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


def test_unknown_event_type(fake_client, embedder, collection, store, settings):
    app = _app(fake_client, embedder, collection, store, settings)
    with TestClient(app) as c:
        with c.websocket_connect("/ws") as ws:
            ws.send_json({"type": "bogus"})
            assert ws.receive_json()["type"] == "error"
