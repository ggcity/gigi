/**
 * Scripted BACKEND event sequences, shared by the offline demo (demo/mock-ws.js) and
 * the Playwright suite. Each scenario is an ordered list of `{ at?: ms, event }` where
 * `event` is exactly the JSON the Phase 1 backend would send over the WebSocket.
 *
 * All text is SYNTHETIC and contains no PII (AR 2.16): never seed fixtures with real
 * resident queries. Cited URLs are `https://www.ggcity.org/...` because the chat
 * module's sanitizer keeps only https/mailto/tel links — the tile path requires https.
 * The highlight `quote` values match text in demo/city-page.html so the stub can find
 * and mark them.
 */

export const HUMAN_REDIRECT = {
  label: 'Contact the City of Garden Grove',
  url: 'https://www.ggcity.org/contact',
  phone: '(714) 741-5000',
};

export const NOT_FOUND_TEXT =
  "I could not find this on the City of Garden Grove website. I don't want to guess, " +
  'so I would rather point you to someone who can help directly.';

export const ERROR_TEXT = 'Something went wrong on our end. Please try again.';

const NARRATION = 'Looking this up on the city website…';

const CITYHALL_URL = 'https://www.ggcity.org/cityhall';
const SANITATION_URL = 'https://www.ggcity.org/publicworks/sanitation';
const BULK_URL = 'https://www.ggcity.org/publicworks/bulk-pickup';

// Quotes present in demo/city-page.html: a visible paragraph, a hidden Bootstrap tab, a
// collapsed Bootstrap-4 section. FUZZY_QUOTE is VISIBLE_QUOTE with one corrupted word
// (Friday→Fridey) so the exact path misses and the companion's fuzzy snap recovers it.
// ABSENT_QUOTE is not on the page (the DOM-miss path).
export const VISIBLE_QUOTE = 'City Hall is open Monday through Friday from 7:30 a.m. to 5:30 p.m.';
export const HIDDEN_QUOTE = 'The business license fee is forty-five dollars per year';
export const COLLAPSIBLE_QUOTE = 'Overnight parking permits cost twenty dollars per month';
export const FUZZY_QUOTE = 'City Hall is open Monday through Fridey from 7:30 a.m. to 5:30 p.m.';
export const ABSENT_QUOTE = 'Dog licenses are issued at the north counter on weekday mornings';

/** Build a streaming turn: session → narration → tokens → answer_done (+highlights). */
function streamingTurn({ session = 'demo-1', tokens, highlights = [], tokenDelay = 45 }) {
  const steps = [{ at: 0, event: { type: 'session', session_id: session } }];
  steps.push({ at: 40, event: { type: 'narration', text: NARRATION } });
  tokens.forEach((t, i) =>
    steps.push({ at: i === 0 ? 120 : tokenDelay, event: { type: 'answer_token', text: t } })
  );
  steps.push({ at: tokenDelay, event: { type: 'answer_done', answer: tokens.join('') } });
  // Async highlights arrive after answer_done.
  highlights.forEach((h) => steps.push({ at: 150, event: { type: 'highlight', ...h } }));
  return steps;
}

// A link split across two token chunks (the core streaming hazard the chat handles).
const HAPPY_TOKENS = [
  'City Hall hours and services are on the ',
  '[City Hall page', // opens the link mid-token
  `](${CITYHALL_URL}). `, // closes it on the next token
  'You can visit in person or call ahead.',
];

const MULTI_TOKENS = [
  'Trash pickup details are on the ',
  `[Sanitation page](${SANITATION_URL}). `,
  'For large items, see the ',
  `[Bulk Pickup page](${BULK_URL}).`,
];

export const SCENARIOS = {
  happyPath: streamingTurn({
    tokens: HAPPY_TOKENS,
    highlights: [{ url: CITYHALL_URL, quote: VISIBLE_QUOTE }],
  }),

  hiddenContent: streamingTurn({
    tokens: HAPPY_TOKENS,
    highlights: [{ url: CITYHALL_URL, quote: HIDDEN_QUOTE }],
  }),

  // Quote inside a collapsed Bootstrap-4 section → companion reveals, then highlights.
  collapsibleContent: streamingTurn({
    tokens: HAPPY_TOKENS,
    highlights: [{ url: CITYHALL_URL, quote: COLLAPSIBLE_QUOTE }],
  }),

  // A lightly corrupted quote the exact path misses → fuzzy snap recovers the real text.
  fuzzyMatch: streamingTurn({
    tokens: HAPPY_TOKENS,
    highlights: [{ url: CITYHALL_URL, quote: FUZZY_QUOTE }],
  }),

  // The quote is not on the page → page shown, no highlight, companion reports the miss.
  domMiss: streamingTurn({
    tokens: HAPPY_TOKENS,
    highlights: [{ url: CITYHALL_URL, quote: ABSENT_QUOTE }],
  }),

  multiLink: streamingTurn({
    tokens: MULTI_TOKENS,
    highlights: [
      { url: SANITATION_URL, quote: VISIBLE_QUOTE },
      { url: BULK_URL, quote: VISIBLE_QUOTE },
    ],
  }),

  // A tel: link (no tile — non-http) plus a page link (one tile): shows the filter.
  phoneAndPage: streamingTurn({
    tokens: [
      'You can call Water Billing at ',
      '[(714) 741-5078](tel:7147415078)',
      ', or see the ',
      `[City Hall page](${CITYHALL_URL})`,
      ' for hours.',
    ],
    highlights: [{ url: CITYHALL_URL, quote: VISIBLE_QUOTE }],
  }),

  // Four citations → a 2×2 grid (all visible on a tall screen).
  fourTiles: streamingTurn({
    tokens: [
      'Several pages help here: the ',
      `[City Hall page](${CITYHALL_URL})`,
      ', the ',
      `[Sanitation page](${SANITATION_URL})`,
      ', the ',
      `[Bulk Pickup page](${BULK_URL})`,
      ', and the ',
      '[Finance page](https://www.ggcity.org/finance)',
      '.',
    ],
    highlights: [{ url: CITYHALL_URL, quote: VISIBLE_QUOTE }],
  }),

  // Two different URLs that the backend resolves to the same final page → one is
  // auto-closed (the highlight events carry a shared final_url).
  redirectDup: streamingTurn({
    tokens: [
      'You can pay at ',
      '[Bill Pay](https://www.ggcity.org/billpay)',
      ' or the ',
      `[Water Portal](${CITYHALL_URL})`,
      '.',
    ],
    highlights: [
      { url: 'https://www.ggcity.org/billpay', quote: VISIBLE_QUOTE, final_url: CITYHALL_URL },
      { url: CITYHALL_URL, quote: VISIBLE_QUOTE, final_url: CITYHALL_URL },
    ],
  }),

  notFound: [
    { at: 0, event: { type: 'session', session_id: 'demo-1' } },
    { at: 40, event: { type: 'narration', text: NARRATION } },
    { at: 400, event: { type: 'not_found', text: NOT_FOUND_TEXT, redirect_to_human: HUMAN_REDIRECT } },
  ],

  errorMidTurn: [
    { at: 0, event: { type: 'session', session_id: 'demo-1' } },
    { at: 40, event: { type: 'narration', text: NARRATION } },
    { at: 120, event: { type: 'answer_token', text: 'City parks are open ' } },
    { at: 60, event: { type: 'answer_token', text: 'from dawn' } },
    { at: 200, event: { type: 'error', text: ERROR_TEXT } },
  ],
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);
