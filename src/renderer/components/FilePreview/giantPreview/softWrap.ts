/**
 * Display-only soft-wrap for pathologically long lines.
 *
 * Why this exists:
 *   Even with `EditorView.lineWrapping` + `overflow-wrap: anywhere`, CM6
 *   must MEASURE every logical line before it can virtualize the viewport.
 *   A single 500 KB line forces the browser to lay out and measure the
 *   entire line - Chromium's main thread freezes for seconds.
 *
 *   The cheapest reliable workaround is to insert hard newlines into the
 *   content BEFORE handing it to CM6 when a line crosses the threshold.
 *   The visible text is the same characters in the same order, just split
 *   across more visual lines.
 *
 * Fidelity trade-offs:
 *   - Copy/paste yields the wrapped version (extra `\n` chars). Acceptable
 *     for a viewer-only Giant tier; the user can always read the file on
 *     disk if perfect-fidelity copy is needed.
 *   - Search MUST run against the original content so a query that
 *     straddles a wrap boundary still matches. The returned `insertionsAt`
 *     array lets the caller map original offsets to wrapped offsets when
 *     dispatching CM6 selections.
 *
 * Pure: input string + threshold in, transformed string + map out. No DOM,
 * no CM6, no React.
 */

/**
 * Maximum logical-line length before soft-wrap kicks in. Sized to comfortably
 * fit CM6's measurement budget on a modern Electron renderer - empirically
 * lines up to a few thousand characters render fine; the freeze is dominated
 * by single-line lengths in the 10s of KB and up. We pick 1000 to give a
 * generous safety margin without changing display for any sane source file.
 */
export const SOFT_WRAP_MAX_LINE_LENGTH = 1000;

export interface SoftWrapResult {
	/** Wrapped text suitable for CM6 to render without per-line freezes. */
	wrapped: string;
	/**
	 * Sorted ascending list of ORIGINAL-source character positions where a
	 * synthetic `\n` was inserted. Pass to `mapToWrappedOffset()` to translate
	 * search hits (computed against the original content) into CM6 doc
	 * positions (which see the wrapped content).
	 *
	 * Empty when no wrapping was needed - callers should treat the wrapped
	 * string as identical to the original in that case.
	 */
	insertionsAt: Uint32Array;
}

/**
 * Insert hard newlines into `content` so no logical line exceeds
 * `maxLineLength` characters. Returns the wrapped text plus an offset map
 * recording where the synthetic newlines were inserted (in original-source
 * coordinates).
 *
 * When no line exceeds the threshold the function returns the original
 * content with an empty insertionsAt array, so callers can skip the offset
 * dance for normal files.
 */
export function softWrapLongLines(content: string, maxLineLength: number): SoftWrapResult {
	if (!content) return { wrapped: content, insertionsAt: new Uint32Array(0) };
	// Guard against a non-positive threshold - `p += maxLineLength` would
	// loop forever on a zero step. Treat invalid input as a no-op so callers
	// don't have to validate before delegating.
	if (!Number.isFinite(maxLineLength) || maxLineLength <= 0) {
		return { wrapped: content, insertionsAt: new Uint32Array(0) };
	}

	// Cheap pre-check: walk once for the longest line; bail when nothing
	// exceeds the threshold so we don't allocate a new string for normal
	// files.
	let maxSeen = 0;
	let cur = 0;
	for (let i = 0; i < content.length; i++) {
		if (content.charCodeAt(i) === 10) {
			if (cur > maxSeen) maxSeen = cur;
			cur = 0;
		} else {
			cur++;
		}
	}
	if (cur > maxSeen) maxSeen = cur;
	if (maxSeen <= maxLineLength) return { wrapped: content, insertionsAt: new Uint32Array(0) };

	// Build the wrapped output. Iterate the original source line-by-line;
	// for each long line, append maxLineLength-char chunks separated by \n.
	// Record original-source positions where we insert each synthetic \n so
	// search hits can be mapped to CM6 doc positions.
	const parts: string[] = [];
	const insertions: number[] = [];
	let lineStart = 0;
	for (let i = 0; i <= content.length; i++) {
		const isNewline = i < content.length && content.charCodeAt(i) === 10;
		const isEnd = i === content.length;
		if (!isNewline && !isEnd) continue;

		const lineLen = i - lineStart;
		if (lineLen <= maxLineLength) {
			parts.push(content.slice(lineStart, i));
		} else {
			for (let p = lineStart; p < i; p += maxLineLength) {
				if (p > lineStart) {
					parts.push('\n');
					insertions.push(p); // synthetic newline before original position p
				}
				parts.push(content.slice(p, Math.min(p + maxLineLength, i)));
			}
		}
		if (isNewline) parts.push('\n');
		lineStart = i + 1;
	}

	return {
		wrapped: parts.join(''),
		insertionsAt: Uint32Array.from(insertions),
	};
}

/**
 * Translate an offset in the ORIGINAL source string into the corresponding
 * offset in the wrapped string. Each synthetic `\n` inserted at or before
 * the original offset shifts the wrapped offset by +1.
 *
 * Binary search is O(log n) over the (typically small) insertions array.
 */
export function mapToWrappedOffset(insertionsAt: Uint32Array, sourceOffset: number): number {
	if (insertionsAt.length === 0) return sourceOffset;
	// Find the count of insertions strictly less than or equal to sourceOffset.
	// An insertion AT sourceOffset was placed BEFORE that source char in the
	// wrapped string, so it shifts the offset too.
	let lo = 0;
	let hi = insertionsAt.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (insertionsAt[mid] <= sourceOffset) lo = mid + 1;
		else hi = mid;
	}
	return sourceOffset + lo;
}
