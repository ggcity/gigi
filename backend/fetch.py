#!/usr/bin/env python3
"""
Live page fetch for cited URLs, with the SQLite page cache.

On a turn the backend fetches only the pages Sonnet actually cited (V3.md
section 2.3 step 5), capped at ``MAX_CITED_URLS`` and run concurrently. Each
page goes through the SAME ``shared.extraction`` functions the crawler used at
index time, then the same whitespace collapse, so the verifier reads text
normalized identically to the stored chunks (V3.md sections 2.5, 9). The
extraction output here is page text only — no ``Title:`` chunk prefix — so it
matches the live DOM.

``httpx`` (async) is used here rather than the crawler's aiohttp or
add_resource's requests, because it fits the FastAPI event loop cleanly.
"""

import asyncio
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, List
from urllib.parse import urldefrag, urlparse

import httpx

from shared import extraction

_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def host_allowed(url: str, settings) -> bool:
    """SSRF guard: only fetch URLs whose host is (a subdomain of) an allowed host.
    The model can emit arbitrary link text; we never make a server-side request to
    an off-list host."""
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return False
    return any(host == h or host.endswith("." + h) for h in settings.allowed_fetch_hosts)


@dataclass
class FetchResult:
    url: str
    text: str
    cache_hit: bool
    latency_ms: int


def _collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _extract(content: bytes, content_type: str, url: str) -> str:
    ct = (content_type or "").lower()
    if "text/html" in ct or not ct:
        text, _title, _meta = extraction.extract_text_from_html(
            content.decode("utf-8", "ignore"), url
        )
    elif "application/pdf" in ct:
        text, _title, _meta = extraction.extract_text_from_pdf(content)
    elif _DOCX_MIME in ct:
        text, _title, _meta = extraction.extract_text_from_docx(content)
    else:
        text, _title, _meta = extraction.extract_text_from_plain(content)
    # Same collapse the crawler applies to HTML; idempotent there, and gives
    # PDF/DOCX a single internally-consistent normalized form for snap.
    return _collapse(text)


async def fetch_page(url: str, store, settings, *, client: httpx.AsyncClient = None) -> FetchResult:
    """Return page text for ``url``: cache hit when fresh, else live fetch +
    extract + cache. ``cache_hit`` and ``latency_ms`` feed the verification log."""
    url = urldefrag(url).url  # cache key never carries a #fragment
    if not host_allowed(url, settings):
        raise ValueError(f"refusing to fetch off-allowlist host: {url}")

    cached = await asyncio.to_thread(store.cache_get, url)
    if cached is not None:
        return FetchResult(url=url, text=cached, cache_hit=True, latency_ms=0)

    t0 = time.perf_counter()
    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(
            timeout=settings.fetch_timeout_seconds,
            headers={"User-Agent": settings.user_agent},
            follow_redirects=True,
        )
    try:
        resp = await client.get(url)
        resp.raise_for_status()
        text = _extract(resp.content, resp.headers.get("content-type", ""), url)
    finally:
        if own_client:
            await client.aclose()
    latency_ms = int((time.perf_counter() - t0) * 1000)

    await asyncio.to_thread(
        store.cache_put, url, text, settings.page_cache_ttl_seconds
    )
    return FetchResult(url=url, text=text, cache_hit=False, latency_ms=latency_ms)


async def fetch_cited(sources: List[Dict[str, Any]], store, settings) -> Dict[str, FetchResult]:
    """Fetch the unique cited URLs (capped at ``MAX_CITED_URLS``) concurrently.
    Returns ``{url: FetchResult}``; URLs that error out are omitted (the
    orchestrator treats a missing page as a verification failure)."""
    seen: List[str] = []
    for s in sources:
        url = urldefrag(s.get("url", "")).url
        # Skip off-allowlist hosts up front (SSRF guard) so they don't consume
        # the cap or trigger doomed requests.
        if url and url not in seen and host_allowed(url, settings):
            seen.append(url)
    seen = seen[: settings.max_cited_urls]
    if not seen:
        return {}

    async with httpx.AsyncClient(
        timeout=settings.fetch_timeout_seconds,
        headers={"User-Agent": settings.user_agent},
        follow_redirects=True,
    ) as client:
        async def _one(u):
            try:
                return await fetch_page(u, store, settings, client=client)
            except Exception:
                return None

        results = await asyncio.gather(*[_one(u) for u in seen])
    return {r.url: r for r in results if r is not None}
