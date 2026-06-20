#!/usr/bin/env python3
"""
Page classifier for retention analysis (decision-support, not authority).

Reads the Chroma corpus produced by website_crawler.py, classifies each unique
page with a small Claude model (Haiku) into a fixed taxonomy, and writes the
labels back onto every chunk of that page. Runs as a separate, re-runnable pass
so the crawler stays fast and the taxonomy can change without re-crawling.

IMPORTANT: these labels are automated suggestions to support a records officer's
review. They must not drive automated retention or destruction decisions.

Set your key first:  export ANTHROPIC_API_KEY=sk-ant-...
"""

import argparse
import concurrent.futures
import json
import logging
import os
from collections import Counter, defaultdict
from typing import Dict, List

import chromadb
from anthropic import Anthropic

from shared.rag_embeddings import sanitize_metadata, fetch_all

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# ---- Taxonomy. Edit these to match the city's actual retention schedule. ----
DOCUMENT_TYPES = [
    "meeting_minutes", "agenda", "ordinance", "resolution", "contract",
    "budget", "financial_report", "audit", "permit_or_application",
    "policy_or_procedure", "public_notice", "staff_report", "press_release",
    "informational_page", "other",
]
DEPARTMENTS = [
    "city_council", "city_clerk", "city_manager", "planning", "building",
    "public_works", "water", "finance", "police", "fire", "parks_recreation",
    "human_resources", "information_technology", "city_attorney",
    "community_development", "other",
]
RECORD_STATUS = ["record", "informational", "unknown"]
CONFIDENCE = ["low", "medium", "high"]

CHAR_BUDGET = 6000  # how much page text to send for classification

SYSTEM_PROMPT = (
    "You are a records classifier for a municipal (city government) website. "
    "Classify the page for records-retention review. "
    "Choose exactly one document_type from this list: " + ", ".join(DOCUMENT_TYPES) + ". "
    "Choose exactly one department from this list: " + ", ".join(DEPARTMENTS) + ". "
    "If none fit, use 'other'. "
    "Set record_status to 'record' if the page is or contains an official city "
    "record likely subject to a retention schedule, 'informational' if it is a "
    "general web or info page, otherwise 'unknown'. "
    "Give a one-sentence rationale and a confidence of low, medium, or high. "
    "Output ONLY a JSON object with exactly these keys: document_type, "
    "department, record_status, confidence, rationale. "
    "No prose, no markdown, no code fences."
)


def parse_labels(raw: str) -> Dict:
    """Parse the model's JSON, tolerate code fences, and coerce to the taxonomy."""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lstrip().lower().startswith("json"):
            text = text.lstrip()[4:]
    # Grab the outermost JSON object if there is surrounding noise.
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1:
        text = text[start:end + 1]
    data = json.loads(text)

    def coerce(value, allowed, default):
        v = str(value).strip().lower().replace(" ", "_") if value is not None else default
        return v if v in allowed else default

    return {
        "document_type": coerce(data.get("document_type"), DOCUMENT_TYPES, "other"),
        "department": coerce(data.get("department"), DEPARTMENTS, "other"),
        "record_status": coerce(data.get("record_status"), RECORD_STATUS, "unknown"),
        "confidence": coerce(data.get("confidence"), CONFIDENCE, "low"),
        "rationale": str(data.get("rationale", ""))[:300],
    }


def classify_text(client: Anthropic, model: str, url: str, text: str) -> Dict:
    """Call the model for one page and return coerced labels."""
    resp = client.messages.create(
        model=model,
        max_tokens=300,
        temperature=0,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": f"URL: {url}\n\nPAGE TEXT:\n{text}"}],
    )
    raw = "".join(block.text for block in resp.content if getattr(block, "type", None) == "text")
    return parse_labels(raw)


def group_pages(collection) -> Dict[str, Dict]:
    """Group chunks by URL. Returns url -> {ids, text, sample_meta}."""
    data = fetch_all(collection, ["documents", "metadatas"])
    ids = data.get("ids", []) or []
    docs = data.get("documents", []) or []
    metas = data.get("metadatas", []) or []

    grouped: Dict[str, Dict] = defaultdict(lambda: {"ids": [], "chunks": [], "sample_meta": {}})
    id_to_meta = {}
    for cid, doc, meta in zip(ids, docs, metas):
        meta = meta or {}
        url = meta.get("url", "")
        grouped[url]["ids"].append(cid)
        grouped[url]["chunks"].append((meta.get("chunk_id", 0), doc or ""))
        grouped[url]["sample_meta"] = meta
        id_to_meta[cid] = meta

    for url, info in grouped.items():
        ordered = [d for _, d in sorted(info["chunks"], key=lambda x: x[0])]
        info["text"] = "\n".join(ordered)[:CHAR_BUDGET]
    return grouped, id_to_meta


def classify_collection(collection, client, model: str, concurrency: int = 8,
                        reclassify: bool = False, classify_fn=classify_text):
    grouped, id_to_meta = group_pages(collection)

    todo = []
    for url, info in grouped.items():
        if not url:
            continue
        if not reclassify and info["sample_meta"].get("classified") is True:
            continue
        todo.append((url, info))

    logger.info(f"{len(grouped)} pages total, {len(todo)} to classify "
                f"(concurrency={concurrency}, reclassify={reclassify})")

    def work(item):
        url, info = item
        try:
            labels = classify_fn(client, model, url, info["text"])
            return url, labels, None
        except Exception as e:
            return url, None, str(e)

    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        for url, labels, err in pool.map(work, todo):
            done += 1
            if err:
                logger.warning(f"classify failed for {url}: {err}")
                continue
            info = grouped[url]
            labels = dict(labels)
            labels["classified"] = True
            new_metas = []
            for cid in info["ids"]:
                merged = {**id_to_meta.get(cid, {}), **labels}
                new_metas.append(sanitize_metadata(merged))
            # Chroma writes in the main thread (one writer).
            collection.update(ids=info["ids"], metadatas=new_metas)
            if done % 25 == 0:
                logger.info(f"  classified {done}/{len(todo)} pages")

    logger.info(f"Classification complete: {done} pages processed")
    print_classification_summary(collection)


def print_classification_summary(collection):
    metas = fetch_all(collection, ["metadatas"])["metadatas"]
    # Reduce to one row per page for page-level counts.
    per_page = {}
    for m in metas:
        m = m or {}
        per_page[m.get("url", "")] = m
    rows = list(per_page.values())

    by_type = Counter(r.get("document_type", "unclassified") for r in rows)
    by_dept = Counter(r.get("department", "unclassified") for r in rows)
    by_status = Counter(r.get("record_status", "unclassified") for r in rows)
    by_conf = Counter(r.get("confidence", "n/a") for r in rows)

    logger.info("=" * 70)
    logger.info("CLASSIFICATION SUMMARY (page-level) - decision-support only")
    logger.info("=" * 70)
    logger.info(f"Pages: {len(rows)}")
    for label, counter in [("Document Types", by_type), ("Departments", by_dept),
                           ("Record Status", by_status), ("Confidence", by_conf)]:
        logger.info(f"{label}:")
        for key, count in counter.most_common():
            logger.info(f"  {str(key):24s}: {count}")
    logger.info("=" * 70)
    logger.info("NOTE: labels are automated suggestions for records-officer review, "
                "not an authority for retention or destruction decisions.")


def _env_default(name, fallback):
    return os.environ.get(name, fallback)


def main():
    parser = argparse.ArgumentParser(description="Classify crawled pages with Claude (retention support)")
    parser.add_argument("--db-path", default=_env_default("CHROMA_PATH", "./chroma_db"))
    parser.add_argument("--collection-name", default=_env_default("CHROMA_COLLECTION", "city_website_content"))
    parser.add_argument("--model", default=_env_default("CLASSIFIER_MODEL", "claude-haiku-4-5-20251001"),
                        help="Anthropic model ID for classification")
    parser.add_argument("--api-key", default=None, help="Anthropic API key (else ANTHROPIC_API_KEY env)")
    parser.add_argument("--concurrency", type=int, default=8, help="Parallel classification calls")
    parser.add_argument("--reclassify", action="store_true",
                        help="Re-classify pages already labeled (default: skip them)")
    parser.add_argument("--summary-only", action="store_true",
                        help="Just print the current classification summary and exit")
    args = parser.parse_args()

    client = chromadb.PersistentClient(path=args.db_path)
    collection = client.get_or_create_collection(
        name=args.collection_name, metadata={"hnsw:space": "cosine"})
    count = collection.count()
    print(f"Collection '{args.collection_name}' has {count} chunks at {args.db_path}")
    if count == 0:
        print("Empty collection. Run the crawler first.")
        return

    if args.summary_only:
        print_classification_summary(collection)
        return

    anthropic_client = Anthropic(api_key=args.api_key) if args.api_key else Anthropic()
    classify_collection(collection, anthropic_client, args.model,
                        concurrency=args.concurrency, reclassify=args.reclassify)


if __name__ == "__main__":
    main()
