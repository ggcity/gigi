import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockBackend, gotoApp, ask, tileCards } from '../e2e/helpers.js';
import { SCENARIOS } from '../../demo/fixtures/events.js';

// WCAG 2.1 AA, asserted in every shell state — not just first paint (V3.md §2.8, §7).
// Scoped to the four WCAG tags so best-practice-only rules don't gate. The cross-origin
// fixture iframe is outside our conformance scope and axe cannot descend into it.
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// Wait for the morph's Web Animations to finish so axe samples the SETTLED layout —
// otherwise it can read tile colors mid-fade (opacity < 1, tokens blended toward the
// backdrop) and report transient contrast failures that don't exist at rest.
async function settle(page) {
  await page.locator('gigi-app').evaluate(async (el) => {
    const root = el.renderRoot;
    if (!root) return;
    const anims = [];
    root.querySelectorAll('.chat-pane, .tiles-pane').forEach((n) => {
      if (n.getAnimations) anims.push(...n.getAnimations());
    });
    await Promise.all(anims.map((a) => a.finished.catch(() => {})));
  });
}

async function scan(page) {
  await settle(page);
  const results = await new AxeBuilder({ page })
    .withTags(WCAG)
    // The framed city page is the city's own responsibility and independently in scope
    // (V3.md §2.8); exclude the iframe's contents so we assert only the shell surface.
    .exclude(['gigi-app', 'gigi-tiles', 'iframe'])
    .analyze();
  return results.violations;
}

test('centered idle state is axe-clean', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.happyPath]);
  await gotoApp(page);
  expect(await scan(page)).toEqual([]);
});

test('tiled state (answer + open tile) is axe-clean', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.happyPath]);
  await gotoApp(page);
  await ask(page, 'City Hall hours?');
  await expect(tileCards(page)).toHaveCount(1);
  expect(await scan(page)).toEqual([]);
});

test('not-found state is axe-clean', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.notFound]);
  await gotoApp(page);
  await ask(page, 'file my taxes?');
  await expect(page.getByRole('link', { name: '(714) 741-5000' })).toBeVisible();
  expect(await scan(page)).toEqual([]);
});

test('dark theme tiled state is axe-clean', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.happyPath]);
  await gotoApp(page);
  await page.locator('gigi-app').evaluate((el) => el.setAttribute('data-theme', 'dark'));
  await ask(page, 'City Hall hours?');
  await expect(tileCards(page)).toHaveCount(1);
  expect(await scan(page)).toEqual([]);
});

test('every tile iframe has a descriptive title', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.happyPath]);
  await gotoApp(page);
  await ask(page, 'City Hall hours?');
  await expect(tileCards(page)).toHaveCount(1);
  const title = await page.locator('gigi-tiles iframe').first().getAttribute('title');
  expect(title).toMatch(/opened by Gigi/);
});
