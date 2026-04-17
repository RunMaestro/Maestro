/**
 * Text utilities for Cue — specifically for slicing user-facing output before
 * it's passed to downstream subscriptions or persisted.
 *
 * Plain `.slice()` / `.substring()` on a JS string operates on UTF-16 code
 * units, which means an emoji or supplementary-plane character (encoded as a
 * surrogate pair) can be split down the middle. The result is an orphan
 * surrogate that downstream consumers see as a replacement character or a
 * mojibake artifact. Worse, if the output is later serialized to a shell
 * command or file, some tools reject invalid UTF-8 altogether.
 *
 * These helpers snap slice boundaries back to the nearest valid code-point
 * edge so Cue never forwards corrupted text.
 */

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

function isHighSurrogate(code: number): boolean {
	return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
}

function isLowSurrogate(code: number): boolean {
	return code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;
}

/**
 * Take the last `maxChars` code units of `s`, but if the slice starts in the
 * middle of a surrogate pair, shift the start forward by one so the result
 * contains only complete code points.
 */
export function sliceTailByChars(s: string, maxChars: number): string {
	if (maxChars <= 0 || s.length === 0) return '';
	if (s.length <= maxChars) return s;
	let start = s.length - maxChars;
	// If the slice starts on a low surrogate, the matching high surrogate is
	// one code unit earlier — drop the low surrogate to keep the result valid.
	if (start > 0 && isLowSurrogate(s.charCodeAt(start))) {
		start += 1;
	}
	return s.slice(start);
}

/**
 * Take the first `maxChars` code units of `s`, but if that position lands
 * between a high and low surrogate, step back by one so the trailing code
 * point is either included whole or excluded entirely.
 */
export function sliceHeadByChars(s: string, maxChars: number): string {
	if (maxChars <= 0 || s.length === 0) return '';
	if (s.length <= maxChars) return s;
	let end = maxChars;
	if (
		end < s.length &&
		isHighSurrogate(s.charCodeAt(end - 1)) &&
		isLowSurrogate(s.charCodeAt(end))
	) {
		end -= 1;
	}
	return s.slice(0, end);
}
