/**
 * Tests for services/liftedAgentSettingsSync, the driver of the Federation settings sync: a change
 * made on a lifted agent's pointer or in a mirrored agent's editor reaches its host, a host change
 * comes back onto the pointer, a field both sides changed waits for the person, a refusal brings
 * the host's value back with a toast, and a peer that is down is left alone until it is back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NotificationStoreModule from '../../../renderer/stores/notificationStore';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => {
	const actual = await importOriginal<typeof NotificationStoreModule>();
	return { ...actual, notifyToast: vi.fn(() => 'toast-1') };
});

import {
	answerHostedSettingsRequest,
	hostedFieldState,
	startLiftedAgentSettingsSync,
} from '../../../renderer/services/liftedAgentSettingsSync';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useHostedAgentSettingsStore } from '../../../renderer/stores/hostedAgentSettingsStore';
import {
	createMirroredPeer,
	replacePeerAgents,
	type PeerMirrorConnection,
} from '../../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import { createMockAITab, createMockSession, resetStores } from '../../helpers';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();
const KEY = 'box:host-1';

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

function editPointer(patch: Parameters<typeof createMockSession>[0]) {
	// Edits the pointer (always first) and keeps every other agent in the store.
	const [session, ...rest] = useSessionStore.getState().sessions;
	useSessionStore.setState({ sessions: [{ ...session, ...patch }, ...rest] });
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
		useHostedAgentSettingsStore.setState({
			pending: {},
			conflicts: {},
			resolutions: {},
			conflictsOpen: false,
		});
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

	describe('the lifted pointer', () => {
		it('sends a setting changed on the pointer after the two were in step', async () => {
			showPeer(hostAgent());
			showPointer();
			stop = startLiftedAgentSettingsSync();
			await pass();
			expect(act$).not.toHaveBeenCalled();
			editPointer({ nudgeMessage: 'new nudge' });
			await pass();
			expect(act$).toHaveBeenCalledWith('box', 'host-1', {
				kind: 'update-agent',
				patch: { nudgeMessage: 'new nudge' },
			});
			expect(notifyToast).not.toHaveBeenCalled();
			expect(localStorage.getItem('maestro:federation:lifted-settings-baseline:v1')).toContain(
				'new nudge'
			);
		});

		it('writes a change another conductor made on the host onto the pointer', async () => {
			showPeer(hostAgent());
			showPointer();
			stop = startLiftedAgentSettingsSync();
			await pass();
			showPeer(hostAgent({ nudgeMessage: 'set on the host', customModel: 'opus' }));
			await pass();
			expect(pointer().nudgeMessage).toBe('set on the host');
			expect(pointer().customModel).toBe('opus');
			expect(act$).not.toHaveBeenCalled();
		});

		it('asks about a difference on the first sync, and sends it once the person keeps theirs', async () => {
			showPeer(hostAgent());
			showPointer({ nudgeMessage: 'stale local edit' });
			stop = startLiftedAgentSettingsSync();
			await pass();
			expect(act$).not.toHaveBeenCalled();
			expect(pointer().nudgeMessage).toBe('stale local edit');
			expect(useHostedAgentSettingsStore.getState().conflicts[KEY]?.conflicts).toEqual([
				expect.objectContaining({ id: 'nudgeMessage', host: 'old nudge', firstSync: true }),
			]);
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ color: 'yellow', title: 'Docs: settings differ from box' })
			);
			useHostedAgentSettingsStore.getState().resolve(KEY, 'nudgeMessage', { take: 'local' });
			await pass();
			expect(act$).toHaveBeenCalledWith('box', 'host-1', {
				kind: 'update-agent',
				patch: { nudgeMessage: 'stale local edit' },
			});
			expect(useHostedAgentSettingsStore.getState().resolutions[KEY]).toBeUndefined();
		});

		it('takes the host value onto the pointer when the person picks it', async () => {
			showPeer(hostAgent());
			showPointer({ nudgeMessage: 'stale local edit' });
			stop = startLiftedAgentSettingsSync();
			await pass();
			useHostedAgentSettingsStore.getState().resolve(KEY, 'nudgeMessage', { take: 'host' });
			await pass();
			expect(pointer().nudgeMessage).toBe('old nudge');
			expect(act$).not.toHaveBeenCalled();
			await pass();
			expect(useHostedAgentSettingsStore.getState().conflicts[KEY]).toBeUndefined();
		});

		it('brings the host value back, with a toast, when the host refuses', async () => {
			act$.mockResolvedValue({ ok: false, error: 'Peer "box": bad value', code: 'invalid' });
			showPeer(hostAgent());
			showPointer();
			stop = startLiftedAgentSettingsSync();
			await pass();
			editPointer({ nudgeMessage: 'refused nudge' });
			await pass();
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ color: 'red', title: 'Docs: host kept its settings' })
			);
			await pass();
			expect(pointer().nudgeMessage).toBe('old nudge');
			expect(act$).toHaveBeenCalledTimes(1);
		});

		it('holds a change made while the peer is down, and sends it once it is back', async () => {
			showPeer(hostAgent());
			showPointer();
			stop = startLiftedAgentSettingsSync();
			await pass();
			showPeer(hostAgent(), 'reconnecting');
			editPointer({ nudgeMessage: 'while away' });
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
			showPointer();
			stop = startLiftedAgentSettingsSync();
			await pass();
			editPointer({ nudgeMessage: 'retry me' });
			await pass();
			expect(notifyToast).not.toHaveBeenCalled();
			expect(pointer().nudgeMessage).toBe('retry me');
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
			expect(useHostedAgentSettingsStore.getState().conflicts).toEqual({});
		});
	});

	describe('peer rows on a lifted pointer', () => {
		beforeEach(() => {
			useSessionStore.setState({ sessionsReadOk: true, sessions: [] });
		});

		it("sends the pointer's peer rows in the host's ids and keeps a row the host cannot honor", async () => {
			const peer = replacePeerAgents(
				createMirroredPeer({ peerId: 'box', remoteId: 'r-box', name: 'box' }),
				[hostAgent(), hostAgent({ id: 'host-2', name: 'Builder' })],
				[],
				1
			).peer;
			usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
			showPointer();
			const builder = createMockSession({
				id: 'local-2',
				name: 'Builder',
				liftedTo: { peer: 'box', agentId: 'host-2', at: 1 },
			});
			const laptop = createMockSession({ id: 'local-3', name: 'Laptop' });
			useSessionStore.setState({ sessions: [pointer(), builder, laptop] });
			stop = startLiftedAgentSettingsSync();
			await pass();
			editPointer({
				peerAgents: [
					{ sessionId: 'local-2', read: true, write: false },
					{ sessionId: 'local-3', read: true, write: true },
				],
			});
			await pass();
			expect(act$).toHaveBeenCalledWith('box', 'host-1', {
				kind: 'update-agent',
				patch: { peerAgents: [{ sessionId: 'host-2', read: true, write: false }] },
			});
			// The row for this machine's agent stays on the pointer, never sent.
			expect(pointer().peerAgents).toEqual([
				{ sessionId: 'local-2', read: true, write: false },
				{ sessionId: 'local-3', read: true, write: true },
			]);
		});
	});

	describe('hostedFieldState', () => {
		it("counts a pointer's edit made while the peer is down as pending", async () => {
			showPeer(hostAgent());
			showPointer();
			stop = startLiftedAgentSettingsSync();
			await pass();
			showPeer(hostAgent(), 'reconnecting');
			editPointer({ nudgeMessage: 'while away' });
			await pass();
			expect(hostedFieldState('box', 'host-1')).toEqual({
				pendingIds: ['nudgeMessage'],
				conflictIds: [],
			});
		});

		it("counts a mirrored agent's held edits as pending, and a conflict as a conflict", async () => {
			showPeer(hostAgent({ nudgeMessage: 'host moved' }), 'reconnecting');
			useHostedAgentSettingsStore.getState().setPending(KEY, {
				values: { customModel: 'sonnet' },
				base: { customModel: null },
				envKeys: [],
			});
			useHostedAgentSettingsStore.getState().setConflicts(KEY, {
				peerId: 'box',
				agentId: 'host-1',
				agentName: 'Docs',
				conflicts: [
					{
						id: 'nudgeMessage',
						label: 'Nudge message',
						local: 'mine',
						host: 'host moved',
						mergeable: true,
						firstSync: false,
					},
				],
			});
			expect(hostedFieldState('box', 'host-1')).toEqual({
				pendingIds: ['customModel'],
				conflictIds: ['nudgeMessage'],
			});
		});
	});

	describe('answerHostedSettingsRequest', () => {
		it('answers every field of a hosted agent with its scope and what waits on it', async () => {
			showPeer(hostAgent());
			showPointer({ nudgeMessage: 'stale' });
			stop = startLiftedAgentSettingsSync();
			await pass();
			const reply = answerHostedSettingsRequest({ action: 'fields', agent: KEY });
			expect(reply.success).toBe(true);
			expect(reply.fields?.find((field) => field.field === 'nudgeMessage')).toMatchObject({
				scope: 'shared',
				conflict: true,
			});
			expect(reply.fields?.find((field) => field.field === 'gatewayUrl')).toMatchObject({
				scope: 'machine',
				pending: false,
			});
			expect(answerHostedSettingsRequest({ action: 'fields', agent: 'no-colon' }).success).toBe(
				false
			);
		});

		it('lists conflicts and settles one the way the modal does', async () => {
			showPeer(hostAgent());
			showPointer({ nudgeMessage: 'stale' });
			stop = startLiftedAgentSettingsSync();
			await pass();
			const listed = answerHostedSettingsRequest({ action: 'list' });
			expect(listed.conflicts).toEqual([
				expect.objectContaining({
					agent: KEY,
					agentName: 'Docs',
					conflicts: [expect.objectContaining({ id: 'nudgeMessage' })],
				}),
			]);
			const settled = answerHostedSettingsRequest({
				action: 'resolve',
				agent: KEY,
				field: 'nudgeMessage',
				resolution: { take: 'host' },
			});
			expect(settled.success).toBe(true);
			expect(settled.conflicts?.[0].conflicts).toEqual([]);
		});

		it('refuses an unknown agent or field, and a merged value for a non-text field', async () => {
			showPeer(hostAgent());
			showPointer({ customModel: 'sonnet' });
			stop = startLiftedAgentSettingsSync();
			await pass();
			expect(
				answerHostedSettingsRequest({
					action: 'resolve',
					agent: 'box:nope',
					field: 'customModel',
					resolution: { take: 'host' },
				})
			).toMatchObject({ success: false });
			expect(
				answerHostedSettingsRequest({
					action: 'resolve',
					agent: KEY,
					field: 'nudgeMessage',
					resolution: { take: 'host' },
				}).error
			).toContain('Fields waiting: customModel');
			expect(
				answerHostedSettingsRequest({
					action: 'resolve',
					agent: KEY,
					field: 'customModel',
					resolution: { take: 'value', value: 'x' },
				}).error
			).toContain('not free text');
		});
	});
});
