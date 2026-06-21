"""Load-bearing parity test: text extracted + chunked at INDEX time must line up
with the text re-extracted at FETCH time, and the ``Title:`` chunk prefix must
never leak into fetched page text (V3.md sections 2.5, 9)."""

import re

from backend import fetch as fetch_mod
from shared import extraction

# A page long enough to force multi-chunk splitting (so the Title: prefix kicks
# in), with hidden-tab and boilerplate elements the crawler strips.
_BODY = " ".join(
    f"Sentence number {i} explains a city service in detail." for i in range(120)
)
HTML = f"""
<html><head><title>Trash Pickup</title></head>
<body>
  <nav>menu we strip</nav>
  <header>site header we strip</header>
  <main>
    <p>{_BODY}</p>
    <div class="tab-pane" hidden>Bulk pickup is available three times per year.</div>
  </main>
  <footer>footer we strip</footer>
  <script>var x = 1;</script>
</body></html>
"""


def test_index_and_fetch_extraction_match():
    # INDEX time: the crawler's extraction.
    index_text, title, _meta = extraction.extract_text_from_html(HTML, "https://x/trash")
    assert title == "Trash Pickup"

    # FETCH time: the backend re-extracts the same bytes through the same code.
    fetch_text = fetch_mod._extract(HTML.encode("utf-8"), "text/html", "https://x/trash")

    assert fetch_text == index_text                 # byte-identical normalization
    assert "menu we strip" not in fetch_text        # nav/header/footer/script gone
    assert "footer we strip" not in fetch_text
    assert "var x" not in fetch_text
    assert "Bulk pickup is available" in fetch_text  # hidden text still extracted


def test_chunks_are_substrings_of_fetched_text_but_title_prefix_is_not():
    index_text, title, _ = extraction.extract_text_from_html(HTML, "https://x/trash")
    chunks = extraction.chunk_text(index_text, title=title, chunk_size=1000, chunk_overlap=200)
    fetch_text = fetch_mod._extract(HTML.encode("utf-8"), "text/html", "https://x/trash")

    assert len(chunks) > 1                           # multi-chunk -> Title: prefix used
    assert any(c.startswith("Title: Trash Pickup") for c in chunks)
    # The Title: artifact is NOT on the live page.
    assert "Title:" not in fetch_text
    # Each chunk, stripped of the injected prefix, is real page text.
    for c in chunks:
        body = re.sub(r"^Title: .*?\n\n", "", c, flags=re.S)
        assert body in fetch_text
