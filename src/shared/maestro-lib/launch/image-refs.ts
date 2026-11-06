/**
 * Turning an image a turn carries into bytes an agent can be handed.
 *
 * An image is either an inline data URL (freshly pasted) or a
 * `maestro-image://` ref into the desktop's content-addressed store. The
 * library owns the first; the store belongs to the host, so a ref is resolved
 * through `resolveImageRef` (see `../host.ts`) rather than an import.
 */

import { resolveImageRef } from '../host';

/** Already resolved prompt bytes, in user order. Paths/URIs are not image content. */
export type AcpPromptBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string };

/**
 * Host-admitted image support for this route, model and fresh/resumed turn.
 * These are caller policy bounds, not asserted native Grok limits. Omit when
 * support is unknown. This does not grant tools, file access or permissions.
 */
export interface EmbeddedImageSupport {
	mimeTypes: readonly string[];
	maxCount: number;
	maxBytesPerImage: number;
	maxTotalBytes: number;
}

/**
 * Encode the native Grok ACP prompt-file envelope without reading image refs
 * or paths. Hosts resolve attachments before planning and preserve their order.
 * Unlike Claude stream-json, invalid content refuses the whole prompt.
 */
export function buildAcpPromptFileContent(
	blocks: readonly AcpPromptBlock[],
	imageSupport?: EmbeddedImageSupport
): { ok: true; content: string; hasImages: boolean } | { ok: false; error: string } {
	if (!Array.isArray(blocks) || blocks.length === 0) {
		return { ok: false, error: 'An ACP prompt file requires at least one content block.' };
	}
	const content: AcpPromptBlock[] = [];
	let imageCount = 0;
	let totalBytes = 0;
	for (const block of blocks) {
		if (block && block.type === 'text' && typeof block.text === 'string') {
			content.push({ type: 'text', text: block.text });
			continue;
		}
		if (
			!block ||
			block.type !== 'image' ||
			typeof block.data !== 'string' ||
			typeof block.mimeType !== 'string'
		) {
			return { ok: false, error: 'ACP prompt files accept only text and embedded image blocks.' };
		}
		if (
			!imageSupport ||
			!Array.isArray(imageSupport.mimeTypes) ||
			![imageSupport.maxCount, imageSupport.maxBytesPerImage, imageSupport.maxTotalBytes].every(
				(limit) => Number.isSafeInteger(limit) && limit > 0
			)
		) {
			return {
				ok: false,
				error: 'Embedded images require explicit support and bounded image limits.',
			};
		}
		if (
			!/^image\/[a-z0-9][a-z0-9.+-]*$/.test(block.mimeType) ||
			!imageSupport.mimeTypes.includes(block.mimeType)
		) {
			return { ok: false, error: 'The embedded image MIME type is not supported for this turn.' };
		}
		imageCount += 1;
		if (imageCount > imageSupport.maxCount) {
			return { ok: false, error: 'The prompt exceeds the admitted image count.' };
		}
		// Bound work before decoding. Require canonical padded base64; Node's
		// decoder alone tolerates malformed input, URLs and ignored characters.
		const padding = block.data.endsWith('==') ? 2 : block.data.endsWith('=') ? 1 : 0;
		const bytes = (block.data.length / 4) * 3 - padding;
		if (!block.data || block.data.length % 4 !== 0 || bytes <= 0) {
			return { ok: false, error: 'An embedded image must contain valid base64 bytes.' };
		}
		if (bytes > imageSupport.maxBytesPerImage || bytes > imageSupport.maxTotalBytes - totalBytes) {
			return { ok: false, error: 'The prompt exceeds the admitted image byte limits.' };
		}
		if (Buffer.from(block.data, 'base64').toString('base64') !== block.data) {
			return { ok: false, error: 'An embedded image must contain valid base64 bytes.' };
		}
		totalBytes += bytes;
		// Project only wire fields: a caller's path/URI is never tool-read input.
		content.push({ type: 'image', data: block.data, mimeType: block.mimeType });
	}
	return {
		ok: true,
		content: JSON.stringify({ type: 'acp', content }),
		hasImages: imageCount > 0,
	};
}

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
