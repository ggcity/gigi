# Phase 5 — Mobile (Implementation Plan)

## Context

Gigi V3 is a FastAPI + Lit web-component stack (V3.md). Phases 1–4 shipped the backend (`backend/`),
the standalone WCAG-first chat module (`chat-module/`), the desktop app shell with tiled iframes and the
centered→side morph (`frontend-gigi/`, `v3/PHASE3.md`), and the real in-page companion
(`frontend-gigi/src/companion/`, `v3/PHASE4.md`). Mobile was *touched* in Phase 3 (scope decision 5:
"a narrow viewport degrades to a chat-only single column") but was never made first-class.

V3.md §2.9 defines the mobile model: **chatbot only, no iframes, no tiles**; citations become links that
open the city page with a `#gigi=` hash carrying the verified quote, and the companion highlights on the
destination page. Phase 5 makes that real and adds a **simple, installable PWA** layer — responsive and
touch-friendly. **No service worker / offline** is in scope (explicit decision; see Risks).

### What already exists (verified in code — do not rebuild)

- `frontend-gigi/index.html` has `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- The shell degrades to chat-only at **≤900px**: `MOBILE_BP = 900` (`gigi-app.js:13`) mirrors the
  `@media (max-width: 900px)` block in `styles.js` (tiles pane `display:none`, chat full-width, dock
  morph skipped — `gigi-app.js:188-200`). Covered by `test/e2e/tiling.spec.js` "#2 mobile viewport".
- Reduced-motion is gated throughout (`morph.js:prefersReducedMotion`, `styles.js`).
- The companion **already consumes the `#gigi=` hash channel** ("Channel 2", `src/companion/companion.js`
  ~L464): it reads `location.hash`, decodes the quote, highlights, then strips the fragment with
  `history.replaceState` (V3.md §2.2). Already tested by `test/e2e/highlight.spec.js` (hash scenario).
  **This is the mobile-destination half — Phase 4 built it; Phase 5 only needs to produce the links.**
- Every citation tap — inline prose link **and** the Sources list — is intercepted by the chat module
  (`gigi-chat.js:_onLogClick` → `preventDefault` → dispatch `gigi-citation-click {url, text}`). So the
  shell's `_onCitationClick` (`gigi-app.js:166`) is the **single chokepoint** for all citation activations.
- Verified, snapped quotes already reach the shell as `highlight {url, quote, final_url}` events
  (`backend/highlight.py:snap` → `ws-client.js` → `onHighlight`).

### The two real gaps

1. **No mobile deep-link mechanic.** On mobile the tile pane is `display:none`, yet `_onCitationClick`
   still calls `this._tilesEl.focusOrOpen(...)` — it opens an *invisible* tile, so tapping a source does
   nothing useful. We need to turn taps into `url#gigi=<quote>` links (V3.md §2.9).
2. **No PWA layer.** No web manifest, `theme-color`, app/apple-touch icons, or favicon.

### Confirmed decisions

- **Mobile citation taps open in a new tab** (`window.open(_blank)`). With no service-worker persistence,
  same-tab navigation would reload a fresh Gigi and lose the conversation; a new tab keeps it alive.
- **App icons are derived from the existing hero speech-bubble logo** (`gigi-app.js:_hero()` SVG) on a
  city-blue field — no new brand assets required.

### Deliberate deviation from V3.md §2.9 (the `#gigi=` link is built client-side)

V3.md §2.9 says "the backend builds" the `#gigi=` links. In the shipped streaming architecture that is not
possible: verified quotes are produced by the **async, post-answer** highlight pass (`backend/highlight.py`),
while citations are inline `[title](url)` prose links streamed **before** any quote exists — so the backend
cannot embed the quote into the streamed answer. The shell already receives `highlight {url, quote}` events,
so reusing them needs **zero backend change** (mirroring Phase 4, which also required no backend edit). The
link is therefore assembled in the shell at tap time.

> Working-tree note: `gigi-app.js` / `ws-client.js` currently carry uncommitted edits for an unrelated
> "supplement / gap pass" feature. Keep Phase 5 changes additive and clear of that logic.

---

## Scope decisions for this phase (locked)

1. **No backend change.** Deep links are built client-side from existing `highlight` events. `pytest tests/`
   stays untouched and green.
2. **No service worker, no offline, no Vite PWA plugin.** "Simple PWA" = installable + themed + standalone,
   shipped as static files via Vite's `public/` dir. (Risks notes the install-prompt caveat.)
3. **Mobile == the existing ≤900px breakpoint.** The deep-link path triggers under the *same* condition as
   tiles-hidden (`isMobile()`), so phones and narrow tablets get it; wide viewports keep tiles. One
   breakpoint, already synced between `gigi-app.js` and `styles.js`.
4. **Touch sizing is scoped to touch devices** (`@media (pointer: coarse)`), so the desktop design and the
   chat module's existing axe snapshots are undisturbed. (Touch-target *minimums* are a WCAG **2.2**
   criterion, not the 2.1 AA mandate — included because first-class mobile needs them; full 2.2 sweep is
   Phase 6.)

---

## Work item 1 — Mobile citation deep links (`#gigi=`)

**`frontend-gigi/src/urls.js`** — add a pure, unit-testable helper beside `guardTileUrl`/defrag:
`buildDeepLink(url, quote)` → `url + '#gigi=' + encodeURIComponent(quote)` when `quote` is truthy, else the
bare `url`.

**`frontend-gigi/src/gigi-app.js`**
- Add `this._quotes = new Map()` keyed by **defragged** URL. Route the `onHighlight` handler through a new
  `_onHighlight(url, quote, final_url)` that records `this._quotes.set(defrag(final_url || url), quote)`
  (prefer `final_url` so the fragment rides to the page the companion actually lands on) and then calls
  `this._tilesEl?.highlight(...)`. The map is cleared in `_onNewSession` only — **not** per submit: a quote
  is the page's own verified substring, stable regardless of which question surfaced it, and tiles can
  persist across a no-citation follow-up, so dropping quotes mid-conversation would needlessly un-highlight
  a still-tappable citation.
- Rewrite `_onCitationClick({url, text})` to branch on `isMobile()`:
  - **Mobile + allow-listed host:** `window.open(buildDeepLink(url, this._quotes.get(defrag(url))), '_blank',
    'noopener')`. If the quote hasn't arrived yet (highlights are post-answer), the link opens with no
    fragment and degrades gracefully to an un-highlighted page (V3.md §2.5 — highlighting is purely additive).
  - **Desktop:** unchanged (`focusOrOpen` into a tile).
  - `mailto:` / `tel:` / off-list branches unchanged.

No chat-module change is required — it already routes all citation taps through `gigi-citation-click`.

---

## Work item 2 — Simple PWA (manifest + icons + meta, no service worker)

Vite serves `frontend-gigi/public/` at the site root and copies it into `dist/`, so **no plugin is needed**.

**`frontend-gigi/public/manifest.webmanifest`** (new): `name:"Gigi — City of Garden Grove Assistant"`,
`short_name:"Gigi"`, `description`, `start_url:"/"`, `scope:"/"`, `display:"standalone"`,
`background_color` (shell bg), `theme_color` (`#0b5cab`), and `icons`: 192 + 512 `purpose:"any"` plus
192 + 512 `purpose:"maskable"`.

**Icons are produced by a standalone, re-runnable script** (`frontend-gigi/scripts/gen-icons.mjs`, npm
`gen:icons`) rather than hand-generated — the user has no final brand asset yet and will want to re-run it
whenever the artwork changes. It reads one source SVG (`--source`, default
`frontend-gigi/assets/gigi-icon.svg`) and emits the full set into `public/`:
`icons/icon-192.png`, `icons/icon-512.png` (purpose `any`), `icons/icon-192-maskable.png`,
`icons/icon-512-maskable.png` (artwork inset to the ~80% safe zone on a solid `--bg`, default `#0b5cab`),
`icons/apple-touch-icon-180.png`, `favicon.svg` (copy of source) + `favicon-16/32.png`. Only dep is
`sharp` (devDependency); a missing `sharp` prints an install hint instead of a stack trace. A **placeholder
source SVG derived from the hero logo** (rounded speech bubble + three dots, city-blue field) ships in
`assets/` so the script runs today; the user swaps that SVG for the real asset and re-runs. **Commit the
generated PNGs as source assets** (not under the gitignored `dist/`). The build does not run the script —
icons referenced before first generation simply 404 (no build failure); run `gen:icons` once before a real
install/deploy.

**`frontend-gigi/index.html`** `<head>` additions:
- `<link rel="manifest" href="/manifest.webmanifest">`
- `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#0b5cab">` + a dark counterpart
  (`#5b9bff` or the dark shell bg) — keep in sync with the `--gigi-shell-accent` tokens in `styles.js`.
- `<link rel="icon" href="/favicon.svg" type="image/svg+xml">` (+ optional `.ico`)
- `<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">`
- `<meta name="mobile-web-app-capable" content="yes">`,
  `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`,
  `<meta name="apple-mobile-web-app-title" content="Gigi">`
- Update viewport to `width=device-width, initial-scale=1, viewport-fit=cover` (enables the safe-area insets
  in Work item 3).

---

## Work item 3 — Responsive & touch polish

**`frontend-gigi/index.html` / `frontend-gigi/src/styles.js`** — dynamic viewport height: make the shell
use `100dvh` (with `100vh`/`100%` fallback) so the composer stays above mobile browser chrome and the
on-screen keyboard. In the `≤900px` block, add `padding-bottom: env(safe-area-inset-bottom)` (and sides as
appropriate) so the composer clears the iOS home indicator / notch.

**`chat-module/src/styles.js`** — under `@media (pointer: coarse)`:
- `.input`, `.send` → `min-height: 44px` (`.send` also `min-width: 44px`), with larger tap padding.
- `.input { font-size: 16px }` to prevent iOS focus auto-zoom.
- Increase inline citation / Sources link tap spacing (line-height / padding) for easier tapping.

---

## Target layout (after Phase 5)

```
frontend-gigi/
  index.html              # CHANGED: manifest/icon/theme-color/apple meta + viewport-fit=cover
  package.json            # CHANGED (optional): + "gen:icons", + sharp devDep (only if no system rsvg/IM)
  public/                 # NEW (Vite static root → copied to dist/)
    manifest.webmanifest  # NEW
    favicon.svg           # NEW
    icons/                # NEW: icon-192/512(.maskable).png, apple-touch-icon-180.png
  scripts/
    gen-icons.mjs         # NEW (optional): SVG → PNG renderer
  src/
    urls.js               # CHANGED: + buildDeepLink(url, quote)
    gigi-app.js           # CHANGED: _quotes map from onHighlight; _onCitationClick mobile branch
    styles.js             # CHANGED: 100dvh + safe-area insets in the ≤900px block
  test/
    unit/*.spec.js        # CHANGED: buildDeepLink + quote-map keying
    e2e/*.spec.js         # CHANGED: mobile deep-link tap + PWA presence
chat-module/
  src/styles.js           # CHANGED: @media (pointer: coarse) touch sizing
```

## Reused, not rebuilt

- Companion `#gigi=` intake — `src/companion/companion.js` Channel 2 (Phase 4).
- Citation chokepoint — `gigi-chat.js:_onLogClick` → `gigi-citation-click`.
- Verified quotes — `highlight` events already reach the shell (`ws-client.js` → `onHighlight`).
- Mobile breakpoint + tiles-hidden layout — `gigi-app.js:isMobile()` + the `styles.js` 900px block.
- URL defrag / host guard — `src/urls.js` (`guardTileUrl`, `DEFAULT_ALLOWED_TILE_HOSTS`).

---

## Testing & acceptance (V3.md §7)

**Unit (`frontend-gigi/test/unit/`):** `buildDeepLink` encodes the quote (`url#gigi=<encoded>`), omits the
fragment when no quote, and leaves `mailto:`/`tel:`/non-allow-listed URLs untouched; the quote map keys on
defragged URLs (and prefers `final_url`).

**Playwright e2e (`frontend-gigi/test/e2e/`, chromium/firefox/webkit):** extend the existing mobile test
(`tiling.spec.js`, 700×800) and/or add a device-emulated (e.g. iPhone) spec:
- Full mobile turn: answer streams, chat is edge-to-edge, **no tiles**, layout stays centered.
- After a `highlight` fixture event, tapping a citation calls `window.open` (spied) with
  `…#gigi=<encoded quote>` and `_blank`; **before** the highlight arrives, it opens the bare URL.
- PWA presence: `/manifest.webmanifest` resolves and validates (required keys + 192/512 icons);
  `index.html` exposes `link[rel=manifest]`, `meta[name=theme-color]`, and `link[rel=apple-touch-icon]`.
- The destination highlight is already proven by the Phase 4 companion hash test (`highlight.spec.js`); the
  new shell test proves the link handed to it is well-formed, closing the loop end-to-end.

**Accessibility (`test/a11y/`):** `@axe-core/playwright` stays green on the mobile layout; the chat-module
axe snapshots are unchanged on desktop (touch sizing is coarse-pointer-only).

**Build:** `cd frontend-gigi && npm run build` emits `dist/manifest.webmanifest` + `dist/icons/*` alongside
`index.html` / `assets/` / `companion.js`. `pytest tests/` still green (no backend change).

**Manual (the human gate):** on a real phone (Mode B — backend serves `dist/`): chat fills the dynamic
viewport, the composer clears the home indicator, no iOS focus-zoom on the input, "Add to Home Screen" /
"Install" yields a themed standalone Gigi, and tapping a source opens the city page with the quote
highlighted (companion via `#gigi=`).

---

## Risks / call-outs

- **No service worker ⇒ no offline, and no automatic Android install prompt.** Without a SW with a fetch
  handler, Chrome/Android won't fire `beforeinstallprompt`; installation still works via the browser menu
  ("Install app" / "Add to Home Screen"), and iOS Safari "Add to Home Screen" works fully from the manifest
  + apple meta tags. This is the deliberate "simple PWA" trade. Offline support, if ever wanted, is a
  separate follow-up.
- **Quote arrives after the answer.** Highlights are post-answer; a user can tap a citation before the
  quote lands. The deep link then carries no fragment and the page opens un-highlighted — acceptable by
  design (V3.md §2.5: highlighting is additive, never a gate).
- **Fragment across redirects.** Using `final_url` for the quote-map key (when present) keeps the `#gigi=`
  fragment aligned with the page the companion actually lands on; relying on browsers to re-attach the
  fragment across a redirect is the fallback.
- **AR 2.16 / PII.** The `#gigi=` fragment carries the verified, non-PII page quote and never reaches the
  server (V3.md §2.2). No new PII surface; test/demo fixtures stay synthetic.
- **`theme-color` / breakpoint sync.** `theme-color` values track `--gigi-shell-accent`, and `MOBILE_BP`
  still mirrors the `styles.js` 900px query — keep both pairs in sync (already noted in the code comments).
```
