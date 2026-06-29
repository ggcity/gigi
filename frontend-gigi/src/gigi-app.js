import { LitElement, html, nothing } from 'lit';
import '@ggcity/gigi-chat'; // registers <gigi-chat>
import './tiles.js'; // registers <gigi-tiles>
import { GigiSocket } from './ws-client.js';
import { animateDock, prefersReducedMotion } from './morph.js';
import { guardTileUrl, defrag, buildDeepLink, DEFAULT_ALLOWED_TILE_HOSTS } from './urls.js';
import { styles, CHAT_BINDINGS } from './styles.js';

const HOLDING_NARRATION = 'Looking this up on the city website…';
const HERO_OUT_MS = 240;
// Below this viewport width the shell is "mobile": chat full-width, tiles hidden.
// Mirrors the 900px media query in styles.js (custom props can't be used in @media).
const MOBILE_BP = 900;

const isMobile = () => {
  try {
    return window.matchMedia(`(max-width: ${MOBILE_BP}px)`).matches;
  } catch {
    return false;
  }
};

/**
 * <gigi-app> — the Gigi application shell.
 *
 * Owns the WebSocket (GigiSocket), embeds and imperatively drives the standalone
 * <gigi-chat>, manages the tile grid (<gigi-tiles>) and the centered→side morph, and
 * shows a branded hero on the initial screen. It does NOT parse the answer markdown —
 * tiles come from the chat module's `gigi-answer-complete` citation set (which is the
 * full, finished, deduped parse; using it instead of the mid-stream
 * `gigi-citation-detected` avoids opening tiles for partial/auto-linked URLs).
 */
export class GigiApp extends LitElement {
  static styles = styles;

  static properties = {
    theme: { type: String, attribute: 'data-theme', reflect: true },
    maxTiles: { type: Number, attribute: 'max-tiles' },
    scrim: { type: Boolean }, // opt-in click-to-interact tile scrim (forwarded to <gigi-tiles>)
    _layout: { state: true },
    _started: { state: true },
    _heroLeaving: { state: true },
  };

  constructor() {
    super();
    this.theme = undefined;
    this.maxTiles = 4;
    this.scrim = false;
    this._layout = 'centered';
    this._started = false;
    this._heroLeaving = false;
    this._streaming = false;
    this._supplementing = false;
    this._allowedHosts = DEFAULT_ALLOWED_TILE_HOSTS;
    // Verified highlight quotes, keyed by the (defragged) page they land on, so a mobile
    // citation tap can build a `#gigi=` deep link. Kept across turns (a quote is the page's
    // own substring, stable regardless of which question surfaced it); cleared on new session.
    this._quotes = new Map();

    this.socket = new GigiSocket({
      onNarration: (t) => this._chat?.setNarration(t),
      onToken: (t) => this._onToken(t),
      onDone: (a) => this._onDone(a),
      onSupplementStart: (t) => this._onSupplementStart(t),
      onSupplementToken: (t) => this._chat?.appendAssistantToken(t),
      onSupplementDone: (a) => this._onSupplementDone(a),
      onHighlight: ({ url, quote, final_url }) => this._onHighlight(url, quote, final_url),
      onNotFound: (text, redirect) => this._onNotFound(text, redirect),
      onError: (text) => this._onError(text),
    });
  }

  firstUpdated() {
    this._chat = this.renderRoot.querySelector('gigi-chat');
    this._tilesEl = this.renderRoot.querySelector('gigi-tiles');
    this._chatPane = this.renderRoot.querySelector('.chat-pane');
    this._tilesPane = this.renderRoot.querySelector('.tiles-pane');
    if (this._tilesEl) this._tilesEl.maxTiles = this.maxTiles;

    this._chat.addEventListener('gigi-submit', (e) => this._onSubmit(e.detail.text));
    this._chat.addEventListener('gigi-answer-complete', (e) => this._onAnswerComplete(e.detail));
    this._chat.addEventListener('gigi-citation-click', (e) => this._onCitationClick(e.detail));
    this._chat.addEventListener('gigi-new-session', () => this._onNewSession());

    this._tilesEl.addEventListener('gigi-tiles-changed', (e) => this._onTilesChanged(e.detail));
    this._tilesEl.addEventListener('gigi-tile-result', (e) => this.socket.sendTileResult(e.detail));

    // Autofocus the chat input on first load (single primary input). Wait for the
    // chat component to finish its first render so the textarea exists.
    Promise.resolve(this._chat.updateComplete).then(() =>
      this._chat.renderRoot?.querySelector('.input')?.focus()
    );
  }

  disconnectedCallback() {
    this.socket.close();
    super.disconnectedCallback();
  }

  // ── chat → backend ────────────────────────────────────────────
  _onSubmit(text) {
    this._streaming = false;
    this._supplementing = false;
    if (!this._started) {
      if (prefersReducedMotion()) {
        this._started = true;
      } else {
        this._heroLeaving = true; // play the hero-out animation, then remove it
        setTimeout(() => {
          this._heroLeaving = false;
          this._started = true;
        }, HERO_OUT_MS);
      }
    }
    this._chat.setNarration(HOLDING_NARRATION); // holding state immediately (V3.md §2.3)
    this.socket.query(text);
  }

  // ── backend → chat ────────────────────────────────────────────
  _onToken(t) {
    if (!this._streaming) {
      this._chat.beginAssistantMessage();
      this._streaming = true;
    }
    this._chat.appendAssistantToken(t);
  }
  _onDone(answer) {
    if (this._streaming) this._chat.endAssistantMessage(answer);
    this._streaming = false;
  }
  // An additive supplement streamed after answer_done: a second assistant bubble
  // beneath the first answer (which stays on screen), introduced by a transient
  // "Let me find that…" narration.
  _onSupplementStart(text) {
    this._chat.setNarration(text || 'Let me find that…');
    this._chat.beginAssistantMessage();
    this._streaming = true;
    this._supplementing = true;
  }
  _onSupplementDone(answer) {
    if (this._streaming) this._chat.endAssistantMessage(answer);
    this._streaming = false;
  }
  _onNotFound(text, redirect) {
    this._chat.showNotFound(text, redirect);
    this._streaming = false;
  }
  _onError(text) {
    this._chat.showError(text);
    this._streaming = false;
  }

  // ── citations → tiles (from the authoritative finished answer) ──
  _onAnswerComplete({ citations }) {
    // Only frame pure http(s) allow-listed links; mailto:/tel:/off-list are ignored.
    const tileable = (citations || []).filter((c) => guardTileUrl(c.url, this._allowedHosts).ok);
    if (this._supplementing) {
      // The supplement is additive: its new page joins the existing tiles rather
      // than replacing them (the original answer and its tiles stay on screen).
      this._supplementing = false;
      for (const c of tileable) this._tilesEl.focusOrOpen({ url: c.url, title: c.text });
      return;
    }
    // A new cited answer replaces the tiles; an answer that cites nothing keeps them.
    if (tileable.length) {
      this._tilesEl.openTiles(tileable.map((c) => ({ url: c.url, title: c.text })));
    }
  }
  // Remember the verified quote keyed by the page it lands on (prefer the post-redirect
  // final_url — that is the page the user actually opens), then highlight the desktop tile.
  _onHighlight(url, quote, final_url) {
    if (quote) {
      const key = defrag(final_url || url);
      if (key) this._quotes.set(key, quote);
    }
    this._tilesEl?.highlight(url, quote, final_url);
  }
  _onCitationClick({ url, text }) {
    if (guardTileUrl(url, this._allowedHosts).ok) {
      if (isMobile()) {
        // Mobile: there are no tiles. Open the city page in a NEW tab with the verified
        // quote in a `#gigi=` fragment so the companion highlights it there, and keep this
        // conversation alive in the original tab (no service worker restores it). V3.md §2.9.
        const link = buildDeepLink(url, this._quotes.get(defrag(url)));
        window.open(link, '_blank', 'noopener');
      } else {
        this._tilesEl.focusOrOpen({ url, title: text });
      }
    } else if (/^(mailto:|tel:)/i.test(url)) {
      window.location.href = url; // let the OS handle mail/dialer
    } else {
      window.open(url, '_blank', 'noopener'); // external http(s) → new tab
    }
  }
  _onNewSession() {
    this.socket.resetSession();
    this._tilesEl.clear();
    this._quotes.clear();
    this._started = false;
    this._streaming = false;
    this._supplementing = false;
  }

  // ── layout / morph ────────────────────────────────────────────
  async _onTilesChanged({ count }) {
    const next = count > 0 ? 'side' : 'centered';
    if (next === this._layout) return;
    const chat = this._chatPane;
    // On mobile the CSS hides the tile pane and keeps the chat full-width; skip the
    // dock morph so it doesn't fight the layout (reduced-motion also skips it).
    const skipMorph = prefersReducedMotion() || isMobile();
    const first = chat ? chat.getBoundingClientRect() : null;
    this._layout = next;
    await this.updateComplete;
    if (!skipMorph && chat && first) {
      const last = chat.getBoundingClientRect();
      animateDock(chat, this._tilesPane, first, last, { toSide: next === 'side' });
    }
    // Returning to centered (last tile closed): keep the user in control.
    if (next === 'centered') this._chat?.renderRoot?.querySelector('.input')?.focus();
  }

  render() {
    const showHero = !this._started;
    const chatStyle = `${CHAT_BINDINGS};height:${this._started ? '100%' : 'auto'}`;
    return html`
      <div class="shell ${this._layout} ${this._started ? 'started' : ''}" part="shell">
        <div class="chat-pane" part="chat-pane">
          ${showHero ? this._hero() : nothing}
          <gigi-chat
            part="chat"
            narration-position="bottom"
            data-theme=${this.theme || nothing}
            style=${chatStyle}
          ></gigi-chat>
        </div>
        <div class="tiles-pane" part="tiles">
          <gigi-tiles max-tiles=${this.maxTiles} ?scrim=${this.scrim}></gigi-tiles>
        </div>
      </div>
    `;
  }

  _hero() {
    return html`
      <div class="hero ${this._heroLeaving ? 'leaving' : ''}" part="hero">
        <svg class="hero-logo" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <rect x="6" y="8" width="52" height="40" rx="12" fill="currentColor" />
          <path d="M18 47 L18 59 L31 47 Z" fill="currentColor" />
          <circle cx="24" cy="28" r="3.6" fill="#fff" />
          <circle cx="32" cy="28" r="3.6" fill="#fff" />
          <circle cx="40" cy="28" r="3.6" fill="#fff" />
        </svg>
        <h1 class="hero-title">Gigi</h1>
        <p class="hero-tag">
          Ask about City of Garden Grove services and information.
        </p>
      </div>
    `;
  }
}

if (!customElements.get('gigi-app')) {
  customElements.define('gigi-app', GigiApp);
}
