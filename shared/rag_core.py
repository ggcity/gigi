#!/usr/bin/env python3
"""
Shared query-side core for the Gigi City RAG system.

UI-free logic lifted from the v2 chatbot so the Gradio harness and the V3 FastAPI
backend share one implementation (see V3.md sections 8 and 9): follow-up rewrite,
Chroma retrieval, context/source formatting, and history normalization.

Everything here takes its Anthropic client, Embedder, and Chroma collection as
arguments -- no module-level model/client construction, no gradio, no torch -- so
the backend can import it cheaply. The v2 prose system prompt and streaming answer
generation stay in the Gradio wrapper; the V3 backend supplies its own structured
draft prompt instead.
"""

import datetime
import logging
from typing import Dict, List, Tuple
from urllib.parse import urldefrag

logger = logging.getLogger(__name__)


def today_str() -> str:
    """Human date for prompt injection, e.g. 'June 20, 2026'. Computed fresh each
    call so the answer date is never stale (replaces the old hard-coded date)."""
    return datetime.date.today().strftime("%B %-d, %Y")


def normalize_history(history, cap: int) -> List[Dict]:
    """Accept Gradio 'messages' (list of dicts) or old tuple format; return a
    capped list of {role, content} dicts (most recent ``cap`` messages)."""
    msgs: List[Dict] = []
    if not history:
        return msgs
    for item in history:
        if isinstance(item, dict) and item.get("role") in ("user", "assistant"):
            if item.get("content"):
                msgs.append({"role": item["role"], "content": str(item["content"])})
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            user_msg, bot_msg = item
            if user_msg:
                msgs.append({"role": "user", "content": str(user_msg)})
            if bot_msg:
                msgs.append({"role": "assistant", "content": str(bot_msg)})
    return msgs[-cap:]


# Single source of truth for the follow-up rewrite prompt. The sync v2 path
# (rewrite_query below, used by the Gradio harness) and the V3 backend's async
# rewrite (backend/rewrite.py, which holds an AsyncAnthropic client and so can't
# call rewrite_query directly) both build the prompt from these, so the wording
# can't drift between indexing-time and serving-time consumers.
REWRITE_SYSTEM = (
    "Rewrite the user's latest message into a single standalone search query "
    "for a City of Garden Grove website search, resolving any references to "
    "earlier turns (pronouns, 'that', 'it', omitted subjects). Output ONLY "
    "the query text, no quotes, no preamble."
)


def rewrite_user_prompt(message: str, history: List[Dict]) -> str:
    """Build the user-turn text for the rewrite call: prior conversation plus the
    latest message. Language-agnostic — references are resolved by the model, not
    by any word list."""
    convo = "\n".join(f"{m['role']}: {m['content']}" for m in history)
    return f"Conversation so far:\n{convo}\n\nLatest message: {message}\n\nStandalone query:"


def rewrite_query(client, model: str, message: str, history: List[Dict]) -> str:
    """Condense conversation + latest message into a standalone search query.

    Resolves pronouns / omitted subjects against recent turns so follow-ups
    retrieve the right context. Falls back to the raw message on any error.
    """
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=80,
            temperature=0,
            system=REWRITE_SYSTEM,
            messages=[{"role": "user", "content": rewrite_user_prompt(message, history)}],
        )
        q = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
        return q or message
    except Exception as e:
        logger.warning(f"Query rewrite failed, using raw message: {e}")
        return message


def search_knowledge_base(embedder, collection, query: str, top_k: int,
                          min_score: float) -> List[Dict]:
    """Embed the query, run Chroma cosine search, return results above min_score.

    Each result dict carries the chunk content, similarity ``score``, all stored
    metadata, and ``chroma_id`` -- the Chroma document id, captured for the V3
    retrieval log (the v2 chatbot discarded it). Note ``chroma_id`` is distinct
    from the metadata ``chunk_id`` (the integer chunk index within its document).
    """
    try:
        query_embedding = embedder.embed_query(query)
        response = collection.query(
            query_embeddings=[query_embedding],
            n_results=top_k,
            include=["documents", "metadatas", "distances"],
        )
        results: List[Dict] = []
        # Chroma always returns ids; they are not a valid `include` value.
        ids = response.get("ids", [[]])[0]
        documents = response.get("documents", [[]])[0]
        metadatas = response.get("metadatas", [[]])[0]
        distances = response.get("distances", [[]])[0]
        for chroma_id, content, metadata, distance in zip(ids, documents, metadatas, distances):
            similarity = 1.0 - distance  # Chroma cosine distance -> similarity
            if similarity >= min_score:
                item = dict(metadata or {})
                item["content"] = content
                item["score"] = similarity
                item["chroma_id"] = chroma_id
                results.append(item)
        return results
    except Exception as e:
        logger.error(f"Error searching knowledge base: {e}")
        return []


def format_context_and_sources(search_results: List[Dict]) -> Tuple[str, List[Dict]]:
    """Build the model-facing context string and the deduped source list.

    One source_id (S0, S1, ...) per unique URL in first-seen order, so every chunk
    from the same page shares an id and the model cites the page, not the chunk.
    Fragments are stripped for dedup; the highest-scoring chunk's score is kept.
    """
    if not search_results:
        return "", []
    sources_by_url: Dict[str, Dict] = {}
    order: List[str] = []  # first-seen order, for stable S0, S1, ...
    context_parts = []
    for result in search_results:
        url = urldefrag(result.get("url", "")).url  # drop #fragment for dedup
        title = result.get("title", "")
        content = result.get("content", "")
        if url not in sources_by_url:
            sources_by_url[url] = {
                "source_id": f"S{len(order)}",
                "title": title,
                "url": url,
                "file_type": result.get("file_type", ""),
                "score": result.get("score", 0.0),
            }
            order.append(url)
        elif result.get("score", 0.0) > sources_by_url[url]["score"]:
            sources_by_url[url]["score"] = result["score"]
        sid = sources_by_url[url]["source_id"]
        context_parts.append(
            f"[{sid}] Title: {title}\nURL: {url}\nContent: {content}"
        )
    context = "\n\n---\n\n".join(context_parts)
    sources = [sources_by_url[u] for u in order]
    return context, sources
