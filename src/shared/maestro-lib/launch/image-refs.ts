/**
 * Turning an image a turn carries into bytes an agent can be handed.
 *
 * An image is either an inline data URL (freshly pasted) or a
 * `maestro-image://` ref into the desktop's content-addressed store. The
 * library owns the first; the store belongs to the host, so a ref is resolved
 * through `resolveImageRef` (see `../host.ts`) rather than an import.
 */

import { resolveImageRef } from '../host';

export function parseDataUrl(value: string): { base64: string; mediaType: string } | null {
	// Inline data URL (freshly pasted): return the original base64 substring
	// verbatim - no decode/re-encode - so this path stays byte-identical to the
	// historical behavior (re-encoding would canonicalize padding/whitespace).
	const match = value.match(/^data:(image\/[^;]+);base64,(.+)$/);
	if (match) return { mediaType: match[1], base64: match[2] };

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
