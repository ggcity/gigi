"""Shared pytest fixtures for the V3 backend tests.

Mocks Anthropic at the SDK boundary with an async fake: ``messages.stream`` is an
async context manager whose ``text_stream`` yields scripted word tokens, and
``messages.create`` answers the ``report_highlights`` tool. Plus a deterministic
hash-vector embedder, a temp Chroma collection, and a temp SQLite store. No
network, no torch, no real models.
"""

import math
import os
import re
import sys

import pytest

# Tests live in tests/; make the repo root importable for `shared` and `backend`.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.config import Settings          # noqa: E402
from backend.fetch import FetchResult        # noqa: E402
from backend.store import Store              # noqa: E402


# --------------------------------------------------------------------------- #
# Fake embedder: deterministic hashed bag-of-words vectors (matches v2 tests). #
# --------------------------------------------------------------------------- #
class FakeEmbedder:
    def __init__(self, model_name=None, device="cpu", **kw):
        self.dimension = 64
        self.model_name = model_name or "fake"
        self.query_instruction = ""

    def _vec(self, t):
        v = [0.0] * 64
        for tok in re.findall(r"[a-z0-9]+", (t or "").lower()):
            v[hash(tok) % 64] += 1.0
        n = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / n for x in v]

    def embed_documents(self, ts):
        return [self._vec(t) for t in ts]

    def embed_query(self, t):
        return self._vec(t)


# --------------------------------------------------------------------------- #
# Fake async Anthropic client: streaming answer + highlight tool.             #
# --------------------------------------------------------------------------- #
class _Usage:
    def __init__(self, i, o):
        self.input_tokens = i
        self.output_tokens = o


class _ToolBlock:
    def __init__(self, name, inp):
        self.type = "tool_use"
        self.name = name
        self.input = inp


class _TextBlock:
    def __init__(self, text):
        self.type = "text"
        self.text = text


class _Resp:
    def __init__(self, content, usage=(8, 4)):
        self.content = content
        self.usage = _Usage(*usage)


class _FinalMsg:
    def __init__(self, usage=(10, 5)):
        self.usage = _Usage(*usage)


class _Stream:
    def __init__(self, text):
        self._text = text

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    @property
    def text_stream(self):
        parts = self._text.split(" ")

        async def _gen():
            for i, w in enumerate(parts):
                yield w + ("" if i == len(parts) - 1 else " ")
        return _gen()

    async def get_final_message(self):
        return _FinalMsg()


def _extract_claims(kw):
    """Parse the [id] text lines from a highlight prompt."""
    content = kw["messages"][-1]["content"]
    m = re.search(r"CLAIMS \(.*?\):\n(.*?)\n\nPAGE TEXT:", content, re.S)
    block = m.group(1) if m else ""
    out = []
    for line in block.splitlines():
        lm = re.match(r"\[([^\]]+)\]\s*(.*)", line)
        if lm:
            out.append((lm.group(1), lm.group(2).strip()))
    return out


class _Messages:
    def __init__(self, client):
        self.client = client

    def stream(self, **kw):
        # NOT a coroutine: returns an async context manager, like the real SDK.
        self.client.calls.append({"kind": "stream", "tool": None, "kw": kw})
        return _Stream(self.client.answer_text)

    async def create(self, **kw):
        tools = kw.get("tools")
        name = tools[0]["name"] if tools else None
        self.client.calls.append({"kind": "create", "tool": name, "kw": kw})
        if name == "report_highlights":
            results = [{"claim_id": cid, "quote": self.client.highlight_quote}
                       for cid, _text in _extract_claims(kw)]
            return _Resp([_ToolBlock("report_highlights", {"results": results})])
        # The only non-tool create call is the follow-up retrieval rewrite; return
        # a text block carrying the scripted standalone query.
        return _Resp([_TextBlock(self.client.rewrite_text)])


class FakeAsyncClient:
    def __init__(self):
        self.messages = _Messages(self)
        self.calls = []
        # Default answer cites the water page with a quote that exists on it.
        self.answer_text = (
            "You can [pay your water bill online](https://www.ggcity.org/water) "
            "or visit City Hall."
        )
        self.highlight_quote = "pay your water bill online"
        # The rewrite call returns this standalone query; it still retrieves the
        # water doc in the fixture collection.
        self.rewrite_text = "pay water bill online"

    def tool_calls(self, name):
        return [c for c in self.calls if c["tool"] == name]

    def stream_calls(self):
        return [c for c in self.calls if c["kind"] == "stream"]


# --------------------------------------------------------------------------- #
# Fixtures.                                                                    #
# --------------------------------------------------------------------------- #
@pytest.fixture
def settings(tmp_path):
    return Settings(
        sqlite_path=str(tmp_path / "gigi.db"),
        min_score=0.0,
        top_k=5,
        max_cited_urls=4,
        max_tiles=4,
        rate_limit_per_ip=1000,
        rate_limit_per_session=1000,
        max_query_chars=2000,
        max_history_messages=6,
        # highlight_enabled defaults True; allowed_fetch_hosts defaults ("ggcity.org",)
    )


@pytest.fixture
def no_highlight_settings(settings):
    import dataclasses
    return dataclasses.replace(settings, highlight_enabled=False)


@pytest.fixture
def store(settings):
    s = Store(settings.sqlite_path)
    yield s
    s.close()


@pytest.fixture
def fake_client():
    return FakeAsyncClient()


@pytest.fixture
def embedder():
    return FakeEmbedder()


@pytest.fixture
def collection():
    import chromadb
    client = chromadb.EphemeralClient()
    coll = client.get_or_create_collection(name="testcoll", metadata={"hnsw:space": "cosine"})
    emb = FakeEmbedder()
    docs = [
        "You can pay your water bill online or in person at City Hall.",
        "A building permit application requires plans and a fee.",
    ]
    metas = [
        {"title": "Water Billing", "url": "https://www.ggcity.org/water", "file_type": "html"},
        {"title": "Building Permits", "url": "https://www.ggcity.org/permits", "file_type": "html"},
    ]
    coll.upsert(ids=["w1", "p1"], embeddings=emb.embed_documents(docs),
                documents=docs, metadatas=metas)
    return coll
