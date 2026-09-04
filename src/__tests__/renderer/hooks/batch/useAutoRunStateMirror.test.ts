import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	applyAutoRunMirrorFrame,
	buildMirroredBatchState,
	reapStaleMirrors,
	resetMirrorFrameClock,
} from '../../../../renderer/hooks/batch/useAutoRunStateMirror';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import type { AutoRunBroadcastState } from '../../../../shared/autoRunBroadcast';
import type { BatchRunState } from '../../../../renderer/types';

const mkFrame = (over: Partial<AutoRunBroadcastState> = {}): AutoRunBroadcastState => ({
	isRunning: true,
	totalTasks: 4,
	completedTasks: 1,
	currentTaskIndex: 1,
	...over,
});

const mkLocalRun = (over: Partial<BatchRunState> = {}): BatchRunState => ({
	...DEFAULT_BATCH_STATE,
	isRunning: true,
	...over,
});

beforeEach(() => {
	useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
	resetMirrorFrameClock();
});

describe('buildMirroredBatchState', () => {
	it('stamps the entry as mirrored so every mutator and control can refuse it', () => {
		expect(buildMirroredBatchState(mkFrame()).mirrored).toBe(true);
	});

	it('carries the full desktop card, not just the progress bar', () => {
		const state = buildMirroredBatchState(
			mkFrame({
				documents: ['plan', 'cleanup'],
				lockedDocuments: ['plan'],
				currentDocumentIndex: 1,
				currentDocTasksTotal: 3,
				currentDocTasksCompleted: 2,
				worktreeActive: true,
				worktreeBranch: 'auto/plan',
				loopEnabled: true,
				loopIteration: 2,
			})
		);

		expect(state.documents).toEqual(['plan', 'cleanup']);
		expect(state.lockedDocuments).toEqual(['plan']);
		expect(state.currentDocumentIndex).toBe(1);
		expect(state.currentDocTasksCompleted).toBe(2);
		expect(state.worktreeActive).toBe(true);
		expect(state.worktreeBranch).toBe('auto/plan');
		expect(state.loopEnabled).toBe(true);
		expect(state.loopIteration).toBe(2);
	});

	it("keeps the owner's start time rather than stamping the moment this client saw the run", () => {
		const ownerStart = 1_700_000_000_000;
		expect(buildMirroredBatchState(mkFrame({ startTime: ownerStart })).startTime).toBe(ownerStart);
	});

	it('falls back to the previous mirror for a field a later frame omits', () => {
		const first = buildMirroredBatchState(mkFrame({ startTime: 123, documents: ['plan'] }));
		const second = buildMirroredBatchState(mkFrame({ completedTasks: 2 }), first);

		expect(second.startTime).toBe(123);
		expect(second.documents).toEqual(['plan']);
		expect(second.completedTasks).toBe(2);
	});

	it('rebuilds an error object from the flattened wire scalars', () => {
		const state = buildMirroredBatchState(
			mkFrame({
				errorPaused: true,
				errorMessage: 'rate limited',
				errorType: 'rate_limit',
				errorRecoverable: true,
			})
		);

		expect(state.errorPaused).toBe(true);
		expect(state.error?.message).toBe('rate limited');
		expect(state.error?.type).toBe('rate_limit');
		expect(state.error?.recoverable).toBe(true);
	});

	it('leaves error undefined when the frame carries no error', () => {
		expect(buildMirroredBatchState(mkFrame()).error).toBeUndefined();
	});
});

describe('applyAutoRunMirrorFrame', () => {
	it('creates a mirrored entry for a run this client has never seen', () => {
		applyAutoRunMirrorFrame('agent-1', mkFrame({ completedTasks: 3 }));

		const entry = useBatchStore.getState().batchRunStates['agent-1'];
		expect(entry.isRunning).toBe(true);
		expect(entry.mirrored).toBe(true);
		expect(entry.completedTasks).toBe(3);
	});

	it('updates an existing mirror in place', () => {
		applyAutoRunMirrorFrame('agent-1', mkFrame({ completedTasks: 1 }));
		applyAutoRunMirrorFrame('agent-1', mkFrame({ completedTasks: 2 }));

		expect(useBatchStore.getState().batchRunStates['agent-1'].completedTasks).toBe(2);
	});

	it('never overwrites a run this client OWNS - the owner hears its own broadcasts back', () => {
		useBatchStore.setState({
			batchRunStates: { 'agent-1': mkLocalRun({ completedTasks: 7, folderPath: '/local' }) },
		});

		applyAutoRunMirrorFrame('agent-1', mkFrame({ completedTasks: 1 }));

		const entry = useBatchStore.getState().batchRunStates['agent-1'];
		expect(entry.mirrored).toBeUndefined();
		expect(entry.completedTasks).toBe(7);
		expect(entry.folderPath).toBe('/local');
	});

	it('removes the mirror when the owner clears the run', () => {
		applyAutoRunMirrorFrame('agent-1', mkFrame());
		applyAutoRunMirrorFrame('agent-1', null);

		expect(useBatchStore.getState().batchRunStates['agent-1']).toBeUndefined();
	});

	it('removes the mirror when the run finishes rather than leaving a stopped card', () => {
		applyAutoRunMirrorFrame('agent-1', mkFrame());
		applyAutoRunMirrorFrame('agent-1', mkFrame({ isRunning: false, completedTasks: 4 }));

		expect(useBatchStore.getState().batchRunStates['agent-1']).toBeUndefined();
	});

	it('leaves a locally owned run alone when a clearing frame arrives for it', () => {
		useBatchStore.setState({ batchRunStates: { 'agent-1': mkLocalRun({ completedTasks: 7 }) } });

		applyAutoRunMirrorFrame('agent-1', null);

		expect(useBatchStore.getState().batchRunStates['agent-1'].completedTasks).toBe(7);
	});

	it('does not create an entry for a clearing frame it has nothing to clear', () => {
		applyAutoRunMirrorFrame('agent-1', null);
		expect(useBatchStore.getState().batchRunStates).toEqual({});
	});

	it('adopts an agent whose LOCAL run has already finished - COMPLETE_BATCH leaves the key behind', () => {
		// `COMPLETE_BATCH` resets the entry in place instead of deleting it, so a
		// client that has run Auto Run once keeps a non-mirrored `isRunning: false`
		// entry forever. Reading that as ownership made mirroring permanently dead
		// for exactly the agents the user had already used it on.
		useBatchStore.setState({
			batchRunStates: { 'agent-1': mkLocalRun({ isRunning: false, completedTasks: 0 }) },
		});

		applyAutoRunMirrorFrame('agent-1', mkFrame({ completedTasks: 3 }));

		const entry = useBatchStore.getState().batchRunStates['agent-1'];
		expect(entry.mirrored).toBe(true);
		expect(entry.isRunning).toBe(true);
		expect(entry.completedTasks).toBe(3);
	});

	it('does not seed a new mirror from a finished local run left behind by the reducer', () => {
		useBatchStore.setState({
			batchRunStates: {
				'agent-1': mkLocalRun({ isRunning: false, documents: ['stale'], startTime: 111 }),
			},
		});

		applyAutoRunMirrorFrame('agent-1', mkFrame());

		const entry = useBatchStore.getState().batchRunStates['agent-1'];
		expect(entry.documents).toEqual([]);
		expect(entry.startTime).toBeUndefined();
	});

	it("leaves a finished local run in place rather than deleting the reducer's entry", () => {
		useBatchStore.setState({
			batchRunStates: { 'agent-1': mkLocalRun({ isRunning: false, sessionIds: ['s1'] }) },
		});

		applyAutoRunMirrorFrame('agent-1', null);

		expect(useBatchStore.getState().batchRunStates['agent-1']?.sessionIds).toEqual(['s1']);
	});

	it('mirrors each agent independently', () => {
		applyAutoRunMirrorFrame('agent-1', mkFrame({ completedTasks: 1 }));
		applyAutoRunMirrorFrame('agent-2', mkFrame({ completedTasks: 5 }));
		applyAutoRunMirrorFrame('agent-1', null);

		expect(useBatchStore.getState().batchRunStates['agent-1']).toBeUndefined();
		expect(useBatchStore.getState().batchRunStates['agent-2'].completedTasks).toBe(5);
	});
});

describe('mirrored runs light up the shared Auto Run surfaces', () => {
	it('counts toward the Left Bar / command palette active-batch selector', async () => {
		const { selectActiveBatchSessionIds, isMirroredBatchRun } =
			await import('../../../../renderer/stores/batchStore');

		applyAutoRunMirrorFrame('agent-1', mkFrame());

		expect(selectActiveBatchSessionIds(useBatchStore.getState())).toEqual(['agent-1']);
		expect(isMirroredBatchRun('agent-1')).toBe(true);
		expect(isMirroredBatchRun('agent-2')).toBe(false);
	});
});

describe('control actions refuse a mirrored run', () => {
	// The batch controls reach the run loop through refs that live in the owning
	// client. Acting on a mirror would dispatch a local state change and
	// re-broadcast it, overwriting the owner's state in main's tracker with a
	// stop that never happens.
	it('stopBatchRun leaves the mirror untouched and broadcasts nothing', async () => {
		const broadcastMock = vi.fn();
		(window as unknown as { maestro: unknown }).maestro = {
			web: { broadcastAutoRunState: broadcastMock },
			logger: { autorun: vi.fn() },
		};

		const { renderHook, act } = await import('@testing-library/react');
		const { useBatchControlActions } =
			await import('../../../../renderer/hooks/batch/internal/useBatchControlActions');

		applyAutoRunMirrorFrame('agent-1', mkFrame());

		const dispatch = vi.fn();
		const { result } = renderHook(() =>
			useBatchControlActions({
				broadcastAutoRunState: broadcastMock,
				dispatch,
				errorResolutionRefs: { current: {} },
				stopRequestedRefs: { current: {} },
				isMountedRef: { current: true },
			})
		);

		act(() => {
			result.current.stopBatchRun('agent-1');
			result.current.resumeAfterError('agent-1');
			result.current.abortBatchOnError('agent-1');
			result.current.skipCurrentDocument('agent-1');
		});

		expect(dispatch).not.toHaveBeenCalled();
		expect(broadcastMock).not.toHaveBeenCalled();
		expect(useBatchStore.getState().batchRunStates['agent-1'].isStopping).toBe(false);
	});

	it('still acts on a run this client owns', async () => {
		const broadcastMock = vi.fn();
		(window as unknown as { maestro: unknown }).maestro = {
			web: { broadcastAutoRunState: broadcastMock },
			logger: { autorun: vi.fn() },
		};

		const { renderHook, act } = await import('@testing-library/react');
		const { useBatchControlActions } =
			await import('../../../../renderer/hooks/batch/internal/useBatchControlActions');

		useBatchStore.setState({ batchRunStates: { 'agent-1': mkLocalRun() } });

		const dispatch = vi.fn();
		const stopRequestedRefs = { current: {} as Record<string, boolean> };
		const { result } = renderHook(() =>
			useBatchControlActions({
				broadcastAutoRunState: broadcastMock,
				dispatch,
				errorResolutionRefs: { current: {} },
				stopRequestedRefs,
				isMountedRef: { current: true },
			})
		);

		act(() => {
			result.current.stopBatchRun('agent-1');
		});

		expect(stopRequestedRefs.current['agent-1']).toBe(true);
		expect(dispatch).toHaveBeenCalledWith({ type: 'SET_STOPPING', sessionId: 'agent-1' });
	});
});

describe('reapStaleMirrors', () => {
	// Nothing tells main that a renderer holding a live run went away, so a
	// desktop reload mid-run leaves `isRunning: true` stored forever and replayed
	// to every client that connects. A mirroring client cannot clear that itself -
	// Stop is disabled and every mutator refuses a mirror - so the card would
	// stay up permanently while `useInputProcessing` queued every message behind
	// a run that will never drain.
	const STALE = 5 * 60_000 + 1_000;

	const setActiveProcesses = (processes: Array<{ sessionId: string }>) => {
		(window as unknown as { maestro: unknown }).maestro = {
			process: { getActiveProcesses: vi.fn().mockResolvedValue(processes) },
		};
	};

	it('drops a mirror that has gone quiet with no Auto Run process left', async () => {
		setActiveProcesses([]);
		applyAutoRunMirrorFrame('agent-1', mkFrame());

		await reapStaleMirrors(Date.now() + STALE);

		expect(useBatchStore.getState().batchRunStates['agent-1']).toBeUndefined();
	});

	it('keeps a quiet mirror whose agent still has a live Auto Run process', async () => {
		setActiveProcesses([{ sessionId: 'agent-1-batch-1700000000000' }]);
		applyAutoRunMirrorFrame('agent-1', mkFrame());

		await reapStaleMirrors(Date.now() + STALE);

		expect(useBatchStore.getState().batchRunStates['agent-1']?.mirrored).toBe(true);
	});

	it('keeps a mirror that is still receiving frames', async () => {
		setActiveProcesses([]);
		applyAutoRunMirrorFrame('agent-1', mkFrame());

		await reapStaleMirrors(Date.now());

		expect(useBatchStore.getState().batchRunStates['agent-1']?.mirrored).toBe(true);
	});

	it('keeps every mirror when the probe fails - that is "could not find out", not "nothing is running"', async () => {
		(window as unknown as { maestro: unknown }).maestro = {
			process: { getActiveProcesses: vi.fn().mockRejectedValue(new Error('bridge down')) },
		};
		applyAutoRunMirrorFrame('agent-1', mkFrame());

		await reapStaleMirrors(Date.now() + STALE);

		expect(useBatchStore.getState().batchRunStates['agent-1']?.mirrored).toBe(true);
	});

	it('never touches a run this client owns', async () => {
		setActiveProcesses([]);
		useBatchStore.setState({ batchRunStates: { 'agent-1': mkLocalRun({ completedTasks: 7 }) } });

		await reapStaleMirrors(Date.now() + STALE);

		expect(useBatchStore.getState().batchRunStates['agent-1']?.completedTasks).toBe(7);
	});

	it('matches the batch process by agent id, not by substring', async () => {
		// `agent-1-batch-...` must not keep `agent-11`'s mirror alive.
		setActiveProcesses([{ sessionId: 'agent-1-batch-1700000000000' }]);
		applyAutoRunMirrorFrame('agent-11', mkFrame());

		await reapStaleMirrors(Date.now() + STALE);

		expect(useBatchStore.getState().batchRunStates['agent-11']).toBeUndefined();
	});
});
