/**
 * Geometry for the Files pane tree lines.
 *
 * One place owns the indent arithmetic so the row renderer, the connector
 * elbows, and the alignment tests all agree. The numbers here are the layout
 * the row already used; they are named rather than re-derived per call site.
 */

import type { FlattenedNode } from '../types';

/** Left padding of a depth-0 row, in px. */
export const BASE_PAD = 8;
/**
 * Horizontal distance between two depth levels, in px. Equals the chevron slot
 * (`w-3` = 12) plus the row's flex gap (`gap-2` = 8). Files reserve the chevron
 * slot so a file and a folder at the same depth share one icon column.
 */
export const INDENT_STEP = 20;
/** Left offset of the guide line for depth level `i`, in px. */
export const GUIDE_OFFSET = 12;
/**
 * Length of the horizontal elbow arm, in px. Stops 4px short of the row's
 * chevron slot so the connector reads as pointing at the icon, not touching it.
 */
export const CONNECTOR_ARM_WIDTH = 12;

/** Left edge of the guide line for depth level `i`, in px. */
export function guideLeft(level: number): number {
	return GUIDE_OFFSET + level * INDENT_STEP;
}

/** Left padding of a row at `depth`, in px. */
export function rowPaddingLeft(depth: number): number {
	return BASE_PAD + depth * INDENT_STEP;
}

/**
 * Widest depth a guide bitmask can represent. The file indexer caps recursion
 * at 20 levels, so a 31-bit mask has room to spare; deeper rows (only reachable
 * if that cap ever moves) fall back to no pass-through guides rather than
 * shifting into undefined territory.
 */
export const MAX_GUIDE_DEPTH = 31;

/**
 * Fill in `isLastChild` and `ancestorGuideMask` on an already-flattened tree.
 *
 * Mutates in place: the flattener has just built this array and nobody else has
 * seen it yet, and a second array of ~100k rows is not worth allocating.
 */
export function annotateTreeLines(rows: FlattenedNode[]): void {
	// Backward pass. Walking from the bottom, a row is its parent's last visible
	// child when we have not already passed a row at the same depth inside the
	// same parent. Anything deeper that we passed belonged to THIS row's own
	// subtree, so those depths start over at the next subtree.
	const seenAtDepth: boolean[] = [];
	for (let i = rows.length - 1; i >= 0; i--) {
		const depth = rows[i].depth;
		rows[i].isLastChild = !seenAtDepth[depth];
		seenAtDepth[depth] = true;
		for (let deeper = depth + 1; deeper < seenAtDepth.length; deeper++) {
			seenAtDepth[deeper] = false;
		}
	}

	// Forward pass. `running` carries one bit per depth: set while the most
	// recent row at that depth still has a following sibling, i.e. while its
	// guide line has somewhere further down to reach.
	let running = 0;
	for (const row of rows) {
		const depth = row.depth;
		if (depth > MAX_GUIDE_DEPTH) {
			row.ancestorGuideMask = 0;
			continue;
		}
		// Drop the bits of any sibling subtree we just left.
		running &= (1 << depth) - 1;
		// Column `depth - 1` is this row's own elbow column, drawn from
		// `isLastChild`, so it never appears in the pass-through mask.
		row.ancestorGuideMask = depth > 0 ? running & ((1 << (depth - 1)) - 1) : 0;
		if (!row.isLastChild) running |= 1 << depth;
	}
}
