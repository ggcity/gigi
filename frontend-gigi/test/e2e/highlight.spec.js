import { test, expect } from '@playwright/test';
import { mockBackend, gotoApp, ask, tileCards, tileFrame, highlightedQuote, isPainted } from './helpers.js';
import {
  SCENARIOS,
  VISIBLE_QUOTE,
  HIDDEN_QUOTE,
  COLLAPSIBLE_QUOTE,
  FUZZY_QUOTE,
} from '../../demo/fixtures/events.js';

// The async highlight path against the REAL Phase 4 companion: after answer_done the
// backend emits highlight {url, quote}; the shell forwards it to the matching open tile
// via origin-checked postMessage; the companion (loaded in the fixture page) normalizes,
// reveals any hidden container, fuzzy-matches, paints via the CSS Custom Highlight API
// (or a <mark> fallback), and sets `data-gigi-highlighted` on <body> with the quote.

test('a highlight event marks the verified quote in the framed page', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.happyPath]); // highlights VISIBLE_QUOTE on the City Hall page
  await gotoApp(page);
  await ask(page, 'City Hall hours?');

  await expect(tileCards(page)).toHaveCount(1);

  const frame = tileFrame(page);
  await expect.poll(() => highlightedQuote(frame)).toContain(VISIBLE_QUOTE);
  expect(await isPainted(frame)).toBe(true);

  // The tile shows a non-color-only "quote shown" cue.
  await expect(page.locator('gigi-tiles .hl-badge')).toBeVisible();
});

test('a highlight in a hidden Bootstrap tab reveals the tab, then marks the quote', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.hiddenContent]); // HIDDEN_QUOTE lives in the (hidden) Fees tab
  await gotoApp(page);
  await ask(page, 'business license fee?');

  await expect(tileCards(page)).toHaveCount(1);

  const frame = tileFrame(page);
  // The fees pane starts hidden; the companion reveals it before marking.
  await expect(frame.locator('#fees')).toBeVisible();
  await expect.poll(() => highlightedQuote(frame)).toContain(HIDDEN_QUOTE);
  expect(await isPainted(frame)).toBe(true);
});

test('a highlight in a collapsed Bootstrap-4 section reveals it, then marks the quote', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.collapsibleContent]); // COLLAPSIBLE_QUOTE in a .collapse section
  await gotoApp(page);
  await ask(page, 'overnight parking?');

  const frame = tileFrame(page);
  await expect(frame.locator('#parking-more')).toBeVisible();
  await expect.poll(() => highlightedQuote(frame)).toContain(COLLAPSIBLE_QUOTE);
});

test('a lightly corrupted quote is recovered by the fuzzy snap', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.fuzzyMatch]); // FUZZY_QUOTE = VISIBLE_QUOTE with one typo
  await gotoApp(page);
  await ask(page, 'City Hall hours?');

  const frame = tileFrame(page);
  // Exact match would miss (Friday→Fridey); the companion still paints the real text.
  await expect.poll(() => highlightedQuote(frame)).toContain(FUZZY_QUOTE);
  expect(await isPainted(frame)).toBe(true);
});

test('a quote that is not on the page degrades to no highlight (DOM-miss)', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.domMiss]); // ABSENT_QUOTE is nowhere on the fixture
  await gotoApp(page);
  await ask(page, 'dog licenses?');

  const frame = tileFrame(page);
  // The companion processed the (missing) quote and recorded the miss; nothing painted.
  await expect.poll(() => highlightedQuote(frame)).toBe('');
  expect(await isPainted(frame)).toBe(false);
  // The page itself is still shown — the highlight is additive, never a gate.
  await expect(frame.locator('#intro')).toBeVisible();
});

test('the #gigi= hash channel highlights on a standalone page open', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.happyPath]); // arms the city-page + companion routes
  // Open the city page directly (no shell parent) with the quote in the fragment.
  await page.goto('https://www.ggcity.org/cityhall#gigi=' + encodeURIComponent(VISIBLE_QUOTE));

  await expect
    .poll(() => page.evaluate(() => document.body.getAttribute('data-gigi-highlighted')))
    .toContain(VISIBLE_QUOTE);
  // The fragment is stripped so it never reaches the server/logs/cache.
  expect(await page.evaluate(() => location.hash)).toBe('');
});
