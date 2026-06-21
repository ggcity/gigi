"""Prompt text and tool schemas for the V3 backend.

- ``answer`` — the streamed prose system prompt (Gigi persona, ggcity.org-only,
  inline ``[title](url)`` citations). This is what the user sees, streamed
  token-by-token.
- ``highlight`` — the async post-answer span extractor: a forced tool the Haiku
  call must return, giving the verbatim page span to highlight for each cited
  claim.
"""
