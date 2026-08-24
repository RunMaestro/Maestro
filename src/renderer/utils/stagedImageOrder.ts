/**
 * Staged-image ordering, and keeping "Screenshot N" references honest.
 *
 * The order of `stagedImages` IS the order the agent receives: every send path
 * walks the array in order (stream-json builds one image content block per
 * element, the temp-file path writes `maestro-image-<ts>-<index>` and lists the
 * paths in order). Nothing maps a filename back to a slot, so reordering the
 * array is the whole of reordering what "Screenshot 2" refers to.
 *
 * That also means a `Screenshot N` the user already typed (or dropped) into the
 * draft is a SNAPSHOT of the order at the time it was written. Reorder the
 * strip afterwards and the text silently points at the wrong picture, which is
 * worse than not having the reference at all. `renumberScreenshotReferences`
 * rewrites those tokens through the same permutation applied to the array, so
 * the words follow the pictures.
 */

/** Move `from` to `to` using Array.splice semantics. Out-of-range is a no-op. */
export function moveStagedImage<T>(items: readonly T[], from: number, to: number): T[] {
	const next = [...items];
	if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) {
		return next;
	}
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

/**
 * Map of OLD 1-based slot number to NEW 1-based slot number for a single move.
 * Slots whose number is unchanged are omitted, so an empty map means "no text
 * needs rewriting".
 */
export function buildSlotRemap(length: number, from: number, to: number): Map<number, number> {
	const remap = new Map<number, number>();
	const originalOrder = Array.from({ length }, (_, i) => i);
	const reordered = moveStagedImage(originalOrder, from, to);
	reordered.forEach((originalIndex, newIndex) => {
		if (originalIndex !== newIndex) remap.set(originalIndex + 1, newIndex + 1);
	});
	return remap;
}

// Matches the reference token this feature writes: the word "screenshot" (any
// case, since the user types it too) followed by a number. Deliberately narrow -
// "image 2" and "picture 2" are ordinary prose that nobody expects to be
// rewritten under them, and the drag-to-insert affordance only ever produces
// this one shape.
const SCREENSHOT_REFERENCE_REGEX = /\b(screenshots?)(\s+)(\d+)\b/gi;

/**
 * Rewrite `Screenshot N` tokens in `text` through a slot remap.
 *
 * Every replacement reads its number from the ORIGINAL text, so the rewrite is
 * simultaneous: swapping 1 and 2 yields 2 and 1 rather than collapsing both
 * onto the same slot the way a sequential pass would.
 *
 * A number outside the remap is left exactly as written - that covers both the
 * slots the move did not disturb and any "Screenshot 9" the user typed with no
 * ninth image staged.
 */
export function renumberScreenshotReferences(
	text: string,
	remap: ReadonlyMap<number, number>
): string {
	if (!text || remap.size === 0) return text;
	return text.replace(SCREENSHOT_REFERENCE_REGEX, (match, word, space, digits) => {
		const next = remap.get(Number(digits));
		return next === undefined ? match : `${word}${space}${next}`;
	});
}

/** The reference text a dragged thumbnail drops into the composer. */
export function screenshotReferenceLabel(index: number): string {
	return `Screenshot ${index + 1}`;
}
