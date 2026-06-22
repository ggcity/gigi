#!/usr/bin/env python3
"""
FastAPI app: WebSocket endpoint, the event protocol, and request guards.

A turn is bidirectional within itself, so transport is a WebSocket (V3.md
section 2.6). The Anthropic key lives only here, server-side. Outbound event
types: ``narration``, ``answer_token`` (streamed prose), ``answer_done``,
``highlight`` (async, one per cited page after the answer), ``not_found`` (and
``session`` / ``error`` envelope events). There is no ``open_tiles`` event — the
frontend opens tiles by parsing the streamed markdown links itself. Inbound
client events: ``query`` and the companion-miss ``tile_result`` (accepted and
logged now; acted on in Phase 3/4).

Guards run BEFORE any model call: oversized queries are rejected, and per-IP and
per-session fixed-window rate limits short-circuit to a throttle event.

``create_app`` is a factory so tests can inject fake deps; the production
``app`` builds real deps (Embedder, Chroma, Anthropic, SQLite) in its lifespan.
"""

import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from .config import Settings
from .orchestrator import HUMAN_REDIRECT, Orchestrator
from .store import Store

logger = logging.getLogger(__name__)


@dataclass
class Deps:
    orchestrator: Orchestrator
    store: Store
    settings: Settings


def build_deps(settings: Optional[Settings] = None, debug=None) -> Deps:
    """Construct the real serving dependencies. Heavy: loads the embedding model
    and opens Chroma + SQLite + the Anthropic client. Shared by the lifespan and
    the CLI driver. ``debug`` is an optional diagnostic sink passed to the
    orchestrator (the CLI wires it to stderr; the server leaves it off)."""
    import chromadb
    from anthropic import AsyncAnthropic

    from shared.rag_embeddings import Embedder

    settings = settings or Settings.from_env()
    store = Store(settings.sqlite_path)
    embedder = Embedder(model_name=settings.embedding_model, device="cpu")
    chroma = chromadb.PersistentClient(path=settings.chroma_path)
    collection = chroma.get_or_create_collection(
        name=settings.chroma_collection, metadata={"hnsw:space": "cosine"}
    )
    # Async client so the answer can stream token-by-token on the event loop.
    # Key from ANTHROPIC_API_KEY; never leaves the server.
    client = AsyncAnthropic()
    orchestrator = Orchestrator(client, embedder, collection, store, settings, debug=debug)
    return Deps(orchestrator=orchestrator, store=store, settings=settings)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # Respect deps injected by a test; otherwise build the real stack.
    if not getattr(app.state, "deps", None):
        app.state.deps = await asyncio.to_thread(build_deps)
    yield
    deps = getattr(app.state, "deps", None)
    if deps and deps.store:
        deps.store.close()


def create_app(deps: Optional[Deps] = None) -> FastAPI:
    app = FastAPI(title="Gigi V3 backend", lifespan=_lifespan)
    if deps is not None:
        app.state.deps = deps

    @app.get("/healthz")
    async def healthz():
        return {"status": "ok"}

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        deps: Deps = ws.app.state.deps
        store, settings = deps.store, deps.settings
        await ws.accept()
        ip = ws.client.host if ws.client else "unknown"
        try:
            while True:
                msg = await ws.receive_json()
                await _handle_message(ws, deps, ip, msg)
        except WebSocketDisconnect:
            return
        except Exception as e:  # never let one bad turn kill the socket silently
            logger.exception("WebSocket turn failed")
            try:
                await ws.send_json({"type": "error", "text": f"internal error: {e}"})
            except Exception:
                pass

    # Serve the built Gigi shell bundle (frontend-gigi/dist) at "/", if present, so the
    # backend is the single origin in production and in the "prod-like" local run. The
    # mount is registered LAST so /ws and /healthz take precedence (a "/" mount matches
    # every path). It is skipped entirely when the bundle hasn't been built, so Phase 1
    # behavior — and the existing tests — are unchanged when dist/ is absent. html=True
    # serves index.html for unmatched paths so the SPA entry resolves.
    dist = Path(__file__).resolve().parent.parent / "frontend-gigi" / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="gigi-shell")

    return app


async def _throttle(ws: WebSocket, text: str):
    await ws.send_json({"type": "not_found", "text": text, "redirect_to_human": HUMAN_REDIRECT})


async def _handle_message(ws: WebSocket, deps: Deps, ip: str, msg: dict):
    store, settings = deps.store, deps.settings
    mtype = msg.get("type")

    if mtype == "tile_result":
        # Companion DOM-miss report. Accepted/logged in Phase 1, acted on later.
        logger.info("tile_result report: %s", msg)
        return
    if mtype != "query":
        await ws.send_json({"type": "error", "text": f"unknown event type: {mtype!r}"})
        return

    text = (msg.get("text") or "").strip()
    session_id = msg.get("session_id") or str(uuid.uuid4())
    # Surface the session id so the client can reuse it across turns.
    await ws.send_json({"type": "session", "session_id": session_id})

    if not text:
        await _throttle(ws, "Please enter a question about City of Garden Grove services.")
        return
    if len(text) > settings.max_query_chars:
        await _throttle(ws, "That question is too long. Please shorten it and try again.")
        return

    # Rate limits run before any model call.
    allowed_ip = await asyncio.to_thread(
        store.rate_check_and_incr, f"ip:{ip}", settings.rate_window_seconds,
        settings.rate_limit_per_ip,
    )
    allowed_session = await asyncio.to_thread(
        store.rate_check_and_incr, f"session:{session_id}", settings.rate_window_seconds,
        settings.rate_limit_per_session,
    )
    if not (allowed_ip and allowed_session):
        await _throttle(ws, "You've sent a lot of requests in a short time. Please wait a moment and try again.")
        return

    await deps.orchestrator.handle_turn(text, session_id, ws.send_json)


# Production ASGI app (built lazily in lifespan).
app = create_app()
