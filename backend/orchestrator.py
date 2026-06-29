#!/usr/bin/env python3
"""
The turn loop: retrieve -> stream answer -> (async) highlight.

``Orchestrator.handle_turn`` runs one user turn and pushes protocol events
through an injected async ``emit`` callback, so it is transport-agnostic: the
FastAPI WebSocket, the CLI driver, and the tests all drive the same code
(V3.md sections 2.3-2.6).

Responsiveness is the priority: there is no pre-answer verify gate. On a follow-up
turn (history present) one small Haiku call rewrites the message into a standalone
query for retrieval only (v2 behavior, language-agnostic — see ``backend/rewrite.py``);
the first turn skips it and retrieves on the raw message. Either way Sonnet then
streams a prose answer with inline ``[title](url)`` citations token-by-token, given
the ORIGINAL message plus the conversation history (so it resolves follow-ups itself;
the rewrite only feeds the embedder). After the answer finishes, highlighting runs as
a NON-BLOCKING enhancement (default on): the cited pages are fetched, Haiku finds the
verbatim span, it is snapped to a true substring, and a ``highlight`` event is emitted
per cited page so the shell can highlight an already-open tile. The frontend opens the
tiles itself by parsing the streamed markdown links.

All model-call / highlight / retrieval writes are centralized here (per-interaction
``seq`` counter + token totals), wrapped in ``asyncio.to_thread`` (sync store).
"""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional
from urllib.parse import urldefrag

from shared import rag_core

from . import answer as answer_mod
from . import fetch as fetch_mod
from . import gap as gap_mod
from . import highlight as highlight_mod
from . import rewrite as rewrite_mod
from .config import Settings

logger = logging.getLogger(__name__)

EmitFn = Callable[[Dict[str, Any]], Awaitable[None]]

# Shown to the resident while the gap supplement is being retrieved + streamed.
SUPPLEMENT_NARRATION = "Let me find that…"

NOT_FOUND_TEXT = (
    "I could not find this on the City of Garden Grove website. I don't want to "
    "guess, so I'd rather point you to someone who can help directly."
)
HUMAN_REDIRECT = {
    "label": "Contact the City of Garden Grove",
    "url": "https://www.ggcity.org/contact",
    "phone": "(714) 741-5000",
}


@dataclass
class _TurnState:
    """Mutable per-turn bookkeeping: the model-call sequence number and the
    running token totals logged onto the interaction."""
    seq: int = 0
    tokens_in: int = 0
    tokens_out: int = 0


class Orchestrator:
    def __init__(self, client, embedder, collection, store, settings: Settings,
                 fetch_cited: Callable[..., Awaitable[Dict[str, fetch_mod.FetchResult]]] = None,
                 debug: Callable[[str], None] = None):
        self.client = client            # AsyncAnthropic
        self.embedder = embedder
        self.collection = collection
        self.store = store
        self.settings = settings
        # Injectable so tests can supply a fake fetcher returning canned text.
        self._fetch_cited = fetch_cited or fetch_mod.fetch_cited
        # Optional diagnostic sink (the CLI wires this to stderr). Kept separate
        # from the event `emit` so it never leaks into the WS protocol.
        self._debug = debug or (lambda _msg: None)

    def _dbg(self, msg: str) -> None:
        self._debug(msg)

    async def _to_thread(self, fn, *a, **kw):
        return await asyncio.to_thread(fn, *a, **kw)

    async def _log_call(self, state: _TurnState, interaction_id: str, call_type: str,
                        model: str, *, tokens_in: int = 0, tokens_out: int = 0,
                        latency_ms: int = None, prompt: Any = None, response: Any = None):
        state.seq += 1
        state.tokens_in += tokens_in or 0
        state.tokens_out += tokens_out or 0
        await self._to_thread(
            self.store.log_model_call, interaction_id, state.seq, call_type, model,
            tokens_in=tokens_in, tokens_out=tokens_out, latency_ms=latency_ms,
            prompt=prompt, response=response,
        )

    # ---- the turn ----------------------------------------------------------
    async def handle_turn(self, query: str, session_id: str, emit: EmitFn) -> str:
        """Run one turn end to end. Returns the interaction_id."""
        t_start = time.perf_counter()
        interaction_id = str(uuid.uuid4())
        state = _TurnState()

        async def _emit(event: Dict[str, Any]):
            event.setdefault("interaction_id", interaction_id)
            await emit(event)

        # 1. Bookkeeping. No model call.
        await self._to_thread(self.store.create_session, session_id)
        await self._to_thread(self.store.touch_session, session_id)
        history = await self._build_history(session_id, interaction_id)
        await self._to_thread(self.store.start_interaction, interaction_id, session_id, query)
        await _emit({"type": "narration", "text": "Looking this up on the city website…"})
        self._dbg(f"interaction {interaction_id}  session={session_id}")
        self._dbg(f"query: {query!r}  (history: {len(history)} msg)")

        # 2. Retrieval via query decomposition. One Haiku call turns the message into
        # 1-3 standalone queries (references resolved; extra queries only for distinct
        # sub-topics or entity-then-attribute gaps). Each is retrieved in parallel and
        # the results merged by content hash. The answer model still gets the original
        # query + full history; the queries are retrieval-only.
        rewritten_query = None
        queries, tin, tout, lat = await rewrite_mod.decompose_for_retrieval(
            self.client, self.settings.rewrite_model, query, history,
            max_queries=self.settings.decompose_max_queries)
        await self._log_call(
            state, interaction_id, "decompose", self.settings.rewrite_model,
            tokens_in=tin, tokens_out=tout, latency_ms=lat,
            prompt={"message": query}, response={"queries": queries})
        if queries and queries[0] != query:
            rewritten_query = queries[0]
        self._dbg(f"decompose: {query!r} → {queries!r}")

        result_lists = await asyncio.gather(*[
            self._to_thread(
                rag_core.search_knowledge_base, self.embedder, self.collection,
                q, self.settings.top_k, self.settings.min_score)
            for q in queries
        ])
        results = rag_core.merge_results(result_lists, self.settings.top_k)
        for rank, r in enumerate(results):
            await self._to_thread(
                self.store.log_retrieval, interaction_id, rank,
                r.get("chroma_id", ""), urldefrag(r.get("url", "")).url, r.get("score", 0.0),
            )
        self._dbg(f"retrieval: {len(results)} merged chunk(s) from {len(queries)} "
                  f"quer{'y' if len(queries) == 1 else 'ies'} >= min_score {self.settings.min_score}")
        for rank, r in enumerate(results):
            self._dbg(f"  [{rank}] score={r.get('score', 0.0):.3f}  {urldefrag(r.get('url','')).url}")
        if not results:
            self._dbg("BRANCH: not_found (no retrieval results)")
            return await self._not_found(state, interaction_id, _emit, t_start, rewritten_query)
        # Content hashes of the retrieved set — the gap pass (step 4) compares against
        # these so it only supplements with chunks not already in front of the model.
        first_hashes = {rag_core.content_key(r.get("content", "")) for r in results}

        # 3. Stream the prose answer token-by-token.
        context, sources = rag_core.format_context_and_sources(results)
        today = rag_core.today_str()
        self._dbg("streaming answer…")
        full_text, tin, tout = await answer_mod.stream_answer(
            self.client, self.settings.answer_model, query, context, sources, history, today,
            _emit, max_tokens=self.settings.max_tokens, temperature=self.settings.temperature,
        )
        await self._log_call(
            state, interaction_id, "answer", self.settings.answer_model,
            tokens_in=tin, tokens_out=tout,
            prompt={"query": query, "sources": [s["url"] for s in sources]},
            response={"answer": full_text},
        )
        await _emit({"type": "answer_done", "answer": full_text})
        self._dbg(f"answer streamed ({len(full_text)} chars)")

        # 4. Post-stream gap inspection (default on). One Haiku call decides whether
        # the answer points at an actionable detail (contact, phone, fee, hours,
        # address) it did not actually provide. On a gap, retrieve once more; if it
        # surfaces chunks not already retrieved, stream a short ADDITIVE supplement
        # after a brief "Let me find that…" indicator. The first answer stays put.
        supplement_text = ""
        supplement_sources: List[Dict[str, Any]] = []
        if self.settings.gap_inspection_enabled:
            gap_query, tin, tout, lat = await gap_mod.inspect_gap(
                self.client, self.settings.rewrite_model, query, full_text, queries)
            await self._log_call(
                state, interaction_id, "gap", self.settings.rewrite_model,
                tokens_in=tin, tokens_out=tout, latency_ms=lat,
                prompt={"query": query, "queries": queries}, response={"gap_query": gap_query})
            self._dbg(f"gap decision: {gap_query!r}" if gap_query
                      else "gap decision: none (answer complete)")
            if gap_query:
                gap_results = await self._to_thread(
                    rag_core.search_knowledge_base, self.embedder, self.collection,
                    gap_query, self.settings.top_k, self.settings.min_score)
                # Hard guard: only chunks not already in front of the model count.
                novel = [r for r in gap_results
                         if rag_core.content_key(r.get("content", "")) not in first_hashes]
                for i, r in enumerate(novel):
                    await self._to_thread(
                        self.store.log_retrieval, interaction_id, len(results) + i,
                        r.get("chroma_id", ""), urldefrag(r.get("url", "")).url, r.get("score", 0.0))
                if novel:
                    self._dbg(f"gap: {len(novel)} novel chunk(s) → supplement")
                    await _emit({"type": "supplement_start", "text": SUPPLEMENT_NARRATION})
                    sup_context, supplement_sources = rag_core.format_context_and_sources(novel)
                    supplement_text, stin, stout = await answer_mod.stream_supplement(
                        self.client, self.settings.answer_model, query, full_text,
                        sup_context, supplement_sources, today, _emit,
                        max_tokens=self.settings.supplement_max_tokens,
                        temperature=self.settings.temperature)
                    await self._log_call(
                        state, interaction_id, "supplement", self.settings.answer_model,
                        tokens_in=stin, tokens_out=stout,
                        prompt={"query": query, "gap_query": gap_query,
                                "sources": [s["url"] for s in supplement_sources]},
                        response={"answer": supplement_text})
                    await _emit({"type": "supplement_done", "answer": supplement_text})
                    self._dbg(f"supplement streamed ({len(supplement_text)} chars)")
                else:
                    self._dbg("gap: no novel chunks, no supplement")

        # 5. Async highlight enhancement (default on, non-blocking). Runs over the
        # main answer plus any supplement, so a supplement's new citation is
        # highlighted too (its source page is added to the relevance set).
        combined_answer = full_text if not supplement_text else f"{full_text}\n\n{supplement_text}"
        citations = answer_mod.parse_citations(combined_answer)
        highlights = await self._run_highlights(
            state, interaction_id, _emit, citations, sources + supplement_sources)

        # 6. Persist. citations = the cited pages (deduped), quote filled where highlighted.
        quote_by_url = {h["url"]: h["quote"] for h in highlights}
        cited_urls, seen = [], set()
        for c in citations:
            if c["url"] not in seen:
                seen.add(c["url"])
                cited_urls.append(c["url"])
        citation_log = [{"url": u, "quote": quote_by_url.get(u, "")} for u in cited_urls]
        await self._to_thread(
            self.store.finish_interaction, interaction_id, rewritten_query=rewritten_query,
            outcome="answered", final_answer=combined_answer, citations=citation_log,
            regen_count=0, tokens_in=state.tokens_in, tokens_out=state.tokens_out,
            latency_ms=int((time.perf_counter() - t_start) * 1000),
        )
        return interaction_id

    # ---- async highlight ---------------------------------------------------
    async def _run_highlights(self, state: _TurnState, interaction_id: str, emit: EmitFn,
                              citations: List[Dict[str, str]],
                              sources: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        """Fetch each cited page and emit a `highlight` event with the snapped
        span. Returns the highlights produced ({url, quote}). Cited pages are
        restricted to the retrieved source set (relevance) and allowed hosts (SSRF
        guard, enforced again in fetch). Disabled via `highlight_enabled`."""
        if not self.settings.highlight_enabled or not citations:
            self._dbg("highlight: disabled or no citations")
            return []

        source_urls = {urldefrag(s.get("url", "")).url for s in sources}
        # Group claims by cited URL, keeping only retrieved + host-allowed pages.
        url_claims: Dict[str, List[Dict[str, str]]] = {}
        for i, c in enumerate(citations):
            url = c["url"]
            if url not in source_urls or not fetch_mod.host_allowed(url, self.settings):
                continue
            url_claims.setdefault(url, []).append({"id": f"c{i}", "text": c["claim"]})
        if not url_claims:
            self._dbg("highlight: no cited page is both retrieved and host-allowed")
            return []

        self._dbg(f"highlight: {sum(len(v) for v in url_claims.values())} claim(s) "
                  f"across {len(url_claims)} page(s)")
        pages = await self._fetch_cited([{"url": u} for u in url_claims], self.store, self.settings)

        async def _one(url, claims):
            fr = pages.get(url)
            if not fr:
                return (url, None, None)
            res = await highlight_mod.highlight_claims(
                self.client, self.settings.highlight_model, claims, fr.text)
            return (url, fr, res)

        batches = await asyncio.gather(*[_one(u, c) for u, c in url_claims.items()])

        highlights: List[Dict[str, str]] = []
        for url, fr, res in batches:
            if fr is None:
                self._dbg(f"  highlight {url}: page unreachable")
                continue
            await self._log_call(
                state, interaction_id, "highlight", self.settings.highlight_model,
                tokens_in=res.tokens_in, tokens_out=res.tokens_out, latency_ms=res.latency_ms,
                prompt=res.prompt_payload, response=res.response_payload)
            for claim in url_claims[url]:
                v = res.verdicts.get(claim["id"]) or highlight_mod.Verdict(claim["id"], False)
                snapped = highlight_mod.snap(v.quote, fr.text) if v.verified else None
                await self._to_thread(
                    self.store.log_verification, interaction_id, url, claim["text"],
                    bool(snapped), snapped or v.quote, page_cache_hit=fr.cache_hit,
                    fetch_latency_ms=fr.latency_ms)
                self._dbg(f"  highlight {url}: quote={v.quote!r}  snap={'ok' if snapped else 'None'}")
                if snapped:
                    # final_url (post-redirect) lets the frontend dedupe tiles that
                    # resolve to the same page; None on a cache hit.
                    evt = {"type": "highlight", "url": url, "quote": snapped}
                    if fr.final_url and fr.final_url != url:
                        evt["final_url"] = fr.final_url
                    await emit(evt)
                    highlights.append({"url": url, "quote": snapped})
        return highlights

    # ---- helpers -----------------------------------------------------------
    async def _build_history(self, session_id: str, interaction_id: str) -> List[Dict]:
        rows = await self._to_thread(
            self.store.recent_interactions, session_id, self.settings.max_history_messages + 1
        )
        history: List[Dict] = []
        for r in rows:
            if r.get("interaction_id") == interaction_id:
                continue
            if r.get("user_query"):
                history.append({"role": "user", "content": r["user_query"]})
            if r.get("final_answer") and r.get("outcome") == "answered":
                history.append({"role": "assistant", "content": r["final_answer"]})
        return history[-(2 * self.settings.max_history_messages):]

    async def _not_found(self, state: _TurnState, interaction_id: str, emit: EmitFn,
                         t_start: float, rewritten_query: str = None) -> str:
        await emit({"type": "not_found", "text": NOT_FOUND_TEXT,
                    "redirect_to_human": HUMAN_REDIRECT})
        await self._to_thread(
            self.store.finish_interaction, interaction_id, rewritten_query=rewritten_query,
            outcome="not_found", final_answer=None, citations=None,
            regen_count=0, tokens_in=state.tokens_in, tokens_out=state.tokens_out,
            latency_ms=int((time.perf_counter() - t_start) * 1000),
        )
        return interaction_id
