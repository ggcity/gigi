# Phase 3 — Gigi App Shell (Implementation Plan)

## Context

Phase 1 shipped the V3 backend (`backend/`): a FastAPI `/ws` WebSocket that streams a grounded
prose answer token-by-token with inline `[title](url)` citations, then runs an **async, post-answer**
highlight pass emitting `highlight {url, quote}` events (V3.md §2.3, `v3/PHASE1.md`). Phase 2
shipped `chat-module/` (`@ggcity/gigi-chat`, `v3/PHASE2.md`): a standalone, WCAG-2.1-AA Lit chat
component with a transport-agnostic imperative API. Crucially, the chat module **already parses
citations** — it emits `gigi-citation-detected {url, text}` the first time each complete link
finalizes mid-stream, and `gigi-answer-complete {answer, citations}` with the full pre-parsed set.

Phase 3 builds the **Gigi app shell** (V3.md §2.1, §5–§6): a Lit application that owns the
WebSocket to the backend, **embeds `<gigi-chat>` and drives it imperatively**, opens cited city
pages as **tiled iframes**, performs the **centered→side morph**, and routes `highlight` events to
the matching tile. This is the integration phase — backend (Phase 1) + chat module (Phase 2) +
tiles + theming — and the first build that is exercised in a browser on localhost.

Why the shell, and not the chat module, owns transport and tiles: the chat module is deliberately
reusable and knows nothing about WebSockets, tiles, or business logic (V3.md §5). The shell is the
Gigi-specific glue. It does **not** re-implement markdown/citation parsing — it consumes the chat
module's citation events (scope decision 2).

**Scope decisions for this phase (locked):**
1. **JavaScript, not TypeScript.** Lit in plain JS, **Vite** build + dev server, **npm**. New
   top-level package **`frontend-gigi/`** (V3.md §6), in-repo and private, depending on
   `@ggcity/gigi-chat` via `file:../chat-module`. Same toolchain and conventions as `chat-module/`.
2. **The shell never re-parses the answer markdown.** Tiles are opened from the chat module's
   `gigi-citation-detected` (during stream) and reconciled on `gigi-answer-complete`. One source of
   link-parsing truth, owned by the module.
3. **Morph via Motion One** (`motion`, ~5kb). Authored with `animate()`/spring easing, fully gated
   behind `prefers-reduced-motion` (reduced → end state applied instantly, no animation).
4. **Highlight: the shell side is fully built now; the in-page companion is Phase 4.** The shell
   does the origin-checked `postMessage` of the verified quote to the tile. A minimal companion
   **stub** ships only inside the test/demo **fixture city page**, so the highlight path runs
   end-to-end locally. The real Drupal-injected companion (reveal Bootstrap tabs, fuzzy match,
   Custom Highlight API) remains Phase 4.
5. **Desktop shell only.** Tiles are a desktop affordance. A narrow viewport degrades to a
   chat-only single column (full mobile `#gigi=` deep-links are Phase 5, V3.md §2.9).

---

## Backend contract this shell maps onto (verified against Phase 1)

Every outbound event also carries `interaction_id` (`backend/orchestrator.py`). Event order per
turn: `session` → `narration`* → `answer_token`* → `answer_done` → `highlight`* (async, after
`answer_done`, zero or more, no guaranteed order).

| Backend event | Shape | Shell routing |
|---|---|---|
| `session` | `{session_id}` | persist; echo on every subsequent `query` |
| `narration` | `{text}` e.g. "Looking this up on the city website…" | `chat.setNarration(text)` |
| `answer_token` | `{text}` — **raw, splittable markdown** | first of a turn → `chat.beginAssistantMessage()`, then `chat.appendAssistantToken(text)` |
| `answer_done` | `{answer}` — authoritative full markdown | `chat.endAssistantMessage(answer)` |
| `highlight` | `{url, quote}` — async, post-answer | match an open tile by **defragged** url → origin-checked `postMessage` of `quote` |
| `not_found` | `{text, redirect_to_human:{label,url,phone}}` — **also** throttle/oversized rejects | `chat.showNotFound(text, redirect_to_human)` |
| `error` | `{text}` | `chat.showError(text)` |

Inbound (shell→backend): `{type:"query", text, session_id?}`; and (Phase 4, scaffolded now)
`{type:"tile_result", …}` for a companion DOM-miss report. Load-bearing facts (verified):
`answer_token` is raw stream markdown that can split a `[title](url)` link across chunks — but the
**chat module** absorbs that hazard (whole-buffer re-parse), so the shell only forwards tokens.
The backend defrags cited URLs (`urldefrag`) and only emits `highlight` for URLs whose host is in
`ALLOWED_FETCH_HOSTS` **and** in the retrieved source set (SSRF + relevance guard, server-side).
`HUMAN_REDIRECT` is `{label:"Contact the City of Garden Grove", url:"https://www.ggcity.org/contact",
phone:"(714) 741-5000"}`.

The shell adds a **client-side iframe guard** as defense-in-depth: it only frames `https:` (and
`http:` for localhost fixtures) URLs whose host is in an `ALLOWED_TILE_HOSTS` allow-list (default
`ggcity.org`); anything else renders as a plain link, never an iframe.

---

## Target layout (after Phase 3)

```
frontend-gigi/
  package.json          # name "@ggcity/gigi-shell", private, type:module; deps: lit, motion,
                        #   "@ggcity/gigi-chat": "file:../chat-module"; dev: vite, @playwright/test,
                        #   @axe-core/playwright, axe-core
  vite.config.js        # dev server + proxy { '/ws': { target:'ws://localhost:8000', ws:true } };
                        #   resolve alias '@ggcity/gigi-chat' → ../chat-module/src/index.js (dev, no prebuild);
                        #   app build → dist/
  playwright.config.js  # projects chromium/firefox/webkit; baseURL :5274; webServer = vite dev --port 5274
  jsconfig.json         # JS + JSDoc
  index.html            # app entry: <gigi-app>, <script type=module src=/src/main.js>
  src/
    main.js             # import '@ggcity/gigi-chat'; import './gigi-app.js'; (registration side-effects)
    gigi-app.js         # <gigi-app> shell element (see Component architecture)
    ws-client.js        # GigiSocket: connect, session persistence, send, parse, backoff reconnect (no DOM)
    tiles.js            # <gigi-tiles>: iframe grid, lifecycle, announce, highlight postMessage, fallback link
    morph.js            # Motion One morph centered↔side; prefers-reduced-motion = instant
    theme.js            # token layer + light/dark/[data-theme]; maps --gigi-shell-* → --gigi-chat-*
    styles.js           # css`` shell styles, token defaults, ::part / exportparts hooks
  demo/
    index.html          # offline demo harness (no backend): scenario picker, theme toggle, event log
    mock-ws.js          # in-page mock feeding fixtures through GigiSocket's parse path
    fixtures/events.js  # scripted backend event sequences (shared with Playwright)
    city-page.html      # fixture city page: Bootstrap tab + known text + COMPANION STUB (ACK + highlight)
  test/
    unit/*.spec.js      # GigiSocket parsing + session reuse; tile lifecycle decision; defrag/host guard
    e2e/*.spec.js       # Playwright via routeWebSocket replaying fixtures (see Testing)
    a11y/axe.spec.js    # @axe-core/playwright per shell state
    e2e/helpers.js      # gotoApp(), feed(events), tiles(page), focus helpers
    MANUAL_A11Y_CHECKLIST.md
  dist/                 # built bundle (gitignored)
```

Dependencies: runtime `lit` (deduped with the chat module's copy), `motion`, `@ggcity/gigi-chat`;
dev `vite`, `@playwright/test`, `@axe-core/playwright`, `axe-core`. Lock versions in a committed
`package-lock.json` once they install cleanly (mirrors `chat-module/` and CLAUDE.md's freeze rule).
`.gitignore` adds `frontend-gigi/dist/`.

One backend change (the only Python edit): `backend/app.py` mounts
`StaticFiles(directory=<frontend-gigi/dist>, html=True)` at `/` **only when that directory exists**,
registered after `/ws` and `/healthz`, so production (and Mode B below) serves the bundle and the
API from one origin. When `dist/` is absent the backend behaves exactly as in Phase 1 (the existing
`tests/` stay green).

---

## Component architecture

- **`<gigi-app>`** — one Lit custom element, shadow DOM (encapsulation consistent with the chat
  module; theming via inheriting custom properties + a few `::part`s). It holds a `GigiSocket`
  instance and renders `<gigi-chat>` + `<gigi-tiles>` in a layout container whose state is
  `centered` or `side`. Responsibilities:
  - **Submit.** On `gigi-submit {text}` from the chat module (which has already optimistically
    appended the user bubble), the shell shows a **holding state immediately** —
    `chat.setNarration("Looking this up…")`, no model call yet (V3.md §2.3 step 1) — and calls
    `socket.query(text)`. It marks `tilesReplacedThisTurn = false`.
  - **Backend routing** per the contract table.
  - **Tile lifecycle.** On the **first** `gigi-citation-detected` of a turn, clear the previous
    turn's tiles and open this one's; subsequent detects append, capped at `maxTiles` (default 4).
    On `gigi-answer-complete`: if `citations.length === 0`, **leave the existing tiles in place**
    (a reply that cites nothing keeps the prior context — V3.md §2.6); otherwise the detected set
    is already correct. The morph fires when tile count crosses 0↔>0.
  - **Highlight.** On `highlight {url, quote}`, delegate to `<gigi-tiles>.highlight(url, quote)`.
  - **Session controls.** On `gigi-new-session`, `socket.resetSession()` + clear tiles + morph to
    centered. On `gigi-citation-click {url}`, open or focus that tile.
- **`GigiSocket`** (`ws-client.js`, **no DOM** — unit-testable in isolation). URL is **relative**:
  `new URL(location.href); proto = wss|ws; path = '/ws'` — so the Vite dev proxy (Mode A) and the
  backend-served bundle (Mode B) both work with zero config. It parses each JSON frame, captures
  `session_id` from the `session` event and replays it on every `query`, and exposes typed
  callbacks (`onSession/onNarration/onToken/onDone/onHighlight/onNotFound/onError/onClose`).
  Between turns it reconnects with exponential backoff; a **mid-turn** disconnect surfaces via
  `chat.showError(...)` and ends the turn cleanly (no partial-answer limbo).
- **`<gigi-tiles>`** (Lit). CSS grid with `gap`, rounded wrappers, capped count. Each tile:
  `<iframe title="<page title> — opened by Gigi" src=<guarded url>>` + a visible caption + an
  **"Open in new tab" fallback link** revealed on iframe `error`/`load`-timeout (covers a page that
  refuses framing — e.g. before Phase 0 headers land). `highlight(url, quote)`: find the tile whose
  **defragged** src matches, then `iframe.contentWindow.postMessage({type:'gigi-highlight', quote},
  tileOrigin)` with `tileOrigin` computed from the tile URL (never `'*'`). Open/close is announced
  via an internal `aria-live="polite"` region. Keyboard: each tile is reachable in tab order and
  has a focusable close control; closing a tile returns focus to a **stable anchor** (the tile
  region heading), never the page top, and never yanks focus on open (V3.md §2.8).
- **`morph.js`** — `applyLayout(state, {animate})`. With motion allowed, Motion One `animate()`
  slides the chat pane from center to the left column and fades/scales the tile grid in (spring,
  `--gigi-shell-morph-ms`); with `prefers-reduced-motion: reduce` it sets the final layout class
  synchronously. The page itself never scrolls or jumps — only internal regions scroll.

### Tile lifecycle & iframe communication (the technical core)

Two-channel intent to the (future) companion follows V3.md §2.2; Phase 3 implements the
**desktop postMessage** channel and scaffolds the hash channel for Phase 5:
- **postMessage.** The shell posts `{type:'gigi-highlight', quote}` to the tile iframe with an
  explicit target origin derived from the tile URL; the companion validates `event.origin` against
  the Gigi origin before acting. In Phase 3 the only listener is the **fixture-page stub**.
- **`tile_result` inbound.** The companion's "I couldn't find the quote" report is plumbed from
  iframe → shell (origin-checked) → `socket.sendTileResult(...)`; the backend already accepts and
  logs it. Phase 3 wires the path and exercises it via the stub; Phase 4 fills in real miss logic.

Multi-turn rule restated for clarity: **a new cited answer replaces the tiles; an answer with no
citations leaves them.** This is the shell's responsibility (there is no `open_tiles` backend
event — V3.md §2.6).

---

## Theming & customization (matches the shell, and is customizable)

A single token layer (`theme.js` + `styles.js`) is the source of truth. The shell exposes
`--gigi-shell-*` custom properties with an AA-clean **light default** and a **dark** palette via
`@media (prefers-color-scheme: dark)`, plus a `data-theme="light|dark"` override on the host and
`color-scheme` set so native UI matches — the **same theming model as the chat module** (PHASE2.md).
Tokens: `--gigi-shell-bg`, `--gigi-shell-surface`, `--gigi-shell-fg`, `--gigi-shell-accent`,
`--gigi-shell-on-accent`, `--gigi-shell-border`, `--gigi-shell-radius`, `--gigi-shell-gap`,
`--gigi-shell-font`, `--gigi-shell-max-width`, `--gigi-shell-tile-min-height`,
`--gigi-shell-morph-ms`. Base palette reuses the established city blue (`#0b5cab` light /
`#4c8dff` dark) so it matches the chat module out of the box.

Because custom properties inherit through shadow boundaries, the shell **derives the embedded chat
module's appearance from its own tokens** — one knob re-skins both:

```css
gigi-chat {
  --gigi-chat-bg:     var(--gigi-shell-surface);
  --gigi-chat-fg:     var(--gigi-shell-fg);
  --gigi-chat-accent: var(--gigi-shell-accent);
  --gigi-chat-font:   var(--gigi-shell-font);
  --gigi-chat-radius: var(--gigi-shell-radius);
  /* …one mapping per public chat token… */
}
```

Three documented customization paths: (1) override any `--gigi-shell-*` on `:root` or the
`<gigi-app>` host; (2) set `data-theme`; (3) structural styling via exported parts
(`::part(chat-pane)`, `::part(tile-grid)`, `::part(tile)`, `::part(status)`), with `exportparts`
forwarding the chat module's own parts where useful. No hardcoded colors live in component bodies.

---

## Accessibility model (WCAG 2.1 AA — shell surface; V3.md §2.8)

The chat module is already conformant in isolation (Phase 2). The shell adds:
- **Frame title** on every tile iframe (descriptive, names the page).
- **Focus order that keeps the user in control:** opening a tile never steals focus from the chat
  input; closing a tile returns focus to a stable anchor, not the page top; no focus trap.
- **Full keyboard operation of tiles:** reach each tile and its close control by keyboard, with
  visible focus indicators and logical order.
- **Highlight signalled by more than color** with adequate contrast (the companion's visual
  treatment, mirrored in the stub).
- **`prefers-reduced-motion` gates the morph and tile animations** (reduced → instant layout).
- **Announced tile open/close** via a polite live region; only internal regions scroll, never the
  page; 200% zoom and 320px reflow without horizontal scroll.

---

## Local run (the deliverable — runnable on localhost; Phase 0 assumed)

**Mode A — dev (fast iteration against the real backend).**
```bash
# terminal 1 — backend (Phase 1)
export ANTHROPIC_API_KEY=sk-ant-…        # ./chroma_db must be present
uvicorn backend.app:app --port 8000
# terminal 2 — shell
cd frontend-gigi && npm install && npm run dev   # http://localhost:5173
```
Vite proxies `/ws` → `ws://localhost:8000/ws` (`ws:true`), so the browser sees one origin — no
CORS, mirroring the production reverse proxy. Ask a real question → the answer streams into
`<gigi-chat>`, tiles open for cited pages, the layout morphs to side.

**Mode B — prod-like (single origin; the acceptance path).**
```bash
cd frontend-gigi && npm run build         # → frontend-gigi/dist
uvicorn backend.app:app --port 8000       # now serves the bundle via StaticFiles
# open http://localhost:8000  (same-origin /ws)
```

**Mode C — offline demo / e2e (no backend, no API key).** `demo/` drives the shell from
`demo/fixtures/events.js` through `demo/mock-ws.js`; the fixture city page (`demo/city-page.html`)
hosts the companion stub, so the **highlight path is visible locally** without Phase 4.

Caveat (documented, not blocking): framing the **real** ggcity.org in a tile requires the Phase 0
`frame-ancestors` headers; without them a tile shows its "Open in new tab" fallback. The bundled
fixture city page is same-origin and always frames + highlights, so local verification never
depends on Phase 0 being live.

---

## Testing & acceptance (V3.md §7)

Principle (V3.md §7): mock the backend at its boundary; prioritize e2e over unit. Drive the shell
with Playwright `routeWebSocket` replaying `demo/fixtures/events.js` — deterministic, no Anthropic/
Chroma/live fetch. The fixture city page is served same-origin by the harness so the iframe +
postMessage + highlight path runs for real against the stub companion.

**Playwright e2e (`test/e2e/`, projects chromium/firefox/webkit):**
- **Happy path:** narration shows → answer streams into `<gigi-chat>` → a tile opens from
  `gigi-citation-detected` → `highlight` arrives → shell posts the quote → stub companion ACKs and
  highlights; layout morphed to side.
- **Multi-link:** several citations → tiles open and are **capped** at `maxTiles`.
- **Multi-turn lifecycle:** a new cited answer **replaces** the tiles; a follow-up answer with no
  citations **keeps** them.
- **Not-found:** `not_found` renders the redirect block; **no tiles**, layout stays centered.
- **Error:** mid-turn `error` renders and clears busy; no partial tiles.
- **Reconnect:** a mid-turn socket drop surfaces an error and the next turn reconnects.
- **Keyboard:** open and close a tile by keyboard; focus returns correctly; opening a tile does not
  steal focus from the input.
- **Morph:** side-state applied on tiles-open (and the offline-demo path: mock WS → tile →
  stub highlight). The reduced-motion "instant morph" behavior is on the manual checklist
  (Playwright's media emulation did not reliably drive the in-component `matchMedia` here).

**Accessibility (`test/a11y/axe.spec.js`):** `@axe-core/playwright` asserts **zero violations** at
`wcag2a/wcag2aa/wcag21a/wcag21aa` in **every shell state** — centered-idle, streaming, tiled,
not-found, and dark — not just first render. Plus assertions that each iframe has a `title` and the
highlight signal is not color-only.

**Unit (`test/unit/`) — only the gnarly pure logic:** `GigiSocket` event parsing + `session_id`
capture/reuse across turns; the tile-lifecycle decision (replace on a cited turn / keep on a
no-citation turn / cap enforcement); URL defrag + `ALLOWED_TILE_HOSTS` guard.

**Manual a11y checklist (`test/MANUAL_A11Y_CHECKLIST.md`) — the human gate:** keyboard-only full
turn including tile open/close; screen-reader pass (NVDA + VoiceOver) for tile announcements, frame
titles, focus order, narration; reduced-motion morph; 200% zoom and 320px reflow.

**Acceptance:** `npm install && npm run build` succeeds; `npm test` green (e2e + axe + unit) across
the three engines; a Mode B live run answers a real city question with streaming + tiles + morph +
(fixture) highlight, and the not-found/error paths render correctly; `pytest tests/` still green
(the StaticFiles mount must not disturb the existing `/ws` tests); manual checklist signed off.

---

## Risks / call-outs

- **Cross-origin framing depends on Phase 0.** Real ggcity.org tiles won't frame until the city
  sends `frame-ancestors` allowing the Gigi origin (V3.md §10). Mitigated: the load-error fallback
  link, and local verification via the same-origin fixture page.
- **Companion stub ≠ real companion.** The Phase 3 stub only ACKs + does a trivial highlight on the
  fixture page; Bootstrap-tab reveal, fuzzy matching, the Custom Highlight API, and miss reporting
  are Phase 4. The shell→iframe **contract** (origin-checked postMessage, `tile_result` plumbing)
  is built and tested now so Phase 4 drops in behind it.
- **Motion One dependency.** A new ~5kb runtime dep, accepted for nicer morph authoring; it is the
  only animation dep and is confined to `morph.js`, behind the reduced-motion gate.
- **Lit duplication.** The shell and the chat module must share one `lit` copy (Vite dedup / npm
  hoist) or custom elements double-register; the registration guard in the module
  (`customElements.get('gigi-chat')`) is the backstop.
- **First browser-facing surface in the repo.** Add `frontend-gigi/dist/` to `.gitignore`; keep the
  package in-repo/private.
- **AR 2.16 / PII.** Wiring the shell to the live backend re-opens the query path as an AR 2.16 PII
  surface (residents volunteer PII in free-text queries; the backend logs them — `interactions`,
  `model_calls`). The shell itself stores nothing, but **demo/test fixtures must use synthetic,
  non-PII text**. Per City policy, handling PII follows AR 2.16 (Cloud Computing Services Policy):
  https://internal.ggcity.org/policies. Retention/redaction is Phase 6.
