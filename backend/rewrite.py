#!/usr/bin/env python3
"""
Query decomposition for retrieval (async).

Replaces the v2 single-query rewrite. One small Haiku call turns the resident's
message into 1-3 standalone search queries (``backend/prompts/decompose.py``): the
first resolves references against history, and extra queries are added only for
distinct sub-topics or entity-then-attribute gaps. The orchestrator retrieves each
in parallel and merges by content hash. This is RETRIEVAL-ONLY: the answer model
still receives the original message plus full history, so it resolves follow-ups
itself; the queries only feed Chroma.

The call is forced through the ``decompose_queries`` tool for structured output
(mirroring ``backend/highlight.py``). On any error it falls back to ``[message]``,
preserving the old raw-message behavior.
"""

import logging
import time
from typing import Dict, List, Tuple

from .prompts import decompose as decompose_prompt

logger = logging.getLogger(__name__)


def _usage(resp):
    usage = getattr(resp, "usage", None)
    return (getattr(usage, "input_tokens", 0) or 0, getattr(usage, "output_tokens", 0) or 0)


def _tool_input(resp, tool_name: str):
    for block in getattr(resp, "content", []) or []:
        if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == tool_name:
            return block.input
    return None


async def decompose_for_retrieval(client, model: str, message: str, history: List[Dict],
                                  max_queries: int = 3) -> Tuple[List[str], int, int, int]:
    """Decompose ``message`` into 1-``max_queries`` standalone retrieval queries.

    Returns ``(queries, tokens_in, tokens_out, latency_ms)``. ``queries`` is never
    empty: it falls back to ``[message]`` (with zero token usage) on any error,
    mirroring the v2 raw-message fallback.
    """
    t0 = time.perf_counter()
    try:
        resp = await client.messages.create(
            model=model,
            max_tokens=200,
            temperature=0,
            system=decompose_prompt.SYSTEM_PROMPT,
            messages=[{"role": "user",
                       "content": decompose_prompt.user_prompt(message, history)}],
            tools=[decompose_prompt.DECOMPOSE_TOOL],
            tool_choice={"type": "tool", "name": decompose_prompt.TOOL_NAME},
        )
        latency_ms = int((time.perf_counter() - t0) * 1000)
        payload = _tool_input(resp, decompose_prompt.TOOL_NAME) or {}
        queries = [str(q).strip() for q in (payload.get("queries") or []) if str(q).strip()]
        queries = queries[:max_queries]
        tokens_in, tokens_out = _usage(resp)
        return (queries or [message], tokens_in, tokens_out, latency_ms)
    except Exception as e:
        logger.warning(f"Query decomposition failed, using raw message: {e}")
        return ([message], 0, 0, int((time.perf_counter() - t0) * 1000))
