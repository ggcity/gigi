/**
 * Shared Playwright helpers. Tests drive the component through its PUBLIC API
 * (methods + events), never by reaching into shadow internals to mutate state.
 * Playwright's CSS locators pierce the open shadow root for assertions.
 */

/** Navigate to the demo harness and start capturing host-facing events. */
export async function gotoChat(page) {
  await page.goto('/');
  await page.waitForSelector('gigi-chat');
  await page.evaluate(() => {
    /** @type {Array<{type:string, detail:any}>} */
    window.__events = [];
    const types = [
      'gigi-submit',
      'gigi-citation-detected',
      'gigi-answer-complete',
      'gigi-citation-click',
      'gigi-new-session',
      'gigi-copy',
    ];
    for (const t of types) {
      // Listen on document: composed+bubbles events cross the shadow boundary.
      document.addEventListener(t, (e) => window.__events.push({ type: e.type, detail: e.detail }));
    }
    // Capture clipboard writes deterministically across engines.
    window.__copied = null;
    try {
      navigator.clipboard.writeText = async (t) => {
        window.__copied = t;
      };
    } catch {
      /* fall back to the component's textarea path */
    }
  });
}

/** Invoke a public API method on the element. */
export function call(page, name, ...args) {
  return page.evaluate(
    ({ name, args }) => document.querySelector('gigi-chat')[name](...args),
    { name, args }
  );
}

/** Flush coalesced (rAF) renders + announcements. */
export function flush(page) {
  return page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))))
  );
}

/** Read captured host-facing events. */
export function events(page) {
  return page.evaluate(() => window.__events);
}
