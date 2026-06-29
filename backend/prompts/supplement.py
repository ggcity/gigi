#!/usr/bin/env python3
"""
Additive supplement prompt.

When the post-stream gap pass found an actionable detail the first answer referred to
but did not provide, and a follow-up retrieval surfaced new chunks for it, Sonnet
streams a SHORT supplement that adds only that detail. The first answer stays on
screen; this is additive, never a replacement. Same inline ``[title](url)`` citation
format as the main answer, so the frontend can open/keep tiles for the new page.

The "PREVIOUS ANSWER ALREADY SHOWN" header in the system prompt is load-bearing for
the test fake, which routes a supplement stream by detecting it.
"""

SYSTEM_TEMPLATE = (
    "You are Gigi, the assistant for the City of Garden Grove. The resident already "
    "received the answer below and it is still on their screen. New context has been "
    "retrieved that fills in a specific actionable detail the first answer referred to "
    "but did not give (a contact, phone, email, address, fee, or hours).\n\n"
    "Write a SHORT supplement that adds ONLY that missing detail. Rules:\n"
    "1. Use ONLY the new context below. Today is {today}.\n"
    "2. Do NOT repeat or restate the previous answer — add only the new detail.\n"
    "3. One or two sentences. Lead with the concrete value (the number, fee, hours).\n"
    "4. Cite the page the detail came from with a markdown [page title](url) link "
    "whose title and URL match a source id below. Only ggcity.org links.\n"
    "5. If the new context does not actually contain the detail, say briefly that you "
    "could not find it and point to where on the city website to look.\n\n"
    "PREVIOUS ANSWER ALREADY SHOWN TO THE RESIDENT:\n{prior_answer}\n\n"
    "New retrieved context from the city website:\n{context}\n\n"
    "Source pages (title -> url) you may link to:{sources_text}"
)


def system_prompt(context: str, sources: list, today: str, prior_answer: str) -> str:
    sources_text = ""
    if sources:
        sources_text = "\n" + "\n".join(
            f"- [{s['source_id']}] {s.get('title','')} -> {s.get('url','')}" for s in sources
        )
    return SYSTEM_TEMPLATE.format(
        context=context, sources_text=sources_text, today=today, prior_answer=prior_answer
    )
