# Phase 2 — Standalone WCAG-First Chat Module (Implementation Plan)

## Context

Phase 1 shipped the V3 backend: a FastAPI WebSocket service that streams a grounded prose
answer token-by-token with inline `[title](url)` citations, then runs an async highlight pass
(V3.md §2.3, `v3/PHASE1.md`). It is exercised today only via `backend/cli.py` — there is **no
frontend at all** in the repo (no `package.json`, no JS/TS/HTML/CSS, no build tooling).

Phase 2 builds the first piece of the UI: a **standalone, reusable, WCAG-2.1-AA chat web
component in Lit** (V3.md §5). It renders the conversation and *nothing else* — it owns no
transport, no tiles, no business logic, so it is testable in isolation and reusable outside
Gigi. The Gigi shell (Phase 3) will drive it imperatively and listen for its events. Phase 2's
acceptance gate is real and independent of Gigi: **axe-clean in every state + a manual keyboard
and screen-reader pass**, before any wiring (V3.md §5, §2.8, §7).

Why a handrolled module and not a chat library: the WCAG 2.1 AA mandate (legally due for Garden
Grove **April 26, 2027**) puts most of the accessibility burden on the chat surface, and
library internals (focus, live-region announcements, control contrast) are hard to fix from
outside. Owning the semantics is the deliberate trade (V3.md §3).

**Scope decisions for this phase (locked):**
1. **JavaScript, not TypeScript.** Lit in plain JS (`static properties`, `static styles`,
   `customElements.define`; no decorators). The public API contract is JSDoc `@typedef`s; an
   optional `tsc --allowJs --emitDeclarationOnly` step can emit `.d.ts` for Phase 3.
2. **Vite** build + dev server; **npm**; the module lives in a top-level **`chat-module/`**
   package (V3.md §6), kept **in-repo and private** (consumed by relative path/workspace until
   a second consumer exists; `package.json` is publish-ready).
3. **Both citation surfaces**: mandatory inline-link click delegation + optional
   `renderCitations()` Sources list; the shell chooses.
4. **Test matrix: evergreen** (Chromium, Firefox, WebKit) via Playwright + axe-core; manual SR
   pass on NVDA + VoiceOver.

---

## Backend contract this module maps onto (verified against Phase 1)

The module never touches the WebSocket, but its API must map cleanly onto the events the shell
will relay (`backend/orchestrator.py`, `backend/answer.py`, `backend/app.py`):

| Backend event | Shape | Module method it drives |
|---|---|---|
| `session` | `{session_id}` | shell-only (not the module's concern) |
| `narration` | `{text}` e.g. "Looking this up on the city website…" | `setNarration(text)` |
| `answer_token` | `{text}` — **raw markdown fragment**, may split a `[title](url)` link across chunks | first one → `beginAssistantMessage()`, then `appendAssistantToken(text)` |
| `answer_done` | `{answer}` — full assembled markdown (canonical) | `endAssistantMessage(answer)` |
| `highlight` | `{url, quote}` async, post-answer | shell/tile-only (module never sees it) |
| `not_found` | `{text, redirect_to_human:{label,url,phone}}` — **also used for throttle/oversized rejects** | `showNotFound(text, redirect)` |
| `error` | `{text}` | `showError(text)` |

Load-bearing facts (verified): `answer_token` carries **raw, splittable markdown** straight from
the Anthropic stream (`backend/answer.py`); `answer_done.answer` is the authoritative full text;
there is **no citations event** — the shell parses links out of the prose itself. `HUMAN_REDIRECT`
is a constant `{label:"Contact the City of Garden Grove", url:"https://www.ggcity.org/contact",
phone:"(714) 741-5000"}`.

---

## Target layout (after Phase 2)

```
chat-module/
  package.json          # name "@ggcity/gigi-chat", private, type:module, exports → dist ESM
  vite.config.js        # library build (build.lib) + demo dev server
  playwright.config.js  # evergreen projects: chromium, firefox, webkit
  jsconfig.json         # JS + JSDoc; optional tsc step for .d.ts emit
  src/
    gigi-chat.js        # the custom element; calls customElements.define('gigi-chat', …)
    index.js            # public entry: side-effecting register + re-export typedefs
    types.js            # JSDoc @typedef: Citation, NotFoundRedirect, event details
    markdown.js         # whole-buffer markdown parse (marked) + DOMPurify sanitize + link extract
    live-region.js      # announce() helper; atomic answer region + polite narration region
    styles.js           # css`` templates; CSS custom props + ::part exports for theming
  demo/
    index.html          # demo harness page (loads <gigi-chat> + scenario runner)
    runner.js           # scenario player: replays an ordered event list into the public API
  test/
    fixtures/streams.js # canonical scripted event sequences (shared with demo)
    e2e/*.spec.js       # Playwright behavioral specs (driven through public API)
    a11y/*.spec.js      # @axe-core/playwright assertions per terminal state
    MANUAL_A11Y_CHECKLIST.md
.gitignore              # ADD: node_modules/, chat-module/dist/, test-results/,
                        #      playwright-report/, coverage/  (repo .gitignore is Python-only today)
```

Dependencies: runtime `lit`, `marked`, `dompurify`; dev `vite`, `@playwright/test`,
`@axe-core/playwright`, `axe-core`, (optional) `typescript` for `.d.ts` emit. Lock versions in a
committed `package-lock.json` once they install cleanly (mirrors CLAUDE.md's freeze-file rule).
**`marked` over `markdown-it`**: smaller, synchronous `marked.parse(str)` fits the whole-buffer
re-parse approach; the renderer is deliberately minimal anyway.

---

## Component architecture

- **One custom element, tag `<gigi-chat>`** (`class GigiChat extends LitElement`). Messages are
  internal `repeat()`-rendered rows, **not** separate custom elements — central coordination of
  the live regions and focus requires one element.
- **Shadow DOM** (default). Gives style/DOM encapsulation so the shell can't break internals and
  the module carries its own conformant focus rings/contrast/spacing — the point of "reusable in
  any app." Theming escape hatches: **CSS custom properties** (`--gigi-chat-bg`, `--gigi-chat-accent`,
  `--gigi-chat-font`, focus-ring color, …) and a few **`::part()`** exports (`message-list`,
  `input`, `send-button`). Watch item: shadow-DOM `aria-live` announcement is verified in the
  manual SR pass; light-DOM-projected live regions are the fallback if any AT fails to announce.
- **Light/dark/custom theming.** Ships an AA-clean light palette (default) and dark palette, and
  **follows the OS automatically** via `@media (prefers-color-scheme: dark)`. A host attribute
  forces a palette regardless of the OS: `data-theme="light"`, `data-theme="dark"`, or
  absent/`"system"` to follow the OS; `color-scheme` is set so native UI (caret, scrollbars,
  controls) matches. Every color is a `--gigi-chat-*` custom property, so a fully **custom theme**
  is just a bag of those properties — the demo's "Ocean" theme demonstrates this (palette + font +
  radius). Both dark palettes (OS-auto + forced) are covered by dedicated axe scans.
- **Reactive state** (`static properties` with `state:true` for internal fields):
  - `_messages: Message[]` — `{id, role:'user'|'assistant'|'system', markdownBuffer, status:'streaming'|'complete'|'notFound'|'error', citations?, redirect?}`
  - `_streamingId: string|null` — the in-flight assistant message (so tokens always hit the right row)
  - `_narration: string` — visible status line text
  - `_busy: boolean` — single source of truth for the announced disabled/turn state
  - non-reactive fields for the two live regions + a pending-announcement string + a `Set` of
    already-emitted citation URLs (dedup for `gigi-citation-detected`).

---

## The incremental-markdown-streaming problem (technical core)

Tokens are **raw markdown fragments** that can split a `[title](url)` link (or `**bold**`, a code
fence) across chunk boundaries. Strategy:

- **Re-parse the whole buffer per render, not incrementally.** On `appendAssistantToken(text)`,
  append to `markdownBuffer`, then re-parse the entire buffer with `marked` and re-sanitize with
  DOMPurify, rendering via Lit `unsafeHTML(sanitizedString)`. A partial `[City Hal` renders as
  literal text until `](url)` arrives, then snaps to a proper link on the next parse — correct and
  simple. Answers are short (`max_tokens=1000` in the backend); parse cost is a non-issue.
- **Coalesce renders on `requestAnimationFrame`** (don't re-parse synchronously per token in a
  burst). Bounds parse cost and smooths the visual stream. Any "typing"/caret motion and smooth
  autoscroll are **gated behind `prefers-reduced-motion`** (reduced → text updates + instant jump).
- **Authoritative final render**: `endAssistantMessage(fullText)` re-parses the canonical
  `answer_done.answer` (defends against a dropped/duplicated token) and fires the single
  announcement. Without an arg, it finalizes the accumulated buffer.
- **Sanitization (every render; model output is untrusted):** strict DOMPurify allow-list —
  `ALLOWED_TAGS: p, br, strong, em, ul, ol, li, a, code, pre, blockquote, h3, h4` (no `img`/`iframe`/
  `h1`/`h2`); `ALLOWED_ATTR: href` (no `target`, no `on*`); `ALLOWED_URI_REGEXP` permits
  `https:`/`mailto:`/`tel:` only (reject `javascript:`/`data:`). There is **no window** where
  unsanitized output reaches the DOM. Document at the `unsafeHTML` call site *why* it is safe
  (the string is DOMPurify-cleaned) so a future contributor doesn't "fix" it into a regression.

### Citation handling — links + observation hooks

The backend sends no citations event; links live in the prose and the shell opens tiles. The
module's jobs:

- **Inline link click delegation (mandatory).** Rendered `<a>` in an assistant message must
  **not navigate**. A single delegated listener on the message-list container intercepts left-click
  and Enter/Space, `preventDefault()`s, and dispatches `gigi-citation-click {url, text}`. `href`
  is kept for right-click/copy-link/discoverability; only activation is hijacked.
- **`renderCitations(items, onClick)` (optional Sources affordance).** A distinct accessible
  "Sources" list the shell can push (descriptive link text; load-bearing on mobile where there
  are no tiles, optional on desktop). Same `onClick({url,text})` contract as inline links — one
  shape for the shell to handle.
- **Observation hooks so the shell can open tiles without piercing shadow DOM** (all composed
  CustomEvents):
  - **`gigi-citation-detected {title, url}`** — emitted *during streaming* the first time a new
    complete link finalizes in the buffer (deduped by URL). Lets the shell open tiles **as links
    appear** (V3.md §2.3 step 4).
  - **`gigi-answer-complete {answer, citations:[{title,url}]}`** — on `endAssistantMessage`, the
    authoritative full text + pre-parsed citation set, so a consumer never re-implements link
    parsing.
  - **`gigi-citation-click {url, text}`** — user activated a citation (inline or Sources list).
  - **`gigi-submit {text}`** — user sent a message (named to avoid colliding with the native
    `submit` event; fulfills V3.md §5's "emits submit"). **`composed:true` is mandatory** on all
    of these or they never cross the shadow boundary to the shell.

  Note: the shell drives `appendAssistantToken`, so it already holds raw tokens — these hooks
  exist for *reusable, parse-free* consumption (detected/complete citations) and for click intent;
  a redundant per-token re-emit is intentionally omitted.

---

## Accessibility model (WCAG 2.1 AA, built in)

- **Two separate live regions inside the element:**
  1. **Answer region** — `aria-live="polite" aria-atomic="true"`, sr-only, **empty during
     streaming**. On `endAssistantMessage`, set once to the plain-text flattening of the full
     answer → the screen reader announces the finished answer **exactly once** (never per token —
     the explicit V3.md §5 rule).
  2. **Narration region** — a *separate* `aria-live="polite"` region for `setNarration` (e.g.
     "Looking this up…") that also updates a **visible status line**. Separation prevents a
     narration update and the answer announcement from clobbering each other.
- **Transcript semantics:** message list is `role="log" aria-label="Conversation"` but
  **`aria-live="off"`** on the list itself — additions are not auto-announced there; the dedicated
  atomic answer region is the sole announcement path (prevents double-announcement). Each row
  carries a visually-hidden sender label ("You said:" / "Gigi said:") — sender conveyed by text,
  not color/alignment (color is never the only signal).
- **Disabled/turn state:** input uses **`aria-disabled="true"` + a submit guard** (not native
  `disabled`) so the user never loses tab position mid-turn; the state change is **announced** via
  the narration region ("Gigi is responding…"). Re-enabled on
  `endAssistantMessage`/`showNotFound`/`showError`. (Native `disabled` vs `aria-disabled` is
  re-verified in the SR pass.)
- **Focus:** new messages **never steal focus** (V3.md §5). Focus stays in the input. A keyboard
  path to the latest message exists via the focusable/scrollable transcript region.
- **Motion & scroll:** typing indicator and autoscroll gated by `prefers-reduced-motion`; only the
  internal list scrolls, never the page.
- **Input:** programmatic label (default provided, overridable via an `input-label` attribute),
  keyboard submit (Enter), visible focus indicators, AA contrast on text and controls.

---

## Public API surface (JSDoc-typed)

`src/types.js` (`@typedef`s): `Citation {url:string, text:string}`,
`NotFoundRedirect {label:string, url:string, phone:string}`, event-detail typedefs.

`<gigi-chat>` methods:

```
appendUserMessage(text)              // render user bubble (does NOT fire gigi-submit)
beginAssistantMessage()              // open in-flight assistant msg; set busy + announce responding
appendAssistantToken(text)           // append raw-markdown chunk; coalesced re-parse+sanitize render
endAssistantMessage(fullText?)       // authoritative final render of answer_done.answer; announce once; clear busy; fire gigi-answer-complete
setNarration(text)                   // narration live region + visible status line
renderCitations(items, onClick)      // optional accessible Sources list; clicks → onClick + gigi-citation-click
showNotFound(text, redirect)         // honest not-found + human-redirect block; announce once; clear busy
showError(text)                      // non-fatal error; announce once; clear busy
reset()                              // silent programmatic clear of the conversation
newSession()                         // reset() + fire gigi-new-session; refocus the input
copyConversation()                   // copy whole transcript as plain text ("You:/Gigi:" blocks); → Promise<bool>
```

Events (composed CustomEvents): `gigi-submit {text}`, `gigi-citation-detected {title,url}`,
`gigi-answer-complete {answer, citations[]}`, `gigi-citation-click {url, text}`,
`gigi-new-session {}`, `gigi-copy {scope:'message'|'conversation', text}`.

**Attributes:** `input-label`, `debug`, `show-toolbar` (bool, default off — built-in New chat +
Copy conversation toolbar), `hide-message-copy` (bool — the per-message Copy button shows by
default), `narration-position` (`top` default | `bottom`, reflected).

**Conversation controls.** A per-assistant-message **Copy** button is in every answer bubble by
default (copies plain text, links flattened as `text (url)`). The optional **toolbar** (gated by
`show-toolbar`) holds **New chat** (→ `newSession()`) and **Copy conversation** (→
`copyConversation()`). Copy feedback is announced in a dedicated `aria-live` action region.
Clipboard uses the async API with a hidden-textarea fallback for insecure contexts.

**Avatars (per-role, CSS-only, off by default):** `--gigi-chat-avatar-display` (`none`→`block`),
`--gigi-chat-assistant-avatar` / `--gigi-chat-user-avatar` (`background-image`),
`--gigi-chat-avatar-size`. Decorative (`aria-hidden`); sender stays conveyed by the `sr-only`
role-tag. Exposed `::part`s: `toolbar`, `copy`, `row`, `row-<role>`, `avatar`, `avatar-<role>`.

On user send, the module **optimistically appends the user bubble itself** and fires `gigi-submit`;
the shell then calls only the assistant-side methods as backend events arrive. (Documented so
Phase 3 knows who calls what.)

**Phase-3 wiring map:** `narration`→`setNarration`; first `answer_token`→`beginAssistantMessage`
then `appendAssistantToken`; later `answer_token`→`appendAssistantToken`;
`answer_done`→`endAssistantMessage(answer)` (+ shell may call `renderCitations`);
`not_found`→`showNotFound`; `error`→`showError`; `session`/`highlight` are shell-only.

---

## Debug output (dev-only, compiled out of prod)

Robust diagnostics during development, **nothing** in the production bundle — enforced by the
build, not by discipline:

- **A single gated logger** `src/debug.js` exporting `debug(...args)` / `debug.group(...)` /
  `debug.warn(...)`, each wrapped in `if (import.meta.env.DEV)`. Vite statically replaces
  `import.meta.env.DEV` with `false` in `vite build`, so every guarded call and its arguments are
  **dead-code-eliminated** from the library bundle — zero runtime cost and no leaked strings in
  prod. (The dev server / demo harness set `DEV` true; the published bundle is `PROD`.)
- **What to log in dev** (the events that are painful to debug blind): each public-API call with
  its args (`appendAssistantToken` chunk, `endAssistantMessage` reconciliation), per-token
  coalesced-render timing, every parsed-vs-final markdown diff, each dispatched CustomEvent
  (`gigi-submit`/`gigi-citation-detected`/`gigi-answer-complete`/`gigi-citation-click`) with its
  detail, live-region announcement text + which region, focus/`_busy` transitions, and any
  DOMPurify removal (tag/attr stripped) so sanitizer surprises are visible.
- **Opt-in verbosity:** default dev logging is concise; a `?gigichat-debug=verbose` query param (or
  a `debug` boolean attribute on the element) raises it to per-token detail, so the demo harness
  isn't noisy by default but full traces are one flag away.
- **AR 2.16 boundary:** debug output goes to `console` only — never persisted, never transmitted,
  and absent from prod entirely, so it does not create a PII/telemetry surface. Dev logs will still
  contain whatever synthetic fixture text is driven through the API; **keep fixtures non-PII**
  (see risks). An e2e assertion confirms the prod build contains no `debug(` calls / known debug
  strings, guarding the strip.

---

## Testing & acceptance (this IS the gate — V3.md §5, §7)

**Demo / scripted-stream harness (`demo/`).** `demo/runner.js` is a scenario player: an ordered
`{delayMs, action}` list replayed into the public API with realistic inter-token delays.
`test/fixtures/streams.js` holds the scenarios as data, **shared between demo and Playwright**.
Scenarios (chosen to hit the hard parts): (1) happy path with an inline link **split across two
token chunks**; (2) multi-link answer → `renderCitations` list + clicks fire callback, nothing
navigates, `gigi-citation-detected`/`gigi-answer-complete` fire with correct payloads; (3)
`not_found` + redirect; (4) throttle/oversized (same `not_found` shape) copy; (5) mid-turn
`error` → busy cleared; (6) narration-then-answer (narration in its region + status line; answer
announced once in the *separate* region); (7) follow-up turn → no focus steal, list scrolls; (8)
reduced-motion variant; (9) rapid token burst → coalesced render drops/dups nothing, final
reconciliation equals `answer_done.answer`.

**Playwright + axe-core (`test/`).** Projects: **chromium, firefox, webkit**. `@axe-core/playwright`
asserts **zero violations at `wcag2a/wcag2aa/wcag21a/wcag21aa`** in **every terminal state** (idle,
mid-stream, completed, not-found, error) — not just initial render. All stimulus goes **through
the public API/events** (assertions may read shadow DOM). Behavioral asserts: `gigi-submit` fires
with correct detail and **crosses the shadow boundary** to a light-DOM listener (guards the
`composed:true` footgun); split-link renders as one anchor; link click prevented + event fired;
answer region empty mid-stream and populated once at end; input disabled-state during turn; focus
never moves on append.

**Manual a11y checklist (`test/MANUAL_A11Y_CHECKLIST.md`) — the human gate.** In isolation,
before any Gigi wiring: keyboard-only full turn (type, Enter, Tab to Send, Tab to a citation,
activate via Enter and Space — all reachable, visible focus, logical order, no trap/yank);
**screen-reader pass on NVDA (Win) + VoiceOver (mac/iOS)** — completed answer announced **exactly
once**, narration as separate process status, sender conveyed non-visually, responding/disabled
state announced, not-found phone/link readable with descriptive text; **shadow-DOM live-region
announcement explicitly verified** (escalate to light-DOM fallback if any AT fails); reduced-motion
honored; AA contrast + no color-only signals; 200% zoom and 320px reflow without horizontal scroll.
Record AT/browser + per-item pass/fail in the checklist file.

**Acceptance:** `npm run build` produces the library bundle; `npm test` (Playwright) green incl.
axe in all states across the three engines; the manual checklist signed off — **before Phase 3
wiring**.

---

## Risks / call-outs

- **Shadow-DOM live-region announcement** — biggest a11y risk; generally works in current AT but
  historically buggy. Verified in the manual gate; light-DOM-projected regions are the fallback.
- **Split-markdown links** — real (raw tokens from `backend/answer.py`); the whole-buffer re-parse
  handles it; the split-link fixture is a permanent regression test.
- **Double-announcement** (`role="log"` auto-announce vs the atomic region) — resolved by
  `aria-live="off"` on the transcript + one atomic answer region; verify in SR pass.
- **`unsafeHTML` + DOMPurify** — looks alarming in review; document the invariant at the call site
  (string is sanitized first). Removing either is a regression (broken render / XSS).
- **`composed:true`** — if missed, the shell silently never hears events; covered by an e2e test.
- **First JS in a Python repo** — add JS artifacts to the Python-only `.gitignore`; keep the module
  in-repo/private (publish later when a second consumer exists).
- **AR 2.16 / PII** — the module stores nothing and has no transport, so it is *outside* the AR 2.16
  surface. Keep it telemetry-free; **demo/test fixtures must use synthetic, non-PII text** (no real
  resident queries). When this is wired to the live backend in Phase 3 the query path becomes an
  AR 2.16 PII surface again. Per City policy, handling PII follows AR 2.16 (Cloud Computing Services
  Policy): https://internal.ggcity.org/policies.
