/**
 * Audio / Video Media Types
 *
 * Canonical extension lists, MIME mapping, and the `maestro-media://` stream
 * URL format shared by the main process (protocol handler + `fs:readFile`) and
 * the renderer (MediaViewer).
 *
 * Media is deliberately NOT handled the way images are. Images come back from
 * `fs:readFile` as a base64 data URL, which is fine for a screenshot and fatal
 * for a two-hour screen recording: the payload would cross IPC, land in the
 * renderer heap, and get held alive by the file tab. Instead the main process
 * returns a short stream URL and the `<audio>`/`<video>` element range-requests
 * the bytes over the custom protocol, so seeking is cheap and memory is flat.
 *
 * Extensions are limited to containers/codecs Chromium can actually decode in
 * an Electron build (which ships proprietary codecs, so H.264/AAC/MP3 all
 * work). Formats Chromium cannot demux - mkv, avi, wmv - are intentionally
 * absent so they keep falling through to the existing "Binary File / open
 * externally" path rather than landing in a player that can only fail.
 */

/** Custom protocol scheme that streams local media files to the renderer. */
export const MEDIA_SCHEME = 'maestro-media';

/** Host segment of a media stream URL: `maestro-media://stream/<token>/<hex>`. */
export const MEDIA_STREAM_HOST = 'stream';

/** Extension -> MIME type for audio formats Chromium can decode. */
const AUDIO_MIME_TYPES: Record<string, string> = {
	mp3: 'audio/mpeg',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	wav: 'audio/wav',
	flac: 'audio/flac',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	opus: 'audio/ogg',
	weba: 'audio/webm',
};

/** Extension -> MIME type for video formats Chromium can decode. */
const VIDEO_MIME_TYPES: Record<string, string> = {
	mp4: 'video/mp4',
	m4v: 'video/mp4',
	webm: 'video/webm',
	ogv: 'video/ogg',
	mov: 'video/quicktime',
};

export type MediaKind = 'audio' | 'video';

/**
 * Extract a lowercase file extension, or `null` when the name has none.
 *
 * Unlike a bare `split('.').pop()` this does not treat an extensionless file
 * named `mp3` as an MP3, and it ignores dots that appear in parent directories.
 */
function getExtension(filePath: string): string | null {
	const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
	const name = filePath.slice(lastSlash + 1);
	const dot = name.lastIndexOf('.');
	if (dot <= 0 || dot === name.length - 1) return null;
	return name.slice(dot + 1).toLowerCase();
}

/** Whether a path names an audio file, a video file, or neither. */
export function getMediaKind(filePath: string): MediaKind | null {
	const ext = getExtension(filePath);
	if (!ext) return null;
	if (AUDIO_MIME_TYPES[ext]) return 'audio';
	if (VIDEO_MIME_TYPES[ext]) return 'video';
	return null;
}

/** Whether a path names a playable audio or video file. */
export function isMediaFile(filePath: string): boolean {
	return getMediaKind(filePath) !== null;
}

/** MIME type for a playable media path, or `null` when it is not media. */
export function getMediaMimeType(filePath: string): string | null {
	const ext = getExtension(filePath);
	if (!ext) return null;
	return AUDIO_MIME_TYPES[ext] ?? VIDEO_MIME_TYPES[ext] ?? null;
}

/**
 * Hex-encode a UTF-8 string. Paths are hex-encoded rather than
 * percent-encoded so that Unicode filenames, `#`, `?`, and `%` survive URL
 * normalization intact on both sides of the protocol boundary.
 */
function toHex(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

/** Inverse of {@link toHex}. Returns `null` for anything that is not clean hex. */
function fromHex(hex: string): string | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return new TextDecoder().decode(bytes);
}

/**
 * Build the stream URL for a local media file.
 *
 * The token is minted once per app boot and checked by the protocol handler,
 * so a stale URL persisted in a file tab (or a URL guessed by embedded content
 * such as the HTML preview iframe) cannot pull arbitrary media off disk.
 */
export function buildMediaStreamUrl(token: string, absolutePath: string): string {
	return `${MEDIA_SCHEME}://${MEDIA_STREAM_HOST}/${token}/${toHex(absolutePath)}`;
}

/** Cheap check for "is this `fs:readFile` result a media stream URL". */
export function isMediaStreamUrl(value: string | null | undefined): boolean {
	return typeof value === 'string' && value.startsWith(`${MEDIA_SCHEME}://${MEDIA_STREAM_HOST}/`);
}

/**
 * Validate a stream URL and recover the file path it points at.
 *
 * @returns The absolute path, or `null` when the URL is malformed, targets the
 *   wrong host, or carries a token that does not match this boot.
 */
export function parseMediaStreamUrl(url: string, expectedToken: string): string | null {
	if (!expectedToken) return null;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.host !== MEDIA_STREAM_HOST) return null;

	const segments = parsed.pathname.replace(/^\//, '').split('/');
	if (segments.length !== 2) return null;
	const [token, hex] = segments;
	if (token !== expectedToken) return null;

	const filePath = fromHex(hex);
	if (!filePath || !isMediaFile(filePath)) return null;
	return filePath;
}

/** Playback speeds offered by the media transport, slowest first. */
export const MEDIA_PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;

/** Clamp an arbitrary persisted value to a usable playback rate. */
export function normalizePlaybackRate(value: unknown): number {
	const rate = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(rate) || rate <= 0) return 1;
	return Math.min(4, Math.max(0.25, rate));
}
