/**
 * Delegation Graph - the fleet's peer relationships as one directed graph.
 *
 * `./peerAgents` answers "who may THIS agent reach". That view is authored one
 * agent at a time, so the shape of the whole team is never visible: nothing
 * says that one agent is reachable by nobody, or that two delegate to each
 * other. This module is the second view over the same data: every agent is a
 * node, and every resolved peer is an edge.
 *
 * It owns no persistence and no precedence. An edge is a `ResolvedPeer` seen
 * from the outside, so the rules about explicit rows, the group grant, the
 * worktree grant and exclusions stay in `resolvePeerRoster` and are never
 * restated here.
 *
 * The edge model:
 *
 *   - An edge is DIRECTED and carries the same two independent bits as a peer
 *     row. READ = the source may consult the target (`maestro-cli ask`).
 *     WRITE = the source may delegate to the target (`maestro-cli dispatch`).
 *   - There is ONE edge per ordered pair, not one per bit. An agent that may
 *     both consult and delegate to a peer is one edge with both bits lit.
 *   - The reverse relationship is a SEPARATE edge, because it is a separate
 *     statement in a separate agent's settings. "Bidirectional" is two edges
 *     existing, never a flag on one.
 *
 * Not the Document Graph: that one graphs documents and their links.
 *
 * This module is bundled into the renderer, so it imports nothing that reaches
 * `fs`, `os`, or Electron.
 */

import {
	resolvePeerRoster,
	SELF_PEER_ERROR,
	type PeerRosterInput,
	type ResolvedPeer,
} from './peerAgents';
import type { PeerAccess } from './types';

/** Why an agent appears on the graph at all. */
export type DelegationNodeScope = 'in-scope' | 'spill';

export interface DelegationGraphNode {
	sessionId: string;
	name: string;
	groupId?: string;
	/**
	 * 'spill' means: outside the requested scope. It is drawn because an edge
	 * reaches it, or because the user placed it on the canvas
	 * (`DelegationGraphOptions.placedIds`) and has not connected it yet.
	 */
	scope: DelegationNodeScope;
}

/** An agent that has no node on a graph: what "Add agent" on the canvas lists. */
export type DelegationOffGraphAgent = Omit<DelegationGraphNode, 'scope'>;

/**
 * One directed relationship. `source` may consult `target` when `read` is set, and
 * delegate to `target` when `write` is set. The reverse relationship, if any, is a
 * SEPARATE edge; there is no bidirectional flag.
 */
export interface DelegationGraphEdge extends PeerAccess {
	/** Stable id: `${sourceId}->${targetId}`. Used by reactflow and by the tests. */
	id: string;
	sourceId: string;
	targetId: string;
	description?: string;
	/** Which grant produced this edge, straight from ResolvedPeer.source. */
	source: ResolvedPeer['source'];
}

/**
 * Which agents the graph is about. A group scope matches on `groupId` equality,
 * the same way the group grant does: it reaches neither a parent group nor a
 * child group.
 */
export type DelegationGraphScope =
	| { kind: 'all' }
	| { kind: 'group'; groupId: string }
	| { kind: 'agent'; sessionId: string };

export interface DelegationGraphModel {
	nodes: DelegationGraphNode[];
	edges: DelegationGraphEdge[];
}

export interface DelegationGraphOptions {
	/**
	 * Agents the user put on the canvas by hand. Each one gets a node even when
	 * it is outside the scope and no edge reaches it, so there is something to
	 * draw an edge to. Placing changes no agent: it writes no peer row and it
	 * does NOT move the agent into the scope's group. The node is `spill`, the
	 * same as after the first edge is drawn, because the agent is outside the
	 * scope either way. An id that is already on the graph, or that names no
	 * live agent, changes nothing.
	 */
	placedIds?: Iterable<string>;
}

/** The counts the legend and the empty-state copy read. */
export interface DelegationGraphStats {
	/** Every agent on the graph, `spill` agents included. */
	agents: number;
	/** Directed edges. A pair that reaches each other counts as two. */
	edges: number;
	/** Pairs of agents with an edge in EACH direction. A pair counts once. */
	mutual: number;
	/**
	 * In-scope agents no edge touches. An agent outside the scope that no edge
	 * touches is counted in `placed`, never here: "nobody reaches it" is a fact
	 * about the fleet, and "not connected yet" is a fact about this canvas.
	 */
	isolated: number;
	/** Agents outside the requested scope, a subset of `agents`. */
	spill: number;
	/**
	 * Agents outside the scope that no edge touches, a subset of `spill`. Only
	 * `DelegationGraphOptions.placedIds` puts one on a graph.
	 */
	placed: number;
}

/**
 * The id of the edge from one agent to another. The builder, the lookups below
 * and the canvas share it, so none of them can disagree about the spelling. A
 * caller that asks "does the reverse edge exist" for every edge builds one
 * `Set` of ids and tests `delegationEdgeId(target, source)`, which `isMutual`
 * answers with a walk of the edge list per call.
 */
export function delegationEdgeId(sourceId: string, targetId: string): string {
	return `${sourceId}->${targetId}`;
}

/**
 * Build the graph for a scope from the live agent list. It takes the same
 * minimal `PeerRosterInput` shape roster resolution does, so the renderer
 * passes its `Session`s and the CLI its own session records.
 *
 * Every agent's roster is resolved, in scope or not, and an edge is kept when
 * EITHER end is in scope. That one rule covers both directions of a group
 * scope: an edge that leaves the group (outbound) and an edge that reaches
 * into it from outside (inbound). Without the inbound half the graph shows
 * only arrows going out and reads as though nobody can reach the group. An
 * edge between two agents that are both outside the scope is not the scope's
 * business and is dropped.
 *
 * Nodes:
 *
 *   - Every in-scope agent gets one, with or without edges. An agent that
 *     nobody reaches and that reaches nobody is exactly what the graph exists
 *     to show.
 *   - An agent outside the scope gets one only when a kept edge names it, or
 *     when `options.placedIds` names it, and it is marked `spill` so the canvas
 *     can draw it differently.
 *
 * `resolvePeerRoster` has already dropped the agent itself, a row whose agent
 * is gone, and a peer left with neither bit. So there is no self-edge, no
 * dangling edge and no dead edge to guard against here, and each `ResolvedPeer`
 * becomes exactly one edge.
 *
 * The output is sorted (nodes by name, then id; edges by id), so two calls with
 * the same input give the same order and a caller never has to sort.
 */
export function buildDelegationGraph(
	scope: DelegationGraphScope,
	sessions: readonly PeerRosterInput[],
	options: DelegationGraphOptions = {}
): DelegationGraphModel {
	if (scope.kind === 'agent') {
		const fleet = buildDelegationGraph({ kind: 'all' }, sessions);
		const neighbors = new Map<string, Set<string>>();
		for (const edge of fleet.edges) {
			if (!neighbors.has(edge.sourceId)) neighbors.set(edge.sourceId, new Set());
			if (!neighbors.has(edge.targetId)) neighbors.set(edge.targetId, new Set());
			neighbors.get(edge.sourceId)!.add(edge.targetId);
			neighbors.get(edge.targetId)!.add(edge.sourceId);
		}
		// A cluster follows both incoming and outgoing edges, including transitive peers.
		const members = new Set([scope.sessionId]);
		for (const id of members) {
			for (const neighbor of neighbors.get(id) ?? []) members.add(neighbor);
		}
		const placed = new Set(options.placedIds);
		return {
			nodes: fleet.nodes
				.filter((node) => members.has(node.sessionId) || placed.has(node.sessionId))
				.map((node) => ({ ...node, scope: members.has(node.sessionId) ? 'in-scope' : 'spill' })),
			edges: fleet.edges.filter((edge) => members.has(edge.sourceId) || members.has(edge.targetId)),
		};
	}
	const placedIds = new Set(options.placedIds);
	const inScopeIds = new Set<string>();
	for (const session of sessions) {
		if (scope.kind === 'all' || session.groupId === scope.groupId) inScopeIds.add(session.id);
	}

	const edges: DelegationGraphEdge[] = [];
	const reachedIds = new Set<string>();
	for (const session of sessions) {
		const sourceInScope = inScopeIds.has(session.id);
		for (const peer of resolvePeerRoster(session, sessions)) {
			if (!sourceInScope && !inScopeIds.has(peer.sessionId)) continue;
			edges.push({
				id: delegationEdgeId(session.id, peer.sessionId),
				sourceId: session.id,
				targetId: peer.sessionId,
				read: peer.read,
				write: peer.write,
				...(peer.description ? { description: peer.description } : {}),
				source: peer.source,
			});
			reachedIds.add(session.id);
			reachedIds.add(peer.sessionId);
		}
	}

	const nodes: DelegationGraphNode[] = [];
	for (const session of sessions) {
		const inScope = inScopeIds.has(session.id);
		if (!inScope && !reachedIds.has(session.id) && !placedIds.has(session.id)) continue;
		nodes.push({
			sessionId: session.id,
			name: session.name,
			...(session.groupId ? { groupId: session.groupId } : {}),
			scope: inScope ? 'in-scope' : 'spill',
		});
	}

	return {
		nodes: nodes.sort(byNameThenId),
		// Code-unit order, not `localeCompare`: an edge id is built from agent ids,
		// which are not words, and this order is the same on every machine.
		edges: edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
	};
}

/** The order of every list of agents here: by name, and by id between two with one name. */
function byNameThenId(a: DelegationOffGraphAgent, b: DelegationOffGraphAgent): number {
	return a.name.localeCompare(b.name) || a.sessionId.localeCompare(b.sessionId);
}

/**
 * Every live agent with no node on `model`, sorted like the nodes are. On the
 * graph of every agent the list is empty. On a group's graph it is the agents
 * outside the group that no edge joins to it: the ones a user can place on the
 * canvas (`DelegationGraphOptions.placedIds`) to draw an edge to.
 */
export function agentsOffGraph(
	model: DelegationGraphModel,
	sessions: readonly PeerRosterInput[]
): DelegationOffGraphAgent[] {
	const onGraphIds = new Set(model.nodes.map((node) => node.sessionId));
	return sessions
		.filter((session) => !onGraphIds.has(session.id))
		.map((session) => ({
			sessionId: session.id,
			name: session.name,
			...(session.groupId ? { groupId: session.groupId } : {}),
		}))
		.sort(byNameThenId);
}

/**
 * The edge from `sourceId` to `targetId`, when there is one. Direction matters:
 * the edge from `targetId` back to `sourceId` is a different edge.
 */
export function edgeBetween(
	model: DelegationGraphModel,
	sourceId: string,
	targetId: string
): DelegationGraphEdge | undefined {
	return model.edges.find((edge) => edge.sourceId === sourceId && edge.targetId === targetId);
}

/**
 * Why an edge from `sourceId` to `targetId` cannot be drawn on this graph, or
 * `null` when it can. Two drops are refused:
 *
 *   - An agent onto itself. An agent is never its own peer, and
 *     `resolvePeerRoster` would drop the row.
 *   - Two `spill` agents, placed by the user or reached by an edge.
 *     `buildDelegationGraph` keeps an edge only when one end is in scope, so
 *     the row would be written and the edge would not appear, and an edge
 *     already there is not in the model to be shown first.
 *
 * An end that is not on the graph is not refused here: the write itself names
 * an agent that is gone.
 */
export function delegationEdgeRefusal(
	model: DelegationGraphModel,
	sourceId: string,
	targetId: string
): string | null {
	if (sourceId === targetId) return `${SELF_PEER_ERROR} Drop the edge on another agent.`;
	const isSpill = (sessionId: string) =>
		model.nodes.some((node) => node.sessionId === sessionId && node.scope === 'spill');
	if (isSpill(sourceId) && isSpill(targetId)) {
		return 'Both agents are outside this group, so its graph would not draw the edge. Switch the scope to All agents to connect them.';
	}
	return null;
}

/**
 * True when edges exist in BOTH directions between two agents, whichever bits
 * each one carries. This is the "bidirectional" question, answered from two
 * edges because it is stored on neither. A manager who may delegate to an
 * employee who may only consult back is mutual.
 */
export function isMutual(model: DelegationGraphModel, a: string, b: string): boolean {
	return edgeBetween(model, a, b) !== undefined && edgeBetween(model, b, a) !== undefined;
}

/**
 * Every agent at least one edge touches, at either end. An in-scope agent on
 * the graph that is NOT in this set is isolated: nobody reaches it and it
 * reaches nobody. A `spill` agent that is not in it was placed by the user and
 * is not connected yet. `delegationGraphStats` counts both and the canvas marks
 * both, and both ask here so the two cannot disagree about which agents they
 * are.
 */
export function connectedAgentIds(model: DelegationGraphModel): Set<string> {
	const connectedIds = new Set<string>();
	for (const edge of model.edges) {
		connectedIds.add(edge.sourceId);
		connectedIds.add(edge.targetId);
	}
	return connectedIds;
}

/**
 * Count what is on the graph. `agents` includes the `spill` agents, so the
 * in-scope count is `agents - spill`.
 */
export function delegationGraphStats(model: DelegationGraphModel): DelegationGraphStats {
	const edgeIds = new Set(model.edges.map((edge) => edge.id));
	const connectedIds = connectedAgentIds(model);

	// A mutual pair is two edges. Count it at the one whose source id sorts
	// first, so the pair counts once.
	let mutual = 0;
	for (const edge of model.edges) {
		if (
			edge.sourceId < edge.targetId &&
			edgeIds.has(delegationEdgeId(edge.targetId, edge.sourceId))
		) {
			mutual++;
		}
	}

	let isolated = 0;
	let spill = 0;
	let placed = 0;
	for (const node of model.nodes) {
		const connected = connectedIds.has(node.sessionId);
		if (node.scope === 'spill') {
			spill++;
			if (!connected) placed++;
		} else if (!connected) {
			isolated++;
		}
	}

	return {
		agents: model.nodes.length,
		edges: model.edges.length,
		mutual,
		isolated,
		spill,
		placed,
	};
}

function countOf(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * The counts in words, one line per fact, in the order a reader asks: how many,
 * how connected, what stands out. A fact with a count of zero has no line. The
 * legend on the canvas and `maestro-cli delegation graph` both print these, so
 * the two cannot count a graph in different words.
 */
export function describeDelegationGraphStats(stats: DelegationGraphStats): string[] {
	const lines = [
		`${countOf(stats.agents, 'agent', 'agents')}, ${countOf(stats.edges, 'edge', 'edges')}`,
	];
	if (stats.mutual > 0) lines.push(countOf(stats.mutual, 'mutual pair', 'mutual pairs'));
	if (stats.isolated > 0) lines.push(`${stats.isolated} with no peers`);
	if (stats.spill > 0) lines.push(`${stats.spill} outside this scope`);
	if (stats.placed > 0) lines.push(`${stats.placed} added, no edge yet`);
	return lines;
}

/** One edge as one of its two agents sees it: the edge, and the agent at the far end. */
export interface DelegationAdjacencyLink {
	edge: DelegationGraphEdge;
	/** The agent at the other end of `edge`. */
	peer: DelegationGraphNode;
	/** True when the edge in the opposite direction exists too. */
	mutual: boolean;
}

/** One agent on the graph with every edge that touches it, split by direction. */
export interface DelegationAdjacencyEntry {
	node: DelegationGraphNode;
	/** The edges this agent is the SOURCE of: whom it may consult or delegate to. */
	reaches: DelegationAdjacencyLink[];
	/** The edges this agent is the TARGET of: who may consult it or delegate to it. */
	reachedBy: DelegationAdjacencyLink[];
}

/**
 * The graph as an adjacency listing: every node, in the model's order, with the
 * edges that leave it and the edges that arrive at it. It is the model read by
 * agent and not by edge, which is the shape a listing in text needs
 * (`maestro-cli delegation graph`). Both lists are in the order of the peer's
 * node, so the listing is as stable as the model.
 *
 * It is a view and holds no rule: an edge is in `reaches` of its source and in
 * `reachedBy` of its target, exactly once each. On a group scope a `spill`
 * agent lists only the edges that join it to the group, because the model
 * keeps no other edge of it.
 */
export function delegationAdjacency(model: DelegationGraphModel): DelegationAdjacencyEntry[] {
	const order = new Map(model.nodes.map((node, index) => [node.sessionId, index]));
	const edgeIds = new Set(model.edges.map((edge) => edge.id));
	const entries = new Map(
		model.nodes.map((node): [string, DelegationAdjacencyEntry] => [
			node.sessionId,
			{ node, reaches: [], reachedBy: [] },
		])
	);

	for (const edge of model.edges) {
		const source = entries.get(edge.sourceId);
		const target = entries.get(edge.targetId);
		// `buildDelegationGraph` gives both ends of every edge a node. A model
		// built by hand that does not is listed without the edge.
		if (!source || !target) continue;
		const mutual = edgeIds.has(delegationEdgeId(edge.targetId, edge.sourceId));
		source.reaches.push({ edge, peer: target.node, mutual });
		target.reachedBy.push({ edge, peer: source.node, mutual });
	}

	const byPeerOrder = (a: DelegationAdjacencyLink, b: DelegationAdjacencyLink) =>
		(order.get(a.peer.sessionId) ?? 0) - (order.get(b.peer.sessionId) ?? 0);
	return [...entries.values()].map((entry) => ({
		node: entry.node,
		reaches: entry.reaches.sort(byPeerOrder),
		reachedBy: entry.reachedBy.sort(byPeerOrder),
	}));
}
