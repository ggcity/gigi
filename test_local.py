#!/usr/bin/env python3
import asyncio, math, re, threading, tempfile, sys, os
from http.server import BaseHTTPRequestHandler, HTTPServer

import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# ---- Fake embedder: deterministic hashing bag-of-words, so token overlap
# ---- produces meaningful cosine similarity without downloading a real model.
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

# ---- Fixture "city site"
PAGES = {
    "/": ("text/html",
          "<html><head><title>City Home</title></head><body>"
          "<p>Welcome to the city website. Find city services and information here for residents.</p>"
          '<a href="/services">Services</a> <a href="/permits">Permits</a> '
          '<a href="/water">Water Bill</a> <a href="/private">Private</a> '
          '<a href="https://example.com/external">External</a>'
          "</body></html>"),
    "/services": ("text/html",
          "<html><head><title>City Services</title></head><body>"
          "<p>The city provides many services including parks recreation and water quality programs.</p>"
          '<a href="/services/parks">Parks</a> <a href="/services/water-quality">Water Quality</a>'
          "</body></html>"),
    "/permits": ("text/html",
          "<html><head><title>Permits and Applications</title></head><body>"
          "<p>Apply for a building permit. Submit your permit application form. "
          "Questions call 714-555-1234 for the planning department.</p>"
          "</body></html>"),
    "/water": ("text/html",
          "<html><head><title>Pay Water Bill</title></head><body>"
          "<p>Residents can pay their water bill online. The water utility billing office "
          "accepts payment for water and sewer services every month.</p>"
          "</body></html>"),
    "/services/parks": ("text/html",
          "<html><head><title>Parks and Recreation</title></head><body>"
          "<p>City parks offer recreation programs sports fields and community events for families.</p>"
          "</body></html>"),
    "/services/water-quality": ("text/html",
          "<html><head><title>Water Quality</title></head><body>"
          "<p>Annual water quality report describes testing of the public water supply system.</p>"
          "</body></html>"),
    "/private": ("text/html",
          "<html><head><title>Private</title></head><body>"
          "<p>This private page is disallowed by robots and should never be crawled by the bot.</p>"
          "</body></html>"),
    "/robots.txt": ("text/plain", "User-agent: *\nDisallow: /private\n"),
}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # silence
        pass
    def _send(self, body_only):
        entry = PAGES.get(self.path)
        if entry is None:
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()
            return None
        ctype, body = entry
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        return data
    def do_HEAD(self):
        self._send(True)
    def do_GET(self):
        data = self._send(False)
        if data is not None:
            self.wfile.write(data)

def start_server():
    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.socket.getsockname()[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, port

# ---- Tests
import website_crawler
website_crawler.Embedder = FakeEmbedder  # inject stand-in

results = []
def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name)

async def run_crawl(base, db_path, **kw):
    async with website_crawler.WebsiteCrawler(
        base_url=base, db_path=db_path, collection_name="test_content", **kw
    ) as crawler:
        await crawler.crawl_website()
        return crawler

def main():
    httpd, port = start_server()
    base = f"http://127.0.0.1:{port}"
    print(f"Fixture server on {base}")

    # --- Scenario 1: max_depth=1 -> depth-2 pages excluded, robots + offsite excluded
    d1 = tempfile.mkdtemp()
    c1 = asyncio.run(run_crawl(base, d1, max_depth=1, recreate=True))
    crawled_paths = {p.replace(base, "") or "/" for p in c1.crawled_urls}
    print("crawled (depth=1):", sorted(crawled_paths))
    check("depth1 includes home/services/permits/water",
          {"/", "/services", "/permits", "/water"}.issubset(crawled_paths))
    check("depth1 EXCLUDES depth-2 pages",
          not any(p.startswith("/services/") for p in crawled_paths))
    check("robots-disallowed /private NOT crawled", "/private" not in crawled_paths)
    check("offsite example.com NOT crawled",
          not any("example.com" in u for u in c1.crawled_urls))

    # --- Scenario 2: max_depth=2 -> depth-2 pages now included
    d2 = tempfile.mkdtemp()
    c2 = asyncio.run(run_crawl(base, d2, max_depth=2, recreate=True))
    paths2 = {p.replace(base, "") or "/" for p in c2.crawled_urls}
    print("crawled (depth=2):", sorted(paths2))
    check("depth2 includes /services/parks", "/services/parks" in paths2)

    # --- Scenario 3: max_pages cap
    d3 = tempfile.mkdtemp()
    c3 = asyncio.run(run_crawl(base, d3, max_pages=2, recreate=True))
    print("crawled count (max_pages=2):", len(c3.crawled_urls))
    check("max_pages caps crawl at 2", len(c3.crawled_urls) <= 2)

    # --- Scenario 4: Chroma round-trip + query (reuse depth-2 DB)
    import chromadb
    client = chromadb.PersistentClient(path=d2)
    coll = client.get_or_create_collection(name="test_content", metadata={"hnsw:space": "cosine"})
    total = coll.count()
    print("chunks stored:", total)
    check("chunks were stored", total > 0)

    emb = FakeEmbedder()
    q = coll.query(query_embeddings=[emb.embed_query("pay my water bill online")],
                   n_results=3, include=["documents", "metadatas", "distances"])
    dists = q["distances"][0]
    metas = q["metadatas"][0]
    print("top result url:", metas[0].get("url"), "distance:", round(dists[0], 3))
    sim0 = 1.0 - dists[0]
    check("distance->similarity in [0,1]", 0.0 <= sim0 <= 1.0001)
    check("water query ranks the water page first", "/water" in (metas[0].get("url") or ""))

    # --- Scenario 5: PII flag + list/None metadata survived the sanitizer
    permit = coll.get(where={"url": f"{base}/permits"}, include=["metadatas"])
    pm = permit["metadatas"][0] if permit["metadatas"] else {}
    check("permits page flagged potential PII (phone)", pm.get("contains_potential_pii") is True)
    check("pii_types stored as joined string", isinstance(pm.get("pii_types"), str))
    check("crawler does NOT set document_type (now done by classify.py)", pm.get("document_type") is None)

    # --- Scenario 6: subdomain logic (unit-level)
    sub = website_crawler.WebsiteCrawler(
        base_url="https://www.city.gov", db_path=tempfile.mkdtemp(),
        collection_name="tsub", allow_subdomains=True)
    check("subdomain allowed when flag set", sub.is_valid_url("https://docs.city.gov/page"))
    check("apex allowed when flag set", sub.is_valid_url("https://city.gov/page"))
    check("unrelated domain still rejected", not sub.is_valid_url("https://evil.com/page"))
    nosub = website_crawler.WebsiteCrawler(
        base_url="https://www.city.gov", db_path=tempfile.mkdtemp(), collection_name="tnosub")
    check("subdomain rejected by default", not nosub.is_valid_url("https://docs.city.gov/page"))

    httpd.shutdown()
    print("\n=== %d/%d passed ===" % (sum(1 for _, ok in results if ok), len(results)))
    if any(not ok for _, ok in results):
        sys.exit(1)

if __name__ == "__main__":
    main()
