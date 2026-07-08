import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchRunState } from '../../renderer/types';
import { DEFAULT_BATCH_STATE } from '../../renderer/hooks/batch/batchReducer';
import { useBatchStore } from '../../renderer/stores/batchStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';

const capturedHooks = vi.hoisted(() => ({
	debounceOptions: undefined as
		| {
				onUpdate: (
					sessionId: string,
					updater: (prev: Record<string, BatchRunState>) => Record<string, BatchRunState>
				) => void;
		  }
		| undefined,
	timeTrackingOptions: undefined as
		| {
				getActiveSessionIds: () => string[];
				onTimeUpdate?: (
					sessionId: string,
					accumulatedMs: number,
					activeTimestamp: number | null
				) => void;
		  }
		| undefined,
	scheduleUpdate: vi.fn(),
	flushUpdate: vi.fn(),
	cancelUpdate: vi.fn(),
	startTracking: vi.fn(),
	stopTracking: vi.fn(),
	getElapsedTime: vi.fn(),
	getAccumulatedTime: vi.fn(),
	getLastActiveTimestamp: vi.fn(),
	isTracking: vi.fn(),
}));

vi.mock('../../renderer/hooks/batch/useSessionDebounce', () => ({
	useSessionDebounce: vi.fn((options) => {
		capturedHooks.debounceOptions = options;

		return {
			scheduleUpdate: capturedHooks.scheduleUpdate,
			flushUpdate: capturedHooks.flushUpdate,
			cancelUpdate: capturedHooks.cancelUpdate,
			isMounted: () => true,
		};
	}),
}));

vi.mock('../../renderer/hooks/batch/useTimeTracking', () => ({
	useTimeTracking: vi.fn((options) => {
		capturedHooks.timeTrackingOptions = options;

		return {
			startTracking: capturedHooks.startTracking,
			stopTracking: capturedHooks.stopTracking,
			getElapsedTime: capturedHooks.getElapsedTime,
			getAccumulatedTime: capturedHooks.getAccumulatedTime,
			getLastActiveTimestamp: capturedHooks.getLastActiveTimestamp,
			isTracking: capturedHooks.isTracking,
		};
	}),
}));

import { useBatchProcessor } from '../../renderer/hooks/batch/useBatchProcessor';

describe('useBatchProcessor callback integration', () => {
	let broadcastAutoRunState: ReturnType<typeof vi.fn>;

	const createBatchState = (overrides: Partial<BatchRunState> = {}): BatchRunState => ({
		...DEFAULT_BATCH_STATE,
		isRunning: true,
		processingState: 'RUNNING',
		documents: ['one.md'],
		totalTasks: 2,
		totalTasksAcrossAllDocs: 2,
		folderPath: '/project',
		lastActiveTimestamp: 100,
		...overrides,
	});

	const renderProcessor = () =>
		renderHook(() =>
			useBatchProcessor({
				sessions: [],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent: vi.fn(),
				onAddHistoryEntry: vi.fn(),
			})
		);

	beforeEach(() => {
		broadcastAutoRunState = vi.fn();
		capturedHooks.debounceOptions = undefined;
		capturedHooks.timeTrackingOptions = undefined;
		capturedHooks.scheduleUpdate.mockClear();
		capturedHooks.flushUpdate.mockClear();
		capturedHooks.cancelUpdate.mockClear();
		capturedHooks.startTracking.mockClear();
		capturedHooks.stopTracking.mockClear();
		capturedHooks.getElapsedTime.mockReturnValue(0);
		capturedHooks.getAccumulatedTime.mockReturnValue(0);
		capturedHooks.getLastActiveTimestamp.mockReturnValue(null);
		capturedHooks.isTracking.mockReturnValue(false);

		window.maestro = {
			...window.maestro,
			web: {
				...window.maestro.web,
				broadcastAutoRunState,
			},
		};
		useBatchStore.setState({
			batchRunStates: {},
			customPrompts: {},
			documentList: [],
			documentTree: [],
			isLoadingDocuments: false,
			documentTaskCounts: new Map(),
		});
		useSessionStore.setState({ sessions: [] });
	});

	afterEach(() => {
		cleanup();
		useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
		useSessionStore.setState({ sessions: [] });
	});

	it('applies debounced progress callback updates and broadcasts the computed state', () => {
		useBatchStore.setState({
			batchRunStates: {
				session1: createBatchState(),
			},
		});
		renderProcessor();

		expect(capturedHooks.debounceOptions).toBeDefined();

		act(() => {
			capturedHooks.debounceOptions!.onUpdate('session1', (prev) => ({
				...prev,
				session1: {
					...prev.session1,
					currentDocumentIndex: 1,
					currentDocTasksTotal: 3,
					currentDocTasksCompleted: 1,
					totalTasksAcrossAllDocs: 4,
					completedTasksAcrossAllDocs: 2,
					totalTasks: 3,
					completedTasks: 1,
					currentTaskIndex: 2,
					sessionIds: ['agent-session-1'],
					accumulatedElapsedMs: 500,
					lastActiveTimestamp: 600,
					loopIteration: 1,
				},
			}));
		});

		const state = useBatchStore.getState().batchRunStates.session1;
		expect(state.currentDocumentIndex).toBe(1);
		expect(state.completedTasksAcrossAllDocs).toBe(2);
		expect(state.sessionIds).toEqual(['agent-session-1']);
		expect(broadcastAutoRunState).toHaveBeenCalledWith(
			'session1',
			expect.objectContaining({
				isRunning: true,
				totalTasks: 3,
				completedTasks: 1,
				currentTaskIndex: 2,
				isStopping: false,
				totalDocuments: 1,
				currentDocumentIndex: 1,
				totalTasksAcrossAllDocs: 4,
				completedTasksAcrossAllDocs: 2,
			})
		);
	});

	it('logs debounced callback failures without broadcasting stale state', () => {
		useBatchStore.setState({
			batchRunStates: {
				session1: createBatchState(),
			},
		});
		renderProcessor();
		const error = new Error('bad updater');

		expect(capturedHooks.debounceOptions).toBeDefined();

		act(() => {
			capturedHooks.debounceOptions!.onUpdate('session1', () => {
				throw error;
			});
		});

		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[BatchProcessor:onUpdate] ERROR in debounce callback:',
			undefined,
			error
		);
		expect(broadcastAutoRunState).not.toHaveBeenCalled();
	});

	it('keeps unchanged debounced progress updates as no-op payloads', () => {
		const unchangedState = createBatchState({
			currentDocumentIndex: 1,
			currentDocTasksTotal: 2,
			currentDocTasksCompleted: 1,
			totalTasksAcrossAllDocs: 3,
			completedTasksAcrossAllDocs: 1,
			totalTasks: 3,
			completedTasks: 1,
			currentTaskIndex: 1,
			sessionIds: ['agent-session-1'],
			accumulatedElapsedMs: 250,
			lastActiveTimestamp: 300,
			loopIteration: 1,
		});
		useBatchStore.setState({
			batchRunStates: {
				session1: unchangedState,
			},
		});
		renderProcessor();

		expect(capturedHooks.debounceOptions).toBeDefined();

		act(() => {
			capturedHooks.debounceOptions!.onUpdate('session1', (prev) => ({
				...prev,
				session1: { ...prev.session1 },
			}));
		});

		expect(useBatchStore.getState().batchRunStates.session1).toEqual(unchangedState);
		expect(broadcastAutoRunState).toHaveBeenCalledWith(
			'session1',
			expect.objectContaining({
				isRunning: true,
				totalTasks: 3,
				completedTasks: 1,
				currentTaskIndex: 1,
				isStopping: false,
				totalDocuments: 1,
				currentDocumentIndex: 1,
				totalTasksAcrossAllDocs: 3,
				completedTasksAcrossAllDocs: 1,
			})
		);
	});

	it('broadcasts missing and completed debounced states through fallback paths', () => {
		renderProcessor();

		expect(capturedHooks.debounceOptions).toBeDefined();

		act(() => {
			capturedHooks.debounceOptions!.onUpdate('missing-session', (prev) => prev);
		});
		expect(broadcastAutoRunState).toHaveBeenCalledWith('missing-session', null);

		broadcastAutoRunState.mockClear();
		act(() => {
			capturedHooks.debounceOptions!.onUpdate('legacy-complete', (prev) => ({
				...prev,
				'legacy-complete': createBatchState({
					isRunning: false,
					processingState: 'IDLE',
					documents: undefined as unknown as string[],
					totalTasks: 1,
					completedTasks: 1,
					currentTaskIndex: 1,
					totalTasksAcrossAllDocs: 1,
					completedTasksAcrossAllDocs: 0,
				}),
			}));
		});
		expect(broadcastAutoRunState).toHaveBeenCalledWith(
			'legacy-complete',
			expect.objectContaining({
				isRunning: false,
				totalTasks: 1,
				completedTasks: 1,
				currentTaskIndex: 1,
				isStopping: false,
				totalDocuments: 0,
				currentDocumentIndex: 0,
				totalTasksAcrossAllDocs: 1,
				completedTasksAcrossAllDocs: 0,
			})
		);

		broadcastAutoRunState.mockClear();
		act(() => {
			capturedHooks.debounceOptions!.onUpdate('aggregate-complete', (prev) => ({
				...prev,
				'aggregate-complete': createBatchState({
					isRunning: false,
					processingState: 'IDLE',
					totalTasks: 1,
					completedTasks: 0,
					totalTasksAcrossAllDocs: 1,
					completedTasksAcrossAllDocs: 1,
				}),
			}));
		});
		expect(broadcastAutoRunState).toHaveBeenCalledWith(
			'aggregate-complete',
			expect.objectContaining({
				isRunning: false,
				totalTasks: 1,
				completedTasks: 0,
				currentTaskIndex: 0,
				isStopping: false,
				totalDocuments: 1,
				currentDocumentIndex: 0,
				totalTasksAcrossAllDocs: 1,
				completedTasksAcrossAllDocs: 1,
			})
		);
	});

	it('reports running sessions and applies time-tracking callback updates', () => {
		useBatchStore.setState({
			batchRunStates: {
				running: createBatchState({ completedTasksAcrossAllDocs: 1 }),
				stopped: createBatchState({ isRunning: false, completedTasksAcrossAllDocs: 1 }),
			},
		});
		renderProcessor();

		expect(capturedHooks.timeTrackingOptions).toBeDefined();
		expect(capturedHooks.timeTrackingOptions!.getActiveSessionIds()).toEqual(['running']);

		act(() => {
			capturedHooks.timeTrackingOptions!.onTimeUpdate?.('running', 1200, null);
		});
		expect(useBatchStore.getState().batchRunStates.running.accumulatedElapsedMs).toBe(1200);
		expect(useBatchStore.getState().batchRunStates.running.lastActiveTimestamp).toBe(100);

		act(() => {
			capturedHooks.timeTrackingOptions!.onTimeUpdate?.('running', 1500, 2500);
		});
		expect(useBatchStore.getState().batchRunStates.running.accumulatedElapsedMs).toBe(1500);
		expect(useBatchStore.getState().batchRunStates.running.lastActiveTimestamp).toBe(2500);
	});
});
