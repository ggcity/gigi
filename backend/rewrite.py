#!/usr/bin/env python3
"""
Follow-up query rewrite for retrieval (async).

On a follow-up turn the raw message ("what's her background") lacks the entity
the embedder needs, so retrieval misses. This runs one small Haiku call to
rewrite the message into a standalone search query, resolving references against
the conversation history. It is RETRIEVAL-ONLY: the answer model still receives
the original message plus the full history, so it resolves "her" from context
itself; the rewrite just feeds Chroma a query with the entity spelled out.

This is the v2 behavior (``shared/rag_core.rewrite_query``), reproduced here for
the backend's ``AsyncAnthropic`` client. The PROMPT is shared from
``shared.rag_core`` (``REWRITE_SYSTEM`` / ``rewrite_user_prompt``) so the wording
never drifts from the sync Gradio path. Language-agnostic: references are
resolved by the model, not a word list.
"""

import logging
import time
from typing import Dict, List, Tuple

from shared.rag_core import REWRITE_SYSTEM, rewrite_user_prompt

logger = logging.getLogger(__name__)


def _usage(resp):
    usage = getattr(resp, "usage", None)
    return (getattr(usage, "input_tokens", 0) or 0, getattr(usage, "output_tokens", 0) or 0)


async def rewrite_for_retrieval(client, model: str, message: str,
                                history: List[Dict]) -> Tuple[str, int, int, int]:
    """Rewrite ``message`` into a standalone retrieval query using ``history``.

    Returns ``(rewritten_query, tokens_in, tokens_out, latency_ms)``. Falls back
    to the raw ``message`` (with zero token usage) on any error, mirroring v2.
    Callers should only invoke this when ``history`` is non-empty.
    """
    t0 = time.perf_counter()
    try:
        resp = await client.messages.create(
            model=model,
            max_tokens=80,
            temperature=0,
            system=REWRITE_SYSTEM,
            messages=[{"role": "user", "content": rewrite_user_prompt(message, history)}],
        )
        latency_ms = int((time.perf_counter() - t0) * 1000)
        text = "".join(
            b.text for b in getattr(resp, "content", []) or []
            if getattr(b, "type", None) == "text"
        ).strip()
        tokens_in, tokens_out = _usage(resp)
        return (text or message, tokens_in, tokens_out, latency_ms)
    except Exception as e:
        logger.warning(f"Query rewrite failed, using raw message: {e}")
        return (message, 0, 0, int((time.perf_counter() - t0) * 1000))
