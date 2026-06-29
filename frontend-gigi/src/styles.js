import { css } from 'lit';

/**
 * Gigi shell styles (Shadow DOM scoped) — "Refined civic" theme.
 *
 * Theming model (identical to the chat module): a light palette is the default on
 * :host; the shell follows the OS via `prefers-color-scheme: dark`; `data-theme`
 * forces a palette. EVERY visible value is a `--gigi-shell-*` custom property, so an
 * operator re-skins the whole app by overriding those. The embedded <gigi-chat> is
 * themed FROM these tokens via CHAT_BINDINGS (applied inline, beating the module's
 * :host defaults) — one knob re-skins both surfaces.
 *
 * Layout is a flex row with strict SCROLL ISOLATION: the shell never scrolls the page;
 * the chat transcript scrolls inside the chat module, and the tile grid scrolls inside
 * <gigi-tiles> — independently. WCAG: AA contrast in both palettes, visible focus
 * rings, color never the sole signal, and all motion gated by `prefers-reduced-motion`.
 */

const darkVars = css`
  --gigi-shell-bg: #0f141b;
  --gigi-shell-surface: #161d27;
  --gigi-shell-surface-2: #1c2531;
  --gigi-shell-fg: #e6eaf0;
  --gigi-shell-muted: #9aa6b4; /* AA on surface */
  --gigi-shell-accent: #5b9bff;
  --gigi-shell-on-accent: #07101f;
  --gigi-shell-border: #2a3340;
  --gigi-shell-focus-ring: #7fb4ff;
  --gigi-shell-shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 12px 32px rgba(0, 0, 0, 0.45);
  color-scheme: dark;
`;

export const styles = css`
  :host {
    /* Light palette (default). */
    --gigi-shell-bg: #eaeff5; /* app backdrop */
    --gigi-shell-surface: #ffffff; /* panels / cards */
    --gigi-shell-surface-2: #f4f7fb; /* subtle inset (tile chrome) */
    --gigi-shell-fg: #16202c;
    --gigi-shell-muted: #54606e; /* AA on surface and backdrop */
    --gigi-shell-accent: #0b5cab; /* city blue, AA on white */
    --gigi-shell-on-accent: #ffffff;
    --gigi-shell-border: #d4dae2;
    --gigi-shell-focus-ring: #0b5cab;
    --gigi-shell-shadow: 0 1px 2px rgba(16, 32, 48, 0.06), 0 12px 32px rgba(16, 32, 48, 0.1);

    --gigi-shell-font: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    --gigi-shell-radius: 16px;
    --gigi-shell-gap: 16px;
    --gigi-shell-chat-width: 500px; /* docked sidebar chat width */
    --gigi-shell-chat-max: 720px; /* centered chat column cap */
    --gigi-shell-tile-min-height: 320px;
    --gigi-shell-tile-stacked-min: 50vh; /* per-tile MIN height when stacked (1 column) */
    --gigi-shell-tile-stacked-max: 78vh; /* per-tile cap when stacked (narrow) */
    --gigi-shell-morph-ms: 420ms;

    color-scheme: light;
    display: block;
    height: 100%;
    box-sizing: border-box;
    color: var(--gigi-shell-fg);
    font-family: var(--gigi-shell-font);
  }

  @media (prefers-color-scheme: dark) {
    :host(:not([data-theme='light'])) {
      ${darkVars}
    }
  }
  :host([data-theme='dark']) {
    ${darkVars}
  }

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

  /* ── Layout — flex row, page never scrolls (scroll isolation) ──── */
  .shell {
    height: 100%;
    display: flex;
    gap: var(--gigi-shell-gap);
    padding: var(--gigi-shell-gap);
    overflow: hidden;
    background-color: var(--gigi-shell-bg);
    /* a subtle accent glow at the top for depth (decorative) */
    background-image: radial-gradient(
      1200px 520px at 50% -12%,
      color-mix(in srgb, var(--gigi-shell-accent) 8%, transparent),
      transparent 70%
    );
  }
  .shell.centered {
    justify-content: center;
    align-items: center;
  }
  .shell.centered.started {
    align-items: stretch;
  }

  .chat-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--gigi-shell-surface);
    border: 1px solid var(--gigi-shell-border);
    border-radius: var(--gigi-shell-radius);
    box-shadow: var(--gigi-shell-shadow);
    overflow: hidden; /* chat scrolls internally, not the pane/page */
  }
  /* Hero (centered, not started): compact, content-height, centered both axes. */
  .shell.centered:not(.started) .chat-pane {
    flex: 0 1 auto;
    width: min(640px, 100%);
    max-height: 100%;
  }
  /* Centered + chatting: centered column, full height, composer pinned at bottom. */
  .shell.centered.started .chat-pane {
    flex: 0 0 auto;
    width: min(var(--gigi-shell-chat-max), 100%);
    height: 100%;
    margin: 0 auto;
  }
  /* Docked: fixed-width sidebar, full height. */
  .shell.side .chat-pane {
    flex: 0 0 var(--gigi-shell-chat-width);
    height: 100%;
  }

  /* Do NOT set display here — outer page rules override the module's :host{display:flex},
     which would break its internal column layout (transcript can't flex, composer floats). */
  gigi-chat {
    min-height: 0;
  }
  /* When chatting, the chat fills the pane so its transcript scrolls and the composer
     sticks to the bottom; height is also forced inline by gigi-app for robustness. */
  .shell.started gigi-chat,
  .shell.side gigi-chat {
    flex: 1 1 auto;
    height: 100%;
  }

  .tiles-pane {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden; /* the tile GRID scrolls inside <gigi-tiles>, not here */
  }
  .shell.centered .tiles-pane {
    display: none;
  }

  /* Mobile (≈900px): the chat fills the viewport EDGE-TO-EDGE and resizes with it;
     tiles are hidden regardless of count. The dock morph is skipped in JS (gigi-app)
     at this width. Keep MOBILE_BP in gigi-app.js in sync with this breakpoint. The
     overrides repeat the layout-state selectors so they beat the higher-specificity
     .shell.centered / .shell.side rules above. */
  @media (max-width: 900px) {
    .shell {
      /* Full-bleed, but inset by the device safe areas (notch / home indicator) so the
         composer and content clear them. env(...) is 0 in a normal browser, so the
         full-width behavior — and the e2e mobile test — is unchanged off-device. */
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
        env(safe-area-inset-left);
      gap: 0;
    }
    .shell .tiles-pane {
      display: none;
    }
    .shell .chat-pane,
    .shell.centered:not(.started) .chat-pane,
    .shell.centered.started .chat-pane,
    .shell.side .chat-pane {
      flex: 1 1 auto;
      width: auto;
      max-width: none;
      margin: 0;
      height: 100%;
      border: 0;
      border-radius: 0;
      box-shadow: none;
    }
  }

  /* ── Hero ─────────────────────────────────────────────────────── */
  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 10px;
    padding: 40px 28px 22px;
  }
  .hero-logo {
    width: 76px;
    height: 76px;
    color: var(--gigi-shell-accent);
  }
  .hero-title {
    margin: 4px 0 0;
    font-size: clamp(2rem, 4vw, 2.6rem);
    font-weight: 800;
    letter-spacing: -0.01em;
    color: var(--gigi-shell-fg);
  }
  .hero-tag {
    margin: 0;
    max-width: 30ch;
    color: var(--gigi-shell-muted);
    font-size: 1.02rem;
    line-height: 1.45;
  }
  @media (prefers-reduced-motion: no-preference) {
    .hero {
      animation: gigi-hero-in 360ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .hero.leaving {
      animation: gigi-hero-out 240ms ease both;
    }
  }
  @keyframes gigi-hero-in {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @keyframes gigi-hero-out {
    to {
      opacity: 0;
      transform: translateY(-8px);
    }
  }

  /* ── Embedded chat animations (via exported ::part), motion-gated ── */
  @media (prefers-reduced-motion: no-preference) {
    gigi-chat::part(message) {
      animation: gigi-bubble-in 260ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    gigi-chat::part(message streaming) {
      animation: gigi-stream-glow 1.8s ease-in-out infinite;
    }
    gigi-chat::part(caret) {
      border-radius: 2px;
      box-shadow: 0 0 8px 1px color-mix(in srgb, var(--gigi-shell-accent) 70%, transparent);
    }
  }
  @keyframes gigi-bubble-in {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.99);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @keyframes gigi-stream-glow {
    0%,
    100% {
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--gigi-shell-accent) 0%, transparent);
    }
    50% {
      box-shadow: 0 0 14px 1px color-mix(in srgb, var(--gigi-shell-accent) 26%, transparent);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-pane,
    .tiles-pane {
      transition: none !important;
    }
  }
`;

/**
 * Inline style applied to the embedded <gigi-chat>: derives the chat module's look
 * from the shell tokens (inline custom properties beat the module's :host defaults).
 */
export const CHAT_BINDINGS = [
  ['--gigi-chat-bg', '--gigi-shell-surface'],
  ['--gigi-chat-fg', '--gigi-shell-fg'],
  ['--gigi-chat-accent', '--gigi-shell-accent'],
  ['--gigi-chat-on-accent', '--gigi-shell-on-accent'],
  ['--gigi-chat-border', '--gigi-shell-border'],
  ['--gigi-chat-focus-ring', '--gigi-shell-focus-ring'],
  ['--gigi-chat-font', '--gigi-shell-font'],
  ['--gigi-chat-radius', '--gigi-shell-radius'],
  ['--gigi-chat-assistant-bg', '--gigi-shell-surface-2'],
]
  .map(([chat, shell]) => `${chat}:var(${shell})`)
  .join(';');
