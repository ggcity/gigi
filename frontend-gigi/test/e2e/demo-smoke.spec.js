import { test, expect } from '@playwright/test';

// Smoke the OFFLINE demo (no backend): mock-ws replays a scenario, tiles frame the
// local fixture via resolveSrc, and the companion stub highlights it.
test('offline demo streams, opens a tile, and highlights via the stub', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/demo/');
  await page.waitForSelector('gigi-app');
  await page.selectOption('#scenario', 'happyPath');
  const box = page.getByRole('textbox');
  await box.fill('City Hall hours?');
  await box.press('Enter');
  await expect(page.locator('gigi-tiles .card')).toHaveCount(1);
  const frame = page.frameLocator('gigi-tiles iframe').first();
  await expect(frame.locator('#gigi-hl')).toContainText('City Hall is open Monday through Friday');
  expect(errors).toEqual([]);
});
