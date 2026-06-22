# Phase 4 — Companion (Implementation Plan)

## Context

Phase 1 shipped the backend (`backend/`): a FastAPI `/ws` that streams a grounded prose answer with
inline `[title](url)` citations, then runs an **async, post-answer** highlight pass — it fetches each
cited live page with the crawler's own extraction, asks Haiku for the verbatim span, **snaps** that span
to a guaranteed true substring of the fetched text, and emits `highlight {url, quote}` events (V3.md §2.3,
§2.5; `v3/PHASE1.md`). Phase 3 shipped the **Gigi app shell** (`frontend-gigi/`): it owns the WebSocket,
embeds `<gigi-chat>`, opens cited pages as tiled iframes, and on a `highlight` event posts the verified
quote into the matching tile with an **origin-checked `postMessage`** (`v3/PHASE3.md`). What it posts to
is, today, a throwaway **stub** living inside the fixture city page so the path runs end-to-end on
localhost.

Phase 4 builds the **real companion** (V3.md §2.1, §2.2, §2.5, §6 Phase 4): a tiny, defensive, vanilla-JS
script injected into **every** City of Garden Grove Drupal page. It receives the verified quote (over
`postMessage` when framed in a desktop tile, or a `#gigi=` URL fragment when opened standalone/mobile),
**reveals** the Bootstrap tab or collapsible that contains the text if it is hidden, **fuzzy-matches** the
quote in its own DOM using the same normalization the crawler used at index time, **highlights** it via
the CSS Custom Highlight API (with a span fallback), **scrolls** it into view, and **reports a miss** back
to the shell when it cannot. The companion is the last piece of the desktop highlight path and the only
piece that runs inside the city's own pages.

The companion is **purely additive** (V3.md §2.5, §3): the answer and the tiles are already on screen by
the time a `highlight` arrives. A page that can't be revealed, a quote that won't match, or a section
built by client-side JS degrades gracefully to *an opened page with no highlight* — Sonnet is never re-run.

**Phase 0 is a prerequisite for production, assumed here** (V3.md §6 Phase 0, §10): the Drupal template
must inject `companion.js` on every page (with security review for a script on every page), and the city
pages must send CSP `frame-ancestors` allowing the Gigi origin and drop any conflicting
`X-Frame-Options`. None of that gates local development — the same-origin fixture page (`demo/city-page.html`)
exercises the full companion without any Phase 0 header work, exactly as in Phase 3.

**Scope decisions for this phase (locked):**
1. **Built inside `frontend-gigi/`, as a second IIFE build target — not a new top-level package.** The
   companion source lives in `frontend-gigi/src/companion/` and is bundled by an added Vite **library
   build** into a single self-contained `dist/companion.js` (IIFE, no imports, no hash in the name) for
   Drupal injection. It reuses the existing toolchain (Vite + npm + Playwright) rather than introducing a
   fourth package. The shell's app build (`vite build` → `dist/index.html`) is unchanged; `npm run build`
   runs both.
2. **Vanilla JS, no framework.** No Lit, no runtime dependency, no module loader on the page — one IIFE
   that runs immediately and defensively (every DOM access guarded, every handler `try`-wrapped). It must
   be safe on a page it does not own and must never throw into the host page.
3. **Both intake channels are built now.** Origin-checked `postMessage` (desktop tiles) **and** the
   `#gigi=` hash fragment (standalone/mobile). The hash channel's *primary consumer* is Phase 5 (mobile
   deep links, V3.md §2.9), but it is the same script, so it ships here. Phase 3 already scaffolded the
   hash read in the stub.
4. **The companion replaces the fixture-page stub.** `demo/city-page.html` loads the real built companion
   instead of its inline stub, so Phase 3's existing Playwright highlight scenarios now exercise real
   reveal / fuzzy-match / Custom-Highlight-API / miss-report logic. No new shell-side wiring is needed —
   the contract (`gigi-highlight` in; `gigi-tile-result` and `gigi-navigating` out) is already built and
   tested in Phase 3.
5. **Highlight is best-effort, never a gate.** A miss degrades to an opened page and a `tile_result`
   report; the companion never asks the backend to regenerate. The `hidden="until-found"` upgrade for
   native find-in-page (V3.md §2.5) is noted as an **optional future enhancement, not built here**.

---

## Protocol & contracts this companion maps onto (verified against Phase 3)

The shell side is already implemented (`frontend-gigi/src/tiles.js`, `frontend-gigi/src/gigi-app.js`); the
companion fills in the in-page half of a contract that already runs against the stub. Two channels carry a
verified quote **into** the page; one channel carries results **out** (V3.md §2.2, §2.6).

| Direction | Channel | Message | Origin discipline |
|---|---|---|---|
| Shell → companion | `postMessage` (desktop tiles) | `{type:'gigi-highlight', quote}` — posted by `tiles.js` `_tryPost()` to the iframe's `contentWindow` with an **explicit** target origin (`tile.origin`, never `'*'`) | Companion validates `event.source === window.parent` **and** `event.origin` ∈ the Gigi-origin allow-list before acting |
| Shell → companion | URL fragment (standalone / mobile, Phase 5 consumer) | `location.hash` = `#gigi=<encodeURIComponent(quote)>` | No origin (no opener); companion reads it **once**, then strips it with `history.replaceState` so it never reaches the server, logs, or cache (V3.md §2.2) |
| Companion → shell | `postMessage` to `window.parent` | `{type:'gigi-tile-result', found, url, quote}` — the miss/ack report; the shell (`gigi-app.js`) forwards it via `socket.sendTileResult(...)`, and the backend already accepts and logs it | Companion replies to `event.source` with the received `event.origin` (never `'*'`); the shell re-validates the origin against the open tile (`tiles.js` `_onWindowMessage`) |
| Companion → shell | `postMessage` to `window.parent` | `{type:'gigi-navigating'}` — sent on `beforeunload`/in-tile link click so the shell shows a per-tile loading bar (Phase 3 behavior) | Best-effort; `'*'` is acceptable for this contentless signal |

Load-bearing facts (verified against Phase 3 code):
- The shell posts **only after the iframe has loaded** and matches the tile by **defragged** URL; the
  companion does not need to know its URL maps to a tile — it just acts on the quote it receives.
- `event.origin` on the inbound `gigi-highlight` is the **shell's** origin (the embedder), which the
  companion must allow-list (a build-time constant, e.g. `https://gigi.ggcity.org`, plus the localhost dev
  origin for the fixture harness). This is the companion's primary security boundary alongside the SSRF
  guard the backend already enforces server-side (V3.md §11; the companion only ever acts on a quote the
  backend already produced and vetted, never a raw URL).
- The quote the companion receives is **already snapped** to a true substring of the page text as the
  backend extracted it. The companion's job is to **re-locate** that text in the live DOM, which can differ
  from the extracted projection (whitespace, element boundaries, hidden tabs) — hence normalization parity
  and fuzzy matching below.

---

## Normalization parity (the load-bearing core)

The single reason highlighting works at all is that the quote the companion searches for and the live page
text it searches **are normalized the same way the crawler normalized the page at index time** (V3.md §2.5,
§9). The backend already guarantees its half: `backend/fetch.py` calls the shared
`shared/extraction.py:extract_text_from_html`, and `backend/highlight.py:snap` aligns the Haiku span to that
text. The companion must reproduce the **same projection** over the live DOM, or a quote that is a perfect
substring of the extracted text will not be found in the page.

The crawler's projection (`shared/extraction.py`, must be matched **exactly**):
- **Strip** `script`, `style`, `nav`, `footer`, `header` before reading text.
- **Content root**, first match wins: `main` → `article` → `div.content` → `body`. The companion searches
  the **same root**, in the same order, so it never matches chrome the crawler discarded.
- **Join** text across elements with a **single space** (`get_text(separator=" ")`).
- **Collapse** all whitespace: `re.sub(r"\s+", " ", text).strip()`. In JS: `s.replace(/\s+/g, ' ').trim()`
  (the exact collapse already used by the Phase 3 stub's `norm()` and `backend/highlight.py:_norm`).

Two hard rules carried from the backend:
- **The `Title:` artifact is never a highlight.** The crawler injects a `Title: …` prefix into some chunks
  that is **not on the live page** (`shared/extraction.py:chunk_text`; `TITLE_ARTIFACT = "Title:"`).
  `snap` already refuses to emit it, so the companion should never receive one — but the companion also
  declines any quote that begins with `Title:` as defense in depth.
- **Fuzzy match mirrors `snap`** (`backend/highlight.py:snap`, threshold **0.85**): normalized-exact
  substring is the fast path; otherwise anchor on the longest common contiguous block and accept a
  full-length window if it is similar enough to the quote (recovering minor live/extracted divergence).
  The companion's matcher is the JS analog of this same algorithm so backend and companion agree on what
  "matches"; it is one of the few pure functions worth unit-testing (V3.md §7).

---

## Target layout (after Phase 4)

Additions/changes within the existing `frontend-gigi/` package — no new top-level directory:

```
frontend-gigi/
  package.json            # + scripts: "build:companion"; "build" = app build && companion build
  vite.config.js          # unchanged (app build → dist/index.html)
  vite.companion.config.js # NEW: library build, formats:['iife'], entry src/companion/companion.js,
                          #   output dist/companion.js (fixed name, sourcemap), emptyOutDir:false
  src/
    companion/
      companion.js        # NEW: the whole companion — ONE self-contained, dependency-free ES module
                          #   (intake + normalize + match/snap + reveal + highlight + report), with
                          #   pure functions exported for unit tests and an auto-install on load
  demo/
    city-page.html        # CHANGED: stub replaced by <script type=module src=/src/companion/companion.js>;
                          #   kept the BS5 tab + known text; added a BS4-style collapsible
    fixtures/events.js    # CHANGED: + COLLAPSIBLE_QUOTE/FUZZY_QUOTE/ABSENT_QUOTE + scenarios
  test/
    unit/companion.spec.js # NEW: collapse parity, snapMatch (exact/whitespace/fuzzy/Title), ratio, origins
    e2e/highlight.spec.js  # CHANGED: real-companion scenarios (visible, hidden tab, collapsible, fuzzy, miss, hash)
    e2e/demo-smoke.spec.js # CHANGED: assert via data-gigi-highlighted (no stub #gigi-hl)
    e2e/helpers.js         # CHANGED: route the companion module at the ggcity origin; highlight helpers
  dist/
    index.html, assets/    # shell app build (unchanged)
    companion.js           # NEW: self-contained IIFE for Drupal injection (~6.8 kB; gitignored with dist/)
```

**Why one module, not a file-per-concern split:** the companion must be loadable three ways from a single
source — imported for unit tests, loaded as a `<script>` in the fixture iframe, and bundled to one IIFE for
Drupal — and a dependency-free single file does all three with no resolver. It is built by a Vite **library**
build (`build.lib`, `formats: ['iife']`, fixed `fileName`, `emptyOutDir: false` so it does not wipe the app
bundle, no externals → fully self-contained). `npm run build` runs the app build then the companion build
into the same `dist/`. The backend's existing `StaticFiles` mount (Phase 3) then serves `companion.js`
alongside the shell from one origin; in production the Drupal template injects it instead (Phase 0). Pure
functions (`collapse`, `findSpan`, `snapMatch`, `ratio`, `isAllowedOrigin`, `locateInDom`, …) are exported so
the gnarly logic is unit-testable; the module auto-installs on load unless `window.__GIGI_NO_AUTORUN` is set.

---

## Module architecture

One self-contained module (`src/companion/companion.js`) holds the whole pipeline; each function is small,
guarded, and independently testable. `install()` attaches its listeners on load (the script may load before
or after the shell posts), and each quote runs through **locate → reveal → highlight → report** once.
Everything is `try`-wrapped so a failure inside the companion can never break the host page, and nothing
leaks onto the page beyond an `__gigiCompanionInstalled` guard flag.

- **Intake (`install`, origin-checked).**
  - *postMessage:* `window.addEventListener('message', …)`; ignore unless `event.source === window.parent`,
    `isAllowedOrigin(event.origin)` (∈ `ALLOWED_PARENT_ORIGINS`, plus `localhost`/`127.0.0.1` for fixtures,
    plus an optional `window.__GIGI_COMPANION_ORIGINS`), and `data.type === 'gigi-highlight'`. On a match,
    run the pipeline for `data.quote` and reply `gigi-tile-result` to `event.source`/`event.origin`.
  - *hash:* on load, parse `/#gigi=([^&]+)/` from `location.hash`, `decodeURIComponent` it, run the pipeline
    with no reply target, then `history.replaceState(null, '', location.pathname + location.search)` to
    strip it (V3.md §2.2).
- **Normalize (`collapse`, `contentRoot`, crawler parity).** `collapse(s) → s.replace(/\s+/g,' ').trim()`;
  `contentRoot()` → first of `main`/`article`/`div.content`/`body`.
- **Locate (`buildIndex` + `findSpan`/`locateInDom`, the snap analog).** Walk the content root with a
  `TreeWalker(SHOW_TEXT)` rejecting any node under `script/style/nav/footer/header` (mirrors the crawler's
  strip set), building a normalized string **plus a per-char map** back to (text node, raw offset). Find the
  quote: normalized-exact substring first; otherwise the longest-common-block + full-length-window fuzzy
  pass at **threshold 0.85** (`findLongestMatch`/`ratio` are the difflib analogs of `backend/highlight.py`),
  then build a DOM `Range` from the map — or `null` for a miss.
- **Reveal (`revealForNode`/`revealEl`, Bootstrap 4/5, version-agnostic).** For each hidden ancestor of the
  match (`[hidden]`, `display:none`, or `.collapse:not(.show)`), **click the real control** — the element
  carrying `data-bs-toggle`/`data-toggle` and a `data-bs-target`/`data-target`/`href` pointing at the
  container (both attribute spellings checked). Clicking the control is version-agnostic and needs no
  Bootstrap handle (V3.md §2.5). If still hidden (no Bootstrap JS — e.g. the fixture), a fallback force-reveals
  (`removeAttribute('hidden')`, add `.show`/`.active`, clear inline `display`).
- **Highlight (`paint` + `clearHighlight`, Custom Highlight API + fallback + scroll).** Build a `Range`; if
  `CSS.highlights`/`Highlight` exist, register it under a `::highlight(gigi)` rule (background **+ underline**
  as a non-color cue for WCAG). Otherwise wrap the range in `<mark id="gigi-hl">`. Clear any prior highlight
  first, then `scrollIntoView({block:'center', behavior: prefers-reduced-motion ? 'auto' : 'smooth'})` —
  scroll only, never moving focus.
- **Report (`handleQuote` tail).** Set `document.body[data-gigi-highlighted]` to the matched quote (or `''`),
  a stable outcome marker the e2e suite asserts on regardless of highlight mechanism; and, when there is a
  reply target, post `gigi-tile-result {found, url, quote}` to the parent. `gigi-navigating` fires on
  `beforeunload` and in-page link clicks so the shell shows a per-tile loading bar (Phase 3 contract).

---

## Bootstrap reveal & the Custom Highlight API (the technical core)

These are the two parts most likely to bite, so they get explicit treatment.

**Reveal.** The crawler extracts text from hidden tabs and collapsibles regardless of CSS, so a cited
quote can legitimately live in a non-default tab or a collapsed section (V3.md §2.5). The companion must
make it visible before it can scroll to it. The robust, version-agnostic move is to **find the toggle
control that targets the hidden container and dispatch a real click** — Bootstrap's own delegated handler
then performs the show, animations and ARIA state included, with no dependency on which Bootstrap version
(or whether its JS bundle is even initialized the way we expect). Resolution order: from the matched node,
walk up to the nearest hidden `.tab-pane`/`.collapse`; derive its `id`; query for a control whose
`data-bs-target`/`data-target`/`href` equals `#<id>` (and bears `data-bs-toggle`/`data-toggle`); click it;
`requestAnimationFrame` before measuring. If no control is found, fall back to un-hiding the container
directly (as the stub does) — a degraded but functional reveal.

**Custom Highlight API.** `CSS.highlights` paints a `Range` without mutating the DOM — the right tool on a
page the companion does not own (no node surgery, no layout disruption, trivially clearable). It is broadly
supported in current Chromium and Safari (V3.md §11), but the companion **must keep the element-wrapping
fallback** for older browsers and for the case where the match resolves to a single text node where a
simple wrap is cleaner. The fallback mirrors the Phase 3 stub (`<mark id="gigi-hl">`). Whichever path is
used, exactly one companion highlight exists at a time (clear-before-set), and the highlight is removed if
a new `gigi-highlight` arrives for a different quote.

---

## Accessibility model (WCAG 2.1 AA — companion surface; V3.md §2.8)

The embedded city pages are the city's own responsibility and independently in scope (V3.md §2.8); the
companion's own conformance surface is small but real:
- **Highlight signalled by more than color, with adequate contrast.** The `::highlight(gigi)` rule (and the
  `<mark>` fallback) pairs a background with a non-color cue (underline or outline) and meets contrast
  against the page's text, mirroring the cue the Phase 3 shell/stub already established (V3.md §2.8).
- **No focus theft.** The companion scrolls but does **not** move keyboard focus into the framed page on
  highlight; it never opens a focus trap. (Phase 3 owns shell/tile focus order.)
- **Reduced motion.** Scrolling honors `prefers-reduced-motion` (`behavior:'auto'` when reduced).
- **Native find-in-page is unharmed** by the Custom Highlight API (no DOM mutation), and the optional
  future `hidden="until-found"` upgrade (V3.md §2.5) would further help Ctrl+F users — flagged, not built.

---

## Local run

The companion is a build output of `frontend-gigi/`, so it rides the existing Phase 3 run modes:

```bash
cd frontend-gigi && npm install
npm run build         # → dist/index.html + assets  AND  dist/companion.js
```

- **Mode A (dev against the real backend)** and **Mode B (prod-like, backend serves dist/)** from
  `v3/PHASE3.md` are unchanged; in Mode B the backend now also serves `dist/companion.js`, and the fixture
  city page loads it. Ask a real question → answer streams → tiles open → `highlight` arrives → the real
  companion reveals/locates/highlights/scrolls in the tile.
- **Mode C (offline demo / e2e, no backend)** drives the shell from `demo/fixtures/events.js` through the
  mock WebSocket; the fixture city page (`demo/city-page.html`) now hosts the **real** companion, so the
  full reveal + match + highlight + miss-report path is visible and testable locally with no API key and
  no Phase 0 headers.

---

## Testing & acceptance (V3.md §7)

Principle (V3.md §7): prioritize e2e over unit; the companion's value only shows when it runs inside a real
page against the shell's real `postMessage`. Reuse the Phase 3 harness — Playwright with `routeWebSocket`
replaying `demo/fixtures/events.js`, the fixture city page served same-origin, the iframe + postMessage +
highlight path running for real — now with the **real companion** in place of the stub.

**Playwright e2e (`test/e2e/`, chromium/firefox/webkit):**
- **Happy path:** `highlight` arrives → shell posts the quote → companion locates and highlights the
  visible text → scrolled into view → `gigi-tile-result {found:true}` reported.
- **Hidden-tab reveal:** the cited quote lives in a non-default Bootstrap-5 tab (`data-bs-*`) → companion
  clicks the control / force-reveals, the pane shows, then the quote is highlighted.
- **Collapsible reveal:** quote inside a collapsed Bootstrap-4 `.collapse` (`data-toggle`/`data-target`) →
  revealed then highlighted (the tab + collapsible together prove version-agnostic reveal).
- **DOM-miss:** quote not present live (`ABSENT_QUOTE`) → page shown with **no** highlight,
  `data-gigi-highlighted` empty, nothing thrown.
- **Fuzzy recovery:** a quote with light divergence from the live text (whitespace / a stray character)
  still matches via the 0.85 fuzzy pass.
- **`Title:` guard:** a quote beginning with `Title:` is declined (no false highlight).
- **Hash channel (Phase 5 path, validated now):** loading the fixture page directly with `#gigi=<quote>`
  highlights and then strips the fragment from the URL (`location.hash` empty after).
- **Origin rejection:** a `gigi-highlight` `postMessage` from a non-allow-listed origin is ignored.

**Accessibility (`test/a11y/`):** `@axe-core/playwright` asserts zero violations on the fixture page with a
companion highlight active; plus assertions that the highlight cue is **not color-only** and that focus did
not move into the frame on highlight.

**Unit (`test/unit/companion.spec.js`) — only the gnarly pure logic (V3.md §7):** the `normalize.js`
collapse + content-root selection (parity with `shared/extraction.py`), and the `match.js` fuzzy/snap
analog (exact substring, whitespace recovery, light-corruption recovery at threshold 0.85, `Title:`
rejection) — the JS mirror of `tests/test_verify_snap.py`.

**Manual checklist (`test/MANUAL_A11Y_CHECKLIST.md`, extended):** screen-reader behavior when a highlight
appears in a tile; reduced-motion scroll; reveal of a real collapsed section on a representative live-like
page; Custom Highlight API vs fallback on the actual browsers residents use.

**Acceptance:** `npm run build` emits both `dist/index.html` and a self-contained `dist/companion.js`;
`npm test` green (e2e + axe + unit) across the three engines with the real companion replacing the stub;
the Phase 3 highlight scenarios still pass; the reveal, miss, fuzzy, and hash scenarios pass; `pytest tests/`
still green (no backend change); manual checklist signed off.

---

## Risks / call-outs

- **Phase 0 dependency (production only).** The companion does nothing in production until the Drupal
  template injects `companion.js` on every page **and** the city sends `frame-ancestors` allowing the Gigi
  origin (dropping conflicting `X-Frame-Options`) (V3.md §10). Mitigated: the same-origin fixture page
  exercises the full companion locally, independent of Phase 0; without the framing headers the desktop
  tile shows the shell's Phase 3 "Open in new tab" fallback and the companion still works via the `#gigi=`
  link on the destination page.
- **Server-rendered vs JS-rendered divergence.** The backend snapped the quote against server-fetched HTML;
  the companion searches the live DOM. Drupal is mostly server-rendered, but a JS-built section can differ —
  this is exactly the **DOM-miss** path: show the page, no highlight, report `tile_result`, never re-run
  (V3.md §11, §2.5).
- **Custom Highlight API support.** Broadly supported in current Chromium and Safari but not universal;
  the element-wrapping fallback is mandatory and on the manual cross-browser checklist (V3.md §11).
- **Bootstrap version differences.** Reveal by clicking the toggle control is version-agnostic across
  Bootstrap 4 and 5; the only branch is reading both `data-bs-*` and legacy `data-*` attribute spellings.
  If a page initializes tabs in a non-standard way, the direct-unhide fallback still reveals the section
  (V3.md §11).
- **A script on every city page (security review).** The companion runs in the city's own pages, so it must
  be tiny, dependency-free, fully guarded (no uncaught exceptions into the host), leak no globals, and act
  **only** on quotes from an allow-listed parent origin. Drupal injection requires the Phase 0 security
  review (V3.md §10). The SSRF surface is **not** here — the backend already restricts fetches to
  `ALLOWED_FETCH_HOSTS` ∩ retrieved sources server-side (V3.md §11); the companion only re-locates a quote
  the backend already vetted.
- **AR 2.16 / PII.** The companion itself handles **no** PII — it receives a non-PII quote and reports only
  `{found, url, quote}` back to the shell, which the backend logs as part of the interaction. The quote
  could in principle echo resident-volunteered text from a prior turn, so test/demo fixtures must use
  **synthetic, non-PII** quotes, and the `tile_result` logging falls under the same retention/redaction
  policy as the rest of the interaction log (Phase 6). Per City policy, handling PII follows AR 2.16
  (Cloud Computing Services Policy): https://internal.ggcity.org/policies.
- **`hidden="until-found"` not built.** Converting collapsibles to native find-in-page revealing is an
  optional future enhancement (V3.md §2.5), deliberately out of Phase 4 scope.
```
