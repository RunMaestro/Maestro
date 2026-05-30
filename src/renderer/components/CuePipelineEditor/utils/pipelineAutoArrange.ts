/**
 * pipelineAutoArrange — pure layout helpers for the canvas layout buttons.
 *
 * Single-pipeline view exposes two buttons that differ only in how they order
 * nodes WITHIN each flow-depth column:
 *
 *  1. arrangePipelineNodes(pipeline) — "Tidy"
 *     Lays nodes out left→right in columns by data-flow depth (rank = longest
 *     path from a root), stacking nodes within a column. Within a column nodes
 *     keep their CURRENT top-to-bottom order — it aligns the existing layout
 *     onto an even grid without reshuffling. Edge crossings are left as-is.
 *
 *  2. untanglePipelineNodes(pipeline) — "Arrange"
 *     Same column assignment and centering, but reorders nodes within each
 *     column to MINIMIZE edge crossings (the Sugiyama ordering phase:
 *     barycenter sweeps + adjacent-swap transpose refinement). Seeded by the
 *     current vertical order so, where reordering isn't needed to remove a
 *     crossing, the user's arrangement is preserved.
 *
 *  3. arrangePipelineGroups(pipelines, currentOffsets)
 *     All-Pipelines view. Packs each pipeline's group card into a balanced
 *     grid by returning a `viewOffset` per pipeline. Internal node positions
 *     are left untouched — only the cards move. There are no edges between
 *     cards to cross, so Tidy and Arrange both route here.
 *
 * Both single-pipeline layouts center each column on a shared vertical midline
 * so edges read cleanly, and a pipeline with no edges (a bag of disconnected
 * nodes) is packed into a balanced grid instead of a single tall column.
 * Group cards keep their CURRENT reading order (top-to-bottom, then
 * left-to-right) so packing tidies without scrambling placement.
 */

import type { CuePipeline, PipelineNode } from '../../../../shared/cue-pipeline-types';
import {
	NODE_BG_WIDTH,
	NODE_BG_HEIGHT,
	PIPELINE_GROUP_PADDING,
	resolvePipelineOffset,
} from './pipelineGraph';

// Step between successive node top-left corners. Tight enough to read as one
// pipeline, loose enough that nodes and their edge labels never touch.
const NODE_COL_SPACING = 300; // horizontal distance between rank columns
const NODE_ROW_SPACING = 130; // vertical distance between nodes in a column

// Visible breathing room between adjacent group cards in the All-Pipelines grid.
const GROUP_GAP = 64;

/** Stable comparator: current Y, then current X, then id. */
function byCurrentPosition(a: PipelineNode, b: PipelineNode): number {
	return a.position.y - b.position.y || a.position.x - b.position.x || (a.id < b.id ? -1 : 1);
}

/**
 * Assign each node a rank = longest path (in edges) from any root node.
 * Roots (no incoming edge) are rank 0. Cycles are broken defensively so a
 * malformed pipeline can never spin the recursion.
 */
function computeNodeRanks(pipeline: CuePipeline): Map<string, number> {
	const incoming = new Map<string, string[]>();
	for (const node of pipeline.nodes) incoming.set(node.id, []);
	for (const edge of pipeline.edges) {
		const sources = incoming.get(edge.target);
		if (sources && incoming.has(edge.source)) sources.push(edge.source);
	}

	const rank = new Map<string, number>();
	const visiting = new Set<string>();
	const rankOf = (id: string): number => {
		const cached = rank.get(id);
		if (cached !== undefined) return cached;
		const sources = incoming.get(id) ?? [];
		if (sources.length === 0) {
			rank.set(id, 0);
			return 0;
		}
		if (visiting.has(id)) return 0; // cycle guard
		visiting.add(id);
		let max = 0;
		for (const src of sources) max = Math.max(max, rankOf(src) + 1);
		visiting.delete(id);
		rank.set(id, max);
		return max;
	};
	for (const node of pipeline.nodes) rankOf(node.id);
	return rank;
}

/** Pack nodes into a near-square grid, preserving their current ordering. */
function gridArrangeNodes(nodes: PipelineNode[]): PipelineNode[] {
	const ordered = [...nodes].sort(byCurrentPosition);
	const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
	return ordered.map((node, i) => ({
		...node,
		position: {
			x: (i % cols) * NODE_COL_SPACING,
			y: Math.floor(i / cols) * NODE_ROW_SPACING,
		},
	}));
}

/**
 * Reorder nodes within each rank column to minimize edge crossings. This is the
 * Sugiyama ordering phase: alternate barycenter sweeps (order each column by the
 * average vertical position of its neighbors in the adjacent column) with a
 * greedy adjacent-swap "transpose" pass that swaps neighbors whenever doing so
 * lowers the total crossing count, keeping the best ordering seen.
 *
 * `byRank` is mutated in place (each column array is reordered). The seed order
 * is the current vertical position, so where reordering isn't needed to remove a
 * crossing the user's existing arrangement is preserved.
 *
 * Crossings are compared by centered rank rather than raw row index: columns
 * hold different node counts and are each centered on y = 0, so row 0 is the TOP
 * of a tall column but the CENTER of a single-node column. Comparing centered
 * ranks aligns nodes by their actual on-screen vertical position.
 */
function minimizeCrossingsWithinColumns(
	byRank: Map<number, PipelineNode[]>,
	edges: CuePipeline['edges']
): void {
	const columnIndices = Array.from(byRank.keys()).sort((a, b) => a - b);
	// Seed each column by current vertical position (tidy-friendly tiebreak).
	for (const col of columnIndices) byRank.get(col)?.sort(byCurrentPosition);

	const column = new Map<string, number>();
	for (const col of columnIndices) {
		for (const node of byRank.get(col) ?? []) column.set(node.id, col);
	}

	// adjacency: source → targets; reverse: target → sources. Only edges whose
	// endpoints are both placed participate.
	const adjacency = new Map<string, string[]>();
	const reverse = new Map<string, string[]>();
	for (const id of column.keys()) {
		adjacency.set(id, []);
		reverse.set(id, []);
	}
	for (const edge of edges) {
		if (!column.has(edge.source) || !column.has(edge.target)) continue;
		adjacency.get(edge.source)?.push(edge.target);
		reverse.get(edge.target)?.push(edge.source);
	}

	const rowOf = new Map<string, number>();
	const computeRows = () => {
		for (const col of columnIndices) {
			(byRank.get(col) ?? []).forEach((node, idx) => rowOf.set(node.id, idx));
		}
	};
	computeRows();

	const centeredRank = (id: string): number => {
		const col = column.get(id) ?? 0;
		const size = (byRank.get(col) ?? []).length;
		return (rowOf.get(id) ?? 0) - (size - 1) / 2;
	};

	// Count crossings between edges that share the same column pair. Two such
	// edges cross iff their endpoints are in opposite vertical order.
	const countCrossings = (): number => {
		let crossings = 0;
		for (let i = 0; i < edges.length; i++) {
			const a = edges[i];
			if (!column.has(a.source) || !column.has(a.target)) continue;
			for (let j = i + 1; j < edges.length; j++) {
				const b = edges[j];
				if (!column.has(b.source) || !column.has(b.target)) continue;
				if (column.get(a.source) !== column.get(b.source)) continue;
				if (column.get(a.target) !== column.get(b.target)) continue;
				const aSrc = rowOf.get(a.source) ?? 0;
				const aTgt = rowOf.get(a.target) ?? 0;
				const bSrc = rowOf.get(b.source) ?? 0;
				const bTgt = rowOf.get(b.target) ?? 0;
				if ((aSrc - bSrc) * (aTgt - bTgt) < 0) crossings++;
			}
		}
		return crossings;
	};

	const barycenterSweep = (goingForward: boolean) => {
		const cols = goingForward ? columnIndices : [...columnIndices].reverse();
		for (const col of cols) {
			const ids = byRank.get(col) ?? [];
			const neighborsFn = goingForward ? reverse : adjacency;
			const bary = new Map<string, number>();
			for (const node of ids) {
				const neighbors = neighborsFn.get(node.id) ?? [];
				bary.set(
					node.id,
					neighbors.length === 0
						? centeredRank(node.id)
						: neighbors.reduce((sum, n) => sum + centeredRank(n), 0) / neighbors.length
				);
			}
			ids.sort((a, b) => (bary.get(a.id) ?? 0) - (bary.get(b.id) ?? 0));
			computeRows();
		}
	};

	const transpose = () => {
		let improved = true;
		let guard = 0;
		while (improved && guard++ < 50) {
			improved = false;
			for (const col of columnIndices) {
				const ids = byRank.get(col) ?? [];
				for (let i = 0; i < ids.length - 1; i++) {
					const before = countCrossings();
					[ids[i], ids[i + 1]] = [ids[i + 1], ids[i]];
					computeRows();
					if (countCrossings() < before) {
						improved = true;
					} else {
						[ids[i], ids[i + 1]] = [ids[i + 1], ids[i]];
						computeRows();
					}
				}
			}
		}
	};

	const snapshot = (): Map<number, PipelineNode[]> =>
		new Map(columnIndices.map((col) => [col, [...(byRank.get(col) ?? [])]]));
	let bestOrder = snapshot();
	let bestCrossings = countCrossings();
	const PASSES = 12;
	for (let pass = 0; pass < PASSES; pass++) {
		barycenterSweep(pass % 2 === 0);
		transpose();
		const crossings = countCrossings();
		if (crossings < bestCrossings) {
			bestCrossings = crossings;
			bestOrder = snapshot();
		}
	}
	for (const [col, ids] of bestOrder) byRank.set(col, ids);
}

/**
 * Shared column layout for both single-pipeline buttons. Assigns flow-depth
 * columns, orders nodes within each column (current-order for Tidy, crossing
 * minimization for Arrange via `untangle`), then centers each column on y = 0.
 * Returns a NEW nodes array; the input is not mutated.
 */
function arrangeByColumns(pipeline: CuePipeline, untangle: boolean): PipelineNode[] {
	if (pipeline.nodes.length <= 1) return pipeline.nodes;

	const ranks = computeNodeRanks(pipeline);
	const maxRank = Math.max(0, ...pipeline.nodes.map((n) => ranks.get(n.id) ?? 0));

	// No flow structure (no edges, or every node is a root): a single column
	// would just be the vertical pile the user asked us to avoid, so grid it.
	if (maxRank === 0) return gridArrangeNodes(pipeline.nodes);

	const byRank = new Map<number, PipelineNode[]>();
	for (const node of pipeline.nodes) {
		const r = ranks.get(node.id) ?? 0;
		const bucket = byRank.get(r);
		if (bucket) bucket.push(node);
		else byRank.set(r, [node]);
	}

	if (untangle) {
		minimizeCrossingsWithinColumns(byRank, pipeline.edges);
	} else {
		// Tidy: keep the current top-to-bottom order within each column.
		for (const group of byRank.values()) group.sort(byCurrentPosition);
	}

	const arranged: PipelineNode[] = [];
	for (const [r, group] of byRank) {
		// Center each column on y = 0 so the pipeline reads as a balanced fan.
		const startY = -((group.length - 1) * NODE_ROW_SPACING) / 2;
		group.forEach((node, i) => {
			arranged.push({
				...node,
				position: { x: r * NODE_COL_SPACING, y: startY + i * NODE_ROW_SPACING },
			});
		});
	}
	return arranged;
}

/**
 * "Tidy" layout. Aligns the current arrangement into flow-depth columns without
 * reshuffling node order within a column, so edge crossings are left intact.
 */
export function arrangePipelineNodes(pipeline: CuePipeline): PipelineNode[] {
	return arrangeByColumns(pipeline, false);
}

/**
 * "Arrange" layout. Same columns as Tidy, but reorders nodes within each column
 * to minimize edge crossings (seeded by current order so it untangles rather
 * than scrambles).
 */
export function untanglePipelineNodes(pipeline: CuePipeline): PipelineNode[] {
	return arrangeByColumns(pipeline, true);
}

interface GroupInfo {
	id: string;
	/** Min node position in canonical space (pre-offset). */
	minX: number;
	minY: number;
	/** Card footprint including the surrounding group padding. */
	width: number;
	height: number;
	/** Current rendered top-left, used only to preserve reading order. */
	currentX: number;
	currentY: number;
}

function groupInfo(
	pipeline: CuePipeline,
	currentOffset: { x: number; y: number }
): GroupInfo | null {
	if (pipeline.nodes.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const node of pipeline.nodes) {
		minX = Math.min(minX, node.position.x);
		minY = Math.min(minY, node.position.y);
		maxX = Math.max(maxX, node.position.x + NODE_BG_WIDTH);
		maxY = Math.max(maxY, node.position.y + NODE_BG_HEIGHT);
	}
	return {
		id: pipeline.id,
		minX,
		minY,
		width: maxX - minX + 2 * PIPELINE_GROUP_PADDING,
		height: maxY - minY + 2 * PIPELINE_GROUP_PADDING,
		currentX: minX + currentOffset.x,
		currentY: minY + currentOffset.y,
	};
}

/**
 * Pack pipeline group cards into a balanced grid. Returns a map of pipeline id
 * → new `viewOffset`. Pipelines are visited in their current reading order
 * (top-to-bottom, then left-to-right) so the grid keeps roughly the same
 * sequence the user already sees — it just removes the gaps and ragged edges.
 *
 * Columns share a uniform width (the widest card) so left edges line up; each
 * row's height is the tallest card in that row, so rows pack without overlap.
 *
 * @param currentOffsets auto-stack Y-offsets (from computePipelineYOffsets) so
 *   pipelines that have never been dragged still report a sensible current
 *   position for the ordering sort.
 */
export function arrangePipelineGroups(
	pipelines: CuePipeline[],
	currentOffsets: Map<string, number>
): Map<string, { x: number; y: number }> {
	const infos: GroupInfo[] = [];
	for (const pipeline of pipelines) {
		const info = groupInfo(pipeline, resolvePipelineOffset(pipeline, currentOffsets));
		if (info) infos.push(info);
	}

	const result = new Map<string, { x: number; y: number }>();
	if (infos.length === 0) return result;

	infos.sort((a, b) => a.currentY - b.currentY || a.currentX - b.currentX);

	const cols = Math.max(1, Math.round(Math.sqrt(infos.length)));
	const colWidth = Math.max(...infos.map((i) => i.width));

	let rowTop = 0;
	for (let start = 0; start < infos.length; start += cols) {
		const rowItems = infos.slice(start, start + cols);
		const rowHeight = Math.max(...rowItems.map((i) => i.height));
		rowItems.forEach((info, col) => {
			const cellX = col * (colWidth + GROUP_GAP);
			// Place the card's padded top-left corner at (cellX, rowTop). The card
			// renders at (minX + offset - PADDING), so solve offset for that origin.
			result.set(info.id, {
				x: cellX - (info.minX - PIPELINE_GROUP_PADDING),
				y: rowTop - (info.minY - PIPELINE_GROUP_PADDING),
			});
		});
		rowTop += rowHeight + GROUP_GAP;
	}
	return result;
}
