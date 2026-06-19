#!/usr/bin/env python3
"""
Tests for add_resource.py, in the style of test_local.py / test_chatbot.py:
  * deterministic fake embedder (no model download)
  * a local HTTP fixture server for the --url fetch path
  * real temp Chroma round-trips
  * assertions on behavior that matters: ID scheme, upsert-not-duplicate,
    PII gate, type detection/override, dry-run, metadata shape, chunk parity.

Run: python test_add_resource.py
"""

import argparse
import hashlib
import math
import os
import re
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


# ---- Fake embedder: deterministic hashing bag-of-words (matches the other
# ---- suites), so we never download BGE-large.
class FakeEmbedder:
    def __init__(self, model_name=None, device="cpu", **kw):
        self.dimension = 64
        self.model_name = model_name or "fake"
        self.query_instruction = ""

    def _vec(self, text):
        v = [0.0] * self.dimension
        for tok in re.findall(r"[a-z0-9]+", (text or "").lower()):
            v[hash(tok) % self.dimension] += 1.0
        n = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / n for x in v]

    def embed_documents(self, texts):
        return [self._vec(t) for t in texts]

    def embed_query(self, text):
        return self._vec(text)


import add_resource
add_resource.Embedder = FakeEmbedder  # inject stand-in, same trick as test_local.py

import chromadb

results = []


def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name)


# ---- Build real fixture files on disk -------------------------------------
def make_pdf(path, text):
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import letter
    c = canvas.Canvas(path, pagesize=letter)
    y = 750
    for line in text.split("\n"):
        c.drawString(72, y, line)
        y -= 16
    c.save()


def make_docx(path, text):
    from docx import Document
    d = Document()
    for line in text.split("\n"):
        d.add_paragraph(line)
    d.save(path)


# ---- HTTP fixture server for the --url path -------------------------------
WATER_HTML = (
    "<html><head><title>Pay Water Bill</title></head><body>"
    "<p>Residents can pay their water bill online. The water utility billing "
    "office accepts payment for water and sewer services every month for all "
    "city residents in good standing.</p></body></html>"
)
PII_HTML = (
    "<html><head><title>Staff Directory</title></head><body>"
    "<p>Contact the planning department. Email jane.doe@example.com or call "
    "714-555-1234 for assistance with your application and related questions.</p>"
    "</body></html>"
)


class Handler(BaseHTTPRequestHandler):
    PAGES = {
        "/water": ("text/html", WATER_HTML),
        "/staff": ("text/html", PII_HTML),
    }

    def log_message(self, *a):
        pass

    def _entry(self):
        return self.PAGES.get(self.path)

    def do_HEAD(self):
        entry = self._entry()
        if entry is None:
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()
            return
        ctype, body = entry
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()

    def do_GET(self):
        entry = self._entry()
        if entry is None:
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()
            return
        ctype, body = entry
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def start_server():
    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.socket.getsockname()[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


# ---- args factory: mirrors main()'s defaults so ingest() sees a full ns ----
def make_args(db_path, **over):
    ns = argparse.Namespace(
        file=None, url=None, type=None, title=None, source_id=None,
        allow_pii=False,
        db_path=db_path, collection_name="test_content",
        embedding_model="fake", device="cpu",
        chunk_size=1000, chunk_overlap=200,
        dry_run=False,
    )
    for k, v in over.items():
        setattr(ns, k, v)
    return ns


def open_coll(db_path):
    return chromadb.PersistentClient(path=db_path).get_or_create_collection(
        name="test_content", metadata={"hnsw:space": "cosine"})


def main():
    httpd, port = start_server()
    base = f"http://127.0.0.1:{port}"
    print(f"Fixture server on {base}")

    workdir = tempfile.mkdtemp()
    txt_path = os.path.join(workdir, "faq.txt")
    md_path = os.path.join(workdir, "notes.md")
    pdf_path = os.path.join(workdir, "fees.pdf")
    docx_path = os.path.join(workdir, "policy.docx")
    html_path = os.path.join(workdir, "page.html")
    pii_txt_path = os.path.join(workdir, "contacts.txt")
    short_path = os.path.join(workdir, "short.txt")

    long_body = ("Residents can pay their water bill online through the city "
                 "billing office. Water and sewer payments are accepted monthly "
                 "for all residents in good standing across the city.")
    with open(txt_path, "w") as f:
        f.write(long_body)
    with open(md_path, "w") as f:
        f.write("# Water Billing\n\n" + long_body)
    with open(pii_txt_path, "w") as f:
        f.write("Reach the office at 714-555-1234 or email clerk@example.com. "
                + long_body)
    with open(short_path, "w") as f:
        f.write("too short")
    make_pdf(pdf_path, "City Fee Schedule 2026\n" + long_body)
    make_docx(docx_path, "Refund Policy\n" + long_body)
    with open(html_path, "w") as f:
        f.write(WATER_HTML)

    # --- Scenario 1: local TXT, no URL --------------------------------------
    d = tempfile.mkdtemp()
    rc = add_resource.ingest(make_args(d, file=txt_path, title="Water FAQ"))
    coll = open_coll(d)
    check("txt: ingest returns 0", rc == 0)
    check("txt: at least one chunk stored", coll.count() >= 1)
    got = coll.get(include=["metadatas"])
    m0 = got["metadatas"][0]
    check("txt: url empty when no --url given", m0.get("url") in ("", None) or m0.get("url") == "")
    check("txt: title override applied", m0.get("title") == "Water FAQ")
    check("txt: file_type is txt", m0.get("file_type") == "txt")
    check("txt: provenance tag set", m0.get("ingested_via") == "add_resource")
    check("txt: local_source_path recorded", bool(m0.get("local_source_path")))
    # ID scheme for no-URL: md5(f"local:{abs_path}_0")
    expect_id = hashlib.md5(f"local:{os.path.realpath(txt_path)}_0".encode()).hexdigest()
    check("txt: no-URL ID scheme matches local:<path>_i", expect_id in got["ids"])

    # --- Scenario 2: re-ingest SAME file upserts, does not duplicate --------
    before = coll.count()
    rc = add_resource.ingest(make_args(d, file=txt_path, title="Water FAQ"))
    after = open_coll(d).count()
    check("txt: re-ingest upserts (no duplicate chunks)", after == before)

    # --- Scenario 3: local file WITH --url uses crawler ID scheme -----------
    d = tempfile.mkdtemp()
    file_url = "https://www.ggcity.org/finance/fees.pdf"
    rc = add_resource.ingest(make_args(d, file=pdf_path, url=file_url))
    coll = open_coll(d)
    check("pdf+url: ingest returns 0", rc == 0)
    g = coll.get(include=["metadatas"])
    mm = g["metadatas"][0]
    check("pdf+url: url stored", mm.get("url") == file_url)
    check("pdf+url: file_type pdf", mm.get("file_type") == "pdf")
    # Crawler ID scheme: md5(f"{url}_{i}") -- this is what makes it upsert over a crawl
    crawler_id0 = hashlib.md5(f"{file_url}_0".encode()).hexdigest()
    check("pdf+url: ID matches crawler scheme md5(url_i)", crawler_id0 in g["ids"])
    check("pdf+url: analyze_url ran (url_path set)", mm.get("url_path") == "finance/fees.pdf")

    # --- Scenario 4: DOCX local --------------------------------------------
    d = tempfile.mkdtemp()
    rc = add_resource.ingest(make_args(d, file=docx_path))
    coll = open_coll(d)
    check("docx: ingest returns 0", rc == 0)
    dm = coll.get(include=["documents", "metadatas"])
    check("docx: file_type docx", dm["metadatas"][0].get("file_type") == "docx")
    check("docx: text actually extracted", any("water" in (d or "").lower()
                                               for d in dm["documents"]))

    # --- Scenario 5: HTML local --------------------------------------------
    d = tempfile.mkdtemp()
    rc = add_resource.ingest(make_args(d, file=html_path, url=f"{base}/water"))
    coll = open_coll(d)
    hm = coll.get(include=["documents", "metadatas"])
    check("html: ingest returns 0", rc == 0)
    check("html: file_type html", hm["metadatas"][0].get("file_type") == "html")
    check("html: title from <title> tag", hm["metadatas"][0].get("title") == "Pay Water Bill")
    check("html: boilerplate stripped, body text kept",
          any("billing office" in (d or "") for d in hm["documents"]))

    # --- Scenario 6: --url fetch path (no local file) -----------------------
    d = tempfile.mkdtemp()
    rc = add_resource.ingest(make_args(d, url=f"{base}/water"))
    coll = open_coll(d)
    um = coll.get(include=["metadatas"])
    check("url-only: ingest returns 0", rc == 0)
    check("url-only: file_type inferred html from content-type",
          um["metadatas"][0].get("file_type") == "html")
    check("url-only: url stored for citation", um["metadatas"][0].get("url") == f"{base}/water")
    check("url-only: no local_source_path", um["metadatas"][0].get("local_source_path") is None)

    # --- Scenario 7: PII gate refuses by default, overrides with --allow-pii -
    d = tempfile.mkdtemp()
    rc_refuse = add_resource.ingest(make_args(d, file=pii_txt_path))
    check("pii: refused by default (rc==3)", rc_refuse == 3)
    check("pii: nothing written on refusal", open_coll(d).count() == 0)
    rc_allow = add_resource.ingest(make_args(d, file=pii_txt_path, allow_pii=True))
    coll = open_coll(d)
    check("pii: --allow-pii ingests (rc==0)", rc_allow == 0)
    pm = coll.get(include=["metadatas"])["metadatas"][0]
    check("pii: contains_potential_pii flagged True", pm.get("contains_potential_pii") is True)
    check("pii: pii_types stored as joined string", isinstance(pm.get("pii_types"), str)
          and "phone" in pm.get("pii_types"))

    # --- Scenario 8: too-short content rejected, writes nothing -------------
    d = tempfile.mkdtemp()
    rc = add_resource.ingest(make_args(d, file=short_path))
    check("short: rejected (rc==1)", rc == 1)
    check("short: nothing written", open_coll(d).count() == 0)

    # --- Scenario 9: dry-run writes nothing ---------------------------------
    d = tempfile.mkdtemp()
    rc = add_resource.ingest(make_args(d, file=txt_path, dry_run=True))
    check("dry-run: returns 0", rc == 0)
    check("dry-run: nothing written to Chroma", open_coll(d).count() == 0)

    # --- Scenario 10: --type override beats extension -----------------------
    d = tempfile.mkdtemp()
    # md file, but force txt explicitly (both map to txt extractor); assert it took
    rc = add_resource.ingest(make_args(d, file=md_path, type="txt"))
    coll = open_coll(d)
    check("type-override: ingest returns 0", rc == 0)
    check("type-override: file_type honored", coll.get(include=["metadatas"])["metadatas"][0]
          .get("file_type") == "txt")

    # --- Scenario 11: chunk parity with the crawler's chunk_text ------------
    # Same text + same chunk_size/overlap must yield identical chunks.
    import website_crawler  # only to borrow the instance method's logic
    big = (" ".join(["water billing permit application planning department"] * 400))
    local_chunks = add_resource.chunk_text(big, "T", 1000, 200)
    # Build a throwaway crawler just to call its chunk_text (no network, no embed).
    wc = website_crawler.WebsiteCrawler.__new__(website_crawler.WebsiteCrawler)
    wc.chunk_size = 1000
    wc.chunk_overlap = 200
    crawler_chunks = wc.chunk_text(big, "T")
    check("chunk parity: same boundaries as crawler.chunk_text",
          local_chunks == crawler_chunks)

    # --- Scenario 12: neither --file nor --url -> usage error ---------------
    d = tempfile.mkdtemp()
    rc = add_resource.ingest(make_args(d))
    check("no source: returns usage error (rc==2)", rc == 2)

    httpd.shutdown()
    passed = sum(1 for _, ok in results if ok)
    print("\n=== %d/%d passed ===" % (passed, len(results)))
    sys.exit(1 if passed != len(results) else 0)


if __name__ == "__main__":
    main()
