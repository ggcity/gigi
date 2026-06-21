import { LitElement, html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { styles } from './styles.js';
import { renderMarkdown, extractCitations, announcementText, toPlainText } from './markdown.js';
import { announce } from './live-region.js';
import { debug, trace, setVerbose } from './debug.js';
import './types.js';

let _seq = 0;
const nextId = () => `m${++_seq}`;

const ROLE_LABEL = {
  user: 'You said:',
  assistant: 'Gigi said:',
  system: 'Gigi:',
};

/** Speaker prefix used when copying the whole conversation. */
const COPY_SPEAKER = { user: 'You', assistant: 'Gigi', system: 'Gigi' };

/**
 * Write `text` to the clipboard. Uses the async Clipboard API, falling back to a
 * hidden-textarea + execCommand for insecure contexts. Resolves to success.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function writeClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * `<gigi-chat>` — a standalone, transport-agnostic, WCAG 2.1 AA chat surface.
 *
 * It renders the conversation and nothing else: no WebSocket, no tiles, no
 * business logic. A host app (the Gigi shell) drives it imperatively through the
 * public methods below and observes it through composed CustomEvents:
 *   - `gigi-submit`            {text}                         user sent a message
 *   - `gigi-citation-detected` {url, text}                    a new link appeared mid-stream
 *   - `gigi-answer-complete`   {answer, citations[]}          answer finalized
 *   - `gigi-citation-click`    {url, text}                    user activated a citation
 *
 * All events are `bubbles:true, composed:true` so they cross the shadow boundary.
 */
export class GigiChat extends LitElement {
  static styles = styles;

  static properties = {
    /** Accessible label for the input. */
    inputLabel: { type: String, attribute: 'input-label' },
    /** "verbose" raises dev logging to per-token detail (dev builds only). */
    debug: { type: String },
    /** Show the built-in conversation toolbar (New chat + Copy conversation). */
    showToolbar: { type: Boolean, attribute: 'show-toolbar' },
    /** Remove the per-message Copy button (it is shown by default). */
    hideMessageCopy: { type: Boolean, attribute: 'hide-message-copy' },
    /** Visible narration line position: "top" (default) | "bottom" (above input). */
    narrationPosition: { type: String, attribute: 'narration-position', reflect: true },

    _messages: { state: true },
    _streamingId: { state: true },
    _narration: { state: true },
    _busy: { state: true },
    _copiedId: { state: true },
  };

  constructor() {
    super();
    this.inputLabel = 'Ask a question about City of Garden Grove services';
    this.debug = '';
    this.showToolbar = false;
    this.hideMessageCopy = false;
    this.narrationPosition = 'top';
    /** @type {Array<Object>} */
    this._messages = [];
    this._streamingId = null;
    this._narration = '';
    this._busy = false;
    this._copiedId = null;

    // Non-reactive turn state.
    this._emittedCitationUrls = new Set();
    /** @type {import('./types.js').CitationClickHandler | null} */
    this._citationClickHandler = null;
    this._renderScheduled = false;
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.debug === 'verbose') setVerbose(true);
    debug('connected');
  }

  // ─────────────────────────────────────────── public API ───

  /** Render a user message bubble. Does NOT emit `gigi-submit`. */
  appendUserMessage(text) {
    debug('appendUserMessage', text);
    this._messages = [
      ...this._messages,
      { id: nextId(), role: 'user', status: 'complete', text: String(text ?? '') },
    ];
    this._scrollSoon();
  }

  /** Open a new in-flight assistant message; mark the turn busy and announce it. */
  beginAssistantMessage() {
    debug('beginAssistantMessage');
    this._busy = true;
    this._emittedCitationUrls = new Set();
    const id = nextId();
    this._streamingId = id;
    this._messages = [
      ...this._messages,
      { id, role: 'assistant', status: 'streaming', markdownBuffer: '', html: '', citations: [] },
    ];
    this._narration = 'Gigi is responding…';
    this._announce('live-narration', this._narration, 'narration');
    this._scrollSoon();
  }

  /** Append a raw-markdown token chunk to the in-flight message (coalesced render). */
  appendAssistantToken(text) {
    const msg = this._streamingMessage();
    if (!msg) {
      // Defensive: a token before begin — open a message implicitly.
      this.beginAssistantMessage();
      return this.appendAssistantToken(text);
    }
    msg.markdownBuffer += String(text ?? '');
    trace('token', JSON.stringify(text));
    this._scheduleStreamRender();
  }

  /**
   * Finalize the in-flight message. Pass `answer_done.answer` for an authoritative
   * final render (defends against a dropped/duplicated token). Clears busy and
   * fires the single answer announcement + `gigi-answer-complete`.
   * @param {string} [fullText]
   */
  endAssistantMessage(fullText) {
    const msg = this._streamingMessage();
    if (!msg) {
      this._busy = false;
      return;
    }
    this._renderScheduled = false;
    if (typeof fullText === 'string') msg.markdownBuffer = fullText;
    msg.html = renderMarkdown(msg.markdownBuffer);
    msg.citations = extractCitations(msg.html);
    msg.status = 'complete';
    this._emitNewCitations(msg.citations);
    this._streamingId = null;
    this._busy = false;
    this._narration = '';
    this._announce('live-narration', '', 'narration');
    this._announce('live-answer', announcementText(msg.html), 'answer');
    debug('endAssistantMessage', { citations: msg.citations.length });
    this._dispatch('gigi-answer-complete', { answer: msg.markdownBuffer, citations: msg.citations });
    this.requestUpdate();
    this._scrollSoon();
  }

  /** Route process status to the visible status line and the narration live region. */
  setNarration(text) {
    debug('setNarration', text);
    this._narration = String(text ?? '');
    this._announce('live-narration', this._narration, 'narration');
  }

  /**
   * Render an explicit accessible "Sources" list under the latest answer. Clicks
   * delegate to `onClick` (and also dispatch `gigi-citation-click`).
   * @param {import('./types.js').Citation[]} items
   * @param {import('./types.js').CitationClickHandler} [onClick]
   */
  renderCitations(items, onClick) {
    debug('renderCitations', items?.length ?? 0);
    if (typeof onClick === 'function') this._citationClickHandler = onClick;
    const target = this._lastAssistantMessage();
    if (target) {
      target.sources = Array.isArray(items) ? items : [];
      this.requestUpdate();
      this._scrollSoon();
    }
  }

  /**
   * Render an honest not-found with a human-redirect block. Also used for
   * throttle/oversized rejects (same wire shape). Announces once; clears busy.
   * @param {string} text
   * @param {import('./types.js').NotFoundRedirect} redirect
   */
  showNotFound(text, redirect) {
    debug('showNotFound', text);
    this._discardStreaming();
    this._messages = [
      ...this._messages,
      { id: nextId(), role: 'assistant', status: 'notFound', text: String(text ?? ''), redirect },
    ];
    this._endTurn();
    this._announce('live-answer', String(text ?? ''), 'answer');
    this._scrollSoon();
  }

  /** Render a non-fatal error message; clears busy; announces once. */
  showError(text) {
    debug('showError', text);
    this._discardStreaming();
    this._messages = [
      ...this._messages,
      { id: nextId(), role: 'assistant', status: 'error', text: String(text ?? '') },
    ];
    this._endTurn();
    this._announce('live-answer', String(text ?? ''), 'answer');
    this._scrollSoon();
  }

  /** Clear the conversation (silent programmatic clear). */
  reset() {
    debug('reset');
    this._messages = [];
    this._streamingId = null;
    this._narration = '';
    this._busy = false;
    this._copiedId = null;
    this._emittedCitationUrls = new Set();
    this._announce('live-answer', '', 'answer');
    this._announce('live-narration', '', 'narration');
  }

  /**
   * Start a fresh conversation: clear the transcript and emit `gigi-new-session`
   * so the host can also reset the backend session. Focus returns to the input.
   */
  newSession() {
    debug('newSession');
    this.reset();
    this._dispatch('gigi-new-session', {});
    this.updateComplete.then(() => this.renderRoot?.querySelector('.input')?.focus());
  }

  /**
   * Copy the whole conversation to the clipboard as plain text ("You: …" /
   * "Gigi: …" blocks; links flattened as `text (url)`). Announces the result and
   * emits `gigi-copy {scope:'conversation', text}`.
   * @returns {Promise<boolean>}
   */
  async copyConversation() {
    const text = this._messages
      .map((m) => `${COPY_SPEAKER[m.role] || 'Gigi'}: ${this._messageText(m)}`)
      .join('\n\n');
    const ok = await writeClipboard(text);
    debug('copyConversation', ok);
    this._announce('live-action', ok ? 'Conversation copied.' : 'Copy failed.', 'action');
    if (ok) this._dispatch('gigi-copy', { scope: 'conversation', text });
    return ok;
  }

  // ─────────────────────────────────────────── internals ───

  /** Plain-text form of a message for the clipboard. */
  _messageText(m) {
    return m.html != null ? toPlainText(m.html) : String(m.text ?? '');
  }

  /** Copy a single message; announce + flash the button + emit `gigi-copy`. */
  async _copyMessage(id) {
    const m = this._messages.find((x) => x.id === id);
    if (!m) return;
    const text = this._messageText(m);
    const ok = await writeClipboard(text);
    debug('copyMessage', id, ok);
    this._announce('live-action', ok ? 'Response copied.' : 'Copy failed.', 'action');
    if (ok) {
      this._dispatch('gigi-copy', { scope: 'message', text });
      this._copiedId = id;
      setTimeout(() => {
        if (this._copiedId === id) this._copiedId = null;
      }, 1500);
    }
  }

  _streamingMessage() {
    return this._messages.find((m) => m.id === this._streamingId) ?? null;
  }

  _lastAssistantMessage() {
    for (let i = this._messages.length - 1; i >= 0; i--) {
      if (this._messages[i].role === 'assistant') return this._messages[i];
    }
    return null;
  }

  _discardStreaming() {
    if (this._streamingId) {
      this._messages = this._messages.filter((m) => m.id !== this._streamingId);
      this._streamingId = null;
    }
    this._renderScheduled = false;
  }

  _endTurn() {
    this._streamingId = null;
    this._busy = false;
    this._narration = '';
    this._announce('live-narration', '', 'narration');
  }

  _scheduleStreamRender() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    const run = () => {
      this._renderScheduled = false;
      this._renderStream();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else queueMicrotask(run);
  }

  _renderStream() {
    const msg = this._streamingMessage();
    if (!msg) return;
    msg.html = renderMarkdown(msg.markdownBuffer);
    const citations = extractCitations(msg.html);
    msg.citations = citations;
    this._emitNewCitations(citations);
    this.requestUpdate();
    this._scrollSoon();
  }

  /** Dispatch `gigi-citation-detected` for any URL not yet seen this turn. */
  _emitNewCitations(citations) {
    for (const c of citations) {
      if (this._emittedCitationUrls.has(c.url)) continue;
      this._emittedCitationUrls.add(c.url);
      this._dispatch('gigi-citation-detected', { url: c.url, text: c.text });
    }
  }

  _activateCitation(citation) {
    debug('citation-click', citation.url);
    this._dispatch('gigi-citation-click', citation);
    if (this._citationClickHandler) {
      try {
        this._citationClickHandler(citation);
      } catch (err) {
        trace('citation handler threw', err);
      }
    }
  }

  _dispatch(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  _announce(id, text, label) {
    const region = this.renderRoot && this.renderRoot.querySelector(`#${id}`);
    if (region) {
      announce(region, text, label);
    } else {
      this.updateComplete.then(() => {
        const r = this.renderRoot && this.renderRoot.querySelector(`#${id}`);
        announce(r, text, label);
      });
    }
  }

  _scrollSoon() {
    this.updateComplete.then(() => {
      const log = this.renderRoot && this.renderRoot.querySelector('.log');
      if (log) log.scrollTop = log.scrollHeight;
    });
  }

  // ─────────────────────────────────────────── input ───

  _onInputKeydown(e) {
    // Enter submits; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._submit();
    }
  }

  _onSubmit(e) {
    e.preventDefault();
    this._submit();
  }

  _submit() {
    if (this._busy) {
      trace('submit ignored: busy');
      return;
    }
    const input = this.renderRoot.querySelector('.input');
    const text = (input?.value ?? '').trim();
    if (!text) return;
    // Optimistically show the user's bubble, then emit for the host to forward.
    this.appendUserMessage(text);
    if (input) input.value = '';
    this._dispatch('gigi-submit', { text });
  }

  _onLogClick(e) {
    const a = e.composedPath().find((n) => n.tagName === 'A' && n.hasAttribute?.('href'));
    if (!a) return;
    e.preventDefault();
    this._activateCitation({ url: a.getAttribute('href'), text: (a.textContent || '').trim() });
  }

  _onLogKeydown(e) {
    if (e.key !== ' ' && e.key !== 'Spacebar') return;
    const a = e.composedPath().find((n) => n.tagName === 'A' && n.hasAttribute?.('href'));
    if (!a) return;
    e.preventDefault();
    this._activateCitation({ url: a.getAttribute('href'), text: (a.textContent || '').trim() });
  }

  // ─────────────────────────────────────────── render ───

  render() {
    return html`
      ${this.showToolbar ? this._toolbarTemplate() : ''}

      <!-- Visible process-status line (companion to the narration live region). -->
      <div class="status" part="status">${this._narration}</div>

      <!-- Live regions: answer is atomic + announced once; narration/action transient. -->
      <div id="live-answer" class="sr-only" aria-live="polite" aria-atomic="true"></div>
      <div id="live-narration" class="sr-only" aria-live="polite"></div>
      <div id="live-action" class="sr-only" aria-live="polite"></div>

      <!--
        Transcript. role=log with aria-live=off: additions are announced via the
        dedicated answer region only, never auto-announced here (prevents the
        per-token / double-announcement the spec forbids).
      -->
      <div
        class="log"
        part="message-list"
        role="log"
        aria-label="Conversation"
        aria-live="off"
        tabindex="0"
        @click=${this._onLogClick}
        @keydown=${this._onLogKeydown}
      >
        ${repeat(this._messages, (m) => m.id, (m) => this._messageTemplate(m))}
      </div>

      ${this._composerTemplate()}
    `;
  }

  _messageTemplate(m) {
    const classes = [
      'msg',
      `msg-${m.role}`,
      m.status === 'streaming' ? 'streaming' : '',
      m.status === 'error' ? 'is-error' : '',
    ]
      .filter(Boolean)
      .join(' ');

    // Expose the bubble row via ::part so a host (the Phase 3 shell) can theme it
    // and drive an entrance animation without forking. The default ships no bubble
    // entrance — the aesthetic is the shell's to choose (still reduce-motion gated).
    const parts = ['message', `message-${m.role}`, m.status === 'streaming' ? 'streaming' : '']
      .filter(Boolean)
      .join(' ');

    return html`
      <div class="row row-${m.role}" part="row row-${m.role}">
        <span class="avatar" part="avatar avatar-${m.role}" aria-hidden="true"></span>
        <div class=${classes} part=${parts} role="group" aria-label=${ROLE_LABEL[m.role] || 'Message'}>
          <span class="sr-only role-tag">${ROLE_LABEL[m.role] || 'Message:'}</span>
          <div class="content" part="message-content">
            ${m.html != null ? unsafeHTML(m.html) : html`<p>${m.text}</p>`}
          </div>
          ${m.status === 'streaming' ? html`<span class="caret" part="caret" aria-hidden="true"></span>` : ''}
          ${m.sources && m.sources.length ? this._sourcesTemplate(m.sources) : ''}
          ${m.redirect ? this._redirectTemplate(m.redirect) : ''}
          ${this._copyButtonTemplate(m)}
        </div>
      </div>
    `;
  }

  /** Per-message Copy button (assistant, non-streaming, unless hidden). */
  _copyButtonTemplate(m) {
    if (this.hideMessageCopy || m.role !== 'assistant' || m.status === 'streaming') return '';
    const copied = this._copiedId === m.id;
    return html`
      <button
        type="button"
        class="copy"
        part="copy"
        aria-label="Copy response"
        @click=${() => this._copyMessage(m.id)}
      >
        ${copied ? 'Copied' : 'Copy'}
      </button>
    `;
  }

  _toolbarTemplate() {
    return html`
      <div class="toolbar" role="toolbar" aria-label="Conversation actions" part="toolbar">
        <button type="button" @click=${() => this.newSession()}>New chat</button>
        <button type="button" @click=${() => this.copyConversation()}>Copy conversation</button>
      </div>
    `;
  }

  _sourcesTemplate(items) {
    return html`
      <div class="sources" part="sources">
        <h3>Sources</h3>
        <ol>
          ${items.map(
            (c) => html`<li><a href=${c.url}>${c.text || c.url}</a></li>`
          )}
        </ol>
      </div>
    `;
  }

  _redirectTemplate(r) {
    return html`
      <div class="redirect" part="redirect">
        ${r.url ? html`<a href=${r.url}>${r.label || 'Contact the City'}</a>` : html`<span>${r.label}</span>`}
        ${r.phone ? html` · <a href=${`tel:${r.phone.replace(/[^\d+]/g, '')}`}>${r.phone}</a>` : ''}
      </div>
    `;
  }

  _composerTemplate() {
    const disabled = this._busy;
    return html`
      <form @submit=${this._onSubmit} novalidate>
        <textarea
          class="input"
          part="input"
          rows="1"
          aria-label=${this.inputLabel}
          aria-disabled=${disabled ? 'true' : 'false'}
          ?readonly=${disabled}
          @keydown=${this._onInputKeydown}
        ></textarea>
        <button
          type="submit"
          class="send"
          part="send-button"
          aria-disabled=${disabled ? 'true' : 'false'}
        >
          Send
        </button>
      </form>
    `;
  }
}

if (!customElements.get('gigi-chat')) {
  customElements.define('gigi-chat', GigiChat);
}
