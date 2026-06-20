"""Shared library for the Gigi City RAG system.

One copy of any logic that must not drift between indexing (crawler), the Gradio
harness, and the V3 FastAPI backend:

  * ``rag_embeddings`` -- the embedding contract (Embedder, sanitize_metadata,
    fetch_all). Existing, unchanged.
  * ``extraction``     -- html/pdf/docx text extraction + chunk_text, used by the
    crawler at index time and the backend at verify time, so normalization is
    identical (see V3.md sections 2.5 and 9).
  * ``rag_core``       -- query-side logic with no UI dependency: rewrite,
    retrieval, context/source formatting, history normalization.
"""
