import { test, expect } from '@playwright/test';

// Unit coverage for the companion's gnarly pure logic (V3.md §7): the crawler-parity
// normalization and the fuzzy snap that must agree with backend/highlight.py:snap. The
// module is imported with __GIGI_NO_AUTORUN set so its install() side effects don't run.

test.beforeEach(async ({ page }) => {
  await page.goto('/'); // any served page; we import the module into its context
});

test('collapse mirrors the crawler whitespace rule', async ({ page }) => {
  const r = await page.evaluate(async () => {
    window.__GIGI_NO_AUTORUN = true;
    const m = await import('/src/companion/companion.js');
    return {
      runs: m.collapse('a\n   b\t c  '),
      empty: m.collapse('   '),
      none: m.collapse(null),
    };
  });
  expect(r.runs).toBe('a b c');
  expect(r.empty).toBe('');
  expect(r.none).toBe('');
});

test('snapMatch: exact, whitespace recovery, corruption recovery, and rejections', async ({ page }) => {
  const r = await page.evaluate(async () => {
    window.__GIGI_NO_AUTORUN = true;
    const m = await import('/src/companion/companion.js');
    const page1 = 'Welcome. The City Hall is open Monday through Friday today. See you.';
    return {
      exact: m.snapMatch('City Hall is open Monday', page1),
      whitespace: m.snapMatch('City   Hall\nis  open', page1),
      corrupt: m.snapMatch('City Hall is opon Monday', page1), // one typo
      title: m.snapMatch('Title: City Hall hours', 'Title: City Hall hours and more'),
      miss: m.snapMatch('completely unrelated zzz qqq', page1),
      emptyQuote: m.snapMatch('', page1),
    };
  });
  expect(r.exact).toBe('City Hall is open Monday');
  expect(r.whitespace).toBe('City Hall is open'); // returns the page's true (collapsed) text
  expect(r.corrupt).toContain('City Hall is open Monday'); // fuzzy window snaps to real text
  expect(r.title).toBeNull(); // the crawler Title: artifact is never a highlight
  expect(r.miss).toBeNull();
  expect(r.emptyQuote).toBeNull();
});

test('ratio behaves like difflib SequenceMatcher.ratio', async ({ page }) => {
  const r = await page.evaluate(async () => {
    window.__GIGI_NO_AUTORUN = true;
    const m = await import('/src/companion/companion.js');
    return {
      identical: m.ratio('abcd efgh', 'abcd efgh'),
      bothEmpty: m.ratio('', ''),
      disjoint: m.ratio('abc', 'xyz'),
      close: m.ratio('City Hall is open', 'City Hall is opon'),
    };
  });
  expect(r.identical).toBe(1);
  expect(r.bothEmpty).toBe(1);
  expect(r.disjoint).toBe(0);
  expect(r.close).toBeGreaterThan(0.85);
});

test('isAllowedOrigin: Gigi origin + localhost yes, others no', async ({ page }) => {
  const r = await page.evaluate(async () => {
    window.__GIGI_NO_AUTORUN = true;
    const m = await import('/src/companion/companion.js');
    return {
      gigi: m.isAllowedOrigin('https://gigi.ggcity.org'),
      localhost: m.isAllowedOrigin('http://localhost:5274'),
      loopback: m.isAllowedOrigin('http://127.0.0.1:9000'),
      evil: m.isAllowedOrigin('https://evil.example'),
      garbage: m.isAllowedOrigin('not-a-url'),
    };
  });
  expect(r.gigi).toBe(true);
  expect(r.localhost).toBe(true);
  expect(r.loopback).toBe(true);
  expect(r.evil).toBe(false);
  expect(r.garbage).toBe(false);
});
