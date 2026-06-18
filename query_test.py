#!/usr/bin/env python3
"""
Standalone retrieval sanity check. No Claude, no Gradio.

Embeds a query with the SAME model the crawler used, queries Chroma, and prints
ranked results with cosine similarity so you can judge retrieval quality and
pick a sensible --min-score for the chatbot.

Usage:
  python query_test.py --query "how do I pay my water bill"
  python query_test.py            # interactive loop
"""

import argparse
import os
import textwrap

import chromadb

from rag_embeddings import Embedder, fetch_all


def run_query(collection, embedder, query: str, top_k: int):
    embedding = embedder.embed_query(query)
    resp = collection.query(
        query_embeddings=[embedding],
        n_results=top_k,
        include=["documents", "metadatas", "distances"],
    )
    docs = resp.get("documents", [[]])[0]
    metas = resp.get("metadatas", [[]])[0]
    dists = resp.get("distances", [[]])[0]

    if not docs:
        print("No results.")
        return

    for rank, (doc, meta, dist) in enumerate(zip(docs, metas, dists), 1):
        similarity = 1.0 - dist  # Chroma cosine distance -> similarity
        meta = meta or {}
        snippet = textwrap.shorten((doc or "").replace("\n", " "), width=280, placeholder=" ...")
        print(f"\n#{rank}  similarity={similarity:.3f}")
        print(f"  title: {meta.get('title', '')}")
        print(f"  url:   {meta.get('url', '')}")
        print(f"  type:  {meta.get('document_type', '')}   dept: {meta.get('department', '')}")
        print(f"  text:  {snippet}")


def list_corpus(collection):
    metas = fetch_all(collection, ["metadatas"])["metadatas"]
    by_url = {}
    for m in metas:
        u = (m or {}).get("url", "")
        if u not in by_url:
            by_url[u] = {
                "title": (m or {}).get("title", ""),
                "type": (m or {}).get("document_type", ""),
                "dept": (m or {}).get("department", ""),
                "chunks": 0,
            }
        by_url[u]["chunks"] += 1
    print(f"{len(by_url)} unique pages, {len(metas)} chunks total\n")
    for u, info in sorted(by_url.items()):
        title = (info["title"] or "")[:45]
        print(f"  [{info['chunks']:>3}c] {str(info['type']):<14} {str(info['dept'] or ''):<12} {title:<45} {u}")


def main():
    parser = argparse.ArgumentParser(description="Chroma retrieval test (no LLM)")
    parser.add_argument("--query", help="Query text. If omitted, runs interactively.")
    parser.add_argument("--list", action="store_true",
                        help="List every crawled page (url, title, type, dept, chunk count) and exit")
    parser.add_argument("--db-path", default=os.environ.get("CHROMA_PATH", "./chroma_db"))
    parser.add_argument("--collection-name", default=os.environ.get("CHROMA_COLLECTION", "city_website_content"))
    parser.add_argument("--embedding-model", default=os.environ.get("EMBEDDING_MODEL", "BAAI/bge-large-en-v1.5"),
                        help="Must match the model the crawler used")
    parser.add_argument("--top-k", type=int, default=5)
    args = parser.parse_args()

    client = chromadb.PersistentClient(path=args.db_path)
    collection = client.get_or_create_collection(
        name=args.collection_name, metadata={"hnsw:space": "cosine"}
    )
    count = collection.count()
    print(f"Collection '{args.collection_name}' has {count} chunks at {args.db_path}")
    if count == 0:
        print("Empty collection. Run the crawler first.")
        return

    # --list does not need the embedding model, so handle it before loading.
    if args.list:
        list_corpus(collection)
        return

    print(f"Loading embedding model: {args.embedding_model}")
    embedder = Embedder(model_name=args.embedding_model, device="cpu")

    if args.query:
        run_query(collection, embedder, args.query, args.top_k)
        return

    print("Interactive mode. Type a query, or 'quit' to exit.")
    while True:
        try:
            q = input("\nquery> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not q:
            continue
        if q.lower() in ("quit", "exit"):
            break
        run_query(collection, embedder, q, args.top_k)


if __name__ == "__main__":
    main()
