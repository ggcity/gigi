#!/usr/bin/env python3
"""
Query-decomposition prompt + tool schema (retrieval only).

Replaces the single follow-up rewrite. One Haiku call turns the resident's message
into 1-3 standalone search queries via the ``decompose_queries`` tool: the first is
the primary topic with references resolved, and a second/third is added ONLY for a
genuinely distinct sub-topic or a predictable entity-then-attribute gap (the agency
name on one page, its phone number on another). The orchestrator retrieves each in
parallel and merges. This is RETRIEVAL-ONLY — the answer model still gets the
original message plus history. Language-agnostic: references are resolved by the
model, not a word list.
"""

from typing import Dict, List

DECOMPOSE_TOOL = {
    "name": "decompose_queries",
    "description": (
        "Return the 1-3 search queries needed to retrieve the City of Garden Grove "
        "website pages that answer the resident's latest message."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "queries": {
                "type": "array",
                "description": "1 to 3 standalone search queries, most important first.",
                "items": {"type": "string"},
                "minItems": 1,
                "maxItems": 3,
            }
        },
        "required": ["queries"],
    },
}

TOOL_NAME = DECOMPOSE_TOOL["name"]

SYSTEM_PROMPT = (
    "You turn a resident's message to the City of Garden Grove website assistant "
    "into the search queries needed to retrieve the supporting pages. Respond ONLY "
    "by calling the decompose_queries tool with 1 to 3 standalone queries.\n"
    "- The FIRST query is the primary topic, with any references to earlier turns "
    "(pronouns, 'that', 'it', omitted subjects) resolved into explicit terms.\n"
    "- Add a SECOND or THIRD query ONLY when the message genuinely needs it: a "
    "distinct sub-topic (e.g. two unrelated services asked at once), or a "
    "predictable entity-then-attribute gap where a needed detail likely lives on a "
    "different page than the entity (e.g. a department's name in one place and its "
    "phone number in another).\n"
    "- Do NOT pad the list. Most messages need exactly one query. Never exceed 3.\n"
    "- Each query is plain search text: no quotes, no preamble, no markdown."
)


def user_prompt(message: str, history: List[Dict]) -> str:
    """Prior conversation (if any) plus the latest message. With no history the
    model still decomposes sub-topics; it just has nothing to resolve against."""
    if history:
        convo = "\n".join(f"{m['role']}: {m['content']}" for m in history)
        return (f"Conversation so far:\n{convo}\n\n"
                f"Latest message: {message}\n\nReturn the search queries.")
    return f"Message: {message}\n\nReturn the search queries."
