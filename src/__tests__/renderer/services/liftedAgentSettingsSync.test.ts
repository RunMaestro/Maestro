/**
 * Tests for services/liftedAgentSettingsSync, the driver of the Federation settings sync: a
 * setting changed on a lifted agent's pointer reaches its host, a host change comes back onto the
 * pointer, a refusal brings the host's value back with a toast, and a peer that is down is left
 * alone until it is back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NotificationStoreModule from '../../../renderer/stores/notificationStore';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => {
	const actual = await importOriginal<typeof NotificationStoreModule>();
	return { ...actual, notifyToast: vi.fn(() => 'toast-1') };
});

import { startLiftedAgentSettingsSync } from '../../../renderer/services/liftedAgentSettingsSync';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	createMirroredPeer,
	replacePeerAgents,
	type PeerMirrorConnection,
} from '../../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import { createMockAITab, createMockSession, resetStores } from '../../helpers';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();

function hostAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: 'host-1',
		name: 'Docs',
		toolType: 'claude-code',
		cwd: '/home/me/docs',
		nudgeMessage: 'old nudge',
		aiTabs: [{ id: 'tab-1' }],
		...overrides,
	};
}

function showPeer(agent: AgentRecord, connection: PeerMirrorConnection = 'connected') {
	const peer = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r-box', name: 'box' }),
		[agent],
		[],
		1
	).peer;
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection }]);
}

function showPointer(overrides: Parameters<typeof createMockSession>[0] = {}) {
	useSessionStore.setState({
		sessionsReadOk: true,
		sessions: [
			createMockSession({
				id: 'local-1',
				name: 'Docs',
				toolType: 'claude-code',
				cwd: '/home/me/docs',
				nudgeMessage: 'old nudge',
				aiTabs: [createMockAITab({ id: 'tab-1', name: null })],
				liftedTo: { peer: 'box', agentId: 'host-1', at: 1 },
				...overrides,
			}),
		],
	});
}

function pointer() {
	return useSessionStore.getState().sessions[0];
}

/** Let the coalescing timer fire and every host call it starts finish. */
async function pass() {
	await vi.advanceTimersByTimeAsync(300);
}

describe('services/liftedAgentSettingsSync', () => {
	let stop: (() => void) | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		resetStores(usePeerMirrorStore, useSessionStore);
		localStorage.clear();
		act$.mockReset();
		act$.mockResolvedValue({ ok: true, result: { kind: 'update-agent', applied: [] } });
		maestro.federation = { act: act$ };
		vi.mocked(notifyToast).mockClear();
	});

	afterEach(() => {
		stop?.();
		stop = undefined;
		delete maestro.federation;
		vi.useRealTimers();
	});

	it('sends a setting changed on the pointer to the host agent', async () => {
		showPeer(hostAgent());
		showPointer({ nudgeMessage: 'new nudge' });
		stop = startLiftedAgentSettingsSync();
		await pass();
		expect(act$).toHaveBeenCalledWith('box', 'host-1', {
			kind: 'update-agent',
			patch: { nudgeMessage: 'new nudge' },
		});
		expect(notifyToast).not.toHaveBeenCalled();
		// The agreed state is kept, so a restart does not read the host's old value as its change.
		expect(localStorage.getItem('maestro:federation:lifted-settings-baseline:v1')).toContain(
			'new nudge'
		);
	});

	it('writes a change the host reports onto the pointer', async () => {
		showPeer(hostAgent());
		showPointer();
		stop = startLiftedAgentSettingsSync();
		await pass();
		expect(act$).not.toHaveBeenCalled();
		showPeer(hostAgent({ nudgeMessage: 'set on the host', customModel: 'opus' }));
		await pass();
		expect(pointer().nudgeMessage).toBe('set on the host');
		expect(pointer().customModel).toBe('opus');
		expect(act$).not.toHaveBeenCalled();
	});

	it('brings the host value back, with a toast, when the host refuses', async () => {
		act$.mockResolvedValue({ ok: false, error: 'Peer "box": bad value', code: 'invalid' });
		showPeer(hostAgent());
		showPointer({ nudgeMessage: 'refused nudge' });
		stop = startLiftedAgentSettingsSync();
		await pass();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', title: 'Docs: host kept its settings' })
		);
		await pass();
		expect(pointer().nudgeMessage).toBe('old nudge');
		expect(act$).toHaveBeenCalledTimes(1);
	});

	it('keeps a change for later when the peer is down, and sends it once it is back', async () => {
		showPeer(hostAgent(), 'reconnecting');
		showPointer({ nudgeMessage: 'while away' });
		stop = startLiftedAgentSettingsSync();
		await pass();
		expect(act$).not.toHaveBeenCalled();
		showPeer(hostAgent());
		await pass();
		expect(act$).toHaveBeenCalledWith('box', 'host-1', {
			kind: 'update-agent',
			patch: { nudgeMessage: 'while away' },
		});
	});

	it('sends again after a call the peer could not take', async () => {
		act$.mockResolvedValueOnce({ ok: false, error: 'Not connected', code: 'host-unavailable' });
		showPeer(hostAgent());
		showPointer({ nudgeMessage: 'retry me' });
		stop = startLiftedAgentSettingsSync();
		await pass();
		expect(notifyToast).not.toHaveBeenCalled();
		expect(pointer().nudgeMessage).toBe('retry me');
		// The mirror's next change (the peer coming back) runs the sync again.
		showPeer(hostAgent());
		await pass();
		expect(act$).toHaveBeenCalledTimes(2);
	});

	it('leaves agents that were never lifted alone', async () => {
		showPeer(hostAgent());
		showPointer({ liftedTo: undefined, nudgeMessage: 'local only' });
		stop = startLiftedAgentSettingsSync();
		await pass();
		expect(act$).not.toHaveBeenCalled();
	});
});
