import { defineConfig, devices } from '@playwright/test';

// Evergreen matrix: Chromium, Firefox, WebKit (V3.md §7 target browsers).
// Tests drive the REAL shell served by the Vite dev server and mock the backend at
// its boundary with Playwright's `routeWebSocket` (no Anthropic / Chroma / live fetch),
// fulfilling cited city-page requests with the bundled fixture page so the iframe +
// postMessage + highlight path runs for real against the companion stub.
export default defineConfig({
  testDir: './test',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5274',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run dev -- --port 5274 --strictPort',
    url: 'http://localhost:5274',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
