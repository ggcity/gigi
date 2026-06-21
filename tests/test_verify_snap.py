"""Load-bearing unit tests for the fuzzy ``snap`` aligner (V3.md sections 2.5, 7)."""

from backend.highlight import snap

PAGE = "You can pay your water bill online or in person at City Hall during business hours."


def test_snap_exact_substring():
    assert snap("pay your water bill online", PAGE) == "pay your water bill online"


def test_snap_normalizes_whitespace():
    # Messy whitespace in the model span collapses to a clean true substring.
    assert snap("pay your   water\n bill   online", PAGE) == "pay your water bill online"


def test_snap_recovers_lightly_corrupted_span():
    # Model introduced a typo ('watter'); snap recovers the real page substring.
    got = snap("pay your watter bill online", PAGE)
    assert got is not None
    assert got in PAGE
    assert "water bill online" in got


def test_snap_returns_none_when_unrecoverable():
    assert snap("completely unrelated zebra quantum flux capacitor", PAGE) is None
    assert snap("", PAGE) is None
    assert snap("anything", "") is None


def test_snap_rejects_title_artifact():
    # The crawler's injected chunk prefix must never become a highlight quote.
    assert snap("Title: Water Billing", PAGE) is None
    assert snap("Title: Water Billing\n\nYou can pay your water bill", PAGE) is None
