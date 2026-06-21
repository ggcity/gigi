"""Unit tests for the SQLite store: schema, WAL, round-trips, ordering, the
fixed-window limiter, and cache TTL expiry."""

import json


def test_schema_and_wal(store):
    assert store.conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    row = store.conn.execute("SELECT version FROM schema_version").fetchone()
    assert row["version"] == 1
    tables = {r[0] for r in store.conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"sessions", "interactions", "model_calls", "verifications",
            "retrievals", "page_cache", "rate_limits"} <= tables


def test_interaction_round_trip(store):
    store.create_session("s1", now=100.0)
    store.start_interaction("i1", "s1", "how do I pay water?", now=101.0)
    store.finish_interaction(
        "i1", rewritten_query="pay water bill", outcome="answered",
        final_answer="Pay online.", citations=[{"url": "u", "quote": "q"}],
        regen_count=0, tokens_in=12, tokens_out=7, latency_ms=345,
    )
    row = store.get_interaction("i1")
    assert row["outcome"] == "answered"
    assert row["final_answer"] == "Pay online."
    assert json.loads(row["citations"])[0]["url"] == "u"
    assert row["tokens_in"] == 12 and row["latency_ms"] == 345


def test_log_writers_round_trip(store):
    store.create_session("s1")
    store.start_interaction("i1", "s1", "q")
    store.log_model_call("i1", 1, "draft", "sonnet", tokens_in=5, tokens_out=3,
                         latency_ms=10, prompt={"a": 1}, response={"b": 2})
    store.log_verification("i1", "https://x/p", "claim", True, "quote",
                           page_cache_hit=True, fetch_latency_ms=22)
    store.log_retrieval("i1", 0, "chroma-abc", "https://x/p", 0.81)

    mc = store.conn.execute("SELECT * FROM model_calls WHERE interaction_id='i1'").fetchone()
    assert mc["call_type"] == "draft" and json.loads(mc["prompt"]) == {"a": 1}
    v = store.conn.execute("SELECT * FROM verifications WHERE interaction_id='i1'").fetchone()
    assert v["verified"] == 1 and v["page_cache_hit"] == 1 and v["quote"] == "quote"
    r = store.conn.execute("SELECT * FROM retrievals WHERE interaction_id='i1'").fetchone()
    assert r["chunk_id"] == "chroma-abc" and abs(r["score"] - 0.81) < 1e-9


def test_recent_interactions_order(store):
    store.create_session("s1")
    for i, t in enumerate([10.0, 20.0, 30.0]):
        store.start_interaction(f"i{i}", "s1", f"q{i}", now=t)
        store.finish_interaction(f"i{i}", outcome="answered", final_answer=f"a{i}")
    recent = store.recent_interactions("s1", 2)
    # Most recent two, returned oldest-first for chronological history building.
    assert [r["user_query"] for r in recent] == ["q1", "q2"]


def test_rate_limit_flips_at_limit(store):
    allowed = [store.rate_check_and_incr("ip:x", 60, 3, now=1000.0) for _ in range(4)]
    assert allowed == [True, True, True, False]
    # A new window resets the counter.
    assert store.rate_check_and_incr("ip:x", 60, 3, now=1000.0 + 61) is True


def test_cache_ttl_expiry(store):
    store.cache_put("https://x/p", "page text", ttl_seconds=100, now=1000.0)
    assert store.cache_get("https://x/p", now=1050.0) == "page text"   # fresh
    assert store.cache_get("https://x/p", now=1100.0) is None          # expired (>= ttl)
    assert store.cache_get("https://x/missing", now=1000.0) is None
