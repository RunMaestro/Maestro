/**
 * Auto Run parity across a local agent, an SSH agent, and a hosted agent: the same Run starts the
 * run (here for local and SSH, on the Federation host for hosted), the run draws the same card, and
 * the same Stop and pause choices reach whichever machine runs the loop.
 */

import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoRunToolbar } from '../../../../renderer/components/AutoRun/AutoRunToolbar';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import { useIsMirroredBatchRun } from '../../../../renderer/hooks/batch/useAutoRunStateMirror';
import { useBatchProcessor } from '../../../../renderer/hooks/batch/useBatchProcessor';
import { syncHostedAgents } from '../../../../renderer/services/hostedAgentSync';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { usePeerMirrorStore } from '../../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { BatchRunConfig, BatchRunState } from '../../../../renderer/types';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../../shared/maestro-lib/client/peer-mirror';
import { resetStores } from '../../../helpers';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockTheme } from '../../../helpers/mockTheme';

const local = vi.hoisted(() => ({ document: vi.fn(), goal: vi.fn(), kill: vi.fn() }));
vi.mock('../../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: () => false }));
vi.mock('../../../../renderer/hooks/batch/internal/useBatchRunner', () => ({
	useBatchRunner: () => ({ startBatchRun: local.document }),
}));
vi.mock('../../../../renderer/hooks/batch/internal/useGoalRunner', () => ({
	useGoalRunner: () => ({ startGoalRun: local.goal }),
}));
vi.mock('../../../../renderer/hooks/batch/internal/useBatchKillAction', () => ({
	useBatchKillAction: () => ({ killBatchRun: local.kill }),
}));
vi.mock('../../../../renderer/hooks/batch/useDocumentProcessor', () => ({
	useDocumentProcessor: () => ({}),
}));
vi.mock('../../../../renderer/hooks/batch/useWorktreeManager', () => ({
	useWorktreeManager: () => ({}),
}));
vi.mock('../../../../renderer/hooks/batch/useTimeTracking', () => ({
	useTimeTracking: () => ({ pauseTracking: vi.fn(), resumeTracking: vi.fn() }),
}));
vi.mock('../../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<object>()),
	notifyToast: vi.fn(),
}));

const ssh = { enabled: true, remoteId: 'r1', workingDirOverride: '/home/me/docs' };
const MODES = [
	{ mode: 'local', id: 'local' },
	{ mode: 'SSH', id: 'ssh' },
	{ mode: 'hosted', id: 'hosted' },
] as const;

const config: BatchRunConfig = {
	documents: [{ id: 'd1', filename: 'phase-1', resetOnCompletion: false, isDuplicate: false }],
	prompt: 'Work the tasks',
	loopEnabled: false,
};

const running = (sessionId: string): Partial<BatchRunState> => ({
	isRunning: true,
	documents: ['phase-1'],
	lockedDocuments: ['phase-1'],
	totalTasks: 4,
	completedTasks: 1,
	currentTaskIndex: 1,
	totalTasksAcrossAllDocs: 4,
	completedTasksAcrossAllDocs: 1,
	folderPath: `/docs/${sessionId}`,
});

const actOnHost = vi.fn();
const deps = () => ({
	groups: [],
	onUpdateSession: vi.fn(),
	onSpawnAgent: vi.fn(),
	onAddHistoryEntry: vi.fn(),
});

/** Start each mode's run as its own machine would, so the card is drawn from real state. */
function startRuns() {
	const owned: Record<string, BatchRunState> = {};
	for (const id of ['local', 'ssh']) {
		owned[id] = { ...DEFAULT_BATCH_STATE, ...running(id) } as BatchRunState;
	}
	useBatchStore.setState({ batchRunStates: owned });
	usePeerMirrorStore.getState().applyPush({
		peerId: 'box',
		event: {
			type: 'agent.autorun',
			agentId: 'h1',
			state: { ...running('hosted'), isRunning: true } as never,
		},
	});
	syncHostedAgents();
}

beforeEach(() => {
	vi.clearAllMocks();
	resetStores(usePeerMirrorStore, useSessionStore);
	useSettingsStore.setState({ federationHostedAgents: true });
	useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
	actOnHost.mockResolvedValue({ ok: true, result: { kind: 'auto-run' } });
	window.maestro = {
		...window.maestro,
		federation: { act: actOnHost },
		web: { broadcastAutoRunState: vi.fn().mockResolvedValue(true) },
		logger: { autorun: vi.fn(), log: vi.fn() },
		process: {
			...window.maestro?.process,
			onRemoteAutoRunStateMirror: () => () => {},
			onRemoteControlAutoRun: () => () => {},
			sendRemoteAutoRunResponse: vi.fn(),
		},
	} as unknown as typeof window.maestro;
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[
			{
				id: 'h1',
				name: 'Docs',
				toolType: 'claude-code',
				autoRunFolderPath: '/home/me/docs',
				aiTabs: [{ id: 't1' }],
			},
		],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
	useSessionStore.setState({
		sessions: [
			createMockSession({ id: 'local', name: 'Docs', liftedTo: undefined }),
			createMockSession({ id: 'ssh', name: 'Docs', sessionSshRemoteConfig: ssh }),
			createMockSession({
				id: 'hosted',
				name: 'Docs',
				sessionSshRemoteConfig: ssh,
				liftedTo: { peer: 'box', agentId: 'h1', at: 1 },
			}),
		],
		activeSessionId: 'local',
	});
});

afterEach(() => {
	useBatchStore.setState({ batchRunStates: {} });
});

describe('Auto Run on local, SSH, and hosted agents', () => {
	it('local, SSH, and hosted agents all start the run from the same Run', async () => {
		const hook = renderHook(() => useBatchProcessor(deps()));
		for (const { id } of MODES) {
			await act(async () => {
				await hook.result.current.startBatchRun(id, config, '/home/me/docs');
			});
		}
		// Local and SSH run the loop here; the SSH hop is inside the spawn.
		expect(local.document.mock.calls.map((call) => call[0])).toEqual(['local', 'ssh']);
		// Hosted: the host runs the same documents with the same prompt.
		expect(actOnHost).toHaveBeenCalledTimes(1);
		expect(actOnHost).toHaveBeenCalledWith('box', 'h1', {
			kind: 'auto-run',
			launch: { documents: [{ file: '/home/me/docs/phase-1.md' }], prompt: 'Work the tasks' },
		});
		hook.unmount();
	});

	it('local, SSH, and hosted agents draw the same running card with a live Stop', () => {
		startRuns();
		const drawn = MODES.map(({ id }) => {
			const readOnly = renderHook(() => useIsMirroredBatchRun(id));
			expect(readOnly.result.current).toBe(false);
			readOnly.unmount();
			const { container, unmount } = render(
				<AutoRunToolbar
					theme={createMockTheme()}
					isAutoRunActive={useBatchStore.getState().batchRunStates[id]?.isRunning === true}
					isStopping={false}
					isAgentBusy={false}
					isDirty={false}
					sessionId={id}
					onStopBatchRun={vi.fn()}
					onOpenHelp={vi.fn()}
					onSave={vi.fn().mockResolvedValue(undefined)}
					fileInputRef={{ current: null }}
					onFileSelect={vi.fn()}
				/>
			);
			const html = container.innerHTML;
			unmount();
			return html;
		});
		expect(drawn[1]).toBe(drawn[0]);
		expect(drawn[2]).toBe(drawn[0]);
		expect(drawn[0]).toContain('Stop auto-run');
	});

	it('Stop reaches the machine that runs the loop', async () => {
		startRuns();
		actOnHost.mockResolvedValue({
			ok: true,
			result: { kind: 'auto-run-control', control: 'stop' },
		});
		const hook = renderHook(() => useBatchProcessor(deps()));
		for (const { id } of MODES) {
			const view = render(
				<AutoRunToolbar
					theme={createMockTheme()}
					isAutoRunActive
					isStopping={false}
					isAgentBusy={false}
					isDirty={false}
					sessionId={id}
					onStopBatchRun={(sessionId) => hook.result.current.stopBatchRun(sessionId ?? '')}
					onOpenHelp={vi.fn()}
					onSave={vi.fn().mockResolvedValue(undefined)}
					fileInputRef={{ current: null }}
					onFileSelect={vi.fn()}
				/>
			);
			fireEvent.click(view.getByRole('button', { name: 'Stop' }));
			view.unmount();
		}
		const states = useBatchStore.getState().batchRunStates;
		expect(states.local?.isStopping).toBe(true);
		expect(states.ssh?.isStopping).toBe(true);
		// The host stops its own loop; its next frame draws the stop here.
		expect(actOnHost).toHaveBeenCalledWith('box', 'h1', {
			kind: 'auto-run-control',
			control: 'stop',
		});
		expect(actOnHost).toHaveBeenCalledTimes(1);
		hook.unmount();
	});

	it.each([
		['skipCurrentDocument', 'skip'],
		['resumeAfterError', 'resume'],
		['abortBatchOnError', 'abort'],
		['killBatchRun', 'stop'],
	] as const)('a hosted run sends %s to its host', async (method, control) => {
		startRuns();
		actOnHost.mockResolvedValue({ ok: true, result: { kind: 'auto-run-control', control } });
		const hook = renderHook(() => useBatchProcessor(deps()));
		await act(async () => {
			await hook.result.current[method]('hosted');
		});
		expect(actOnHost).toHaveBeenCalledWith('box', 'h1', { kind: 'auto-run-control', control });
		expect(local.kill).not.toHaveBeenCalled();
		hook.unmount();
	});
});
