#!/usr/bin/env python3
"""
Post-stream gap inspection (async).

After the answer has streamed, ``inspect_gap`` runs one Haiku call that reads the
completed answer against the original question (``backend/prompts/gap.py``). It
returns a single targeted retrieval query when the answer points at an actionable
detail it did not actually provide (a contact, phone, address, fee, or hours), or an
empty string otherwise. The decomposed queries from the retrieval step are passed in
so the model can decline a gap that was already searched.

The call is forced through the ``report_gap`` tool for structured output. On any
error it returns ``""`` (no gap), so a failure here never blocks the turn — the
answer already shipped.
"""

import logging
import time
from typing import List, Tuple

from .prompts import gap as gap_prompt

logger = logging.getLogger(__name__)


def _usage(resp):
    usage = getattr(resp, "usage", None)
    return (getattr(usage, "input_tokens", 0) or 0, getattr(usage, "output_tokens", 0) or 0)


def _tool_input(resp, tool_name: str):
    for block in getattr(resp, "content", []) or []:
        if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == tool_name:
            return block.input
    return None


async def inspect_gap(client, model: str, question: str, answer: str,
                      prior_queries: List[str]) -> Tuple[str, int, int, int]:
    """Decide whether ``answer`` leaves an actionable detail unprovided.

    Returns ``(gap_query, tokens_in, tokens_out, latency_ms)``; ``gap_query`` is the
    empty string when there is no gap (or on error).
    """
    t0 = time.perf_counter()
    try:
        resp = await client.messages.create(
            model=model,
            max_tokens=120,
            temperature=0,
            system=gap_prompt.SYSTEM_PROMPT,
            messages=[{"role": "user",
                       "content": gap_prompt.user_prompt(question, answer, prior_queries)}],
            tools=[gap_prompt.GAP_TOOL],
            tool_choice={"type": "tool", "name": gap_prompt.TOOL_NAME},
        )
        latency_ms = int((time.perf_counter() - t0) * 1000)
        payload = _tool_input(resp, gap_prompt.TOOL_NAME) or {}
        gap_query = str(payload.get("gap_query") or "").strip()
        tokens_in, tokens_out = _usage(resp)
        return (gap_query, tokens_in, tokens_out, latency_ms)
    except Exception as e:
        logger.warning(f"Gap inspection failed, skipping supplement: {e}")
        return ("", 0, 0, int((time.perf_counter() - t0) * 1000))
