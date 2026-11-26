/**
 * Tests for `services/hostedAgentSync.ts`: every hosted agent's Left Bar record follows its host,
 * the tab on screen is read lazily, and a record that already matches is left alone.
 */

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHostedAgentSync, syncHostedAgents } from '../../../renderer/services/hostedAgentSync';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useAutoRunSteeringStore } from '../../../renderer/stores/autoRunSteeringStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { resetStores } from '../../helpers';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: toastMock,
}));

const maestro = window.maestro as unknown as Record<string, unknown>;
const transcript = vi.fn();

function hydrateHost(state: 'idle' | 'busy' = 'busy') {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[
			{
				id: 'h1',
				name: 'Docs',
				toolType: 'claude-code',
				activeTabId: 't1',
				aiTabs: [{ id: 't1', name: 'Main', agentSessionId: 's1', state }],
			},
		],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

const row = () =>
	createMockSession({
		id: 'row',
		liftedTo: { peer: 'box', agentId: 'h1', at: 1 },
		activeTabId: 't1',
		aiTabs: [createMockAITab({ id: 't1', logs: [] })],
		state: 'idle',
	});

const flush = () => act(async () => undefined);

describe('hostedAgentSync', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({ federationHostedAgents: true });
		transcript.mockReset();
		transcript.mockResolvedValue([{ id: 'e1', timestamp: 1, source: 'ai', text: 'from the host' }]);
		maestro.federation = { transcript };
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it('folds the host tab into the record and reads the tab on screen', async () => {
		useSessionStore.setState({ sessions: [row()], activeSessionId: 'row' });
		hydrateHost('busy');
		syncHostedAgents();
		const synced = useSessionStore.getState().sessions[0];
		expect(synced.aiTabs[0]).toMatchObject({ name: 'Main', state: 'busy' });
		expect(synced.state).toBe('busy');
		expect(transcript).toHaveBeenCalledWith('box', 'h1', 't1', expect.any(Object));
		await flush();
		syncHostedAgents();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs.map((e) => e.text)).toEqual([
			'from the host',
		]);
	});

	it('does not read a tab nobody looks at', () => {
		useSessionStore.setState({ sessions: [row()], activeSessionId: 'someone-else' });
		hydrateHost();
		syncHostedAgents();
		expect(transcript).not.toHaveBeenCalled();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].state).toBe('busy');
	});

	it('leaves local agents and a record that already matches untouched', () => {
		const localAgent = createMockSession({ id: 'local' });
		useSessionStore.setState({ sessions: [row(), localAgent], activeSessionId: 'local' });
		hydrateHost('idle');
		syncHostedAgents();
		const once = useSessionStore.getState().sessions;
		syncHostedAgents();
		expect(useSessionStore.getState().sessions).toBe(once);
		expect(once[1]).toBe(localAgent);
	});

	it('follows the mirror once started, and stops following when stopped', async () => {
		useSessionStore.setState({ sessions: [row()], activeSessionId: 'other' });
		const stop = startHostedAgentSync();
		act(() => hydrateHost('busy'));
		await flush();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].state).toBe('busy');
		stop();
		act(() => hydrateHost('idle'));
		await flush();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].state).toBe('busy');
	});

	it('with hosted agents off, folds nothing in and releases each record once', () => {
		useSessionStore.setState({ sessions: [row()], activeSessionId: 'row' });
		hydrateHost('busy');
		syncHostedAgents();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].state).toBe('busy');

		useSettingsStore.setState({ federationHostedAgents: false });
		syncHostedAgents();
		const released = useSessionStore.getState().sessions[0];
		expect(released.aiTabs[0].state).toBe('idle');
		expect(released.state).toBe('idle');
		expect(transcript).toHaveBeenCalledTimes(1);

		// A local SSH turn that starts afterwards is never idled by a later pass.
		useSessionStore.setState({
			sessions: [{ ...released, state: 'busy', busySource: 'ai' }],
		});
		syncHostedAgents();
		expect(useSessionStore.getState().sessions[0].state).toBe('busy');

		// Back on: the host is folded in again.
		useSettingsStore.setState({ federationHostedAgents: true });
		syncHostedAgents();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].state).toBe('busy');
	});

	describe('Auto Run the host drives', () => {
		const frame = (completedTasks: number) => ({
			isRunning: true,
			totalTasks: 4,
			completedTasks,
			currentTaskIndex: completedTasks,
			documents: ['phase-1'],
			lockedDocuments: ['phase-1'],
			currentDocTasksTotal: 4,
			currentDocTasksCompleted: completedTasks,
			startTime: 50,
		});
		const pushRun = (state: ReturnType<typeof frame> | null) =>
			usePeerMirrorStore
				.getState()
				.applyPush({ peerId: 'box', event: { type: 'agent.autorun', agentId: 'h1', state } });

		beforeEach(() => {
			useBatchStore.setState({ batchRunStates: {} });
			useSessionStore.setState({ sessions: [row()], activeSessionId: 'other' });
			hydrateHost('idle');
		});

		it('draws the host run as the record run, follows it, and drops it when the host clears it', () => {
			pushRun(frame(1));
			syncHostedAgents();
			expect(useBatchStore.getState().batchRunStates.row).toMatchObject({
				mirrored: true,
				isRunning: true,
				documents: ['phase-1'],
				lockedDocuments: ['phase-1'],
				completedTasks: 1,
				currentDocTasksCompleted: 1,
				startTime: 50,
			});

			pushRun(frame(2));
			syncHostedAgents();
			expect(useBatchStore.getState().batchRunStates.row?.completedTasks).toBe(2);

			pushRun(null);
			syncHostedAgents();
			expect(useBatchStore.getState().batchRunStates.row).toBeUndefined();
		});

		it("reads the host's steering notes when it first sees the run, and when the run moves on", async () => {
			const act = vi.fn(async () => ({
				ok: true,
				result: {
					kind: 'steer-auto-run',
					result: {
						success: true,
						steerable: true,
						pending: [{ id: 'n1', text: 'Sent from another client', timestamp: 3 }],
						deliveries: [],
					},
				},
			}));
			maestro.federation = { transcript, act };
			pushRun(frame(1));
			syncHostedAgents();
			await flush();
			expect(act).toHaveBeenCalledTimes(1);
			expect(act).toHaveBeenCalledWith('box', 'h1', {
				kind: 'steer-auto-run',
				input: { action: 'list' },
			});
			expect(useAutoRunSteeringStore.getState().notes.row).toEqual([
				{ id: 'n1', text: 'Sent from another client', timestamp: 3 },
			]);

			// The same place again: the notes still wait, so the host is asked whether a task took them.
			act.mockClear();
			pushRun(frame(2));
			syncHostedAgents();
			await flush();
			expect(act).toHaveBeenCalledTimes(1);
			useAutoRunSteeringStore.setState({ notes: {}, delivered: {} });
		});

		it('drops the run of a record that is no longer hosted', () => {
			pushRun(frame(1));
			syncHostedAgents();
			expect(useBatchStore.getState().batchRunStates.row?.mirrored).toBe(true);
			useSessionStore.setState({ sessions: [{ ...row(), liftedTo: undefined }] });
			syncHostedAgents();
			expect(useBatchStore.getState().batchRunStates.row).toBeUndefined();
		});

		it('reads the steering again when a record hosted again shows the run it left (P11)', async () => {
			const act = vi.fn(async () => ({
				ok: true,
				result: {
					kind: 'steer-auto-run',
					result: { success: true, steerable: true, pending: [], deliveries: [] },
				},
			}));
			maestro.federation = { transcript, act };
			pushRun(frame(1));
			syncHostedAgents();
			await flush();
			expect(act).toHaveBeenCalledTimes(1);

			// The record stops being hosted mid-run, then is hosted again at the same place.
			useSessionStore.setState({ sessions: [{ ...row(), liftedTo: undefined }] });
			syncHostedAgents();
			useSessionStore.setState({ sessions: [row()] });
			syncHostedAgents();
			await flush();
			expect(act).toHaveBeenCalledTimes(2);
		});

		describe('the end of the host run', () => {
			const across = (done: number, extra: Record<string, unknown> = {}) => ({
				...frame(done),
				totalTasksAcrossAllDocs: 4,
				completedTasksAcrossAllDocs: done,
				initialCompletedTasks: 0,
				...extra,
			});
			let stop: () => void = () => undefined;
			beforeEach(() => toastMock.mockClear());
			afterEach(() => stop());

			it('raises the same Auto-Run Complete toast a local run raises', () => {
				stop = startHostedAgentSync({ announcesRunEnds: true });
				pushRun(across(3) as never);
				syncHostedAgents();
				pushRun(across(4) as never);
				syncHostedAgents();
				expect(toastMock).not.toHaveBeenCalled();
				pushRun(null);
				syncHostedAgents();
				expect(toastMock).toHaveBeenCalledTimes(1);
				expect(toastMock).toHaveBeenCalledWith(
					expect.objectContaining({
						type: 'success',
						title: 'Auto-Run Complete',
						message: 'All 4 tasks completed successfully',
						sessionId: 'row',
					})
				);
				// The run is gone; a later sync raises nothing more.
				syncHostedAgents();
				expect(toastMock).toHaveBeenCalledTimes(1);
			});

			it('says a stopped run stopped', () => {
				stop = startHostedAgentSync({ announcesRunEnds: true });
				pushRun(across(2, { isStopping: true }) as never);
				syncHostedAgents();
				pushRun(null);
				syncHostedAgents();
				expect(toastMock).toHaveBeenCalledWith(
					expect.objectContaining({
						type: 'warning',
						message: 'Stopped after completing 2 of 4 tasks',
					})
				);
			});

			it('raises it in one window only, and not when the record stops being hosted', () => {
				stop = startHostedAgentSync();
				pushRun(across(4) as never);
				syncHostedAgents();
				pushRun(null);
				syncHostedAgents();
				expect(toastMock).not.toHaveBeenCalled();
				stop();

				stop = startHostedAgentSync({ announcesRunEnds: true });
				pushRun(across(4) as never);
				syncHostedAgents();
				useSessionStore.setState({ sessions: [{ ...row(), liftedTo: undefined }] });
				syncHostedAgents();
				expect(toastMock).not.toHaveBeenCalled();
			});
		});

		it('never overwrites a run this window owns for the record', () => {
			useBatchStore.setState({
				batchRunStates: {
					row: { ...frame(0), isRunning: true, isStopping: false } as never,
				},
			});
			pushRun(frame(3));
			syncHostedAgents();
			expect(useBatchStore.getState().batchRunStates.row?.mirrored).toBeUndefined();
			expect(useBatchStore.getState().batchRunStates.row?.completedTasks).toBe(0);
		});
	});
});
