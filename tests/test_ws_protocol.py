"""WebSocket protocol tests via FastAPI's TestClient: a query yields the streamed
event sequence; oversized and over-limit requests hit the reject path with no
model calls."""

from urllib.parse import urldefrag

from fastapi.testclient import TestClient

from backend.app import Deps, create_app
from backend.fetch import FetchResult
from backend.orchestrator import Orchestrator

WATER_URL = "https://www.ggcity.org/water"
PAGES = {WATER_URL: "You can pay your water bill online or in person at City Hall."}


async def _fetcher(sources, store, settings):
    out = {}
    for s in sources:
        url = urldefrag(s.get("url", "")).url
        if url in PAGES and url not in out:
            out[url] = FetchResult(url=url, text=PAGES[url], cache_hit=False, latency_ms=1)
    return out


def _app(fake_client, embedder, collection, store, settings):
    orch = Orchestrator(fake_client, embedder, collection, store, settings, fetch_cited=_fetcher)
    return create_app(Deps(orchestrator=orch, store=store, settings=settings))


def _drain(ws, limit=80):
    """Read until the turn is clearly done: a not_found, or a highlight (which
    only comes after answer_done), or answer_done with no highlight to follow."""
    out = []
    for _ in range(limit):
        e = ws.receive_json()
        out.append(e)
        if e["type"] in ("not_found", "highlight"):
            break
    return out


def test_healthz(fake_client, embedder, collection, store, settings):
    app = _app(fake_client, embedder, collection, store, settings)
    with TestClient(app) as c:
        assert c.get("/healthz").json() == {"status": "ok"}


def test_query_event_sequence(fake_client, embedder, collection, store, settings):
    app = _app(fake_client, embedder, collection, store, settings)
    with TestClient(app) as c:
        with c.websocket_connect("/ws") as ws:
            ws.send_json({"type": "query", "text": "pay water bill", "session_id": "S"})
            seq = _drain(ws)

    kinds = [e["type"] for e in seq]
    assert kinds[0] == "session" and seq[0]["session_id"] == "S"
    assert kinds[1] == "narration"
    assert kinds.count("answer_token") > 1            # real token streaming
    assert "answer_done" in kinds
    assert kinds[-1] == "highlight"                   # async enhancement after answer
    assert kinds.index("answer_done") < kinds.index("highlight")
    assert seq[-1]["url"] == WATER_URL and seq[-1]["quote"] in PAGES[WATER_URL]


def test_no_open_tiles_event(fake_client, embedder, collection, store, settings):
    # The backend no longer emits open_tiles; the frontend parses links itself.
    app = _app(fake_client, embedder, collection, store, settings)
    with TestClient(app) as c:
        with c.websocket_connect("/ws") as ws:
            ws.send_json({"type": "query", "text": "pay water bill", "session_id": "S"})
            seq = _drain(ws)
    assert "open_tiles" not in [e["type"] for e in seq]


def test_oversized_query_rejected_without_model_call(fake_client, embedder, collection, store, settings):
    app = _app(fake_client, embedder, collection, store, settings)
    with TestClient(app) as c:
        with c.websocket_connect("/ws") as ws:
            ws.send_json({"type": "query", "text": "x" * (settings.max_query_chars + 1),
                          "session_id": "S"})
            assert ws.receive_json()["type"] == "session"
            rej = ws.receive_json()
    assert rej["type"] == "not_found"
    assert fake_client.calls == []   # no model call


def test_rate_limit_rejected_without_model_call(fake_client, embedder, collection, store, tmp_path):
    from backend.config import Settings
    settings = Settings(sqlite_path=str(tmp_path / "g.db"), min_score=0.0,
                        rate_limit_per_session=3, rate_limit_per_ip=1000)
    for _ in range(3):
        store.rate_check_and_incr("session:S", settings.rate_window_seconds,
                                  settings.rate_limit_per_session)
    app = _app(fake_client, embedder, collection, store, settings)
    with TestClient(app) as c:
        with c.websocket_connect("/ws") as ws:
            ws.send_json({"type": "query", "text": "pay water bill", "session_id": "S"})
            assert ws.receive_json()["type"] == "session"
            rej = ws.receive_json()
    assert rej["type"] == "not_found"
    assert fake_client.calls == []   # throttled before any model call


def test_supplement_event_sequence(fake_client, embedder, store, tmp_path):
    # A gap supplement streams over the WS after answer_done: supplement_start ->
    # supplement_token* -> supplement_done. Two separated docs + top_k=1 so the gap
    # query surfaces a novel chunk; highlight off so the turn ends at supplement_done.
    import chromadb
    from backend.config import Settings
    coll = chromadb.EphemeralClient().get_or_create_collection(
        name="supws", metadata={"hnsw:space": "cosine"})
    docs = ["water bill payment online options portal account",
            "garbage trash pickup schedule collection days route"]
    metas = [{"title": "Water Billing", "url": WATER_URL, "file_type": "html"},
             {"title": "Trash Schedule", "url": "https://www.ggcity.org/trash", "file_type": "html"}]
    coll.upsert(ids=["w", "t"], embeddings=embedder.embed_documents(docs),
                documents=docs, metadatas=metas)
    settings = Settings(sqlite_path=str(tmp_path / "g.db"), min_score=0.0, top_k=1,
                        highlight_enabled=False, rate_limit_per_ip=1000, rate_limit_per_session=1000)
    fake_client.decomposed = ["water bill payment online"]
    fake_client.gap_query = "garbage trash pickup schedule"
    fake_client.supplement_text = "Trash is collected on your route's scheduled day."

    app = _app(fake_client, embedder, coll, store, settings)
    with TestClient(app) as c:
        with c.websocket_connect("/ws") as ws:
            ws.send_json({"type": "query", "text": "how do I pay my water bill", "session_id": "S"})
            seq = []
            for _ in range(80):
                e = ws.receive_json()
                seq.append(e)
                if e["type"] == "supplement_done":
                    break

    kinds = [e["type"] for e in seq]
    assert "answer_done" in kinds and kinds[-1] == "supplement_done"
    assert kinds.index("answer_done") < kinds.index("supplement_start")
    assert "supplement_token" in kinds
    assert [e for e in seq if e["type"] == "supplement_start"][0]["text"] == "Let me find that…"


def test_unknown_event_type(fake_client, embedder, collection, store, settings):
    app = _app(fake_client, embedder, collection, store, settings)
    with TestClient(app) as c:
        with c.websocket_connect("/ws") as ws:
            ws.send_json({"type": "bogus"})
            assert ws.receive_json()["type"] == "error"
