/**
 * The remote agent and group CRUD listeners in useAppRemoteEventListeners, in both modes.
 *
 * OFF (today's code): the `maestro:remote*` events main forwards are handled by the renderer. ON
 * (library runtime hosted, Phase 9): main answers those messages itself, so the renderer's copy of
 * the rules is not registered and an event that somehow arrives does nothing. While main has not
 * answered the status question the listeners stay registered, because that is the safe reading.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { resetLibraryRuntimeStatus } from '../../../../renderer/services/libraryRuntime';
import type { Group, Session } from '../../../../renderer/types';

const storeState: { groups: Group[]; sessions: Session[] } = { groups: [], sessions: [] };

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => storeState) }),
	selectSessionById: vi.fn(),
}));
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));
vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({ DEFAULT_BATCH_PROMPT: '' }));
vi.mock('../../../../renderer/services/git', () => ({ gitService: {} }));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));

/** Every event the renderer-owned CRUD listeners answer, with a payload the OFF path accepts. */
const CRUD_EVENTS: Array<[string, Record<string, unknown>]> = [
	['maestro:setAutoRunFolder', { sessionId: 's1', folderPath: '/x', responseChannel: 'ch' }],
	[
		'maestro:remoteCreateSession',
		{ name: 'A', toolType: 'claude-code', cwd: '/x', responseChannel: 'ch' },
	],
	['maestro:remoteDeleteSession', { sessionId: 's1' }],
	['maestro:remoteUpdateSessionCwd', { sessionId: 's1', newCwd: '/y', responseChannel: 'ch' }],
	['maestro:remoteUpdateSessionSsh', { sessionId: 's1', sshPatch: {}, responseChannel: 'ch' }],
	[
		'maestro:remoteUpdateSessionConfig',
		{ sessionId: 's1', configPatch: {}, responseChannel: 'ch' },
	],
	['maestro:remoteRenameSession', { sessionId: 's1', newName: 'B', responseChannel: 'ch' }],
	['maestro:remoteCreateGroup', { name: 'G', appearance: {}, responseChannel: 'ch' }],
	['maestro:remoteRenameGroup', { groupId: 'g1', name: 'H', responseChannel: 'ch' }],
	['maestro:remoteUpdateGroup', { groupId: 'g1', update: { name: 'H' }, responseChannel: 'ch' }],
	['maestro:remoteDeleteGroup', { groupId: 'g1' }],
	['maestro:remoteMoveSessionToGroup', { sessionId: 's1', groupId: 'g1', responseChannel: 'ch' }],
];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function dispatch(name: string, detail: Record<string, unknown>) {
	window.dispatchEvent(new CustomEvent(name, { detail }));
}

function setup() {
	const setGroups = vi.fn();
	const setSessions = vi.fn();
	const view = renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef: { current: [{ id: 's1', name: 'One' }] },
			setActiveSessionId: vi.fn(),
			setSessions,
			setGroups,
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);
	return { setGroups, setSessions, ...view };
}

/** Let the status question settle and the listeners re-register for the answer. */
async function settleStatus() {
	await act(async () => {
		await flush();
	});
}

let responses: Record<string, ReturnType<typeof vi.fn>>;

function installMaestro(hosting: boolean | 'unanswered') {
	responses = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
		get(target, key: string) {
			// Any `sendRemote*Response` the hook calls is recorded; nothing else is read from here.
			return (target[key] ??= vi.fn());
		},
	});
	(window as any).maestro = {
		process: responses,
		groups: { setAll: vi.fn().mockResolvedValue(undefined) },
		sessions: { setMany: vi.fn().mockResolvedValue(undefined) },
		agents: { get: vi.fn().mockResolvedValue(null) },
		libraryRuntime: {
			status: vi.fn(() =>
				hosting === 'unanswered' ? new Promise(() => undefined) : Promise.resolve({ hosting })
			),
			onEvent: vi.fn(),
		},
	};
}

function calledResponses(): string[] {
	return Object.entries(responses)
		.filter(([, fn]) => fn.mock.calls.length > 0)
		.map(([name]) => name);
}

const originalMaestro = (window as any).maestro;

beforeEach(() => {
	vi.clearAllMocks();
	resetLibraryRuntimeStatus();
	storeState.groups = [{ id: 'g1', name: 'TEAM', emoji: '\u{1F4C2}', collapsed: false } as Group];
	storeState.sessions = [];
});

afterEach(() => {
	resetLibraryRuntimeStatus();
	(window as any).maestro = originalMaestro;
});

describe('remote agent and group CRUD listeners', () => {
	describe('library runtime OFF', () => {
		it('handles a remote group rename and a move to a group', async () => {
			installMaestro(false);
			const { setGroups, setSessions } = setup();
			await settleStatus();

			dispatch('maestro:remoteRenameGroup', { groupId: 'g1', name: 'Team', responseChannel: 'c1' });
			dispatch('maestro:remoteMoveSessionToGroup', {
				sessionId: 's1',
				groupId: 'g1',
				responseChannel: 'c2',
			});

			expect(setGroups).toHaveBeenCalledTimes(1);
			expect(setSessions).toHaveBeenCalledTimes(1);
			expect(responses.sendRemoteRenameGroupResponse).toHaveBeenCalledWith('c1', true);
			expect(responses.sendRemoteMoveSessionToGroupResponse).toHaveBeenCalledWith('c2', true);
		});
	});

	describe('library runtime ON', () => {
		it('registers none of the CRUD listeners once main says it hosts the runtime', async () => {
			installMaestro(true);
			const { setGroups, setSessions } = setup();
			await settleStatus();

			for (const [name, detail] of CRUD_EVENTS) dispatch(name, detail);
			await act(async () => {
				await flush();
			});

			expect(setGroups).not.toHaveBeenCalled();
			expect(setSessions).not.toHaveBeenCalled();
			expect(calledResponses()).toEqual([]);
			expect((window as any).maestro.groups.setAll).not.toHaveBeenCalled();
			expect((window as any).maestro.agents.get).not.toHaveBeenCalled();
		});

		it('stops handling an event the moment the answer arrives, not before', async () => {
			installMaestro(true);
			const { setGroups } = setup();

			// Main has not answered yet: the renderer's copy is still registered.
			dispatch('maestro:remoteRenameGroup', {
				groupId: 'g1',
				name: 'Early',
				responseChannel: 'c1',
			});
			expect(setGroups).toHaveBeenCalledTimes(1);

			await settleStatus();
			dispatch('maestro:remoteRenameGroup', { groupId: 'g1', name: 'Late', responseChannel: 'c2' });
			expect(setGroups).toHaveBeenCalledTimes(1);
		});

		it('keeps the listeners the runtime does not answer', async () => {
			installMaestro(true);
			setup();
			await settleStatus();

			// A worktree agent is created by the renderer's git and spawn flow, so its listener stays.
			dispatch('maestro:createWorktreeSession', {
				parentSessionId: 'missing',
				config: { branchName: 'b' },
				responseChannel: 'c1',
			});
			await waitFor(() =>
				expect(responses.sendRemoteCreateWorktreeSessionResponse).toHaveBeenCalledWith('c1', {
					success: false,
					error: 'Parent agent missing not found',
				})
			);
		});
	});

	describe('main has not answered', () => {
		it('reads as OFF, so the renderer still handles the event', async () => {
			installMaestro('unanswered');
			const { setGroups } = setup();
			await settleStatus();

			dispatch('maestro:remoteRenameGroup', { groupId: 'g1', name: 'Team', responseChannel: 'c1' });

			expect(setGroups).toHaveBeenCalledTimes(1);
		});
	});
});
