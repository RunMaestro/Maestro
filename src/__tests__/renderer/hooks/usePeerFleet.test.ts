/**
 * Tests for usePeerFleet
 *
 * The hook is the one read of the fleet behind every Peer Agents editor: the
 * agents its picker offers and the name of the group its count describes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePeerFleet } from '../../../renderer/hooks/agent/usePeerFleet';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Group } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';

const backend: Group = { id: 'group-backend', name: 'Backend', emoji: '', collapsed: false };

describe('usePeerFleet', () => {
	beforeEach(() => {
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'agent-a', name: 'Alpha', groupId: backend.id }),
				createMockSession({ id: 'agent-b', name: 'Beta' }),
			],
			groups: [backend],
		});
	});

	it('returns every agent, cut down to id, name and group', () => {
		const { result } = renderHook(() => usePeerFleet(undefined));

		expect(result.current.availableAgents).toEqual([
			{ id: 'agent-a', name: 'Alpha', groupId: backend.id },
			{ id: 'agent-b', name: 'Beta', groupId: undefined },
		]);
		// Only the three fields: a section that reads no store must not be handed
		// a whole agent record.
		expect(Object.keys(result.current.availableAgents[0]).sort()).toEqual([
			'groupId',
			'id',
			'name',
		]);
	});

	it('names the group it is given', () => {
		const { result } = renderHook(() => usePeerFleet(backend.id));

		expect(result.current.groupName).toBe('Backend');
	});

	it('names no group with no group id, or a group that is gone', () => {
		expect(renderHook(() => usePeerFleet(undefined)).result.current.groupName).toBeUndefined();
		expect(renderHook(() => usePeerFleet('group-gone')).result.current.groupName).toBeUndefined();
	});

	it('follows the group as the caller changes it', () => {
		const { result, rerender } = renderHook(({ groupId }) => usePeerFleet(groupId), {
			initialProps: { groupId: undefined as string | undefined },
		});
		expect(result.current.groupName).toBeUndefined();

		rerender({ groupId: backend.id });

		expect(result.current.groupName).toBe('Backend');
	});

	it('keeps the same fleet array until the agents change', () => {
		const { result, rerender } = renderHook(() => usePeerFleet(undefined));
		const first = result.current.availableAgents;

		rerender();
		expect(result.current.availableAgents).toBe(first);

		act(() => {
			useSessionStore.setState((state) => ({
				sessions: [...state.sessions, createMockSession({ id: 'agent-c', name: 'Gamma' })],
			}));
		});

		expect(result.current.availableAgents.map((agent) => agent.id)).toEqual([
			'agent-a',
			'agent-b',
			'agent-c',
		]);
	});
});
