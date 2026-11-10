/**
 * Turning an image a turn carries into bytes an agent can be handed.
 *
 * An image is either an inline data URL (freshly pasted) or a
 * `maestro-image://` ref into the desktop's content-addressed store. The
 * library owns the first; the store belongs to the host, so a ref is resolved
 * through `resolveImageRef` (see `../host.ts`) rather than an import.
 */

import { parseBase64DataUrl } from '../../dataUrl';
import { resolveImageRef } from '../host';

export function parseDataUrl(value: string): { base64: string; mediaType: string } | null {
	// Inline data URL (freshly pasted): return the original base64 substring
	// verbatim - no decode/re-encode - so this path stays byte-identical to the
	// historical behavior (re-encoding would canonicalize padding/whitespace).
	// Header-only parse: a `(.+)$` capture overflowed V8's regexp backtrack
	// stack on multi-megabyte screenshots (see src/shared/dataUrl.ts).
	const inline = parseBase64DataUrl(value);
	if (inline && inline.mediaType.startsWith('image/')) return inline;

	// maestro-image ref (persisted image relocated to the content-addressed
	// store): read the bytes off disk and encode them for the agent hand-off.
	const resolved = resolveImageRef(value);
	if (!resolved) return null;
	return { mediaType: resolved.mediaType, base64: resolved.buffer.toString('base64') };
}

export function buildImagePromptPrefix(tempPaths: string[]): string {
	if (tempPaths.length === 0) return '';
	return `[Attached images: ${tempPaths.join(', ')}]\n\n`;
}
