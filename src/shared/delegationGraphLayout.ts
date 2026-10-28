/**
 * Delegation Graph layout storage - where each agent sits, per scope.
 *
 * `./delegationGraph` builds the picture (nodes and edges) and owns no
 * persistence. This module is the other half: the key a scope's arrangement is
 * stored under, and the three operations on a set of saved coordinates. It
 * knows nothing about which layouts exist; that vocabulary is the leaf module
 * `renderer/components/DelegationGraph/delegationLayoutTypes.ts`, and the
 * record that joins the two (`{ layout, positions }` per scope) is the
 * renderer's `settingsDelegationGraphSlice.ts`.
 *
 * Positions are stored PER SCOPE, because one agent sits in the "all" graph
 * and in its group's graph at different places. A position saved in one scope
 * must never be read in another.
 *
 * Everything here is pure, and bundled into the renderer, so it imports
 * nothing that reaches `fs`, `os`, or Electron.
 */

import type { DelegationGraphScope } from './delegationGraph';

/** The settings key the per-scope layouts are stored under. */
export const DELEGATION_GRAPH_LAYOUTS_SETTING = 'delegationGraphLayouts';

const ALL_SCOPE_KEY = 'all';
const GROUP_SCOPE_PREFIX = 'group:';
const AGENT_SCOPE_PREFIX = 'agent:';

/** Where one agent sits on the canvas, in reactflow's coordinate space. */
export interface DelegationNodePosition {
	x: number;
	y: number;
}

/** One scope's saved coordinates, keyed by the agent's session id. */
export type DelegationSavedPositions = Record<string, DelegationNodePosition>;

/** The part of a canvas node this module reads. A reactflow `Node` satisfies it. */
export interface DelegationPositionedNode {
	id: string;
	position: DelegationNodePosition;
}

/** What `mergeSavedPositions` returns: the nodes split by whether a position was saved. */
export interface DelegationMergedPositions<T extends DelegationPositionedNode> {
	/** Nodes that had a saved position, now carrying it. */
	placed: T[];
	/** Nodes with no saved position, untouched. The caller decides where they go. */
	unplaced: T[];
}

/**
 * The key a scope's layout is stored under: `'all'`, or `group:<groupId>`.
 * `parseScopeStorageKey` is its inverse.
 */
export function scopeStorageKey(scope: DelegationGraphScope): string {
	if (scope.kind === 'all') return ALL_SCOPE_KEY;
	return scope.kind === 'group'
		? `${GROUP_SCOPE_PREFIX}${scope.groupId}`
		: `${AGENT_SCOPE_PREFIX}${scope.sessionId}`;
}

/**
 * The scope a storage key names, or `null` when the key is not one
 * `scopeStorageKey` could have written. A stored record is filtered through
 * this, so a key written by hand or by a later build is dropped instead of
 * being carried forever.
 */
export function parseScopeStorageKey(key: string): DelegationGraphScope | null {
	if (key === ALL_SCOPE_KEY) return { kind: 'all' };
	if (key.startsWith(GROUP_SCOPE_PREFIX) && key.length > GROUP_SCOPE_PREFIX.length) {
		return { kind: 'group', groupId: key.slice(GROUP_SCOPE_PREFIX.length) };
	}
	if (key.startsWith(AGENT_SCOPE_PREFIX) && key.length > AGENT_SCOPE_PREFIX.length) {
		return { kind: 'agent', sessionId: key.slice(AGENT_SCOPE_PREFIX.length) };
	}
	return null;
}

/**
 * The usable coordinates in a value read from disk or handed over by a layout
 * algorithm. An entry is kept only when both `x` and `y` are finite numbers,
 * and only those two fields are copied. A layout that diverged to `NaN` is
 * therefore dropped here instead of reaching disk, where JSON would turn it
 * into `null`.
 */
export function parseSavedPositions(raw: unknown): DelegationSavedPositions {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

	const positions: DelegationSavedPositions = {};
	for (const [sessionId, value] of Object.entries(raw)) {
		if (!value || typeof value !== 'object') continue;
		const { x, y } = value as Partial<DelegationNodePosition>;
		if (typeof x !== 'number' || typeof y !== 'number') continue;
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		positions[sessionId] = { x, y };
	}
	return positions;
}

/**
 * Put each node where the user left it, and say which nodes have nowhere to go.
 *
 * A node with a saved position is returned in `placed` as a copy carrying that
 * position. A node without one is returned in `unplaced` exactly as it came in,
 * so the position it arrived with (usually the origin) is never mistaken for a
 * saved one. The two lists map onto `positionNewNodesNearNeighbors(unplaced,
 * placed, edges)`, which is how a newly created agent lands beside the agents
 * it is connected to. Each list keeps the order of `nodes`.
 */
export function mergeSavedPositions<T extends DelegationPositionedNode>(
	nodes: readonly T[],
	saved: DelegationSavedPositions
): DelegationMergedPositions<T> {
	const placed: T[] = [];
	const unplaced: T[] = [];
	for (const node of nodes) {
		// Own keys only: a node id is never answered by something inherited from
		// `Object.prototype`.
		const position = Object.prototype.hasOwnProperty.call(saved, node.id)
			? saved[node.id]
			: undefined;
		if (position) {
			placed.push({ ...node, position: { x: position.x, y: position.y } });
		} else {
			unplaced.push(node);
		}
	}
	return { placed, unplaced };
}

/**
 * Drop the coordinates of agents that no longer exist, so a deleted agent's
 * position does not accumulate forever.
 *
 * `liveSessionIds` is every agent that exists, NOT every agent on the canvas.
 * An agent that is alive but not drawn right now (a `spill` agent whose edge
 * was removed) keeps its position, so it returns to the same place when the
 * edge comes back.
 *
 * Returns `saved` itself when nothing was dropped, so a caller can compare
 * identities to learn whether there is anything to write.
 */
export function prunePositions(
	saved: DelegationSavedPositions,
	liveSessionIds: Iterable<string>
): DelegationSavedPositions {
	const live = liveSessionIds instanceof Set ? liveSessionIds : new Set(liveSessionIds);

	let dropped = false;
	const kept: DelegationSavedPositions = {};
	for (const [sessionId, position] of Object.entries(saved)) {
		if (live.has(sessionId)) {
			kept[sessionId] = position;
		} else {
			dropped = true;
		}
	}
	return dropped ? kept : saved;
}
