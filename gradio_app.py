#!/usr/bin/env python3
"""
City Website RAG Chatbot - "Gigi" (local edition, conversational).

Retrieves from a local Chroma collection (built by website_crawler.py) using
BGE-large query embeddings, and answers as Gigi using Claude Sonnet via the
Anthropic API.

Conversation support (combined approach):
  * Query rewrite: a cheap Haiku call condenses the conversation plus the latest
    message into a standalone search query, so follow-ups ("what about for
    businesses?") retrieve the right context.
  * Generation memory: the recent turns are passed to Sonnet so it answers in
    context. History is capped to keep cost/latency bounded.

Citations: the model refers to pages by title and does NOT paste raw URLs. The
app appends a clean markdown "Sources" list, which fixes the old bracket-in-URL
links that 404'd.

Set your key first:  export ANTHROPIC_API_KEY=sk-ant-...
"""

import argparse
import logging
import os
from typing import Dict, List, Tuple, Generator
from urllib.parse import urldefrag

import chromadb
import gradio as gr
from anthropic import Anthropic

from shared.rag_embeddings import Embedder
from shared import rag_core

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

INTRO = (
    "Hi, I'm Gigi, your City of Garden Grove assistant. I can help you find city "
    "services, pay bills, apply for permits, and navigate the city website. What "
    "can I help you with?"
)

SYSTEM_TEMPLATE = (
    "You are Gigi, a friendly and helpful assistant for the City of Garden Grove. "
    "You help residents find city services and navigate the city website, with a "
    "warm, welcoming, approachable tone.\n\n"
    "RULES:\n"
    "1. Use ONLY the retrieved context below to answer.\n"
    "2. Do not sound condescending, e.g. do not claim to understand the user's "
    "feelings when you cannot.\n"
    "3. Make sure your information is not out of date before answering. "
    "Today is {today}.\n"
    "4. Do not offer links to websites outside our domain: ggcity.org\n"
    "5. If you are unsure or the answer is not in the context, say you don't know "
    "and point the resident to where on the city website they might look.\n"
    "6. If the question is not about the City of Garden Grove, politely decline.\n"
    "7. Keep answers concise, but complete.\n"
    "8. Do not ask follow-up questions.\n"
    "9. Every context block below is tagged with a source id like [S0]. When you "
    "state a fact, link the page it actually came from, using markdown link "
    "syntax [page title](url) with the title and URL of the SAME source id whose "
    "content supports that fact. Do not attribute a fact to a page unless that "
    "page's own context block contains it. If a fact is supported by one source "
    "id but you are tempted to cite a different one, cite the correct source id or "
    "do not link at all. Link the first mention of each relevant page. Never paste "
    "a bare URL on its own.\n\n"
    "Retrieved context from the city website:\n{context}\n\n"
    "Source pages (title -> url) you may link to:{sources_text}"
)


class CityRAGChatbot:
    def __init__(
        self,
        model_name: str = "claude-sonnet-4-6",
        rewrite_model: str = "claude-haiku-4-5-20251001",
        db_path: str = "./chroma_db",
        collection_name: str = "city_website_content",
        embedding_model: str = "BAAI/bge-large-en-v1.5",
        api_key: str = None,
        max_tokens: int = 1000,
        temperature: float = 0.0,
        top_k_results: int = 5,
        min_score: float = 0.3,
        max_history_messages: int = 6,
        show_footer: bool = True,
    ):
        self.model_name = model_name
        self.rewrite_model = rewrite_model
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.top_k_results = top_k_results
        self.min_score = min_score
        self.max_history_messages = max_history_messages
        self.show_footer = show_footer

        self.client = Anthropic(api_key=api_key) if api_key else Anthropic()

        logger.info(f"Loading embedding model: {embedding_model}")
        self.embedder = Embedder(model_name=embedding_model, device="cpu")

        self.chroma_client = chromadb.PersistentClient(path=db_path)
        self.collection = self.chroma_client.get_or_create_collection(
            name=collection_name, metadata={"hnsw:space": "cosine"}
        )

        self._test_connections()

    def _test_connections(self):
        count = self.collection.count()
        if count == 0:
            raise Exception(
                f"Collection '{self.collection.name}' is empty. Run the crawler first."
            )
        logger.info(f"Chroma collection has {count} chunks")
        self.client.messages.create(
            model=self.model_name,
            max_tokens=8,
            messages=[{"role": "user", "content": "Hello"}],
        )
        logger.info(f"Connected to Anthropic ({self.model_name})")

    # ---- history / rewrite / retrieval (delegated to shared.rag_core) -------
    def _normalize_history(self, history) -> List[Dict]:
        return rag_core.normalize_history(history, self.max_history_messages)

    def rewrite_query(self, message: str, history: List[Dict]) -> str:
        return rag_core.rewrite_query(self.client, self.rewrite_model, message, history)

    def search_knowledge_base(self, query: str) -> List[Dict]:
        return rag_core.search_knowledge_base(
            self.embedder, self.collection, query, self.top_k_results, self.min_score
        )

    def format_context_and_sources(self, search_results: List[Dict]) -> Tuple[str, List[Dict]]:
        return rag_core.format_context_and_sources(search_results)

    @staticmethod
    def _sources_footer(sources: List[Dict]) -> str:
        """Clean markdown links. Avoids the bare-URL-in-brackets 404."""
        lines = []
        seen = set()
        for s in sources:
            url = urldefrag(s.get("url", "")).url
            if not url or url in seen:
                continue
            seen.add(url)
            title = (s.get("title") or url).replace("[", "(").replace("]", ")").strip()
            lines.append(f"- [{title}]({url})")
        return "\n\n**Sources:**\n" + "\n".join(lines) if lines else ""

    # ---- generation --------------------------------------------------------
    def generate_response(self, query: str, context: str, sources: List[Dict],
                          history: List[Dict]) -> Generator[str, None, None]:
        sources_text = ""
        if sources:
            sources_text = "\n" + "\n".join(
                f"- [{s['source_id']}] {s['title']} -> {s['url']}" for s in sources
            )
        today = rag_core.today_str()
        system_prompt = SYSTEM_TEMPLATE.format(
            context=context, sources_text=sources_text, today=today
        )

        messages = list(history) + [{"role": "user", "content": query}]
        try:
            with self.client.messages.stream(
                model=self.model_name,
                max_tokens=self.max_tokens,
                temperature=self.temperature,
                system=system_prompt,
                messages=messages,
            ) as stream:
                for text in stream.text_stream:
                    yield text
        except Exception as e:
            logger.error(f"Error generating response: {e}")
            yield f"I ran into a problem generating a response: {str(e)}"

    def chat_with_rag(self, message: str, history) -> Generator[str, None, None]:
        if not message.strip():
            yield "Please ask me a question about City of Garden Grove services."
            return

        hist = self._normalize_history(history)
        first_turn = len(hist) == 0
        prefix = (INTRO + "\n\n") if first_turn else ""

        # First turn needs no rewrite; later turns resolve references.
        query = message if first_turn else self.rewrite_query(message, hist)

        results = self.search_knowledge_base(query)
        if not results:
            yield prefix + (
                "I'm sorry, I don't have information about that on the City of Garden "
                "Grove website. I can only help with City of Garden Grove topics, so "
                "please try rephrasing or check the city website directly."
            )
            return

        context, sources = self.format_context_and_sources(results)

        response_text = prefix
        if prefix:
            yield response_text
        for chunk in self.generate_response(message, context, sources, hist):
            response_text += chunk
            yield response_text

        if self.show_footer:
            footer = self._sources_footer(sources)
            if footer:
                response_text += footer
                yield response_text

    def create_gradio_interface(self) -> gr.ChatInterface:
        def chat_wrapper(message, history):
            for response in self.chat_with_rag(message, history):
                yield response

        demo = gr.ChatInterface(
            fn=chat_wrapper,
            title="Gigi - City of Garden Grove Assistant",
            description="Ask Gigi about City of Garden Grove services, bills, permits, and more.",
            examples=[
                "How do I pay my water bill?",
                "What do I need to apply for a building permit?",
                "How can I report a pothole?",
                "What are the requirements for a business license?",
                "How do I schedule a bulk trash pickup?",
            ],
        )
        return demo


def _env_default(name, fallback):
    return os.environ.get(name, fallback)


def main():
    parser = argparse.ArgumentParser(description="Gigi - City of Garden Grove RAG Chatbot")
    parser.add_argument("--model-name", default=_env_default("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
                        help="Anthropic model ID for answering")
    parser.add_argument("--rewrite-model", default=_env_default("REWRITE_MODEL", "claude-haiku-4-5-20251001"),
                        help="Cheaper model used to rewrite follow-ups into standalone queries")
    parser.add_argument("--db-path", default=_env_default("CHROMA_PATH", "./chroma_db"),
                        help="Chroma persistence directory (must match the crawler)")
    parser.add_argument("--collection-name", default=_env_default("CHROMA_COLLECTION", "city_website_content"))
    parser.add_argument("--embedding-model", default=_env_default("EMBEDDING_MODEL", "BAAI/bge-large-en-v1.5"),
                        help="Must match the model used by the crawler")
    parser.add_argument("--api-key", default=None, help="Anthropic API key (else ANTHROPIC_API_KEY env)")
    parser.add_argument("--max-tokens", type=int, default=1000)
    parser.add_argument("--temperature", type=float, default=0.0,
                        help="0.0 is most deterministic; raise only for more varied phrasing")
    parser.add_argument("--max-history", type=int, default=6,
                        help="Max number of past messages to carry into each turn")
    parser.add_argument("--no-footer", action="store_true",
                        help="Do not append the Sources list (links still appear inline)")
    parser.add_argument("--port", type=int, default=7860)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--share", action="store_true", help="Create a public shareable link")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--min-score", type=float, default=0.3,
                        help="Minimum cosine similarity in [0,1]")
    args = parser.parse_args()

    print("Starting Gigi - City of Garden Grove Assistant")
    print(f"Answer model: {args.model_name}  Rewrite model: {args.rewrite_model}")
    print(f"Chroma: {args.db_path} / {args.collection_name}")
    print("-" * 50)

    try:
        chatbot = CityRAGChatbot(
            model_name=args.model_name,
            rewrite_model=args.rewrite_model,
            db_path=args.db_path,
            collection_name=args.collection_name,
            embedding_model=args.embedding_model,
            api_key=args.api_key,
            max_tokens=args.max_tokens,
            temperature=args.temperature,
            top_k_results=args.top_k,
            min_score=args.min_score,
            max_history_messages=args.max_history,
            show_footer=not args.no_footer,
        )
        demo = chatbot.create_gradio_interface()
        print("Gigi initialized")
        print(f"Starting server on {args.host}:{args.port}")
        demo.launch(server_name=args.host, server_port=args.port,
                    share=args.share, show_error=True)
    except Exception as e:
        print(f"Error starting chatbot: {e}")
        logger.error(f"Startup error: {e}", exc_info=True)


if __name__ == "__main__":
    main()
    