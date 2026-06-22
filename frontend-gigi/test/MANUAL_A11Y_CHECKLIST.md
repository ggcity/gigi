# Gigi shell — manual accessibility checklist (Phase 3)

The chat module is conformant in isolation (Phase 2, its own gate). This checklist covers
the **shell surface** the shell adds: tiles, the morph, narration wiring, and focus order
(V3.md §2.8). Automated axe scans (`test/a11y/axe.spec.js`) catch only a fraction — run
this human pass before treating Phase 3 as done. Record AT + browser + OS and per-item
pass/fail.

Tester: ________   AT / browser / OS: ________   Date: ________

## Keyboard only (no mouse)
- [ ] Type a question, submit with Enter; the answer streams in without focus moving.
- [ ] Tab reaches: chat input → Send → (after an answer) each citation link → each tile's
      **Open ↗** and **Close** controls, in a logical order.
- [ ] Activate a citation with Enter and with Space; the tile opens/focuses (does not navigate away).
- [ ] Open a tile, then Tab into and operate the tile header controls.
- [ ] Close a tile with Enter/Space; focus lands on a sensible anchor (the tile region heading,
      or the chat input when the last tile closes) — never lost to the page top.
- [ ] No focus trap anywhere; visible focus indicator on every control.

## Screen reader
- [ ] On a new answer, the completed answer is announced **once** (not per token).
- [ ] Narration ("Looking this up…") is announced as a separate status, not mixed into the answer.
- [ ] Tile open/close is announced (e.g. "1 city page opened", "Closed a page").
- [ ] Each tile iframe is reachable and announced with its descriptive `title` ("… — opened by Gigi").
- [ ] The highlight cue ("quote shown") is perceivable without relying on color.
- [ ] not-found: the redirect contact name, link, and phone number read with descriptive text.

## Visual / motion
- [ ] With `prefers-reduced-motion: reduce`, the centered→side morph and tile transitions are
      instant (no animation); the layout still changes correctly.
- [ ] AA contrast on all shell text/controls in light **and** dark; nothing relies on color alone.
- [ ] 200% browser zoom: usable, no clipping.
- [ ] 320px-wide reflow: collapses to the chat-only column (tiles hidden), no horizontal page scroll.
- [ ] A custom palette (override `--gigi-shell-*`, e.g. the demo's "Ocean") keeps AA contrast.

## Notes
_(record failures + follow-ups here)_
