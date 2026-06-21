import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { gotoChat, call, flush } from '../e2e/helpers.js';
import { HUMAN_REDIRECT, NOT_FOUND_TEXT } from '../fixtures/streams.js';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const FULL = 'You can pay your water bill at the [Online Bill Pay portal](https://www.ggcity.org/finance/pay-bill).';

async function scan(page) {
  // axe traverses the open shadow root; include the component subtree.
  return new AxeBuilder({ page }).include('gigi-chat').withTags(WCAG_TAGS).analyze();
}

test.beforeEach(async ({ page }) => {
  await gotoChat(page);
});

test('idle state has no WCAG 2.1 AA violations', async ({ page }) => {
  const results = await scan(page);
  expect(results.violations).toEqual([]);
});

test('mid-stream state has no violations', async ({ page }) => {
  await call(page, 'beginAssistantMessage');
  await call(page, 'appendAssistantToken', FULL.slice(0, 40));
  await flush(page);
  const results = await scan(page);
  expect(results.violations).toEqual([]);
});

test('completed-answer state has no violations', async ({ page }) => {
  await call(page, 'appendUserMessage', 'How do I pay my water bill?');
  await call(page, 'beginAssistantMessage');
  await call(page, 'appendAssistantToken', FULL);
  await flush(page);
  await call(page, 'endAssistantMessage', FULL);
  await call(page, 'renderCitations', [
    { url: 'https://www.ggcity.org/finance/pay-bill', text: 'Online Bill Pay portal' },
  ]);
  await flush(page);
  const results = await scan(page);
  expect(results.violations).toEqual([]);
});

test('not-found state has no violations', async ({ page }) => {
  await call(page, 'showNotFound', NOT_FOUND_TEXT, HUMAN_REDIRECT);
  await flush(page);
  const results = await scan(page);
  expect(results.violations).toEqual([]);
});

test('error state has no violations', async ({ page }) => {
  await call(page, 'showError', 'Something went wrong on our end. Please try again.');
  await flush(page);
  const results = await scan(page);
  expect(results.violations).toEqual([]);
});

test('dark mode (OS-auto) completed-answer state has no contrast violations', async ({ page }) => {
  // Emulate an OS dark preference; the component switches palette via its
  // prefers-color-scheme media query (no data-theme set).
  await page.emulateMedia({ colorScheme: 'dark' });
  await call(page, 'appendUserMessage', 'How do I pay my water bill?');
  await call(page, 'beginAssistantMessage');
  await call(page, 'appendAssistantToken', FULL);
  await flush(page);
  await call(page, 'endAssistantMessage', FULL);
  await call(page, 'renderCitations', [
    { url: 'https://www.ggcity.org/finance/pay-bill', text: 'Online Bill Pay portal' },
  ]);
  await flush(page);
  const results = await scan(page);
  expect(results.violations).toEqual([]);
});

test('toolbar + per-message copy + avatars shown has no violations', async ({ page }) => {
  await page.evaluate(() => {
    const c = document.querySelector('gigi-chat');
    c.setAttribute('show-toolbar', '');
    c.style.setProperty('--gigi-chat-avatar-display', 'block');
    c.style.setProperty('--gigi-chat-assistant-avatar', 'url(data:image/svg+xml,<svg/>)');
    c.style.setProperty('--gigi-chat-user-avatar', 'url(data:image/svg+xml,<svg/>)');
  });
  await call(page, 'appendUserMessage', 'How do I pay my water bill?');
  await call(page, 'beginAssistantMessage');
  await call(page, 'appendAssistantToken', FULL);
  await flush(page);
  await call(page, 'endAssistantMessage', FULL);
  await flush(page);
  const results = await scan(page);
  expect(results.violations).toEqual([]);
});

test('forced dark via data-theme has no violations in a light OS', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => document.querySelector('gigi-chat').setAttribute('data-theme', 'dark'));
  await call(page, 'beginAssistantMessage');
  await call(page, 'appendAssistantToken', FULL);
  await flush(page);
  await call(page, 'endAssistantMessage', FULL);
  await flush(page);
  const results = await scan(page);
  expect(results.violations).toEqual([]);
});
