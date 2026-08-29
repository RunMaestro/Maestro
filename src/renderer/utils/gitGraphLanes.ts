/**
 * Lane assignment for the Git Log graph view.
 *
 * The rendered graph (`GitGraphView`) and the keyboard navigation over it
 * (`GitLogViewer`) must agree on two things: which lane each commit sits in,
 * and what left-to-right order those lanes are drawn in. Deriving that twice
 * would let an arrow key land on a commit the user sees in a different column,
 * so both sides call this one pure function.
 *
 * The row/column model mirrors @gitgraph's default vertical orientation:
 * - Row 0 is the OLDEST commit and is drawn at the BOTTOM
 *   (`y = spacing * (maxRow - row)`), so a higher row index is visually higher.
 * - A lane's x position is its order of first appearance in the oldest-first
 *   commit list (`BranchesOrder` in @gitgraph/core), so `laneOrder` below reads
 *   left to right.
 */

import type { GitGraphNode } from '../services/git';

export interface GitGraphLanes {
	/** Commits sorted oldest -> newest. Index into this array IS the graph row. */
	ordered: GitGraphNode[];
	/** Lane (branch) name each commit hash was placed on. */
	laneOfCommit: Map<string, string>;
	/** Lane names in left-to-right draw order. */
	laneOrder: string[];
	/** Row index (position in `ordered`) of each commit hash. */
	rowOfCommit: Map<string, number>;
}

/**
 * Pull a branch label out of a commit's refs (e.g. "HEAD -> main, origin/main,
 * tag: v1"). Prefers local branches over remote-tracking refs; ignores tags.
 */
export function pickBranchFromRefs(refs: string[]): string | null {
	const cleaned = refs
		.map((r) => r.replace(/^HEAD -> /, '').trim())
		.filter((r) => r && !r.startsWith('tag:'));
	if (cleaned.length === 0) return null;
	const local = cleaned.find((r) => !r.includes('/'));
	return local || cleaned[0];
}

/**
 * Assign every commit to a lane, in the same order the graph is built in.
 *
 * A commit takes its lane from its own refs when it has one, otherwise it stays
 * on its first parent's lane, otherwise it opens an anonymous `lane-N`.
 */
export function computeGitGraphLanes(nodes: GitGraphNode[]): GitGraphLanes {
	const ordered = [...nodes].sort(
		(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
	);

	const laneOfCommit = new Map<string, string>();
	const rowOfCommit = new Map<string, number>();
	const laneOrder: string[] = [];
	const seenLanes = new Set<string>();
	let laneCounter = 0;

	ordered.forEach((node, row) => {
		const refLane = pickBranchFromRefs(node.refs);
		const firstParent = node.parents[0];
		const inheritedLane = firstParent ? (laneOfCommit.get(firstParent) ?? null) : null;
		const lane = refLane ?? inheritedLane ?? `lane-${++laneCounter}`;

		laneOfCommit.set(node.hash, lane);
		rowOfCommit.set(node.hash, row);
		if (!seenLanes.has(lane)) {
			seenLanes.add(lane);
			laneOrder.push(lane);
		}
	});

	return { ordered, laneOfCommit, laneOrder, rowOfCommit };
}

/**
 * Step one row up (`+1`, visually up = newer) or down (`-1` = older) from
 * `fromHash`. Returns the target commit hash, or null when there is nowhere to
 * go (the anchor is off-graph, or the cursor is already at an end).
 */
export function stepGitGraphRow(
	lanes: GitGraphLanes,
	fromHash: string | undefined,
	direction: 1 | -1
): string | null {
	if (lanes.ordered.length === 0) return null;
	if (!fromHash) return null;
	const row = lanes.rowOfCommit.get(fromHash);
	if (row === undefined) return null;
	const target = row + direction;
	if (target < 0 || target >= lanes.ordered.length) return null;
	return lanes.ordered[target].hash;
}

/**
 * The commit at `row`, clamped into range. Use it for the jumps that are meant
 * to land somewhere definite (a page, the top, the bottom) rather than to step:
 * a page jump near an end should reach the end, not refuse to move.
 */
export function gitGraphHashAtRow(lanes: GitGraphLanes, row: number): string | null {
	if (lanes.ordered.length === 0) return null;
	const clamped = Math.min(Math.max(row, 0), lanes.ordered.length - 1);
	return lanes.ordered[clamped].hash;
}

/**
 * Jump to the neighbouring lane, `direction` +1 moving right and -1 left.
 *
 * The landing commit is the one nearest the current row on that lane, so a
 * horizontal jump keeps the user roughly where they were in history instead of
 * throwing them to the tip of another branch. Lanes are skipped rather than
 * refused when they hold no commits (they cannot, but the search stays total),
 * and the ends do not wrap: wrapping across the whole graph reads as a jump to
 * a random branch rather than as a step.
 */
export function stepGitGraphLane(
	lanes: GitGraphLanes,
	fromHash: string | undefined,
	direction: 1 | -1
): string | null {
	if (!fromHash) return null;
	const currentLane = lanes.laneOfCommit.get(fromHash);
	if (!currentLane) return null;
	const laneIndex = lanes.laneOrder.indexOf(currentLane);
	if (laneIndex < 0) return null;
	const currentRow = lanes.rowOfCommit.get(fromHash) ?? 0;

	for (let i = laneIndex + direction; i >= 0 && i < lanes.laneOrder.length; i += direction) {
		const targetLane = lanes.laneOrder[i];
		let best: { hash: string; distance: number } | null = null;
		for (const node of lanes.ordered) {
			if (lanes.laneOfCommit.get(node.hash) !== targetLane) continue;
			const distance = Math.abs((lanes.rowOfCommit.get(node.hash) ?? 0) - currentRow);
			if (!best || distance < best.distance) best = { hash: node.hash, distance };
		}
		if (best) return best.hash;
	}

	return null;
}
