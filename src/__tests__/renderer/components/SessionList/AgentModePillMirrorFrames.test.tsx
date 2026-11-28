/**
 * L36: the frames of a hosted turn must not draw the mode pills again. The mirror replaces its
 * peer on every turn frame (the live turn lives in it); a pill that subscribed to the whole peer
 * map committed once per frame in every mode that names a peer, which in the running app was most
 * of the 40 to 50% more React commits a hosted turn made than a local or an SSH one. A pill
 * commits again only when what it draws changes (the host's connection).
 */

import { Profiler } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	createMirroredPeer,
	replacePeerAgents,
	type MirrorPush,
} from '../../../../shared/maestro-lib/client/peer-mirror';
import { AgentModePill } from '../../../../renderer/components/SessionList/AgentModePill';
import { usePeerMirrorStore } from '../../../../renderer/stores/peerMirrorStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { AGENT_MODES, createModeSession, resetStores } from '../../../helpers';
import { mockTheme } from '../../../helpers/mockTheme';

const TURN_FRAMES = 10;

function hydrateBox(): void {
	const peer = replacePeerAgents(
		{
			...createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'box' }),
			connection: 'connected',
		},
		[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [{ id: 't1' }] }],
		[],
		500
	).peer;
	usePeerMirrorStore.getState().hydrate([peer]);
}

const apply = (event: MirrorPush['event']) =>
	act(() => {
		usePeerMirrorStore.getState().applyPush({ peerId: 'box', event });
	});

describe('AgentModePill across the frames of a hosted turn (L36)', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore);
		useSettingsStore.setState({ federationHostedAgents: true });
		hydrateBox();
	});

	it.each(AGENT_MODES)(
		'%s: commits no time while the host streams a turn, and once when the connection changes',
		async (mode) => {
			let commits = 0;
			const session = createModeSession(mode, { id: `pill-${mode}` });
			render(
				<Profiler id="pill" onRender={() => commits++}>
					<AgentModePill theme={mockTheme} session={session} />
				</Profiler>
			);
			await act(async () => {});
			commits = 0;

			for (let i = 0; i < TURN_FRAMES; i++) {
				apply({
					type: 'turn',
					agentId: 'h1',
					tabId: 't1',
					event: { kind: 'text', at: i + 1, text: `chunk ${i}` },
				});
			}
			expect(usePeerMirrorStore.getState().peers.box.liveTurns).not.toEqual({});
			expect(commits).toBe(0);

			apply({
				type: 'peer.state',
				peer: { peerId: 'box', remoteId: 'r1', name: 'box', connection: 'host-down' },
			} as MirrorPush['event']);
			// A local pill names no peer; an SSH and a hosted one draw the host's connection.
			expect(commits).toBe(mode === 'local' ? 0 : 1);
		}
	);
});
