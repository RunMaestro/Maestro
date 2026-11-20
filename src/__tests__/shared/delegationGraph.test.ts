/**
 * Delegation Graph - the fleet's peer rosters as nodes and directed edges.
 *
 * The graph owns no precedence: every edge is a `ResolvedPeer` from
 * `resolvePeerRoster`, whose rules are asserted in `peerAgents.test.ts`. These
 * tests cover what the graph adds on top: direction, scope, and the queries a
 * canvas asks of the model.
 */

import { describe, it, expect } from 'vitest';

import {
	agentsOffGraph,
	buildDelegationGraph,
	connectedAgentIds,
	delegationAdjacency,
	delegationEdgeId,
	delegationEdgeRefusal,
	delegationGraphStats,
	describeDelegationGraphStats,
	edgeBetween,
	isMutual,
} from '../../shared/delegationGraph';
import type { DelegationGraphModel, DelegationGraphStats } from '../../shared/delegationGraph';
import { SELF_PEER_ERROR } from '../../shared/peerAgents';
import type { PeerRosterInput } from '../../shared/peerAgents';
import type { PeerAccess, PeerAgent } from '../../shared/types';

const R: PeerAccess = { read: true, write: false };
const W: PeerAccess = { read: false, write: true };
const RW: PeerAccess = { read: true, write: true };

function agent(id: string, name: string, extra: Partial<PeerRosterInput> = {}): PeerRosterInput {
	return { id, name, ...extra };
}

function row(sessionId: string, access: PeerAccess): PeerAgent {
	return { sessionId, ...access };
}

const NONE: PeerAccess = { read: false, write: false };

const ALL = { kind: 'all' } as const;
const G1 = { kind: 'group', groupId: 'g1' } as const;

// The canvas builds one Set of edge ids and asks for the reverse of each edge.
describe('delegationEdgeId', () => {
	it('is the id the builder gives the edge between the same two agents', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alpha', { peerAgents: [row('b', R)] }),
			agent('b', 'Beta'),
		]);

		expect(model.edges.map((edge) => edge.id)).toEqual([delegationEdgeId('a', 'b')]);
	});

	it('is directed: the reverse edge has another id', () => {
		expect(delegationEdgeId('a', 'b')).not.toBe(delegationEdgeId('b', 'a'));
	});
});

describe('buildDelegationGraph', () => {
	it('scopes an agent to its full connected cluster across groups and edge directions', () => {
		const sessions = [
			agent('a', 'Alpha', { groupId: 'g1', peerAgents: [row('b', R)] }),
			agent('b', 'Beta', { groupId: 'g2' }),
			agent('c', 'Gamma', { peerAgents: [row('b', W)] }),
			agent('d', 'Delta', { peerAgents: [row('e', RW)] }),
			agent('e', 'Echo'),
		];
		const model = buildDelegationGraph({ kind: 'agent', sessionId: 'a' }, sessions);
		expect(model.nodes.map((node) => node.sessionId)).toEqual(['a', 'b', 'c']);
		expect(model.nodes.every((node) => node.scope === 'in-scope')).toBe(true);
		expect(model.edges.map((edge) => edge.id)).toEqual(['a->b', 'c->b']);
	});

	it('handles an isolated or removed cluster anchor without importing other agents', () => {
		const sessions = [agent('a', 'Alpha'), agent('b', 'Beta')];
		expect(
			buildDelegationGraph({ kind: 'agent', sessionId: 'a' }, sessions).nodes.map(
				(node) => node.sessionId
			)
		).toEqual(['a']);
		expect(buildDelegationGraph({ kind: 'agent', sessionId: 'gone' }, sessions)).toEqual({
			nodes: [],
			edges: [],
		});
	});

	it('can place an unrelated agent in a cluster without granting access', () => {
		const model = buildDelegationGraph(
			{ kind: 'agent', sessionId: 'a' },
			[agent('a', 'Alpha'), agent('b', 'Beta')],
			{ placedIds: ['b'] }
		);
		expect(model.nodes.map((node) => [node.sessionId, node.scope])).toEqual([
			['a', 'in-scope'],
			['b', 'spill'],
		]);
		expect(model.edges).toEqual([]);
	});
	it('draws a manager and an employee as two edges, each with its own bits', () => {
		const model = buildDelegationGraph(ALL, [
			agent('m', 'Manager', { peerAgents: [row('e', RW)] }),
			agent('e', 'Employee', { peerAgents: [row('m', R)] }),
		]);

		expect(model.edges).toEqual([
			{ id: 'e->m', sourceId: 'e', targetId: 'm', read: true, write: false, source: 'explicit' },
			{ id: 'm->e', sourceId: 'm', targetId: 'e', read: true, write: true, source: 'explicit' },
		]);
		expect(isMutual(model, 'm', 'e')).toBe(true);
		expect(edgeBetween(model, 'e', 'm')?.write).toBe(false);
	});

	it('draws one edge when only one agent lists the other, and still gives the target a node', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', R)] }),
			agent('b', 'Bob'),
		]);

		expect(model.edges.map((edge) => edge.id)).toEqual(['a->b']);
		expect(isMutual(model, 'a', 'b')).toBe(false);
		expect(model.nodes).toEqual([
			{ sessionId: 'a', name: 'Alice', scope: 'in-scope' },
			{ sessionId: 'b', name: 'Bob', scope: 'in-scope' },
		]);
	});

	it('copies the description and the grant source from the resolved peer', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [{ ...row('b', R), description: 'Owns the docs' }] }),
			agent('b', 'Bob'),
			agent('p', 'Parent', { worktreePeerAccess: W }),
			agent('w', 'Worktree', { parentSessionId: 'p' }),
		]);

		expect(edgeBetween(model, 'a', 'b')).toMatchObject({
			description: 'Owns the docs',
			source: 'explicit',
		});
		expect(edgeBetween(model, 'p', 'w')).toEqual({
			id: 'p->w',
			sourceId: 'p',
			targetId: 'w',
			read: false,
			write: true,
			source: 'worktree',
		});
	});

	it('never marks an agent as spill when the scope is every agent', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('x', W)] }),
			agent('x', 'Xavier', { groupId: 'g2' }),
			agent('z', 'Zed'),
		]);

		expect(model.nodes.map((node) => node.scope)).toEqual(['in-scope', 'in-scope', 'in-scope']);
	});

	it('keeps an edge that leaves the group, and marks its target as spill', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('x', W)] }),
			agent('x', 'Xavier', { groupId: 'g2' }),
		]);

		expect(model.edges.map((edge) => edge.id)).toEqual(['a->x']);
		expect(model.nodes).toEqual([
			{ sessionId: 'a', name: 'Alice', groupId: 'g1', scope: 'in-scope' },
			{ sessionId: 'x', name: 'Xavier', groupId: 'g2', scope: 'spill' },
		]);
	});

	it('keeps an edge that reaches into the group from outside, pointing in', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1' }),
			agent('y', 'Yara', { groupId: 'g2', peerAgents: [row('a', W)] }),
		]);

		expect(model.edges).toEqual([
			{ id: 'y->a', sourceId: 'y', targetId: 'a', read: false, write: true, source: 'explicit' },
		]);
		expect(edgeBetween(model, 'a', 'y')).toBeUndefined();
		expect(model.nodes).toEqual([
			{ sessionId: 'a', name: 'Alice', groupId: 'g1', scope: 'in-scope' },
			{ sessionId: 'y', name: 'Yara', groupId: 'g2', scope: 'spill' },
		]);
	});

	it('drops an edge between two agents that are both outside the group, and gives neither a node', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1' }),
			agent('x', 'Xavier', { groupId: 'g2', peerAgents: [row('y', RW)] }),
			agent('y', 'Yara', { groupId: 'g2', peerAgents: [row('x', RW)] }),
		]);

		expect(model.edges).toEqual([]);
		expect(model.nodes.map((node) => node.sessionId)).toEqual(['a']);
	});

	it('treats a nested group as outside the scope: groups match on id only', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('n', R)] }),
			agent('n', 'Nested', { groupId: 'g1-child' }),
			agent('o', 'Other', { groupId: 'g1-child' }),
		]);

		expect(model.nodes).toEqual([
			{ sessionId: 'a', name: 'Alice', groupId: 'g1', scope: 'in-scope' },
			{ sessionId: 'n', name: 'Nested', groupId: 'g1-child', scope: 'spill' },
		]);
	});

	it('draws no edge for an exclusion row over a group grant', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', {
				groupId: 'g1',
				groupPeerAccess: RW,
				peerAgents: [row('b', NONE)],
			}),
			agent('b', 'Bob', { groupId: 'g1' }),
			agent('c', 'Carol', { groupId: 'g1' }),
		]);

		expect(edgeBetween(model, 'a', 'b')).toBeUndefined();
		expect(model.edges).toEqual([
			{ id: 'a->c', sourceId: 'a', targetId: 'c', read: true, write: true, source: 'group' },
		]);
		// Bob is excluded, not removed: he is still an agent of the group.
		expect(model.nodes.map((node) => node.sessionId)).toEqual(['a', 'b', 'c']);
	});

	it('gives an in-scope agent a node when no edge touches it', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('b', R)] }),
			agent('b', 'Bob', { groupId: 'g1' }),
			agent('i', 'Isolde', { groupId: 'g1' }),
		]);

		expect(model.nodes).toContainEqual({
			sessionId: 'i',
			name: 'Isolde',
			groupId: 'g1',
			scope: 'in-scope',
		});
		expect(model.edges.some((edge) => edge.sourceId === 'i' || edge.targetId === 'i')).toBe(false);
	});

	it('draws no node and no edge for a row that points at a deleted agent', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('gone', RW), row('b', R)] }),
			agent('b', 'Bob'),
		]);

		expect(model.edges.map((edge) => edge.id)).toEqual(['a->b']);
		expect(model.nodes.map((node) => node.sessionId)).toEqual(['a', 'b']);
	});

	it('returns an empty graph for a group with no agents', () => {
		const model = buildDelegationGraph({ kind: 'group', groupId: 'empty' }, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('b', R)] }),
			agent('b', 'Bob', { groupId: 'g1' }),
		]);

		expect(model).toEqual({ nodes: [], edges: [] });
	});

	it('gives the same order for the same input, in whatever order the agents arrive', () => {
		const sessions = [
			agent('c', 'Carol', { groupId: 'g1', peerAgents: [row('a', R), row('x', W)] }),
			agent('a2', 'Alice', { groupId: 'g1' }),
			agent('x', 'Xavier', { groupId: 'g2', peerAgents: [row('a', RW)] }),
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('c', RW)] }),
		];

		const first = buildDelegationGraph(G1, sessions);

		expect(buildDelegationGraph(G1, sessions)).toEqual(first);
		expect(buildDelegationGraph(G1, [...sessions].reverse())).toEqual(first);
		// Two agents share a name, so the id breaks the tie.
		expect(first.nodes.map((node) => node.sessionId)).toEqual(['a', 'a2', 'c', 'x']);
		expect(first.edges.map((edge) => edge.id)).toEqual(['a->c', 'c->a', 'c->x', 'x->a']);
	});
});

// What the canvas passes for an agent the user put on it by hand.
describe('buildDelegationGraph with placed agents', () => {
	// In g1: Alpha and Beta. Outside it: Carol, reached by an edge, and Dave and
	// Erin, reached by none.
	const fleet = [
		agent('a', 'Alpha', { groupId: 'g1', peerAgents: [row('c', R)] }),
		agent('b', 'Beta', { groupId: 'g1' }),
		agent('c', 'Carol', { groupId: 'g2' }),
		agent('d', 'Dave', { groupId: 'g2' }),
		agent('e', 'Erin'),
	];

	it('gives a placed agent outside the scope a spill node and no edge', () => {
		const base = buildDelegationGraph(G1, fleet);
		const model = buildDelegationGraph(G1, fleet, { placedIds: ['d'] });

		expect(base.nodes.map((node) => node.sessionId)).toEqual(['a', 'b', 'c']);
		expect(model.nodes).toEqual([
			{ sessionId: 'a', name: 'Alpha', groupId: 'g1', scope: 'in-scope' },
			{ sessionId: 'b', name: 'Beta', groupId: 'g1', scope: 'in-scope' },
			{ sessionId: 'c', name: 'Carol', groupId: 'g2', scope: 'spill' },
			{ sessionId: 'd', name: 'Dave', groupId: 'g2', scope: 'spill' },
		]);
		expect(model.edges).toEqual(base.edges);
	});

	// Placing is not moving: the node keeps the group the agent is really in.
	it('does not put a placed agent in the group', () => {
		const model = buildDelegationGraph(G1, fleet, { placedIds: ['d', 'e'] });

		expect(model.nodes.find((node) => node.sessionId === 'd')?.groupId).toBe('g2');
		expect(model.nodes.find((node) => node.sessionId === 'e')).toEqual({
			sessionId: 'e',
			name: 'Erin',
			scope: 'spill',
		});
	});

	it('changes nothing for an id that is already on the graph or names no agent', () => {
		const base = buildDelegationGraph(G1, fleet);

		expect(buildDelegationGraph(G1, fleet, { placedIds: ['a', 'c', 'gone'] })).toEqual(base);
		expect(buildDelegationGraph(ALL, fleet, { placedIds: ['d'] })).toEqual(
			buildDelegationGraph(ALL, fleet)
		);
	});

	it('takes any iterable of ids', () => {
		const model = buildDelegationGraph(G1, fleet, { placedIds: new Set(['e']) });

		expect(model.nodes.map((node) => node.sessionId)).toContain('e');
	});

	// "Placed and then connected becomes a spill node, as if authored in settings."
	it('draws a placed agent the same with and without the placement once an edge joins it', () => {
		const connected = fleet.map((session) =>
			session.id === 'b' ? { ...session, peerAgents: [row('d', W)] } : session
		);

		expect(buildDelegationGraph(G1, connected, { placedIds: ['d'] })).toEqual(
			buildDelegationGraph(G1, connected)
		);
	});
});

describe('agentsOffGraph', () => {
	const fleet = [
		agent('a', 'Alpha', { groupId: 'g1', peerAgents: [row('c', R)] }),
		agent('z', 'Zed', { groupId: 'g2' }),
		agent('c', 'Carol', { groupId: 'g2' }),
		agent('d', 'Dave'),
		agent('d2', 'Dave', { groupId: 'g3' }),
	];

	it('is empty on the graph of every agent', () => {
		expect(agentsOffGraph(buildDelegationGraph(ALL, fleet), fleet)).toEqual([]);
	});

	it('lists the agents a group graph does not draw, by name and then by id', () => {
		const model = buildDelegationGraph(G1, fleet);

		expect(agentsOffGraph(model, fleet)).toEqual([
			{ sessionId: 'd', name: 'Dave' },
			{ sessionId: 'd2', name: 'Dave', groupId: 'g3' },
			{ sessionId: 'z', name: 'Zed', groupId: 'g2' },
		]);
	});

	it('leaves out an agent once it is placed', () => {
		const model = buildDelegationGraph(G1, fleet, { placedIds: ['z'] });

		expect(agentsOffGraph(model, fleet).map((off) => off.sessionId)).toEqual(['d', 'd2']);
	});
});

describe('edgeBetween', () => {
	const model = buildDelegationGraph(ALL, [
		agent('a', 'Alice', { peerAgents: [row('b', RW)] }),
		agent('b', 'Bob'),
	]);

	it('returns the edge from the source to the target', () => {
		expect(edgeBetween(model, 'a', 'b')).toEqual({
			id: 'a->b',
			sourceId: 'a',
			targetId: 'b',
			read: true,
			write: true,
			source: 'explicit',
		});
	});

	it('is directional: the edge back is a different edge, and here there is none', () => {
		expect(edgeBetween(model, 'b', 'a')).toBeUndefined();
	});

	it('returns undefined for an agent the graph does not hold', () => {
		expect(edgeBetween(model, 'a', 'gone')).toBeUndefined();
		expect(edgeBetween(model, 'gone', 'b')).toBeUndefined();
	});
});

// What the canvas asks before it opens an editor on a dropped edge.
describe('delegationEdgeRefusal', () => {
	// In g1: Alpha and Beta. Outside it: Carol and Dave, each drawn only because
	// an edge reaches it.
	const fleet = [
		agent('a', 'Alpha', { groupId: 'g1', peerAgents: [row('c', R), row('d', R)] }),
		agent('b', 'Beta', { groupId: 'g1' }),
		agent('c', 'Carol'),
		agent('d', 'Dave', { groupId: 'g2' }),
	];

	it('refuses an agent as its own peer, on every scope', () => {
		for (const scope of [ALL, G1]) {
			const refusal = delegationEdgeRefusal(buildDelegationGraph(scope, fleet), 'a', 'a');

			expect(refusal).toContain(SELF_PEER_ERROR);
		}
	});

	it('allows any two different agents on the graph of every agent', () => {
		const model = buildDelegationGraph(ALL, fleet);

		expect(delegationEdgeRefusal(model, 'c', 'd')).toBeNull();
		expect(delegationEdgeRefusal(model, 'b', 'a')).toBeNull();
	});

	it('allows an edge with one end in the group, in either direction', () => {
		const model = buildDelegationGraph(G1, fleet);

		expect(delegationEdgeRefusal(model, 'b', 'c')).toBeNull();
		expect(delegationEdgeRefusal(model, 'c', 'b')).toBeNull();
		expect(delegationEdgeRefusal(model, 'a', 'b')).toBeNull();
	});

	// `buildDelegationGraph` drops an edge with both ends outside the scope, so
	// the row would be written and the edge would not appear.
	it('refuses an edge between two agents that are both outside the group', () => {
		const model = buildDelegationGraph(G1, fleet);

		expect(delegationEdgeRefusal(model, 'c', 'd')).toMatch(/outside this group/);
		expect(delegationEdgeRefusal(model, 'd', 'c')).toMatch(/outside this group/);
	});

	// A placed agent is outside the group too, with or without an edge.
	it('refuses an edge between a placed agent and another agent outside the group', () => {
		const withErin = [...fleet, agent('e', 'Erin')];
		const model = buildDelegationGraph(G1, withErin, { placedIds: ['e'] });

		expect(delegationEdgeRefusal(model, 'e', 'c')).toMatch(/outside this group/);
		expect(delegationEdgeRefusal(model, 'd', 'e')).toMatch(/outside this group/);
		expect(delegationEdgeRefusal(model, 'e', 'b')).toBeNull();
		expect(delegationEdgeRefusal(model, 'a', 'e')).toBeNull();
	});

	it('leaves an end that is not on the graph to the write, which names it', () => {
		const model = buildDelegationGraph(ALL, fleet);

		expect(delegationEdgeRefusal(model, 'a', 'gone')).toBeNull();
	});
});

describe('isMutual', () => {
	it('is true when an edge exists in each direction, whichever bits each carries', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', W)] }),
			agent('b', 'Bob', { peerAgents: [row('a', R)] }),
		]);

		expect(isMutual(model, 'a', 'b')).toBe(true);
		expect(isMutual(model, 'b', 'a')).toBe(true);
	});

	it('is false when only one direction exists', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', RW)] }),
			agent('b', 'Bob'),
		]);

		expect(isMutual(model, 'a', 'b')).toBe(false);
		expect(isMutual(model, 'b', 'a')).toBe(false);
	});

	it('is false for an agent and itself, and for an agent the graph does not hold', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', RW)] }),
			agent('b', 'Bob', { peerAgents: [row('a', RW)] }),
		]);

		expect(isMutual(model, 'a', 'a')).toBe(false);
		expect(isMutual(model, 'a', 'gone')).toBe(false);
	});
});

describe('connectedAgentIds', () => {
	it('is empty on a graph with no edges', () => {
		const model = buildDelegationGraph(ALL, [agent('a', 'Alice'), agent('b', 'Bob')]);

		expect(connectedAgentIds(model).size).toBe(0);
	});

	it('holds both ends of every edge and leaves out an agent no edge touches', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', R)] }),
			agent('b', 'Bob'),
			agent('c', 'Carol'),
		]);

		expect([...connectedAgentIds(model)].sort()).toEqual(['a', 'b']);
	});

	// A spill agent is on the graph only because an edge reaches it, so it is
	// always connected. The canvas relies on this: a node is spill OR isolated.
	it('always holds a spill agent', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('x', W)] }),
			agent('x', 'Xavier', { groupId: 'g2' }),
		]);
		const connected = connectedAgentIds(model);

		for (const node of model.nodes.filter((n) => n.scope === 'spill')) {
			expect(connected.has(node.sessionId)).toBe(true);
		}
		expect(connected.has('x')).toBe(true);
	});
});

describe('delegationGraphStats', () => {
	it('counts nothing on an empty graph', () => {
		const empty: DelegationGraphModel = { nodes: [], edges: [] };

		expect(delegationGraphStats(empty)).toEqual({
			agents: 0,
			edges: 0,
			mutual: 0,
			isolated: 0,
			spill: 0,
			placed: 0,
		});
	});

	it('counts a mutual pair once in `mutual` and twice in `edges`', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', RW), row('c', R)] }),
			agent('b', 'Bob', { peerAgents: [row('a', R)] }),
			agent('c', 'Carol'),
		]);

		expect(delegationGraphStats(model)).toEqual({
			agents: 3,
			edges: 3,
			mutual: 1,
			isolated: 0,
			spill: 0,
			placed: 0,
		});
	});

	it('counts an agent no edge touches as isolated', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', R)] }),
			agent('b', 'Bob'),
			agent('c', 'Carol'),
			agent('d', 'Dave'),
		]);

		expect(delegationGraphStats(model)).toMatchObject({ agents: 4, edges: 1, isolated: 2 });
	});

	it('counts spill agents inside `agents`, and never as isolated', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('x', W)] }),
			agent('b', 'Bob', { groupId: 'g1' }),
			agent('x', 'Xavier', { groupId: 'g2' }),
			agent('y', 'Yara', { groupId: 'g2', peerAgents: [row('a', R)] }),
			agent('z', 'Zed', { groupId: 'g2' }),
		]);

		expect(delegationGraphStats(model)).toEqual({
			agents: 4,
			edges: 2,
			mutual: 0,
			isolated: 1,
			spill: 2,
			placed: 0,
		});
	});

	// "Nobody reaches it" is a fact about the fleet. "Not connected yet" is a
	// fact about one canvas, and it is counted apart.
	it('counts a placed agent in `spill` and `placed`, and never as isolated', () => {
		const model = buildDelegationGraph(
			G1,
			[
				agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('x', W)] }),
				agent('b', 'Bob', { groupId: 'g1' }),
				agent('x', 'Xavier', { groupId: 'g2' }),
				agent('z', 'Zed', { groupId: 'g2' }),
			],
			{ placedIds: ['z'] }
		);

		expect(delegationGraphStats(model)).toEqual({
			agents: 4,
			edges: 1,
			mutual: 0,
			isolated: 1,
			spill: 2,
			placed: 1,
		});
	});
});

// The legend on the canvas and `maestro-cli delegation graph` print these lines.
describe('describeDelegationGraphStats', () => {
	const STATS: DelegationGraphStats = {
		agents: 6,
		edges: 4,
		mutual: 1,
		isolated: 2,
		spill: 1,
		placed: 0,
	};

	it('says how many agents and edges, then what stands out', () => {
		expect(describeDelegationGraphStats(STATS)).toEqual([
			'6 agents, 4 edges',
			'1 mutual pair',
			'2 with no peers',
			'1 outside this scope',
		]);
	});

	it('leaves out a count that is zero', () => {
		expect(
			describeDelegationGraphStats({
				agents: 1,
				edges: 1,
				mutual: 0,
				isolated: 0,
				spill: 0,
				placed: 0,
			})
		).toEqual(['1 agent, 1 edge']);
	});

	it('counts the agents that were added and have no edge, after the ones outside the scope', () => {
		expect(describeDelegationGraphStats({ ...STATS, spill: 3, placed: 2 })).toEqual([
			'6 agents, 4 edges',
			'1 mutual pair',
			'2 with no peers',
			'3 outside this scope',
			'2 added, no edge yet',
		]);
	});

	it('uses the plural for more than one mutual pair', () => {
		expect(describeDelegationGraphStats({ ...STATS, mutual: 3 })).toContain('3 mutual pairs');
	});
});

describe('delegationAdjacency', () => {
	const names = (links: { peer: { name: string } }[]) => links.map((link) => link.peer.name);

	it('lists nothing for an empty graph', () => {
		expect(delegationAdjacency({ nodes: [], edges: [] })).toEqual([]);
	});

	it('gives every node an entry, in the order of the model, with or without an edge', () => {
		const model = buildDelegationGraph(ALL, [
			agent('c', 'Carol'),
			agent('a', 'Alice', { peerAgents: [row('b', R)] }),
			agent('b', 'Bob'),
		]);

		const listing = delegationAdjacency(model);

		expect(listing.map((entry) => entry.node.name)).toEqual(['Alice', 'Bob', 'Carol']);
		expect(listing[2]).toMatchObject({ reaches: [], reachedBy: [] });
	});

	it('puts an edge in `reaches` of its source and in `reachedBy` of its target, once each', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [{ ...row('b', RW), description: 'Reviews' }] }),
			agent('b', 'Bob'),
		]);

		const [alice, bob] = delegationAdjacency(model);

		expect(alice.reaches).toHaveLength(1);
		expect(alice.reaches[0]).toMatchObject({
			edge: { id: 'a->b', read: true, write: true, description: 'Reviews', source: 'explicit' },
			peer: { sessionId: 'b', name: 'Bob' },
			mutual: false,
		});
		expect(alice.reachedBy).toEqual([]);
		expect(bob.reaches).toEqual([]);
		expect(bob.reachedBy).toHaveLength(1);
		expect(bob.reachedBy[0]).toMatchObject({ edge: { id: 'a->b' }, peer: { sessionId: 'a' } });
	});

	// The manager delegates down and the employee only consults up: two edges,
	// each with its own bits, and each marked as half of a pair.
	it('marks both edges of a pair as mutual and keeps the bits of each', () => {
		const model = buildDelegationGraph(ALL, [
			agent('m', 'Manager', { peerAgents: [row('e', RW)] }),
			agent('e', 'Employee', { peerAgents: [row('m', R)] }),
		]);

		const [employee, manager] = delegationAdjacency(model);

		expect(manager.reaches[0]).toMatchObject({ edge: { write: true }, mutual: true });
		expect(employee.reaches[0]).toMatchObject({ edge: { read: true, write: false }, mutual: true });
		expect(manager.reachedBy[0]).toMatchObject({ peer: { sessionId: 'e' }, mutual: true });
	});

	it('orders the links of one agent by the peer, the way the nodes are ordered', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('z', R), row('b', R), row('c', R)] }),
			agent('z', 'Zed', { peerAgents: [row('c', R)] }),
			agent('c', 'Carol'),
			agent('b', 'Bob', { peerAgents: [row('c', R)] }),
		]);

		const listing = delegationAdjacency(model);

		expect(names(listing[0].reaches)).toEqual(['Bob', 'Carol', 'Zed']);
		expect(names(listing[2].reachedBy)).toEqual(['Alice', 'Bob', 'Zed']);
	});

	it('names the grant that derived an edge', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { groupId: 'g1', groupPeerAccess: R }),
			agent('b', 'Bob', { groupId: 'g1' }),
		]);

		expect(delegationAdjacency(model)[0].reaches[0].edge.source).toBe('group');
	});

	// The model of a group keeps an edge only when one end is in the group.
	it('lists for a spill agent only the edges that join it to the group', () => {
		const model = buildDelegationGraph(G1, [
			agent('a', 'Alice', { groupId: 'g1', peerAgents: [row('x', W)] }),
			agent('x', 'Xavier', { groupId: 'g2', peerAgents: [row('y', R)] }),
			agent('y', 'Yara', { groupId: 'g2' }),
		]);

		const listing = delegationAdjacency(model);

		expect(listing.map((entry) => entry.node.name)).toEqual(['Alice', 'Xavier']);
		expect(listing[1].node.scope).toBe('spill');
		expect(listing[1].reaches).toEqual([]);
		expect(names(listing[1].reachedBy)).toEqual(['Alice']);
	});

	it('leaves out an edge whose end has no node, and does not throw', () => {
		const model: DelegationGraphModel = {
			nodes: [{ sessionId: 'a', name: 'Alice', scope: 'in-scope' }],
			edges: [
				{
					id: 'a->gone',
					sourceId: 'a',
					targetId: 'gone',
					read: true,
					write: false,
					source: 'explicit',
				},
			],
		};

		expect(delegationAdjacency(model)).toEqual([
			{ node: model.nodes[0], reaches: [], reachedBy: [] },
		]);
	});

	it('does not change the model', () => {
		const model = buildDelegationGraph(ALL, [
			agent('a', 'Alice', { peerAgents: [row('b', R)] }),
			agent('b', 'Bob', { peerAgents: [row('a', R)] }),
		]);
		const before = JSON.stringify(model);

		delegationAdjacency(model);

		expect(JSON.stringify(model)).toBe(before);
	});
});
