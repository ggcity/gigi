import { LitElement, html, css, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { animate } from 'motion';
import { guardTileUrl, sameTarget, canonicalize, DEFAULT_ALLOWED_TILE_HOSTS } from './urls.js';
import { prefersReducedMotion } from './morph.js';

/**
 * <gigi-tiles> — the robust desktop tile grid ("tiling library").
 *
 * Frames cited city pages and forwards verified highlight quotes via origin-checked
 * postMessage (the in-page companion — Phase 4 — acts on them; a stub does so in the
 * test/demo fixture). The shell feeds it citations (already filtered to pure http(s)
 * allow-listed links); this element never parses markdown.
 *
 * Behavior:
 *  - Adaptive grid: 1 column (full-width tile) until the pane is wide enough AND there
 *    are ≥2 tiles → 2 columns; rows are `minmax(280px,1fr)` so a tall screen shows all
 *    tiles and a short one scrolls. The GRID scrolls — never the page.
 *  - Click-to-interact scrim: by default the wheel scrolls the column and iframes are
 *    inert; click a tile to interact with its page; scrolling the column re-arms it.
 *  - Dedup: cosmetically-equal URLs collapse on open (canonicalize); URLs that the
 *    backend reports redirect to the same page (`final_url`) auto-close the duplicate.
 *  - Animated open / close / reflow (CSS enter+leave, Motion-One FLIP), motion-gated.
 *
 * Safety: every URL passes `guardTileUrl` (http(s) + allow-listed host) before framing.
 */
export class GigiTiles extends LitElement {
  static properties = {
    maxTiles: { type: Number, attribute: 'max-tiles' },
    scrim: { type: Boolean, reflect: true }, // opt-in click-to-interact scrim (off by default)
    _tiles: { state: true },
    _status: { state: true },
    _interactive: { state: true }, // url of the tile currently interactive (scrim mode)
    _activeIndex: { state: true }, // roving-tabindex active card (arrow-key nav)
    _canUp: { state: true },
    _canDown: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      height: 100%;
      container-type: inline-size; /* tile count responds to the PANE width */
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .tiles {
      position: relative;
      height: 100%;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .grid {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      display: grid;
      gap: var(--gigi-shell-gap, 16px);
      /* left/top/bottom 8px for focus-ring room (#4); right leaves room for the
         custom scroll indicator. */
      padding: 8px 18px 8px 8px;
      grid-template-columns: 1fr; /* one full-width tile by default */
      /* Stacked (1 column) tiles get a comfortable min height (#3). */
      grid-auto-rows: minmax(var(--gigi-shell-tile-stacked-min, 50vh), 1fr);
      align-content: stretch;
      /* Native scrollbar hidden — we render our own always-visible indicator (#6),
         because native bars are overlay/auto-hidden on many OSes and unstyleable
         once scrollbar-color/width are set. */
      scrollbar-width: none;
    }
    .grid::-webkit-scrollbar {
      display: none;
    }
    /* Two columns only when the pane is wide (~1500px viewport) AND there are ≥2 tiles. */
    @container (min-width: 950px) {
      .grid:has(.card:nth-child(2)) {
        grid-template-columns: 1fr 1fr;
      }
      /* Two-up rows are shorter so a 4-up 2×2 still fits a tall screen (#9). */
      .grid {
        grid-auto-rows: minmax(300px, 1fr);
      }
      /* An odd last tile spans the full width instead of leaving a half-empty row. */
      .grid:has(.card:nth-child(3)):not(:has(.card:nth-child(4))) .card:last-child {
        grid-column: 1 / -1;
      }
    }
    /* Custom always-visible scroll indicator (#6) — obvious and draggable. Shown only
       when the column actually overflows. */
    .vscroll {
      position: absolute;
      top: 8px;
      right: 4px;
      bottom: 8px;
      width: 12px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--gigi-shell-fg, #16202c) 8%, transparent);
      z-index: 5;
    }
    .vscroll[hidden] {
      display: none;
    }
    .vthumb {
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      min-height: 32px;
      border-radius: 8px;
      background: var(--gigi-shell-accent, #0b5cab);
      cursor: grab;
      touch-action: none;
    }
    .vthumb:active {
      cursor: grabbing;
    }
    .vthumb:hover {
      background: color-mix(in srgb, var(--gigi-shell-accent, #0b5cab) 85%, black);
    }
    /* Fade affordances at the scroll edges. */
    .fade {
      position: absolute;
      left: 0;
      right: 18px;
      height: 28px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 160ms ease;
      z-index: 3;
    }
    .fade-top {
      top: 0;
      background: linear-gradient(var(--gigi-shell-bg, #eaeff5), transparent);
    }
    .fade-bottom {
      bottom: 0;
      background: linear-gradient(transparent, var(--gigi-shell-bg, #eaeff5));
    }
    :host([data-up]) .fade-top,
    :host([data-down]) .fade-bottom {
      opacity: 0.9;
    }

    .card {
      position: relative;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--gigi-shell-surface, #fff);
      border: 1px solid var(--gigi-shell-border, #c6c6cc);
      border-radius: var(--gigi-shell-radius, 14px);
      box-shadow: var(--gigi-shell-shadow, 0 1px 3px rgba(0, 0, 0, 0.08));
      overflow: hidden;
    }
    /* #10/#5: show focus when a card is focused (arrow-key nav) or focus enters it. */
    .card:focus,
    .card:focus-within {
      outline: 3px solid var(--gigi-shell-focus-ring, #0b5cab);
      outline-offset: 2px;
    }
    .card:focus {
      outline-style: solid;
    }
    .card-head {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px 6px 12px;
      border-bottom: 1px solid var(--gigi-shell-border, #c6c6cc);
      background: var(--gigi-shell-surface-2, #f4f7fb);
      font-size: 0.85rem;
    }
    .card-title {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
      color: var(--gigi-shell-fg, #1a1a1a);
    }
    .hl-badge {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 7px;
      border-radius: 999px;
      font-size: 0.7rem;
      color: var(--gigi-shell-on-accent, #fff);
      background: var(--gigi-shell-accent, #0b5cab);
    }
    .icon-btn {
      flex: 0 0 auto;
      display: inline-grid;
      place-items: center;
      width: 30px;
      height: 30px;
      padding: 0;
      color: var(--gigi-shell-muted, #54606e);
      background: transparent;
      border: 1px solid var(--gigi-shell-border, #c6c6cc);
      border-radius: 8px;
      cursor: pointer;
      text-decoration: none;
    }
    .icon-btn:hover {
      color: var(--gigi-shell-fg, #1a1a1a);
      background: var(--gigi-shell-surface, #fff);
    }
    .icon-btn:focus-visible {
      outline: 3px solid var(--gigi-shell-focus-ring, #0b5cab);
      outline-offset: 2px;
    }
    .icon-btn svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      stroke-width: 2;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .frame-wrap {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
      background: #fff;
      pointer-events: auto; /* interactive by default (scrim opt-in) */
    }
    /* Scrim mode (opt-in): iframes are inert until the tile is activated. */
    :host([scrim]) iframe {
      pointer-events: none;
    }
    :host([scrim]) .card.interactive iframe {
      pointer-events: auto;
    }
    /* Per-tile loading bar (#7): indeterminate top progress while the framed page
       navigates (driven by the in-page companion's gigi-navigating signal). */
    .loadbar {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      z-index: 6;
      overflow: hidden;
      background: color-mix(in srgb, var(--gigi-shell-accent, #0b5cab) 22%, transparent);
    }
    .loadbar::before {
      content: '';
      position: absolute;
      inset: 0;
      width: 40%;
      background: var(--gigi-shell-accent, #0b5cab);
      animation: loadbar-slide 1.1s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .loadbar::before {
        animation: none;
        width: 100%;
        opacity: 0.6;
      }
    }
    @keyframes loadbar-slide {
      0% {
        transform: translateX(-100%);
      }
      100% {
        transform: translateX(350%);
      }
    }
    /* #7: the scrim captures clicks (so the wheel scrolls the column, not the iframe)
       and is the affordance to activate a tile. */
    .scrim {
      position: absolute;
      inset: 0;
      z-index: 2;
      display: grid;
      place-items: center;
      padding: 0;
      border: 0;
      background: transparent;
      cursor: pointer;
    }
    .scrim:hover,
    .scrim:focus-visible {
      background: color-mix(in srgb, var(--gigi-shell-fg, #16202c) 6%, transparent);
    }
    .scrim:focus-visible {
      outline: 3px solid var(--gigi-shell-focus-ring, #0b5cab);
      outline-offset: -3px;
    }
    .scrim-hint {
      opacity: 0;
      transform: translateY(4px);
      transition: opacity 140ms ease, transform 140ms ease;
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--gigi-shell-bg, #fff);
      background: color-mix(in srgb, var(--gigi-shell-fg, #16202c) 88%, transparent);
    }
    .scrim:hover .scrim-hint,
    .scrim:focus-visible .scrim-hint {
      opacity: 1;
      transform: none;
    }
    .fallback {
      padding: 16px;
      font-size: 0.9rem;
      color: var(--gigi-shell-muted, #54606e);
    }
    .fallback a {
      color: var(--gigi-shell-accent, #0b5cab);
    }

    /* Enter / leave animations (motion-gated). */
    @media (prefers-reduced-motion: no-preference) {
      .card {
        animation: tile-in 240ms cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      .card.leaving {
        animation: tile-out 200ms ease both;
        pointer-events: none;
      }
    }
    @keyframes tile-in {
      from {
        opacity: 0;
        transform: translateY(8px) scale(0.985);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
    @keyframes tile-out {
      to {
        opacity: 0;
        transform: scale(0.97);
      }
    }
  `;

  constructor() {
    super();
    this.maxTiles = 4;
    this.scrim = false;
    /** @type {Array<{url:string, src:string, origin:string, title:string, errored:boolean, highlighted:boolean, leaving:boolean, loading:boolean}>} */
    this._tiles = [];
    this._status = '';
    this._interactive = null;
    this._activeIndex = 0;
    this._canUp = false;
    this._canDown = false;
    this._allowedHosts = DEFAULT_ALLOWED_TILE_HOSTS;
    this.resolveSrc = (url) => url;
    this._onWindowMessage = this._onWindowMessage.bind(this);
    this._pending = new Map(); // url → quote awaiting iframe load
    this._loaded = new Set(); // urls whose iframe has loaded
    this._finalByUrl = new Map(); // url → canonical post-redirect URL (for dedup)
    this._loadingSince = new Map(); // url → timestamp the loading bar appeared (#7 min display)
  }

  set allowedHosts(v) {
    this._allowedHosts = Array.isArray(v) && v.length ? v : DEFAULT_ALLOWED_TILE_HOSTS;
  }
  get allowedHosts() {
    return this._allowedHosts;
  }
  get count() {
    return this._tiles.filter((t) => !t.leaving).length;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('message', this._onWindowMessage);
  }
  disconnectedCallback() {
    window.removeEventListener('message', this._onWindowMessage);
    this._ro?.disconnect();
    super.disconnectedCallback();
  }

  // ── public API ────────────────────────────────────────────────
  /** Replace the tile set (new cited answer), deduping cosmetically-equal URLs. */
  openTiles(citations) {
    const first = this._captureRects();
    const next = [];
    for (const c of citations || []) {
      if (next.length >= this.maxTiles) break;
      const tile = this._makeTile(c);
      if (tile && !next.some((t) => sameTarget(t.url, tile.url))) next.push(tile);
    }
    // Drop per-url state for tiles that are gone.
    const keepUrls = new Set(next.map((t) => t.url));
    for (const url of [...this._loaded]) if (!keepUrls.has(url)) this._loaded.delete(url);
    this._setTiles(next, first);
    this._announceCount('opened');
  }

  /** Append one citation as a tile, capped. */
  addTile(citation) {
    if (this.count >= this.maxTiles) return;
    const tile = this._makeTile(citation);
    if (!tile || this._tiles.some((t) => sameTarget(t.url, tile.url))) return;
    const first = this._captureRects();
    this._setTiles([...this._tiles.filter((t) => !t.leaving), tile], first);
    this._announceCount('opened');
  }

  /** Focus an already-open tile, or open one if absent. */
  focusOrOpen(citation) {
    const tile = citation && this._tiles.find((t) => sameTarget(t.url, citation.url));
    if (tile) {
      this.updateComplete.then(() =>
        this.renderRoot.querySelector(`a[data-tile-url="${cssEscape(tile.url)}"]`)?.focus()
      );
    } else {
      this.addTile(citation);
    }
  }

  clear() {
    if (!this._tiles.length) return;
    this._tiles = [];
    this._interactive = null;
    this._status = 'Closed the open pages.';
    this._emitChanged();
  }

  /**
   * Forward a verified quote to the matching open tile. If the backend reports a
   * `finalUrl` that another open tile also resolves to, merge them (close the later
   * duplicate, keep the earlier, highlight that one). Posting is queued until the
   * iframe has loaded.
   */
  highlight(url, quote, finalUrl) {
    const idx = this._tiles.findIndex((t) => !t.leaving && sameTarget(t.url, url));
    if (idx === -1) return;
    const tile = this._tiles[idx];
    const finalCanon = canonicalize(finalUrl || tile.url);
    this._finalByUrl.set(tile.url, finalCanon);

    // Any other live tile resolving to the same final page → dedupe.
    const dupIdx = this._tiles.findIndex(
      (t, i) => i !== idx && !t.leaving && this._finalByUrl.get(t.url) === finalCanon
    );
    if (dupIdx !== -1) {
      const keep = this._tiles[Math.min(idx, dupIdx)];
      const drop = this._tiles[Math.max(idx, dupIdx)];
      this._pending.set(keep.url, quote);
      this._mark(keep.url, { highlighted: true });
      this._tryPostByUrl(keep.url);
      this._status = `Merged a duplicate page; highlighted ${keep.title}.`;
      this._removeTile(drop.url);
      return;
    }

    this._pending.set(tile.url, quote);
    this._mark(tile.url, { highlighted: true });
    this._tryPostByUrl(tile.url);
    this._status = `Highlighted a quote on ${tile.title}.`;
  }

  // ── internals ─────────────────────────────────────────────────
  _makeTile(c) {
    if (!c || !c.url) return null;
    const guard = guardTileUrl(c.url, this._allowedHosts);
    if (!guard.ok) return null;
    const title = (c.title || c.text || guard.href).toString();
    const src = this.resolveSrc(guard.href);
    let origin = guard.origin;
    try {
      origin = new URL(src, location.href).origin;
    } catch {
      /* keep guard.origin */
    }
    return { url: guard.href, src, origin, title, errored: false, highlighted: false, leaving: false, loading: false };
  }

  _close(url) {
    this._removeTile(url);
  }

  /** Remove a tile with a leave animation + FLIP reflow of the rest (motion-gated). */
  _removeTile(url) {
    const reduce = prefersReducedMotion();
    if (reduce) {
      this._commitRemoval(url, null);
      return;
    }
    // Animate the leaving tile out, then commit + FLIP the survivors into place.
    const first = this._captureRects(url);
    this._mark(url, { leaving: true });
    setTimeout(() => this._commitRemoval(url, first), 200);
  }

  _commitRemoval(url, firstRects) {
    if (this._interactive === url) this._interactive = null;
    this._loaded.delete(url);
    this._pending.delete(url);
    this._finalByUrl.delete(url);
    this._tiles = this._tiles.filter((t) => t.url !== url);
    this._status = 'Closed a page.';
    this._emitChanged();
    if (firstRects) this.updateComplete.then(() => this._flip(firstRects));
    // Keyboard focus: move to a remaining tile's close button, else the shell handles it.
    if (this._tiles.length) {
      this.updateComplete.then(() => this.renderRoot.querySelector('.icon-close')?.focus());
    }
  }

  /** Set the tile array and FLIP survivors from their captured rects. */
  _setTiles(next, firstRects) {
    this._tiles = next;
    if (firstRects && !prefersReducedMotion()) {
      this.updateComplete.then(() => this._flip(firstRects));
    }
    this._emitChanged();
  }

  /** Capture current card rects keyed by url (optionally excluding one). */
  _captureRects(excludeUrl) {
    const map = new Map();
    for (const el of this.renderRoot?.querySelectorAll('.card[data-url]') || []) {
      const u = el.getAttribute('data-url');
      if (u && u !== excludeUrl) map.set(u, el.getBoundingClientRect());
    }
    return map;
  }

  /** Animate surviving cards from their old rect to the new one (move + resize). */
  _flip(firstRects) {
    for (const el of this.renderRoot.querySelectorAll('.card[data-url]')) {
      const u = el.getAttribute('data-url');
      const first = firstRects.get(u);
      if (!first) continue; // a brand-new card uses the CSS enter animation
      const last = el.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(first.width - last.width) < 0.5) continue;
      try {
        const a = animate(
          el,
          {
            transform: [`translate(${dx}px, ${dy}px)`, 'translate(0px, 0px)'],
            width: [first.width + 'px', last.width + 'px'],
            height: [first.height + 'px', last.height + 'px'],
          },
          { duration: 0.32, easing: [0.22, 1, 0.36, 1] }
        );
        const clear = () => {
          el.style.transform = '';
          el.style.width = '';
          el.style.height = '';
        };
        a.finished ? a.finished.then(clear).catch(clear) : setTimeout(clear, 380);
      } catch {
        el.style.transform = el.style.width = el.style.height = '';
      }
    }
  }

  _mark(url, patch) {
    this._tiles = this._tiles.map((t) => (t.url === url ? { ...t, ...patch } : t));
  }

  _tryPostByUrl(url) {
    const tile = this._tiles.find((t) => t.url === url);
    if (tile) this._tryPost(tile);
  }
  _tryPost(tile) {
    if (!this._loaded.has(tile.url)) return; // posted on load instead
    const quote = this._pending.get(tile.url);
    if (quote == null) return;
    const iframe = this.renderRoot.querySelector(`iframe[data-tile-url="${cssEscape(tile.url)}"]`);
    const win = iframe?.contentWindow;
    if (!win) return;
    try {
      win.postMessage({ type: 'gigi-highlight', quote }, tile.origin);
    } catch {
      /* ignore */
    }
  }

  _onIframeLoad(url) {
    this._loaded.add(url);
    // Keep the loading bar up for a minimum time so a fast load is still perceptible (#7).
    const since = this._loadingSince.get(url);
    const MIN = 500;
    const elapsed = since ? Date.now() - since : Infinity;
    if (elapsed < MIN) {
      setTimeout(() => {
        this._loadingSince.delete(url);
        this._mark(url, { loading: false });
      }, MIN - elapsed);
    } else {
      this._loadingSince.delete(url);
      this._mark(url, { loading: false });
    }
    this._tryPostByUrl(url);
  }
  _onIframeError(url) {
    this._mark(url, { errored: true, loading: false });
  }

  // Scrim activation / re-arm (scroll-isolation, #7).
  _activate(url) {
    this._interactive = url;
    this.updateComplete.then(() =>
      this.renderRoot.querySelector(`iframe[data-tile-url="${cssEscape(url)}"]`)?.focus()
    );
  }
  _onGridScroll() {
    if (this._interactive) this._interactive = null; // re-arm scrims
    this._syncScroll();
  }

  updated() {
    // Observe the grid for size changes (viewport resize, tile add/remove) and keep
    // the custom scroll indicator + edge fades in sync.
    const grid = this.renderRoot.querySelector('.grid');
    if (grid && this._observedGrid !== grid) {
      this._ro?.disconnect();
      this._ro = new ResizeObserver(() => this._syncScroll());
      this._ro.observe(grid);
      this._observedGrid = grid;
    }
    this._syncScroll();
  }

  /** Position the custom scroll thumb + edge fades to match the grid's scroll state. */
  _syncScroll() {
    const grid = this.renderRoot.querySelector('.grid');
    const track = this.renderRoot.querySelector('.vscroll');
    const thumb = this.renderRoot.querySelector('.vthumb');
    if (!grid || !track || !thumb) return;
    const sh = grid.scrollHeight;
    const ch = grid.clientHeight;
    const st = grid.scrollTop;
    const overflow = sh - ch > 2;
    this.toggleAttribute('data-up', overflow && st > 2);
    this.toggleAttribute('data-down', overflow && st + ch < sh - 2);
    if (!overflow) {
      track.hidden = true;
      return;
    }
    track.hidden = false;
    const trackH = track.clientHeight;
    const thumbH = Math.max(32, Math.round((trackH * ch) / sh));
    const maxTop = trackH - thumbH;
    const top = maxTop * (st / (sh - ch));
    thumb.style.height = thumbH + 'px';
    thumb.style.transform = `translateY(${Math.max(0, Math.min(maxTop, top))}px)`;
  }

  _thumbPointerDown(e) {
    e.preventDefault();
    e.stopPropagation();
    const grid = this.renderRoot.querySelector('.grid');
    const track = this.renderRoot.querySelector('.vscroll');
    const thumb = this.renderRoot.querySelector('.vthumb');
    if (!grid || !track || !thumb) return;
    const range = grid.scrollHeight - grid.clientHeight;
    const span = track.clientHeight - thumb.offsetHeight;
    const startY = e.clientY;
    const startScroll = grid.scrollTop;
    const move = (ev) => {
      grid.scrollTop = startScroll + ((ev.clientY - startY) * range) / (span || 1);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  _trackPointerDown(e) {
    if (e.target.classList?.contains('vthumb')) return; // the thumb handles its own drag
    const grid = this.renderRoot.querySelector('.grid');
    const track = this.renderRoot.querySelector('.vscroll');
    if (!grid || !track) return;
    const rect = track.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    grid.scrollTop = ratio * (grid.scrollHeight - grid.clientHeight);
  }

  _onWindowMessage(ev) {
    const data = ev?.data;
    if (!data || typeof data !== 'object') return;
    const tile = this._tiles.find((t) => t.origin && t.origin === ev.origin);
    if (!tile) return; // only messages from an open tile's framed page
    if (data.type === 'gigi-tile-result') {
      this.dispatchEvent(
        new CustomEvent('gigi-tile-result', { detail: data, bubbles: true, composed: true })
      );
    } else if (data.type === 'gigi-navigating') {
      // The framed page is navigating to a new URL (#7) — show its loading bar until load.
      this._mark(tile.url, { loading: true });
      this._loadingSince.set(tile.url, Date.now());
    }
  }

  // ── arrow-key navigation between tiles (#5) ───────────────────
  _onGridKeydown(e) {
    const NAV = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!NAV.includes(e.key)) return;
    // Only navigate when a CARD itself is focused (the roving-tabindex entry point) —
    // never hijack arrows inside an interactive page or on a control.
    const active = this.renderRoot.activeElement;
    if (!active || !active.classList?.contains('card')) return;
    const cards = [...this.renderRoot.querySelectorAll('.card')];
    const cur = cards.indexOf(active);
    if (cur === -1) return;
    let target = null;
    if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = cards.length - 1;
    else target = this._nearestCard(cards, cur, e.key);
    if (target == null || target === cur) return;
    e.preventDefault();
    this._activeIndex = target;
    cards[target].focus();
  }

  /** Index of the nearest card in the arrow direction (geometry-based, any column count). */
  _nearestCard(cards, cur, key) {
    const r = cards[cur].getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    let best = null;
    let bestD = Infinity;
    cards.forEach((c, i) => {
      if (i === cur) return;
      const b = c.getBoundingClientRect();
      const dx = b.left + b.width / 2 - cx;
      const dy = b.top + b.height / 2 - cy;
      const inDir =
        key === 'ArrowRight' ? dx > 4 : key === 'ArrowLeft' ? dx < -4 : key === 'ArrowDown' ? dy > 4 : dy < -4;
      if (!inDir) return;
      const primary = horizontal ? Math.abs(dx) : Math.abs(dy);
      const cross = horizontal ? Math.abs(dy) : Math.abs(dx);
      const d = primary + cross * 2; // prefer same row/column
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  _announceCount(verb) {
    const n = this.count;
    this._status = n ? `${n} city page${n === 1 ? '' : 's'} ${verb}.` : 'No pages open.';
  }

  _emitChanged() {
    this.dispatchEvent(
      new CustomEvent('gigi-tiles-changed', {
        detail: { count: this.count },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    if (!this._tiles.length) {
      return html`<div class="sr-only" aria-live="polite">${this._status}</div>`;
    }
    const active = Math.min(Math.max(this._activeIndex, 0), this._tiles.length - 1);
    return html`
      <section class="tiles" part="tile-grid" aria-label="Related city pages Gigi opened">
        <h2 class="sr-only">Related city pages (use arrow keys to move between them)</h2>
        <div class="fade fade-top"></div>
        <div class="grid" role="list" @scroll=${this._onGridScroll} @keydown=${this._onGridKeydown}>
          ${repeat(
            this._tiles,
            (t) => t.url,
            (t, i) => this._card(t, i === active)
          )}
        </div>
        <div class="fade fade-bottom"></div>
        <div class="vscroll" hidden @pointerdown=${this._trackPointerDown}>
          <div class="vthumb" @pointerdown=${this._thumbPointerDown}></div>
        </div>
        <div class="sr-only" aria-live="polite">${this._status}</div>
      </section>
    `;
  }

  _card(t, isActive) {
    const interactive = this._interactive === t.url;
    return html`
      <div
        class="card ${t.leaving ? 'leaving' : ''} ${interactive ? 'interactive' : ''}"
        part="tile"
        data-url=${t.url}
        role="listitem"
        aria-label=${t.title}
        tabindex=${isActive ? '0' : '-1'}
      >
        <div class="card-head">
          <span class="card-title" title=${t.title}>${t.title}</span>
          ${t.highlighted
            ? html`<span class="hl-badge" title="A verified quote is highlighted on this page">✶ quote</span>`
            : nothing}
          <a
            class="icon-btn"
            data-tile-url=${t.url}
            href=${t.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label=${`Open ${t.title} in a new tab`}
            title=${`Open ${t.title} in a new tab`}
          >
            ${OPEN_ICON}
          </a>
          <button
            type="button"
            class="icon-btn icon-close"
            @click=${() => this._close(t.url)}
            aria-label=${`Close ${t.title}`}
            title=${`Close ${t.title}`}
          >
            ${CLOSE_ICON}
          </button>
        </div>
        <div class="frame-wrap">
          ${t.loading ? html`<div class="loadbar" role="progressbar" aria-label="Loading page"></div>` : nothing}
          ${t.errored
            ? html`<div class="fallback">
                This page can’t be shown here.
                <a href=${t.url} target="_blank" rel="noopener noreferrer">Open ${t.title} in a new tab ↗</a>
              </div>`
            : html`
                <iframe
                  data-tile-url=${t.url}
                  title=${`${t.title} — opened by Gigi`}
                  src=${t.src}
                  referrerpolicy="no-referrer"
                  @load=${() => this._onIframeLoad(t.url)}
                  @error=${() => this._onIframeError(t.url)}
                ></iframe>
                ${this.scrim && !interactive
                  ? html`<button
                      class="scrim"
                      @click=${() => this._activate(t.url)}
                      aria-label=${`Interact with ${t.title} (scrolls the page)`}
                    >
                      <span class="scrim-hint">Click to interact</span>
                    </button>`
                  : nothing}
              `}
        </div>
      </div>
    `;
  }
}

// Inline SVG icons (no Font Awesome dependency; self-contained, CSP/proxy-safe).
const OPEN_ICON = html`<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M14 4h6v6" />
  <path d="M20 4l-9 9" />
  <path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
</svg>`;
const CLOSE_ICON = html`<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M6 6l12 12" />
  <path d="M18 6L6 18" />
</svg>`;

function cssEscape(v) {
  if (window.CSS && CSS.escape) return CSS.escape(v);
  return String(v).replace(/["\\]/g, '\\$&');
}

if (!customElements.get('gigi-tiles')) {
  customElements.define('gigi-tiles', GigiTiles);
}
