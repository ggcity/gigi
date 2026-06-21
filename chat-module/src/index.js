/**
 * Public entry point.
 *
 * Importing this module registers the `<gigi-chat>` custom element as a side
 * effect (see `package.json` "sideEffects"). A host app does:
 *
 *   import '@ggcity/gigi-chat';
 *   const chat = document.querySelector('gigi-chat');
 *   chat.appendUserMessage('hello');
 *
 * The `GigiChat` class is also exported for direct use / subclassing.
 */
import { GigiChat } from './gigi-chat.js';
import './types.js';

export { GigiChat };
