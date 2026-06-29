#!/usr/bin/env python3
"""
Post-stream gap-inspection prompt + tool schema.

After the answer has streamed, one Haiku call reads the completed answer against the
original question. Its only job: decide whether the answer refers to something
ACTIONABLE (a contact, phone number, email, address, fee, or hours) WITHOUT actually
providing the specific value. If so it returns one targeted retrieval query for that
gap via the ``report_gap`` tool; otherwise it returns an empty ``gap_query``.

The decomposed queries from the retrieval step are passed in so the model can decline
a gap that was already searched (a coverage guard; the orchestrator also enforces a
hard novelty check on the retrieved chunks).
"""

from typing import List

GAP_TOOL = {
    "name": "report_gap",
    "description": (
        "Report whether the answer points at an actionable detail it did not "
        "actually provide, and if so the query that would retrieve it."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "gap_query": {
                "type": "string",
                "description": (
                    "A single targeted search query for the missing actionable "
                    "detail, or an EMPTY string if there is no such gap."
                ),
            }
        },
        "required": ["gap_query"],
    },
}

TOOL_NAME = GAP_TOOL["name"]

SYSTEM_PROMPT = (
    "You inspect an answer that was just given to a resident of Garden Grove and "
    "decide whether it refers to something ACTIONABLE — a contact, phone number, "
    "email, address, fee/cost, or hours — WITHOUT stating the specific value.\n"
    "If it does (e.g. it says 'call the Water Division' but gives no number, or "
    "'there is a fee' but no amount), call report_gap with a single targeted search "
    "query that would retrieve that specific detail from the city website.\n"
    "Otherwise call report_gap with an EMPTY gap_query — when the answer is already "
    "complete, only declines or redirects, or the missing detail was already among "
    "the queries that were searched.\n"
    "Output exactly one tool call. Do not invent a gap; most complete answers have none."
)


def user_prompt(question: str, answer: str, prior_queries: List[str]) -> str:
    pq = "\n".join(f"- {q}" for q in prior_queries) or "- (none)"
    return (
        f"RESIDENT'S QUESTION:\n{question}\n\n"
        f"ANSWER GIVEN:\n{answer}\n\n"
        f"QUERIES ALREADY SEARCHED (do not repeat these):\n{pq}\n\n"
        "Is there an actionable detail referenced but not provided? Return the "
        "targeted query, or an empty gap_query if none."
    )
