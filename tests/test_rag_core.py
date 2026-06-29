"""Unit tests for the pure retrieval helpers used by query decomposition:
``content_key`` (chunk hashing) and ``merge_results`` (cross-query dedup + top-k)."""

from shared import rag_core


def _r(content, score, cid="c"):
    return {"content": content, "score": score, "url": "u", "chroma_id": cid}


def test_merge_dedups_by_content_keeping_highest_score():
    a = [_r("alpha", 0.5, "a1"), _r("beta", 0.4, "b1")]
    b = [_r("alpha", 0.9, "a2"), _r("gamma", 0.3, "g1")]   # alpha repeats with a higher score
    merged = rag_core.merge_results([a, b], top_k=10)

    assert [r["content"] for r in merged] == ["alpha", "beta", "gamma"]   # score-sorted, deduped
    assert merged[0]["content"] == "alpha" and merged[0]["score"] == 0.9  # highest score kept


def test_merge_truncates_to_top_k():
    lists = [[_r(f"c{i}", i / 10.0, f"id{i}") for i in range(8)]]
    merged = rag_core.merge_results(lists, top_k=3)
    assert [r["content"] for r in merged] == ["c7", "c6", "c5"]


def test_merge_handles_empty():
    assert rag_core.merge_results([], top_k=5) == []
    assert rag_core.merge_results([[], []], top_k=5) == []


def test_content_key_stable_and_distinct():
    assert rag_core.content_key("x") == rag_core.content_key("x")
    assert rag_core.content_key("x") != rag_core.content_key("y")
    assert rag_core.content_key("") == rag_core.content_key(None or "")
