/**
 * Shared JSDoc type definitions — the public API contract Phase 3 (the shell)
 * codes against. This module exports nothing at runtime; importing it is only
 * for the `@typedef`s to be visible to tooling. (An optional
 * `npm run types` step emits `.d.ts` from these for editor ergonomics.)
 */

/**
 * A citation source. `text` is the accessible, descriptive link text (the page
 * title / anchor text); `url` is the destination.
 * @typedef {Object} Citation
 * @property {string} url
 * @property {string} text
 */

/**
 * The human-redirect block shown with a not-found / throttle response. Mirrors
 * the backend `not_found.redirect_to_human` shape exactly.
 * @typedef {Object} NotFoundRedirect
 * @property {string} label  e.g. "Contact the City of Garden Grove"
 * @property {string} url    e.g. "https://www.ggcity.org/contact"
 * @property {string} phone  e.g. "(714) 741-5000"
 */

/**
 * Called when the user activates a citation (inline prose link or Sources list).
 * @callback CitationClickHandler
 * @param {Citation} citation
 * @returns {void}
 */

/** @typedef {{ text: string }} GigiSubmitDetail */
/** @typedef {Citation} GigiCitationDetectedDetail */
/** @typedef {{ answer: string, citations: Citation[] }} GigiAnswerCompleteDetail */
/** @typedef {Citation} GigiCitationClickDetail */

/**
 * @typedef {'user'|'assistant'|'system'} Role
 * @typedef {'streaming'|'complete'|'notFound'|'error'} MessageStatus
 */

/**
 * Internal message model (not part of the public API; documented for maintainers).
 * @typedef {Object} Message
 * @property {string} id
 * @property {Role} role
 * @property {string} markdownBuffer  accumulated raw markdown (assistant) or plain text (user)
 * @property {MessageStatus} status
 * @property {Citation[]} [citations]
 * @property {NotFoundRedirect} [redirect]
 */

export {};
