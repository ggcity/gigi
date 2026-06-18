# City Website RAG Chatbot (Local Edition)

A RAG chatbot that helps residents navigate city services. This edition runs
the vector store and embeddings locally and calls Claude over the Anthropic API.

## Architecture

- Crawler (`website_crawler.py`): crawls a city website, extracts text + factual
  metadata (dates, PII heuristic, URL stats), embeds chunks, stores in Chroma
- Classifier (`classify.py`): a separate, re-runnable LLM pass that labels each
  page (document type, department, record status) for retention review
- Vector store: Chroma (local, persistent directory)
- Embeddings: BGE-large (`BAAI/bge-large-en-v1.5`) via sentence-transformers
- Chatbot ("Gigi", `city_chatbot.py`): conversational assistant. Answers with
  Claude Sonnet 4.6 (`claude-sonnet-4-6`); a cheap Haiku call rewrites follow-ups
  into standalone search queries so multi-turn context works
- Interface: Gradio with streaming responses

`rag_embeddings.py` is shared by the crawler and chatbot so the embedding model,
dimension, normalization, and query handling cannot drift apart.

## Prerequisites

- Python 3.9+
- An Anthropic API key
- About 1.3GB of disk for the BGE-large weights (downloaded on first run)
- GPU optional. CPU works; a GPU mainly speeds up the one-time crawl embedding.

## Setup

Install torch first, matched to your hardware, then the rest.

CPU-only box:

```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu
```

GPU box (CUDA). Check your CUDA version with `nvidia-smi`, then pick the matching
wheel (the official selector is at https://pytorch.org/get-started/locally/):

```bash
# cu121 / cu124 / cu126 are common; choose the closest <= your driver's CUDA
pip install torch --index-url https://download.pytorch.org/whl/cu124
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

Then:

```bash
pip install -r crawler_requirements.txt
pip install -r chatbot_requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
```

Optional, to bound CPU threads per request on a shared box:

```bash
export OMP_NUM_THREADS=8
```

## 1. Crawl the site

```bash
python website_crawler.py \
  --base-url https://your-city-website.com \
  --db-path ./chroma_db \
  --collection-name city_website_content
```

On a GPU box, add `--device cuda` to run embedding on the GPU (much faster for
large PDFs). Re-running upserts by URL (no wipe); pass `--recreate` to rebuild.
The crawl prints a summary by file type, year, and potential-PII flag. Document
type and department are NOT set here; they come from the classifier in step 2.

Performance note: embedding cost scales with chunk count, not page count, and
large PDFs (budget books, master plans) can be hundreds of chunks each. On CPU
this dominates runtime. Options: raise `--chunk-size`, lower `--max-file-size-mb`,
use `--skip-pdf`, or run with `--device cuda`.

## 2. Classify pages for retention (optional, decision-support)

```bash
python classify.py \
  --db-path ./chroma_db \
  --collection-name city_website_content \
  --model claude-haiku-4-5-20251001
```

Reads the crawled corpus, classifies each unique page with Haiku into a fixed
taxonomy (document type, department, record status, confidence, rationale), and
writes the labels back onto every chunk of that page. Re-runnable: it skips
pages already labeled unless you pass `--reclassify`. Use `--summary-only` to
print the current counts without calling the model. Edit the taxonomy lists at
the top of `classify.py` to match the city's actual retention schedule.

IMPORTANT: these labels are automated suggestions to support a records officer's
review. They are not an authority for retention or destruction decisions.

## 3. Start the chatbot

```bash
python city_chatbot.py \
  --db-path ./chroma_db \
  --collection-name city_website_content \
  --model-name claude-sonnet-4-6
```

Open http://localhost:7860

Gigi introduces herself on the first turn and keeps conversation context: a
Haiku call rewrites each follow-up into a standalone query for retrieval, and the
recent turns are passed to Sonnet for the answer (capped by `--max-history`).
Sources are linked inline in the answer (markdown links), and a Sources list is
also appended below unless you pass `--no-footer`.

The `--db-path` and `--embedding-model` MUST match what the crawler used, or
retrieval breaks. Classification is not required for the chatbot to work; the
chatbot retrieves by vector similarity and ignores the classification labels.

## Crawl scope and stopping

By default the crawler is breadth-first and stays on the start URL's exact host.
It keeps going until it runs out of in-scope links, so on a large site it will
try to crawl everything. Bound it with:

- `--max-depth N`: link depth from the start page. `0` = only the start page,
  `1` = start page plus pages it links to, etc. Unlimited if unset.
- `--max-pages N`: hard cap on pages crawled (counts successful pages; failed
  fetches still log but do not count). Unlimited if unset.
- `--allow-subdomains`: also follow subdomains of the start domain (default:
  same host only, so `www.city.gov` will not follow `docs.city.gov`).
- `--skip-pdf`: do not fetch or process PDFs (by extension and content-type).
- `--skip-spreadsheets`: do not fetch or process spreadsheets (xls, xlsx, xlsm,
  csv, tsv, ods). Useful because spreadsheets embed poorly and can surface as
  noisy citations.
- `--exclude-pattern REGEX` (repeatable): skip URLs matching the regex. Use this
  to keep auto-generated/templated pages out of the index, e.g. paginated record
  lists and query-string traps:
  `--exclude-pattern 'annual_permits' --exclude-pattern '\?year='`
- `--include-pattern REGEX` (repeatable): only crawl URLs matching at least one
  regex. Use to restrict a crawl to a section of the site.
- `--sitemap URL`: seed the crawl from a sitemap instead of just the start page.
  Handles a sitemap index and gzipped sub-sitemaps. The listed URLs become the
  depth-0 set, so the crawl covers what the CMS considers canonical content.
  Combine with `--max-depth 1` for a hybrid: sitemap pages plus one hop of the
  pages they link to. All filters (exclude patterns, robots, skip-pdf, etc.)
  still apply to both the seeds and the branched links.

A Drupal sitemap lists Drupal-managed content, so seeding from it tends to
exclude bolted-on non-Drupal apps (paginated record viewers, etc.) by
construction. Note it may also omit some legitimate pages or files that are
configured out of the sitemap.

Curation matters more than coverage. Indexing auto-generated list/search/
calendar pages pollutes retrieval: their boilerplate shares keywords with real
questions and crowds out the pages that actually answer them. Exclude them.

It restricts to the start URL's domain automatically; off-site links are
skipped, and robots.txt is fetched and enforced.

## Key options

Crawler: `--embedding-model`, `--device`, `--chunk-size`, `--chunk-overlap`,
`--max-concurrent`, `--recreate`, `--max-depth`, `--max-pages`,
`--allow-subdomains`, `--skip-pdf`, `--skip-spreadsheets`, `--exclude-pattern`, `--include-pattern`, `--sitemap`

Classifier: `--model`, `--concurrency`, `--reclassify`, `--summary-only`

Chatbot: `--model-name`, `--rewrite-model`, `--max-history`, `--no-footer`, `--top-k`, `--min-score`, `--temperature`, `--max-tokens`, `--share`

`--min-score` is genuine cosine similarity in [0, 1] (1 = identical). Start
around 0.3 and tune.

`--temperature` defaults to 0.0 (most deterministic). Temperature is a weak
hallucination control: the real levers are retrieval quality (`--min-score`,
`--top-k`) and the grounding instructions in the system prompt.

## Inspect and test retrieval

```bash
python query_test.py --list                                  # every crawled page
python query_test.py --query "how do I pay my water bill"    # ranked results + similarity
python classify.py --summary-only                            # current label counts
```

`--list` and `--summary-only` do not load the embedding model or call the API.
Use `query_test.py` similarity numbers to choose a `--min-score` for the chatbot.

## Notes and limitations

- Concurrency: a single Gradio process is bound by the Python GIL for the
  CPU-bound query embedding. Fine for staff or a pilot. For many simultaneous
  residents, run multiple worker processes or split the embedder into its own
  service.
- Language: BGE-large-en is English-tuned. Swap `--embedding-model` for a
  multilingual model if resident content is not primarily English.
- Aggregations: summaries are computed in Python over Chroma metadata. Fine at
  city scale; for very large corpora consider pgvector.
- Fragment URLs: the crawler currently treats `page#section` as distinct from
  `page`, which can cause duplicate fetches. Known minor issue.
- Tested with chromadb 1.5.x, gradio 6.x, anthropic 0.109.x. Lock the ranges in
  the requirements files to what installs cleanly on your machine.
- Data flow: crawled content and the crawler's PII flags stay local. The final
  prompt plus retrieved context goes to the Anthropic API (chatbot), and page
  text goes to the Anthropic API during classification (`classify.py`). 
