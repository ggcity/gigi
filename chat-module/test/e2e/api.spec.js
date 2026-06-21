import { test, expect } from '@playwright/test';
import { gotoChat, call, flush, events } from './helpers.js';
import { HUMAN_REDIRECT, NOT_FOUND_TEXT } from '../fixtures/streams.js';

const SPLIT = [
  'You can pay your water bill online through the ',
  '[Online Bill Pay',
  ' portal](https://www.ggcity.org/finance/pay-bill)',
  ' or in person at City Hall.',
];
const SPLIT_FULL = SPLIT.join('');

test.beforeEach(async ({ page }) => {
  await gotoChat(page);
});

test('gigi-submit crosses the shadow boundary and renders the user bubble', async ({ page }) => {
  await page.locator('gigi-chat .input').fill('How do I pay my water bill?');
  await page.locator('gigi-chat .input').press('Enter');
  await flush(page);

  const ev = await events(page);
  const submit = ev.find((e) => e.type === 'gigi-submit');
  expect(submit).toBeTruthy();
  expect(submit.detail.text).toBe('How do I pay my water bill?');

  await expect(page.locator('gigi-chat .msg-user')).toHaveText(/How do I pay my water bill\?/);
  // Input is cleared after submit.
  await expect(page.locator('gigi-chat .input')).toHaveValue('');
});

test('a link split across two token chunks renders as a single anchor', async ({ page }) => {
  await call(page, 'beginAssistantMessage');
  for (const t of SPLIT) {
    await call(page, 'appendAssistantToken', t);
    await flush(page);
  }
  await call(page, 'endAssistantMessage', SPLIT_FULL);
  await flush(page);

  const links = page.locator('gigi-chat .msg-assistant a');
  await expect(links).toHaveCount(1);
  await expect(links.first()).toHaveAttribute('href', 'https://www.ggcity.org/finance/pay-bill');
  await expect(links.first()).toHaveText('Online Bill Pay portal');
});

test('citation-detected fires during stream; answer-complete carries parsed citations', async ({ page }) => {
  await call(page, 'beginAssistantMessage');
  for (const t of SPLIT) {
    await call(page, 'appendAssistantToken', t);
    await flush(page);
  }
  await call(page, 'endAssistantMessage', SPLIT_FULL);
  await flush(page);

  const ev = await events(page);
  const detected = ev.filter((e) => e.type === 'gigi-citation-detected');
  expect(detected.length).toBe(1);
  expect(detected[0].detail.url).toBe('https://www.ggcity.org/finance/pay-bill');

  const complete = ev.find((e) => e.type === 'gigi-answer-complete');
  expect(complete).toBeTruthy();
  expect(complete.detail.answer).toBe(SPLIT_FULL);
  expect(complete.detail.citations).toHaveLength(1);
  expect(complete.detail.citations[0].text).toBe('Online Bill Pay portal');
});

test('clicking a citation is prevented and dispatches gigi-citation-click (no navigation)', async ({ page }) => {
  const startUrl = page.url();
  await call(page, 'beginAssistantMessage');
  await call(page, 'appendAssistantToken', SPLIT_FULL);
  await flush(page);
  await call(page, 'endAssistantMessage', SPLIT_FULL);
  await flush(page);

  await page.locator('gigi-chat .msg-assistant a').first().click();
  await flush(page);

  expect(page.url()).toBe(startUrl); // did not navigate
  const ev = await events(page);
  const click = ev.find((e) => e.type === 'gigi-citation-click');
  expect(click).toBeTruthy();
  expect(click.detail.url).toBe('https://www.ggcity.org/finance/pay-bill');
});

test('answer live region is empty mid-stream and populated exactly once at the end', async ({ page }) => {
  const region = page.locator('gigi-chat #live-answer');

  await call(page, 'beginAssistantMessage');
  await call(page, 'appendAssistantToken', SPLIT[0]);
  await flush(page);
  await call(page, 'appendAssistantToken', SPLIT[1]);
  await flush(page);
  // Mid-stream: nothing announced yet.
  await expect(region).toHaveText('');

  await call(page, 'appendAssistantToken', SPLIT[2]);
  await call(page, 'appendAssistantToken', SPLIT[3]);
  await call(page, 'endAssistantMessage', SPLIT_FULL);
  await flush(page);

  await expect(region).toContainText('You can pay your water bill online');
  await expect(region).not.toContainText('['); // flattened: no raw markdown syntax
});

test('busy state disables the input during a turn and re-enables after', async ({ page }) => {
  const input = page.locator('gigi-chat .input');
  await expect(input).toHaveAttribute('aria-disabled', 'false');

  await call(page, 'beginAssistantMessage');
  await flush(page);
  await expect(input).toHaveAttribute('aria-disabled', 'true');

  await call(page, 'endAssistantMessage', SPLIT_FULL);
  await flush(page);
  await expect(input).toHaveAttribute('aria-disabled', 'false');
});

test('not-found renders the message and a human-redirect block with a tel link', async ({ page }) => {
  await call(page, 'showNotFound', NOT_FOUND_TEXT, HUMAN_REDIRECT);
  await flush(page);

  await expect(page.locator('gigi-chat .msg-assistant')).toContainText('could not find this');
  const redirect = page.locator('gigi-chat .redirect');
  await expect(redirect).toContainText('Contact the City of Garden Grove');
  await expect(redirect.locator('a[href^="tel:"]')).toHaveText('(714) 741-5000');
  // Not-found is a terminal state: not busy.
  await expect(page.locator('gigi-chat .input')).toHaveAttribute('aria-disabled', 'false');
});

test('error mid-turn clears busy and shows the error', async ({ page }) => {
  await call(page, 'beginAssistantMessage');
  await call(page, 'appendAssistantToken', 'City parks are open ');
  await flush(page);
  await call(page, 'showError', 'Something went wrong on our end.');
  await flush(page);

  await expect(page.locator('gigi-chat .msg.is-error')).toContainText('Something went wrong');
  await expect(page.locator('gigi-chat .input')).toHaveAttribute('aria-disabled', 'false');
});

test('rapid token burst reconciles to the full answer with no drops or dups', async ({ page }) => {
  const full =
    'Here are the steps to start water service: submit an application, provide proof of residency, pay the deposit, and schedule a start date.';
  const tokens = full.match(/.{1,3}/g);

  await call(page, 'beginAssistantMessage');
  for (const t of tokens) await call(page, 'appendAssistantToken', t); // no flush between → burst
  await flush(page);
  await call(page, 'endAssistantMessage', full);
  await flush(page);

  await expect(page.locator('gigi-chat .msg-assistant .content')).toHaveText(full);
});

test('per-message Copy writes plain text with links as "text (url)"', async ({ page }) => {
  await call(page, 'beginAssistantMessage');
  await call(page, 'appendAssistantToken', SPLIT_FULL);
  await flush(page);
  await call(page, 'endAssistantMessage', SPLIT_FULL);
  await flush(page);

  await page.locator('gigi-chat .msg-assistant .copy').click();
  await flush(page);

  const copied = await page.evaluate(() => window.__copied);
  expect(copied).toContain('Online Bill Pay portal (https://www.ggcity.org/finance/pay-bill)');
  await expect(page.locator('gigi-chat #live-action')).toHaveText('Response copied.');

  const ev = await events(page);
  const c = ev.find((e) => e.type === 'gigi-copy');
  expect(c.detail.scope).toBe('message');
});

test('copyConversation copies You/Gigi blocks with flattened links', async ({ page }) => {
  await call(page, 'appendUserMessage', 'How do I pay my water bill?');
  await call(page, 'beginAssistantMessage');
  await call(page, 'appendAssistantToken', SPLIT_FULL);
  await flush(page);
  await call(page, 'endAssistantMessage', SPLIT_FULL);
  await flush(page);

  await call(page, 'copyConversation');
  await flush(page);

  const copied = await page.evaluate(() => window.__copied);
  expect(copied).toContain('You: How do I pay my water bill?');
  expect(copied).toContain('Gigi: You can pay your water bill');
  expect(copied).toContain('(https://www.ggcity.org/finance/pay-bill)');
});

test('toolbar is gated by show-toolbar; New chat clears + emits gigi-new-session', async ({ page }) => {
  // The demo element sets show-toolbar.
  await expect(page.locator('gigi-chat .toolbar')).toHaveCount(1);

  await call(page, 'appendUserMessage', 'hello');
  await flush(page);
  await expect(page.locator('gigi-chat .msg-user')).toHaveCount(1);

  await page.locator('gigi-chat .toolbar button', { hasText: 'New chat' }).click();
  await flush(page);
  await expect(page.locator('gigi-chat .msg-user')).toHaveCount(0);
  const ev = await events(page);
  expect(ev.some((e) => e.type === 'gigi-new-session')).toBe(true);

  // Removing the attribute hides the toolbar (default off).
  await page.evaluate(() => document.querySelector('gigi-chat').removeAttribute('show-toolbar'));
  await flush(page);
  await expect(page.locator('gigi-chat .toolbar')).toHaveCount(0);
});

test('narration-position="bottom" reorders the status below the transcript', async ({ page }) => {
  const order = () =>
    page.evaluate(
      () => getComputedStyle(document.querySelector('gigi-chat').shadowRoot.querySelector('.status')).order
    );
  expect(await order()).toBe('0');
  await page.evaluate(() => document.querySelector('gigi-chat').setAttribute('narration-position', 'bottom'));
  await flush(page);
  expect(await order()).toBe('2');
});

test('avatars are hidden by default and shown via CSS custom properties', async ({ page }) => {
  await call(page, 'beginAssistantMessage');
  await call(page, 'appendAssistantToken', 'hi');
  await flush(page);
  await call(page, 'endAssistantMessage', 'hi');
  await flush(page);

  const display = () =>
    page.evaluate(
      () =>
        getComputedStyle(
          document.querySelector('gigi-chat').shadowRoot.querySelector('.row-assistant .avatar')
        ).display
    );
  expect(await display()).toBe('none');

  await page.evaluate(() => {
    const c = document.querySelector('gigi-chat');
    c.style.setProperty('--gigi-chat-avatar-display', 'block');
    c.style.setProperty('--gigi-chat-assistant-avatar', 'url(data:image/svg+xml,<svg/>)');
  });
  await flush(page);
  expect(await display()).toBe('block');
});

test('exposes ::part hooks (message/streaming/caret) for host-driven animation', async ({ page }) => {
  await call(page, 'beginAssistantMessage');
  await call(page, 'appendAssistantToken', 'Working on it');
  await flush(page);

  // While streaming: row exposes message + streaming parts; caret part present.
  const row = page.locator('gigi-chat .msg-assistant');
  await expect(row).toHaveAttribute('part', /(^|\s)message(\s|$)/);
  await expect(row).toHaveAttribute('part', /(^|\s)streaming(\s|$)/);
  await expect(page.locator('gigi-chat .caret')).toHaveAttribute('part', 'caret');

  await call(page, 'endAssistantMessage', 'Working on it');
  await flush(page);

  // After completion: streaming part and caret are gone; message part remains.
  await expect(row).toHaveAttribute('part', /(^|\s)message(\s|$)/);
  await expect(row).not.toHaveAttribute('part', /streaming/);
  await expect(page.locator('gigi-chat .caret')).toHaveCount(0);
});

test('renderCitations shows an accessible Sources list whose clicks delegate', async ({ page }) => {
  const items = [
    { url: 'https://www.ggcity.org/publicworks/sanitation', text: 'Sanitation page' },
    { url: 'https://www.ggcity.org/publicworks/bulk-pickup', text: 'Bulk Pickup page' },
  ];
  await call(page, 'beginAssistantMessage');
  await call(page, 'appendAssistantToken', 'Trash info is on the city site.');
  await flush(page);
  await call(page, 'endAssistantMessage', 'Trash info is on the city site.');
  await call(page, 'renderCitations', items);
  await flush(page);

  const sources = page.locator('gigi-chat .sources');
  await expect(sources.locator('h3')).toHaveText('Sources');
  await expect(sources.locator('ol li')).toHaveCount(2);

  await sources.locator('a').first().click();
  await flush(page);
  const ev = await events(page);
  const click = ev.find((e) => e.type === 'gigi-citation-click');
  expect(click.detail.url).toBe('https://www.ggcity.org/publicworks/sanitation');
});
