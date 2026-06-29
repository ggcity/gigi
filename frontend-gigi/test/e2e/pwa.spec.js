import { test, expect } from '@playwright/test';

// The "simple PWA" layer: a reachable, valid web manifest and the install/theme head tags.
// Independent of the generated PNG icon set (run `npm run gen:icons` to produce those) —
// this asserts the manifest is well-formed and the document advertises installability.

test('manifest is served and valid', async ({ page, baseURL }) => {
  const res = await page.request.get(new URL('/manifest.webmanifest', baseURL).href);
  expect(res.ok()).toBeTruthy();
  const m = await res.json();
  expect(m.name).toContain('Gigi');
  expect(m.display).toBe('standalone');
  expect(m.start_url).toBe('/');
  expect(m.theme_color).toBe('#0b5cab');
  // 192 + 512 in both "any" and "maskable" purposes.
  const purposes = m.icons.map((i) => `${i.sizes}:${i.purpose}`);
  for (const want of ['192x192:any', '512x512:any', '192x192:maskable', '512x512:maskable']) {
    expect(purposes).toContain(want);
  }
});

test('index.html advertises installability and theming', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', /#0b5cab|#0f141b/);
  // viewport-fit=cover enables the safe-area insets the mobile layout uses.
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
});
