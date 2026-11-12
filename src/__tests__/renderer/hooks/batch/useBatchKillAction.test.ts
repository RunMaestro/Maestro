import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBatchKillAction } from '../../../../renderer/hooks/batch/internal/useBatchKillAction';
import type { AutoRunFlushState } from '../../../../renderer/hooks/batch/internal/batchFlushState';
import type { ErrorResolutionEntry } from '../../../../renderer/hooks/batch/internal/useBatchControlActions';

const endAutoRun = vi.fn(async () => undefined);
const getActiveProcesses = vi.fn(async () => [] as Array<{ sessionId: string }>);
const killProcess = vi.fn(async () => undefined);
const removeReason = vi.fn();
const getHistory = vi.fn(async () => [] as unknown[]);

beforeEach(() => {
	endAutoRun.mockReset();
	endAutoRun.mockResolvedValue(undefined);
	getActiveProcesses.mockReset();
	getActiveProcesses.mockResolvedValue([]);
	killProcess.mockReset();
	killProcess.mockResolvedValue(undefined);
	removeReason.mockReset();
	getHistory.mockReset();
	getHistory.mockResolvedValue([]);
	(window as unknown as { maestro: unknown }).maestro = {
		stats: { endAutoRun },
		process: { getActiveProcesses, kill: killProcess },
		power: { addReason: vi.fn(), removeReason },
		logger: { autorun: vi.fn(), log: vi.fn() },
		history: { getAll: getHistory },
	};
});

const mkFlush = (over: Partial<AutoRunFlushState> = {}): AutoRunFlushState => ({
	statsAutoRunId: 'stats-1',
	sessionName: 'demo',
	projectPath: '/repo',
	getCompletedTasks: () => 3,
	getTotalTasks: () => 5,
	getInputTokens: () => 100,
	getOutputTokens: () => 50,
	getTotalCost: () => 0.01,
	getDocumentsProcessed: () => 1,
	...over,
});

const setupHook = (override: { flushAtStart?: AutoRunFlushState | null } = {}) => {
	const broadcastAutoRunState = vi.fn();
	const flushDebouncedUpdate = vi.fn();
	const dispatch = vi.fn();
	const timeTracking = {
		startTracking: vi.fn(),
		stopTracking: vi.fn(),
		getElapsedTime: vi.fn(() => 12_345),
	};
	const autoRunFlushStateRefs = { current: {} as Record<string, AutoRunFlushState> };
	if (override.flushAtStart !== null) {
		autoRunFlushStateRefs.current.sess = override.flushAtStart ?? mkFlush();
	}
	const errorResolutionRefs = { current: {} as Record<string, ErrorResolutionEntry> };
	const stopRequestedRefs = { current: {} as Record<string, boolean> };
	const isMountedRef = { current: true };
	const onAddHistoryEntry = vi.fn();
	const onComplete = vi.fn();

	const hook = renderHook(() =>
		useBatchKillAction({
			broadcastAutoRunState,
			flushDebouncedUpdate,
			dispatch,
			timeTracking: timeTracking as never,
			autoRunFlushStateRefs,
			errorResolutionRefs,
			stopRequestedRefs,
			isMountedRef,
			onAddHistoryEntry,
			onComplete,
		})
	);

	return {
		hook,
		broadcastAutoRunState,
		flushDebouncedUpdate,
		dispatch,
		timeTracking,
		autoRunFlushStateRefs,
		errorResolutionRefs,
		stopRequestedRefs,
		isMountedRef,
		onAddHistoryEntry,
		onComplete,
	};
};

describe('useBatchKillAction', () => {
	it('claims the flush state, captures elapsed time, and writes the killed history entry', async () => {
		const { hook, autoRunFlushStateRefs, onAddHistoryEntry } = setupHook();

		await act(async () => {
			await hook.result.current.killBatchRun('sess');
		});

		// Flush ref is consumed.
		expect(autoRunFlushStateRefs.current.sess).toBeUndefined();
		// History entry written with the captured elapsed time, not zero.
		const entry = onAddHistoryEntry.mock.calls[0][0];
		expect(entry.summary).toContain('Auto Run killed');
		expect(entry.elapsedTimeMs).toBe(12_345);
		expect(entry.success).toBe(false);
	});

	it('calls stats.endAutoRun with the captured elapsed time before stopTracking', async () => {
		const { hook, timeTracking } = setupHook();

		await act(async () => {
			await hook.result.current.killBatchRun('sess');
		});

		expect(endAutoRun).toHaveBeenCalledWith('stats-1', 12_345, 3);
		// stopTracking happens AFTER endAutoRun in the runtime; assert ordering by call order.
		expect(endAutoRun.mock.invocationCallOrder[0]).toBeLessThan(
			timeTracking.stopTracking.mock.invocationCallOrder[0]
		);
	});

	it('fires onComplete with non-zero elapsed time and the snapshot stats', async () => {
		const { hook, onComplete } = setupHook();

		await act(async () => {
			await hook.result.current.killBatchRun('sess');
		});

		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(onComplete).toHaveBeenCalledWith({
			sessionId: 'sess',
			sessionName: 'demo',
			completedTasks: 3,
			totalTasks: 5,
			wasStopped: true,
			elapsedTimeMs: 12_345,
			inputTokens: 100,
			outputTokens: 50,
			totalCostUsd: 0.01,
			documentsProcessed: 1,
		});
	});

	it('uses persisted session history when it exceeds the in-memory kill snapshot', async () => {
		getHistory.mockResolvedValue([
			{
				type: 'AUTO',
				timestamp: 1000,
				summary: 'older task',
				elapsedTimeMs: 20_000,
				usageStats: {
					inputTokens: 500,
					outputTokens: 250,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 1.25,
					contextWindow: 0,
				},
			},
			{
				type: 'AUTO',
				timestamp: 2000,
				summary: 'newer task',
				elapsedTimeMs: 30_000,
				usageStats: {
					inputTokens: 700,
					outputTokens: 350,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 2.5,
					contextWindow: 0,
				},
			},
		]);
		const { hook, onAddHistoryEntry, onComplete } = setupHook({
			flushAtStart: mkFlush({
				getCompletedTasks: () => 1,
				getTotalTasks: () => 1,
				getInputTokens: () => 10,
				getOutputTokens: () => 5,
				getTotalCost: () => 0.01,
			}),
		});

		await act(async () => {
			await hook.result.current.killBatchRun('sess');
		});

		expect(getHistory).toHaveBeenCalledWith(undefined, 'sess');
		expect(endAutoRun).toHaveBeenCalledWith('stats-1', 50_000, 2);
		const entry = onAddHistoryEntry.mock.calls[0][0];
		expect(entry.summary).toContain('Auto Run killed: 2 tasks in');
		expect(entry.elapsedTimeMs).toBe(50_000);
		expect(entry.usageStats).toMatchObject({
			inputTokens: 1200,
			outputTokens: 600,
			totalCostUsd: 3.75,
		});
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				completedTasks: 2,
				totalTasks: 2,
				elapsedTimeMs: 50_000,
				inputTokens: 1200,
				outputTokens: 600,
				totalCostUsd: 3.75,
			})
		);
	});

	it('kills processes filtered by the session prefix', async () => {
		getActiveProcesses.mockResolvedValue([
			{ sessionId: 'sess' },
			{ sessionId: 'sess-batch-1' },
			{ sessionId: 'unrelated' },
		]);
		const { hook } = setupHook();

		await act(async () => {
			await hook.result.current.killBatchRun('sess');
		});

		expect(killProcess).toHaveBeenCalledWith('sess');
		expect(killProcess).toHaveBeenCalledWith('sess-batch-1');
		expect(killProcess).not.toHaveBeenCalledWith('unrelated');
	});

	it('falls back to the legacy direct ID when the active-process listing is empty', async () => {
		getActiveProcesses.mockResolvedValue([]);
		const { hook } = setupHook();

		await act(async () => {
			await hook.result.current.killBatchRun('sess');
		});

		expect(killProcess).toHaveBeenCalledWith('sess');
	});

	it('flushes debounced updates, dispatches COMPLETE_BATCH, broadcasts null, and removes the power reason', async () => {
		const { hook, flushDebouncedUpdate, dispatch, broadcastAutoRunState } = setupHook();

		await act(async () => {
			await hook.result.current.killBatchRun('sess');
		});

		expect(flushDebouncedUpdate).toHaveBeenCalledWith('sess');
		expect(dispatch).toHaveBeenCalledWith({
			type: 'COMPLETE_BATCH',
			sessionId: 'sess',
			finalSessionIds: [],
		});
		expect(broadcastAutoRunState).toHaveBeenCalledWith('sess', null);
		expect(removeReason).toHaveBeenCalledWith('autorun:sess');
	});

	it('intentionally does NOT delete stopRequestedRefs[sessionId] (loop relies on observing it)', async () => {
		const { hook, stopRequestedRefs } = setupHook();

		await act(async () => {
			await hook.result.current.killBatchRun('sess');
		});

		expect(stopRequestedRefs.current.sess).toBe(true);
	});

	it('resolves any pending error-resolution promise with abort', async () => {
		const { hook, errorResolutionRefs } = setupHook();
		const resolve = vi.fn();
		errorResolutionRefs.current.sess = {
			promise: new Promise(() => {}) as never,
			resolve,
		} as never;

		await act(async () => {
			await hook.result.current.killBatchRun('sess');
		});

		expect(resolve).toHaveBeenCalledWith('abort');
		expect(errorResolutionRefs.current.sess).toBeUndefined();
	});

	it('skips the flush block entirely when no flush state exists for the session', async () => {
		const { hook, onAddHistoryEntry, onComplete } = setupHook({ flushAtStart: null });

		await act(async () => {
			await hook.result.current.killBatchRun('sess');
		});

		expect(onAddHistoryEntry).not.toHaveBeenCalled();
		expect(onComplete).not.toHaveBeenCalled();
		// Process kill + cleanup still runs.
		expect(killProcess).toHaveBeenCalled();
	});

	it('sets the stop flag synchronously before any await fires', async () => {
		// Make every IPC await hang so we can observe the flag before any of them resolves.
		const neverResolve = new Promise(() => {});
		endAutoRun.mockReturnValue(neverResolve as never);
		getActiveProcesses.mockReturnValue(neverResolve as never);

		const { hook, stopRequestedRefs } = setupHook();
		// Fire-and-forget - don't await. The flag should already be set by the time
		// killBatchRun yields to the first `await`.
		void hook.result.current.killBatchRun('sess');

		expect(stopRequestedRefs.current.sess).toBe(true);
	});

	it('continues with COMPLETE_BATCH + broadcast + stopTracking even if onComplete throws', async () => {
		const onComplete = vi.fn(() => {
			throw new Error('downstream callback boom');
		});
		const broadcastAutoRunState = vi.fn();
		const flushDebouncedUpdate = vi.fn();
		const dispatch = vi.fn();
		const timeTracking = {
			startTracking: vi.fn(),
			stopTracking: vi.fn(),
			getElapsedTime: vi.fn(() => 7777),
		};
		const autoRunFlushStateRefs = {
			current: { sess: mkFlush() } as Record<string, AutoRunFlushState>,
		};
		const errorResolutionRefs = { current: {} as Record<string, ErrorResolutionEntry> };
		const stopRequestedRefs = { current: {} as Record<string, boolean> };
		const isMountedRef = { current: true };
		const onAddHistoryEntry = vi.fn();

		const { result } = renderHook(() =>
			useBatchKillAction({
				broadcastAutoRunState,
				flushDebouncedUpdate,
				dispatch,
				timeTracking: timeTracking as never,
				autoRunFlushStateRefs,
				errorResolutionRefs,
				stopRequestedRefs,
				isMountedRef,
				onAddHistoryEntry,
				onComplete,
			})
		);

		await act(async () => {
			await result.current.killBatchRun('sess');
		});

		expect(onComplete).toHaveBeenCalled();
		// Cleanup must still run despite the throw.
		expect(killProcess).toHaveBeenCalled();
		expect(flushDebouncedUpdate).toHaveBeenCalledWith('sess');
		expect(dispatch).toHaveBeenCalledWith({
			type: 'COMPLETE_BATCH',
			sessionId: 'sess',
			finalSessionIds: [],
		});
		expect(broadcastAutoRunState).toHaveBeenCalledWith('sess', null);
		expect(timeTracking.stopTracking).toHaveBeenCalledWith('sess');
	});
});
