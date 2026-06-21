#!/usr/bin/env python3
"""
SQLite persistence for the Gigi V3 backend.

One file holds session state, the fetched-page cache, rate-limit counters, and
the full interaction / model-call / verification / retrieval logs (schema per
V3.md section 2.7). Opened with WAL and a busy_timeout so the single serving
process never blocks on its own writes.

This module is intentionally SYNCHRONOUS. The embedder and Chroma are already
called off the event loop via ``asyncio.to_thread``; the store follows the same
pattern, so every method here is wrapped in ``to_thread`` at its async call site
rather than depending on an async SQLite driver.

PII / AR 2.16 note
------------------
``interactions.user_query`` (and the ``model_calls.prompt`` JSON, which embeds
it) is a PII store: residents volunteer personal information in free-text
queries even though the crawled city pages contain none. Phase 1 logs it as
specified for debuggability; the retention / redaction / access-control policy
is Phase 6 work (V3.md section 11). Handle this file as a PII asset under City
Administrative Regulation 2.16 (Cloud Computing Services Policy):
https://internal.ggcity.org/policies
"""

import json
import sqlite3
import time
from typing import Any, Dict, List, Optional

SCHEMA_VERSION = 1


def _now() -> float:
    """Epoch seconds. Wrapped so call sites can inject a clock in tests."""
    return time.time()


_SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

CREATE TABLE IF NOT EXISTS sessions (
    session_id   TEXT PRIMARY KEY,
    created_at   REAL,
    last_seen_at REAL
);

CREATE TABLE IF NOT EXISTS interactions (
    interaction_id  TEXT PRIMARY KEY,           -- uuid4
    session_id      TEXT,
    created_at      REAL,
    user_query      TEXT,                        -- PII (see module header)
    rewritten_query TEXT,
    outcome         TEXT,                        -- answered | regenerated | not_found
    final_answer    TEXT,
    citations       TEXT,                        -- JSON
    regen_count     INTEGER DEFAULT 0,
    tokens_in       INTEGER DEFAULT 0,
    tokens_out      INTEGER DEFAULT 0,
    latency_ms      INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE TABLE IF NOT EXISTS model_calls (
    id             INTEGER PRIMARY KEY,
    interaction_id TEXT,
    seq            INTEGER,
    call_type      TEXT,                         -- rewrite | draft | verify | regen
    model          TEXT,
    tokens_in      INTEGER,
    tokens_out     INTEGER,
    latency_ms     INTEGER,
    prompt         TEXT,                          -- JSON
    response       TEXT,                          -- JSON
    created_at     REAL,
    FOREIGN KEY (interaction_id) REFERENCES interactions(interaction_id)
);

CREATE TABLE IF NOT EXISTS verifications (
    id               INTEGER PRIMARY KEY,
    interaction_id   TEXT,
    source_url       TEXT,
    claim            TEXT,
    verified         INTEGER,
    quote            TEXT,
    page_cache_hit   INTEGER,
    fetch_latency_ms INTEGER,
    created_at       REAL,
    FOREIGN KEY (interaction_id) REFERENCES interactions(interaction_id)
);

CREATE TABLE IF NOT EXISTS retrievals (
    id             INTEGER PRIMARY KEY,
    interaction_id TEXT,
    rank           INTEGER,
    chunk_id       TEXT,
    url            TEXT,
    score          REAL,
    FOREIGN KEY (interaction_id) REFERENCES interactions(interaction_id)
);

CREATE TABLE IF NOT EXISTS page_cache (
    url         TEXT PRIMARY KEY,
    text        TEXT,
    fetched_at  REAL,
    ttl_seconds INTEGER
);

CREATE TABLE IF NOT EXISTS rate_limits (
    key          TEXT PRIMARY KEY,
    window_start REAL,
    count        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_model_calls_interaction ON model_calls(interaction_id);
CREATE INDEX IF NOT EXISTS idx_verifications_interaction ON verifications(interaction_id);
CREATE INDEX IF NOT EXISTS idx_retrievals_interaction ON retrievals(interaction_id);
"""


class Store:
    """Synchronous SQLite wrapper. Call every method via ``asyncio.to_thread``
    from async code."""

    def __init__(self, path: str):
        self.path = path
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.create_schema()

    def create_schema(self) -> None:
        with self.conn:
            self.conn.executescript(_SCHEMA)
            row = self.conn.execute("SELECT version FROM schema_version").fetchone()
            if row is None:
                self.conn.execute(
                    "INSERT INTO schema_version (version) VALUES (?)", (SCHEMA_VERSION,)
                )

    def close(self) -> None:
        self.conn.close()

    # ---- sessions ----------------------------------------------------------
    def create_session(self, session_id: str, now: Optional[float] = None) -> None:
        ts = _now() if now is None else now
        with self.conn:
            self.conn.execute(
                "INSERT OR IGNORE INTO sessions (session_id, created_at, last_seen_at) "
                "VALUES (?, ?, ?)",
                (session_id, ts, ts),
            )

    def session_exists(self, session_id: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM sessions WHERE session_id=?", (session_id,)
        ).fetchone()
        return row is not None

    def touch_session(self, session_id: str, now: Optional[float] = None) -> None:
        ts = _now() if now is None else now
        with self.conn:
            self.conn.execute(
                "UPDATE sessions SET last_seen_at=? WHERE session_id=?", (ts, session_id)
            )

    def recent_interactions(self, session_id: str, n: int) -> List[Dict[str, Any]]:
        """Most recent ``n`` interactions for a session, returned oldest-first so
        the caller can build a chronological history for the rewrite step.

        History is DERIVED here, never duplicated into a separate store
        (V3.md section 2.7). Only answered/regenerated turns carry a usable
        assistant reply, but all are returned; the caller decides what to keep.
        """
        rows = self.conn.execute(
            "SELECT interaction_id, user_query, rewritten_query, outcome, final_answer, "
            "created_at FROM interactions WHERE session_id=? "
            "ORDER BY created_at DESC, rowid DESC LIMIT ?",
            (session_id, n),
        ).fetchall()
        return [dict(r) for r in reversed(rows)]

    # ---- interactions ------------------------------------------------------
    def start_interaction(self, interaction_id: str, session_id: str,
                          user_query: str, now: Optional[float] = None) -> None:
        ts = _now() if now is None else now
        with self.conn:
            self.conn.execute(
                "INSERT INTO interactions (interaction_id, session_id, created_at, "
                "user_query, regen_count, tokens_in, tokens_out) "
                "VALUES (?, ?, ?, ?, 0, 0, 0)",
                (interaction_id, session_id, ts, user_query),
            )

    def finish_interaction(self, interaction_id: str, *, rewritten_query: str = None,
                           outcome: str, final_answer: str = None,
                           citations: Any = None, regen_count: int = 0,
                           tokens_in: int = 0, tokens_out: int = 0,
                           latency_ms: int = None) -> None:
        with self.conn:
            self.conn.execute(
                "UPDATE interactions SET rewritten_query=?, outcome=?, final_answer=?, "
                "citations=?, regen_count=?, tokens_in=?, tokens_out=?, latency_ms=? "
                "WHERE interaction_id=?",
                (rewritten_query, outcome, final_answer,
                 json.dumps(citations) if citations is not None else None,
                 regen_count, tokens_in, tokens_out, latency_ms, interaction_id),
            )

    def get_interaction(self, interaction_id: str) -> Optional[Dict[str, Any]]:
        row = self.conn.execute(
            "SELECT * FROM interactions WHERE interaction_id=?", (interaction_id,)
        ).fetchone()
        return dict(row) if row else None

    # ---- logs --------------------------------------------------------------
    def log_model_call(self, interaction_id: str, seq: int, call_type: str, model: str,
                       *, tokens_in: int = 0, tokens_out: int = 0, latency_ms: int = None,
                       prompt: Any = None, response: Any = None,
                       now: Optional[float] = None) -> None:
        ts = _now() if now is None else now
        with self.conn:
            self.conn.execute(
                "INSERT INTO model_calls (interaction_id, seq, call_type, model, tokens_in, "
                "tokens_out, latency_ms, prompt, response, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (interaction_id, seq, call_type, model, tokens_in, tokens_out, latency_ms,
                 json.dumps(prompt) if prompt is not None else None,
                 json.dumps(response) if response is not None else None, ts),
            )

    def log_verification(self, interaction_id: str, source_url: str, claim: str,
                         verified: bool, quote: str = None, *, page_cache_hit: bool = False,
                         fetch_latency_ms: int = None, now: Optional[float] = None) -> None:
        ts = _now() if now is None else now
        with self.conn:
            self.conn.execute(
                "INSERT INTO verifications (interaction_id, source_url, claim, verified, "
                "quote, page_cache_hit, fetch_latency_ms, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (interaction_id, source_url, claim, 1 if verified else 0, quote,
                 1 if page_cache_hit else 0, fetch_latency_ms, ts),
            )

    def log_retrieval(self, interaction_id: str, rank: int, chunk_id: str, url: str,
                      score: float) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT INTO retrievals (interaction_id, rank, chunk_id, url, score) "
                "VALUES (?, ?, ?, ?, ?)",
                (interaction_id, rank, chunk_id, url, score),
            )

    # ---- page cache --------------------------------------------------------
    def cache_get(self, url: str, now: Optional[float] = None) -> Optional[str]:
        """Return cached page text if present AND still within its TTL, else None."""
        ts = _now() if now is None else now
        row = self.conn.execute(
            "SELECT text, fetched_at, ttl_seconds FROM page_cache WHERE url=?", (url,)
        ).fetchone()
        if row is None:
            return None
        if ts - row["fetched_at"] >= row["ttl_seconds"]:
            return None
        return row["text"]

    def cache_put(self, url: str, text: str, ttl_seconds: int,
                  now: Optional[float] = None) -> None:
        ts = _now() if now is None else now
        with self.conn:
            self.conn.execute(
                "INSERT INTO page_cache (url, text, fetched_at, ttl_seconds) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(url) DO UPDATE SET text=excluded.text, "
                "fetched_at=excluded.fetched_at, ttl_seconds=excluded.ttl_seconds",
                (url, text, ts, ttl_seconds),
            )

    # ---- rate limiting (fixed window) --------------------------------------
    def rate_check_and_incr(self, key: str, window_seconds: int, limit: int,
                            now: Optional[float] = None) -> bool:
        """Fixed-window limiter. Returns True if the call is allowed (and counts
        it), False if ``key`` is already at ``limit`` within the current window.
        The first ``limit`` calls in a window pass; the next is rejected."""
        ts = _now() if now is None else now
        with self.conn:
            row = self.conn.execute(
                "SELECT window_start, count FROM rate_limits WHERE key=?", (key,)
            ).fetchone()
            if row is None or (ts - row["window_start"]) >= window_seconds:
                self.conn.execute(
                    "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) "
                    "ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start, "
                    "count=1",
                    (key, ts),
                )
                return True
            if row["count"] >= limit:
                return False
            self.conn.execute(
                "UPDATE rate_limits SET count=count+1 WHERE key=?", (key,)
            )
            return True
