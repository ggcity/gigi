import { test, expect } from '@playwright/test';
import { mockBackend, gotoApp, ask, tileCards, tileFrame } from './helpers.js';
import { SCENARIOS, VISIBLE_QUOTE, HIDDEN_QUOTE } from '../../demo/fixtures/events.js';

// The async highlight path: after answer_done the backend emits highlight {url, quote};
// the shell forwards it to the matching open tile via origin-checked postMessage; the
// fixture page's companion stub marks the text and acks. (Real companion is Phase 4.)

test('a highlight event marks the verified quote in the framed page', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.happyPath]); // highlights VISIBLE_QUOTE on the City Hall page
  await gotoApp(page);
  await ask(page, 'City Hall hours?');

  await expect(tileCards(page)).toHaveCount(1);

  const frame = tileFrame(page);
  const mark = frame.locator('#gigi-hl');
  await expect(mark).toBeVisible();
  await expect(mark).toContainText(VISIBLE_QUOTE);

  // The tile shows a non-color-only "quote shown" cue.
  await expect(page.locator('gigi-tiles .hl-badge')).toBeVisible();
});

test('a highlight in a hidden Bootstrap tab reveals the tab, then marks the quote', async ({ page }) => {
  await mockBackend(page, [SCENARIOS.hiddenContent]); // highlights HIDDEN_QUOTE (in the Fees tab)
  await gotoApp(page);
  await ask(page, 'business license fee?');

  await expect(tileCards(page)).toHaveCount(1);

  const frame = tileFrame(page);
  // The fees pane starts hidden; the stub reveals it before marking.
  await expect(frame.locator('#fees')).toBeVisible();
  await expect(frame.locator('#gigi-hl')).toContainText(HIDDEN_QUOTE);
});
