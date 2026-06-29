#!/usr/bin/env python3
"""
Backend configuration.

A single frozen ``Settings`` dataclass populated from environment variables. It
mirrors the env knobs the v2 Gradio entry point (`app.py`) reads (model id, Chroma
path/collection, embedding model, top-k, min-score, history cap) and adds V3 knobs:
page-cache TTL, live-fetch timeout, citation/tile caps, the allowed fetch hosts
(SSRF guard), rate limiting, query-size cap, the SQLite path, and the User-Agent.

Nothing here constructs a client or touches the network; it is pure config so it
can be imported cheaply by tests.
"""

import os
from dataclasses import dataclass, field
from typing import Tuple


def load_env_file(path: str = None) -> None:
    """Populate ``os.environ`` from a simple ``KEY=VALUE`` config file (a repo-root
    ``.env`` by default, or ``GIGI_ENV_FILE``). Dependency-free: blank lines and
    ``#`` comments are skipped, surrounding quotes stripped, and values already set
    in the real environment are NOT overridden (an explicit launch-time ``TOP_K=…``
    wins over the file). Missing file is a no-op."""
    path = path or os.environ.get("GIGI_ENV_FILE", ".env")
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
    except FileNotFoundError:
        pass


def _env(name: str, fallback: str) -> str:
    return os.environ.get(name, fallback)


def _env_int(name: str, fallback: int) -> int:
    try:
        return int(os.environ.get(name, fallback))
    except (TypeError, ValueError):
        return fallback


def _env_float(name: str, fallback: float) -> float:
    try:
        return float(os.environ.get(name, fallback))
    except (TypeError, ValueError):
        return fallback


def _env_bool(name: str, fallback: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return fallback
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_hosts(name: str, fallback: Tuple[str, ...]) -> Tuple[str, ...]:
    raw = os.environ.get(name)
    if not raw:
        return fallback
    return tuple(h.strip().lower() for h in raw.split(",") if h.strip())


# Reuse the crawler's identity so the city sees one well-behaved agent both at
# index time and at highlight-fetch time.
DEFAULT_USER_AGENT = "CityWebsiteCrawler/1.0 (City Website RAG System)"


@dataclass(frozen=True)
class Settings:
    # --- models ---
    answer_model: str = "claude-sonnet-4-6"            # streamed prose answer
    highlight_model: str = "claude-haiku-4-5-20251001"  # async highlight-span extraction
    # Query decomposition + gap inspection, RETRIEVAL ONLY: turns the message into
    # 1-3 standalone Chroma queries and (post-answer) inspects for an actionable gap
    # (feeds the embedder; the answer still uses the original message + history).
    rewrite_model: str = "claude-haiku-4-5-20251001"

    # --- retrieval (same env names as app.py) ---
    chroma_path: str = "./chroma_db"
    chroma_collection: str = "city_website_content"
    embedding_model: str = "BAAI/bge-large-en-v1.5"
    top_k: int = 20
    min_score: float = 0.3
    max_history_messages: int = 6
    # Query decomposition: max standalone queries per turn (the first is always the
    # primary topic; extras only for distinct sub-topics / entity-attribute gaps).
    decompose_max_queries: int = 3

    # --- post-stream gap inspection + additive supplement ---
    # On by default: after the answer streams, one Haiku call checks whether it
    # referenced an actionable detail (contact/phone/fee/hours) without providing it;
    # if so and a re-retrieval surfaces new chunks, a short Sonnet supplement streams.
    gap_inspection_enabled: bool = True
    supplement_max_tokens: int = 300

    # --- generation ---
    max_tokens: int = 1000
    temperature: float = 0.0

    # --- async highlight enhancement ---
    # On by default: after the answer streams, fetch the cited pages and ask Haiku
    # for the verbatim span to highlight, emitted as `highlight` events. Toggle off
    # for pure streaming chat (tiles still open client-side, no highlight).
    highlight_enabled: bool = True

    # --- live fetch / cache (highlight only) ---
    page_cache_ttl_seconds: int = 86400      # 1 day
    fetch_timeout_seconds: int = 30          # matches the crawler's total timeout
    max_cited_urls: int = 4                  # cap pages fetched per turn
    max_tiles: int = 4
    # SSRF guard: the backend only fetches model-cited URLs whose host is within
    # this set. The model can emit any text; we never fetch off-list hosts.
    allowed_fetch_hosts: Tuple[str, ...] = ("ggcity.org",)

    # --- limits / store ---
    rate_limit_per_ip: int = 60
    rate_limit_per_session: int = 30
    rate_window_seconds: int = 60
    max_query_chars: int = 2000
    sqlite_path: str = "./gigi.db"
    user_agent: str = DEFAULT_USER_AGENT

    @classmethod
    def from_env(cls) -> "Settings":
        # Load an optional .env config file first (does not override real env vars).
        load_env_file()
        return cls(
            answer_model=_env("ANTHROPIC_MODEL", cls.answer_model),
            highlight_model=_env("HIGHLIGHT_MODEL", cls.highlight_model),
            rewrite_model=_env("REWRITE_MODEL", cls.rewrite_model),
            chroma_path=_env("CHROMA_PATH", cls.chroma_path),
            chroma_collection=_env("CHROMA_COLLECTION", cls.chroma_collection),
            embedding_model=_env("EMBEDDING_MODEL", cls.embedding_model),
            top_k=_env_int("TOP_K", cls.top_k),
            min_score=_env_float("MIN_SCORE", cls.min_score),
            max_history_messages=_env_int("MAX_HISTORY", cls.max_history_messages),
            decompose_max_queries=_env_int("DECOMPOSE_MAX_QUERIES", cls.decompose_max_queries),
            gap_inspection_enabled=_env_bool("GAP_INSPECTION_ENABLED", cls.gap_inspection_enabled),
            supplement_max_tokens=_env_int("SUPPLEMENT_MAX_TOKENS", cls.supplement_max_tokens),
            max_tokens=_env_int("MAX_TOKENS", cls.max_tokens),
            temperature=_env_float("TEMPERATURE", cls.temperature),
            highlight_enabled=_env_bool("HIGHLIGHT_ENABLED", cls.highlight_enabled),
            page_cache_ttl_seconds=_env_int("PAGE_CACHE_TTL_SECONDS", cls.page_cache_ttl_seconds),
            fetch_timeout_seconds=_env_int("FETCH_TIMEOUT_SECONDS", cls.fetch_timeout_seconds),
            max_cited_urls=_env_int("MAX_CITED_URLS", cls.max_cited_urls),
            max_tiles=_env_int("MAX_TILES", cls.max_tiles),
            allowed_fetch_hosts=_env_hosts("ALLOWED_FETCH_HOSTS", cls.allowed_fetch_hosts),
            rate_limit_per_ip=_env_int("RATE_LIMIT_PER_IP", cls.rate_limit_per_ip),
            rate_limit_per_session=_env_int("RATE_LIMIT_PER_SESSION", cls.rate_limit_per_session),
            rate_window_seconds=_env_int("RATE_WINDOW_SECONDS", cls.rate_window_seconds),
            max_query_chars=_env_int("MAX_QUERY_CHARS", cls.max_query_chars),
            sqlite_path=_env("SQLITE_PATH", cls.sqlite_path),
            user_agent=_env("USER_AGENT", cls.user_agent),
        )
