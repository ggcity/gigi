import { test, expect } from '@playwright/test';
import { mockBackend, gotoApp, ask, tileCards } from './helpers.js';

// Robust-tiling behaviors: adaptive columns, full-height 4-up, mobile collapse,
// redirect dedup, the click-to-interact scrim, autofocus, and focus-within.

const NARR = 'Looking this up…';
const link = (t, u) => `[${t}](${u})`;
const gg = (p) => `https://www.ggcity.org/${p}`;

function turn({ tokens, highlights = [] }) {
  const steps = [
    { at: 0, event: { type: 'session', session_id: 's' } },
    { at: 15, event: { type: 'narration', text: NARR } },
  ];
  tokens.forEach((t, i) => steps.push({ at: i === 0 ? 30 : 12, event: { type: 'answer_token', text: t } }));
  steps.push({ at: 12, event: { type: 'answer_done', answer: tokens.join('') } });
  highlights.forEach((h) => steps.push({ at: 40, event: { type: 'highlight', ...h } }));
  return steps;
}

/** Read each tile card's bounding rect + the grid client size from inside the shadow. */
function tileGeometry(page) {
  return page.evaluate(() => {
    const tiles = document.querySelector('gigi-app').renderRoot.querySelector('gigi-tiles');
    const grid = tiles.renderRoot.querySelector('.grid');
    const cards = [...tiles.renderRoot.querySelectorAll('.card')].map((c) => {
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    });
    return {
      cards,
      gridWidth: grid.clientWidth,
      scroll: { scrollHeight: grid.scrollHeight, clientHeight: grid.clientHeight },
    };
  });
}

test('#1 one citation fills the tile column full-width', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await mockBackend(page, [turn({ tokens: ['See ', link('Water', gg('water')), '.'] })]);
  await gotoApp(page);
  await ask(page, 'water?');
  await expect(tileCards(page)).toHaveCount(1);
  const g = await tileGeometry(page);
  expect(g.cards[0].width).toBeGreaterThan(g.gridWidth * 0.9); // ~full pane width
});

test('#6 columns: 1-per-row at ~1400px, 2-per-row at ~1600px', async ({ page }) => {
  const two = turn({ tokens: ['A ', link('One', gg('a')), ' B ', link('Two', gg('b')), '.'] });

  await page.setViewportSize({ width: 1400, height: 900 });
  await mockBackend(page, [two]);
  await gotoApp(page);
  await ask(page, 'two pages?');
  await expect(tileCards(page)).toHaveCount(2);
  let g = await tileGeometry(page);
  // Stacked: second card is below the first.
  expect(g.cards[1].top).toBeGreaterThan(g.cards[0].top + 10);

  await page.setViewportSize({ width: 1600, height: 900 });
  g = await tileGeometry(page);
  // Side by side: same row, second card to the right.
  expect(Math.abs(g.cards[1].top - g.cards[0].top)).toBeLessThan(4);
  expect(g.cards[1].left).toBeGreaterThan(g.cards[0].right - 4);
});

test('#9 four tiles are all visible on a tall screen (no scroll)', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1080 });
  const four = turn({
    tokens: ['1 ', link('One', gg('a')), ' 2 ', link('Two', gg('b')), ' 3 ', link('Three', gg('c')), ' 4 ', link('Four', gg('d')), '.'],
  });
  await mockBackend(page, [four]);
  await gotoApp(page);
  await ask(page, 'four pages?');
  await expect(tileCards(page)).toHaveCount(4);
  const g = await tileGeometry(page);
  const h = await page.evaluate(() => window.innerHeight);
  for (const c of g.cards) expect(c.bottom).toBeLessThanOrEqual(h + 2);
  // No meaningful scroll (allow a few px of sub-pixel rounding across engines).
  expect(g.scroll.scrollHeight).toBeLessThanOrEqual(g.scroll.clientHeight + 6);
});

test('#2 mobile viewport hides tiles and gives the chat full width', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await mockBackend(page, [turn({ tokens: ['See ', link('Water', gg('water')), '.'] })]);
  await gotoApp(page);
  await ask(page, 'water?');
  // The answer rendered; the tile pane is hidden by the mobile media query.
  await expect(page.locator('gigi-chat .content').filter({ hasText: 'Water' })).toBeVisible();
  const m = await page.evaluate(() => {
    const root = document.querySelector('gigi-app').renderRoot;
    const pane = root.querySelector('.chat-pane');
    const cs = getComputedStyle(pane);
    return {
      tilesDisplay: getComputedStyle(root.querySelector('.tiles-pane')).display,
      radius: cs.borderTopLeftRadius,
      paneWidth: pane.getBoundingClientRect().width,
      vw: window.innerWidth,
    };
  });
  expect(m.tilesDisplay).toBe('none'); // tiles hidden
  expect(m.radius).toBe('0px'); // full-bleed (no rounded card)
  expect(m.paneWidth).toBeGreaterThan(m.vw - 2); // fills the viewport width
});

test('#3 two citations that redirect to the same page dedupe to one tile', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const final = gg('finance/water-billing');
  const scenario = turn({
    tokens: ['Pay at ', link('Bill Pay', gg('billpay')), ' or the ', link('Water Portal', gg('water')), '.'],
    highlights: [
      { url: gg('billpay'), quote: 'pay your water bill', final_url: final },
      { url: gg('water'), quote: 'pay your water bill', final_url: final },
    ],
  });
  await mockBackend(page, [scenario]);
  await gotoApp(page);
  await ask(page, 'pay water bill?');
  // Both open, then the duplicate (same final_url) auto-closes → one tile.
  await expect(tileCards(page)).toHaveCount(1, { timeout: 4000 });
});

const iframePointerEvents = (page) =>
  page.evaluate(
    () => getComputedStyle(document.querySelector('gigi-app').renderRoot.querySelector('gigi-tiles').renderRoot.querySelector('iframe')).pointerEvents
  );

test('#6 default: no scrim, iframe is interactive', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await mockBackend(page, [turn({ tokens: ['See ', link('Water', gg('water')), '.'] })]);
  await gotoApp(page);
  await ask(page, 'water?');
  await expect(tileCards(page)).toHaveCount(1);
  expect(await iframePointerEvents(page)).toBe('auto'); // interactive by default
  await expect(page.getByRole('button', { name: /Interact with/ })).toHaveCount(0); // no scrim
});

test('#6 opt-in scrim keeps the iframe inert until activated', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await mockBackend(page, [turn({ tokens: ['See ', link('Water', gg('water')), '.'] })]);
  await gotoApp(page);
  await page.evaluate(() => document.querySelector('gigi-app').setAttribute('scrim', '')); // opt in
  await ask(page, 'water?');
  await expect(tileCards(page)).toHaveCount(1);

  expect(await iframePointerEvents(page)).toBe('none');
  const scrim = page.getByRole('button', { name: /Interact with/ });
  await expect(scrim).toBeVisible();
  await scrim.click();
  expect(await iframePointerEvents(page)).toBe('auto');
});

test('#6 custom scroll indicator appears when the column overflows', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 760 }); // 1-col, 3×50vh → overflow
  const three = turn({
    tokens: ['A ', link('One', gg('a')), ' B ', link('Two', gg('b')), ' C ', link('Three', gg('c')), '.'],
  });
  await mockBackend(page, [three]);
  await gotoApp(page);
  await ask(page, 'three?');
  await expect(tileCards(page)).toHaveCount(3);
  const s = await page.evaluate(() => {
    const tiles = document.querySelector('gigi-app').renderRoot.querySelector('gigi-tiles');
    const track = tiles.renderRoot.querySelector('.vscroll');
    const thumb = tiles.renderRoot.querySelector('.vthumb');
    return { hidden: track.hidden, thumbH: thumb.getBoundingClientRect().height, trackW: track.getBoundingClientRect().width };
  });
  expect(s.hidden).toBe(false); // visible because the column overflows
  expect(s.thumbH).toBeGreaterThan(20);
  expect(s.trackW).toBeGreaterThan(8);
});

test('#3 stacked tiles get a tall (≈50vh) min height', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 1000 }); // pane <950 → 1 column
  const two = turn({ tokens: ['A ', link('One', gg('a')), ' B ', link('Two', gg('b')), '.'] });
  await mockBackend(page, [two]);
  await gotoApp(page);
  await ask(page, 'two?');
  await expect(tileCards(page)).toHaveCount(2);
  const g = await tileGeometry(page);
  for (const c of g.cards) expect(c.height).toBeGreaterThan(1000 * 0.45); // ~50vh each
});

test('#4 the grid has padding so a focused tile outline is not clipped', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await mockBackend(page, [turn({ tokens: ['See ', link('Water', gg('water')), '.'] })]);
  await gotoApp(page);
  await ask(page, 'water?');
  await expect(tileCards(page)).toHaveCount(1);
  const pad = await page.evaluate(
    () => getComputedStyle(document.querySelector('gigi-app').renderRoot.querySelector('gigi-tiles').renderRoot.querySelector('.grid')).paddingLeft
  );
  expect(parseFloat(pad)).toBeGreaterThan(0);
});

test('#5 arrow keys move focus between tiles', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const two = turn({ tokens: ['A ', link('One', gg('a')), ' B ', link('Two', gg('b')), '.'] });
  await mockBackend(page, [two]);
  await gotoApp(page);
  await ask(page, 'two?');
  await expect(tileCards(page)).toHaveCount(2);
  await page.evaluate(() =>
    document.querySelector('gigi-app').renderRoot.querySelector('gigi-tiles').renderRoot.querySelector('.card').focus()
  );
  await page.keyboard.press('ArrowRight');
  const activeUrl = await page.evaluate(() =>
    document.querySelector('gigi-app').renderRoot.querySelector('gigi-tiles').renderRoot.activeElement?.getAttribute('data-url')
  );
  expect(activeUrl).toContain('/b'); // moved to the second tile
});

test('#7 an in-iframe navigation shows the per-tile loading bar', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await mockBackend(page, [turn({ tokens: ['See ', link('Water', gg('water')), '.'] })]);
  await gotoApp(page);
  await ask(page, 'water?');
  await expect(tileCards(page)).toHaveCount(1);

  const handle = await page.locator('gigi-tiles iframe').elementHandle();
  const frame = await handle.contentFrame();
  // The framed page signals it is navigating → the tile shows a loading bar.
  await frame.evaluate(() => window.parent.postMessage({ type: 'gigi-navigating' }, '*'));
  await expect(page.locator('gigi-tiles .loadbar')).toBeVisible();
  // A completed load clears it.
  await frame.evaluate(() => location.reload());
  await expect(page.locator('gigi-tiles .loadbar')).toHaveCount(0);
});

test('#8 the chat input is focused on load', async ({ page }) => {
  await mockBackend(page, [turn({ tokens: ['hi'] })]);
  await gotoApp(page);
  await expect(page.getByRole('textbox')).toBeFocused();
});

test('#10 focus inside a tile shows a focus-within outline', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await mockBackend(page, [turn({ tokens: ['See ', link('Water', gg('water')), '.'] })]);
  await gotoApp(page);
  await ask(page, 'water?');
  await expect(tileCards(page)).toHaveCount(1);
  const outline = await page.evaluate(() => {
    const tiles = document.querySelector('gigi-app').renderRoot.querySelector('gigi-tiles');
    const card = tiles.renderRoot.querySelector('.card');
    tiles.renderRoot.querySelector('.icon-close').focus(); // focus a control inside the card
    return getComputedStyle(card).outlineWidth;
  });
  expect(parseFloat(outline)).toBeGreaterThan(0);
});
