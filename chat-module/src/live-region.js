/**
 * aria-live announcement helpers.
 *
 * Two distinct regions are used by the element (see gigi-chat.js):
 *   - answer region: polite + aria-atomic, EMPTY during streaming, set ONCE with
 *     the finished answer so the screen reader announces it exactly one time.
 *   - narration region: polite, for transient process status ("Looking this up…",
 *     "Gigi is responding…"), kept separate so it never clobbers the answer.
 *
 * Tokens are NEVER routed here (V3.md §5: never pipe every token into the live
 * region).
 */

import { trace } from './debug.js';

/**
 * Announce `text` in a live region. Clears first, then sets on the next frame, so
 * re-announcing identical text (e.g. two errors in a row) still fires. A no-op for
 * empty text.
 * @param {HTMLElement | null | undefined} region
 * @param {string} text
 * @param {string} [label]  dev-log label identifying which region
 */
export function announce(region, text, label = 'live') {
  if (!region) return;
  const value = (text ?? '').trim();
  region.textContent = '';
  if (!value) return;
  const set = () => {
    region.textContent = value;
    trace('announce', `[${label}]`, value);
  };
  // rAF when available (real DOM), else microtask (test/headless edge cases).
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(set);
  else queueMicrotask(set);
}

/**
 * Clear a live region without announcing.
 * @param {HTMLElement | null | undefined} region
 */
export function clearRegion(region) {
  if (region) region.textContent = '';
}
