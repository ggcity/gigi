import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Guards the dev-only debug logger: the production library bundle must contain
// no debug output. Run `npm run build` first (the verify step does).
const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '../../dist/gigi-chat.js');

test('production bundle strips all dev debug output', async () => {
  expect(
    existsSync(DIST),
    `Built bundle not found at ${DIST} — run "npm run build" before this test.`
  ).toBe(true);

  const code = readFileSync(DIST, 'utf8');
  // The dev logger prefix, the URL verbosity flag, and console.debug calls all
  // live inside `if (import.meta.env.DEV)` blocks, which Vite compiles to
  // `if (false)` and esbuild dead-code-eliminates.
  expect(code).not.toContain('[gigi-chat]');
  expect(code).not.toContain('gigichat-debug');
  expect(code).not.toContain('console.debug');
});
