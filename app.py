#!/usr/bin/env python3
"""
Entry point for Hugging Face Spaces (Gradio SDK).

Spaces runs this file and expects a Gradio app bound to 0.0.0.0:7860.
Configuration comes from environment variables (set non-secret ones as
Space "Variables" and ANTHROPIC_API_KEY as a Space "Secret").
"""

import os

from city_chatbot import CityRAGChatbot


def ensure_chroma(db_path: str):
    """If the Chroma directory isn't already here (e.g. local dev), download it
    from the private HF dataset. Uses HF_TOKEN (set as a Space secret)."""
    if os.path.isdir(db_path) and os.listdir(db_path):
        return
    repo = os.environ.get("CHROMA_DATASET", "ggcity/gigi-chromadb")
    from huggingface_hub import snapshot_download
    print(f"Downloading ChromaDB from dataset {repo} into {db_path} ...")
    snapshot_download(
        repo_id=repo,
        repo_type="dataset",
        local_dir=db_path,
        token=os.environ.get("HF_TOKEN"),
    )
    print("ChromaDB download complete.")


def build():
    db_path = os.environ.get("CHROMA_PATH", "./chroma_db")
    ensure_chroma(db_path)
    bot = CityRAGChatbot(
        model_name=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
        rewrite_model=os.environ.get("REWRITE_MODEL", "claude-haiku-4-5-20251001"),
        db_path=db_path,
        collection_name=os.environ.get("CHROMA_COLLECTION", "city_website_content"),
        embedding_model=os.environ.get("EMBEDDING_MODEL", "BAAI/bge-large-en-v1.5"),
        top_k_results=int(os.environ.get("TOP_K", "5")),
        min_score=float(os.environ.get("MIN_SCORE", "0.3")),
        max_history_messages=int(os.environ.get("MAX_HISTORY", "6")),
        show_footer=os.environ.get("SHOW_FOOTER", "1") != "0",
        temperature=float(os.environ.get("TEMPERATURE", "0.0")),
    )
    return bot.create_gradio_interface()


# Spaces imports this module; a module-level `demo` is the conventional handle.
demo = build()

if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860)