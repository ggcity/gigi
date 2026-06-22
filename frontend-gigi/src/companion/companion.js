/**
 * Gigi companion — Phase 4 (V3.md §2.2, §2.5, §6).
 *
 * A tiny, dependency-free, defensive script injected into every City of Garden Grove
 * page. It receives a VERIFIED quote (over origin-checked postMessage when framed in a
 * desktop tile, or a `#gigi=` URL fragment when opened standalone/mobile), reveals the
 * Bootstrap tab/collapsible that contains the text if hidden, fuzzy-matches the quote in
 * its own DOM using the SAME normalization the crawler used at index time, highlights it
 * via the CSS Custom Highlight API (with a `<mark>` fallback), scrolls it into view, and
 * reports a miss back to the shell. It is purely additive: a miss degrades to an opened
 * page with no highlight and a `tile_result` report — it never re-runs the answer.
 *
 * Single self-contained ES module (no imports) so the one source is: importable for unit
 * tests, loadable as a classic/module <script> in the fixture iframe, and bundlable by
 * Vite into one IIFE (`dist/companion.js`) for Drupal injection. Pure functions are
 * exported for unit testing; the side-effecting install runs on load unless
 * `window.__GIGI_NO_AUTORUN` is set (the unit tests set it).
 *
 * Security: the only legitimate embedder is the Gigi origin, so inbound `gigi-highlight`
 * messages are accepted only from `window.parent` AND an allow-listed origin (localhost
 * permitted for fixtures, mirroring the shell's tile guard). The SSRF surface is NOT here:
 * the backend already restricts fetches server-side (V3.md §11); the companion only
 * re-locates a quote the backend already produced and vetted.
 */

export const TITLE_ARTIFACT = 'Title:';
const HL_NAME = 'gigi';
const THRESHOLD = 0.85; // mirrors backend/highlight.py:snap

// The only legitimate parent origin in production. Extend at inject time via
// window.__GIGI_COMPANION_ORIGINS; localhost is always allowed for fixtures/dev.
const ALLOWED_PARENT_ORIGINS = ['https://gigi.ggcity.org'];

// ── normalization parity with shared/extraction.py ───────────────────────────
/** The crawler's whitespace collapse: `re.sub(r"\s+", " ", text).strip()`. */
export function collapse(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/** The crawler's content root, first match wins: main → article → div.content → body. */
export function contentRoot() {
  return (
    document.querySelector('main') ||
    document.querySelector('article') ||
    document.querySelector('div.content') ||
    document.body ||
    document.documentElement
  );
}

// ── fuzzy match (the JS analog of backend/highlight.py:snap) ──────────────────
function _b2j(b) {
  const m = new Map();
  for (let j = 0; j < b.length; j++) {
    const c = b[j];
    let a = m.get(c);
    if (!a) {
      a = [];
      m.set(c, a);
    }
    a.push(j);
  }
  return m;
}

/** difflib-style longest contiguous matching block of `a[alo:ahi]` in `b[blo:bhi]`. */
function _longest(a, b, alo, ahi, blo, bhi, b2j) {
  let besti = alo,
    bestj = blo,
    bestsize = 0;
  let j2len = new Map();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map();
    const js = b2j.get(a[i]);
    if (js) {
      for (let x = 0; x < js.length; x++) {
        const j = js[x];
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }
  return { a: besti, b: bestj, size: bestsize };
}

export function findLongestMatch(a, b) {
  return _longest(a, b, 0, a.length, 0, b.length, _b2j(b));
}

/** difflib SequenceMatcher.ratio(): 2*M/T over the recursive matching blocks. */
export function ratio(a, b) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const b2j = _b2j(b);
  const queue = [[0, a.length, 0, b.length]];
  let matches = 0;
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const m = _longest(a, b, alo, ahi, blo, bhi, b2j);
    if (m.size > 0) {
      matches += m.size;
      if (alo < m.a && blo < m.b) queue.push([alo, m.a, blo, m.b]);
      if (m.a + m.size < ahi && m.b + m.size < bhi)
        queue.push([m.a + m.size, ahi, m.b + m.size, bhi]);
    }
  }
  return (2 * matches) / (a.length + b.length);
}

/**
 * Core span finder over already-normalized strings — the snap algorithm
 * (backend/highlight.py:snap): exact substring fast path, else the longest common block
 * anchors a full-length window accepted at THRESHOLD, else the raw block if it covers
 * most of the quote. Returns {start,end} into `npage` or null.
 */
export function findSpan(nq, npage, threshold = THRESHOLD) {
  if (!nq || !npage) return null;
  const idx = npage.indexOf(nq);
  if (idx !== -1) return { start: idx, end: idx + nq.length };

  const m = findLongestMatch(npage, nq);
  if (m.size === 0) return null;

  const windowStart = Math.max(0, m.a - m.b);
  const window = npage.slice(windowStart, windowStart + nq.length);
  if (window && ratio(window, nq) >= threshold)
    return { start: windowStart, end: windowStart + window.length };

  if (m.size / nq.length >= threshold) return { start: m.a, end: m.a + m.size };
  return null;
}

/**
 * Snap a quote to a true substring of `pageText` (string in, string out) — mirrors the
 * backend, used by the unit tests. Refuses the `Title:` chunk artifact.
 */
export function snapMatch(quote, pageText, threshold = THRESHOLD) {
  const nq = collapse(quote);
  const npage = collapse(pageText);
  if (!nq || !npage) return null;
  if (nq.startsWith(TITLE_ARTIFACT)) return null;
  const s = findSpan(nq, npage, threshold);
  if (!s) return null;
  const span = npage.slice(s.start, s.end).trim();
  if (!span || span.startsWith(TITLE_ARTIFACT)) return null;
  return span;
}

// ── locate the quote in the live DOM and build a Range ────────────────────────
/**
 * Build the crawler-equivalent normalized projection of `root`, plus a per-char map back
 * to (text node, raw offset). Skips script/style/nav/footer/header (the crawler strips
 * those before reading), joins across elements with a single space, and collapses
 * whitespace — so a quote that is a substring of the indexed text is a substring here.
 */
function buildIndex(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      for (let p = n.parentElement; p; p = p.parentElement) {
        const t = p.tagName;
        if (t === 'SCRIPT' || t === 'STYLE' || t === 'NAV' || t === 'FOOTER' || t === 'HEADER')
          return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let norm = '';
  const nodes = [];
  const offs = [];
  let lastSpace = true; // suppress leading whitespace (the crawler's .strip())
  const push = (ch, node, offset) => {
    if (/\s/.test(ch)) {
      if (!lastSpace) {
        norm += ' ';
        nodes.push(node);
        offs.push(offset);
        lastSpace = true;
      }
    } else {
      norm += ch;
      nodes.push(node);
      offs.push(offset);
      lastSpace = false;
    }
  };
  let n;
  while ((n = walker.nextNode())) {
    const raw = n.textContent;
    for (let k = 0; k < raw.length; k++) push(raw[k], n, k);
    push(' ', n, raw.length); // element boundary == whitespace (get_text separator=" ")
  }
  if (lastSpace && norm.endsWith(' ')) {
    norm = norm.slice(0, -1);
    nodes.pop();
    offs.pop();
  }
  return { norm, nodes, offs };
}

/** Locate `quote` in `root` and return a DOM Range over it, or null on a miss. */
export function locateInDom(quote, root) {
  const nq = collapse(quote);
  if (!nq || nq.startsWith(TITLE_ARTIFACT)) return null;
  const { norm, nodes, offs } = buildIndex(root || contentRoot());
  const s = findSpan(nq, norm, THRESHOLD);
  if (!s || s.end <= s.start) return null;
  // nq is trimmed, so its first/last chars are non-space → real content map entries.
  const startNode = nodes[s.start];
  const startOff = offs[s.start];
  const endNode = nodes[s.end - 1];
  const endOff = offs[s.end - 1];
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  try {
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff + 1);
  } catch (e) {
    return null;
  }
  return range;
}

// ── reveal hidden Bootstrap tabs / collapsibles (version-agnostic) ────────────
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function isHiddenEl(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.hasAttribute('hidden')) return true;
  let cs;
  try {
    cs = getComputedStyle(el);
  } catch (e) {
    return false;
  }
  if (cs.display === 'none' || cs.visibility === 'hidden') return true;
  if (el.classList && el.classList.contains('collapse') && !el.classList.contains('show')) return true;
  return false;
}

function revealEl(el) {
  const id = el.id;
  // Production path: click the real Bootstrap toggle control targeting this element,
  // version-agnostic across Bootstrap 4 (data-toggle/data-target) and 5 (data-bs-*).
  if (id) {
    const esc = '#' + cssEscape(id);
    const sel =
      `[data-bs-toggle][data-bs-target="${esc}"],[data-toggle][data-target="${esc}"],` +
      `[data-bs-toggle][href="${esc}"],[data-toggle][href="${esc}"]`;
    let ctrl = null;
    try {
      ctrl = document.querySelector(sel);
    } catch (e) {
      /* bad selector — ignore */
    }
    if (ctrl) {
      try {
        ctrl.click();
      } catch (e) {
        /* ignore */
      }
    }
  }
  // Fallback (no Bootstrap JS on the page, or the click didn't reveal): force it visible.
  if (isHiddenEl(el)) {
    try {
      el.removeAttribute('hidden');
    } catch (e) {}
    try {
      if (el.classList) {
        el.classList.add('show');
        if (el.classList.contains('tab-pane')) el.classList.add('active');
      }
    } catch (e) {}
    try {
      if (getComputedStyle(el).display === 'none') el.style.display = '';
    } catch (e) {}
    if (id && el.classList && el.classList.contains('tab-pane')) {
      try {
        const ctrls = document.querySelectorAll('[data-bs-target],[data-target],[href]');
        ctrls.forEach((b) => {
          const tgt =
            b.getAttribute('data-bs-target') || b.getAttribute('data-target') || b.getAttribute('href');
          if (tgt === '#' + id) {
            b.classList.add('active');
            b.setAttribute('aria-selected', 'true');
          }
        });
      } catch (e) {}
    }
  }
}

function revealForNode(node) {
  let el = node && node.nodeType === 3 ? node.parentElement : node;
  const stack = [];
  for (let p = el; p && p !== document.body && p.nodeType === 1; p = p.parentElement) {
    if (isHiddenEl(p)) stack.push(p);
  }
  // Outermost first, so a revealed ancestor doesn't re-hide an inner one.
  for (let i = stack.length - 1; i >= 0; i--) revealEl(stack[i]);
}

// ── highlight (CSS Custom Highlight API + <mark> fallback) + scroll ───────────
let _active = { api: false, el: null };

function reduceMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {
    return false;
  }
}

function ensureStyle() {
  if (document.getElementById('gigi-companion-style')) return;
  const style = document.createElement('style');
  style.id = 'gigi-companion-style';
  // Color is paired with an underline so the highlight is not signalled by color alone
  // (WCAG 2.1 AA, V3.md §2.8); dark text keeps contrast on the light wash.
  style.textContent =
    '::highlight(gigi){background-color:#fff2a8;color:#0a0a0a;text-decoration:underline;}' +
    'mark#gigi-hl{background-color:#fff2a8;color:#0a0a0a;text-decoration:underline;border-radius:2px;}';
  (document.head || document.documentElement).appendChild(style);
}

function clearHighlight() {
  try {
    if (_active.api && typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete(HL_NAME);
  } catch (e) {}
  try {
    if (_active.el && _active.el.parentNode) {
      const p = _active.el.parentNode;
      while (_active.el.firstChild) p.insertBefore(_active.el.firstChild, _active.el);
      p.removeChild(_active.el);
      if (p.normalize) p.normalize();
    }
  } catch (e) {}
  _active = { api: false, el: null };
}

function paint(range) {
  clearHighlight();
  let painted = false;
  try {
    if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') {
      ensureStyle();
      CSS.highlights.set(HL_NAME, new Highlight(range));
      _active = { api: true, el: null };
      painted = true;
    }
  } catch (e) {
    painted = false;
  }
  if (!painted) {
    // Fallback: wrap the range (works for a single-text-node match, the common case).
    try {
      ensureStyle();
      const mark = document.createElement('mark');
      mark.id = 'gigi-hl';
      range.surroundContents(mark);
      _active = { api: false, el: mark };
      painted = true;
    } catch (e) {
      painted = false;
    }
  }
  // Scroll the match into view without moving keyboard focus (V3.md §2.8).
  try {
    const anchor = _active.el || range.startContainer.parentElement || contentRoot();
    if (anchor && anchor.scrollIntoView)
      anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
  } catch (e) {}
  return painted;
}

// ── the pipeline: locate → reveal → highlight → report ────────────────────────
export function handleQuote(quote, replyWin, replyOrigin) {
  let found = false;
  try {
    if (quote && !collapse(quote).startsWith(TITLE_ARTIFACT)) {
      const range = locateInDom(quote, contentRoot());
      if (range) {
        revealForNode(range.startContainer);
        found = paint(range);
      }
    }
  } catch (e) {
    found = false;
  }
  try {
    if (document.body) document.body.setAttribute('data-gigi-highlighted', found ? quote : '');
  } catch (e) {}
  if (replyWin) {
    try {
      replyWin.postMessage(
        { type: 'gigi-tile-result', found: found, url: location.href, quote: quote },
        replyOrigin || '*'
      );
    } catch (e) {}
  }
  return found;
}

// ── intake channels + install ─────────────────────────────────────────────────
export function isAllowedOrigin(origin) {
  try {
    if (ALLOWED_PARENT_ORIGINS.indexOf(origin) !== -1) return true;
    const extra =
      typeof window !== 'undefined' && Array.isArray(window.__GIGI_COMPANION_ORIGINS)
        ? window.__GIGI_COMPANION_ORIGINS
        : [];
    if (extra.indexOf(origin) !== -1) return true;
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch (e) {
    return false;
  }
}

export function install() {
  if (typeof window === 'undefined') return;
  if (window.__gigiCompanionInstalled) return;
  window.__gigiCompanionInstalled = true;

  // Tell the shell we're navigating so it can show a per-tile loading bar (Phase 3).
  const signalNav = () => {
    try {
      if (window.parent && window.parent !== window)
        window.parent.postMessage({ type: 'gigi-navigating' }, '*');
    } catch (e) {}
  };
  window.addEventListener('beforeunload', signalNav);
  document.addEventListener(
    'click',
    (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[href]');
      if (a) signalNav();
    },
    true
  );

  // Channel 1: origin-checked postMessage from the embedding Gigi shell (desktop tiles).
  window.addEventListener('message', (ev) => {
    try {
      if (ev.source !== window.parent) return;
      if (!isAllowedOrigin(ev.origin)) return;
      const d = ev.data;
      if (!d || d.type !== 'gigi-highlight') return;
      handleQuote(d.quote, ev.source, ev.origin);
    } catch (e) {}
  });

  // Channel 2: a `#gigi=` fragment for standalone/mobile opens with no opener. Read it
  // once, then strip it so it never reaches the server, logs, or cache (V3.md §2.2).
  try {
    const m = /#gigi=([^&]+)/.exec(location.hash || '');
    if (m) {
      const q = decodeURIComponent(m[1]);
      handleQuote(q, null, null);
      history.replaceState(null, '', location.pathname + location.search);
    }
  } catch (e) {}
}

// Auto-install on load (deferred module → DOM is parsed). Unit tests set the flag to
// import the pure functions without side effects.
if (typeof window !== 'undefined' && !window.__GIGI_NO_AUTORUN) {
  try {
    install();
  } catch (e) {}
}
