/**
 * Offline mock WebSocket for the demo harness — replays a scripted backend scenario
 * (demo/fixtures/events.js) so the WHOLE shell runs with no backend, no Anthropic, no
 * Chroma. It replaces `window.WebSocket` with a stand-in that, on a `query` frame,
 * streams the armed scenario's events back through `onmessage`.
 *
 * Install BEFORE the shell module loads so GigiSocket captures the mock as its default
 * `WebSocket` (the demo uses a dynamic import to guarantee that order). The Playwright
 * suite does NOT use this — it drives the real ws-client via `routeWebSocket`.
 */
import { SCENARIOS } from './fixtures/events.js';

let armed = 'happyPath';

/** Choose which scenario the next query will replay. */
export function setScenario(name) {
  if (SCENARIOS[name]) armed = name;
}

export function installMockWebSocket() {
  if (window.__gigiMockInstalled) return;
  window.__gigiMockInstalled = true;

  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      this._timers = [];
      setTimeout(() => {
        this.readyState = 1; // OPEN
        this.onopen && this.onopen({});
      }, 10);
    }
    send(data) {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.type !== 'query') return;
      const steps = SCENARIOS[armed] || SCENARIOS.happyPath;
      let t = 0;
      for (const step of steps) {
        t += step.at ?? 0;
        const ev = step.event;
        this._timers.push(
          setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(ev) }), t)
        );
      }
    }
    close() {
      this._timers.forEach(clearTimeout);
      this.readyState = 3; // CLOSED
      this.onclose && this.onclose({});
    }
  }

  window.WebSocket = MockWebSocket;
}
