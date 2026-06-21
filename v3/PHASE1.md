# Phase 1 — Backend Orchestration Core (Implementation Plan)

## Context

Gigi v2 is a Gradio RAG chatbot (retrieve → rewrite → Sonnet prose answer with markdown
citations). V3 (spec in `V3.md`) replaces it with an agentic backend that **proves the
answer before showing it**: retrieve → structured draft → fetch the cited live pages →
verify each claim against fresh page text → branch (pass / one informed regen / not-found).
Nothing reaches the user until verification passes. The optimization target is *honest
"not found" over confident-but-unsupported answers* (low false positives > coverage).

> **Revision (post-implementation) — the gated design below was replaced by a single
> streaming pipeline.** The structured-draft verify/highlight gate forced a full draft
> (~12s) before any text could show, which fails the responsiveness bar. What actually
> ships now:
> - **Verify mode + the structured claim-tagged draft are deleted** (no gate, no regen,
>   no not-found-on-failure). The Haiku follow-up **rewrite is retained for retrieval
>   only**: on a follow-up turn it rewrites the message into a standalone Chroma query
>   (reusing `shared/rag_core`'s prompt via `backend/rewrite.py`, language-agnostic); the
>   first turn uses the raw message. The answer still streams from the **original** message
>   + history, so Sonnet resolves the follow-up itself — the rewrite only feeds the embedder.
> - **The answer streams token-by-token**: Sonnet emits prose with inline `[title](url)`
>   citations via the async Anthropic stream API. First token ≈ 1s.
> - **The frontend opens tiles** by parsing the streamed markdown links (no backend
>   `open_tiles`, no allowlist).
> - **Highlighting is a non-blocking post-answer enhancement (on by default,
>   `HIGHLIGHT_ENABLED`):** after `answer_done`, fetch the cited pages (allowed-host ∩
>   retrieved sources — SSRF + relevance), one batched Haiku call per page, snap, and emit
>   `highlight {url, quote}` events.
> - **SSRF guard:** the backend only fetches model-cited URLs whose host is in
>   `ALLOWED_FETCH_HOSTS` (default `ggcity.org`).
>
> Module deltas vs the sections below: `backend/draft.py`, `backend/prompts/draft.py`,
> `backend/prompts/verify.py` are **deleted**; `backend/verify.py` → `backend/highlight.py`
> (keeps `snap` + `highlight_claims`); new `backend/prompts/answer.py` (prose prompt) and
> `backend/answer.py` (`stream_answer` + `parse_citations`); new `backend/rewrite.py`
> (`rewrite_for_retrieval`, async, reusing the shared rewrite prompt); `app.py` uses
> `AsyncAnthropic`. The sections below are the original gated plan, kept for context.

Phase 0 (infra: proxy routing, origin decision, CSP, Drupal injection) is assumed passed.
Phase 1 builds the **backend orchestration core**, testable with no frontend — exercised
over a CLI / scripted WebSocket client. The chat module (Phase 2), shell (Phase 3), and
companion (Phase 4) come later.

Three scope decisions:
1. **Include the shared-library refactor** as Phase 1's first step (the `shared/` modules
   don't exist yet).
2. **SQLite via sync `sqlite3` + `asyncio.to_thread`** — consistent with how the embedder
   and Chroma are already called off-thread; no async DB dependency.
3. **pytest + pytest-asyncio** for the new backend tests; v2's plain `check()` scripts stay.

---

## Target repository layout (after Phase 1)

```
shared/
  __init__.py
  rag_embeddings.py   # MOVED from repo root, unchanged
  extraction.py       # NEW: html/pdf/docx text + chunk_text (from crawler)
  rag_core.py         # NEW: rewrite, retrieval, context formatting (from chatbot)
backend/
  __init__.py
  config.py           # env/config dataclass (mirrors app.py env knobs)
  app.py              # FastAPI: WebSocket endpoint, event protocol, rate limiting
  orchestrator.py     # retrieve -> draft -> fetch -> verify -> branch (the loop)
  draft.py            # Sonnet structured claim-tagged draft + regen
  fetch.py            # live page fetch (httpx) using shared/extraction + page cache
  verify.py           # Haiku per-claim verify + verbatim span + snap-to-text
  store.py            # SQLite: schema, WAL, sessions, cache, limits, log writers
  prompts/
    __init__.py
    draft.py          # structured draft system prompt (+ regen variant)
    rewrite.py        # rewrite prompt (lifted from rag_core, reused)
    verify.py         # per-claim verify prompt
  cli.py              # scripted driver: run a query end-to-end, print events
crawler/
  website_crawler.py  # imports shared/extraction + shared/rag_embeddings
  classify.py         # unchanged (moved for tidiness, optional)
gradio_app.py         # thin Gradio UI over shared/rag_core (keeps v2 working)
tests/
  conftest.py         # fixtures: temp Chroma, fake Anthropic, temp SQLite
  test_store.py
  test_extraction_parity.py
  test_verify_snap.py
  test_orchestrator.py
  test_ws_protocol.py
backend_requirements.txt
```

`shared/` becomes a real package (`__init__.py`). All consumers import
`from shared.rag_embeddings import Embedder`, etc. Tests add the repo root to
`sys.path` (existing pattern) or rely on pytest rootdir.

---

## Part A — Shared library extraction (do first; everything else imports it)

### A1. Move `rag_embeddings.py` → `shared/rag_embeddings.py`
No code change. `Embedder` (`embed_documents`, `embed_query` with BGE query-instruction
prefix), `sanitize_metadata`, `fetch_all` reused as-is. Update imports in the crawler,
`city_chatbot.py`/gradio wrapper, `add_resource.py`, `classify.py`, `query_test.py`,
`app.py`, and the v2 tests.

### A2. Create `shared/extraction.py` (from `website_crawler.py`)
Lift these as **stateless module-level functions** (currently methods on the crawler /
duplicated in `add_resource.py`). Normalization must be byte-identical to index time —
this is the load-bearing reason for sharing (V3.md §2.5, §9):

- `extract_text_from_html(content: str, url: str="") -> tuple[str, str, list[str], dict]`
  - BeautifulSoup; `soup(["script","style","nav","footer","header"])` → `.decompose()`
  - content root: `soup.find("main") or soup.find("article") or soup.find("div", class_="content") or soup.body or soup`
  - `main_content.get_text(separator=" ", strip=True)` then `re.sub(r"\s+", " ", text).strip()`
- `extract_text_from_pdf(content: bytes) -> tuple[str, str, dict]` — PyPDF2, pages joined `"\n"`, `page_count` in metadata
- `extract_text_from_docx(content: bytes) -> tuple[str, str, dict]` — python-docx, paragraphs joined `"\n"`
- `chunk_text(text, title="", chunk_size=1000, chunk_overlap=200) -> list[str]`
  - sentence-aware boundary (`.`/`?`/`!` past `start + chunk_size//2`, else last space),
    overlap step `end - chunk_overlap`
  - **`Title:` prefix** injection (`f"Title: {title}\n\n{chunk}"`) preserved — but flagged
    loudly: that prefix is **not on the live page and must never be a highlight quote**
    (relevant to verify/snap in Part B and the companion in Phase 4).

The crawler (`crawler/website_crawler.py`) keeps its async wrappers but delegates the body
to these functions (or calls them directly via `asyncio.to_thread`). `add_resource.py`'s
duplicate copies are deleted in favor of the shared functions. **Acceptance:** crawler tests
(`test_local.py`, `test_add_resource.py`) still pass after rewiring.

### A3. Create `shared/rag_core.py` (from `city_chatbot.py`)
Move the UI-free query logic, behavior preserved (V3.md §8). These become free functions or
a small `RagCore` helper holding `client`, `embedder`, `collection`, config:

- `rewrite_query(client, model, message, history) -> str` — Haiku, `max_tokens=80`,
  `temperature=0`, graceful fallback to raw message.
- `search_knowledge_base(embedder, collection, query, top_k, min_score) -> list[dict]`
  - **One-line change required by V3.md §8 / Phase 1**: capture Chroma ids. Add
    `"ids"` to `include=[...]` and carry `response["ids"][0]` onto each result dict
    (`item["chunk_id"] = id`) for the **retrieval log**. v2 silently discards them.
  - keeps `similarity = 1.0 - distance`, `min_score` filter.
- `format_context_and_sources(results) -> tuple[str, list[dict]]` — dedup by `urldefrag(url)`,
  stable `S0/S1...` ids, `[S{i}] Title:.. URL:.. Content:..` blocks. Sources carry
  `source_id, title, url, file_type, score`.
- `normalize_history(history, cap) -> list[dict]` — lifted from `_normalize_history`.
- **Dynamic date**: replace any hard-coded date with `datetime.date.today()`
  (`%B %-d, %Y`) — V3.md §8 minor fix.

The existing **prose** `SYSTEM_TEMPLATE` and streaming `generate_response` stay reachable by
the Gradio wrapper. The **structured draft prompt** is *new* and lives in `backend/prompts/`
(Part B), not here.

### A4. `gradio_app.py` (thin wrapper)
Keep `create_gradio_interface`, `chat_with_rag`, history glue in a thin module that imports
`shared/rag_core` + the v2 prose prompt, so the Gradio app keeps working for backend testing
(V3.md §1, §8). `app.py` (HF Spaces entry) re-points to it. Env-var reading
(`ANTHROPIC_MODEL`, `REWRITE_MODEL`, `TOP_K`, `MIN_SCORE`, `CHROMA_PATH`, etc.) and the HF
`ensure_chroma` snapshot download are preserved.

---

## Part B — Backend package

### B1. `backend/config.py`
A frozen dataclass `Settings` populated from env (same knobs as `app.py`) plus new ones:
`PAGE_CACHE_TTL_SECONDS` (default 86400), `FETCH_TIMEOUT_SECONDS` (30, matches crawler),
`MAX_TILES`/`MAX_CITED_URLS` (cap, e.g. 4), `RATE_LIMIT_PER_IP`, `RATE_LIMIT_PER_SESSION`,
`RATE_WINDOW_SECONDS`, `MAX_QUERY_CHARS`, `REGEN_CAP` (=1), `SQLITE_PATH`, `USER_AGENT`
(reuse the crawler's `"CityWebsiteCrawler/1.0 ..."` or a Gigi-specific one).
*Delta:* also `HIGHLIGHT_ENABLED` and `VERIFY_ENABLED` (bools, **both default false** —
plain mode is the default; highlight and verify are opt-in), `MAX_CLAIMS` (=25,
pathological-draft guardrail; replaces the originally-named `MAX_VERIFY_CLAIMS` since it now
bounds the highlight pass too), and `STREAM_TOKEN_DELAY_MS` (=0, ms between simulated answer
tokens).

### B2. `backend/store.py` — SQLite (sync, WAL, called via `asyncio.to_thread`)
Connection opened with `check_same_thread=False`, `PRAGMA journal_mode=WAL`,
`PRAGMA busy_timeout=5000`, `PRAGMA foreign_keys=ON`. Schema created on startup
(idempotent `CREATE TABLE IF NOT EXISTS`); a tiny `schema_version` row enables future
migrations. Tables exactly per V3.md §2.7:

```sql
sessions(session_id TEXT PRIMARY KEY, created_at, last_seen_at)
interactions(interaction_id TEXT PRIMARY KEY /*uuid4*/, session_id, created_at,
  user_query, rewritten_query, outcome /*answered|regenerated|not_found*/,
  final_answer, citations JSON, regen_count INT, tokens_in INT, tokens_out INT,
  latency_ms INT)
model_calls(id INTEGER PRIMARY KEY, interaction_id, seq INT,
  call_type /*rewrite|draft|verify|regen*/, model, tokens_in, tokens_out,
  latency_ms, prompt JSON, response JSON, created_at)
verifications(id INTEGER PRIMARY KEY, interaction_id, source_url, claim, verified INT,
  quote, page_cache_hit INT, fetch_latency_ms, created_at)
retrievals(id INTEGER PRIMARY KEY, interaction_id, rank INT, chunk_id, url, score REAL)
page_cache(url TEXT PRIMARY KEY, text, fetched_at, ttl_seconds)
rate_limits(key TEXT PRIMARY KEY, window_start, count)
```
Indexes: `interactions(session_id, created_at)`, `model_calls(interaction_id)`,
`verifications(interaction_id)`, `retrievals(interaction_id)`.

Writer functions (each wrapped in `to_thread` at call sites):
`create_session`, `touch_session`, `recent_interactions(session_id, n)` (→ history for
rewrite, *derived* not duplicated), `start_interaction`, `finish_interaction`,
`log_model_call`, `log_verification`, `log_retrieval`, `cache_get(url)`/`cache_put`,
`rate_check_and_incr(key, window, limit) -> bool`.

> **PII note (AR 2.16):** `interactions.user_query` is a PII store because residents
> volunteer PII in free text. Phase 1 logs it as specified; retention/redaction policy is
> Phase 6 (V3.md §11). Flag this in the file header comment and link
> https://internal.ggcity.org/policies.

### B3. `backend/prompts/`
- `draft.py` — **new structured draft system prompt**. Sonnet emits the JSON of V3.md §4:
  `{segments:[{id,text,source_ids[]}], sources:[{id,url,label}], abstain:bool}`. Rules
  carried from v2 `SYSTEM_TEMPLATE`: ggcity.org-only, use ONLY retrieved context, dynamic
  `today`, abstain when context supports nothing, concise, no follow-up questions. **New:**
  Sonnet *paraphrases, never quotes* (verbatim spans come from verify); every factual
  segment carries ≥1 source id; empty `source_ids` on a factual segment = failure;
  `abstain:true` short-circuits to not-found. Context blocks tagged `[S0]…` as today.
  Enforce JSON via the structured-output / tool-use pattern (a single tool the model must
  call), so parsing is validated not regex-scraped.
- `draft.py` also exports the **regen** variant: same prompt + an appended block stating
  *which claim failed and what the live page actually says* (V3.md §2.4).
- `rewrite.py` / `verify.py` — rewrite reuses `shared/rag_core.rewrite_query`; verify prompt
  asks Haiku for a **batch** `{results:[{claim_id, verified, quote}]}` over all claims that
  cite one page (page text sent once), returning the **verbatim supporting span** per claim
  (V3.md §2.5).
- *Delta:* `highlight.py` — **new** default-mode prompt. Same batched shape but
  `{results:[{claim_id, quote}]}` (no pass/fail): for each claim, the single contiguous
  span to highlight, empty if none. Used when the verify gate is off.

### B4. `backend/draft.py`
- `draft(client, model, query, context, sources, history, today) -> DraftResult` — calls
  Sonnet with the structured prompt, returns parsed `segments/sources/abstain`. Logs a
  `model_calls` row (`call_type="draft"`, prompt/response JSON, tokens, latency).
- `regen(client, model, ..., failed_claim, page_says) -> DraftResult` — one capped regen,
  logged as `call_type="regen"`.
- Validation: reject a factual segment with empty `source_ids` (treat as abstain/failure).

### B5. `backend/fetch.py`
- `async fetch_page(url, store, settings) -> str` — cache lookup first
  (`page_cache`, TTL fresh → return, log `page_cache_hit=1`). On miss: `httpx.AsyncClient`
  GET (timeout from settings, the project User-Agent), dispatch by content-type to
  `shared/extraction` (`extract_text_from_html/pdf/docx`), **apply the same whitespace
  collapse** the crawler uses, write to `page_cache`, return text. `httpx` chosen (async,
  fits FastAPI) over the crawler's aiohttp / add_resource's requests.
- `fetch_cited(draft_sources, ...)` — fetch **only the cited URLs** (V3.md §2.3 step 5),
  capped at `MAX_CITED_URLS`, concurrently (`asyncio.gather`).
- Defang the `Title:` prefix concern: extraction output here is page text only (no chunk
  title injection), so fetched text matches the live DOM.

### B6. `backend/verify.py`
- `async verify_claims(client, model, claims, page_text) -> BatchVerifyResult` — Haiku, one
  call per page over **all** claims citing it (page text sent once), against the **freshly
  fetched full page** (more independent than re-reading the drafting chunk, V3.md §2.5).
  Fail-closed on any omitted claim id. *(Originally a per-claim `verify_claim`; batched to
  cut duplicate page tokens.)* The orchestrator logs one `verifications` row per claim.
- *Delta:* `async highlight_claims(...)` — default-mode sibling, same batched shape, returns
  only the best contiguous span per claim (no pass/fail).
- `snap(quote, page_text) -> str | None` — **fuzzy align** the model's returned span to the
  actual fetched text so the shipped quote is a guaranteed true substring (models copy
  imperfectly). Implementation: normalize whitespace on both, exact-substring fast path,
  else a sliding best-match (difflib `SequenceMatcher.find_longest_match` / ratio threshold)
  to recover the real substring; return `None` if it can't be snapped (treat as verify fail
  for that claim). This is one of the few **pure functions worth unit-testing** (V3.md §7).
- Guard: reject any snapped quote that begins with/contains the `Title:` prefix artifact.

### B7. `backend/orchestrator.py` — the loop (V3.md §2.3, §2.4)
`async def handle_turn(query, session_id, emit) -> None` where `emit(event)` pushes a
protocol event (so it is transport-agnostic and CLI-testable). Steps:

1. `start_interaction` (uuid4); `emit(narration "Looking this up…")`. No model call.
2. History = `recent_interactions(session_id, n)`. If follow-up, `rewrite_query`
   (logged `rewrite`).
3. `search_knowledge_base` → `log_retrieval` rows (rank, **chunk_id**, url, score).
   No results → not-found branch.
4. `format_context_and_sources` → `draft(...)`. `abstain` → not-found branch.
5. **Mode split** *(revised)*:
   - **plain (default):** no fetch, no Haiku. Build tiles directly from the draft's cited
     URLs (`_plain_verdicts`), finalize `answered`. Fastest path.
   - **highlight / verify:** `fetch_cited(draft.sources)` → page cache, then a batched Haiku
     pass per page via `_run_claim_pass(mode)` + `snap` each span. `highlight` returns spans
     only; `verify` also gates pass/fail.
6. Collect per-claim passed + (snapped) quote. A passed claim is tiled by its cited URL even
   without a snapped quote (the tile opens the page; the quote drives the highlight).
7. **Branch**:
   - **plain / highlight:** always finalize `answered` — stream the draft segments,
     `emit(open_tiles, …)` for the cited pages (with quotes in highlight, without in plain),
     capped. No regen, no not-found from this step.
   - **verify, all pass:** finalize `answered` (tiles from the passed claims).
   - **verify, too many fail (majority) or `REGEN_CAP<1`:** not-found + redirect (no regen;
     never serve partial). *(The earlier "primary claim" abandon trigger was dropped — the
     format has no primacy marker.)*
   - **verify, minority fail:** **one** informed `regen` (cap=1). If it abstains → not-found.
     Else finalize `regenerated` — **shipped untested (no re-verify)**: stream the regen's
     segments and **reuse the tiles from the initial verify pass**. No second Haiku call, no
     refetch.
8. Not-found branch → `emit(not_found, {text, redirect_to_human})`,
   `finish_interaction(outcome="not_found")`. Message scoped to *"I could not find this on
   the city site"* (never "this doesn't exist") and routes to a real human contact.

*Streaming/tiles deltas:* the answer is streamed as **simulated word-level** `answer_token`
events (`_stream_text`, paced by `STREAM_TOKEN_DELAY_MS`); `open_tiles` is emitted **only when
the turn has tiles** (carries the complete new set — the shell replaces; absence leaves the
prior turn's tiles up).

Because nothing ships until the pass completes, the regen is invisible (no jarring on-screen
replacement) — which is why a full regen is acceptable over a surgical patch.

### B8. `backend/app.py` — FastAPI + WebSocket + event protocol
- Lifespan: open SQLite (WAL/pragmas), construct `Embedder` (cpu), open Chroma collection,
  construct `Anthropic()` (key from env, never leaves server), create schema.
- `GET /healthz`.
- `WS /ws` — accepts `{type:"query", session_id?, text}`; creates session if absent
  (surfaces the **interaction uuid** to the client for support reference). Calls
  `handle_turn` with an `emit` that `await ws.send_json(event)`.
- **Event types** (V3.md §2.6): `narration`, `answer_token`, `answer_done`, `open_tiles`,
  `tile_result`, `not_found`. Inbound client events: `query`, and the companion-miss report
  (`tile_result`) the shell will send later (accepted/logged now, acted on in Phase 3/4).
- **Rate limiting**: per-IP and per-session via `rate_limits` table + `rate_check_and_incr`
  (fixed window). Over limit → a `not_found`-style throttle event, no model calls.
- **Request caps**: reject queries over `MAX_QUERY_CHARS` before any model call.
- No static-bundle serving in Phase 1 (that's the integration phase; §10 prerequisite).

### B9. `backend/cli.py` — scripted driver (the Phase 1 acceptance harness)
A `python -m backend.cli --query "how do I pay my water bill" [--session S]` that connects
to the WS (or calls `handle_turn` in-process with a printing `emit`) and prints the ordered
event stream. Lets the whole loop be exercised before any frontend exists (V3.md §6 Phase 1).

---

## Dependencies (`backend_requirements.txt`)

`fastapi`, `uvicorn[standard]`, `httpx` (async live fetch), `anthropic>=0.39` (already used),
plus the existing `chromadb>=0.5`, `sentence-transformers`, `beautifulsoup4`, `lxml`,
`PyPDF2`, `python-docx` (shared/extraction). Test extras: `pytest`, `pytest-asyncio`. SQLite
is stdlib (no `aiosqlite`). `websockets` comes via `uvicorn[standard]`. Lock into a freeze
file once they install cleanly (per CLAUDE.md).

---

## Testing (pytest + pytest-asyncio; mock Anthropic at the SDK boundary)

`tests/conftest.py` fixtures (reuse v2 patterns — `FakeEmbedder` deterministic hash vectors,
`FakeClient`/`_Messages`/`_Stream`, temp Chroma collection with a few labeled docs, temp
SQLite path):

- `test_store.py` — schema creates; WAL on; writers round-trip; `recent_interactions` order;
  `rate_check_and_incr` flips at the limit; `cache_get` honors TTL expiry.
- `test_extraction_parity.py` — **unit, load-bearing**: a fixed HTML string chunked at index
  time and re-extracted at fetch time produce the same normalized text; the `Title:` prefix
  appears in chunks but never in fetched page text.
- `test_verify_snap.py` — **unit, load-bearing**: `snap` recovers a true substring from a
  lightly-corrupted model span; returns `None` when unrecoverable; rejects `Title:` artifact;
  claim→source map selects the right failed segment(s).
- `test_orchestrator.py` — **integration, the core**: drive each branch deterministically
  with the fake client + fixture Chroma + a fake fetcher returning canned page text:
  pass; verify-fail→regen→pass; regen-fail→not-found; abstain→not-found; primary-claim-fail
  abandon→not-found. Assert outcomes **and** the `model_calls`/`verifications`/`retrievals`
  log writes. *(Streaming revision: the live branches are stream-answer→highlight,
  no-results→not-found, and the follow-up case — history present fires a `rewrite`
  `model_calls` row + populates `interactions.rewritten_query` for retrieval, while the
  streamed answer still receives the original message + history.)*
- `test_ws_protocol.py` — FastAPI `TestClient`/ASGI WebSocket: a query yields the expected
  ordered event sequence; oversized query and over-limit rate produce the throttle/reject
  path with no model calls.

v2's plain `test_*.py` scripts remain runnable as-is after the import rewrite.

---

## Verification / acceptance (end-to-end, no frontend)

1. `pip install -r backend_requirements.txt` (after torch per CLAUDE.md); `pytest tests/`
   green.
2. v2 still works: `python test_chatbot.py && python test_local.py && python
   test_add_resource.py` pass after the shared-library rewire; `python gradio_app.py` boots.
3. Live loop against a **real** ggcity.org query (key + crawled `chroma_db` present):
   `python -m backend.cli --query "how do I pay my water bill"` prints
   narration → answer tokens → open_tiles with a snapped verbatim quote that is a true
   substring of the live page; and a deliberately unanswerable query prints `not_found` with
   a human redirect.
4. Inspect SQLite: `interactions`, `model_calls` (rewrite/draft/verify[/regen]),
   `verifications`, `retrievals` all populated and tied to one `interaction_id`;
   `page_cache` hit on a repeat query.

---

## Risks / call-outs

- **Extraction drift** is the silent killer — parity test (`test_extraction_parity.py`) is
  the guard; both crawler and backend must call the *same* `shared/extraction` functions.
- **`Title:` prefix** must never become a highlight quote — guarded in `snap` and flagged in
  extraction.
- **AR 2.16 / PII**: `interactions.user_query` is a PII store; Phase 1 logs as specified,
  redaction/retention deferred to Phase 6. Header comment + policy link required.
- **Structured-output reliability**: enforce the draft JSON via tool-use, not regex; an
  invalid/empty-source draft is treated as abstain rather than crashing the turn.
- **Single-machine SQLite** boundary is fine at pilot scale (V3.md §11); high-load deferred.
- The retained Gradio prose prompt and the new structured draft prompt **diverge on
  purpose** — keep both; don't unify.
