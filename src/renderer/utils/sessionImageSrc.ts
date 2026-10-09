/**
 * Resolve the `<img src>` for an image attached to a conversation.
 *
 * A transcript image is one of two things: an inline `data:` URL (fresh paste,
 * not yet persisted) or a `maestro-image://store/<sha>.<ext>` reference to the
 * session image store. The same renderer runs in two hosts that reach a stored
 * reference different ways:
 *
 *   - Electron desktop: the `maestro-image://` protocol handler registered in
 *     the main process serves it straight to the `<img>`.
 *   - web-desktop browser bundle: a browser has no handler for the custom
 *     scheme and renders a broken-image glyph, so the reference is rewritten
 *     to the token-scoped HTTP route on the embedded web server.
 *
 * Every surface that renders a conversation image (transcript, lightbox, queue
 * cards, staged strip, group chat, wizard bubbles) runs its src through here,
 * so the decision is made once. Data URLs and anything that is not a store
 * reference pass through untouched. Same pattern as `resolveConcertoHtmlSrc`.
 */

import { sessionImageHttpPath, sessionImageRefBasename } from '../../shared/sessionImageRefs';
import { isWebDesktop } from './runtimeContext';

export function displayImageSrc(src: string): string {
	if (!isWebDesktop()) return src;
	const basename = sessionImageRefBasename(src);
	if (!basename) return src;
	// Read via cast - the same global is declared with a stricter shape in the
	// web-desktop shim, and re-augmenting it from the renderer would collide.
	const apiBase = (window as { __MAESTRO_CONFIG__?: { apiBase?: unknown } }).__MAESTRO_CONFIG__
		?.apiBase;
	// A page served without apiBase has nowhere to fetch from; leave the
	// reference alone rather than invent a token-less path.
	if (typeof apiBase !== 'string' || !apiBase) return src;
	return sessionImageHttpPath(apiBase, basename);
}
