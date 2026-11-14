/**
 * Where each agent goes on the Delegation Graph.
 *
 * Two questions, two functions:
 *
 *   - `computeDelegationLayout` runs one named algorithm over the whole graph.
 *     It is what the layout picker calls, and what a scope with nothing saved
 *     is drawn with.
 *   - `arrangeDelegationGraph` is what the canvas calls on every model change.
 *     A saved position always wins. Only an agent with no saved position is
 *     placed, beside the agents it is connected to, and nothing already placed
 *     moves. This is the opposite of the Cue pipeline canvas, which re-runs its
 *     layout on every topology change: a picture of a team is useful only when
 *     the same agent is in the same place every time.
 *
 * The hierarchical and force algorithms are the Document Graph's
 * (`DocumentGraph/layoutAlgorithms.ts`), handed agent nodes and their size.
 * The radial one is here, because the Document Graph's is written for its
 * canvas nodes.
 *
 * Every layout places the CONNECTED agents only, and packs the isolated ones
 * in a grid below them. Most agents in a fleet have no peers, and an algorithm
 * given all of them draws one row dozens of nodes wide, or lets them drift.
 *
 * A position is the top-left corner of a node, as reactflow stores it.
 *
 * This module pulls in d3-force. The layout NAMES live in the leaf
 * `./delegationLayoutTypes`, so the settings store never imports it.
 */

import type { Edge, Node } from 'reactflow';
import dagre from '@dagrejs/dagre';
import type { MindMapNode, MindMapLink } from '../DocumentGraph/MindMap';
import { buildAdjacencyMap, calculateLayout } from '../DocumentGraph/mindMapLayouts';
import {
	DELEGATION_EDGE_LINES,
	delegationEdgeKind,
	delegationEdgeOpacity,
} from './edges/DelegationEdge';
import {
	connectedAgentIds,
	type DelegationGraphEdge,
	type DelegationGraphModel,
	type DelegationGraphNode,
} from '../../../shared/delegationGraph';
import {
	mergeSavedPositions,
	type DelegationSavedPositions,
} from '../../../shared/delegationGraphLayout';
import {
	applyForceLayout,
	applyHierarchicalLayout,
	positionNewNodesNearNeighbors,
	type NodeDimensions,
} from '../DocumentGraph/layoutAlgorithms';
import {
	DEFAULT_DELEGATION_LAYOUT,
	isDelegationAlgorithmLayout,
	type DelegationAlgorithmLayout,
	type DelegationLayoutType,
} from './delegationLayoutTypes';
import {
	AGENT_DELEGATION_NODE_HEIGHT,
	estimateAgentDelegationNodeWidth,
} from './nodes/agentDelegationNodeSize';

/** A node as the algorithms see it: an id, a position and a width. */
type LayoutNode = Node<{ width: number }>;

interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface DelegationLayoutOptions {
	/**
	 * The agent the radial layout puts in the middle. Absent, or not connected
	 * to anything, the agent with the most relationships is used.
	 */
	centerId?: string;
	spacingScale?: number;
}

export interface DelegationArrangement {
	/** Where every agent on the graph goes. */
	positions: DelegationSavedPositions;
	/**
	 * The subset that had no saved position and was placed by this call. Empty
	 * when every agent was already saved.
	 */
	newlyPlaced: DelegationSavedPositions;
}

/** Space between two agents in a row, and between two rows. */
const NODE_GAP = 60;
const RANK_GAP = 110;
/** How far a ring of the radial layout is from the one inside it. */
const RING_SPACING = 260;
/** How far below the connected agents the isolated ones start. */
const ISOLATED_BLOCK_GAP = 140;
const GRID_GAP = 40;
/** The least width the isolated grid wraps at, for a graph that is narrow or empty. */
const GRID_MIN_WIDTH = 960;
/** How far from its neighbors a new agent is put: clear of a node on every side. */
const NEW_NODE_DISTANCE = 260;
/** The golden angle. Successive points on a spiral at this turn never line up. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const NOTHING_PLACED: DelegationSavedPositions = Object.freeze({});

function measureNode(node: LayoutNode): NodeDimensions {
	return { width: node.data.width, height: AGENT_DELEGATION_NODE_HEIGHT };
}

function toLayoutNodes(nodes: readonly DelegationGraphNode[]): LayoutNode[] {
	return nodes.map((node) => ({
		id: node.sessionId,
		position: { x: 0, y: 0 },
		data: { width: estimateAgentDelegationNodeWidth(node.name) },
	}));
}

/** Adapt relationships to the Document Graph canvas without copying its renderer or layouts. */
export function delegationMindMapData(model: DelegationGraphModel): {
	nodes: MindMapNode[];
	links: MindMapLink[];
} {
	return {
		nodes: model.nodes.map((node) => ({
			id: node.sessionId,
			filePath: node.sessionId,
			label: node.name,
			nodeType: 'document',
			x: 0,
			y: 0,
			width: 0,
			height: 0,
			depth: 0,
			side: 'center',
		})),
		links: model.edges.map((edge) => ({
			source: edge.sourceId,
			target: edge.targetId,
			type: 'internal',
			directed: true,
			dashed: edge.read && !edge.write,
			strokeWidth: DELEGATION_EDGE_LINES[delegationEdgeKind(edge)!].width,
			opacity: delegationEdgeOpacity(edge.source),
		})),
	};
}

function toLayoutEdges(edges: readonly DelegationGraphEdge[]): Edge[] {
	return edges.map((edge) => ({ id: edge.id, source: edge.sourceId, target: edge.targetId }));
}

function positionsOf(nodes: readonly LayoutNode[]): DelegationSavedPositions {
	const positions: DelegationSavedPositions = {};
	for (const node of nodes) positions[node.id] = { x: node.position.x, y: node.position.y };
	return positions;
}

function boundsOf(nodes: readonly LayoutNode[]): Bounds | null {
	if (nodes.length === 0) return null;
	const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
	for (const node of nodes) {
		bounds.minX = Math.min(bounds.minX, node.position.x);
		bounds.minY = Math.min(bounds.minY, node.position.y);
		bounds.maxX = Math.max(bounds.maxX, node.position.x + node.data.width);
		bounds.maxY = Math.max(bounds.maxY, node.position.y + AGENT_DELEGATION_NODE_HEIGHT);
	}
	return bounds;
}

/**
 * Pack nodes in a grid: under `above` and flush with its left edge, or centered
 * on the origin when there is nothing above. The grid wraps at the width of
 * what is above it, so a long list of isolated agents does not make the graph
 * wider than its connected part.
 */
function packInGrid(nodes: readonly LayoutNode[], above: Bounds | null): LayoutNode[] {
	if (nodes.length === 0) return [];

	const cellWidth = Math.max(...nodes.map((node) => node.data.width)) + GRID_GAP;
	const cellHeight = AGENT_DELEGATION_NODE_HEIGHT + GRID_GAP;
	const wrapWidth = Math.max(above ? above.maxX - above.minX : 0, GRID_MIN_WIDTH);
	const columns = Math.max(1, Math.min(nodes.length, Math.floor(wrapWidth / cellWidth)));
	const rows = Math.ceil(nodes.length / columns);

	const originX = above ? above.minX : -(columns * cellWidth - GRID_GAP) / 2;
	const originY = above ? above.maxY + ISOLATED_BLOCK_GAP : -(rows * cellHeight - GRID_GAP) / 2;

	return nodes.map((node, index) => ({
		...node,
		position: {
			x: originX + (index % columns) * cellWidth,
			y: originY + Math.floor(index / columns) * cellHeight,
		},
	}));
}

/**
 * `node`, moved straight down until no node of `others` is under it. A new
 * agent is put at a random angle from its neighbors, which can be on top of an
 * agent that was already there. Down is one direction, so this always ends.
 */
function moveClearOf(node: LayoutNode, others: readonly LayoutNode[]): LayoutNode {
	const { x } = node.position;
	let { y } = node.position;
	let moved = true;
	while (moved) {
		moved = false;
		for (const other of others) {
			const overlaps =
				x < other.position.x + other.data.width + GRID_GAP &&
				other.position.x < x + node.data.width + GRID_GAP &&
				y < other.position.y + AGENT_DELEGATION_NODE_HEIGHT + GRID_GAP &&
				other.position.y < y + AGENT_DELEGATION_NODE_HEIGHT + GRID_GAP;
			if (overlaps) {
				y = other.position.y + AGENT_DELEGATION_NODE_HEIGHT + GRID_GAP;
				moved = true;
			}
		}
	}
	return y === node.position.y ? node : { ...node, position: { x, y } };
}

/** The nodes of `candidates` that an edge joins to a node of `anchored`. */
function withNeighborIn(
	candidates: readonly LayoutNode[],
	anchored: readonly LayoutNode[],
	edges: readonly Edge[]
): LayoutNode[] {
	const anchoredIds = new Set(anchored.map((node) => node.id));
	const reachable = new Set<string>();
	for (const edge of edges) {
		if (anchoredIds.has(edge.source)) reachable.add(edge.target);
		if (anchoredIds.has(edge.target)) reachable.add(edge.source);
	}
	return candidates.filter((node) => reachable.has(node.id));
}

/**
 * Start positions for the force simulation, on a spiral. The simulation picks
 * a random start for a node at the origin, so two runs over one graph would
 * differ. Seeded, the same graph gives the same picture every time.
 */
function seedOnSpiral(nodes: readonly LayoutNode[]): LayoutNode[] {
	return nodes.map((node, index) => {
		// From 1, so no point has a zero coordinate: the simulation reads a zero
		// as "not placed" and replaces it with a random number.
		const radius = 80 * Math.sqrt(index + 1);
		const angle = (index + 1) * GOLDEN_ANGLE;
		return {
			...node,
			position: { x: radius * Math.cos(angle), y: radius * Math.sin(angle) },
		};
	});
}

/**
 * Concentric rings around one agent. Ring `n` holds the agents `n`
 * relationships away from the center, counted in either direction: an agent
 * that can reach the center is as close to it as one the center can reach.
 * Agents with no path to the center go on one ring outside all the others.
 *
 * Around a ring, an agent sits in the wedge of the agent it was reached
 * through, and a wedge is as wide as the number of agents at its outer edge.
 * So a branch of the team fans out from its own lead and does not cross
 * another branch.
 */
function applyRadialLayout(
	nodes: readonly LayoutNode[],
	edges: readonly Edge[],
	centerId?: string
): LayoutNode[] {
	if (nodes.length === 0) return [];

	const order = new Map(nodes.map((node, index) => [node.id, index]));
	const neighbors = new Map<string, Set<string>>(nodes.map((node) => [node.id, new Set()]));
	for (const edge of edges) {
		neighbors.get(edge.source)?.add(edge.target);
		neighbors.get(edge.target)?.add(edge.source);
	}
	const degree = (id: string) => neighbors.get(id)?.size ?? 0;

	// `nodes` is in the model's order (by name), so a tie goes to the first name.
	const center =
		centerId !== undefined && order.has(centerId)
			? centerId
			: nodes.reduce(
					(best, node) => (degree(node.id) > degree(best) ? node.id : best),
					nodes[0].id
				);

	// Breadth-first, visiting neighbors in the model's order. Each agent is the
	// child of the agent it was first reached through.
	const rings: string[][] = [];
	const children = new Map<string, string[]>();
	const seen = new Set([center]);
	let ring = [center];
	while (ring.length > 0) {
		rings.push(ring);
		const next: string[] = [];
		for (const id of ring) {
			const unseen = [...(neighbors.get(id) ?? [])]
				.filter((neighbor) => !seen.has(neighbor))
				.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
			for (const neighbor of unseen) seen.add(neighbor);
			children.set(id, unseen);
			next.push(...unseen);
		}
		ring = next;
	}

	// How many agents sit at the outer edge of each agent's branch, from the
	// outermost ring inwards.
	const leaves = new Map<string, number>();
	for (const members of [...rings].reverse()) {
		for (const id of members) {
			const branch = children.get(id) ?? [];
			leaves.set(
				id,
				branch.length === 0 ? 1 : branch.reduce((sum, child) => sum + (leaves.get(child) ?? 1), 0)
			);
		}
	}

	// The center owns the whole circle, starting at the top. Each agent sits in
	// the middle of its wedge and splits the wedge among its children.
	const angles = new Map<string, number>();
	const wedges = [{ id: center, start: -Math.PI / 2, span: 2 * Math.PI }];
	while (wedges.length > 0) {
		const wedge = wedges.pop()!;
		angles.set(wedge.id, wedge.start + wedge.span / 2);
		let cursor = wedge.start;
		for (const child of children.get(wedge.id) ?? []) {
			const share = (wedge.span * (leaves.get(child) ?? 1)) / (leaves.get(wedge.id) ?? 1);
			wedges.push({ id: child, start: cursor, span: share });
			cursor += share;
		}
	}

	const unreached = nodes.filter((node) => !seen.has(node.id)).map((node) => node.id);
	unreached.forEach((id, index) => {
		angles.set(id, -Math.PI / 2 + (2 * Math.PI * index) / unreached.length);
	});
	if (unreached.length > 0) rings.push(unreached);

	const byId = new Map(nodes.map((node) => [node.id, node]));
	const widestOf = (members: readonly string[]) =>
		Math.max(...members.map((id) => byId.get(id)?.data.width ?? 0));

	const centers = new Map<string, { x: number; y: number }>([[center, { x: 0, y: 0 }]]);
	let radius = 0;
	let innerWidest = widestOf(rings[0]);
	for (const members of rings.slice(1)) {
		const widest = widestOf(members);
		// Clear of the ring inside it, where two nodes line up side by side.
		const clearRadius = radius + Math.max(RING_SPACING, (innerWidest + widest) / 2 + NODE_GAP);
		// Far enough out that the two closest nodes ON the ring do not touch: the
		// chord between them must be as long as a node is wide.
		const turns = members.map((id) => angles.get(id) ?? 0).sort((a, b) => a - b);
		let closest = members.length > 1 ? 2 * Math.PI - (turns[turns.length - 1] - turns[0]) : Math.PI;
		for (let index = 1; index < turns.length; index++) {
			closest = Math.min(closest, turns[index] - turns[index - 1]);
		}
		const fitRadius = (widest + GRID_GAP) / (2 * Math.sin(Math.min(closest, Math.PI) / 2));

		radius = Math.max(clearRadius, fitRadius);
		innerWidest = widest;
		for (const id of members) {
			const angle = angles.get(id) ?? 0;
			centers.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
		}
	}

	return nodes.map((node) => {
		const point = centers.get(node.id) ?? { x: 0, y: 0 };
		return {
			...node,
			position: {
				x: point.x - node.data.width / 2,
				y: point.y - AGENT_DELEGATION_NODE_HEIGHT / 2,
			},
		};
	});
}

/**
 * Run one algorithm over the whole graph and return a position for every
 * agent on it. Nothing saved is read: this is the arrangement the algorithm
 * gives, which the caller then saves over whatever was there.
 */
function computeDelegationLayoutBase(
	layout: DelegationAlgorithmLayout,
	model: DelegationGraphModel,
	options: DelegationLayoutOptions = {}
): DelegationSavedPositions {
	const connectedIds = connectedAgentIds(model);
	const nodes = toLayoutNodes(model.nodes);
	const connected = nodes.filter((node) => connectedIds.has(node.id));
	const isolated = nodes.filter((node) => !connectedIds.has(node.id));
	const edges = toLayoutEdges(model.edges);
	// Reuse graphlib's weak components: unrelated teams must never be threaded
	// through one another by a force simulation or a shared radial ring.
	const topology = new dagre.graphlib.Graph();
	for (const node of connected) topology.setNode(node.id, {});
	for (const edge of edges) topology.setEdge(edge.source, edge.target);
	const components = dagre.graphlib.alg.components(topology).sort((a, b) => b.length - a.length);
	if (components.length > 1) {
		const teams = components.map((ids) => {
			const members = new Set(ids);
			const positions = computeDelegationLayoutBase(
				layout,
				{
					nodes: model.nodes.filter((node) => members.has(node.sessionId)),
					edges: model.edges.filter(
						(edge) => members.has(edge.sourceId) && members.has(edge.targetId)
					),
				},
				options
			);
			const team = connected
				.filter((node) => members.has(node.id))
				.map((node) => ({
					...node,
					position: positions[node.id],
				}));
			return { nodes: team, bounds: boundsOf(team)! };
		});
		const gap = ISOLATED_BLOCK_GAP;
		const first = teams[0].bounds;
		const wrapWidth = Math.max(
			first.maxX - first.minX,
			Math.sqrt(
				teams.reduce(
					(area, team) =>
						area +
						(team.bounds.maxX - team.bounds.minX + gap) *
							(team.bounds.maxY - team.bounds.minY + gap),
					0
				) * 1.6
			)
		);
		const placed: LayoutNode[] = [];
		let x = first.minX;
		let y = first.minY;
		let rowHeight = 0;
		for (const team of teams) {
			const { bounds } = team;
			const width = bounds.maxX - bounds.minX;
			const height = bounds.maxY - bounds.minY;
			if (x !== first.minX && x + width > first.minX + wrapWidth) {
				x = first.minX;
				y += rowHeight + gap;
				rowHeight = 0;
			}
			placed.push(
				...team.nodes.map((node) => ({
					...node,
					position: { x: node.position.x + x - bounds.minX, y: node.position.y + y - bounds.minY },
				}))
			);
			x += width + gap;
			rowHeight = Math.max(rowHeight, height);
		}
		return positionsOf([...placed, ...packInGrid(isolated, boundsOf(placed))]);
	}

	let placed: LayoutNode[];
	switch (layout) {
		case 'mindmap':
		case 'lobes': {
			const data = delegationMindMapData({
				...model,
				nodes: model.nodes.filter((node) => connectedIds.has(node.sessionId)),
			});
			const adjacency = buildAdjacencyMap(data.links);
			const center =
				connected.find((node) => node.id === options.centerId)?.id ??
				[...connected].sort(
					(a, b) => (adjacency.get(b.id)?.size ?? 0) - (adjacency.get(a.id)?.size ?? 0)
				)[0]?.id ??
				'';
			const result = calculateLayout(
				layout,
				data.nodes,
				data.links,
				adjacency,
				center,
				Math.max(1, data.nodes.length - 1),
				960,
				640,
				false,
				0,
				1,
				true,
				true
			);
			// Expand the entire pill arrangement to reserve the editor's card
			// footprints. Pushing individual collisions down destroys its branches
			// and communities and makes their edges run through other teams.
			const scaleX = Math.max(
				1,
				...result.nodes.map(
					(node) => (estimateAgentDelegationNodeWidth(node.label) + GRID_GAP) / node.width
				)
			);
			const scaleY = Math.max(
				1,
				...result.nodes.map((node) => (AGENT_DELEGATION_NODE_HEIGHT + GRID_GAP) / node.height)
			);
			placed = result.nodes.map((node) => {
				const width = estimateAgentDelegationNodeWidth(node.label);
				return {
					id: node.id,
					position: {
						x: node.x * scaleX - width / 2,
						y: node.y * scaleY - AGENT_DELEGATION_NODE_HEIGHT / 2,
					},
					data: { width },
				};
			});
			break;
		}
		case 'hierarchical':
			placed = applyHierarchicalLayout(connected, edges, {
				measureNode,
				nodeSeparation: NODE_GAP,
				rankSeparation: RANK_GAP,
			});
			break;
		case 'force':
			placed = applyForceLayout(seedOnSpiral(connected), edges, {
				measureNode,
				nodeSeparation: NODE_GAP,
			});
			break;
		case 'radial':
			placed = applyRadialLayout(connected, edges, options.centerId);
			break;
	}

	return positionsOf([...placed, ...packInGrid(isolated, boundsOf(placed))]);
}

/** Scale centers rather than corners, so cards keep their footprints. */
export function scaleDelegationPositions(
	model: DelegationGraphModel,
	positions: DelegationSavedPositions,
	scale: number
): DelegationSavedPositions {
	if (scale === 1) return positions;
	const scaled: DelegationSavedPositions = {};
	for (const node of model.nodes) {
		const position = positions[node.sessionId];
		if (!position) continue;
		const halfWidth = estimateAgentDelegationNodeWidth(node.name) / 2;
		const halfHeight = AGENT_DELEGATION_NODE_HEIGHT / 2;
		scaled[node.sessionId] = {
			x: (position.x + halfWidth) * scale - halfWidth,
			y: (position.y + halfHeight) * scale - halfHeight,
		};
	}
	return scaled;
}

export function computeDelegationLayout(
	layout: DelegationAlgorithmLayout,
	model: DelegationGraphModel,
	options: DelegationLayoutOptions = {}
): DelegationSavedPositions {
	return scaleDelegationPositions(
		model,
		computeDelegationLayoutBase(layout, model, options),
		options.spacingScale ?? 1
	);
}

/**
 * Put every agent on the graph somewhere, moving nothing the user or an
 * earlier run already placed.
 *
 *   - Every agent has a saved position: those positions, unchanged.
 *   - No agent has one (a scope opened for the first time, or one whose saved
 *     agents are all gone): the scope's algorithm, or the default for a scope
 *     that is `manual` with nothing left of what was placed by hand.
 *   - Some do and some do not: the saved ones stay put. A new agent with a
 *     placed neighbor goes beside its neighbors, on a spot no other agent
 *     covers, and one with none goes in a grid under the graph. So no agent is
 *     ever dropped on the origin or on top of another.
 */
export function arrangeDelegationGraph(
	model: DelegationGraphModel,
	layout: DelegationLayoutType,
	saved: DelegationSavedPositions
): DelegationArrangement {
	const { placed, unplaced } = mergeSavedPositions(toLayoutNodes(model.nodes), saved);
	if (unplaced.length === 0) {
		return { positions: positionsOf(placed), newlyPlaced: NOTHING_PLACED };
	}
	if (placed.length === 0) {
		const positions = computeDelegationLayout(
			isDelegationAlgorithmLayout(layout) ? layout : DEFAULT_DELEGATION_LAYOUT,
			model
		);
		return { positions, newlyPlaced: positions };
	}

	// Place in rounds: an agent beside neighbors that already have a place, then
	// the agents beside THAT one, until a round places nobody.
	const edges = toLayoutEdges(model.edges);
	let anchored = placed;
	let waiting = unplaced;
	let ready = withNeighborIn(waiting, anchored, edges);
	while (ready.length > 0) {
		const beside = positionNewNodesNearNeighbors(ready, anchored, edges, {
			nodeSeparation: NEW_NODE_DISTANCE,
		});
		for (const node of beside) anchored = [...anchored, moveClearOf(node, anchored)];
		const readyIds = new Set(ready.map((node) => node.id));
		waiting = waiting.filter((node) => !readyIds.has(node.id));
		ready = withNeighborIn(waiting, anchored, edges);
	}

	const apart = packInGrid(waiting, boundsOf(anchored));
	const newlyPlaced = positionsOf([...anchored.slice(placed.length), ...apart]);
	return { positions: { ...positionsOf(placed), ...newlyPlaced }, newlyPlaced };
}
