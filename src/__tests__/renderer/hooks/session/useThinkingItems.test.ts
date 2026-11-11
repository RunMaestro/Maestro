/**
 * Tests for useThinkingItems: the Thinking pill's list is the local agents' busy tabs, then the
 * busy tabs of every connected Federation peer, which carry `mirror`.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useThinkingItems } from '../../../../renderer/hooks/session/useThinkingItems';
import { usePeerMirrorStore } from '../../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../../shared/maestro-lib/client/peer-mirror';
import { resetStores } from '../../../helpers';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';

function hydrateBusyPeer() {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[
			{
				id: 'a1',
				name: 'Builder',
				toolType: 'claude-code',
				aiTabs: [{ id: 'ht1', state: 'busy' }],
			},
		],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

describe('useThinkingItems', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
	});

	it('lists only local items while no peer is mirrored', () => {
		const session = createMockSession({
			id: 'local-1',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [createMockAITab({ id: 't1', state: 'busy' })],
		});
		useSessionStore.setState({ sessions: [session] });
		const { result } = renderHook(() => useThinkingItems());
		expect(result.current.map((item) => item.session.id)).toEqual(['local-1']);
		expect(result.current[0].mirror).toBeUndefined();
	});

	it('appends the mirrored busy tabs after the local ones', () => {
		const session = createMockSession({
			id: 'local-1',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [createMockAITab({ id: 't1', state: 'busy' })],
		});
		useSessionStore.setState({ sessions: [session] });
		hydrateBusyPeer();
		const { result } = renderHook(() => useThinkingItems());
		expect(result.current.map((item) => item.session.id)).toEqual(['local-1', 'box:a1']);
		expect(result.current[1].mirror).toEqual({ peerId: 'box', agentId: 'a1' });
	});

	it('does not scope mirrored items by window ownership', () => {
		hydrateBusyPeer();
		const { result } = renderHook(() => useThinkingItems(() => false));
		expect(result.current.map((item) => item.session.id)).toEqual(['box:a1']);
	});

	it('picks up a mirrored tab that goes busy', () => {
		const { result } = renderHook(() => useThinkingItems());
		expect(result.current).toEqual([]);
		act(() => hydrateBusyPeer());
		expect(result.current.map((item) => item.tab?.id)).toEqual(['ht1']);
	});
});
