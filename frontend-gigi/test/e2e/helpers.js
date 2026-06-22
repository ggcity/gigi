/**
 * Playwright helpers for the shell e2e suite.
 *
 * The backend is mocked at its boundary: `mockBackend` intercepts the WebSocket the
 * shell opens (Playwright `routeWebSocket`) and replays scripted backend events, and
 * fulfills cited `www.ggcity.org` page requests with the bundled fixture city page so
 * the iframe + companion-stub + highlight path runs for real — no Anthropic, no Chroma,
 * no network. Tests then drive the REAL chat input and assert on the rendered shell.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CITY_PAGE = readFileSync(resolve(HERE, '../../demo/city-page.html'), 'utf8');
// The fixture page loads the REAL companion as a module script. Served at the ggcity.org
// origin in the suite, so its `/src/companion/companion.js` import resolves there — route
// that exact path to the source file (registered after the catch-all so it takes priority).
const COMPANION = readFileSync(resolve(HERE, '../../src/companion/companion.js'), 'utf8');

/**
 * Arm the mocked backend. `scenarios` is either an array of step-lists (one consumed
 * per query, in order) or a function (queryText, turnIndex) → step-list. Each step is
 * `{ at?: ms, event }`. Optionally `onClose(turnIndex)` may close the socket mid-turn
 * to exercise the reconnect/error path. Call BEFORE `page.goto`.
 */
export async function mockBackend(page, scenarios, { dropTurn = null } = {}) {
  await page.route('https://www.ggcity.org/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: CITY_PAGE })
  );
  // Higher-priority (later-registered) route for the companion module the fixture imports.
  await page.route('https://www.ggcity.org/src/companion/companion.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: COMPANION })
  );

  let turn = 0;
  await page.routeWebSocket('**/ws', (ws) => {
    ws.onMessage((raw) => {
      let msg;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        return;
      }
      if (msg.type !== 'query') return;
      const idx = turn++;
      if (dropTurn === idx) {
        // Simulate a mid-turn disconnect after a brief delay.
        setTimeout(() => ws.close(), 80);
        return;
      }
      const steps =
        typeof scenarios === 'function'
          ? scenarios(msg.text, idx)
          : scenarios[Math.min(idx, scenarios.length - 1)];
      let t = 0;
      for (const step of steps || []) {
        t += step.at ?? 0;
        setTimeout(() => ws.send(JSON.stringify(step.event)), t);
      }
    });
  });
}

/** Navigate to the real shell. */
export async function gotoApp(page) {
  await page.goto('/');
  await page.waitForSelector('gigi-app');
  await page.locator('gigi-app').evaluate((el) => el.updateComplete);
}

/** Type a question into the chat input and submit with Enter. */
export async function ask(page, text) {
  const box = page.getByRole('textbox');
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

/** Locator for the live tile cards. */
export function tileCards(page) {
  return page.locator('gigi-tiles .card');
}

/** FrameLocator into the first (or nth) framed city page. */
export function tileFrame(page, nth = 0) {
  return page.frameLocator('gigi-tiles iframe').nth(nth);
}

/** The companion's outcome marker on a framed page (the quote it highlighted, or ''). */
export function highlightedQuote(frame) {
  return frame.locator('body').getAttribute('data-gigi-highlighted');
}

/** Whether the companion painted a highlight in the frame (Custom Highlight API or mark). */
export function isPainted(frame) {
  return frame
    .locator('body')
    .evaluate(() => (window.CSS && CSS.highlights && CSS.highlights.size > 0) || !!document.getElementById('gigi-hl'));
}
