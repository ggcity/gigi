"""Unit tests for citation parsing from the streamed prose answer."""

from backend.answer import parse_citations


def test_parses_inline_markdown_links():
    text = ("You can [pay your water bill online](https://www.ggcity.org/water) or "
            "visit the [permits desk](https://www.ggcity.org/permits#hours) at City Hall.")
    cites = parse_citations(text)
    urls = [c["url"] for c in cites]
    assert urls == ["https://www.ggcity.org/water", "https://www.ggcity.org/permits"]  # fragment stripped
    # The claim is the surrounding sentence with the link flattened to its anchor.
    assert "pay your water bill online" in cites[0]["claim"]
    assert "[" not in cites[0]["claim"] and "](" not in cites[0]["claim"]


def test_no_links_no_citations():
    assert parse_citations("I'm not sure, please check the city website.") == []
    assert parse_citations("") == []
