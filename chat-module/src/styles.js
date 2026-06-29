import { css } from 'lit';

/**
 * Component styles (Shadow DOM scoped).
 *
 * Theming model:
 *   - Light palette is the default on :host.
 *   - The component follows the OS automatically via `prefers-color-scheme: dark`.
 *   - A host attribute forces a palette regardless of the OS:
 *       <gigi-chat data-theme="light">  — always light
 *       <gigi-chat data-theme="dark">   — always dark
 *       (absent / data-theme="system")  — follow the OS
 *   - Everything visual is a `--gigi-chat-*` CSS custom property, so an embedding
 *     app can define a fully custom theme just by setting those properties (see the
 *     demo's "Ocean" theme). A few ::part() targets are also exported.
 *
 * Colors meet WCAG AA contrast in both light and dark; state is never signaled by
 * color alone; all motion is gated by prefers-reduced-motion. `color-scheme` is set
 * so native UI (caret, scrollbars, form controls) matches the palette.
 */

// Built-in dark palette — interpolated wherever dark applies (OS-auto and forced),
// so the two selectors can't drift.
const darkVars = css`
  --gigi-chat-bg: #14161b;
  --gigi-chat-fg: #e8eaed;
  --gigi-chat-accent: #4c8dff;
  --gigi-chat-on-accent: #0a0f1a;
  --gigi-chat-user-bg: #1f3550;
  --gigi-chat-assistant-bg: #22252c;
  --gigi-chat-border: #3a3f4a;
  --gigi-chat-error-fg: #ff8a7a;
  --gigi-chat-focus-ring: #6fb3ff;
  --gigi-chat-disabled-bg: #20232a;
  --gigi-chat-send-disabled-bg: #4a4f5a;
  --gigi-chat-code-bg: rgba(255, 255, 255, 0.08);
  color-scheme: dark;
`;

export const styles = css`
  :host {
    /* Light palette (default) — override any of these to theme the component. */
    --gigi-chat-bg: #ffffff;
    --gigi-chat-fg: #1a1a1a;
    --gigi-chat-accent: #0b5cab; /* AA on white */
    --gigi-chat-on-accent: #ffffff; /* text on accent-colored controls */
    --gigi-chat-user-bg: #e7f0fb;
    --gigi-chat-assistant-bg: #f4f4f5;
    --gigi-chat-border: #c6c6cc;
    --gigi-chat-error-fg: #8a1f11; /* AA on white */
    --gigi-chat-focus-ring: #0b5cab;
    --gigi-chat-disabled-bg: #ededf0;
    --gigi-chat-send-disabled-bg: #6b6b73;
    --gigi-chat-code-bg: rgba(0, 0, 0, 0.06);
    --gigi-chat-font: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    --gigi-chat-radius: 12px;
    --gigi-chat-gap: 12px;
    /* Avatars: off by default; set display to show, and an image per role. */
    --gigi-chat-avatar-display: none;
    --gigi-chat-avatar-size: 28px;
    --gigi-chat-assistant-avatar: none;
    --gigi-chat-user-avatar: none;
    --gigi-chat-toolbar-bg: transparent;
    color-scheme: light;

    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
    background: var(--gigi-chat-bg);
    color: var(--gigi-chat-fg);
    font-family: var(--gigi-chat-font);
    font-size: 1rem;
    line-height: 1.5;
  }

  /* Follow the OS when no explicit light/custom theme is forced. */
  @media (prefers-color-scheme: dark) {
    :host(:not([data-theme='light']):not([data-theme='ocean'])) {
      ${darkVars}
    }
  }
  /* Force dark regardless of OS. */
  :host([data-theme='dark']) {
    ${darkVars}
  }
  /* (data-theme="light" forces the :host light defaults above, even in a dark OS.) */

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Optional conversation toolbar (shown via the show-toolbar attribute). */
  .toolbar {
    order: 0;
    display: flex;
    gap: 8px;
    padding: 8px var(--gigi-chat-gap);
    border-bottom: 1px solid var(--gigi-chat-border);
    background: var(--gigi-chat-toolbar-bg);
  }
  .toolbar button {
    font: inherit;
    font-size: 0.85rem;
    padding: 5px 10px;
    color: var(--gigi-chat-fg);
    background: transparent;
    border: 1px solid var(--gigi-chat-border);
    border-radius: 8px;
    cursor: pointer;
  }
  .toolbar button:focus-visible {
    outline: 3px solid var(--gigi-chat-focus-ring);
    outline-offset: 2px;
  }

  /* Transcript */
  .log {
    order: 1;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: var(--gigi-chat-gap);
    display: flex;
    flex-direction: column;
    gap: var(--gigi-chat-gap);
  }
  .log:focus-visible {
    outline: 3px solid var(--gigi-chat-focus-ring);
    outline-offset: -3px;
  }

  /* Row wrapper: holds an optional avatar beside the bubble. align-self (left vs
     right) lives here so the avatar travels with the bubble. */
  .row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    max-width: 90%;
  }
  .row-assistant {
    align-self: flex-start;
  }
  .row-user {
    align-self: flex-end;
    flex-direction: row-reverse;
  }
  .row-system {
    align-self: stretch;
    max-width: 100%;
  }

  /* Per-role avatar — hidden unless --gigi-chat-avatar-display is set. Decorative. */
  .avatar {
    display: var(--gigi-chat-avatar-display);
    flex: 0 0 auto;
    width: var(--gigi-chat-avatar-size);
    height: var(--gigi-chat-avatar-size);
    border-radius: 50%;
    background-color: var(--gigi-chat-assistant-bg);
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
  }
  .row-assistant .avatar {
    background-image: var(--gigi-chat-assistant-avatar);
  }
  .row-user .avatar {
    background-image: var(--gigi-chat-user-avatar);
  }
  .row-system .avatar {
    display: none;
  }

  .msg {
    flex: 0 1 auto;
    min-width: 0;
    padding: 10px 14px;
    border-radius: var(--gigi-chat-radius);
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .msg-user {
    background: var(--gigi-chat-user-bg);
    border: 1px solid var(--gigi-chat-border);
  }
  .msg-assistant {
    background: var(--gigi-chat-assistant-bg);
    border: 1px solid var(--gigi-chat-border);
  }
  .msg-system {
    background: transparent;
    border: 1px dashed var(--gigi-chat-border);
  }

  /* Per-message copy button. */
  .copy {
    margin-top: 8px;
    font: inherit;
    font-size: 0.8rem;
    padding: 3px 8px;
    color: var(--gigi-chat-fg);
    background: transparent;
    border: 1px solid var(--gigi-chat-border);
    border-radius: 8px;
    cursor: pointer;
  }
  .copy:focus-visible {
    outline: 3px solid var(--gigi-chat-focus-ring);
    outline-offset: 2px;
  }
  .msg.is-error {
    border-color: var(--gigi-chat-error-fg);
  }
  .msg.is-error .role-tag::after {
    content: ' — error';
    color: var(--gigi-chat-error-fg);
    font-weight: 600;
  }

  .msg :first-child {
    margin-top: 0;
  }
  .msg :last-child {
    margin-bottom: 0;
  }
  .msg a {
    color: var(--gigi-chat-accent);
    text-decoration: underline;
  }
  .msg a:focus-visible {
    outline: 3px solid var(--gigi-chat-focus-ring);
    outline-offset: 2px;
  }
  .msg pre {
    overflow-x: auto;
    padding: 8px;
    background: var(--gigi-chat-code-bg);
    border-radius: 6px;
  }

  /* Streaming caret — motion gated below. */
  .streaming .caret {
    display: inline-block;
    width: 0.5ch;
    margin-left: 1px;
    background: currentColor;
    animation: blink 1s step-end infinite;
  }

  /* Sources list */
  .sources {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--gigi-chat-border);
    font-size: 0.9rem;
  }
  .sources h3 {
    margin: 0 0 4px;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .sources ol {
    margin: 0;
    padding-left: 1.2em;
  }

  /* Not-found redirect block */
  .redirect {
    margin-top: 8px;
    padding: 8px;
    border: 1px solid var(--gigi-chat-border);
    border-radius: 8px;
  }
  .redirect a {
    color: var(--gigi-chat-accent);
  }

  /* Status / narration line (visible companion to the live region) */
  .status {
    order: 0;
    padding: 4px var(--gigi-chat-gap);
    min-height: 1.5em;
    color: var(--gigi-chat-fg);
    font-size: 0.9rem;
    opacity: 0.85;
  }
  .status:empty {
    display: none;
  }
  /* narration-position="bottom" drops the status just above the composer. */
  :host([narration-position='bottom']) .status {
    order: 2;
  }

  /* Composer */
  form {
    order: 3;
    display: flex;
    gap: 8px;
    padding: var(--gigi-chat-gap);
    border-top: 1px solid var(--gigi-chat-border);
  }
  .input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 10px 12px;
    font: inherit;
    color: var(--gigi-chat-fg);
    background: var(--gigi-chat-bg);
    border: 1px solid var(--gigi-chat-border);
    border-radius: var(--gigi-chat-radius);
    resize: none;
  }
  .input:focus-visible {
    outline: 3px solid var(--gigi-chat-focus-ring);
    outline-offset: 1px;
  }
  .input[aria-disabled='true'] {
    background: var(--gigi-chat-disabled-bg);
    cursor: not-allowed;
  }
  .send {
    flex: 0 0 auto;
    padding: 0 16px;
    font: inherit;
    font-weight: 600;
    color: var(--gigi-chat-on-accent);
    background: var(--gigi-chat-accent);
    border: 1px solid transparent;
    border-radius: var(--gigi-chat-radius);
    cursor: pointer;
  }
  .send:focus-visible {
    outline: 3px solid var(--gigi-chat-focus-ring);
    outline-offset: 2px;
  }
  .send[aria-disabled='true'] {
    color: #ffffff;
    background: var(--gigi-chat-send-disabled-bg);
    cursor: not-allowed;
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .streaming .caret {
      animation: none;
    }
    .log {
      scroll-behavior: auto;
    }
  }
  @media (prefers-reduced-motion: no-preference) {
    .log {
      scroll-behavior: smooth;
    }
  }

  /* Touch devices: comfortable tap targets and no iOS focus auto-zoom. Scoped to a
     coarse pointer so the desktop layout (and its axe snapshots) are untouched. The
     44px target is WCAG 2.2; included for first-class mobile, ahead of the 2.1 mandate. */
  @media (pointer: coarse) {
    .input {
      min-height: 44px;
      font-size: 16px; /* ≥16px stops iOS Safari from zooming the page on focus */
    }
    .send {
      min-height: 44px;
      min-width: 44px;
    }
    /* Roomier tap area for citation links in the answer and the Sources list. */
    .content a,
    .sources a {
      padding: 2px 1px;
    }
  }
`;
