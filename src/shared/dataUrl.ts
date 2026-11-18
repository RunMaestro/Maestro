/**
 * Parsing a `data:<media type>;base64,<payload>` URL.
 *
 * The regex matches only the HEADER. The payload is taken with `slice`, never
 * with a `(.+)$` capture group. A pasted screenshot is a multi-megabyte base64
 * string, and a capture over it is a time bomb in a long-running process: once
 * the heap's executable memory passes V8's limit, new regexps compile without
 * optimization, the greedy capture pushes backtrack state for every character,
 * and the backtrack stack overflows with `RangeError: Maximum call stack size
 * exceeded` somewhere past ~2.5M characters (a ~2 MB image). It worked in every
 * fresh process and failed every time in a desktop app that had run for days
 * (an SSH agent's held queue message with a 4.3 MB screenshot). The same work
 * also blocked the main thread for seconds. `slice` returns a V8 SlicedString:
 * no copy, no scan.
 */

const BASE64_DATA_URL_HEADER_RE = /^data:([^;,]+);base64,/;

export interface ParsedBase64DataUrl {
	/** The full media type, e.g. `image/png`. */
	mediaType: string;
	/** The payload, verbatim (never decoded and re-encoded). */
	base64: string;
}

/**
 * Split a base64 data URL into its media type and payload. Returns null when
 * the value is not a base64 data URL or the payload is empty. Constant time in
 * the payload length.
 */
export function parseBase64DataUrl(value: string): ParsedBase64DataUrl | null {
	if (typeof value !== 'string') return null;
	const header = BASE64_DATA_URL_HEADER_RE.exec(value);
	if (!header) return null;
	const base64 = value.slice(header[0].length);
	if (!base64) return null;
	return { mediaType: header[1], base64 };
}

/**
 * The subtype of a media type (`png` for `image/png`), or null when the media
 * type is not under `type` (`image` by default).
 */
export function mediaSubtype(mediaType: string, type = 'image'): string | null {
	const prefix = `${type}/`;
	if (!mediaType.startsWith(prefix)) return null;
	const subtype = mediaType.slice(prefix.length);
	return subtype || null;
}
