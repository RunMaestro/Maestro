/**
 * The Document Graph's neighbor-depth control: how many links out from the
 * focused document the graph draws.
 *
 * `0` means "All", and it is the WIDEST view rather than the narrowest - so on
 * the `D` cycle it sits at the top of the ladder (1, 2, ... 5, All) rather than
 * where its numeric value would put it. The slider labels it the same way.
 */

/** Sentinel depth meaning "draw every document", not "draw none". */
export const NEIGHBOR_DEPTH_ALL = 0;

/** Largest numbered depth the slider offers. */
export const NEIGHBOR_DEPTH_MAX = 5;

/**
 * The next depth on the `D` cycle: one level wider each press, wrapping from
 * All back to a single level.
 */
export function nextNeighborDepth(current: number): number {
	if (!Number.isFinite(current)) return 1;
	if (current >= NEIGHBOR_DEPTH_MAX) return NEIGHBOR_DEPTH_ALL;
	if (current <= NEIGHBOR_DEPTH_ALL) return 1;
	return Math.floor(current) + 1;
}

/** How the depth reads in a button, a slider readout, or a tooltip. */
export function formatNeighborDepth(depth: number): string {
	return depth === NEIGHBOR_DEPTH_ALL ? 'All' : String(depth);
}
