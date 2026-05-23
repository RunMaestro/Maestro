import DOMPurify from 'dompurify';

/**
 * Centralized DOMPurify policy for the Fast tier.
 *
 * The Rich path renders markdown via React, so raw HTML goes through
 * rehype-raw + the React reconciler (which strips event handlers naturally).
 * The Fast path emits HTML strings and injects them via `innerHTML`, so a
 * sanitizer is mandatory.
 *
 * Policy choices:
 * - `ALLOWED_URI_REGEXP` lets the standard web protocols through plus our
 *   internal `maestro-file:` protocol (resolved by the delegated click
 *   handler to the in-app file viewer) and `maestro:` deep links (routed
 *   through the in-app deep link handler).
 * - `ADD_ATTR` whitelists the two data attributes our link rewriter relies
 *   on; without these DOMPurify would strip them.
 * - `FORBID_TAGS` explicitly removes form / input / button / select /
 *   textarea / object / embed. DOMPurify keeps these by default, but a
 *   preview pane has no use for them and they enable phishing-style
 *   `<form action="evil">` patterns.
 */
const PURIFY_CONFIG = {
	ALLOWED_URI_REGEXP:
		/^(?:(?:https?|ftp|mailto|tel|file|maestro-file|maestro):)|^[^a-z]|^[a-z+.\-]+(?:[^a-z+.\-:]|$)/i,
	ADD_ATTR: ['target', 'data-maestro-file', 'data-maestro-image'] as string[],
	FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'object', 'embed'] as string[],
};

/**
 * Sanitize a single block of HTML produced by markdown-it. Returns a string
 * safe to assign to `innerHTML` / `dangerouslySetInnerHTML`.
 *
 * Sanitization happens per-block at render time rather than at parse time so
 * we only pay the cost for blocks the user actually scrolls to (Virtuoso
 * mounts ~30 at a time).
 */
export function sanitizeBlock(html: string): string {
	return DOMPurify.sanitize(html, PURIFY_CONFIG);
}
