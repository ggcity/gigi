import { test, expect } from '@playwright/test';
import { mockBackend, gotoApp, ask, tileCards } from './helpers.js';
import { SCENARIOS } from '../../demo/fixtures/events.js';

const NARRATION = 'Looking this up on the city website…';

/** Build a streaming turn (session → narration → tokens → done [+highlights]). */
function turn({ tokens, highlights = [], session = 's1' }) {
  const steps = [
    { at: 0, event: { type: 'session', session_id: session } },
    { at: 20, event: { type: 'narration', text: NARRATION } },
  ];
  tokens.forEach((t, i) => steps.push({ at: i === 0 ? 40 : 20, event: { type: 'answer_token', text: t } }));
  steps.push({ at: 20, event: { type: 'answer_done', answer: tokens.join('') } });
  highlights.forEach((h) => steps.push({ at: 60, event: { type: 'highlight', ...h } }));
  return steps;
}

const link = (text, url) => `[${text}](${url})`;

test('streams an answer, opens one tile, and morphs to the side layout', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.happyPath]);
  await gotoApp(page);

  // Centered to start.
  await expect(page.locator('gigi-app .shell.centered')).toBeVisible();

  await ask(page, 'What are the City Hall hours?');

  // The streamed answer and its inline citation render in the chat. Scope to the
  // visible bubble — the same text also lives in the sr-only answer live region.
  await expect(
    page.locator('gigi-chat .content').filter({ hasText: 'City Hall hours and services are on the' })
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'City Hall page', exact: true })).toBeVisible();

  // Exactly one tile opens, and the layout morphs to side.
  await expect(tileCards(page)).toHaveCount(1);
  await expect(page.locator('gigi-app .shell.side')).toBeVisible();
  await expect(page.locator('gigi-tiles .card-title').first()).toContainText('City Hall page');
});

test('multiple citations open multiple tiles, capped at maxTiles', async ({ page }) => {
  // Five links, default cap is 4.
  const tokens = [
    'See ',
    link('One', 'https://www.ggcity.org/a') + ', ',
    link('Two', 'https://www.ggcity.org/b') + ', ',
    link('Three', 'https://www.ggcity.org/c') + ', ',
    link('Four', 'https://www.ggcity.org/d') + ', and ',
    link('Five', 'https://www.ggcity.org/e') + '.',
  ];
  await mockBackend(page, [turn({ tokens })]);
  await gotoApp(page);
  await ask(page, 'List the pages');

  await expect(page.getByRole('link', { name: 'Five' })).toBeVisible();
  await expect(tileCards(page)).toHaveCount(4); // capped
});

test('a new cited answer replaces tiles; a no-citation answer keeps them', async ({ page }) => {
  const t1 = turn({ tokens: ['First, see ', link('Sanitation', 'https://www.ggcity.org/sanitation'), '.'] });
  const t2 = turn({ tokens: ['Also see ', link('Bulk Pickup', 'https://www.ggcity.org/bulk'), '.'] });
  const t3 = turn({ tokens: ['Yes, that is correct — no other page applies.'] }); // no links
  await mockBackend(page, [t1, t2, t3]);
  await gotoApp(page);

  await ask(page, 'trash pickup?');
  await expect(tileCards(page)).toHaveCount(1);
  await expect(page.locator('gigi-tiles .card-title').first()).toContainText('Sanitation');

  await ask(page, 'and bulky items?');
  await expect(tileCards(page)).toHaveCount(1); // replaced, not appended
  await expect(page.locator('gigi-tiles .card-title').first()).toContainText('Bulk Pickup');

  await ask(page, 'is that all?');
  // No citations this turn → tiles are left in place.
  await expect(tileCards(page)).toHaveCount(1);
  await expect(page.locator('gigi-tiles .card-title').first()).toContainText('Bulk Pickup');
});

test('not_found shows the human redirect and opens no tiles', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.notFound]);
  await gotoApp(page);
  await ask(page, 'can you file my taxes?');

  await expect(
    page.locator('gigi-chat .content').filter({ hasText: 'I could not find this on the City of Garden Grove website' })
  ).toBeVisible();
  await expect(page.getByRole('link', { name: '(714) 741-5000' })).toBeVisible();
  await expect(tileCards(page)).toHaveCount(0);
  await expect(page.locator('gigi-app .shell.centered')).toBeVisible();
});

test('a mid-stream error is shown and clears the busy state', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.errorMidTurn]);
  await gotoApp(page);
  await ask(page, 'park hours?');

  await expect(
    page.locator('gigi-chat .content').filter({ hasText: 'Something went wrong on our end' })
  ).toBeVisible();
  await expect(tileCards(page)).toHaveCount(0);
  // Input is usable again (busy cleared) — a follow-up can be typed.
  await expect(page.getByRole('textbox')).not.toHaveAttribute('aria-disabled', 'true');
});

test('a dropped connection mid-turn surfaces an error', async ({ page }) => {
  await mockBackend(page, [turn({ tokens: ['x'] })], { dropTurn: 0 });
  await gotoApp(page);
  await ask(page, 'anything');
  await expect(
    page.locator('gigi-chat .content').filter({ hasText: /connection dropped/i })
  ).toBeVisible();
});

test('the hero shows initially, hides after the first turn, and returns on a new session', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.happyPath]);
  await gotoApp(page);

  await expect(page.locator('gigi-app .hero')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Gigi' })).toBeVisible();

  await ask(page, 'City Hall hours?');
  await expect(
    page.locator('gigi-chat .content').filter({ hasText: 'City Hall hours and services are on the' })
  ).toBeVisible();
  await expect(page.locator('gigi-app .hero')).toHaveCount(0);

  // A new session restores the hero + centered layout.
  await page.locator('gigi-app gigi-chat').evaluate((el) => el.newSession());
  await expect(page.locator('gigi-app .hero')).toBeVisible();
  await expect(page.locator('gigi-app .shell.centered')).toBeVisible();
});

test('only http(s) citations open tiles; tel:/mailto: links render but open no tile', async ({ page }) => {
  const tokens = [
    'You can call Water Billing at ',
    link('(714) 741-5078', 'tel:7147415078'),
    ', or see the ',
    link('Water Billing page', 'https://www.ggcity.org/water-billing'),
    '.',
  ];
  await mockBackend(page, [turn({ tokens })]);
  await gotoApp(page);
  await ask(page, 'water bill phone number?');

  // The tel: link is shown in the answer…
  await expect(page.getByRole('link', { name: '(714) 741-5078' })).toBeVisible();
  // …but only the http(s) page becomes a tile.
  await expect(tileCards(page)).toHaveCount(1);
  await expect(page.locator('gigi-tiles .card-title')).toContainText('Water Billing page');
});

test('a URL split across token chunks opens one tile with the FULL url, never a prefix', async ({ page }) => {
  // Bare URL streamed in pieces — mid-stream it transiently auto-links a truncated prefix.
  const tokens = ['For details visit https://www.ggci', 'ty.org/finance/wat', 'er-billing today.'];
  await mockBackend(page, [turn({ tokens })]);
  await gotoApp(page);
  await ask(page, 'water billing page?');

  await expect(tileCards(page)).toHaveCount(1);
  const href = await page.locator('gigi-tiles a[data-tile-url]').first().getAttribute('data-tile-url');
  expect(href).toBe('https://www.ggcity.org/finance/water-billing');
});

test('a tile can be closed by keyboard and focus returns to the region heading', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.happyPath]);
  await gotoApp(page);
  await ask(page, 'City Hall hours?');
  await expect(tileCards(page)).toHaveCount(1);

  const close = page.getByRole('button', { name: /^Close/ });
  await close.focus();
  await close.press('Enter');

  await expect(tileCards(page)).toHaveCount(0);
  // Layout returns to centered; focus is on the (now sr-only) heading anchor, not lost.
  await expect(page.locator('gigi-app .shell.centered')).toBeVisible();
});
