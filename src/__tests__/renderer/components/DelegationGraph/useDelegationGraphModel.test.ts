/**
 * Tests for useDelegationGraphModel - the graph of one scope from the live
 * agent list.
 *
 * `buildDelegationGraph` itself is covered in `shared/delegationGraph.test.ts`.
 * These cases cover what the hook adds: WHEN the model is rebuilt. The session
 * store replaces its array on every batch of streamed output, and the graph
 * must not be rebuilt for that.
 *
 * `useAgentsOffDelegationGraph` is the list the canvas offers to add: the
 * agents a model has no node for.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
	useAgentsOffDelegationGraph,
	useDelegationGraphModel,
} from '../../../../renderer/components/DelegationGraph/useDelegationGraphModel';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { Session } from '../../../../renderer/types';
import type { DelegationGraphScope } from '../../../../shared/delegationGraph';
import { createMockSession } from '../../../helpers/mockSession';

const ALL: DelegationGraphScope = { kind: 'all' };
/** Stable lists: the hook rebuilds the model when the array it is handed changes. */
const NOTHING_PLACED: readonly string[] = [];
const PLACED_GAMMA: readonly string[] = ['c'];

function patchSession(id: string, patch: Partial<Session>): void {
	act(() => {
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((session) =>
				session.id === id ? { ...session, ...patch } : session
			),
		}));
	});
}

describe('useDelegationGraphModel', () => {
	beforeEach(() => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'a',
					name: 'Alpha',
					groupId: 'g-1',
					peerAgents: [{ sessionId: 'b', read: true, write: false }],
				}),
				createMockSession({ id: 'b', name: 'Beta', groupId: 'g-2' }),
				createMockSession({ id: 'c', name: 'Gamma', groupId: 'g-2' }),
			],
		});
	});

	it('builds the graph of every agent for the all scope', () => {
		const { result } = renderHook(() => useDelegationGraphModel(ALL));

		expect(result.current.nodes.map((node) => node.sessionId)).toEqual(['a', 'b', 'c']);
		expect(result.current.edges.map((edge) => edge.id)).toEqual(['a->b']);
	});

	it('switches between agent clusters and all agents without confusing their memo keys', () => {
		const { result, rerender } = renderHook(
			({ scope }: { scope: DelegationGraphScope }) => useDelegationGraphModel(scope),
			{ initialProps: { scope: { kind: 'agent', sessionId: 'b' } } }
		);
		expect(result.current.nodes.map((node) => node.sessionId)).toEqual(['a', 'b']);
		rerender({ scope: { kind: 'agent', sessionId: 'c' } });
		expect(result.current.nodes.map((node) => node.sessionId)).toEqual(['c']);
		rerender({ scope: ALL });
		expect(result.current.nodes.map((node) => node.sessionId)).toEqual(['a', 'b', 'c']);
	});

	it('builds the graph of one group, with the agents its edges reach', () => {
		const { result } = renderHook(() => useDelegationGraphModel({ kind: 'group', groupId: 'g-1' }));

		expect(result.current.nodes).toEqual([
			{ sessionId: 'a', name: 'Alpha', groupId: 'g-1', scope: 'in-scope' },
			{ sessionId: 'b', name: 'Beta', groupId: 'g-2', scope: 'spill' },
		]);
	});

	// A busy fleet replaces every session object several times a second.
	it('keeps the same model when a field the graph does not read changes', () => {
		const { result } = renderHook(() => useDelegationGraphModel(ALL));
		const before = result.current;

		patchSession('a', { state: 'busy' });
		patchSession('b', { contextUsage: 42 });

		expect(result.current).toBe(before);
	});

	it('keeps the same model when the caller passes a new scope object for the same scope', () => {
		const { result, rerender } = renderHook(() =>
			useDelegationGraphModel({ kind: 'group', groupId: 'g-2' })
		);
		const before = result.current;

		rerender();

		expect(result.current).toBe(before);
	});

	it('rebuilds on a rename', () => {
		const { result } = renderHook(() => useDelegationGraphModel(ALL));

		patchSession('b', { name: 'Zeta' });

		expect(result.current.nodes.map((node) => node.name)).toEqual(['Alpha', 'Gamma', 'Zeta']);
	});

	it('rebuilds when a peer field is edited', () => {
		const { result } = renderHook(() => useDelegationGraphModel(ALL));

		patchSession('c', { peerAgents: [{ sessionId: 'a', read: false, write: true }] });

		expect(result.current.edges.map((edge) => edge.id)).toEqual(['a->b', 'c->a']);
	});

	it('rebuilds when an agent changes group', () => {
		const { result } = renderHook(() => useDelegationGraphModel({ kind: 'group', groupId: 'g-2' }));
		// Alpha is outside the group and is drawn because its edge reaches Beta.
		expect(result.current.nodes.map((node) => node.sessionId)).toEqual(['a', 'b', 'c']);

		patchSession('c', { groupId: 'g-1' });

		expect(result.current.nodes.find((node) => node.sessionId === 'c')).toBeUndefined();
	});

	it('rebuilds when an agent is added or removed', () => {
		const { result } = renderHook(() => useDelegationGraphModel(ALL));

		act(() => {
			useSessionStore.setState((state) => ({
				sessions: state.sessions.filter((session) => session.id !== 'b'),
			}));
		});

		// The edge to the agent that is gone goes with it.
		expect(result.current.nodes.map((node) => node.sessionId)).toEqual(['a', 'c']);
		expect(result.current.edges).toEqual([]);
	});

	it('changes model when the scope changes', () => {
		const { result, rerender } = renderHook(
			({ scope }: { scope: DelegationGraphScope }) => useDelegationGraphModel(scope),
			// Widened: `ALL` alone narrows the hook's props to the one kind.
			{ initialProps: { scope: ALL as DelegationGraphScope } }
		);
		expect(result.current.nodes).toHaveLength(3);

		rerender({ scope: { kind: 'group', groupId: 'g-1' } });

		expect(result.current.nodes).toHaveLength(2);
	});

	describe('placed agents', () => {
		const G1: DelegationGraphScope = { kind: 'group', groupId: 'g-1' };

		it('draws an agent the caller placed, outside the scope and with no edge', () => {
			const { result } = renderHook(() => useDelegationGraphModel(G1, PLACED_GAMMA));

			expect(result.current.nodes).toEqual([
				{ sessionId: 'a', name: 'Alpha', groupId: 'g-1', scope: 'in-scope' },
				{ sessionId: 'b', name: 'Beta', groupId: 'g-2', scope: 'spill' },
				{ sessionId: 'c', name: 'Gamma', groupId: 'g-2', scope: 'spill' },
			]);
			expect(result.current.edges.map((edge) => edge.id)).toEqual(['a->b']);
		});

		it('keeps the same model while the caller passes the same placed list', () => {
			const { result, rerender } = renderHook(() => useDelegationGraphModel(G1, PLACED_GAMMA));
			const before = result.current;

			rerender();

			expect(result.current).toBe(before);
		});

		it('rebuilds when the placed list changes', () => {
			const { result, rerender } = renderHook(
				({ placed }: { placed: readonly string[] }) => useDelegationGraphModel(G1, placed),
				{ initialProps: { placed: NOTHING_PLACED } }
			);
			expect(result.current.nodes.map((node) => node.sessionId)).toEqual(['a', 'b']);

			rerender({ placed: PLACED_GAMMA });

			expect(result.current.nodes.map((node) => node.sessionId)).toEqual(['a', 'b', 'c']);
		});
	});
});

describe('useAgentsOffDelegationGraph', () => {
	beforeEach(() => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'a',
					name: 'Alpha',
					groupId: 'g-1',
					peerAgents: [{ sessionId: 'b', read: true, write: false }],
				}),
				createMockSession({ id: 'b', name: 'Beta', groupId: 'g-2' }),
				createMockSession({ id: 'c', name: 'Gamma', groupId: 'g-2' }),
				createMockSession({ id: 'd', name: 'Delta' }),
			],
		});
	});

	function renderOffGraph(scope: DelegationGraphScope, placed: readonly string[] = NOTHING_PLACED) {
		return renderHook(() => useAgentsOffDelegationGraph(useDelegationGraphModel(scope, placed)));
	}

	it('is empty on the graph of every agent', () => {
		expect(renderOffGraph(ALL).result.current).toEqual([]);
	});

	it('lists the agents a group graph does not draw, by name', () => {
		const { result } = renderOffGraph({ kind: 'group', groupId: 'g-1' });

		expect(result.current).toEqual([
			{ sessionId: 'd', name: 'Delta' },
			{ sessionId: 'c', name: 'Gamma', groupId: 'g-2' },
		]);
	});

	it('drops an agent from the list once it is placed', () => {
		const { result } = renderOffGraph({ kind: 'group', groupId: 'g-1' }, PLACED_GAMMA);

		expect(result.current.map((agent) => agent.sessionId)).toEqual(['d']);
	});

	it('keeps the same list when a field the graph does not read changes', () => {
		const { result } = renderOffGraph({ kind: 'group', groupId: 'g-1' });
		const before = result.current;

		patchSession('d', { state: 'busy' });

		expect(result.current).toBe(before);
	});

	it('follows a rename and a new agent', () => {
		const { result } = renderOffGraph({ kind: 'group', groupId: 'g-1' });

		patchSession('d', { name: 'Zulu' });
		act(() => {
			useSessionStore.setState((state) => ({
				sessions: [...state.sessions, createMockSession({ id: 'e', name: 'Echo' })],
			}));
		});

		expect(result.current.map((agent) => agent.name)).toEqual(['Echo', 'Gamma', 'Zulu']);
	});
});
