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
 *
 * Vertical movement walks ONE LANE (`commitsOnLane`), never the global row
 * order: the two axes have to mean different things, or Up/Down drifts sideways
 * across branches on its own and Left/Right has nothing left to do.
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
	/** Hashes on each lane, oldest first. This is what Up/Down walks. */
	commitsOnLane: Map<string, string[]>;
	/** Each commit's position within its own lane's list. */
	indexOnLane: Map<string, number>;
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
	const commitsOnLane = new Map<string, string[]>();
	const indexOnLane = new Map<string, number>();
	const laneOrder: string[] = [];
	let laneCounter = 0;

	ordered.forEach((node, row) => {
		const refLane = pickBranchFromRefs(node.refs);
		const firstParent = node.parents[0];
		const inheritedLane = firstParent ? (laneOfCommit.get(firstParent) ?? null) : null;
		const lane = refLane ?? inheritedLane ?? `lane-${++laneCounter}`;

		laneOfCommit.set(node.hash, lane);
		rowOfCommit.set(node.hash, row);

		let members = commitsOnLane.get(lane);
		if (!members) {
			members = [];
			commitsOnLane.set(lane, members);
			laneOrder.push(lane);
		}
		indexOnLane.set(node.hash, members.length);
		members.push(node.hash);
	});

	return { ordered, laneOfCommit, laneOrder, rowOfCommit, commitsOnLane, indexOnLane };
}

/** The lane a commit sits on plus its position along it, or null if off-graph. */
function locate(
	lanes: GitGraphLanes,
	hash: string | undefined
): { members: string[]; index: number } | null {
	if (!hash) return null;
	const lane = lanes.laneOfCommit.get(hash);
	if (!lane) return null;
	const members = lanes.commitsOnLane.get(lane);
	const index = lanes.indexOnLane.get(hash);
	if (!members || index === undefined) return null;
	return { members, index };
}

/**
 * Step one commit along the CURRENT lane: `+1` is the next commit up the same
 * line (newer), `-1` the next one down it (older). Commits sitting between them
 * on other branches are skipped, because the user asked to follow one line.
 *
 * Returns null at either end of the lane rather than wrapping or spilling onto
 * a neighbour - crossing branches is what Left/Right is for.
 */
export function stepGitGraphAlongLane(
	lanes: GitGraphLanes,
	fromHash: string | undefined,
	direction: 1 | -1
): string | null {
	const at = locate(lanes, fromHash);
	if (!at) return null;
	const target = at.index + direction;
	if (target < 0 || target >= at.members.length) return null;
	return at.members[target];
}

/**
 * Move `delta` commits along the current lane, CLAMPED to its ends. Use it for
 * the jumps that are meant to land somewhere definite (a page, the tip, the
 * root): a page jump near an end should reach the end rather than refuse to
 * move, which is the opposite of what a single step should do.
 */
export function jumpGitGraphAlongLane(
	lanes: GitGraphLanes,
	fromHash: string | undefined,
	delta: number
): string | null {
	const at = locate(lanes, fromHash);
	if (!at) return null;
	const clamped = Math.min(Math.max(at.index + delta, 0), at.members.length - 1);
	return at.members[clamped];
}

/** The newest ('tip') or oldest ('root') commit on the anchor's own lane. */
export function gitGraphLaneEdge(
	lanes: GitGraphLanes,
	fromHash: string | undefined,
	edge: 'tip' | 'root'
): string | null {
	const at = locate(lanes, fromHash);
	if (!at) return null;
	return edge === 'tip' ? at.members[at.members.length - 1] : at.members[0];
}

/**
 * Jump to the neighbouring lane, `direction` +1 moving right and -1 left.
 *
 * The landing commit is the one nearest the current ROW on that lane (rows are
 * the shared vertical coordinate across lanes), so a horizontal jump keeps the
 * user roughly where they were in history instead of throwing them to the tip
 * of another branch. The ends do not wrap: wrapping across the whole graph
 * reads as a jump to a random branch rather than as a step.
 */
export function stepGitGraphAcrossLanes(
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
		const members = lanes.commitsOnLane.get(lanes.laneOrder[i]);
		if (!members || members.length === 0) continue;
		let best: { hash: string; distance: number } | null = null;
		for (const hash of members) {
			const distance = Math.abs((lanes.rowOfCommit.get(hash) ?? 0) - currentRow);
			if (!best || distance < best.distance) best = { hash, distance };
		}
		if (best) return best.hash;
	}

	return null;
}
