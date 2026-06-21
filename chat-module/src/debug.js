/**
 * Dev-only debug logger.
 *
 * Every call site is guarded by `import.meta.env.DEV`. Vite statically replaces
 * that token with `false` in `vite build`, so the guarded blocks — and the
 * argument expressions inside them — are dead-code-eliminated from the published
 * library bundle. There is zero runtime cost and no leaked debug strings in prod.
 *
 * The dev server and the demo harness run with DEV=true, so diagnostics are fully
 * active there. AR 2.16: this writes to `console` only — never persisted, never
 * transmitted, and absent from prod entirely, so it creates no PII/telemetry surface.
 *
 * Verbosity:
 *   - default: concise (lifecycle + events)
 *   - verbose: per-token detail, enabled by `?gigichat-debug=verbose` on the page URL
 *     or a `debug="verbose"` attribute on the element (the element forwards it here).
 */

const PREFIX = '[gigi-chat]';

let _verbose = false;

// Read the URL flag once at module load (dev only). Wrapped so it strips in prod.
if (import.meta.env.DEV) {
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    if (params.get('gigichat-debug') === 'verbose') _verbose = true;
  } catch {
    /* no location (e.g. worker) — stay concise */
  }
}

/** Raise/lower verbosity at runtime (dev only). */
export function setVerbose(on) {
  if (import.meta.env.DEV) _verbose = !!on;
}

/** True when verbose dev logging is active. */
export function isVerbose() {
  return import.meta.env.DEV && _verbose;
}

/** Concise dev log. */
export function debug(...args) {
  if (import.meta.env.DEV) console.debug(PREFIX, ...args);
}

/** Per-token / high-frequency dev log; only emits in verbose mode. */
export function trace(...args) {
  if (import.meta.env.DEV && _verbose) console.debug(PREFIX, ...args);
}

/** Dev warning (always emits in dev, regardless of verbosity). */
export function warn(...args) {
  if (import.meta.env.DEV) console.warn(PREFIX, ...args);
}

/** Grouped dev log helper; callback runs only in dev. */
export function group(label, fn) {
  if (import.meta.env.DEV) {
    console.groupCollapsed(PREFIX, label);
    try {
      fn?.();
    } finally {
      console.groupEnd();
    }
  }
}
