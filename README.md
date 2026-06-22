# Gigi — City Assistant

Gigi is a RAG chatbot that helps Garden Grove residents navigate city services. Ask a question and Gigi streams an answer grounded in content from ggcity.org, opens cited pages as side-by-side previews, and highlights the exact supporting text on the page.

## Architecture

- **Crawler** (`website_crawler.py`): breadth-first crawl of the city website. Extracts HTML, PDF, and DOCX text, chunks it, embeds with BGE-large, and upserts to ChromaDB.
- **Backend** (`backend/`): FastAPI server. Each query retrieves from ChromaDB, streams a Sonnet answer with inline citations over WebSocket, then asynchronously fetches cited pages and asks Haiku to find the exact supporting span for in-page highlighting.
- **Chat UI** (`chat-module/`): standalone WCAG 2.1 AA Lit web component. Transport-agnostic — no WebSocket, no tiles.
- **App shell** (`frontend-gigi/`): Lit application that owns the WebSocket, opens cited city pages as tiled iframes, and drives the centered→side layout morph.
- **Companion** (`frontend-gigi/src/companion/companion.js`): vanilla script injected into every city page by Drupal. Receives highlight quotes via postMessage, reveals hidden Bootstrap tabs or collapsibles, and highlights the passage via the CSS Custom Highlight API.
- **Shared library** (`shared/`): embedding contract, text extraction, and RAG core reused by the crawler and backend.

## Prerequisites

- Python 3.9+
- Node.js 20+
- An Anthropic API key
- ~1.3 GB disk for BGE-large weights (downloaded on first run, cached by sentence-transformers)
- A populated ChromaDB vector store (see [Crawl the site](#1-crawl-the-site))

## Setup

### Python

Install PyTorch first, matched to your hardware:

```bash
# CPU-only:
pip install torch --index-url https://download.pytorch.org/whl/cpu

# GPU (CUDA 12.4 — check your driver with nvidia-smi and pick the closest):
pip install torch --index-url https://download.pytorch.org/whl/cu124
```

Then install backend and crawler dependencies:

```bash
pip install -r crawler_requirements.txt
pip install -r backend_requirements.txt
```

Copy the example env file and fill in the required values:

```bash
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY, CHROMA_PATH, CHROMA_COLLECTION
```

### JavaScript

```bash
cd chat-module && npm install
cd ../frontend-gigi && npm install
```

## 1. Crawl the site

```bash
python website_crawler.py \
  --base-url https://www.ggcity.org \
  --db-path ./chroma_db \
  --collection-name city_website_content
```

Re-running the crawler upserts by URL — it does not wipe the store. Pass `--recreate` to rebuild from scratch. On a GPU machine, add `--device cuda` for faster embedding.

**Useful options:**

| Flag | Description |
|---|---|
| `--sitemap URL` | Seed from the CMS sitemap instead of the start page |
| `--max-depth N` | Limit link depth from start page |
| `--max-pages N` | Hard cap on pages crawled |
| `--skip-pdf` | Skip PDF files (recommended if PDFs are slow or noisy) |
| `--skip-spreadsheets` | Skip XLS/XLSX/CSV files |
| `--exclude-pattern REGEX` | Skip URLs matching the regex (repeatable) |
| `--include-pattern REGEX` | Only crawl URLs matching at least one regex |
| `--allow-subdomains` | Also follow subdomains of the start domain |
| `--device cuda` | Run embedding on GPU |

Curation matters. Auto-generated list, search, and calendar pages share keywords with real content and crowd out relevant results — exclude them with `--exclude-pattern`.

## 2. Classify pages for retention (optional)

```bash
python classify.py \
  --db-path ./chroma_db \
  --collection-name city_website_content \
  --model claude-haiku-4-5-20251001
```

Labels each page with document type, department, and record status via Haiku and writes those labels back onto the chunks. Re-runnable; skips already-labeled pages unless you pass `--reclassify`. Use `--summary-only` to print current counts without calling the model.

These labels are automated suggestions for a records officer's review, not authoritative retention decisions.

## 3. Run in development

Start the backend and frontend in separate terminals:

```bash
# Terminal 1 — backend (auto-reload on code changes):
uvicorn backend.app:create_app --factory --reload --port 8000

# Terminal 2 — frontend dev server (proxies /ws to :8000):
cd frontend-gigi && npm run dev
```

Open http://localhost:5173. The Vite dev server proxies WebSocket connections to the backend, so both run on one origin with no CORS setup.

To test the backend without a browser:

```bash
python -m backend.cli --query "how do I pay my water bill"
python -m backend.cli              # interactive REPL
python -m backend.cli --no-highlight  # skip the async highlight pass
```

## 4. Build for production

```bash
cd frontend-gigi && npm run build
```

This produces `frontend-gigi/dist/`: the app bundle (`index.html` + assets) and the standalone companion script (`companion.js`). The FastAPI backend serves `dist/` at `/` automatically — no separate static host needed.

Start the production server:

```bash
uvicorn backend.app:create_app --factory --host 0.0.0.0 --port 8000
```

Sit this behind your existing reverse proxy. The proxy should:
- Route `/ws` as a WebSocket upgrade to the backend
- Route everything else to the backend as HTTP

For the companion and tiled iframes to work, city pages must allow the Gigi origin to frame them:

```
Content-Security-Policy: frame-ancestors 'self' https://gigi.ggcity.org
```

Drop any conflicting `X-Frame-Options` header. The companion script (`companion.js`) is injected into the Drupal template on every city page.

## Configuration

All backend settings are read from environment variables or a `.env` file. The most important ones:

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(required)* | Anthropic API key |
| `CHROMA_PATH` | `./chroma_db` | Path to the ChromaDB directory |
| `CHROMA_COLLECTION` | `city_website_content` | Collection name (must match crawler) |
| `SQLITE_PATH` | `./gigi.db` | SQLite database path |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Model for answer generation |
| `REWRITE_MODEL` | `claude-haiku-4-5-20251001` | Model for follow-up query rewrite |
| `HIGHLIGHT_MODEL` | `claude-haiku-4-5-20251001` | Model for highlight span extraction |
| `HIGHLIGHT_ENABLED` | `true` | Toggle async in-page highlighting |
| `TOP_K` | `8` | Number of chunks to retrieve |
| `MIN_SCORE` | `0.3` | Minimum cosine similarity threshold |
| `MAX_HISTORY` | `6` | Max prior turns passed to the model |
| `ALLOWED_FETCH_HOSTS` | `ggcity.org` | Hosts the backend may fetch for highlighting (SSRF guard) |
| `RATE_LIMIT_PER_IP` | `60` | Requests per IP per rate window |
| `RATE_LIMIT_PER_SESSION` | `30` | Requests per session per rate window |
| `RATE_WINDOW_SECONDS` | `60` | Rate limit window duration |
| `GIGI_ENV_FILE` | `.env` | Path to a custom env file |

`--min-score` is genuine cosine similarity in [0, 1]. Start around 0.3 and tune up if retrieval is returning irrelevant chunks.

## Inspect retrieval quality

```bash
python query_test.py --list                                   # every crawled page
python query_test.py --query "how do I apply for a permit"    # ranked results with similarity scores
python classify.py --summary-only                             # current classification label counts
```

`--list` and `--summary-only` do not load the embedding model or call any API.

## Run tests

```bash
# Python backend tests:
pytest tests/

# Frontend end-to-end and accessibility (requires browser install on first run):
cd frontend-gigi && npm run test:install && npm test
cd chat-module && npm run test:install && npm test
```

The Playwright suite covers happy-path streaming, tile lifecycle, companion highlight, hidden-content reveal, and accessibility (axe-core integrated).

## Notes and limitations

- **Embedding model must match**: `CHROMA_COLLECTION` and `EMBEDDING_MODEL` must be identical between the crawler run and the running backend. A mismatch causes silent retrieval failure.
- **Single-machine SQLite**: fine at pilot scale. Multi-instance deployment needs an external store.
- **Highlight is best-effort**: if the backend cannot fetch a cited page or snap the quote to a true substring, the tile opens without a highlight. The answer has already streamed and is unaffected.
- **JS-rendered sections**: the crawler fetches static HTML; sections built client-side after page load may not be in the index and may cause companion misses.
- **PII in logs**: user queries are stored in `interactions.user_query` for debuggability. This makes the interaction log a PII store. A retention and redaction policy is required before production deployment (City AR 2.16).
- **Language**: BGE-large-en is English-tuned. Swap `EMBEDDING_MODEL` for a multilingual model for non-English content.
- **WCAG 2.1 AA**: target compliance date April 26, 2027. The chat module was built to conformance. A full-system audit covering the shell, tiles, and companion is required before launch.
