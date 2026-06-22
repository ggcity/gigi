/**
 * The centered↔side layout morph, authored with Motion One (`motion`).
 *
 * A real FLIP dock: the caller measures the chat pane BEFORE the layout change, applies
 * the layout (centered ↔ side), measures AFTER, then calls `animateDock` with both
 * rects. We animate the chat pane's `width` (interpolated length → smooth narrow/widen,
 * the text rewraps live with no scale distortion) and a `translateX` (GPU) so it slides
 * from its old position to the new dock. Entering the side layout, the tile pane
 * slides+fades in. ALL of it is gated by `prefers-reduced-motion` — when reduced, the
 * CSS layout swap is the entire transition. The page never scrolls; only panes move.
 */

import { animate } from 'motion';

const EASE = [0.22, 1, 0.36, 1];

export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Animate the chat pane from its pre-change rect (`first`) to its current rect
 * (`last`); fade/slide the tile pane in when docking to the side.
 * @param {HTMLElement} chatPane
 * @param {HTMLElement|null} tilesPane
 * @param {DOMRect} first
 * @param {DOMRect} last
 * @param {{ toSide: boolean }} opts
 */
export function animateDock(chatPane, tilesPane, first, last, { toSide }) {
  const ms = readMorphMs(chatPane);
  const duration = ms / 1000;
  const dx = first.left - last.left;
  try {
    if (chatPane && (Math.abs(dx) > 0.5 || Math.abs(first.width - last.width) > 0.5)) {
      const anim = animate(
        chatPane,
        { width: [first.width + 'px', last.width + 'px'], transform: [`translateX(${dx}px)`, 'translateX(0px)'] },
        { duration, easing: EASE }
      );
      // Restore responsive width/transform once the dock settles.
      const clear = () => {
        chatPane.style.width = '';
        chatPane.style.transform = '';
      };
      anim.finished ? anim.finished.then(clear).catch(clear) : setTimeout(clear, ms + 50);
    }
    if (toSide && tilesPane) {
      animate(
        tilesPane,
        { opacity: [0, 1], transform: ['translateX(24px)', 'translateX(0px)'] },
        { duration, easing: EASE }
      );
    }
  } catch {
    // Any animation-engine hiccup degrades to the already-applied final layout.
    if (chatPane) {
      chatPane.style.width = '';
      chatPane.style.transform = '';
    }
  }
}

function readMorphMs(el) {
  try {
    const raw = getComputedStyle(el).getPropertyValue('--gigi-shell-morph-ms').trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 420;
  } catch {
    return 420;
  }
}
