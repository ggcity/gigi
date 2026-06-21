#!/usr/bin/env python3
"""
Highlight-extraction prompt + tool schema (default mode).

When the verification gate is OFF (the default), the Sonnet draft is trusted and
Haiku is asked only to find, for each cited claim, the exact verbatim span on the
page that best supports it -- so the shell can highlight it. There is no pass/fail
judgement here: a claim with no relevant span simply gets no highlight; the answer
ships regardless.

Claims that cite the same page are batched into one call (page text sent once),
mirroring ``prompts/verify.py``. The span must be ONE contiguous run of page text
(no stitching / ellipsis / paraphrase), so it snaps to a true substring.
"""

HIGHLIGHT_TOOL = {
    "name": "report_highlights",
    "description": "For each claim, return the exact page span that best supports it (for highlighting).",
    "input_schema": {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "description": "Exactly one entry per claim id provided, in any order.",
                "items": {
                    "type": "object",
                    "properties": {
                        "claim_id": {
                            "type": "string",
                            "description": "The id of the claim (e.g. 's1').",
                        },
                        "quote": {
                            "type": "string",
                            "description": (
                                "ONE exact contiguous verbatim span copied from the page text "
                                "that best supports this claim, for highlighting. Empty string "
                                "if nothing on the page is relevant."
                            ),
                        },
                    },
                    "required": ["claim_id", "quote"],
                },
            }
        },
        "required": ["results"],
    },
}

TOOL_NAME = HIGHLIGHT_TOOL["name"]

SYSTEM_PROMPT = (
    "You locate the exact text on a web page that should be highlighted for each "
    "of several claims. For EACH claim, find the single span of the page text that "
    "best supports or illustrates it, and copy it EXACTLY as it appears: ONE single, "
    "contiguous, uninterrupted run of text. Do NOT stitch together separate parts, "
    "do NOT skip over text, do NOT use ellipses, do NOT join non-adjacent sentences, "
    "and do NOT paraphrase or fix typos. If nothing on the page is relevant to a "
    "claim, return an empty quote for it. Respond ONLY by calling the "
    "report_highlights tool, with exactly one result per claim id you were given."
)


def user_prompt(claims, page_text: str) -> str:
    """``claims`` is a list of {"id", "text"} dicts that all cite this page."""
    lines = "\n".join(f"[{c['id']}] {c['text']}" for c in claims)
    return (
        f"CLAIMS (find a highlight span for each):\n{lines}\n\n"
        f"PAGE TEXT:\n{page_text}\n\n"
        "For each claim id above, return the single contiguous span of page text "
        "that best supports it, or an empty quote if none."
    )
