/**
 * Shared sizing for the table-of-contents overlay.
 *
 * Every TOC surface (File Preview, Director's Notes) measures its width the
 * same way, so a heading of a given length produces an identically sized
 * overlay wherever it appears. This lived inline in `FilePreview` before
 * Director's Notes needed it too.
 */

import type { TocEntry } from './types';

const MIN_WIDTH = 200;
const MAX_WIDTH = 500;
/** Approximate px per character at ~0.8rem. */
const CHAR_WIDTH = 7.5;
/** Padding inside the entry buttons. */
const BASE_PADDING = 24;
/** Room for the "CONTENTS" header plus the headings-count badge. */
const HEADER_EXTRA = 100;

/**
 * Width in px for the overlay: wide enough for the longest indented entry,
 * clamped so a single long heading can't take over the panel.
 */
export function computeTocWidth(entries: TocEntry[]): number {
	if (entries.length === 0) return MIN_WIDTH;

	let maxNeeded = HEADER_EXTRA;
	for (const entry of entries) {
		const indent = (entry.level - 1) * 12 + 8;
		const textWidth = entry.text.length * CHAR_WIDTH;
		maxNeeded = Math.max(maxNeeded, indent + textWidth + BASE_PADDING);
	}
	return Math.min(Math.max(Math.ceil(maxNeeded), MIN_WIDTH), MAX_WIDTH);
}
