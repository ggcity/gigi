/**
 * Streaming-safe markdown rendering.
 *
 * Assistant tokens arrive as RAW markdown fragments that can split a
 * `[title](url)` link (or `**bold**`, a code fence) across chunk boundaries.
 * The strategy is to re-parse the WHOLE accumulated buffer on every render:
 * a partial `[City Hal` renders as literal text until `](url)` arrives, then
 * snaps to a proper link on the next parse. This is correct and simple; answers
 * are short, so the per-render O(n) cost is negligible.
 *
 * Model output is untrusted, so the parsed HTML is DOMPurify-sanitized on every
 * render against a strict allow-list before it is ever placed in the DOM. The
 * sanitized STRING is what the element renders via Lit's `unsafeHTML` directive —
 * `unsafeHTML` here means "Lit did not sanitize it" (we did), not "unsafe".
 * Removing either `marked` or DOMPurify is a regression (broken render / XSS).
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { trace, warn } from './debug.js';

// Deliberately minimal renderer for a city-services answer.
marked.use({ gfm: true, breaks: false });

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'ul', 'ol', 'li',
    'a', 'code', 'pre', 'blockquote', 'h3', 'h4',
  ],
  // href only — no target, no inline handlers. We delegate clicks ourselves.
  ALLOWED_ATTR: ['href'],
  // Only safe, expected schemes. Rejects javascript:/data: and bare relative URLs.
  ALLOWED_URI_REGEXP: /^(?:https:|mailto:|tel:)/i,
  KEEP_CONTENT: true, // text inside a stripped tag (e.g. an h1) survives as text
};

/**
 * Parse a raw-markdown buffer and return sanitized HTML safe to render.
 * @param {string} buffer
 * @returns {string}
 */
export function renderMarkdown(buffer) {
  const rawHtml = marked.parse(buffer ?? '', { async: false });
  const clean = DOMPurify.sanitize(rawHtml, PURIFY_CONFIG);
  // Surface sanitizer activity in dev so XSS-shaped surprises in model output
  // are visible. DOMPurify.removed is populated by the last sanitize() call.
  if (import.meta.env.DEV && DOMPurify.removed && DOMPurify.removed.length) {
    trace('DOMPurify removed', DOMPurify.removed.length, 'node(s)/attr(s)');
  }
  return clean;
}

/**
 * Extract citation links from sanitized HTML, in document order, deduped by URL.
 * Reads the exact anchors that survived sanitization, so what is surfaced matches
 * what is rendered.
 * @param {string} sanitizedHtml
 * @returns {import('./types.js').Citation[]}
 */
export function extractCitations(sanitizedHtml) {
  /** @type {import('./types.js').Citation[]} */
  const out = [];
  const seen = new Set();
  try {
    const doc = new DOMParser().parseFromString(sanitizedHtml, 'text/html');
    for (const a of doc.querySelectorAll('a[href]')) {
      const url = a.getAttribute('href') || '';
      const text = (a.textContent || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, text: text || url });
    }
  } catch (err) {
    warn('extractCitations failed', err);
  }
  return out;
}

/**
 * Flatten sanitized HTML to a single readable line for the aria-live answer
 * announcement (links become their anchor text; whitespace collapsed).
 * @param {string} sanitizedHtml
 * @returns {string}
 */
export function announcementText(sanitizedHtml) {
  try {
    const doc = new DOMParser().parseFromString(sanitizedHtml, 'text/html');
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  } catch {
    return (sanitizedHtml || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

/**
 * Flatten sanitized HTML to plain text for the clipboard, rendering links as
 * `anchor text (url)` so the destination survives a paste into a plain-text field
 * (e.g. "Code FAQ (https://www.ggcity.org/faq)"). Block elements are separated by
 * newlines; inline whitespace is collapsed.
 * @param {string} sanitizedHtml
 * @returns {string}
 */
export function toPlainText(sanitizedHtml) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(sanitizedHtml, 'text/html');
  } catch {
    return (sanitizedHtml || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const BLOCK = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'H3', 'H4', 'BR']);
  let out = '';
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent.replace(/\s+/g, ' ');
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'A') {
          const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
          const href = child.getAttribute('href') || '';
          out += href && href !== text ? `${text} (${href})` : text;
        } else {
          walk(child);
          if (BLOCK.has(child.tagName)) out += '\n';
        }
      }
    }
  };
  walk(doc.body);
  // Collapse runs of blank lines, trim trailing inline space on each line.
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
