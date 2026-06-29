#!/usr/bin/env python3
"""
Streamed prose answer generation + citation parsing.

``stream_answer`` runs Sonnet with the prose prompt and emits ``answer_token``
events as the tokens arrive (real LLM streaming via the async Anthropic stream
API), returning the full text and token usage. ``parse_citations`` then extracts
the inline ``[title](url)`` markdown links from the finished answer (plus the
sentence around each), so the orchestrator knows which pages to fetch for the
async highlight pass. The same links are what the frontend parses to open tiles.
"""

import re
from typing import Any, Dict, List, Tuple
from urllib.parse import urldefrag

from .prompts import answer as answer_prompt
from .prompts import supplement as supplement_prompt

# [anchor](url) — url stops at whitespace or the closing paren.
_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
_SENT_BOUND = ".?!\n"


async def stream_answer(client, model: str, query: str, context: str,
                        sources: List[Dict[str, Any]], history: List[Dict], today: str,
                        emit, *, max_tokens: int = 1000, temperature: float = 0.0
                        ) -> Tuple[str, int, int]:
    """Stream the prose answer token-by-token through ``emit`` and return
    (full_text, tokens_in, tokens_out). ``client`` is an AsyncAnthropic."""
    system = answer_prompt.system_prompt(context, sources, today)
    messages = list(history or []) + [{"role": "user", "content": query}]

    parts: List[str] = []
    async with client.messages.stream(
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
        system=system,
        messages=messages,
    ) as stream:
        async for text in stream.text_stream:
            if text:
                parts.append(text)
                await emit({"type": "answer_token", "text": text})
        final = await stream.get_final_message()

    usage = getattr(final, "usage", None)
    tokens_in = getattr(usage, "input_tokens", 0) or 0
    tokens_out = getattr(usage, "output_tokens", 0) or 0
    return "".join(parts), tokens_in, tokens_out


async def stream_supplement(client, model: str, question: str, prior_answer: str,
                            context: str, sources: List[Dict[str, Any]], today: str,
                            emit, *, max_tokens: int = 300, temperature: float = 0.0
                            ) -> Tuple[str, int, int]:
    """Stream the additive supplement token-by-token through ``emit`` (as
    ``supplement_token`` events, not ``answer_token``) and return
    (full_text, tokens_in, tokens_out). Same streaming mechanics as
    ``stream_answer`` but with the supplement prompt and the prior answer in view."""
    system = supplement_prompt.system_prompt(context, sources, today, prior_answer)
    messages = [{"role": "user", "content": question}]

    parts: List[str] = []
    async with client.messages.stream(
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
        system=system,
        messages=messages,
    ) as stream:
        async for text in stream.text_stream:
            if text:
                parts.append(text)
                await emit({"type": "supplement_token", "text": text})
        final = await stream.get_final_message()

    usage = getattr(final, "usage", None)
    tokens_in = getattr(usage, "input_tokens", 0) or 0
    tokens_out = getattr(usage, "output_tokens", 0) or 0
    return "".join(parts), tokens_in, tokens_out


def _sentence_around(text: str, idx: int) -> str:
    """The sentence containing position ``idx``. Operates on URL-free text (links
    already flattened to anchors), so splitting on '.' is safe."""
    if idx < 0:
        return text.strip()
    start = max((text.rfind(c, 0, idx) for c in _SENT_BOUND), default=-1) + 1
    ends = [e for e in (text.find(c, idx) for c in _SENT_BOUND) if e != -1]
    end = (min(ends) + 1) if ends else len(text)
    return text[start:end].strip()


def parse_citations(answer_text: str) -> List[Dict[str, str]]:
    """Extract inline ``[anchor](url)`` citations from the answer. Returns one
    entry per link occurrence: ``{url (defragged), anchor, claim}`` where ``claim``
    is the surrounding sentence (with markdown flattened). The orchestrator groups
    these by URL for the highlight pass."""
    # Flatten links to their anchor text first so sentence splitting never trips
    # on the periods inside a URL.
    plain = _LINK.sub(r"\1", answer_text or "")
    out: List[Dict[str, str]] = []
    for m in _LINK.finditer(answer_text or ""):
        anchor, raw_url = m.group(1).strip(), m.group(2).strip()
        url = urldefrag(raw_url).url
        if not url:
            continue
        out.append({"url": url, "anchor": anchor,
                    "claim": _sentence_around(plain, plain.find(anchor))})
    return out
