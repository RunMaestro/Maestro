/**
 * Resolve the iframe `src` for an isolated Concerto HTML document.
 *
 * The same renderer runs in two hosts that reach the document different ways:
 *
 *   - Electron desktop: the `maestro-concerto://` protocol handler registered
 *     in the main process (see `src/main/index.ts`).
 *   - web-desktop browser bundle: an HTTP route on the embedded web server,
 *     because a browser has no handler for a custom scheme and silently renders
 *     a blank frame instead (#1442).
 *
 * Both serve the identical body and the identical sandboxing headers; only the
 * address differs, so this is the one place that picks between them.
 */

import { buildConcertoHtmlHttpPath, buildConcertoHtmlUrl } from '../../shared/concerto-html';
import type { ConcertoHtmlSurface } from '../../shared/concerto-html';
import { isWebDesktop } from './runtimeContext';

export function resolveConcertoHtmlSrc(
	surface: ConcertoHtmlSurface,
	id: string,
	revision: number
): string {
	if (!isWebDesktop()) return buildConcertoHtmlUrl(surface, id, revision);
	const concertoToken = (window as { __MAESTRO_CONFIG__?: { concertoToken?: unknown } })
		.__MAESTRO_CONFIG__?.concertoToken;
	// An older server build serves a page without the token. Fall back to the
	// custom scheme rather than to a token-less path: the frame fails to load
	// either way, and a request that omits the token must not look like a
	// legitimate one the route should have honored.
	if (typeof concertoToken !== 'string' || !concertoToken) {
		return buildConcertoHtmlUrl(surface, id, revision);
	}
	return buildConcertoHtmlHttpPath(concertoToken, surface, id, revision);
}
