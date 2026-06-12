/**
 * Source-line anchoring for the preview ⇄ edit toggle.
 *
 * Toggling between a rendered/virtualized preview and the CodeMirror editor
 * used to sync by *scroll percentage*. Percent is a poor proxy for "the same
 * content": the preview's per-line height differs from the editor's (soft-wrap,
 * gutters, virtualized page estimates), so 60%-down in one view lands on a
 * different source line in the other. These helpers anchor on the 1-based
 * source line at the top of the viewport instead, so the line you were looking
 * at stays put across the toggle.
 *
 * The DOM helpers reuse `buildRangeAtOffset` (the same primitive the search
 * tiers use to land on a matched word) so they work regardless of how the text
 * is wrapped in elements - e.g. Bionify reading-mode spans.
 */

import { buildRangeAtOffset } from './search/scrollToOffset';

/**
 * Character offset where 1-based `line` begins. Line 1 → 0. Lines past the end
 * clamp to the final line start. Cheap single scan, no string splitting.
 */
export function nthLineStartOffset(text: string, line: number): number {
	if (line <= 1) return 0;
	let seen = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10 /* \n */) {
			seen++;
			if (seen === line - 1) return i + 1;
		}
	}
	// Fewer lines than requested - clamp to the start of the last line.
	const lastNl = text.lastIndexOf('\n');
	return lastNl === -1 ? 0 : lastNl + 1;
}

/** Total 1-based line count (newlines + 1). */
function totalLines(text: string): number {
	let n = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) n++;
	}
	return n;
}

/** Viewport-relative top of the row that source `line` starts on, or null. */
function lineTop(containerEl: HTMLElement, text: string, line: number): number | null {
	const range = buildRangeAtOffset(containerEl, nthLineStartOffset(text, line), 1);
	if (!range) return null;
	const rect = range.getBoundingClientRect();
	// A collapsed range over a bare "\n" can report a zero rect; skip it.
	if (rect.top === 0 && rect.height === 0) return null;
	return rect.top;
}

/**
 * The 1-based source line currently at the top of `scrollEl`, for a preview
 * that renders the full `text` as DOM inside `containerEl` (the small / Rich
 * text tier). Binary-searches line tops against the scroller's top edge.
 */
export function domGetTopLine(
	scrollEl: HTMLElement,
	containerEl: HTMLElement,
	text: string
): number {
	const edge = scrollEl.getBoundingClientRect().top + 1; // +1px epsilon
	let lo = 1;
	let hi = totalLines(text);
	let ans = 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const top = lineTop(containerEl, text, mid);
		if (top !== null && top <= edge) {
			ans = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return ans;
}

/**
 * Scroll `scrollEl` so source `line` sits at the top of the viewport, for a
 * preview that renders the full `text` as DOM inside `containerEl`.
 */
export function domScrollToLine(
	scrollEl: HTMLElement,
	containerEl: HTMLElement,
	text: string,
	line: number
): void {
	const range = buildRangeAtOffset(containerEl, nthLineStartOffset(text, line), 1);
	if (!range) return;
	const delta = range.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
	scrollEl.scrollTop += delta;
}
