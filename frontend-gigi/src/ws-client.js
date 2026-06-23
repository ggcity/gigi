/**
 * GigiSocket — the shell's WebSocket client to the Phase 1 backend.
 *
 * No DOM: it parses the backend event protocol (backend/app.py, backend/orchestrator.py)
 * and hands typed values to host callbacks, so it is unit-testable in isolation.
 *
 * Backend → client events (each also carries `interaction_id`):
 *   session {session_id} · narration {text} · answer_token {text} ·
 *   answer_done {answer} · highlight {url, quote} ·
 *   not_found {text, redirect_to_human:{label,url,phone}} · error {text}
 * Client → backend: {type:'query', text, session_id?} and {type:'tile_result', …}.
 *
 * The URL is RELATIVE (`/ws`) with the scheme derived from the page, so the exact
 * same path works whether the bundle is served by the Vite dev proxy or by the
 * backend itself. The session id from the first `session` event is replayed on every
 * subsequent query so the backend can thread conversation history.
 */

/**
 * @typedef {Object} GigiSocketHandlers
 * @property {(sessionId: string) => void} [onSession]
 * @property {(text: string) => void} [onNarration]
 * @property {(text: string) => void} [onToken]
 * @property {(answer: string) => void} [onDone]
 * @property {(h: {url: string, quote: string}) => void} [onHighlight]
 * @property {(text: string, redirect: any) => void} [onNotFound]
 * @property {(text: string) => void} [onError]
 * @property {(open: boolean) => void} [onConnectionChange]
 */

export class GigiSocket {
  /**
   * @param {GigiSocketHandlers} handlers
   * @param {{ url?: string, WebSocketImpl?: typeof WebSocket, maxBackoffMs?: number }} [opts]
   */
  constructor(handlers = {}, opts = {}) {
    this.handlers = handlers;
    this._WebSocket = opts.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this._url = opts.url || defaultWsUrl();
    this._maxBackoffMs = opts.maxBackoffMs ?? 8000;

    /** @type {WebSocket|null} */
    this._ws = null;
    this._sessionId = null;
    this._ready = null; // Promise that resolves when the socket is OPEN
    this._wantOpen = false; // intent: should we (re)connect?
    this._turnActive = false; // a query is in flight (answer not yet terminal)
    this._retries = 0;
    this._reconnectTimer = null;
  }

  get sessionId() {
    return this._sessionId;
  }

  /** Forget the session so the next turn starts a fresh backend conversation. */
  resetSession() {
    this._sessionId = null;
  }

  /** Open (or reuse) the connection. Resolves when OPEN. */
  connect() {
    this._wantOpen = true;
    if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1)) {
      return this._ready || Promise.resolve();
    }
    if (!this._WebSocket) return Promise.reject(new Error('no WebSocket implementation'));

    this._ready = new Promise((resolve, reject) => {
      let settled = false;
      const ws = new this._WebSocket(this._url);
      this._ws = ws;
      ws.onopen = () => {
        this._retries = 0;
        settled = true;
        this.handlers.onConnectionChange?.(true);
        resolve();
      };
      ws.onmessage = (ev) => this._handleData(ev.data);
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('websocket error'));
        }
      };
      ws.onclose = () => this._handleClose();
    });
    return this._ready;
  }

  /**
   * Send a user query, opening the connection if needed. Marks the turn active so a
   * mid-turn disconnect can surface a clean error.
   * @param {string} text
   */
  async query(text) {
    this._turnActive = true;
    try {
      await this.connect();
    } catch (e) {
      this._turnActive = false;
      this.handlers.onError?.('Could not reach Gigi. Please try again.');
      return;
    }
    this._send({ type: 'query', text, session_id: this._sessionId || undefined });
  }

  /** Forward a companion DOM-miss report (Phase 4 acts on it; backend logs it now). */
  sendTileResult(detail) {
    if (this._ws && this._ws.readyState === 1) {
      this._send({ ...detail, type: 'tile_result', session_id: this._sessionId || undefined });
    }
  }

  /** Stop reconnecting and close. */
  close() {
    this._wantOpen = false;
    clearTimeout(this._reconnectTimer);
    if (this._ws) {
      try {
        this._ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  _send(obj) {
    this._ws.send(JSON.stringify(obj));
  }

  /**
   * Parse and dispatch one inbound frame. Exposed (underscore-named but reachable) so
   * unit tests can feed scripted JSON without a live socket.
   * @param {string} data
   */
  _handleData(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // ignore non-JSON noise
    }
    switch (msg.type) {
      case 'session':
        if (msg.session_id) this._sessionId = msg.session_id;
        this.handlers.onSession?.(msg.session_id);
        break;
      case 'narration':
        this.handlers.onNarration?.(msg.text ?? '');
        break;
      case 'answer_token':
        this.handlers.onToken?.(msg.text ?? '');
        break;
      case 'answer_done':
        this._turnActive = false;
        this.handlers.onDone?.(msg.answer ?? '');
        break;
      case 'highlight':
        if (msg.url && msg.quote)
          this.handlers.onHighlight?.({ url: msg.url, quote: msg.quote, final_url: msg.final_url });
        break;
      case 'not_found':
        this._turnActive = false;
        this.handlers.onNotFound?.(msg.text ?? '', msg.redirect_to_human ?? null);
        break;
      case 'error':
        this._turnActive = false;
        this.handlers.onError?.(msg.text ?? 'Something went wrong.');
        break;
      default:
        // Unknown event types are ignored forward-compatibly.
        break;
    }
  }

  _handleClose() {
    this.handlers.onConnectionChange?.(false);
    // A drop while a turn was streaming leaves the chat hanging — surface it.
    if (this._turnActive) {
      this._turnActive = false;
      this.handlers.onError?.('The connection dropped before Gigi finished. Please try again.');
    }
    this._ws = null;
    this._ready = null;
    if (this._wantOpen) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    const delay = Math.min(this._maxBackoffMs, 250 * 2 ** this._retries);
    this._retries += 1;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (this._wantOpen) this.connect().catch(() => {});
    }, delay);
  }
}

/** Build `ws(s)://<host>/ws` from the current page so dev-proxy and served bundle both work. */
function defaultWsUrl() {
  try {
    const u = new URL('/ws', location.href);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.href;
  } catch {
    return 'ws://localhost:8000/ws';
  }
}
