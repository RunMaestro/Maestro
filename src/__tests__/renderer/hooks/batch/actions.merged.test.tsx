// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/batch/useBatchBroadcast.test.ts
// Source: src/__tests__/renderer/hooks/batch/useBatchControlActions.test.ts
// Source: src/__tests__/renderer/hooks/batch/useBatchKillAction.test.ts
// Source: src/__tests__/renderer/hooks/batch/useDocumentProcessor.steering.test.ts
// Source: src/__tests__/renderer/hooks/batch/useWorktreeManager.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook as s1_renderHook, act as s1_act } from '@testing-library/react';
import { useBatchBroadcast } from '../../../../renderer/hooks/batch/internal/useBatchBroadcast';
import { useBatchStore as s1_useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE as S1_DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import type { BatchRunState as S1_BatchRunState } from '../../../../renderer/types';
import { renderHook as s2_renderHook, act as s2_act } from '@testing-library/react';
import {
	useBatchControlActions,
	type ErrorResolutionEntry as S2_ErrorResolutionEntry,
} from '../../../../renderer/hooks/batch/internal/useBatchControlActions';
import { useBatchStore as s2_useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE as S2_DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import type { AgentError, BatchRunState as S2_BatchRunState } from '../../../../renderer/types';
import { renderHook as s3_renderHook, act as s3_act } from '@testing-library/react';
import { useBatchKillAction } from '../../../../renderer/hooks/batch/internal/useBatchKillAction';
import type { AutoRunFlushState } from '../../../../renderer/hooks/batch/internal/batchFlushState';
import type { ErrorResolutionEntry as S3_ErrorResolutionEntry } from '../../../../renderer/hooks/batch/internal/useBatchControlActions';
import { renderHook as s4_renderHook } from '@testing-library/react';
import { useDocumentProcessor } from '../../../../renderer/hooks/batch/useDocumentProcessor';
import { STEERING_BLOCK_START, STEERING_BLOCK_END } from '../../../../shared/autorunSteering';
import { createMockSession } from '../../../helpers/mockSession';
import { renderHook as s5_renderHook } from '@testing-library/react';
import { useWorktreeManager } from '../../../../renderer/hooks/batch/useWorktreeManager';
import type { BatchDocumentEntry } from '../../../../renderer/types';
// Source: src/__tests__/renderer/hooks/batch/useBatchBroadcast.test.ts
describe('', () => {
	const broadcastMock = vi.fn();
	beforeEach(() => {
		broadcastMock.mockReset();
		s1_useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
		(
			window as unknown as {
				maestro: unknown;
			}
		).maestro = {
			web: { broadcastAutoRunState: broadcastMock },
		};
	});
	const mkState = (over: Partial<S1_BatchRunState> = {}): S1_BatchRunState => ({
		...S1_DEFAULT_BATCH_STATE,
		isRunning: true,
		...over,
	});
	describe('useBatchBroadcast', () => {
		it('carries the fields a mirroring client needs to draw the whole card', () => {
			// A web-desktop client renders the same components the owner does, so the
			// broadcast has to carry more than the mobile progress bar needs. A field
			// dropped here is silently missing from the mirror.
			const dispatch = vi.fn();
			const { result } = s1_renderHook(() => useBatchBroadcast({ dispatch }));
			s1_act(() => {
				result.current.broadcastAutoRunState(
					'sess',
					mkState({
						documents: ['plan', 'cleanup'],
						lockedDocuments: ['plan'],
						currentDocTasksTotal: 3,
						currentDocTasksCompleted: 1,
						worktreeActive: true,
						worktreeBranch: 'auto/plan',
						startTime: 1700000000000,
						loopEnabled: true,
						loopIteration: 2,
					})
				);
			});
			expect(broadcastMock).toHaveBeenCalledWith(
				'sess',
				expect.objectContaining({
					documents: ['plan', 'cleanup'],
					lockedDocuments: ['plan'],
					currentDocTasksTotal: 3,
					currentDocTasksCompleted: 1,
					worktreeActive: true,
					worktreeBranch: 'auto/plan',
					startTime: 1700000000000,
					loopEnabled: true,
					loopIteration: 2,
				})
			);
		});
		it('broadcasts a populated payload when state is running', () => {
			const dispatch = vi.fn();
			const { result } = s1_renderHook(() => useBatchBroadcast({ dispatch }));
			s1_act(() => {
				result.current.broadcastAutoRunState(
					'sess',
					mkState({ totalTasks: 5, completedTasks: 2, currentTaskIndex: 2 })
				);
			});
			expect(broadcastMock).toHaveBeenCalledWith(
				'sess',
				expect.objectContaining({
					isRunning: true,
					totalTasks: 5,
					completedTasks: 2,
					currentTaskIndex: 2,
				})
			);
		});
		it('broadcasts null when state is null', () => {
			const dispatch = vi.fn();
			const { result } = s1_renderHook(() => useBatchBroadcast({ dispatch }));
			s1_act(() => result.current.broadcastAutoRunState('sess', null));
			expect(broadcastMock).toHaveBeenCalledWith('sess', null);
		});
		it('broadcasts null when state is not running and has no completed work', () => {
			const dispatch = vi.fn();
			const { result } = s1_renderHook(() => useBatchBroadcast({ dispatch }));
			s1_act(() => {
				result.current.broadcastAutoRunState(
					'sess',
					mkState({ isRunning: false, completedTasks: 0, completedTasksAcrossAllDocs: 0 })
				);
			});
			expect(broadcastMock).toHaveBeenCalledWith('sess', null);
		});
		it('broadcasts a populated payload when state has completed tasks even if not running', () => {
			const dispatch = vi.fn();
			const { result } = s1_renderHook(() => useBatchBroadcast({ dispatch }));
			s1_act(() => {
				result.current.broadcastAutoRunState(
					'sess',
					mkState({ isRunning: false, completedTasks: 3 })
				);
			});
			expect(broadcastMock).toHaveBeenCalledWith(
				'sess',
				expect.objectContaining({ isRunning: false, completedTasks: 3 })
			);
		});
		it('omits error fields when no error is present in state', () => {
			const dispatch = vi.fn();
			const { result } = s1_renderHook(() => useBatchBroadcast({ dispatch }));
			s1_act(() => {
				result.current.broadcastAutoRunState('sess', mkState());
			});
			const payload = broadcastMock.mock.calls[0][1];
			expect(payload.errorMessage).toBeUndefined();
			expect(payload.errorType).toBeUndefined();
			expect(payload.errorRecoverable).toBeUndefined();
		});
		it('flushDebouncedUpdate triggers any queued update synchronously', async () => {
			const dispatch = vi.fn();
			const { result } = s1_renderHook(() => useBatchBroadcast({ dispatch }));
			// Seed the store so the diffing path emits a non-undefined field.
			s1_useBatchStore.setState({ batchRunStates: { sess: mkState({ completedTasks: 0 }) } });
			s1_act(() => {
				result.current.updateBatchStateAndBroadcast('sess', (prev) => ({
					...prev,
					sess: { ...prev.sess, completedTasks: 7 },
				}));
			});
			// Nothing dispatched yet (debounced).
			expect(dispatch).not.toHaveBeenCalled();
			s1_act(() => {
				result.current.flushDebouncedUpdate('sess');
			});
			expect(dispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'UPDATE_PROGRESS',
					sessionId: 'sess',
					payload: expect.objectContaining({ completedTasks: 7 }),
				})
			);
		});
		it('immediate=true bypasses the debounce', () => {
			const dispatch = vi.fn();
			const { result } = s1_renderHook(() => useBatchBroadcast({ dispatch }));
			s1_useBatchStore.setState({ batchRunStates: { sess: mkState({ completedTasks: 0 }) } });
			s1_act(() => {
				result.current.updateBatchStateAndBroadcast(
					'sess',
					(prev) => ({ ...prev, sess: { ...prev.sess, completedTasks: 9 } }),
					true
				);
			});
			expect(dispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'UPDATE_PROGRESS',
					sessionId: 'sess',
					payload: expect.objectContaining({ completedTasks: 9 }),
				})
			);
		});
		it('only dispatches diff fields that actually changed', () => {
			const dispatch = vi.fn();
			const { result } = s1_renderHook(() => useBatchBroadcast({ dispatch }));
			s1_useBatchStore.setState({
				batchRunStates: { sess: mkState({ completedTasks: 5, totalTasks: 10 }) },
			});
			s1_act(() => {
				result.current.updateBatchStateAndBroadcast(
					'sess',
					(prev) => ({
						...prev,
						sess: { ...prev.sess, completedTasks: 6 },
					}),
					true
				);
			});
			const payload = (
				dispatch.mock.calls[0][0] as {
					payload: Record<string, unknown>;
				}
			).payload;
			expect(payload.completedTasks).toBe(6);
			// totalTasks didn't change → omitted
			expect(payload.totalTasks).toBeUndefined();
		});
		it('multi-session debounce isolation: flushing one session does not flush another', () => {
			const dispatch = vi.fn();
			const { result } = s1_renderHook(() => useBatchBroadcast({ dispatch }));
			s1_useBatchStore.setState({
				batchRunStates: { a: mkState({ completedTasks: 0 }), b: mkState({ completedTasks: 0 }) },
			});
			s1_act(() => {
				result.current.updateBatchStateAndBroadcast('a', (prev) => ({
					...prev,
					a: { ...prev.a, completedTasks: 1 },
				}));
				result.current.updateBatchStateAndBroadcast('b', (prev) => ({
					...prev,
					b: { ...prev.b, completedTasks: 2 },
				}));
			});
			expect(dispatch).not.toHaveBeenCalled();
			s1_act(() => result.current.flushDebouncedUpdate('a'));
			expect(dispatch).toHaveBeenCalledTimes(1);
			expect(dispatch.mock.calls[0][0].sessionId).toBe('a');
		});
	});
});
// Source: src/__tests__/renderer/hooks/batch/useBatchControlActions.test.ts
describe('', () => {
	const autorunLog = vi.fn();
	beforeEach(() => {
		autorunLog.mockReset();
		s2_useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
		(
			window as unknown as {
				maestro: unknown;
			}
		).maestro = {
			logger: { autorun: autorunLog, log: vi.fn() },
		};
	});
	const setupHook = () => {
		const broadcastAutoRunState = vi.fn();
		const dispatch = vi.fn();
		const errorResolutionRefs = { current: {} as Record<string, S2_ErrorResolutionEntry> };
		const stopRequestedRefs = { current: {} as Record<string, boolean> };
		const isMountedRef = { current: true };
		const timeTracking = { pauseTracking: vi.fn(), resumeTracking: vi.fn() };
		const hook = s2_renderHook(() =>
			useBatchControlActions({
				broadcastAutoRunState,
				dispatch,
				errorResolutionRefs,
				stopRequestedRefs,
				isMountedRef,
				timeTracking,
			})
		);
		return {
			hook,
			broadcastAutoRunState,
			dispatch,
			errorResolutionRefs,
			stopRequestedRefs,
			isMountedRef,
			timeTracking,
		};
	};
	const mkRunningState = (over: Partial<S2_BatchRunState> = {}): S2_BatchRunState => ({
		...S2_DEFAULT_BATCH_STATE,
		isRunning: true,
		...over,
	});
	const mkError = (over: Partial<AgentError> = {}): AgentError => ({
		type: 'context-window' as never,
		message: 'context limit',
		recoverable: true,
		raw: 'raw',
		...over,
	});
	describe('useBatchControlActions', () => {
		it('stopBatchRun sets stopRequestedRefs, resolves any pending error, dispatches SET_STOPPING and broadcasts', () => {
			s2_useBatchStore.setState({ batchRunStates: { sess: mkRunningState() } });
			const { hook, dispatch, broadcastAutoRunState, errorResolutionRefs, stopRequestedRefs } =
				setupHook();
			const resolve = vi.fn();
			errorResolutionRefs.current.sess = {
				promise: new Promise(() => {}) as never,
				resolve,
			};
			s2_act(() => hook.result.current.stopBatchRun('sess'));
			expect(stopRequestedRefs.current.sess).toBe(true);
			expect(resolve).toHaveBeenCalledWith('abort');
			expect(errorResolutionRefs.current.sess).toBeUndefined();
			expect(dispatch).toHaveBeenCalledWith({ type: 'SET_STOPPING', sessionId: 'sess' });
			expect(broadcastAutoRunState).toHaveBeenCalledWith(
				'sess',
				expect.objectContaining({ isStopping: true })
			);
		});
		it('stopBatchRun is a no-op for the broadcast when no batch state exists', () => {
			const { hook, broadcastAutoRunState } = setupHook();
			s2_act(() => hook.result.current.stopBatchRun('sess'));
			expect(broadcastAutoRunState).not.toHaveBeenCalled();
		});
		it('pauseBatchOnError dispatches SET_ERROR with payload and creates an error-resolution promise', () => {
			s2_useBatchStore.setState({ batchRunStates: { sess: mkRunningState() } });
			const { hook, dispatch, broadcastAutoRunState, errorResolutionRefs, timeTracking } =
				setupHook();
			const error = mkError();
			s2_act(() => hook.result.current.pauseBatchOnError('sess', error, 0, 'task'));
			// A paused run is not running: its clock stops.
			expect(timeTracking.pauseTracking).toHaveBeenCalledWith('sess');
			expect(dispatch).toHaveBeenCalledWith({
				type: 'SET_ERROR',
				sessionId: 'sess',
				payload: { error, documentIndex: 0, taskDescription: 'task' },
			});
			expect(broadcastAutoRunState).toHaveBeenCalledWith(
				'sess',
				expect.objectContaining({ errorPaused: true, errorDocumentIndex: 0 })
			);
			expect(errorResolutionRefs.current.sess).toBeDefined();
			expect(autorunLog).toHaveBeenCalled();
		});
		it('pauseBatchOnError is idempotent - does not replace an existing resolution promise', () => {
			const { hook, errorResolutionRefs } = setupHook();
			const error = mkError();
			s2_act(() => hook.result.current.pauseBatchOnError('sess', error, 0));
			const first = errorResolutionRefs.current.sess;
			s2_act(() => hook.result.current.pauseBatchOnError('sess', error, 0));
			expect(errorResolutionRefs.current.sess).toBe(first);
		});
		it('skipCurrentDocument dispatches CLEAR_ERROR and resolves the promise with skip-document', async () => {
			s2_useBatchStore.setState({ batchRunStates: { sess: mkRunningState() } });
			const { hook, dispatch, errorResolutionRefs, timeTracking } = setupHook();
			s2_act(() => hook.result.current.pauseBatchOnError('sess', mkError(), 0));
			const entry = errorResolutionRefs.current.sess;
			expect(entry).toBeDefined();
			s2_act(() => hook.result.current.skipCurrentDocument('sess'));
			expect(timeTracking.resumeTracking).toHaveBeenCalledWith('sess');
			expect(dispatch).toHaveBeenCalledWith({ type: 'CLEAR_ERROR', sessionId: 'sess' });
			await expect(entry!.promise).resolves.toBe('skip-document');
			expect(errorResolutionRefs.current.sess).toBeUndefined();
		});
		it('resumeAfterError dispatches CLEAR_ERROR and resolves with resume', async () => {
			s2_useBatchStore.setState({ batchRunStates: { sess: mkRunningState() } });
			const { hook, dispatch, errorResolutionRefs, timeTracking } = setupHook();
			s2_act(() => hook.result.current.pauseBatchOnError('sess', mkError(), 0));
			const entry = errorResolutionRefs.current.sess;
			s2_act(() => hook.result.current.resumeAfterError('sess'));
			expect(timeTracking.resumeTracking).toHaveBeenCalledWith('sess');
			expect(dispatch).toHaveBeenCalledWith({ type: 'CLEAR_ERROR', sessionId: 'sess' });
			await expect(entry!.promise).resolves.toBe('resume');
		});
		it('abortBatchOnError dispatches SET_STOPPING, sets stopRequestedRefs, and resolves with abort', async () => {
			s2_useBatchStore.setState({ batchRunStates: { sess: mkRunningState() } });
			const { hook, dispatch, errorResolutionRefs, stopRequestedRefs } = setupHook();
			s2_act(() => hook.result.current.pauseBatchOnError('sess', mkError(), 0));
			const entry = errorResolutionRefs.current.sess;
			s2_act(() => hook.result.current.abortBatchOnError('sess'));
			expect(stopRequestedRefs.current.sess).toBe(true);
			expect(dispatch).toHaveBeenCalledWith({ type: 'SET_STOPPING', sessionId: 'sess' });
			await expect(entry!.promise).resolves.toBe('abort');
		});
		it('isMountedRef=false short-circuits pause/skip/resume/abort (but stopBatchRun still runs)', () => {
			s2_useBatchStore.setState({ batchRunStates: { sess: mkRunningState() } });
			const broadcastAutoRunState = vi.fn();
			const dispatch = vi.fn();
			const errorResolutionRefs = { current: {} as Record<string, S2_ErrorResolutionEntry> };
			const stopRequestedRefs = { current: {} as Record<string, boolean> };
			const isMountedRef = { current: false };
			const { result } = s2_renderHook(() =>
				useBatchControlActions({
					broadcastAutoRunState,
					dispatch,
					errorResolutionRefs,
					stopRequestedRefs,
					isMountedRef,
					timeTracking: { pauseTracking: vi.fn(), resumeTracking: vi.fn() },
				})
			);
			s2_act(() => result.current.pauseBatchOnError('sess', mkError(), 0));
			s2_act(() => result.current.skipCurrentDocument('sess'));
			s2_act(() => result.current.resumeAfterError('sess'));
			s2_act(() => result.current.abortBatchOnError('sess'));
			expect(dispatch).not.toHaveBeenCalled();
			// stopBatchRun bypasses isMountedRef.
			s2_act(() => result.current.stopBatchRun('sess'));
			expect(dispatch).toHaveBeenCalledWith({ type: 'SET_STOPPING', sessionId: 'sess' });
		});
		it('logs an autorun message for each control action', () => {
			const { hook } = setupHook();
			s2_act(() => hook.result.current.pauseBatchOnError('sess', mkError(), 0));
			s2_act(() => hook.result.current.skipCurrentDocument('sess'));
			s2_act(() => hook.result.current.resumeAfterError('sess'));
			s2_act(() => hook.result.current.abortBatchOnError('sess'));
			expect(autorunLog.mock.calls.length).toBeGreaterThanOrEqual(4);
		});
	});
});
// Source: src/__tests__/renderer/hooks/batch/useBatchKillAction.test.ts
describe('', () => {
	const endAutoRun = vi.fn(async () => undefined);
	const getActiveProcesses = vi.fn(
		async () =>
			[] as Array<{
				sessionId: string;
			}>
	);
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
		(
			window as unknown as {
				maestro: unknown;
			}
		).maestro = {
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
	const setupHook = (
		override: {
			flushAtStart?: AutoRunFlushState | null;
		} = {}
	) => {
		const broadcastAutoRunState = vi.fn();
		const flushDebouncedUpdate = vi.fn();
		const dispatch = vi.fn();
		const timeTracking = {
			startTracking: vi.fn(),
			stopTracking: vi.fn(),
			getElapsedTime: vi.fn(() => 12345),
		};
		const autoRunFlushStateRefs = { current: {} as Record<string, AutoRunFlushState> };
		if (override.flushAtStart !== null) {
			autoRunFlushStateRefs.current.sess = override.flushAtStart ?? mkFlush();
		}
		const errorResolutionRefs = { current: {} as Record<string, S3_ErrorResolutionEntry> };
		const stopRequestedRefs = { current: {} as Record<string, boolean> };
		const isMountedRef = { current: true };
		const onAddHistoryEntry = vi.fn();
		const onComplete = vi.fn();
		const hook = s3_renderHook(() =>
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
			await s3_act(async () => {
				await hook.result.current.killBatchRun('sess');
			});
			// Flush ref is consumed.
			expect(autoRunFlushStateRefs.current.sess).toBeUndefined();
			// History entry written with the captured elapsed time, not zero.
			const entry = onAddHistoryEntry.mock.calls[0][0];
			expect(entry.summary).toContain('Auto Run killed');
			expect(entry.elapsedTimeMs).toBe(12345);
			expect(entry.success).toBe(false);
		});
		it('calls stats.endAutoRun with the captured elapsed time before stopTracking', async () => {
			const { hook, timeTracking } = setupHook();
			await s3_act(async () => {
				await hook.result.current.killBatchRun('sess');
			});
			expect(endAutoRun).toHaveBeenCalledWith('stats-1', 12345, 3);
			// stopTracking happens AFTER endAutoRun in the runtime; assert ordering by call order.
			expect(endAutoRun.mock.invocationCallOrder[0]).toBeLessThan(
				timeTracking.stopTracking.mock.invocationCallOrder[0]
			);
		});
		it('fires onComplete with non-zero elapsed time and the snapshot stats', async () => {
			const { hook, onComplete } = setupHook();
			await s3_act(async () => {
				await hook.result.current.killBatchRun('sess');
			});
			expect(onComplete).toHaveBeenCalledTimes(1);
			expect(onComplete).toHaveBeenCalledWith({
				sessionId: 'sess',
				sessionName: 'demo',
				completedTasks: 3,
				totalTasks: 5,
				wasStopped: true,
				elapsedTimeMs: 12345,
				inputTokens: 100,
				outputTokens: 50,
				totalCostUsd: 0.01,
				documentsProcessed: 1,
			});
		});
		it('carries the kind the runner registered in its flush state', async () => {
			const { hook, onComplete } = setupHook({ flushAtStart: mkFlush({ kind: 'goal-driven' }) });
			await s3_act(async () => {
				await hook.result.current.killBatchRun('sess');
			});
			expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ kind: 'goal-driven' }));
		});
		it('leaves kind undefined when the flush state has none', async () => {
			const { hook, onComplete } = setupHook();
			await s3_act(async () => {
				await hook.result.current.killBatchRun('sess');
			});
			expect(onComplete.mock.calls[0][0].kind).toBeUndefined();
		});
		it('uses persisted session history when it exceeds the in-memory kill snapshot', async () => {
			getHistory.mockResolvedValue([
				{
					type: 'AUTO',
					timestamp: 1000,
					summary: 'older task',
					elapsedTimeMs: 20000,
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
					elapsedTimeMs: 30000,
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
			await s3_act(async () => {
				await hook.result.current.killBatchRun('sess');
			});
			expect(getHistory).toHaveBeenCalledWith(undefined, 'sess');
			expect(endAutoRun).toHaveBeenCalledWith('stats-1', 50000, 2);
			const entry = onAddHistoryEntry.mock.calls[0][0];
			expect(entry.summary).toContain('Auto Run killed: 2 tasks in');
			expect(entry.elapsedTimeMs).toBe(50000);
			expect(entry.usageStats).toMatchObject({
				inputTokens: 1200,
				outputTokens: 600,
				totalCostUsd: 3.75,
			});
			expect(onComplete).toHaveBeenCalledWith(
				expect.objectContaining({
					completedTasks: 2,
					totalTasks: 2,
					elapsedTimeMs: 50000,
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
			await s3_act(async () => {
				await hook.result.current.killBatchRun('sess');
			});
			expect(killProcess).toHaveBeenCalledWith('sess');
			expect(killProcess).toHaveBeenCalledWith('sess-batch-1');
			expect(killProcess).not.toHaveBeenCalledWith('unrelated');
		});
		it('falls back to the legacy direct ID when the active-process listing is empty', async () => {
			getActiveProcesses.mockResolvedValue([]);
			const { hook } = setupHook();
			await s3_act(async () => {
				await hook.result.current.killBatchRun('sess');
			});
			expect(killProcess).toHaveBeenCalledWith('sess');
		});
		it('flushes debounced updates, dispatches COMPLETE_BATCH, broadcasts null, and removes the power reason', async () => {
			const { hook, flushDebouncedUpdate, dispatch, broadcastAutoRunState } = setupHook();
			await s3_act(async () => {
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
			await s3_act(async () => {
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
			await s3_act(async () => {
				await hook.result.current.killBatchRun('sess');
			});
			expect(resolve).toHaveBeenCalledWith('abort');
			expect(errorResolutionRefs.current.sess).toBeUndefined();
		});
		it('skips the flush block entirely when no flush state exists for the session', async () => {
			const { hook, onAddHistoryEntry, onComplete } = setupHook({ flushAtStart: null });
			await s3_act(async () => {
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
			const errorResolutionRefs = { current: {} as Record<string, S3_ErrorResolutionEntry> };
			const stopRequestedRefs = { current: {} as Record<string, boolean> };
			const isMountedRef = { current: true };
			const onAddHistoryEntry = vi.fn();
			const { result } = s3_renderHook(() =>
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
			await s3_act(async () => {
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
});
// Source: src/__tests__/renderer/hooks/batch/useDocumentProcessor.steering.test.ts
describe('', () => {
	const DOC_CONTENT = '- [ ] Do the thing\n';
	function mockAutorunIpc(): void {
		window.maestro = {
			...window.maestro,
			autorun: {
				...window.maestro?.autorun,
				readDoc: vi.fn().mockResolvedValue({ success: true, content: DOC_CONTENT }),
				writeDoc: vi.fn().mockResolvedValue({ success: true }),
			},
			agentSessions: {
				...window.maestro?.agentSessions,
				registerSessionOrigin: vi.fn().mockResolvedValue(undefined),
			},
		} as typeof window.maestro;
	}
	describe('useDocumentProcessor - steering notes', () => {
		const onSpawnAgent = vi.fn();
		beforeEach(() => {
			vi.clearAllMocks();
			mockAutorunIpc();
			onSpawnAgent.mockResolvedValue({ success: true, response: 'Did the thing.' });
		});
		const runTask = async (steeringNotes?: Parameters<typeof baseConfig>[0]) => {
			const { result } = s4_renderHook(() => useDocumentProcessor());
			await result.current.processTask(baseConfig(steeringNotes), 'phase-1', 0, 1, DOC_CONTENT, {
				onSpawnAgent,
			});
			return onSpawnAgent.mock.calls[0][1] as string;
		};
		function baseConfig(
			steeringNotes?: {
				id: string;
				text: string;
				timestamp: number;
			}[]
		) {
			const session = createMockSession({ cwd: '/test/project' });
			return {
				folderPath: '/test/project/.maestro/playbooks',
				session,
				loopIteration: 1,
				effectiveCwd: session.cwd,
				customPrompt: 'Work the document.',
				...(steeringNotes && { steeringNotes }),
			};
		}
		it('sends the prompt unchanged when there are no notes', async () => {
			const prompt = await runTask();
			expect(prompt).toBe('Work the document.');
			expect(prompt).not.toContain(STEERING_BLOCK_START);
		});
		it('prepends the note block ahead of the prompt', async () => {
			const prompt = await runTask([
				{ id: 'n1', text: 'Important notice: Maestro error.', timestamp: Date.now() },
			]);
			expect(prompt.startsWith(STEERING_BLOCK_START)).toBe(true);
			expect(prompt).toContain('Important notice: Maestro error.');
			// The note comes FIRST - the base prompt follows it.
			expect(prompt.indexOf(STEERING_BLOCK_END)).toBeLessThan(prompt.indexOf('Work the document.'));
		});
		it('leaves template syntax inside a note unexpanded', async () => {
			// Notes are prepended AFTER substitution on purpose: `{{GIT_BRANCH}}` the
			// operator typed is their literal text, not a variable to expand.
			const prompt = await runTask([
				{ id: 'n1', text: 'mention {{GIT_BRANCH}} verbatim', timestamp: Date.now() },
			]);
			expect(prompt).toContain('mention {{GIT_BRANCH}} verbatim');
		});
	});
});
// Source: src/__tests__/renderer/hooks/batch/useWorktreeManager.test.ts
describe('', () => {
	const singleDoc: BatchDocumentEntry[] = [{ filename: 'auth-module', resetOnCompletion: false }];
	const twoDocs: BatchDocumentEntry[] = [
		{ filename: 'auth-module', resetOnCompletion: false },
		{ filename: 'db-migration', resetOnCompletion: false },
	];
	const manyDocs: BatchDocumentEntry[] = [
		{ filename: 'auth-module', resetOnCompletion: false },
		{ filename: 'db-migration', resetOnCompletion: false },
		{ filename: 'api-routes', resetOnCompletion: false },
		{ filename: 'frontend-ui', resetOnCompletion: false },
	];
	describe('useWorktreeManager - PR generation', () => {
		describe('generatePRTitle', () => {
			it('includes branch name and document name for single doc', () => {
				const { result } = s5_renderHook(() => useWorktreeManager());
				const title = result.current.generatePRTitle('feature/auth', singleDoc, 5);
				expect(title).toBe('feature/auth: 5 tasks completed in auth-module');
			});
			it('lists both document names for two docs', () => {
				const { result } = s5_renderHook(() => useWorktreeManager());
				const title = result.current.generatePRTitle('feature/auth', twoDocs, 12);
				expect(title).toBe('feature/auth: 12 tasks across auth-module, db-migration');
			});
			it('truncates with "+N more" for three or more docs', () => {
				const { result } = s5_renderHook(() => useWorktreeManager());
				const title = result.current.generatePRTitle('feature/auth', manyDocs, 20);
				expect(title).toBe('feature/auth: 20 tasks across auth-module, db-migration +2 more');
			});
			it('uses singular "task" for 1 completed task', () => {
				const { result } = s5_renderHook(() => useWorktreeManager());
				const title = result.current.generatePRTitle('hotfix/typo', singleDoc, 1);
				expect(title).toContain('1 task completed');
			});
			it('falls back to "Auto Run" when branch name is undefined', () => {
				const { result } = s5_renderHook(() => useWorktreeManager());
				const title = result.current.generatePRTitle(undefined, singleDoc, 3);
				expect(title).toMatch(/^Auto Run:/);
			});
		});
		describe('generatePRBody', () => {
			it('includes document list and task count', () => {
				const { result } = s5_renderHook(() => useWorktreeManager());
				const body = result.current.generatePRBody(twoDocs, 8);
				expect(body).toContain('- auth-module');
				expect(body).toContain('- db-migration');
				expect(body).toContain('**Total tasks completed:** 8');
			});
			it('includes commit subjects when provided', () => {
				const { result } = s5_renderHook(() => useWorktreeManager());
				const commits = ['Add login endpoint', 'Fix password hashing', 'Update tests'];
				const body = result.current.generatePRBody(singleDoc, 3, commits);
				expect(body).toContain('## Changes');
				expect(body).toContain('- Add login endpoint');
				expect(body).toContain('- Fix password hashing');
				expect(body).toContain('- Update tests');
			});
			it('omits Changes section when no commits provided', () => {
				const { result } = s5_renderHook(() => useWorktreeManager());
				const body = result.current.generatePRBody(singleDoc, 1);
				expect(body).not.toContain('## Changes');
			});
			it('omits Changes section for empty commit list', () => {
				const { result } = s5_renderHook(() => useWorktreeManager());
				const body = result.current.generatePRBody(singleDoc, 1, []);
				expect(body).not.toContain('## Changes');
			});
			it('includes Maestro attribution footer', () => {
				const { result } = s5_renderHook(() => useWorktreeManager());
				const body = result.current.generatePRBody(singleDoc, 1);
				expect(body).toContain('Maestro');
				expect(body).toContain('Auto Run');
			});
		});
	});
});
