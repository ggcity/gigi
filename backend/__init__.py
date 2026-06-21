"""Gigi V3 FastAPI backend.

The turn loop, tuned for responsiveness: retrieve on the raw message -> stream a
prose answer with inline ``[title](url)`` citations token-by-token -> after the
answer finishes, run a non-blocking highlight pass (fetch the cited pages, Haiku
finds the verbatim span, snap it, emit ``highlight`` events). The frontend opens
tiles by parsing the streamed links. Retrieval and extraction are NOT reimplemented
here; they come from the ``shared`` package so indexing and highlighting stay
byte-aligned (V3.md sections 2.3-2.5, 9).
"""
