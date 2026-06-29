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


def make_fetcher_final(pages, final_url):
    async def _fetch_cited(sources, store, settings):
        out = {}
        for s in sources:
            url = urldefrag(s.get("url", "")).url
            if url in pages and url not in out and len(out) < settings.max_cited_urls:
                out[url] = FetchResult(url=url, text=pages[url], cache_hit=False,
                                       latency_ms=1, final_url=final_url)
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
    # decompose (retrieval) -> answer -> gap -> highlight; no legacy rewrite/verify.
    assert ct[0] == "decompose" and "answer" in ct and "highlight" in ct
    assert "rewrite" not in ct and "verify" not in ct
    # Default gap inspection finds no gap (fake gap_query="") -> no supplement.
    assert "gap" in ct and "supplement" not in ct
    assert "supplement_start" not in kinds


@pytest.mark.asyncio
async def test_highlight_carries_final_url(fake_client, embedder, collection, store, settings):
    # When the cited page redirected, the post-redirect URL rides on the highlight
    # event so the frontend can dedupe tiles that resolve to the same page.
    final = "https://www.ggcity.org/finance/water-billing"
    orch = build_orch(fake_client, embedder, collection, store, settings,
                      fetcher=make_fetcher_final(PAGES, final))
    events, _ = await run_turn(orch)
    hl = [e for e in events if e["type"] == "highlight"][0]
    assert hl.get("final_url") == final


@pytest.mark.asyncio
async def test_no_highlight_setting_skips_fetch_and_pass(fake_client, embedder, collection, store, no_highlight_settings):
    orch = build_orch(fake_client, embedder, collection, store, no_highlight_settings,
                      fetcher=_boom_fetcher)   # would raise if fetched
    events, iid = await run_turn(orch)

    assert store.get_interaction(iid)["outcome"] == "answered"
    assert "answer_done" in types(events)
    assert "highlight" not in types(events)
    assert fake_client.tool_calls("report_highlights") == []
    # Gap inspection is independent of highlighting and still runs (no gap -> no supplement).
    assert call_types(store, iid) == ["decompose", "answer", "gap"]


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
async def test_followup_decomposes_query_for_retrieval(fake_client, embedder, collection, store, settings):
    store.create_session("s1")
    store.start_interaction("prev", "s1", "first question")
    store.finish_interaction("prev", outcome="answered", final_answer="A prior answer.")

    # Script a decomposition whose first query differs from the raw message, so the
    # standalone (rewritten) query is what gets logged on the interaction.
    fake_client.decomposed = ["pay water bill online"]
    orch = build_orch(fake_client, embedder, collection, store, settings)
    events, iid = await run_turn(orch, query="what about online?")

    # Decomposition is the first model call (a forced tool call), then the answer.
    ct = call_types(store, iid)
    assert ct[0] == "decompose" and ct[1] == "answer"
    assert fake_client.tool_calls("decompose_queries")
    # The primary standalone query is logged on the interaction.
    assert store.get_interaction(iid)["rewritten_query"] == "pay water bill online"

    # The ANSWER still gets the original message + carried history (decomposition is
    # retrieval-only — the answer model resolves the follow-up itself).
    stream_kw = fake_client.stream_calls()[0]["kw"]
    msgs = stream_kw["messages"]
    assert len(msgs) > 1
    assert msgs[0]["role"] == "user" and msgs[0]["content"] == "first question"
    assert msgs[-1]["content"] == "what about online?"


@pytest.mark.asyncio
async def test_decomposition_retrieves_each_query_and_merges(fake_client, embedder, collection, store, settings):
    # Two distinct sub-topics. Each query (against the fixture, min_score=0) returns
    # BOTH docs, so without merge the retrieval log would have 4 rows; merge dedups
    # by content to the 2 distinct pages.
    fake_client.decomposed = ["pay water bill", "building permit fee"]
    orch = build_orch(fake_client, embedder, collection, store, settings)
    events, iid = await run_turn(orch, query="water bill and a building permit")

    assert len(fake_client.tool_calls("decompose_queries")) == 1
    n = store.conn.execute(
        "SELECT COUNT(*) FROM retrievals WHERE interaction_id=?", (iid,)).fetchone()[0]
    assert n == 2                                            # merged & deduped, not 4
    urls = {r[0] for r in store.conn.execute(
        "SELECT DISTINCT url FROM retrievals WHERE interaction_id=?", (iid,)).fetchall()}
    assert urls == {"https://www.ggcity.org/water", "https://www.ggcity.org/permits"}


@pytest.mark.asyncio
async def test_gap_triggers_additive_supplement(fake_client, embedder, store, settings):
    # A collection with two well-separated docs and top_k=1 so the primary query
    # retrieves only the water doc and the gap query surfaces the (novel) trash doc.
    import dataclasses
    import chromadb
    coll = chromadb.EphemeralClient().get_or_create_collection(
        name="sup", metadata={"hnsw:space": "cosine"})
    docs = [
        "water bill payment online options portal account",
        "garbage trash pickup schedule collection days route",
    ]
    metas = [
        {"title": "Water Billing", "url": "https://www.ggcity.org/water", "file_type": "html"},
        {"title": "Trash Schedule", "url": "https://www.ggcity.org/trash", "file_type": "html"},
    ]
    coll.upsert(ids=["w", "t"], embeddings=embedder.embed_documents(docs),
                documents=docs, metadatas=metas)

    st = dataclasses.replace(settings, top_k=1, highlight_enabled=False)
    fake_client.decomposed = ["water bill payment online"]   # -> water doc only
    fake_client.gap_query = "garbage trash pickup schedule"  # -> trash doc (novel)
    fake_client.supplement_text = "Trash is collected on your route's scheduled day."

    orch = Orchestrator(fake_client, embedder, coll, store, st, fetch_cited=_boom_fetcher)
    events, iid = await run_turn(orch, query="how do I pay my water bill")

    kinds = types(events)
    assert "supplement_start" in kinds and "supplement_done" in kinds
    assert kinds.index("answer_done") < kinds.index("supplement_start")
    assert (kinds.index("supplement_start") < kinds.index("supplement_token")
            < kinds.index("supplement_done"))
    ss = [e for e in events if e["type"] == "supplement_start"][0]
    assert ss["text"] == "Let me find that…"
    # supplement tokens reconstruct the supplement text.
    streamed = "".join(e["text"] for e in events if e["type"] == "supplement_token")
    assert streamed == fake_client.supplement_text

    ct = call_types(store, iid)
    assert ct == ["decompose", "answer", "gap", "supplement"]
    # Persisted answer is the main answer + the supplement (additive, not a replacement).
    final = store.get_interaction(iid)["final_answer"]
    assert fake_client.answer_text in final and fake_client.supplement_text in final


@pytest.mark.asyncio
async def test_gap_with_no_novel_chunks_skips_supplement(fake_client, embedder, collection, store, settings):
    # The fixture (min_score=0, top_k=5) retrieves BOTH docs on every query, so any
    # gap re-retrieval returns only already-seen chunks -> the supplement is skipped.
    fake_client.gap_query = "water division phone number"
    orch = build_orch(fake_client, embedder, collection, store, settings)
    events, iid = await run_turn(orch)

    kinds = types(events)
    assert "supplement_start" not in kinds and "supplement_done" not in kinds
    ct = call_types(store, iid)
    assert "gap" in ct and "supplement" not in ct


@pytest.mark.asyncio
async def test_gap_inspection_disabled(fake_client, embedder, collection, store, settings):
    import dataclasses
    st = dataclasses.replace(settings, gap_inspection_enabled=False)
    fake_client.gap_query = "water division phone number"    # would trigger if enabled
    orch = build_orch(fake_client, embedder, collection, store, st)
    events, iid = await run_turn(orch)

    ct = call_types(store, iid)
    assert "gap" not in ct and "supplement" not in ct
    assert "supplement_start" not in types(events)
    assert fake_client.tool_calls("report_gap") == []
