import type { TextPage } from './types';

/** Default lines per page. 80 is a sweet spot - small enough that mounting
 * one page is cheap, large enough that a 1M-line file fits in ~12,500 pages
 * (TanStack Virtual handles that count trivially). */
export const DEFAULT_LINES_PER_PAGE = 80;

/**
 * Split a source string into fixed-size pages for virtualization.
 *
 * Pure, no DOM, no React - fully unit-testable. The function does a single
 * O(n) scan over `content` to locate newlines, then chops the resulting line
 * array into pages of `linesPerPage`. Each page carries its source offset
 * range so Cmd+F search can map a match offset back to a page index.
 *
 * Edge cases:
 *   - Empty input → returns an empty array (caller should render an empty state).
 *   - Single line with no trailing newline → one page of one line.
 *   - Trailing newline → an empty final line is included (matches Unix semantics).
 *   - CRLF endings → preserved inside the line content; we only split on LF.
 */
export function paginate(content: string, linesPerPage = DEFAULT_LINES_PER_PAGE): TextPage[] {
	if (!content) return [];
	if (linesPerPage <= 0) {
		throw new Error('linesPerPage must be a positive integer');
	}

	// One pass to record the start offset of each line.
	const lineStarts: number[] = [0];
	for (let i = 0; i < content.length; i++) {
		if (content.charCodeAt(i) === 10) {
			lineStarts.push(i + 1);
		}
	}
	// `lineStarts[i]` is the inclusive start of line `i`. The line count is
	// `lineStarts.length` when the document doesn't end with a newline, or
	// the same value with an extra empty trailing line otherwise (the LF at
	// the end pushed a new line start equal to `content.length`).
	const lineCount = lineStarts.length;

	const pages: TextPage[] = [];
	for (let pageStart = 0; pageStart < lineCount; pageStart += linesPerPage) {
		const pageEnd = Math.min(pageStart + linesPerPage, lineCount);
		const lines: string[] = [];
		for (let line = pageStart; line < pageEnd; line++) {
			const fromOffset = lineStarts[line];
			const toOffset = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : content.length;
			lines.push(content.slice(fromOffset, toOffset));
		}
		const sourceStart = lineStarts[pageStart];
		const sourceEnd = pageEnd < lineStarts.length ? lineStarts[pageEnd] : content.length;
		pages.push({
			id: pages.length,
			startLine: pageStart,
			endLine: pageEnd,
			lines,
			sourceStart,
			sourceEnd,
		});
	}
	return pages;
}

/**
 * Compute the page index for a given source character offset using binary
 * search over the page ranges. Returns 0 when `pages` is empty; clamps to
 * the last page when offset is past the end (graceful for trailing
 * whitespace matches).
 */
export function pageIndexAtOffset(pages: TextPage[], offset: number): number {
	if (pages.length === 0) return 0;
	let lo = 0;
	let hi = pages.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const page = pages[mid];
		if (offset < page.sourceStart) {
			hi = mid - 1;
		} else if (offset >= page.sourceEnd) {
			lo = mid + 1;
		} else {
			return mid;
		}
	}
	if (lo >= pages.length) return pages.length - 1;
	if (hi < 0) return 0;
	return lo;
}
