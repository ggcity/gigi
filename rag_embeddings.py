#!/usr/bin/env python3
"""
Shared local embedding helper for the City RAG system.

Both the crawler and the chatbot import this so they cannot drift apart on the
model, dimension, normalization, or query handling. If those differ between
indexing and querying, retrieval silently degrades.

Default model is BAAI/bge-large-en-v1.5 (about 335M params, 1024-dim, runs on
CPU). The first run downloads roughly 1.3GB from Hugging Face and caches it.
"""

from typing import Dict, List

DEFAULT_MODEL = "BAAI/bge-large-en-v1.5"

# BGE v1.5 recommends prefixing the QUERY (not the documents) with this
# instruction for short-query-to-passage retrieval. It measurably helps recall.
DEFAULT_QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: "


class Embedder:
    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        device: str = "cpu",
        normalize: bool = True,
        query_instruction: str = DEFAULT_QUERY_INSTRUCTION,
        batch_size: int = 32,
    ):
        # Imported here, not at module top, so that importing this module (for
        # sanitize_metadata, or just to reference Embedder) does not pull in
        # torch unless an Embedder is actually constructed.
        from sentence_transformers import SentenceTransformer

        self.model_name = model_name
        self.normalize = normalize
        self.query_instruction = query_instruction
        self.batch_size = batch_size
        # device="cpu" avoids any attempt to grab a (nonexistent) GPU.
        self.model = SentenceTransformer(model_name, device=device)
        # Method was renamed in newer sentence-transformers; support both.
        if hasattr(self.model, "get_embedding_dimension"):
            self.dimension = self.model.get_embedding_dimension()
        else:
            self.dimension = self.model.get_sentence_embedding_dimension()

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        """Embed passages for storage. Batched for CPU throughput."""
        embeddings = self.model.encode(
            texts,
            batch_size=self.batch_size,
            normalize_embeddings=self.normalize,
            show_progress_bar=False,
        )
        return [vec.tolist() for vec in embeddings]

    def embed_query(self, text: str) -> List[float]:
        """Embed a single query, with the BGE query instruction prepended."""
        prompt = f"{self.query_instruction}{text}" if self.query_instruction else text
        vec = self.model.encode(
            [prompt],
            normalize_embeddings=self.normalize,
            show_progress_bar=False,
        )[0]
        return vec.tolist()


def sanitize_metadata(metadata: Dict) -> Dict:
    """
    Chroma only accepts str/int/float/bool metadata values. The crawler produces
    lists (pii_types, url_segments, keywords) and None values (e.g. department),
    which Chroma rejects. Lists become comma-joined strings; None is dropped.
    """
    clean: Dict = {}
    for key, value in metadata.items():
        if value is None:
            continue
        if isinstance(value, bool):
            clean[key] = value
        elif isinstance(value, (int, float, str)):
            clean[key] = value
        elif isinstance(value, (list, tuple)):
            clean[key] = ", ".join(str(item) for item in value) if value else ""
        else:
            clean[key] = str(value)
    return clean


def fetch_all(collection, include=("metadatas",), batch_size: int = 1000) -> Dict:
    """Page through an entire Chroma collection.

    A plain collection.get() on a large collection can exceed SQLite's bound-
    variable limit ("too many SQL variables"). This pulls the data in batches
    via limit/offset and concatenates it. batch_size is conservative; lower it
    if you are on a very old SQLite build.
    """
    include = list(include)
    result: Dict = {"ids": []}
    for key in include:
        result[key] = []
    offset = 0
    while True:
        batch = collection.get(include=include, limit=batch_size, offset=offset)
        ids = batch.get("ids", []) or []
        if not ids:
            break
        result["ids"].extend(ids)
        for key in include:
            result[key].extend(batch.get(key) or [])
        if len(ids) < batch_size:
            break
        offset += batch_size
    return result
