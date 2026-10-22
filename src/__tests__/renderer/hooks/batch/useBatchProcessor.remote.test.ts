import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBatchProcessor } from '../../../../renderer/hooks/batch/useBatchProcessor';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import {
	applyAutoRunMirrorFrame,
	useIsMirroredBatchRun,
} from '../../../../renderer/hooks/batch/useAutoRunStateMirror';
import type { AutoRunRemoteControl } from '../../../../shared/autoRunRemote';
import type { BatchRunConfig } from '../../../../renderer/types';

const local = vi.hoisted(() => ({ web: true, document: vi.fn(), goal: vi.fn(), kill: vi.fn() }));
vi.mock('../../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: () => local.web }));
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
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));

const config: BatchRunConfig = {
	documents: [{ id: 'doc', filename: 'nested/tasks', resetOnCompletion: true, isDuplicate: false }],
	prompt: 'Exact prompt',
	loopEnabled: true,
	maxLoops: 7,
	taskSelectionMode: 'document',
	model: 'chosen-model',
	effort: 'high',
	ignoreModelHints: true,
	autoResumeOnError: false,
	autoResumeAfterMin: 3,
	maxAutoResumes: 2,
	worktreeTarget: { mode: 'existing-open', sessionId: 'worktree' },
};
const deps = () => ({
	groups: [],
	onUpdateSession: vi.fn(),
	onSpawnAgent: vi.fn(),
	onAddHistoryEntry: vi.fn(),
});
let start: Mock;
let control: Mock;
let reply: Mock;
let ownerControl:
	| ((sessionId: string, command: AutoRunRemoteControl, responseChannel: string) => void)
	| undefined;

beforeEach(() => {
	vi.clearAllMocks();
	local.web = true;
	ownerControl = undefined;
	useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
	start = vi.fn().mockResolvedValue({ success: true });
	control = vi.fn().mockResolvedValue({ success: true });
	reply = vi.fn();
	window.maestro = {
		web: {
			startAutoRun: start,
			controlAutoRun: control,
			broadcastAutoRunState: vi.fn().mockResolvedValue(true),
		},
		logger: { autorun: vi.fn(), log: vi.fn() },
		process: {
			onRemoteAutoRunStateMirror: () => () => {},
			onRemoteControlAutoRun: (callback: typeof ownerControl) => {
				ownerControl = callback;
				return () => {};
			},
			sendRemoteAutoRunResponse: reply,
		},
	} as unknown as typeof window.maestro;
});

describe('host-owned remote Auto Run', () => {
	it.each([false, true])('never starts a browser runner (goal mode: %s)', async (goalMode) => {
		const runConfig = goalMode
			? {
					...config,
					goalConfig: {
						goal: 'Ship the feature',
						exitCriteria: 'Feature is working',
						maxIterations: 3,
					},
				}
			: config;
		const hook = renderHook(() => useBatchProcessor(deps()));
		await act(async () => {
			await hook.result.current.startBatchRun('requested-agent', runConfig, '/host/source/docs');
		});
		expect(start).toHaveBeenCalledWith('requested-agent', runConfig, '/host/source/docs');
		expect(local.document).not.toHaveBeenCalled();
		expect(local.goal).not.toHaveBeenCalled();
		expect(ownerControl).toBeUndefined();
		expect(useBatchStore.getState().batchRunStates).toEqual({});
		hook.unmount();
	});

	it('surfaces rejected/uncertain starts without falling back to browser execution', async () => {
		start.mockResolvedValue({ success: false, error: 'Check host state before retrying' });
		const hook = renderHook(() => useBatchProcessor(deps()));
		await expect(hook.result.current.startBatchRun('agent', config, '/docs')).rejects.toThrow(
			'Check host state'
		);
		expect(local.document).not.toHaveBeenCalled();
		expect(local.goal).not.toHaveBeenCalled();
		hook.unmount();
	});

	it('routes every control to the owner while leaving broadcast state unchanged until the host updates it', async () => {
		applyAutoRunMirrorFrame('agent', {
			isRunning: true,
			totalTasks: 4,
			completedTasks: 1,
			currentTaskIndex: 1,
			errorPaused: true,
		});
		const before = useBatchStore.getState().batchRunStates.agent;
		const hook = renderHook(() => useBatchProcessor(deps()));
		const controlsEnabled = renderHook(() => useIsMirroredBatchRun('agent'));
		expect(controlsEnabled.result.current).toBe(false);
		const error = {
			type: 'rate_limited' as const,
			message: 'Limit',
			recoverable: true,
			agentId: 'claude-code',
			timestamp: 1,
		};
		await act(async () => {
			hook.result.current.stopBatchRun('agent');
			hook.result.current.pauseBatchOnError('agent', error, 2, 'exact task');
			hook.result.current.resumeAfterError('agent');
			hook.result.current.skipCurrentDocument('agent');
			hook.result.current.abortBatchOnError('agent');
			await hook.result.current.killBatchRun('agent');
		});
		expect(control.mock.calls.map((args) => args[1])).toEqual([
			{ action: 'stop' },
			{ action: 'pause', error, documentIndex: 2, taskDescription: 'exact task' },
			{ action: 'resume' },
			{ action: 'skip-document' },
			{ action: 'abort' },
			{ action: 'kill' },
		]);
		expect(useBatchStore.getState().batchRunStates.agent).toBe(before);
		expect(local.kill).not.toHaveBeenCalled();
		act(() => applyAutoRunMirrorFrame('agent', null));
		expect(useBatchStore.getState().batchRunStates.agent).toBeUndefined();
		hook.unmount();
		controlsEnabled.unmount();
	});

	it('owner controls transition the existing host run and reject nonexistent ownership', async () => {
		local.web = false;
		useBatchStore.setState({
			batchRunStates: {
				agent: { ...DEFAULT_BATCH_STATE, isRunning: true, processingState: 'RUNNING' },
			},
		});
		const hook = renderHook(() => useBatchProcessor(deps()));
		await act(async () =>
			ownerControl!(
				'agent',
				{
					action: 'pause',
					error: {
						type: 'rate_limited',
						message: 'Limit',
						recoverable: true,
						agentId: 'claude-code',
						timestamp: 1,
					},
					documentIndex: 0,
				},
				'pause-reply'
			)
		);
		expect(useBatchStore.getState().batchRunStates.agent.errorPaused).toBe(true);
		await act(async () => ownerControl!('agent', { action: 'resume' }, 'resume-reply'));
		expect(useBatchStore.getState().batchRunStates.agent.errorPaused).toBe(false);
		await act(async () => ownerControl!('absent', { action: 'kill' }, 'invalid-reply'));
		expect(reply).toHaveBeenCalledWith(
			'invalid-reply',
			expect.objectContaining({ success: false })
		);
		expect(local.kill).not.toHaveBeenCalled();
		hook.unmount();
	});
});
