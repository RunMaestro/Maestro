/**
 * openMaestroLink - handle `maestro://` URLs clicked from inside the renderer
 * (markdown previews, AI output, etc.) without round-tripping through the OS
 * protocol handler.
 *
 * The renderer already listens for OS-delivered deep links via
 * `window.maestro.app.onDeepLink` (see useSessionSwitchCallbacks.ts). To avoid
 * duplicating navigation logic, in-app clicks fan out through the same handler
 * by dispatching a CustomEvent that the hook also subscribes to.
 */

import { parseMaestroDeepLink } from '../../shared/deep-link-urls';
import type { ParsedDeepLink } from '../../shared/types';

export const MAESTRO_LINK_EVENT = 'maestro:in-app-deep-link';

/**
 * Parse a `maestro://` URL and dispatch it to the in-renderer deep link
 * subscriber. Returns true if the URL was recognized and dispatched.
 */
export function openMaestroLink(url: string): boolean {
	const parsed = parseMaestroDeepLink(url);
	if (!parsed) return false;
	window.dispatchEvent(new CustomEvent<ParsedDeepLink>(MAESTRO_LINK_EVENT, { detail: parsed }));
	return true;
}

/**
 * Subscribe to in-renderer `maestro://` link clicks. Returns an unsubscribe.
 */
export function subscribeToInAppDeepLinks(cb: (deepLink: ParsedDeepLink) => void): () => void {
	const handler = (event: Event) => {
		const detail = (event as CustomEvent<ParsedDeepLink>).detail;
		if (detail) cb(detail);
	};
	window.addEventListener(MAESTRO_LINK_EVENT, handler);
	return () => window.removeEventListener(MAESTRO_LINK_EVENT, handler);
}
