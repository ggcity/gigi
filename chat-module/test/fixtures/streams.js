/**
 * Canonical scripted scenarios, shared by the demo harness (demo/runner.js) and
 * the Playwright suite so both exercise identical sequences.
 *
 * A scenario is an ordered list of steps. Each step is a public-API call:
 *   { at?: number(ms delay before this step), call: methodName, args: [...] }
 *
 * All text here is SYNTHETIC and contains no PII (AR 2.16): never seed fixtures
 * with real resident queries.
 */

/** Mirrors the backend `not_found.redirect_to_human` shape exactly. */
export const HUMAN_REDIRECT = {
  label: 'Contact the City of Garden Grove',
  url: 'https://www.ggcity.org/contact',
  phone: '(714) 741-5000',
};

export const NOT_FOUND_TEXT =
  "I could not find this on the City of Garden Grove website. I don't want to guess, " +
  'so I would rather point you to someone who can help directly.';

export const THROTTLE_TEXT =
  "You've sent a lot of requests in a short time. Please wait a moment and try again.";

export const ERROR_TEXT = 'Something went wrong on our end. Please try again.';

const NARRATION = 'Looking this up on the city website…';

/** Build the step list for a streaming assistant turn. */
function streamingTurn({ user, narration = NARRATION, tokens, tokenDelay = 40, citations }) {
  const steps = [];
  if (user) steps.push({ call: 'appendUserMessage', args: [user] });
  if (narration) steps.push({ at: 50, call: 'setNarration', args: [narration] });
  steps.push({ at: 150, call: 'beginAssistantMessage', args: [] });
  tokens.forEach((t, i) =>
    steps.push({ at: i === 0 ? 100 : tokenDelay, call: 'appendAssistantToken', args: [t] })
  );
  steps.push({ at: tokenDelay, call: 'endAssistantMessage', args: [tokens.join('')] });
  if (citations) steps.push({ at: 30, call: 'renderCitations', args: [citations] });
  return steps;
}

// A link deliberately split across two token chunks (the core streaming hazard).
const SPLIT_LINK_TOKENS = [
  'You can pay your water bill online through the ',
  '[Online Bill Pay', // opens a link mid-token
  ' portal](https://www.ggcity.org/finance/pay-bill)', // closes it on the next token
  ' or in person at City Hall.',
];

const MULTI_LINK_TOKENS = [
  'Trash pickup details are on the ',
  '[Sanitation page](https://www.ggcity.org/publicworks/sanitation). ',
  'For bulky-item pickup, see the ',
  '[Bulk Pickup page](https://www.ggcity.org/publicworks/bulk-pickup).',
];

const MULTI_LINK_CITATIONS = [
  { url: 'https://www.ggcity.org/publicworks/sanitation', text: 'Sanitation page' },
  { url: 'https://www.ggcity.org/publicworks/bulk-pickup', text: 'Bulk Pickup page' },
];

// 80 tiny chunks delivered back-to-back — stresses the coalesced renderer.
const BURST_FULL =
  'Here are the steps to start water service: ' +
  'submit an application, provide proof of residency, pay the deposit, ' +
  'and schedule a start date with the Finance Department.';
const BURST_TOKENS = BURST_FULL.match(/.{1,3}/g) || [BURST_FULL];

export const SCENARIOS = {
  happyPathSplitLink: {
    description: 'Happy path; an inline link is split across two token chunks.',
    steps: streamingTurn({ user: 'How do I pay my water bill?', tokens: SPLIT_LINK_TOKENS }),
  },

  multiLink: {
    description: 'Two inline links; a Sources list is rendered after the answer.',
    steps: streamingTurn({
      user: 'When is trash pickup?',
      tokens: MULTI_LINK_TOKENS,
      citations: MULTI_LINK_CITATIONS,
    }),
  },

  notFound: {
    description: 'Retrieval found nothing → honest not-found + human redirect.',
    steps: [
      { call: 'appendUserMessage', args: ['Can you file my taxes for me?'] },
      { at: 50, call: 'setNarration', args: [NARRATION] },
      { at: 600, call: 'showNotFound', args: [NOT_FOUND_TEXT, HUMAN_REDIRECT] },
    ],
  },

  throttle: {
    description: 'Rate-limit / oversized reject (same not-found shape).',
    steps: [
      { call: 'appendUserMessage', args: ['hi'] },
      { at: 100, call: 'showNotFound', args: [THROTTLE_TEXT, HUMAN_REDIRECT] },
    ],
  },

  errorMidTurn: {
    description: 'Error mid-stream → busy cleared, error shown.',
    steps: [
      { call: 'appendUserMessage', args: ['What are the park hours?'] },
      { at: 50, call: 'setNarration', args: [NARRATION] },
      { at: 150, call: 'beginAssistantMessage', args: [] },
      { at: 100, call: 'appendAssistantToken', args: ['City parks are open '] },
      { at: 60, call: 'appendAssistantToken', args: ['from dawn'] },
      { at: 200, call: 'showError', args: [ERROR_TEXT] },
    ],
  },

  followUp: {
    description: 'Two turns; focus stays in the input, transcript scrolls.',
    steps: [
      ...streamingTurn({ user: 'How do I pay my water bill?', tokens: SPLIT_LINK_TOKENS }),
      ...streamingTurn({
        user: 'And trash pickup?',
        narration: NARRATION,
        tokens: MULTI_LINK_TOKENS,
        citations: MULTI_LINK_CITATIONS,
      }),
    ],
  },

  rapidBurst: {
    description: 'Rapid token burst; coalesced render must not drop/dup text.',
    steps: streamingTurn({
      user: 'How do I start water service?',
      tokens: BURST_TOKENS,
      tokenDelay: 0,
    }),
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);
