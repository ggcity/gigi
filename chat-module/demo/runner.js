/**
 * Scenario player for the demo harness and the Playwright suite.
 *
 * Replays an ordered step list (see test/fixtures/streams.js) into a <gigi-chat>
 * element's public API, honoring each step's `at` delay. Returns a promise that
 * resolves when the scenario finishes. Independent of Gigi / any transport.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {import('../src/gigi-chat.js').GigiChat} chat
 * @param {Array<{at?: number, call: string, args?: any[]}>} steps
 * @param {{ speed?: number, signal?: AbortSignal }} [opts]
 */
export async function playScenario(chat, steps, opts = {}) {
  const speed = opts.speed ?? 1;
  for (const step of steps) {
    if (opts.signal?.aborted) return;
    if (step.at) await sleep(step.at * speed);
    const fn = chat[step.call];
    if (typeof fn !== 'function') {
      // eslint-disable-next-line no-console
      console.error('[runner] unknown API call:', step.call);
      continue;
    }
    fn.apply(chat, step.args ?? []);
  }
}
