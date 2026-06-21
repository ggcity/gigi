# Phase 1 — Acceptance Testing Guide

Phase 1 builds the backend orchestration core (retrieve → **stream** a prose
answer with inline `[title](url)` citations → async **highlight** pass that fetches
the cited pages and emits `highlight {url, quote}` events). The automated suite
(`pytest tests/`) mocks Anthropic at the SDK boundary and stubs the live fetch,
so it proves the **flow and the log writes** but *cannot* prove that the real
models stream good citations or that highlight quotes line up with live pages.

This guide is the manual/live acceptance matrix that fills that gap. Run it
against a real crawled `chroma_db` with `ANTHROPIC_API_KEY` set.

> ⚠️ **AR 2.16 / PII.** Every live run below sends retrieved + live-fetched page
> text (and the raw user query) to the Anthropic API, and writes the query into
> `interactions.user_query`, which is a PII store. This falls under City
> Administrative Regulation 2.16 (Cloud Computing Services Policy):
> https://internal.ggcity.org/policies. Use non-PII test queries.

The CLI is the harness. It prints the user-facing event stream to **stdout** and
verbose diagnostics (fetched link, truncated page preview, per-claim verify
result, decision branch, and a `[db]` summary) to **stderr**. Silence diagnostics
with `--quiet` or `2>/dev/null`. Tune retrieval inline with `--top-k` /
`--min-score`.

> **Single streaming flow** (verify mode removed; the Haiku rewrite is kept for
> retrieval only): on a follow-up turn (history present) a small Haiku call rewrites
> the message into a standalone **retrieval** query (the first turn uses the raw
> message); retrieve → Sonnet **streams** a prose answer with inline `[title](url)`
> citations token-by-token, given the **original** message + history (so the rewrite
> only feeds the embedder) → after it finishes, an async **highlight** pass (on by
> default; `--no-highlight` to skip) fetches the cited pages, Haiku finds the span,
> it's snapped, and a `highlight {url, quote}` event is emitted per page.
> The frontend opens tiles by parsing the links; there is no `open_tiles` event.
> The backend only fetches URLs on an allowed host (`ALLOWED_FETCH_HOSTS`, default
> `ggcity.org`) that are also in the retrieved set (SSRF + relevance guard).

---

## 0. Baseline gate (from PHASE1.md)

1. `pip install -r backend_requirements.txt` (after torch per CLAUDE.md), then
   `pytest tests/` is green (28 tests).
2. v2 still works after the shared-library rewire:
   `python test_chatbot.py && python test_local.py && python test_add_resource.py`
   all pass; `python gradio_app.py` boots.
3. One answerable + one unanswerable live CLI query behave (see B and C below).
4. SQLite tables populated and tied to one `interaction_id`; `page_cache` hits on
   a repeat query (see D and I below).

---

## A. Streaming + citation reliability (mock can't validate)

The fake client streams a canned answer. Confirm **real Sonnet** streams promptly
and cites with inline `[title](url)` links on the city's domain across queries:

```bash
python -m backend.cli --query "how do I pay my water bill"
python -m backend.cli --query "what do I need for a building permit"
python -m backend.cli --query "how do I schedule a bulk trash pickup"
```

Watch that tokens start printing within ~1-2s (not ~12s), that the answer carries
`[title](https://www.ggcity.org/...)` links, and that an off-domain question
("what's the capital of France") is declined in prose. The `[db]` summary should
show one `answer` call (+ `highlight` calls; + a `rewrite` call only on a
follow-up turn), never a `draft`/`verify`/`regen`.

## B. The load-bearing guarantee: highlight quote is a true substring of the live page

Highlighting is on by default. For an answered query, confirm a quote from a
`[highlight]` event literally exists on the cited page:

```bash
python -m backend.cli --query "how do I pay my water bill" 2>dbg.txt
# copy a [highlight] url + quote from stdout, then:
curl -s <HIGHLIGHT_URL> | python -c "import sys,re; from shared.extraction import extract_text_from_html as e; t=re.sub(r'\s+',' ',e(sys.stdin.read())[0]); print('<PASTE QUOTE>' in t)"
# expect: True
```

Also eyeball `dbg.txt`: every `highlight … snap=ok` quote should be present in the
fetched page, and no quote may begin with `Title:`. `--no-highlight` streams the
answer with no highlight pass (no fetch, no `highlight` events).

## C. Off-domain / unanswerable → declined or honest not-found

```bash
python -m backend.cli --query "what is the capital of France"   # declined in prose
python -m backend.cli --query "asdfqwer zzzz nonsense"          # likely no results -> not_found
```

Expect either a polite prose decline (off-domain) or `BRANCH: not_found` (no
retrieval results) with a redirect to a real phone number — **never** a confident
city answer.

## D. Page cache (TTL) actually hits on repeat

Run the *same* query twice (highlight on). The second run's diagnostics show
`fetched [cache] …` instead of `[NNms]`, and in SQLite `page_cache_hit=1`:

```bash
sqlite3 gigi.db "SELECT source_url,page_cache_hit,fetch_latency_ms FROM verifications ORDER BY id DESC LIMIT 5;"
```

## E. Multi-turn follow-up (rewrite for retrieval, answer from original + history)

```bash
python -m backend.cli --session s9 --query "what do I need for a building permit"
python -m backend.cli --session s9 --query "what about for a business one"
```

On the second turn the diagnostics show `rewrite: 'what about for a business one'
→ '<standalone query>'` (resolving "one") used for **retrieval only**, a `rewrite`
`model_calls` row, and `interactions.rewritten_query` populated. The streamed
answer still receives the **original** message + history, so it resolves "one"
in prose too. The first turn fires no rewrite (no history).

## F. Failure injection — a cited page that 404s / times out must not crash

An unreachable cited page is non-fatal: highlighting just skips it. Force it
(e.g. `FETCH_TIMEOUT_SECONDS=1 python -m backend.cli …`) and confirm the answer
still streamed and completed, with no `highlight` event for that page and no
traceback.

## SSRF guard
Confirm the backend never fetches an off-`ALLOWED_FETCH_HOSTS` URL even if the
model emits one: `fetch.host_allowed` rejects non-`ggcity.org` hosts, and the
highlight filter only fetches cited URLs already in the retrieved source set.

## G. Real WebSocket protocol (not just the in-process CLI)

The CLI calls `handle_turn` directly; also exercise the real ASGI WebSocket path
and event ordering:

```bash
uvicorn backend.app:app --port 8000 &
curl -s localhost:8000/healthz          # {"status":"ok"}
# with websocat / a small python websockets client, send:
#   {"type":"query","text":"how do I pay my water bill","session_id":"w1"}
# expect ordered events:
#   session → narration → answer_token… → answer_done → highlight*
```

- Oversized: send `{"type":"query","text":"<2001 chars>"}` → `not_found` reject,
  no `model_calls` row written.
- Rate limit: send 31+ queries fast on one session (default
  `RATE_LIMIT_PER_SESSION=30`) → throttle `not_found`, no new `model_calls`.
- There is **no** `open_tiles` event — the frontend parses the streamed links.

## H. Highlight cap, batching & concurrency

Ask something broad enough that the answer cites more than `MAX_CITED_URLS` (4)
pages. Confirm the `fetching N cited URL(s) (cap 4)` line only fetches the cap,
and the fetches overlap in time (concurrent, not summed latency).

Highlighting is **batched per page**: all claims citing the same URL go to Haiku
in one call (page text sent once), and the per-page batches run concurrently.
Confirm the `highlight: N claim(s) across M page(s)` line shows `M` = number of
cited pages, that `model_calls` has one `highlight` row per page, and that a span
that won't snap simply yields no `highlight` event for that page (the answer and
tiles already shipped).

## I. Logging integrity (every generation tied to one interaction)

```bash
sqlite3 gigi.db "SELECT seq,call_type,model,tokens_in,tokens_out FROM model_calls WHERE interaction_id='<ID>' ORDER BY seq;"
sqlite3 gigi.db "PRAGMA foreign_key_check; PRAGMA integrity_check;"
```

Confirm `interactions.tokens_in/out` equals the sum across its `model_calls`, and
the calls all share one `interaction_id`. Expect `call_type` to be `answer`
(+ `highlight` per cited page; + a `rewrite` on follow-up turns). There is no
`draft`/`verify`/`regen`.
The `[db]` summary the CLI prints at the end of each run gives this at a glance.

## J. Session isolation

Two different `--session` ids must not bleed history into each other. Run an A/B
follow-up across two sessions and confirm Sonnet resolves each one's "it/that"
against the right session only.

---

## Tuning aid

Use `query_test.py` (v2) and the CLI's `--top-k` / `--min-score` together to set a
sane `MIN_SCORE`: inspect similarity scores, then confirm the chosen threshold
still answers the good queries and abstains on the bad ones.

```bash
python query_test.py --query "how do I pay my water bill"
python -m backend.cli --query "how do I pay my water bill" --top-k 8 --min-score 0.25
```
