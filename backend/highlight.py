#!/usr/bin/env python3
"""
Async highlight-span extraction (Haiku) + the ``snap`` fuzzy aligner.

This is the post-answer enhancement: once the prose answer has streamed, the
orchestrator fetches each cited page and calls ``highlight_claims`` to get the
verbatim span on that page that supports what the answer said. ``snap`` then
aligns that span to the real fetched text the backend already holds, so the quote
shipped to the companion is a GUARANTEED true substring of the page (models copy
imperfectly). ``snap`` is one of the few pure functions worth unit-testing
(V3.md sections 2.5, 7).

Claims that cite the same page are batched into one call (page text sent once).
The crawler injects a ``Title:`` prefix into some chunks; that text is not on the
live page, so ``snap`` refuses to return any span that is the title artifact.
"""

import difflib
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .prompts import highlight as highlight_prompt

TITLE_ARTIFACT = "Title:"


@dataclass
class Verdict:
    claim_id: str
    verified: bool
    quote: str = ""


@dataclass
class BatchVerifyResult:
    """One Haiku call's verdicts for all claims that cite a single page."""
    verdicts: Dict[str, Verdict] = field(default_factory=dict)
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms: int = 0
    prompt_payload: Any = None
    response_payload: Any = None


def _norm(s: str) -> str:
    """The crawler's whitespace collapse. Both the live fetch and the companion
    apply the same one, so a span normalized here lines up with what they hold."""
    return re.sub(r"\s+", " ", s or "").strip()


def snap(quote: str, page_text: str, threshold: float = 0.85) -> Optional[str]:
    """Return a true substring of ``page_text`` that best matches ``quote``, or
    None if it cannot be recovered confidently.

    Both inputs are whitespace-normalized first. Exact substring is the fast
    path; otherwise the longest common block anchors a full-length window which,
    if similar enough to the quote, is returned (recovering internal typos).
    Returns None — treated by the caller as a verification failure — when nothing
    aligns, and refuses the ``Title:`` chunk artifact.
    """
    nq = _norm(quote)
    npage = _norm(page_text)
    if not nq or not npage:
        return None
    if nq.startswith(TITLE_ARTIFACT):
        return None

    # Fast path: exact (post-normalization) substring.
    idx = npage.find(nq)
    if idx != -1:
        return _guard(npage[idx:idx + len(nq)])

    # Fuzzy: anchor on the longest common contiguous block.
    sm = difflib.SequenceMatcher(None, npage, nq, autojunk=False)
    match = sm.find_longest_match(0, len(npage), 0, len(nq))
    if match.size == 0:
        return None

    # Reconstruct a full-length window aligned so the quote's start maps onto the
    # page, then accept it if it is similar enough to the quote.
    window_start = max(0, match.a - match.b)
    window = npage[window_start:window_start + len(nq)]
    if window and difflib.SequenceMatcher(None, window, nq).ratio() >= threshold:
        return _guard(window)

    # Fall back to the raw longest block if it already covers most of the quote.
    if match.size / len(nq) >= threshold:
        return _guard(npage[match.a:match.a + match.size])

    return None


def _guard(span: Optional[str]) -> Optional[str]:
    if span is None:
        return None
    span = span.strip()
    if not span or span.startswith(TITLE_ARTIFACT):
        return None
    return span


def _tool_input(resp, tool_name: str):
    for block in getattr(resp, "content", []) or []:
        if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == tool_name:
            return block.input
    return None


def _usage(resp):
    usage = getattr(resp, "usage", None)
    return (getattr(usage, "input_tokens", 0) or 0, getattr(usage, "output_tokens", 0) or 0)


async def highlight_claims(client, model: str, claims: List[Dict[str, str]],
                           page_text: str) -> BatchVerifyResult:
    """Ask Haiku for the best highlight span per claim against ONE page, in a
    single call (page text sent once). ``claims`` is a list of {"id", "text"};
    ``client`` is an AsyncAnthropic. Returns per-claim results keyed by id;
    ``verified`` is set to whether a non-empty span came back (the caller snaps
    each quote). Fail-closed (empty quote) for any claim id the model omits."""
    system = highlight_prompt.SYSTEM_PROMPT
    user = highlight_prompt.user_prompt(claims, page_text)
    t0 = time.perf_counter()
    resp = await client.messages.create(
        model=model,
        max_tokens=1024,
        temperature=0,
        system=system,
        messages=[{"role": "user", "content": user}],
        tools=[highlight_prompt.HIGHLIGHT_TOOL],
        tool_choice={"type": "tool", "name": highlight_prompt.TOOL_NAME},
    )
    latency_ms = int((time.perf_counter() - t0) * 1000)
    payload = _tool_input(resp, highlight_prompt.TOOL_NAME) or {}
    tokens_in, tokens_out = _usage(resp)

    verdicts: Dict[str, Verdict] = {}
    for r in (payload.get("results") or []):
        cid = str(r.get("claim_id") or r.get("id") or "")
        if not cid:
            continue
        quote = r.get("quote") or ""
        verdicts[cid] = Verdict(claim_id=cid, verified=bool(quote.strip()), quote=quote)
    for c in claims:
        verdicts.setdefault(c["id"], Verdict(claim_id=c["id"], verified=False))

    return BatchVerifyResult(
        verdicts=verdicts,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        latency_ms=latency_ms,
        prompt_payload={"claims": [c["id"] for c in claims]},
        response_payload=payload,
    )
