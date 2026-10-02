import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAutoRunHandlers } from '../../../../renderer/hooks/batch/useAutoRunHandlers';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import { clearGoalRunLaunches } from '../../../../renderer/hooks/remote/goalRunLaunch';
import { createMockSession } from '../../../helpers/mockSession';
import type { BatchRunConfig } from '../../../../shared/types';
import type { AutoRunRemoteResult } from '../../../../shared/autoRunRemote';

const runtime = vi.hoisted(() => ({ web: false }));
vi.mock('../../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: () => runtime.web }));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
import { spawnWorktreeAgentAndDispatch } from '../../../../renderer/utils/worktreeSpawn';

const config: BatchRunConfig = {
	documents: [{ id: 'one', filename: 'sub/task', resetOnCompletion: true, isDuplicate: false }],
	prompt: 'Do the specified work',
	loopEnabled: true,
	maxLoops: 3,
	model: 'exact-model',
	effort: 'high',
	ignoreModelHints: true,
	autoResumeOnError: false,
};
const source = createMockSession({
	id: 'requested',
	autoRunFolderPath: '/host/documents',
	cwd: '/repo',
});
const active = createMockSession({
	id: 'host-active',
	autoRunFolderPath: '/wrong',
	cwd: '/wrong-repo',
});
let ownerStart:
	| ((
			sessionId: string,
			runConfig: BatchRunConfig,
			folderPath: string,
			responseChannel: string
	  ) => void)
	| undefined;
const replies = new Map<string, AutoRunRemoteResult>();
const deps = (startBatchRun = vi.fn()) => ({
	setSessions: vi.fn(),
	setAutoRunDocumentList: vi.fn(),
	setAutoRunTree: vi.fn(),
	setAutoRunIsLoadingDocuments: vi.fn(),
	setAutoRunSetupModalOpen: vi.fn(),
	setBatchRunnerModalOpen: vi.fn(),
	setActiveRightTab: vi.fn(),
	setRightPanelOpen: vi.fn(),
	setActiveFocus: vi.fn(),
	setSuccessFlashNotification: vi.fn(),
	autoRunDocumentList: [],
	startBatchRun,
});

beforeEach(() => {
	vi.clearAllMocks();
	clearGoalRunLaunches();
	runtime.web = false;
	ownerStart = undefined;
	replies.clear();
	useSessionStore.setState({ sessions: [source, active], activeSessionId: active.id });
	useSettingsStore.setState({ autoRunDisabled: false });
	useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
	window.maestro = {
		logger: { log: vi.fn() },
		process: {
			onRemoteStartAutoRun: (callback: typeof ownerStart) => {
				ownerStart = callback;
				return () => {
					ownerStart = undefined;
				};
			},
			sendRemoteAutoRunResponse: (channel: string, result: AutoRunRemoteResult) => {
				replies.set(channel, result);
			},
		},
	} as unknown as typeof window.maestro;
});

describe('remote host launch ownership', () => {
	it('confirms the requested agent starts, without waiting for its run to end or using host focus', async () => {
		let finishRun!: () => void;
		const run = new Promise<void>((resolve) => {
			finishRun = resolve;
		});
		const startBatchRun = vi.fn((sessionId: string) => {
			useBatchStore.setState({
				batchRunStates: { [sessionId]: { ...DEFAULT_BATCH_STATE, isRunning: true } },
			});
			return run;
		});
		const hook = renderHook(() => useAutoRunHandlers(deps(startBatchRun)));
		act(() => ownerStart!(source.id, config, '/host/explicit-documents', 'started'));
		await waitFor(() => expect(replies.get('started')).toEqual({ success: true }));
		expect(startBatchRun).toHaveBeenCalledWith(source.id, config, '/host/explicit-documents');
		expect(useBatchStore.getState().batchRunStates[source.id].isRunning).toBe(true);
		finishRun();
		hook.unmount();
	});

	it('starts documentless goals without substituting a documents folder', async () => {
		const runConfig: BatchRunConfig = {
			documents: [],
			prompt: '',
			loopEnabled: false,
			model: 'goal-model',
			goalConfig: { goal: 'Complete the objective', exitCriteria: 'All done', maxIterations: 5 },
		};
		const startBatchRun = vi.fn((sessionId: string) => {
			useBatchStore.setState({
				batchRunStates: {
					[sessionId]: { ...DEFAULT_BATCH_STATE, isRunning: true, goalMode: true },
				},
			});
			return Promise.resolve();
		});
		const hook = renderHook(() => useAutoRunHandlers(deps(startBatchRun)));
		act(() => ownerStart!(source.id, runConfig, '', 'goal'));
		await waitFor(() => expect(replies.get('goal')).toEqual({ success: true }));
		expect(startBatchRun).toHaveBeenCalledWith(source.id, runConfig, '');
		hook.unmount();
	});

	it('rejects startup that returns before publishing a live run', async () => {
		const hook = renderHook(() => useAutoRunHandlers(deps(vi.fn().mockResolvedValue(undefined))));
		act(() => ownerStart!(source.id, config, '/host/docs', 'refused'));
		await waitFor(() => expect(replies.get('refused')?.success).toBe(false));
		expect(replies.get('refused')?.error).toContain('Check host state');
		hook.unmount();
	});

	it('rejects an unavailable worktree target instead of silently running on the source agent', async () => {
		const startBatchRun = vi.fn();
		const hook = renderHook(() => useAutoRunHandlers(deps(startBatchRun)));
		act(() =>
			ownerStart!(
				source.id,
				{ ...config, worktreeTarget: { mode: 'existing-open', sessionId: 'removed' } },
				'/host/docs',
				'removed'
			)
		);
		await waitFor(() => expect(replies.get('removed')?.success).toBe(false));
		expect(startBatchRun).not.toHaveBeenCalled();
		hook.unmount();
	});

	it('refuses duplicate requests during preparation, keeping one existing host runner', async () => {
		let startNow!: () => void;
		const startBatchRun = vi.fn(
			(sessionId: string) =>
				new Promise<void>((resolve) => {
					startNow = () => {
						useBatchStore.setState({
							batchRunStates: { [sessionId]: { ...DEFAULT_BATCH_STATE, isRunning: true } },
						});
						resolve();
					};
				})
		);
		const hook = renderHook(() => useAutoRunHandlers(deps(startBatchRun)));
		act(() => {
			ownerStart!(source.id, config, '/host/docs', 'first');
			ownerStart!(source.id, config, '/host/docs', 'second');
		});
		await waitFor(() => expect(replies.get('second')?.success).toBe(false));
		expect(startBatchRun).toHaveBeenCalledTimes(1);
		act(() => startNow());
		await waitFor(() => expect(replies.get('first')?.success).toBe(true));
		hook.unmount();
	});

	it('never creates a worktree in Lite before dispatching the launch to its host', async () => {
		runtime.web = true;
		const startBatchRun = vi.fn().mockResolvedValue(undefined);
		const hook = renderHook(() => useAutoRunHandlers(deps(startBatchRun)));
		const runConfig = {
			...config,
			worktreeTarget: { mode: 'create-new' as const, newBranchName: 'feature' },
		};
		await act(async () => hook.result.current.handleStartBatchRun(runConfig));
		expect(spawnWorktreeAgentAndDispatch).not.toHaveBeenCalled();
		expect(startBatchRun).toHaveBeenCalledWith(active.id, runConfig, active.autoRunFolderPath);
		expect(ownerStart).toBeUndefined();
		hook.unmount();
	});
});
