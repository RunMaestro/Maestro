// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/batch/batchReducer.test.ts
// Source: src/__tests__/renderer/hooks/batch/useAutoRunHandlers.refresh.test.ts
// Source: src/__tests__/renderer/hooks/batch/useAutoRunStateMirror.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	batchReducer,
	DEFAULT_BATCH_STATE as S1_DEFAULT_BATCH_STATE,
	type BatchState,
} from '../../../../renderer/hooks/batch/batchReducer';
import type { AgentError } from '../../../../renderer/types';
import { renderHook, act } from '@testing-library/react';
import { useAutoRunHandlers } from '../../../../renderer/hooks';
import type { Session } from '../../../../renderer/types';
import { createMockSession } from '../../../helpers/mockSession';
import { useBatchStore as s2_useBatchStore } from '../../../../renderer/stores/batchStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import {
	applyAutoRunMirrorFrame,
	buildMirroredBatchState,
	reapStaleMirrors,
	resetMirrorFrameClock,
} from '../../../../renderer/hooks/batch/useAutoRunStateMirror';
import { useBatchStore as s3_useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE as S3_DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import type { AutoRunBroadcastState } from '../../../../shared/autoRunBroadcast';
import type { BatchRunState } from '../../../../renderer/types';
// Source: src/__tests__/renderer/hooks/batch/batchReducer.test.ts
describe('', () => {
	describe('batchReducer', () => {
		// ============================================================================
		// START_BATCH action tests
		// ============================================================================
		describe('START_BATCH', () => {
			it('should initialize batch state for a new session', () => {
				const initialState: BatchState = {};
				const result = batchReducer(initialState, {
					type: 'START_BATCH',
					sessionId: 'session-1',
					payload: {
						documents: ['doc1.md', 'doc2.md'],
						lockedDocuments: ['doc1.md', 'doc2.md'],
						totalTasksAcrossAllDocs: 10,
						loopEnabled: false,
						maxLoops: null,
						folderPath: '/test/folder',
						worktreeActive: false,
						worktreePath: undefined,
						worktreeBranch: undefined,
						startTime: 1000,
						cumulativeTaskTimeMs: 0,
						accumulatedElapsedMs: 0,
						lastActiveTimestamp: 1000,
					},
				});
				expect(result['session-1']).toBeDefined();
				expect(result['session-1'].isRunning).toBe(true);
				expect(result['session-1'].isStopping).toBe(false);
				expect(result['session-1'].documents).toEqual(['doc1.md', 'doc2.md']);
				expect(result['session-1'].totalTasksAcrossAllDocs).toBe(10);
				expect(result['session-1'].completedTasksAcrossAllDocs).toBe(0);
				expect(result['session-1'].initialCompletedTasks).toBe(0);
				expect(result['session-1'].processingState).toBe('INITIALIZING');
			});
			it('records pre-checked tasks as the ETA baseline', () => {
				const result = batchReducer(
					{},
					{
						type: 'START_BATCH',
						sessionId: 'session-1',
						payload: {
							documents: ['doc1.md'],
							lockedDocuments: ['doc1.md'],
							totalTasksAcrossAllDocs: 10,
							completedTasksAcrossAllDocs: 4,
							loopEnabled: false,
							maxLoops: null,
							folderPath: '/test/folder',
							worktreeActive: false,
							startTime: 1000,
							cumulativeTaskTimeMs: 0,
							accumulatedElapsedMs: 0,
							lastActiveTimestamp: 1000,
						},
					}
				);
				expect(result['session-1'].completedTasksAcrossAllDocs).toBe(4);
				expect(result['session-1'].initialCompletedTasks).toBe(4);
			});
			it('should preserve other sessions when starting a new batch', () => {
				const initialState: BatchState = {
					'existing-session': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						completedTasksAcrossAllDocs: 5,
					},
				};
				const result = batchReducer(initialState, {
					type: 'START_BATCH',
					sessionId: 'session-1',
					payload: {
						documents: ['doc1.md'],
						lockedDocuments: ['doc1.md'],
						totalTasksAcrossAllDocs: 10,
						loopEnabled: false,
						maxLoops: null,
						folderPath: '/test/folder',
						worktreeActive: false,
						startTime: 1000,
						cumulativeTaskTimeMs: 0,
						accumulatedElapsedMs: 0,
						lastActiveTimestamp: 1000,
					},
				});
				expect(result['existing-session'].completedTasksAcrossAllDocs).toBe(5);
				expect(result['session-1'].completedTasksAcrossAllDocs).toBe(0);
			});
			it('should initialize completedTasksAcrossAllDocs from payload when provided', () => {
				const initialState: BatchState = {};
				const result = batchReducer(initialState, {
					type: 'START_BATCH',
					sessionId: 'session-1',
					payload: {
						documents: ['doc1.md'],
						lockedDocuments: ['doc1.md'],
						totalTasksAcrossAllDocs: 46,
						completedTasksAcrossAllDocs: 4,
						loopEnabled: false,
						maxLoops: null,
						folderPath: '/test/folder',
						worktreeActive: false,
						startTime: 1000,
						cumulativeTaskTimeMs: 0,
						accumulatedElapsedMs: 0,
						lastActiveTimestamp: 1000,
					},
				});
				expect(result['session-1'].totalTasksAcrossAllDocs).toBe(46);
				expect(result['session-1'].completedTasksAcrossAllDocs).toBe(4);
			});
		});
		// ============================================================================
		// UPDATE_PROGRESS action tests - Critical for progress bar bug prevention
		// ============================================================================
		describe('UPDATE_PROGRESS', () => {
			it('should update completedTasksAcrossAllDocs when provided', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						totalTasksAcrossAllDocs: 10,
						completedTasksAcrossAllDocs: 0,
					},
				};
				const result = batchReducer(initialState, {
					type: 'UPDATE_PROGRESS',
					sessionId: 'session-1',
					payload: {
						completedTasksAcrossAllDocs: 5,
					},
				});
				expect(result['session-1'].completedTasksAcrossAllDocs).toBe(5);
			});
			it('should NOT update completedTasksAcrossAllDocs when undefined', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						completedTasksAcrossAllDocs: 5,
					},
				};
				const result = batchReducer(initialState, {
					type: 'UPDATE_PROGRESS',
					sessionId: 'session-1',
					payload: {
						totalTasksAcrossAllDocs: 20, // Only updating total, not completed
					},
				});
				// Should keep the existing completed count
				expect(result['session-1'].completedTasksAcrossAllDocs).toBe(5);
				expect(result['session-1'].totalTasksAcrossAllDocs).toBe(20);
			});
			it('clears lastActiveTimestamp on null (paused) and keeps it on undefined', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						accumulatedElapsedMs: 0,
						lastActiveTimestamp: 1000,
					},
				};
				const kept = batchReducer(initialState, {
					type: 'UPDATE_PROGRESS',
					sessionId: 'session-1',
					payload: { completedTasksAcrossAllDocs: 1 },
				});
				expect(kept['session-1'].lastActiveTimestamp).toBe(1000);
				const paused = batchReducer(initialState, {
					type: 'UPDATE_PROGRESS',
					sessionId: 'session-1',
					payload: { accumulatedElapsedMs: 5000, lastActiveTimestamp: null },
				});
				expect(paused['session-1'].accumulatedElapsedMs).toBe(5000);
				expect(paused['session-1'].lastActiveTimestamp).toBeUndefined();
			});
			it('should handle multiple sequential progress updates correctly', () => {
				let state: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						totalTasksAcrossAllDocs: 17,
						completedTasksAcrossAllDocs: 0,
					},
				};
				// Simulate 17 tasks completing one by one
				for (let i = 1; i <= 17; i++) {
					state = batchReducer(state, {
						type: 'UPDATE_PROGRESS',
						sessionId: 'session-1',
						payload: {
							completedTasksAcrossAllDocs: i,
						},
					});
					expect(state['session-1'].completedTasksAcrossAllDocs).toBe(i);
				}
				expect(state['session-1'].completedTasksAcrossAllDocs).toBe(17);
			});
			it('should handle rapid updates without losing progress', () => {
				let state: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						totalTasksAcrossAllDocs: 100,
						completedTasksAcrossAllDocs: 0,
					},
				};
				// Simulate rapid batch of updates
				const updates = [1, 5, 10, 25, 50, 75, 100];
				for (const completed of updates) {
					state = batchReducer(state, {
						type: 'UPDATE_PROGRESS',
						sessionId: 'session-1',
						payload: {
							completedTasksAcrossAllDocs: completed,
						},
					});
				}
				expect(state['session-1'].completedTasksAcrossAllDocs).toBe(100);
			});
			it('should return unchanged state for unknown session', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						completedTasksAcrossAllDocs: 5,
					},
				};
				const result = batchReducer(initialState, {
					type: 'UPDATE_PROGRESS',
					sessionId: 'unknown-session',
					payload: {
						completedTasksAcrossAllDocs: 10,
					},
				});
				// Should return the same state reference when session doesn't exist
				expect(result).toBe(initialState);
			});
			it('should update all provided fields in a single update', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						totalTasksAcrossAllDocs: 10,
						completedTasksAcrossAllDocs: 0,
						currentDocumentIndex: 0,
						currentDocTasksTotal: 5,
						currentDocTasksCompleted: 0,
					},
				};
				const result = batchReducer(initialState, {
					type: 'UPDATE_PROGRESS',
					sessionId: 'session-1',
					payload: {
						completedTasksAcrossAllDocs: 3,
						currentDocTasksCompleted: 3,
						currentTaskIndex: 3,
						completedTasks: 3,
					},
				});
				expect(result['session-1'].completedTasksAcrossAllDocs).toBe(3);
				expect(result['session-1'].currentDocTasksCompleted).toBe(3);
				expect(result['session-1'].currentTaskIndex).toBe(3);
				expect(result['session-1'].completedTasks).toBe(3);
			});
		});
		// ============================================================================
		// SET_RUNNING action tests
		// ============================================================================
		describe('SET_RUNNING', () => {
			it('should transition from INITIALIZING to RUNNING state', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						processingState: 'INITIALIZING',
					},
				};
				const result = batchReducer(initialState, {
					type: 'SET_RUNNING',
					sessionId: 'session-1',
				});
				expect(result['session-1'].processingState).toBe('RUNNING');
			});
		});
		// ============================================================================
		// SET_STOPPING action tests
		// ============================================================================
		describe('SET_STOPPING', () => {
			it('should set isStopping to true', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						isStopping: false,
					},
				};
				const result = batchReducer(initialState, {
					type: 'SET_STOPPING',
					sessionId: 'session-1',
				});
				expect(result['session-1'].isStopping).toBe(true);
			});
		});
		// ============================================================================
		// SET_ERROR and CLEAR_ERROR action tests
		// ============================================================================
		describe('SET_ERROR', () => {
			it('should set error state and pause processing', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						processingState: 'RUNNING',
					},
				};
				const error: AgentError = {
					type: 'rate_limited',
					message: 'Rate limit exceeded',
					recoverable: true,
					agentId: 'agent-1',
					timestamp: Date.now(),
				};
				const result = batchReducer(initialState, {
					type: 'SET_ERROR',
					sessionId: 'session-1',
					payload: {
						error,
						documentIndex: 2,
						taskDescription: 'Processing task 3',
					},
				});
				expect(result['session-1'].error).toEqual(error);
				expect(result['session-1'].errorPaused).toBe(true);
				expect(result['session-1'].errorDocumentIndex).toBe(2);
				expect(result['session-1'].errorTaskDescription).toBe('Processing task 3');
				expect(result['session-1'].processingState).toBe('PAUSED_ERROR');
			});
		});
		describe('CLEAR_ERROR', () => {
			it('should clear error state and resume processing', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						processingState: 'PAUSED_ERROR',
						error: {
							type: 'rate_limited',
							message: 'Rate limit exceeded',
							recoverable: true,
							agentId: 'agent-1',
							timestamp: Date.now(),
						},
						errorPaused: true,
						errorDocumentIndex: 2,
						errorTaskDescription: 'Test task',
					},
				};
				const result = batchReducer(initialState, {
					type: 'CLEAR_ERROR',
					sessionId: 'session-1',
				});
				expect(result['session-1'].error).toBeUndefined();
				expect(result['session-1'].errorPaused).toBe(false);
				expect(result['session-1'].errorDocumentIndex).toBeUndefined();
				expect(result['session-1'].errorTaskDescription).toBeUndefined();
				expect(result['session-1'].processingState).toBe('RUNNING');
			});
		});
		// ============================================================================
		// COMPLETE_BATCH action tests
		// ============================================================================
		describe('COMPLETE_BATCH', () => {
			it('should reset batch state to default values', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						totalTasksAcrossAllDocs: 17,
						completedTasksAcrossAllDocs: 17,
						documents: ['doc1.md'],
						processingState: 'RUNNING',
					},
				};
				const result = batchReducer(initialState, {
					type: 'COMPLETE_BATCH',
					sessionId: 'session-1',
					finalSessionIds: ['claude-session-1', 'claude-session-2'],
				});
				expect(result['session-1'].isRunning).toBe(false);
				expect(result['session-1'].isStopping).toBe(false);
				expect(result['session-1'].totalTasksAcrossAllDocs).toBe(0);
				expect(result['session-1'].completedTasksAcrossAllDocs).toBe(0);
				expect(result['session-1'].documents).toEqual([]);
				expect(result['session-1'].sessionIds).toEqual(['claude-session-1', 'claude-session-2']);
				expect(result['session-1'].processingState).toBe('IDLE');
			});
			it('should preserve sessionIds when batch completes', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						sessionIds: ['old-session-1'],
					},
				};
				const result = batchReducer(initialState, {
					type: 'COMPLETE_BATCH',
					sessionId: 'session-1',
					finalSessionIds: ['new-session-1', 'new-session-2'],
				});
				expect(result['session-1'].sessionIds).toEqual(['new-session-1', 'new-session-2']);
			});
		});
		// ============================================================================
		// INCREMENT_LOOP action tests
		// ============================================================================
		describe('INCREMENT_LOOP', () => {
			it('should increment loop iteration and update task counts', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						loopEnabled: true,
						loopIteration: 0,
						totalTasksAcrossAllDocs: 10,
						completedTasksAcrossAllDocs: 10,
						totalTasks: 10,
						completedTasks: 10,
					},
				};
				const result = batchReducer(initialState, {
					type: 'INCREMENT_LOOP',
					sessionId: 'session-1',
					newTotalTasks: 8, // New tasks found for next loop
				});
				expect(result['session-1'].loopIteration).toBe(1);
				// newTotalTasks + completedTasksAcrossAllDocs
				expect(result['session-1'].totalTasksAcrossAllDocs).toBe(18);
				expect(result['session-1'].totalTasks).toBe(18);
			});
		});
		// ============================================================================
		// State immutability tests
		// ============================================================================
		describe('immutability', () => {
			it('should not mutate the original state', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						completedTasksAcrossAllDocs: 5,
					},
				};
				const originalCompleted = initialState['session-1'].completedTasksAcrossAllDocs;
				batchReducer(initialState, {
					type: 'UPDATE_PROGRESS',
					sessionId: 'session-1',
					payload: {
						completedTasksAcrossAllDocs: 10,
					},
				});
				// Original state should be unchanged
				expect(initialState['session-1'].completedTasksAcrossAllDocs).toBe(originalCompleted);
			});
			it('should return new state object for each action', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
					},
				};
				const result = batchReducer(initialState, {
					type: 'UPDATE_PROGRESS',
					sessionId: 'session-1',
					payload: {
						completedTasksAcrossAllDocs: 1,
					},
				});
				expect(result).not.toBe(initialState);
				expect(result['session-1']).not.toBe(initialState['session-1']);
			});
		});
		// ============================================================================
		// Edge cases and regression tests
		// ============================================================================
		describe('edge cases', () => {
			it('should handle 0 to 0 progress update (no change)', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						completedTasksAcrossAllDocs: 0,
					},
				};
				const result = batchReducer(initialState, {
					type: 'UPDATE_PROGRESS',
					sessionId: 'session-1',
					payload: {
						completedTasksAcrossAllDocs: 0,
					},
				});
				expect(result['session-1'].completedTasksAcrossAllDocs).toBe(0);
			});
			it('should handle completing more tasks than total (edge case)', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						totalTasksAcrossAllDocs: 10,
						completedTasksAcrossAllDocs: 0,
					},
				};
				// This could happen if tasks are added during processing
				const result = batchReducer(initialState, {
					type: 'UPDATE_PROGRESS',
					sessionId: 'session-1',
					payload: {
						completedTasksAcrossAllDocs: 15,
					},
				});
				// Should still set the value (caller is responsible for validity)
				expect(result['session-1'].completedTasksAcrossAllDocs).toBe(15);
			});
			it('should handle default action (unknown action type)', () => {
				const initialState: BatchState = {
					'session-1': {
						...S1_DEFAULT_BATCH_STATE,
						isRunning: true,
						completedTasksAcrossAllDocs: 5,
					},
				};
				// Test that unknown action types return unchanged state
				// We cast to any to bypass TypeScript's strict action type checking
				const unknownAction = {
					type: 'UNKNOWN_ACTION',
					sessionId: 'session-1',
				} as Parameters<typeof batchReducer>[1];
				const result = batchReducer(initialState, unknownAction);
				// Should return same state for unknown action
				expect(result).toBe(initialState);
			});
		});
	});
});
// Source: src/__tests__/renderer/hooks/batch/useAutoRunHandlers.refresh.test.ts
describe('', () => {
	const createSession = (overrides: Partial<Session> = {}): Session =>
		createMockSession({
			id: 'session-1',
			autoRunFolderPath: '/projects/autorun-docs',
			...overrides,
		});
	const createDeps = () => ({
		setSessions: vi.fn(),
		setAutoRunDocumentList: vi.fn(),
		setAutoRunDocumentTree: vi.fn(),
		setAutoRunIsLoadingDocuments: vi.fn(),
		setAutoRunSetupModalOpen: vi.fn(),
		setBatchRunnerModalOpen: vi.fn(),
		setActiveRightTab: vi.fn(),
		setRightPanelOpen: vi.fn(),
		setActiveFocus: vi.fn(),
		setSuccessFlashNotification: vi.fn(),
		autoRunDocumentList: ['Phase 1'],
		startBatchRun: vi.fn(),
	});
	const DOC_CONTENT: Record<string, string> = {
		'Phase 1.md': '- [x] done\n- [ ] todo\n- [ ] todo again\n',
		'Phase 2.md': '- [x] a\n- [x] b\n',
	};
	describe('handleAutoRunRefresh', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			const session = createSession();
			useSessionStore.setState({ sessions: [session], activeSessionId: session.id } as any);
			s2_useBatchStore.getState().setDocumentTaskCounts(
				new Map([
					['Phase 1', { completed: 1, total: 4 }],
					['Phase 2', { completed: 0, total: 2 }],
				])
			);
			vi.mocked(window.maestro.autorun.readDoc).mockImplementation(
				async (_folder: string, file: string) => ({
					success: true,
					content: DOC_CONTENT[file] ?? '',
				})
			);
		});
		it('re-reads the task counts from disk so edited documents show fresh counts', async () => {
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
				success: true,
				files: ['Phase 1', 'Phase 2'],
				tree: [],
			});
			const deps = createDeps();
			const { result } = renderHook(() => useAutoRunHandlers(deps));
			await act(async () => {
				await result.current.handleAutoRunRefresh({ silent: true });
			});
			expect(deps.setAutoRunDocumentList).toHaveBeenCalledWith(['Phase 1', 'Phase 2']);
			expect(window.maestro.autorun.readDoc).toHaveBeenCalledWith(
				'/projects/autorun-docs',
				'Phase 1.md',
				undefined
			);
			const counts = s2_useBatchStore.getState().documentTaskCounts;
			expect(counts.get('Phase 1')).toEqual({ completed: 1, total: 3 });
			expect(counts.get('Phase 2')).toEqual({ completed: 2, total: 2 });
			expect(counts.size).toBe(2);
		});
		it('keeps the cached task counts when listing the folder fails', async () => {
			vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
				success: false,
				error: 'boom',
			});
			const deps = createDeps();
			const { result } = renderHook(() => useAutoRunHandlers(deps));
			await act(async () => {
				await result.current.handleAutoRunRefresh({ silent: true });
			});
			expect(deps.setAutoRunDocumentList).not.toHaveBeenCalled();
			expect(window.maestro.autorun.readDoc).not.toHaveBeenCalled();
			expect(s2_useBatchStore.getState().documentTaskCounts.get('Phase 1')).toEqual({
				completed: 1,
				total: 4,
			});
		});
		it('leaves the loading flag to the newer refresh when an older one settles late', async () => {
			type ListResult = {
				success: boolean;
				files: string[];
				tree: never[];
			};
			const resolvers: Array<(value: ListResult) => void> = [];
			vi.mocked(window.maestro.autorun.listDocs).mockImplementation(
				() =>
					new Promise<ListResult>((resolve) => {
						resolvers.push(resolve);
					}) as never
			);
			const deps = createDeps();
			const { result } = renderHook(() => useAutoRunHandlers(deps));
			let first: Promise<void> = Promise.resolve();
			let second: Promise<void> = Promise.resolve();
			act(() => {
				first = result.current.handleAutoRunRefresh({ silent: true });
				second = result.current.handleAutoRunRefresh({ silent: true });
			});
			await act(async () => {
				resolvers[0]({ success: true, files: ['Phase 1'], tree: [] });
				await first;
			});
			// The superseded refresh settled, but the newer one is still loading.
			expect(deps.setAutoRunIsLoadingDocuments).not.toHaveBeenCalledWith(false);
			expect(deps.setAutoRunDocumentList).not.toHaveBeenCalled();
			await act(async () => {
				resolvers[1]({ success: true, files: ['Phase 1', 'Phase 2'], tree: [] });
				await second;
			});
			expect(deps.setAutoRunDocumentList).toHaveBeenCalledWith(['Phase 1', 'Phase 2']);
			expect(deps.setAutoRunIsLoadingDocuments).toHaveBeenLastCalledWith(false);
		});
		it('discards a refresh that finishes after the user switched to another session', async () => {
			let resolveList: (value: {
				success: boolean;
				files: string[];
				tree: never[];
			}) => void = () => {};
			vi.mocked(window.maestro.autorun.listDocs).mockReturnValueOnce(
				new Promise((resolve) => {
					resolveList = resolve;
				})
			);
			const deps = createDeps();
			const { result } = renderHook(() => useAutoRunHandlers(deps));
			let refresh: Promise<void> = Promise.resolve();
			act(() => {
				refresh = result.current.handleAutoRunRefresh({ silent: true });
			});
			// The user switches sessions while the listing is still in flight.
			useSessionStore.setState({ activeSessionId: 'session-2' } as any);
			await act(async () => {
				resolveList({ success: true, files: ['Phase 1', 'Phase 2'], tree: [] });
				await refresh;
			});
			expect(deps.setAutoRunDocumentList).not.toHaveBeenCalled();
			expect(window.maestro.autorun.readDoc).not.toHaveBeenCalled();
			expect(s2_useBatchStore.getState().documentTaskCounts.get('Phase 1')).toEqual({
				completed: 1,
				total: 4,
			});
			expect(deps.setAutoRunIsLoadingDocuments).toHaveBeenLastCalledWith(false);
		});
	});
});
// Source: src/__tests__/renderer/hooks/batch/useAutoRunStateMirror.test.ts
describe('', () => {
	const mkFrame = (over: Partial<AutoRunBroadcastState> = {}): AutoRunBroadcastState => ({
		isRunning: true,
		totalTasks: 4,
		completedTasks: 1,
		currentTaskIndex: 1,
		...over,
	});
	const mkLocalRun = (over: Partial<BatchRunState> = {}): BatchRunState => ({
		...S3_DEFAULT_BATCH_STATE,
		isRunning: true,
		...over,
	});
	beforeEach(() => {
		s3_useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
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
			const ownerStart = 1700000000000;
			expect(buildMirroredBatchState(mkFrame({ startTime: ownerStart })).startTime).toBe(
				ownerStart
			);
		});
		it("carries the owner's ETA baseline and keeps it when a later frame omits it", () => {
			const first = buildMirroredBatchState(mkFrame({ initialCompletedTasks: 12 }));
			expect(first.initialCompletedTasks).toBe(12);
			expect(buildMirroredBatchState(mkFrame(), first).initialCompletedTasks).toBe(12);
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
			const entry = s3_useBatchStore.getState().batchRunStates['agent-1'];
			expect(entry.isRunning).toBe(true);
			expect(entry.mirrored).toBe(true);
			expect(entry.completedTasks).toBe(3);
		});
		it('updates an existing mirror in place', () => {
			applyAutoRunMirrorFrame('agent-1', mkFrame({ completedTasks: 1 }));
			applyAutoRunMirrorFrame('agent-1', mkFrame({ completedTasks: 2 }));
			expect(s3_useBatchStore.getState().batchRunStates['agent-1'].completedTasks).toBe(2);
		});
		it('never overwrites a run this client OWNS - the owner hears its own broadcasts back', () => {
			s3_useBatchStore.setState({
				batchRunStates: { 'agent-1': mkLocalRun({ completedTasks: 7, folderPath: '/local' }) },
			});
			applyAutoRunMirrorFrame('agent-1', mkFrame({ completedTasks: 1 }));
			const entry = s3_useBatchStore.getState().batchRunStates['agent-1'];
			expect(entry.mirrored).toBeUndefined();
			expect(entry.completedTasks).toBe(7);
			expect(entry.folderPath).toBe('/local');
		});
		it('removes the mirror when the owner clears the run', () => {
			applyAutoRunMirrorFrame('agent-1', mkFrame());
			applyAutoRunMirrorFrame('agent-1', null);
			expect(s3_useBatchStore.getState().batchRunStates['agent-1']).toBeUndefined();
		});
		it('removes the mirror when the run finishes rather than leaving a stopped card', () => {
			applyAutoRunMirrorFrame('agent-1', mkFrame());
			applyAutoRunMirrorFrame('agent-1', mkFrame({ isRunning: false, completedTasks: 4 }));
			expect(s3_useBatchStore.getState().batchRunStates['agent-1']).toBeUndefined();
		});
		it('leaves a locally owned run alone when a clearing frame arrives for it', () => {
			s3_useBatchStore.setState({
				batchRunStates: { 'agent-1': mkLocalRun({ completedTasks: 7 }) },
			});
			applyAutoRunMirrorFrame('agent-1', null);
			expect(s3_useBatchStore.getState().batchRunStates['agent-1'].completedTasks).toBe(7);
		});
		it('does not create an entry for a clearing frame it has nothing to clear', () => {
			applyAutoRunMirrorFrame('agent-1', null);
			expect(s3_useBatchStore.getState().batchRunStates).toEqual({});
		});
		it('adopts an agent whose LOCAL run has already finished - COMPLETE_BATCH leaves the key behind', () => {
			// `COMPLETE_BATCH` resets the entry in place instead of deleting it, so a
			// client that has run Auto Run once keeps a non-mirrored `isRunning: false`
			// entry forever. Reading that as ownership made mirroring permanently dead
			// for exactly the agents the user had already used it on.
			s3_useBatchStore.setState({
				batchRunStates: { 'agent-1': mkLocalRun({ isRunning: false, completedTasks: 0 }) },
			});
			applyAutoRunMirrorFrame('agent-1', mkFrame({ completedTasks: 3 }));
			const entry = s3_useBatchStore.getState().batchRunStates['agent-1'];
			expect(entry.mirrored).toBe(true);
			expect(entry.isRunning).toBe(true);
			expect(entry.completedTasks).toBe(3);
		});
		it('does not seed a new mirror from a finished local run left behind by the reducer', () => {
			s3_useBatchStore.setState({
				batchRunStates: {
					'agent-1': mkLocalRun({ isRunning: false, documents: ['stale'], startTime: 111 }),
				},
			});
			applyAutoRunMirrorFrame('agent-1', mkFrame());
			const entry = s3_useBatchStore.getState().batchRunStates['agent-1'];
			expect(entry.documents).toEqual([]);
			expect(entry.startTime).toBeUndefined();
		});
		it("leaves a finished local run in place rather than deleting the reducer's entry", () => {
			s3_useBatchStore.setState({
				batchRunStates: { 'agent-1': mkLocalRun({ isRunning: false, sessionIds: ['s1'] }) },
			});
			applyAutoRunMirrorFrame('agent-1', null);
			expect(s3_useBatchStore.getState().batchRunStates['agent-1']?.sessionIds).toEqual(['s1']);
		});
		it('mirrors each agent independently', () => {
			applyAutoRunMirrorFrame('agent-1', mkFrame({ completedTasks: 1 }));
			applyAutoRunMirrorFrame('agent-2', mkFrame({ completedTasks: 5 }));
			applyAutoRunMirrorFrame('agent-1', null);
			expect(s3_useBatchStore.getState().batchRunStates['agent-1']).toBeUndefined();
			expect(s3_useBatchStore.getState().batchRunStates['agent-2'].completedTasks).toBe(5);
		});
	});
	describe('mirrored runs light up the shared Auto Run surfaces', () => {
		it('counts toward the Left Bar / command palette active-batch selector', async () => {
			const { selectActiveBatchSessionIds, isMirroredBatchRun } =
				await import('../../../../renderer/stores/batchStore');
			applyAutoRunMirrorFrame('agent-1', mkFrame());
			expect(selectActiveBatchSessionIds(s3_useBatchStore.getState())).toEqual(['agent-1']);
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
			(
				window as unknown as {
					maestro: unknown;
				}
			).maestro = {
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
					timeTracking: { pauseTracking: vi.fn(), resumeTracking: vi.fn() },
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
			expect(s3_useBatchStore.getState().batchRunStates['agent-1'].isStopping).toBe(false);
		});
		it('still acts on a run this client owns', async () => {
			const broadcastMock = vi.fn();
			(
				window as unknown as {
					maestro: unknown;
				}
			).maestro = {
				web: { broadcastAutoRunState: broadcastMock },
				logger: { autorun: vi.fn() },
			};
			const { renderHook, act } = await import('@testing-library/react');
			const { useBatchControlActions } =
				await import('../../../../renderer/hooks/batch/internal/useBatchControlActions');
			s3_useBatchStore.setState({ batchRunStates: { 'agent-1': mkLocalRun() } });
			const dispatch = vi.fn();
			const stopRequestedRefs = { current: {} as Record<string, boolean> };
			const { result } = renderHook(() =>
				useBatchControlActions({
					broadcastAutoRunState: broadcastMock,
					dispatch,
					errorResolutionRefs: { current: {} },
					stopRequestedRefs,
					isMountedRef: { current: true },
					timeTracking: { pauseTracking: vi.fn(), resumeTracking: vi.fn() },
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
		const STALE = 5 * 60000 + 1000;
		const setActiveProcesses = (
			processes: Array<{
				sessionId: string;
			}>
		) => {
			(
				window as unknown as {
					maestro: unknown;
				}
			).maestro = {
				process: { getActiveProcesses: vi.fn().mockResolvedValue(processes) },
			};
		};
		it('drops a mirror that has gone quiet with no Auto Run process left', async () => {
			setActiveProcesses([]);
			applyAutoRunMirrorFrame('agent-1', mkFrame());
			await reapStaleMirrors(Date.now() + STALE);
			expect(s3_useBatchStore.getState().batchRunStates['agent-1']).toBeUndefined();
		});
		it('keeps a quiet mirror whose agent still has a live Auto Run process', async () => {
			setActiveProcesses([{ sessionId: 'agent-1-batch-1700000000000' }]);
			applyAutoRunMirrorFrame('agent-1', mkFrame());
			await reapStaleMirrors(Date.now() + STALE);
			expect(s3_useBatchStore.getState().batchRunStates['agent-1']?.mirrored).toBe(true);
		});
		it('keeps a valid error or HITL pause even though no batch process is active', async () => {
			setActiveProcesses([]);
			applyAutoRunMirrorFrame(
				'agent-1',
				mkFrame({ errorPaused: true, errorMessage: 'Waiting for approval' })
			);
			await reapStaleMirrors(Date.now() + STALE);
			expect(s3_useBatchStore.getState().batchRunStates['agent-1']?.mirrored).toBe(true);
			expect(window.maestro.process.getActiveProcesses).not.toHaveBeenCalled();
		});
		it('keeps a mirror that is still receiving frames', async () => {
			setActiveProcesses([]);
			applyAutoRunMirrorFrame('agent-1', mkFrame());
			await reapStaleMirrors(Date.now());
			expect(s3_useBatchStore.getState().batchRunStates['agent-1']?.mirrored).toBe(true);
		});
		it('keeps every mirror when the probe fails - that is "could not find out", not "nothing is running"', async () => {
			(
				window as unknown as {
					maestro: unknown;
				}
			).maestro = {
				process: { getActiveProcesses: vi.fn().mockRejectedValue(new Error('bridge down')) },
			};
			applyAutoRunMirrorFrame('agent-1', mkFrame());
			await reapStaleMirrors(Date.now() + STALE);
			expect(s3_useBatchStore.getState().batchRunStates['agent-1']?.mirrored).toBe(true);
		});
		it('never touches a run this client owns', async () => {
			setActiveProcesses([]);
			s3_useBatchStore.setState({
				batchRunStates: { 'agent-1': mkLocalRun({ completedTasks: 7 }) },
			});
			await reapStaleMirrors(Date.now() + STALE);
			expect(s3_useBatchStore.getState().batchRunStates['agent-1']?.completedTasks).toBe(7);
		});
		it('matches the batch process by agent id, not by substring', async () => {
			// `agent-1-batch-...` must not keep `agent-11`'s mirror alive.
			setActiveProcesses([{ sessionId: 'agent-1-batch-1700000000000' }]);
			applyAutoRunMirrorFrame('agent-11', mkFrame());
			await reapStaleMirrors(Date.now() + STALE);
			expect(s3_useBatchStore.getState().batchRunStates['agent-11']).toBeUndefined();
		});
		it('keeps a mirror refreshed while the process probe is pending', async () => {
			let finishProbe!: (
				processes: Array<{
					sessionId: string;
				}>
			) => void;
			const getActiveProcesses = vi.fn(
				() =>
					new Promise<
						Array<{
							sessionId: string;
						}>
					>((resolve) => {
						finishProbe = resolve;
					})
			);
			(
				window as unknown as {
					maestro: unknown;
				}
			).maestro = {
				process: { getActiveProcesses },
			};
			const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
			applyAutoRunMirrorFrame('agent-1', mkFrame({ completedTasks: 1 }));
			const reaping = reapStaleMirrors(1000 + STALE);
			await vi.waitFor(() => expect(getActiveProcesses).toHaveBeenCalledTimes(1));
			clock.mockReturnValue(2000);
			applyAutoRunMirrorFrame('agent-1', mkFrame({ completedTasks: 2 }));
			finishProbe([]);
			await reaping;
			expect(s3_useBatchStore.getState().batchRunStates['agent-1']?.completedTasks).toBe(2);
		});
	});
});
