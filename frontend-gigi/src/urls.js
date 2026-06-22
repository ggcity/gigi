/**
 * Pure URL helpers — no DOM, no state, so they are unit-tested directly.
 *
 * The shell frames cited city pages in tiles and forwards verified highlight quotes
 * to them. Two safety rules apply on the client (defense-in-depth; the backend
 * already SSRF-guards which URLs it will fetch):
 *   - Only http(s) URLs are ever framed.
 *   - The host must be in the tile allow-list (default `ggcity.org`), with localhost
 *     permitted so same-origin test/demo fixtures work.
 * Highlight events are matched to an open tile by the URL with its `#fragment`
 * removed, because the backend defrags cited URLs before emitting `highlight`.
 */

/** Default hosts whose pages the shell will frame. Mirrors the backend's ALLOWED_FETCH_HOSTS. */
export const DEFAULT_ALLOWED_TILE_HOSTS = ['ggcity.org'];

/** Hosts that are always allowed so same-origin local fixtures can be framed/tested. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '']);

/**
 * Resolve a possibly-relative URL against a base and strip its fragment.
 * Returns null if it cannot be parsed.
 * @param {string} url
 * @param {string} [base]
 * @returns {string|null}
 */
export function defrag(url, base = locationHref()) {
  try {
    const u = new URL(url, base);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

// Query params that never change which page you land on — dropped when canonicalizing.
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|igshid$)/i;
const INDEX_FILE = /\/(index\.html?|index\.php|default\.aspx?)$/i;

/**
 * Aggressively normalize a URL so cosmetically-different links that point at the same
 * page collapse together (dedup on open). Lowercases scheme+host, drops the default
 * port, strips the fragment, removes a trailing slash, drops `index.*`/`default.*`
 * filenames, and removes tracking query params. Returns the input on parse failure.
 * NB: this is a heuristic for COSMETIC differences; true server redirects are deduped
 * separately via the backend's post-redirect `final_url`.
 * @param {string} url
 * @param {string} [base]
 * @returns {string}
 */
export function canonicalize(url, base = locationHref()) {
  let u;
  try {
    u = new URL(url, base);
  } catch {
    return url;
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  u.pathname = u.pathname.replace(INDEX_FILE, '/');
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  }
  // Stable param order so ?a=1&b=2 and ?b=2&a=1 match.
  u.searchParams.sort();
  return u.href;
}

/** True when two URLs resolve to the same canonical target. */
export function sameTarget(a, b, base = locationHref()) {
  const ca = canonicalize(a, base);
  const cb = canonicalize(b, base);
  return ca === cb;
}

/**
 * Decide whether a cited URL may be framed in a tile.
 * @param {string} url
 * @param {string[]} [allowedHosts]
 * @param {string} [base]
 * @returns {{ ok: boolean, href?: string, origin?: string, host?: string, reason?: string }}
 */
export function guardTileUrl(url, allowedHosts = DEFAULT_ALLOWED_TILE_HOSTS, base = locationHref()) {
  let u;
  try {
    u = new URL(url, base);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: `scheme ${u.protocol}` };
  }
  const host = u.hostname.toLowerCase();
  const allowed =
    LOCAL_HOSTS.has(host) ||
    allowedHosts.some((h) => {
      const base = String(h).toLowerCase();
      return host === base || host.endsWith('.' + base);
    });
  if (!allowed) return { ok: false, reason: `host ${host}` };
  return { ok: true, href: u.href, origin: u.origin, host };
}

/** Indirection so tests can run without a real `location`. */
function locationHref() {
  try {
    return typeof location !== 'undefined' ? location.href : 'http://localhost/';
  } catch {
    return 'http://localhost/';
  }
}
