# Manual Accessibility Checklist — `<gigi-chat>` (Phase 2 acceptance gate)

Automated axe (`test/a11y/axe.spec.js`) catches only a fraction of WCAG issues. This
manual pass is **mandatory** and, together with a clean axe run across Chromium/Firefox/WebKit,
**constitutes the Phase 2 acceptance gate** — completed in isolation (via the demo harness,
`npm run dev`) **before** the module is wired into the Gigi shell (Phase 3).

Target matrix (locked): **NVDA + Firefox (Windows)** and **VoiceOver + Safari (macOS/iOS)**.
Record AT/browser/OS versions and per-item pass/fail below for each release.

## How to run
1. `npm run dev`, open the demo, and use the scenario dropdown (`happyPathSplitLink`,
   `multiLink`, `notFound`, `throttle`, `errorMidTurn`, `followUp`, `rapidBurst`).
2. For verbose dev tracing, append `?gigichat-debug=verbose` to the demo URL.

## Keyboard-only (no mouse)
- [ ] Tab reaches: transcript (`role=log`), the input, the Send button — in a logical order.
- [ ] Type a question, press **Enter** to send (Shift+Enter inserts a newline, does not send).
- [ ] Tab to a citation link in an answer; activate with **Enter** and with **Space** — both
      fire the citation action and the page does **not** navigate.
- [ ] Tab to a Sources-list link (multiLink scenario); same activation behavior.
- [ ] Visible focus indicator on every interactive element; focus is never trapped and is
      never yanked away when a new message arrives.

## Screen reader
- [ ] The **completed answer is announced exactly once** — not per token, not twice. (Stream a
      long answer and confirm only the final text is read.)
- [ ] **Narration** ("Looking this up…", "Gigi is responding…") is announced as transient
      status, separately from the answer, without clobbering it.
- [ ] Each message's **sender is conveyed** ("You said:" / "Gigi said:") — not by color or
      bubble alignment alone.
- [ ] The **responding/disabled state** is announced when a turn starts; the input is not
      silently inert.
- [ ] In not-found, the message, the **phone number**, and the contact link are all read with
      descriptive text.
- [ ] **Shadow-DOM live regions are actually announced** by this AT. ⚠️ If any AT fails to
      announce `#live-answer` / `#live-narration` inside the shadow root, escalate to the
      light-DOM-projected live-region fallback (see gigi-chat.js note).

## Conversation controls (toolbar / copy / new session)
- [ ] With `show-toolbar`, Tab reaches **New chat** and **Copy conversation**; both activate via
      Enter and Space; visible focus on each.
- [ ] **New chat** clears the transcript and returns focus to the input (not lost on the removed
      toolbar button).
- [ ] Each answer's **Copy** button has an accessible name ("Copy response"); after activating,
      "Response copied." is announced (and "Conversation copied." for the toolbar action).
- [ ] Copied clipboard text is readable plain text; links read as `text (url)`.

## Avatars (when enabled)
- [ ] Avatars are **decorative**: the screen reader does NOT announce them; sender is still
      conveyed by the "You said:/Gigi said:" text.
- [ ] Layout holds with avatars shown at 200% zoom / 320px width.

## Narration position
- [ ] `narration-position="bottom"` moves the visible status line above the composer without
      changing announcement behavior (still announced once via the live region).

## Visual / low-vision
- [ ] All text and controls meet **AA contrast** (4.5:1 text, 3:1 large/UI).
- [ ] State (streaming vs complete vs error, sender) is **never signaled by color alone**.
- [ ] **200% zoom** and a **320px-wide** viewport reflow without horizontal scrolling or loss
      of content (WCAG 1.4.4 / 1.4.10). Long links/code wrap; `pre` scrolls within its own box.

## Motion
- [ ] With OS **reduced-motion** on: no typing-caret animation, autoscroll jumps (no smooth
      scroll).
- [ ] With reduced-motion off: caret animates and autoscroll is smooth.

## Sign-off record
| Date | AT / Browser / OS | Result | Notes |
|------|-------------------|--------|-------|
|      |                   |        |       |
