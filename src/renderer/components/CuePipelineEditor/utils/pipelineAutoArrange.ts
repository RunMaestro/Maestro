/**
 * pipelineAutoArrange - pure layout helpers for the canvas layout buttons.
 *
 * Single-pipeline view exposes two buttons that differ only in how they order
 * nodes WITHIN each flow-depth column:
 *
 *  1. arrangePipelineNodes(pipeline) - "Tidy"
 *     Lays each weakly-connected component out as its OWN horizontal band
 *     (left→right columns by data-flow depth), then KEEPS the column-groups the
 *     user already built: bands are clustered by their current left edge, so a
 *     two-column arrangement of sub-circuits stays two columns instead of
 *     collapsing into one tall stack. Within each column-group the bands stack
 *     top-to-bottom and share one rank grid; the result snaps onto a clean grid
 *     (triggers aligned left, uniform spacing, no overlaps) WITHOUT rearranging
 *     the graph's topology. Within a band, nodes keep their CURRENT top-to-bottom
 *     order, so edge crossings within a component are left as-is.
 *
 *  2. untanglePipelineNodes(pipeline, widths, viewport) - "Arrange"
 *     Same per-component banding and centering, but (a) reorders nodes within
 *     each column to MINIMIZE edge crossings (the Sugiyama ordering phase:
 *     barycenter sweeps + adjacent-swap transpose refinement, seeded by the
 *     current vertical order) AND (b) repacks the independent sub-circuits into
 *     the column count whose overall aspect ratio best matches the viewport, so
 *     the whole graph fits on screen without scrolling or zooming way out.
 *
 *  3. arrangePipelineGroups(pipelines, currentOffsets)
 *     All-Pipelines view. Packs each pipeline's group card into a balanced
 *     grid by returning a `viewOffset` per pipeline. Internal node positions
 *     are left untouched - only the cards move. There are no edges between
 *     cards to cross, so Tidy and Arrange both route here.
 *
 * Both single-pipeline layouts snap nodes onto one orthogonal grid: columns keep
 * a uniform NODE_GAP (25px) of clear space between every stacked node, and each
 * column is vertically centered against the neighbors it branches to so a fan
 * source/sink sits in the middle of its group (see assignBandCenters). A pipeline
 * with no edges (a bag of disconnected nodes) is packed into a balanced grid
 * instead of a single tall column.
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

// Empty space the grid leaves between adjacent node footprints. This is also the
// MINIMUM length of the orthogonal edge segment that bridges two nodes, so the
// whole graph snaps onto a clean grid where every gap (and every straight edge)
// reads as the same 25px. Bump this to widen the grid.
const NODE_GAP = 25;

// The ArrowClosed marker at a target handle consumes ~16px of the edge line
// (18px when the edge is selected; see markerEnd in PipelineEdge.tsx). The
// source/target handle centers sit ON the node edges, so a horizontal edge
// spans exactly the COLUMN gap - subtract the arrowhead and the plain visible
// line is the leftover. To guarantee at least NODE_GAP (25px) of straight line
// BEFORE the arrowhead, the horizontal column gap must be NODE_GAP plus this
// allowance. Vertical spacing needs no allowance (edges run horizontally).
const ARROWHEAD_ALLOWANCE = 20;
// Horizontal clear space between columns. Wider than NODE_GAP so the arrowhead
// has room and >=25px of line still shows before it.
const COLUMN_GAP = NODE_GAP + ARROWHEAD_ALLOWANCE;

// Real rendered node heights by type (the wrapper height each node component
// sets). The connection handle on every node sits at its VERTICAL CENTER
// (ReactFlow's default `top: 50%`), so to make an edge between two nodes a
// single straight horizontal segment their CENTERS must share a y - aligning
// top-left corners is NOT enough when the heights differ (a 60px trigger feeding
// an 80px agent would otherwise jog 10px, the jagged line out of every trigger).
// Keep these in sync with the `height:` in each node component under nodes/.
const TRIGGER_HEIGHT = 60;
const DEFAULT_NODE_HEIGHT = 80; // agent, command, error
const ROW_HEIGHT = DEFAULT_NODE_HEIGHT; // tallest node drives the uniform row slot

function nodeHeight(node: PipelineNode): number {
	return node.type === 'trigger' ? TRIGGER_HEIGHT : DEFAULT_NODE_HEIGHT;
}

// Horizontal step between rank columns = footprint + gap. The canonical node
// footprint (NODE_BG_WIDTH, the box that always encloses a rendered node)
// guarantees at least NODE_GAP of clear space between columns so they never
// overlap and read as distinct vertical bands.
// (All-Pipelines card packing uses a shortest-column masonry; see arrangePipelineGroups.)
const NODE_COL_SPACING = NODE_BG_WIDTH + NODE_GAP;
// Vertical step between rows = real node height + gap. Using the REAL height
// (not the 100px footprint) gives a true 25px of visible space between stacked
// nodes instead of ~45px of phantom padding, tightening the grid vertically.
const NODE_ROW_SPACING = ROW_HEIGHT + NODE_GAP;

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
 * Crossings and barycenters are compared by raw row index (the node's order
 * within its column). The later coordinate pass (assignBandCenters) keeps that
 * order intact - it only shifts whole columns vertically to center fans - so the
 * ordering decided here is exactly the on-screen top-to-bottom order.
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
						? (rowOf.get(node.id) ?? 0)
						: neighbors.reduce((sum, n) => sum + (rowOf.get(n) ?? 0), 0) / neighbors.length
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
 * Split a pipeline into weakly-connected components (treating edges as
 * undirected). Each independent trigger→…→agent chain is its own component, so
 * the layout can keep them on separate rows instead of collapsing every chain's
 * roots into one shared column. Components are returned in the user's current
 * reading order (top-to-bottom, then left-to-right) so banding preserves the
 * arrangement rather than reshuffling it.
 */
function weaklyConnectedComponents(pipeline: CuePipeline): PipelineNode[][] {
	const ids = new Set(pipeline.nodes.map((n) => n.id));
	const parent = new Map<string, string>();
	for (const n of pipeline.nodes) parent.set(n.id, n.id);
	const find = (x: string): string => {
		let root = x;
		while (parent.get(root) !== root) root = parent.get(root)!;
		// Path-compress so repeated finds stay near-flat.
		let cur = x;
		while (parent.get(cur) !== root) {
			const next = parent.get(cur)!;
			parent.set(cur, root);
			cur = next;
		}
		return root;
	};
	for (const edge of pipeline.edges) {
		if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
		const a = find(edge.source);
		const b = find(edge.target);
		if (a !== b) parent.set(a, b);
	}

	const groups = new Map<string, PipelineNode[]>();
	for (const node of pipeline.nodes) {
		const root = find(node.id);
		const bucket = groups.get(root);
		if (bucket) bucket.push(node);
		else groups.set(root, [node]);
	}

	const minOf = (nodes: PipelineNode[], axis: 'x' | 'y'): number =>
		Math.min(...nodes.map((n) => n.position[axis]));
	return [...groups.values()].sort(
		(a, b) => minOf(a, 'y') - minOf(b, 'y') || minOf(a, 'x') - minOf(b, 'x')
	);
}

// Vertical gap between two stacked component bands. Zero so independent chains
// sit on ONE continuous uniform grid: the last row of a band and the first row
// of the next are exactly one row pitch (ROW_HEIGHT + NODE_GAP) apart, the same
// rhythm as rows within a column. No special inter-band whitespace.
const BAND_GAP = 0;

// Horizontal whitespace between two side-by-side column-GROUPS (each group is a
// vertical stack of independent component bands). When many small sub-circuits
// are packed into 2+ columns to fit the viewport, this is the clear gutter that
// separates one column of sub-circuits from the next. Wider than the intra-rank
// COLUMN_GAP so the eye reads the groups as distinct stacks, not one wide band.
const BAND_COLUMN_GAP = 64;

/**
 * Vertical coordinate assignment within a single component band. Returns each
 * node's CENTER y (relative, roughly around 0; the caller normalizes the band).
 *
 * Each rank column is kept as a rigid, evenly-spaced block (pitch
 * NODE_ROW_SPACING, order = the order already in `byRank`). The only freedom is
 * the block's vertical offset, which we settle so the block's centroid aligns
 * with the centroid of its connected neighbors. That single rule gives the
 * behavior fan layouts want:
 *
 *   - fan-out (1 source → N targets): the source's neighbor mean is the center
 *     of its N targets, so the source lands centered against the group.
 *   - fan-in  (N sources → 1 sink): symmetric - the sink centers on its sources.
 *   - a straight 1→1 chain: every node's neighbor mean is the next node, so all
 *     columns share one center line and edges stay dead-straight.
 *
 * Solved by relaxation: alternate forward/backward sweeps, each setting a
 * column's offset to the mean of its nodes' neighbor-center means. Acyclic small
 * pipeline graphs converge in a handful of sweeps; the seeded order is never
 * changed, so it shifts columns without reshuffling nodes.
 */
function assignBandCenters(
	byRank: Map<number, PipelineNode[]>,
	edges: CuePipeline['edges']
): Map<string, number> {
	const ranks = [...byRank.keys()].sort((a, b) => a - b);
	const colOf = new Map<string, number>();
	const idxInCol = new Map<string, number>();
	for (const r of ranks) {
		byRank.get(r)!.forEach((node, i) => {
			colOf.set(node.id, r);
			idxInCol.set(node.id, i);
		});
	}

	// Undirected neighbors (parents AND children) restricted to this band.
	const neighbors = new Map<string, string[]>();
	for (const r of ranks) for (const node of byRank.get(r)!) neighbors.set(node.id, []);
	for (const edge of edges) {
		if (!neighbors.has(edge.source) || !neighbors.has(edge.target)) continue;
		neighbors.get(edge.source)!.push(edge.target);
		neighbors.get(edge.target)!.push(edge.source);
	}

	const blockCenter = new Map<number, number>(ranks.map((r) => [r, 0]));
	const centerOf = (id: string): number => {
		const r = colOf.get(id)!;
		const size = byRank.get(r)!.length;
		return blockCenter.get(r)! + (idxInCol.get(id)! - (size - 1) / 2) * NODE_ROW_SPACING;
	};

	const SWEEPS = 12;
	for (let s = 0; s < SWEEPS; s++) {
		const order = s % 2 === 0 ? ranks : [...ranks].reverse();
		for (const r of order) {
			const group = byRank.get(r)!;
			let sum = 0;
			for (const node of group) {
				const nb = neighbors.get(node.id)!;
				if (nb.length === 0) {
					sum += blockCenter.get(r)!; // no edges here: hold position (inertia)
				} else {
					sum += nb.reduce((acc, m) => acc + centerOf(m), 0) / nb.length;
				}
			}
			blockCenter.set(r, sum / group.length);
		}
	}

	const result = new Map<string, number>();
	for (const r of ranks) for (const node of byRank.get(r)!) result.set(node.id, centerOf(node.id));
	return result;
}

/**
 * Lay out ONE column-group: a vertical stack of weakly-connected component bands
 * that share a single rank grid. Each component is a horizontal band (flow-depth
 * columns left→right); bands stack top-to-bottom in the order given. Every
 * component in the group shares one column grid (triggers all in column 0, their
 * targets all in column 1, ...) so the stack reads as one aligned circuit.
 *
 * Returns the positioned nodes (normalized so the group's top-left sits at 0,0)
 * plus the group's bounding-box width/height, which the caller uses to place
 * multiple column-groups side by side. Within each band, Tidy keeps the current
 * top-to-bottom order while Arrange (`untangle`) reorders to minimize crossings.
 */
function layoutColumnGroup(
	pipeline: CuePipeline,
	components: PipelineNode[][],
	untangle: boolean,
	widthOf: (node: PipelineNode) => number
): { nodes: PipelineNode[]; width: number; height: number } {
	// Pass 1: rank + order each component, and record the WIDEST node at each
	// GLOBAL rank across the group so every component shares one column grid.
	const banded: Array<{ byRank: Map<number, PipelineNode[]>; compEdges: CuePipeline['edges'] }> =
		[];
	const maxWidthByRank = new Map<number, number>();
	for (const comp of components) {
		const compIds = new Set(comp.map((n) => n.id));
		const compEdges = pipeline.edges.filter((e) => compIds.has(e.source) && compIds.has(e.target));
		const ranks = computeNodeRanks({ ...pipeline, nodes: comp, edges: compEdges });

		const byRank = new Map<number, PipelineNode[]>();
		for (const node of comp) {
			const r = ranks.get(node.id) ?? 0;
			const bucket = byRank.get(r);
			if (bucket) bucket.push(node);
			else byRank.set(r, [node]);
		}

		if (untangle) {
			minimizeCrossingsWithinColumns(byRank, compEdges);
		} else {
			// Tidy: keep the current top-to-bottom order within each column.
			for (const group of byRank.values()) group.sort(byCurrentPosition);
		}

		for (const [r, group] of byRank) {
			const widest = Math.max(...group.map(widthOf));
			maxWidthByRank.set(r, Math.max(maxWidthByRank.get(r) ?? 0, widest));
		}
		banded.push({ byRank, compEdges });
	}

	// Column x-origins: cumulative left edges. Each column starts COLUMN_GAP past
	// the right edge of the widest node in the previous column. COLUMN_GAP leaves
	// room for the target's arrowhead AND >=25px of visible straight line before
	// it, no matter how wide a node is. A chain of N ranks therefore yields N
	// distinct, non-overlapping columns.
	const columnX = new Map<number, number>();
	let x = 0;
	for (const r of [...maxWidthByRank.keys()].sort((a, b) => a - b)) {
		columnX.set(r, x);
		x += (maxWidthByRank.get(r) ?? NODE_BG_WIDTH) + COLUMN_GAP;
	}

	const nodes: PipelineNode[] = [];
	let bandTop = 0;
	let width = 0;

	// Pass 2: place each node at its column's left edge (nodes are LEFT-aligned
	// within a column per the user's spec) and at the vertical CENTER chosen by
	// the coordinate-assignment pass, which centers fan sources/sinks against the
	// group they branch to (see assignBandCenters).
	for (const { byRank, compEdges } of banded) {
		// Center y per node (relative, ~around 0). A node's connection handle sits
		// at its vertical center, so positioning by center keeps edges between
		// equal-center nodes a single straight horizontal segment even when heights
		// differ (a 60px trigger feeding an 80px agent).
		const centerY = assignBandCenters(byRank, compEdges);

		// Normalize the band so its topmost node's top edge sits at bandTop.
		let minTop = Infinity;
		let maxBottom = -Infinity;
		for (const group of byRank.values()) {
			for (const node of group) {
				const c = centerY.get(node.id)!;
				minTop = Math.min(minTop, c - nodeHeight(node) / 2);
				maxBottom = Math.max(maxBottom, c + nodeHeight(node) / 2);
			}
		}
		const shift = bandTop - minTop;

		for (const [r, group] of byRank) {
			for (const node of group) {
				const y = centerY.get(node.id)! + shift - nodeHeight(node) / 2;
				const px = columnX.get(r) ?? 0;
				nodes.push({ ...node, position: { x: px, y } });
				width = Math.max(width, px + widthOf(node));
			}
		}
		// Trailing NODE_GAP keeps the next band one clear gap below this one's
		// lowest node, the same rhythm as rows within a column.
		bandTop += maxBottom - minTop + NODE_GAP + BAND_GAP;
	}

	// bandTop overshot by one trailing gap after the last band; drop it.
	const height = Math.max(0, bandTop - NODE_GAP - BAND_GAP);
	return { nodes, width, height };
}

/**
 * Tidy partition: keep the column-groups the user already built. Cluster the
 * linked components by their CURRENT left edge so two visible columns of
 * sub-circuits stay two columns. Components within ~one node-width of each other
 * horizontally belong to the same column; a bigger gap starts a new column.
 * Returns column-groups left-to-right, each preserving reading order.
 */
function clusterColumnGroupsByCurrentX(linked: PipelineNode[][]): PipelineNode[][][] {
	const minXs = linked.map((comp) => Math.min(...comp.map((n) => n.position.x)));
	const sorted = [...new Set(minXs)].sort((a, b) => a - b);
	// A gap wider than one node footprint between consecutive left edges means the
	// user intentionally placed those sub-circuits in separate columns.
	const NEW_COLUMN_GAP = NODE_BG_WIDTH;
	const clusterOfX = new Map<number, number>();
	let cid = 0;
	for (let k = 0; k < sorted.length; k++) {
		if (k > 0 && sorted[k] - sorted[k - 1] > NEW_COLUMN_GAP) cid++;
		clusterOfX.set(sorted[k], cid);
	}
	const groups: PipelineNode[][][] = Array.from({ length: cid + 1 }, () => []);
	linked.forEach((comp, i) => groups[clusterOfX.get(minXs[i])!].push(comp));
	return groups;
}

/**
 * Arrange partition: pick the column count that best fills the viewport. Many
 * small independent sub-circuits stacked in one tall column waste the wide
 * editor canvas and force scrolling/zoom-out; packing them into 2+ columns makes
 * the whole "circuit board" fit. We estimate each component's footprint, then for
 * each candidate column count masonry-pack components (reading order → shortest
 * column) and keep the count whose overall aspect ratio is closest to the
 * viewport's. Ties favor fewer columns. With no viewport (tests) or a single
 * component, returns one column-group (legacy single-stack behavior).
 */
function chooseColumnGroupsForViewport(
	pipeline: CuePipeline,
	linked: PipelineNode[][],
	untangle: boolean,
	widthOf: (node: PipelineNode) => number,
	viewport?: { width: number; height: number }
): PipelineNode[][][] {
	const N = linked.length;
	if (N <= 1 || !viewport || viewport.width <= 0 || viewport.height <= 0) {
		return [linked];
	}

	const dims = linked.map((comp) => {
		const { width, height } = layoutColumnGroup(pipeline, [comp], untangle, widthOf);
		return { width, height };
	});
	const target = viewport.width / viewport.height;

	let best: { score: number; assign: PipelineNode[][][] } = { score: Infinity, assign: [linked] };
	for (let K = 1; K <= N; K++) {
		const colGroups: PipelineNode[][][] = Array.from({ length: K }, () => []);
		const colH = new Array<number>(K).fill(0);
		const colW = new Array<number>(K).fill(0);
		for (let i = 0; i < N; i++) {
			let s = 0;
			for (let c = 1; c < K; c++) if (colH[c] < colH[s]) s = c;
			// Bands stack with a NODE_GAP between them; the first in a column has none.
			colH[s] += dims[i].height + (colGroups[s].length > 0 ? NODE_GAP : 0);
			colW[s] = Math.max(colW[s], dims[i].width);
			colGroups[s].push(linked[i]);
		}
		const used = colGroups.filter((g) => g.length > 0);
		if (used.length === 0) continue;
		const totalW =
			colW.reduce((sum, w, c) => sum + (colGroups[c].length > 0 ? w : 0), 0) +
			(used.length - 1) * BAND_COLUMN_GAP;
		const totalH = Math.max(...colH);
		if (totalW <= 0 || totalH <= 0) continue;
		const score = Math.abs(Math.log(totalW / totalH / target));
		if (score < best.score) best = { score, assign: used };
	}
	return best.assign;
}

/**
 * Shared layout for both single-pipeline buttons. Lays each weakly-connected
 * component out as its OWN horizontal band (flow-depth columns left→right), then
 * packs the bands into one or more side-by-side column-groups. Tidy keeps the
 * column-groups the user already has (clustered by current x) and preserves node
 * order within each band; Arrange reorders to minimize crossings and repacks the
 * bands into the column count that best fills the viewport. Truly disconnected
 * single nodes are packed into a grid beneath the chains rather than forming a
 * tall thin column. Returns a NEW nodes array; the input is not mutated.
 */
function arrangeByColumns(
	pipeline: CuePipeline,
	untangle: boolean,
	nodeWidths?: Map<string, number>,
	viewport?: { width: number; height: number }
): PipelineNode[] {
	if (pipeline.nodes.length <= 1) return pipeline.nodes;

	const components = weaklyConnectedComponents(pipeline);
	const linked = components.filter((c) => c.length > 1);
	const isolated = components.filter((c) => c.length === 1).map((c) => c[0]);

	// Nodes render at `width: max-content`, so a command node with a long path or
	// a long agent name is far wider than the canonical NODE_BG_WIDTH footprint.
	// A fixed column pitch would let those wide nodes overrun the next column
	// (the "3-node chain crammed into 2 columns" bug). Use the REAL measured
	// width when available so each column clears the previous one. Fallback to
	// the footprint when unmeasured (e.g. unit tests, first paint).
	const widthOf = (node: PipelineNode): number => nodeWidths?.get(node.id) ?? NODE_BG_WIDTH;

	const arranged: PipelineNode[] = [];
	let stackBottom = 0;

	if (linked.length > 0) {
		// Tidy preserves the user's current columns; Arrange repacks to fit the view.
		const groups = untangle
			? chooseColumnGroupsForViewport(pipeline, linked, untangle, widthOf, viewport)
			: clusterColumnGroupsByCurrentX(linked);

		// Place each column-group's stack left-to-right with a clear gutter between.
		let groupX = 0;
		for (const group of groups) {
			const { nodes, width, height } = layoutColumnGroup(pipeline, group, untangle, widthOf);
			for (const node of nodes) {
				arranged.push({
					...node,
					position: { x: node.position.x + groupX, y: node.position.y },
				});
			}
			groupX += width + BAND_COLUMN_GAP;
			stackBottom = Math.max(stackBottom, height);
		}
	}

	// Pack any standalone nodes (no edges) into a grid beneath the chains.
	if (isolated.length > 0) {
		const offsetY = linked.length > 0 ? stackBottom + NODE_GAP : 0;
		for (const node of gridArrangeNodes(isolated)) {
			arranged.push({
				...node,
				position: { x: node.position.x, y: node.position.y + offsetY },
			});
		}
	}

	return arranged;
}

/**
 * "Tidy" layout. Aligns the current arrangement into flow-depth columns without
 * reshuffling node order within a band, so edge crossings are left intact. Keeps
 * the column-groups the user already built (clustered by current x) so a 2-column
 * arrangement stays 2 columns instead of collapsing into one tall stack.
 *
 * @param nodeWidths optional map of node id → measured rendered width. Columns
 *   are spaced from these so wide `max-content` nodes never overrun the next
 *   column. Falls back to the canonical footprint width per node when absent.
 */
export function arrangePipelineNodes(
	pipeline: CuePipeline,
	nodeWidths?: Map<string, number>
): PipelineNode[] {
	return arrangeByColumns(pipeline, false, nodeWidths);
}

/**
 * "Arrange" layout. Reorders nodes within each band to minimize edge crossings
 * (seeded by current order so it untangles rather than scrambles) AND repacks the
 * independent sub-circuits into the column count that best fills the viewport, so
 * the whole graph fits on screen without scrolling or zooming way out.
 *
 * @param nodeWidths optional map of node id → measured rendered width (see
 *   arrangePipelineNodes).
 * @param viewport optional editor canvas dimensions; when present, the number of
 *   column-groups is chosen so the laid-out graph's aspect ratio matches the
 *   viewport. Absent (e.g. unit tests), it falls back to a single column-group.
 */
export function untanglePipelineNodes(
	pipeline: CuePipeline,
	nodeWidths?: Map<string, number>,
	viewport?: { width: number; height: number }
): PipelineNode[] {
	return arrangeByColumns(pipeline, true, nodeWidths, viewport);
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
 * Pack pipeline group cards into a tight masonry. Returns a map of pipeline id
 * → new `viewOffset`. Pipelines are visited in their current reading order
 * (top-to-bottom, then left-to-right) and dealt into columns, so the layout
 * keeps roughly the sequence the user already sees while removing gaps.
 *
 * Why masonry instead of a uniform grid: a rigid grid sizes every column to the
 * widest card and every row to its tallest card. With one large pipeline (e.g. a
 * 27-node graph that's ~1600px wide and ~3000px tall), that blows out EVERY cell
 * - narrow two-node pipelines inherit the giant's column width and the giant's
 * row inherits its height, stranding small cards in a sea of whitespace (the
 * "Arrange didn't straighten anything" complaint). Masonry sidesteps both:
 *
 *   - Each card drops into the currently-SHORTEST column, so a single tall
 *     pipeline occupies one column while the rest fill the others. No card
 *     inherits another's height.
 *   - Each column is only as wide as ITS widest card, so a column of small
 *     pipelines stays narrow next to the giant's column. No card inherits
 *     another's width.
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

	// Deal each card into the shortest column (running height includes the gap).
	const colCards: GroupInfo[][] = Array.from({ length: cols }, () => []);
	const colHeights = new Array<number>(cols).fill(0);
	for (const info of infos) {
		let shortest = 0;
		for (let c = 1; c < cols; c++) {
			if (colHeights[c] < colHeights[shortest]) shortest = c;
		}
		colCards[shortest].push(info);
		colHeights[shortest] += info.height + GROUP_GAP;
	}

	// Column x-origins from per-column widths so left edges line up snugly.
	const colWidths = colCards.map((cards) =>
		cards.length === 0 ? 0 : Math.max(...cards.map((i) => i.width))
	);
	const colX = new Array<number>(cols).fill(0);
	for (let c = 1; c < cols; c++) {
		colX[c] = colX[c - 1] + colWidths[c - 1] + GROUP_GAP;
	}

	for (let c = 0; c < cols; c++) {
		let top = 0;
		for (const info of colCards[c]) {
			// Place the card's padded top-left corner at (colX, top). The card
			// renders at (minX + offset - PADDING), so solve offset for that origin.
			result.set(info.id, {
				x: colX[c] - (info.minX - PIPELINE_GROUP_PADDING),
				y: top - (info.minY - PIPELINE_GROUP_PADDING),
			});
			top += info.height + GROUP_GAP;
		}
	}
	return result;
}
