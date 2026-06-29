import { test, expect } from '@playwright/test';

// Unit coverage for the gnarly pure logic, exercised in a real browser by importing the
// served ES modules directly (Vite serves /src/*.js). No backend, no app shell.

test.beforeEach(async ({ page }) => {
  await page.goto('/'); // any served page; we import modules into its context
});

test('urls: defrag, sameTarget, and the tile host/scheme guard', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import('/src/urls.js');
    return {
      defrag: m.defrag('https://www.ggcity.org/a/b#section'),
      sameYes: m.sameTarget('https://www.ggcity.org/a#x', 'https://www.ggcity.org/a#y'),
      sameNo: m.sameTarget('https://www.ggcity.org/a', 'https://www.ggcity.org/b'),
      gg: m.guardTileUrl('https://www.ggcity.org/p'),
      sub: m.guardTileUrl('https://sub.ggcity.org/p'),
      bareHost: m.guardTileUrl('https://ggcity.org/p'),
      evil: m.guardTileUrl('https://evil.example/p'),
      js: m.guardTileUrl('javascript:alert(1)'),
      local: m.guardTileUrl('http://localhost:5274/demo/city-page.html'),
    };
  });
  expect(r.defrag).toBe('https://www.ggcity.org/a/b');
  expect(r.sameYes).toBe(true);
  expect(r.sameNo).toBe(false);
  expect(r.gg.ok).toBe(true);
  expect(r.sub.ok).toBe(true);
  expect(r.bareHost.ok).toBe(true);
  expect(r.evil.ok).toBe(false);
  expect(r.js.ok).toBe(false);
  expect(r.local.ok).toBe(true); // localhost always allowed for fixtures
});

test('urls: canonicalize collapses cosmetic differences', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import('/src/urls.js');
    const c = m.canonicalize;
    return {
      trailing: c('https://www.ggcity.org/water/') === c('https://www.ggcity.org/water'),
      index: c('https://www.ggcity.org/water/index.html') === c('https://www.ggcity.org/water'),
      utm: c('https://www.ggcity.org/water?utm_source=x&id=5') === c('https://www.ggcity.org/water?id=5'),
      caseHost: c('https://WWW.GGCITY.ORG/Water') === c('https://www.ggcity.org/Water'),
      paramOrder: c('https://www.ggcity.org/p?a=1&b=2') === c('https://www.ggcity.org/p?b=2&a=1'),
      distinct: c('https://www.ggcity.org/water') === c('https://www.ggcity.org/sewer'),
    };
  });
  expect(r.trailing).toBe(true);
  expect(r.index).toBe(true);
  expect(r.utm).toBe(true);
  expect(r.caseHost).toBe(true);
  expect(r.paramOrder).toBe(true);
  expect(r.distinct).toBe(false);
});

test('urls: buildDeepLink carries the verified quote as a #gigi= fragment', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await import('/src/urls.js');
    return {
      withQuote: m.buildDeepLink('https://www.ggcity.org/water', 'pay your water bill'),
      encodes: m.buildDeepLink('https://www.ggcity.org/p', 'a & b'),
      replacesFrag: m.buildDeepLink('https://www.ggcity.org/p#old', 'q'),
      emptyQuote: m.buildDeepLink('https://www.ggcity.org/water', ''),
      noQuote: m.buildDeepLink('https://www.ggcity.org/water'),
    };
  });
  expect(r.withQuote).toBe('https://www.ggcity.org/water#gigi=pay%20your%20water%20bill');
  expect(r.encodes).toBe('https://www.ggcity.org/p#gigi=a%20%26%20b');
  expect(r.replacesFrag).toBe('https://www.ggcity.org/p#gigi=q'); // companion owns #gigi=
  expect(r.emptyQuote).toBe('https://www.ggcity.org/water'); // no fragment without a quote
  expect(r.noQuote).toBe('https://www.ggcity.org/water');
});

test('GigiSocket: parses the event protocol and dispatches to handlers', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { GigiSocket } = await import('/src/ws-client.js');
    const calls = [];
    const s = new GigiSocket(
      {
        onSession: (id) => calls.push(['session', id]),
        onNarration: (t) => calls.push(['narration', t]),
        onToken: (t) => calls.push(['token', t]),
        onDone: (a) => calls.push(['done', a]),
        onHighlight: (h) => calls.push(['highlight', h.url, h.quote]),
        onNotFound: (t, redir) => calls.push(['not_found', t, redir?.phone]),
        onError: (t) => calls.push(['error', t]),
      },
      { WebSocketImpl: function () {} }
    );
    s._handleData(JSON.stringify({ type: 'session', session_id: 'abc' }));
    s._handleData(JSON.stringify({ type: 'narration', text: 'looking' }));
    s._handleData(JSON.stringify({ type: 'answer_token', text: 'A' }));
    s._handleData(JSON.stringify({ type: 'answer_done', answer: 'A.' }));
    s._handleData(JSON.stringify({ type: 'highlight', url: 'u', quote: 'q' }));
    s._handleData(JSON.stringify({ type: 'not_found', text: 'nope', redirect_to_human: { phone: '(714) 741-5000' } }));
    s._handleData(JSON.stringify({ type: 'error', text: 'boom' }));
    s._handleData('not json'); // ignored, no throw
    return { calls, sessionId: s.sessionId };
  });
  expect(r.sessionId).toBe('abc');
  expect(r.calls).toContainEqual(['session', 'abc']);
  expect(r.calls).toContainEqual(['narration', 'looking']);
  expect(r.calls).toContainEqual(['token', 'A']);
  expect(r.calls).toContainEqual(['done', 'A.']);
  expect(r.calls).toContainEqual(['highlight', 'u', 'q']);
  expect(r.calls).toContainEqual(['not_found', 'nope', '(714) 741-5000']);
  expect(r.calls).toContainEqual(['error', 'boom']);
});

test('GigiSocket: replays the captured session id on the next query', async ({ page }) => {
  const sent = await page.evaluate(async () => {
    const { GigiSocket } = await import('/src/ws-client.js');
    const sends = [];
    class FakeWS {
      constructor() {
        this.readyState = 0;
        setTimeout(() => {
          this.readyState = 1;
          this.onopen && this.onopen();
        }, 0);
      }
      send(d) {
        sends.push(d);
      }
      close() {}
    }
    const s = new GigiSocket({}, { WebSocketImpl: FakeWS });
    s._handleData(JSON.stringify({ type: 'session', session_id: 'sess-1' }));
    await s.query('hello');
    return sends;
  });
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0])).toMatchObject({ type: 'query', text: 'hello', session_id: 'sess-1' });
});

test('GigiSocket: a close while a turn is active surfaces an error', async ({ page }) => {
  const errs = await page.evaluate(async () => {
    const { GigiSocket } = await import('/src/ws-client.js');
    const errors = [];
    class FakeWS {
      constructor() {
        this.readyState = 0;
        setTimeout(() => {
          this.readyState = 1;
          this.onopen && this.onopen();
        }, 0);
      }
      send() {}
      close() {
        this.readyState = 3;
        this.onclose && this.onclose();
      }
    }
    const s = new GigiSocket({ onError: (t) => errors.push(t) }, { WebSocketImpl: FakeWS, maxBackoffMs: 1 });
    await s.query('hi'); // turn active
    s._handleClose(); // simulate a drop before answer_done
    s.close();
    return errors;
  });
  expect(errs.some((e) => /dropped/i.test(e))).toBe(true);
});
