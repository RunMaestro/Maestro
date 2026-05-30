/**
 * pipelineAutoArrange — pure layout helpers for the "Auto-arrange" button.
 *
 * Two layouts, one button (the editor picks based on the active view):
 *
 *  1. arrangePipelineNodes(pipeline)
 *     Single-pipeline view. Lays a pipeline's nodes out left→right in columns
 *     by data-flow depth (rank = longest path from a root), stacking nodes
 *     within a column. Columns are centered on a shared vertical midline so
 *     edges read cleanly. A pipeline with no edges (a bag of disconnected
 *     nodes) is packed into a balanced grid instead of a single tall column.
 *
 *  2. arrangePipelineGroups(pipelines, currentOffsets)
 *     All-Pipelines view. Packs each pipeline's group card into a balanced
 *     grid by returning a `viewOffset` per pipeline. Internal node positions
 *     are left untouched — only the cards move.
 *
 * Ordering invariant (the "just align them up, don't reshuffle" requirement):
 * neither layout invents a new ordering from the graph. Within a rank, nodes
 * keep their CURRENT top-to-bottom order; group cards keep their CURRENT
 * reading order (top-to-bottom, then left-to-right). We only snap that
 * existing order onto an even grid, so pressing the button again after the
 * user nudges things tidies the alignment without scrambling placement.
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
 * Lay out one pipeline's nodes. Returns a NEW nodes array (same nodes, new
 * positions); the input is not mutated. Order within a column follows current
 * vertical position so the user's arrangement is tidied, not reshuffled.
 */
export function arrangePipelineNodes(pipeline: CuePipeline): PipelineNode[] {
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

	const arranged: PipelineNode[] = [];
	for (const [r, group] of byRank) {
		group.sort(byCurrentPosition);
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
