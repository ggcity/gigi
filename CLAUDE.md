# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Gigi is a RAG chatbot for the City of Garden Grove that helps residents navigate city services. It crawls the city website, embeds the content into ChromaDB, and answers questions via Claude.

**Active codebase: V3** — a FastAPI + Lit web component stack with real-time streaming, tiled city-page previews, and in-page quote highlighting. The architecture spec lives in `V3.md`. V2 (Gradio, deployed to Hugging Face Spaces) lives on the `main` branch and is kept for reference.

## Repository layout

```
shared/               # shared Python library (crawler + backend)
  rag_embeddings.py   # Embedder, sanitize_metadata, fetch_all
  extraction.py       # HTML/PDF/DOCX text extraction + chunk_text
  rag_core.py         # rewrite, retrieval, formatting, generation

backend/              # FastAPI backend (V3)
  app.py              # WebSocket endpoint, static serving, lifespan
  orchestrator.py     # retrieve → stream → async highlight
  answer.py           # Sonnet streaming + citation parsing
  rewrite.py          # Haiku follow-up query rewrite
  fetch.py            # live page fetch, SSRF guard, page cache
  highlight.py        # Haiku span extraction + fuzzy snap
  store.py            # SQLite schema, logging, sessions, cache, rate limits
  config.py           # Settings dataclass (env vars / .env file)
  cli.py              # CLI driver for backend testing
  prompts/            # answer and highlight prompts

chat-module/          # standalone WCAG 2.1 AA Lit chat component (@ggcity/gigi-chat)
frontend-gigi/        # Lit app shell (@ggcity/gigi-shell): WebSocket, tiles, morph
  src/companion/      # vanilla companion script injected into Drupal pages

crawler/              # (root level) website_crawler.py, classify.py, add_resource.py
gradio_app.py         # thin V2 UI kept for backend testing
tests/                # pytest suite
```

## Environment setup

### Python (backend + crawler)

Install torch first, matched to hardware:

```bash
# CPU-only:
pip install torch --index-url https://download.pytorch.org/whl/cpu
# GPU (CUDA 12.4):
pip install torch --index-url https://download.pytorch.org/whl/cu124
```

Then install per-component requirements:

```bash
pip install -r crawler_requirements.txt      # crawl + classify
pip install -r backend_requirements.txt      # V3 backend (fastapi, uvicorn, httpx, anthropic, chromadb, …)
```

Copy `.env.example` to `.env` and set at minimum:

```
ANTHROPIC_API_KEY=sk-ant-...
CHROMA_PATH=./chroma_db
CHROMA_COLLECTION=city_website_content
```

### JavaScript (frontend)

Both packages use Vite. Install from each directory:

```bash
cd chat-module && npm install
cd ../frontend-gigi && npm install
```

`@ggcity/gigi-chat` is resolved from source by the shell's Vite alias — no separate build step needed in dev.

## Commands

### Crawl the city website

```bash
python website_crawler.py \
  --base-url https://www.ggcity.org \
  --db-path ./chroma_db \
  --collection-name city_website_content \
  [--sitemap URL] [--max-depth N] [--max-pages N] \
  [--skip-pdf] [--exclude-pattern REGEX] [--device cuda]
```

Re-running upserts by URL. Pass `--recreate` to rebuild from scratch.

### Classify pages (optional)

```bash
python classify.py \
  --db-path ./chroma_db \
  --collection-name city_website_content \
  --model claude-haiku-4-5-20251001
```

### Inspect retrieval quality

```bash
python query_test.py --query "how do I pay my water bill"
python query_test.py --list        # all crawled pages, no model call
python classify.py --summary-only  # label counts, no model call
```

### Run the V3 backend

```bash
# Dev (auto-reload):
uvicorn backend.app:create_app --factory --reload --port 8000

# Or with a custom .env file:
GIGI_ENV_FILE=.env.local uvicorn backend.app:create_app --factory --reload
```

### Run the V3 frontend (dev)

```bash
# Terminal 1 — backend (must be running first):
uvicorn backend.app:create_app --factory --reload --port 8000

# Terminal 2 — shell dev server (proxies /ws to :8000):
cd frontend-gigi && npm run dev
```

Opens at http://localhost:5173. Hot module replacement is active.

### CLI backend test (no browser)

```bash
python -m backend.cli --query "how do I pay my water bill"
python -m backend.cli              # interactive REPL
python -m backend.cli --no-highlight  # skip the async highlight pass
```

Prints streamed answer to stdout, diagnostics (retrieval, model calls, latency) to stderr.

### Build for production

```bash
# Build frontend (shell + companion):
cd frontend-gigi && npm run build
# Outputs: dist/index.html, dist/assets/*, dist/companion.js

# The FastAPI backend serves dist/ at "/" automatically.
# Start the production server:
uvicorn backend.app:create_app --factory --host 0.0.0.0 --port 8000
```

### Run tests

```bash
# Python backend tests:
pytest tests/

# Frontend E2E + accessibility (Playwright):
cd frontend-gigi && npm test
cd chat-module && npm test

# Install browsers once:
cd frontend-gigi && npm run test:install
```

### Add a single resource

```bash
python add_resource.py --file ./fee_schedule_2026.pdf \
    --url https://www.ggcity.org/finance/fee-schedule-2026.pdf
python add_resource.py --url https://www.ggcity.org/trash/bulk-pickup
```

## Architecture

### V3 data flow

1. **Crawl** (`website_crawler.py`): breadth-first, extracts HTML/PDF/DOCX via `shared/extraction`, chunks, embeds with BGE-large, upserts to ChromaDB.
2. **Query** (backend WebSocket): on each turn —
   - If follow-up (history present): Haiku rewrites message into standalone retrieval query (`rewrite.py`)
   - ChromaDB cosine similarity search (`shared/rag_core`)
   - Sonnet streams prose answer with inline `[title](url)` citations (`answer.py`)
   - Frontend parses the streamed markdown links and opens city pages as tiled iframes
   - After answer completes: async highlight pass — fetches cited pages, Haiku finds exact span, snap to true substring, emits `highlight` events to companion (`highlight.py`, `fetch.py`)
3. **Companion** (`src/companion/companion.js`): injected into every city page, receives the verified quote via postMessage, reveals hidden Bootstrap tabs/collapsibles, highlights via CSS Custom Highlight API.

### Shared embedding contract (`shared/rag_embeddings.py`)

The crawler and backend both import `Embedder` from here. Model, dimension, normalization, and BGE query instruction prefix must match or retrieval silently fails. `fetch_all` pages through large Chroma collections to avoid SQLite limits.

### Shared extraction (`shared/extraction.py`)

Used at crawl time and at live-fetch time. **Must stay identical** — the highlight snap works only because the backend reads page text the same way the crawler built the chunks.

### Models used

- **Sonnet** (`claude-sonnet-4-6`): streaming answer generation
- **Haiku** (`claude-haiku-4-5-20251001`): query rewrite, highlight span extraction, classifier page labeling
- **BGE-large** (`BAAI/bge-large-en-v1.5`): embeddings (~1.3GB, downloaded on first run)

### WebSocket event protocol

Outbound (backend → client): `session`, `narration`, `answer_token`, `answer_done`, `highlight {url, quote}`, `not_found`, `error`

Inbound (client → backend): `query {text, session_id?}`, `tile_result` (companion miss report)

There is no `open_tiles` event — the frontend parses `[title](url)` links from the streamed answer text itself.

### SQLite (`store.py`, WAL mode)

Tables: `sessions`, `interactions`, `model_calls`, `verifications`, `retrievals`, `page_cache`, `rate_limits`. Every model call is logged with tokens and latency tied to an `interaction_id` (uuid surfaced to the client for support reference).

### Frontend packages

- **`@ggcity/gigi-chat`** (`chat-module/`): standalone Lit component. No transport, no tiles. Public API: `appendUserMessage`, `beginAssistantMessage`, `appendAssistantToken`, `endAssistantMessage`, `setNarration`, `renderCitations`, `showNotFound`, `showError`. Emits: `gigi-submit`, `gigi-citation-detected`, `gigi-answer-complete`, `gigi-citation-click`, `gigi-new-session`.
- **`@ggcity/gigi-shell`** (`frontend-gigi/`): owns the WebSocket (`ws-client.js`), centered→side morph (`morph.js`), tile grid of city-page iframes (`tiles.js`), and the `<gigi-app>` root element. Also builds the companion IIFE separately (`vite.companion.config.js`).

### Companion (`src/companion/companion.js`)

Self-contained IIFE injected by Drupal on every city page. Receives highlight quotes via origin-checked postMessage (desktop) or `#gigi=<quote>` URL fragment (mobile). Normalizes text identically to the crawler, fuzzy-matches, reveals Bootstrap tabs/collapsibles, highlights via CSS Highlight API (with `<mark>` fallback), and reports misses back.

## Key constraints

- **PII**: user queries are logged in SQLite (`interactions.user_query`). Falls under City AR 2.16. Retention policy and redaction are Phase 6 hardening tasks.
- **SSRF guard**: the backend only fetches URLs whose host is in `ALLOWED_FETCH_HOSTS` (default `ggcity.org`) AND which appear in the retrieved source set. Never fetch raw model-emitted URLs unguarded.
- **Domain restriction**: Gigi only answers about `ggcity.org`. The system prompt refuses off-domain questions.
- **`--db-path` and `--embedding-model` must match** between the crawler and backend runs. Mismatches cause silent retrieval failure.
- **`Title:` chunk prefix**: the crawler injects a `Title:` prefix into some chunks. That text is not on the live page and must never be returned as a highlight quote.
- **Normalization parity**: `shared/extraction.py` must stay byte-identical to the logic in `companion.js`'s `collapse()` / content-root extraction. Any divergence breaks the highlight snap.
- **WCAG 2.1 AA**: target compliance date April 26, 2027 (Garden Grove). The chat module was built to conformance. Full-system audit is Phase 6.
