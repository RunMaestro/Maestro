/**
 * Tests for useThinkingItems: the Thinking pill lists every agent's busy tabs. A hosted agent is
 * listed through its own Left Bar record (kept in step with its host by `startHostedAgentSync()`),
 * never a second time from the peer mirror.
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

/** The Left Bar row that shows host agent box:a1 (idle locally: its turns run on the host). */
const hostedRow = () =>
	createMockSession({ id: 'row-a1', liftedTo: { peer: 'box', agentId: 'a1', at: 1 } });

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

	it("lists a hosted agent once, from its own record, never again from the host's mirror", () => {
		const row = createMockSession({
			id: 'row-a1',
			liftedTo: { peer: 'box', agentId: 'a1', at: 1 },
			state: 'busy',
			busySource: 'ai',
			aiTabs: [createMockAITab({ id: 'ht1', state: 'busy' })],
		});
		useSessionStore.setState({ sessions: [row] });
		hydrateBusyPeer();
		const { result } = renderHook(() => useThinkingItems());
		expect(result.current.map((item) => item.session.id)).toEqual(['row-a1']);
		expect(result.current[0].mirror).toBeUndefined();
	});

	it("never lists a host's busy agent on its own", () => {
		hydrateBusyPeer();
		const { result } = renderHook(() => useThinkingItems());
		expect(result.current).toEqual([]);
		act(() => useSessionStore.setState({ sessions: [hostedRow()] }));
		// The row is idle until the host sync marks its tab busy.
		expect(result.current).toEqual([]);
	});
});
