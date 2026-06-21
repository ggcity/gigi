"""Integration tests for the streaming turn loop + async highlight.

Driven with the async fake client (streams word tokens, answers the highlight
tool), fixture Chroma, temp store, and a fake fetcher returning canned page text.
"""

from urllib.parse import urldefrag

import pytest

from backend import fetch as fetch_mod
from backend.fetch import FetchResult
from backend.orchestrator import Orchestrator

WATER_URL = "https://www.ggcity.org/water"
PAGES = {WATER_URL: "You can pay your water bill online or in person at City Hall."}


def make_fetcher(pages):
    async def _fetch_cited(sources, store, settings):
        out = {}
        for s in sources:
            url = urldefrag(s.get("url", "")).url
            if url in pages and url not in out and len(out) < settings.max_cited_urls:
                out[url] = FetchResult(url=url, text=pages[url], cache_hit=False, latency_ms=1)
        return out
    return _fetch_cited


async def _boom_fetcher(sources, store, settings):
    raise AssertionError("fetch must not be called")


def build_orch(fake_client, embedder, collection, store, settings, fetcher=None):
    return Orchestrator(fake_client, embedder, collection, store, settings,
                        fetch_cited=fetcher or make_fetcher(PAGES))


async def run_turn(orch, query="how do I pay my water bill", session="s1"):
    events = []

    async def emit(e):
        events.append(dict(e))

    interaction_id = await orch.handle_turn(query, session, emit)
    return events, interaction_id


def types(events):
    return [e["type"] for e in events]


def call_types(store, iid):
    return [r[0] for r in store.conn.execute(
        "SELECT call_type FROM model_calls WHERE interaction_id=? ORDER BY seq", (iid,)).fetchall()]


# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_streams_answer_then_highlights(fake_client, embedder, collection, store, settings):
    orch = build_orch(fake_client, embedder, collection, store, settings)
    events, iid = await run_turn(orch)

    kinds = types(events)
    assert kinds[0] == "narration"
    assert kinds.count("answer_token") > 1                 # real token streaming
    # The streamed tokens reconstruct the answer text exactly.
    streamed = "".join(e["text"] for e in events if e["type"] == "answer_token")
    assert streamed == fake_client.answer_text
    # answer_done comes before any highlight (highlight is the async enhancement).
    assert "answer_done" in kinds and "highlight" in kinds
    assert kinds.index("answer_done") < kinds.index("highlight")

    hl = [e for e in events if e["type"] == "highlight"][0]
    assert hl["url"] == WATER_URL
    assert hl["quote"] in PAGES[WATER_URL]                 # snapped true substring

    row = store.get_interaction(iid)
    assert row["outcome"] == "answered"
    ct = call_types(store, iid)
    assert ct[0] == "answer" and "highlight" in ct          # no rewrite/verify calls
    assert "rewrite" not in ct and "verify" not in ct


@pytest.mark.asyncio
async def test_no_highlight_setting_skips_fetch_and_pass(fake_client, embedder, collection, store, no_highlight_settings):
    orch = build_orch(fake_client, embedder, collection, store, no_highlight_settings,
                      fetcher=_boom_fetcher)   # would raise if fetched
    events, iid = await run_turn(orch)

    assert store.get_interaction(iid)["outcome"] == "answered"
    assert "answer_done" in types(events)
    assert "highlight" not in types(events)
    assert fake_client.tool_calls("report_highlights") == []
    assert call_types(store, iid) == ["answer"]


@pytest.mark.asyncio
async def test_no_results_not_found(fake_client, embedder, settings, store):
    import chromadb
    empty = chromadb.EphemeralClient().get_or_create_collection(
        name="empty", metadata={"hnsw:space": "cosine"})
    orch = build_orch(fake_client, embedder, empty, store, settings, fetcher=_boom_fetcher)
    events, iid = await run_turn(orch)

    assert types(events)[-1] == "not_found"
    assert events[-1]["redirect_to_human"]["phone"]
    assert store.get_interaction(iid)["outcome"] == "not_found"
    assert fake_client.stream_calls() == []                 # never reached the answer


@pytest.mark.asyncio
async def test_unsnappable_highlight_emits_no_highlight_event(fake_client, embedder, collection, store, settings):
    fake_client.highlight_quote = "this phrase is nowhere on the page"
    orch = build_orch(fake_client, embedder, collection, store, settings)
    events, iid = await run_turn(orch)

    assert store.get_interaction(iid)["outcome"] == "answered"
    assert "highlight" not in types(events)                 # nothing snapped
    # The highlight pass still ran and logged a (miss) verification row.
    assert "highlight" in call_types(store, iid)
    assert store.conn.execute(
        "SELECT verified FROM verifications WHERE interaction_id=?", (iid,)).fetchone()[0] == 0


@pytest.mark.asyncio
async def test_cited_url_not_retrieved_is_not_fetched(fake_client, embedder, collection, store, settings):
    # The answer cites a ggcity page that was NOT in the retrieved set -> not
    # highlighted (relevance filter), so the fetcher is never called for it.
    fake_client.answer_text = "Try the [careers page](https://www.ggcity.org/careers)."
    orch = build_orch(fake_client, embedder, collection, store, settings, fetcher=_boom_fetcher)
    events, iid = await run_turn(orch)

    assert store.get_interaction(iid)["outcome"] == "answered"
    assert "highlight" not in types(events)
    assert fake_client.tool_calls("report_highlights") == []


def test_host_allowed_ssrf_guard(settings):
    assert fetch_mod.host_allowed("https://www.ggcity.org/water", settings) is True
    assert fetch_mod.host_allowed("https://ggcity.org/x", settings) is True
    assert fetch_mod.host_allowed("https://evil.com/x", settings) is False
    assert fetch_mod.host_allowed("https://notggcity.org.evil.com/x", settings) is False


@pytest.mark.asyncio
async def test_followup_rewrites_query_for_retrieval(fake_client, embedder, collection, store, settings):
    store.create_session("s1")
    store.start_interaction("prev", "s1", "first question")
    store.finish_interaction("prev", outcome="answered", final_answer="A prior answer.")

    orch = build_orch(fake_client, embedder, collection, store, settings)
    events, iid = await run_turn(orch, query="what about online?")

    # A follow-up (history present) rewrites the query for RETRIEVAL: the rewrite
    # is the first model call, then the answer.
    ct = call_types(store, iid)
    assert ct[0] == "rewrite" and ct[1] == "answer"
    # The rewrite is a non-tool create call.
    assert any(c["kind"] == "create" and c["tool"] is None for c in fake_client.calls)
    # The rewritten standalone query is logged on the interaction.
    assert store.get_interaction(iid)["rewritten_query"] == fake_client.rewrite_text

    # The ANSWER still gets the original message + carried history (rewrite is
    # retrieval-only — the answer model resolves the follow-up itself).
    stream_kw = fake_client.stream_calls()[0]["kw"]
    msgs = stream_kw["messages"]
    assert len(msgs) > 1
    assert msgs[0]["role"] == "user" and msgs[0]["content"] == "first question"
    assert msgs[-1]["content"] == "what about online?"
