/**
 * batchStore tests
 *
 * Tests for the consolidated batch/Auto Run Zustand store:
 * - AutoRun document state (documentList, documentTree, loading, taskCounts)
 * - Batch run states (via dispatchBatch reusing batchReducer)
 * - Custom prompts
 * - Derived selectors
 * - Non-React access
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	useBatchStore,
	getBatchState,
	getBatchActions,
	selectHasAnyActiveBatch,
	selectActiveBatchSessionIds,
	selectStoppingBatchSessionIds,
	selectBatchRunState,
} from '../../../renderer/stores/batchStore';
import type { TaskCountEntry } from '../../../renderer/stores/batchStore';
import type { AutoRunTreeNode } from '../../../renderer/hooks/batch/useAutoRunHandlers';
import { DEFAULT_BATCH_STATE } from '../../../renderer/hooks/batch/batchReducer';
import type { StartBatchPayload } from '../../../renderer/hooks/batch/batchReducer';

// ============================================================================
// Helpers
// ============================================================================

function createTreeNode(overrides: Partial<AutoRunTreeNode> = {}): AutoRunTreeNode {
	return {
		name: 'test.md',
		type: 'file',
		path: '/docs/test.md',
		...overrides,
	};
}

function createStartBatchPayload(overrides: Partial<StartBatchPayload> = {}): StartBatchPayload {
	return {
		documents: ['doc1.md', 'doc2.md'],
		lockedDocuments: ['doc1.md'],
		totalTasksAcrossAllDocs: 10,
		loopEnabled: false,
		folderPath: '/test/folder',
		worktreeActive: false,
		startTime: Date.now(),
		cumulativeTaskTimeMs: 0,
		accumulatedElapsedMs: 0,
		lastActiveTimestamp: Date.now(),
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe('batchStore', () => {
	beforeEach(() => {
		// Reset store to initial state
		useBatchStore.setState({
			documentList: [],
			documentTree: [],
			isLoadingDocuments: false,
			documentTaskCounts: new Map(),
			batchRunStates: {},
			customPrompts: {},
		});
	});

	// ==========================================================================
	// Initial state
	// ==========================================================================

	describe('initial state', () => {
		it('has empty document list', () => {
			expect(useBatchStore.getState().documentList).toEqual([]);
		});

		it('has empty document tree', () => {
			expect(useBatchStore.getState().documentTree).toEqual([]);
		});

		it('has isLoadingDocuments false', () => {
			expect(useBatchStore.getState().isLoadingDocuments).toBe(false);
		});

		it('has empty document task counts', () => {
			expect(useBatchStore.getState().documentTaskCounts.size).toBe(0);
		});

		it('has empty batch run states', () => {
			expect(Object.keys(useBatchStore.getState().batchRunStates)).toHaveLength(0);
		});

		it('has empty custom prompts', () => {
			expect(Object.keys(useBatchStore.getState().customPrompts)).toHaveLength(0);
		});
	});

	// ==========================================================================
	// AutoRun document state
	// ==========================================================================

	describe('document list', () => {
		it('sets document list with direct value', () => {
			useBatchStore.getState().setDocumentList(['a.md', 'b.md']);
			expect(useBatchStore.getState().documentList).toEqual(['a.md', 'b.md']);
		});

		it('sets document list with functional updater', () => {
			useBatchStore.getState().setDocumentList(['a.md']);
			useBatchStore.getState().setDocumentList((prev) => [...prev, 'b.md']);
			expect(useBatchStore.getState().documentList).toEqual(['a.md', 'b.md']);
		});

		it('replaces document list entirely', () => {
			useBatchStore.getState().setDocumentList(['old.md']);
			useBatchStore.getState().setDocumentList(['new1.md', 'new2.md']);
			expect(useBatchStore.getState().documentList).toEqual(['new1.md', 'new2.md']);
		});
	});

	describe('document tree', () => {
		it('sets document tree with direct value', () => {
			const tree = [
				createTreeNode({ name: 'file1.md' }),
				createTreeNode({ name: 'folder', type: 'folder', children: [] }),
			];
			useBatchStore.getState().setDocumentTree(tree);
			expect(useBatchStore.getState().documentTree).toHaveLength(2);
			expect(useBatchStore.getState().documentTree[1].type).toBe('folder');
		});

		it('sets document tree with functional updater', () => {
			useBatchStore.getState().setDocumentTree([createTreeNode({ name: 'a.md' })]);
			useBatchStore
				.getState()
				.setDocumentTree((prev) => [...prev, createTreeNode({ name: 'b.md' })]);
			expect(useBatchStore.getState().documentTree).toHaveLength(2);
		});
	});

	describe('loading state', () => {
		it('sets isLoadingDocuments to true', () => {
			useBatchStore.getState().setIsLoadingDocuments(true);
			expect(useBatchStore.getState().isLoadingDocuments).toBe(true);
		});

		it('toggles with functional updater', () => {
			useBatchStore.getState().setIsLoadingDocuments(true);
			useBatchStore.getState().setIsLoadingDocuments((prev) => !prev);
			expect(useBatchStore.getState().isLoadingDocuments).toBe(false);
		});
	});

	describe('document task counts', () => {
		it('sets task counts with direct value', () => {
			const counts = new Map<string, TaskCountEntry>([
				['doc1.md', { completed: 3, total: 10 }],
				['doc2.md', { completed: 0, total: 5 }],
			]);
			useBatchStore.getState().setDocumentTaskCounts(counts);
			expect(useBatchStore.getState().documentTaskCounts.size).toBe(2);
			expect(useBatchStore.getState().documentTaskCounts.get('doc1.md')).toEqual({
				completed: 3,
				total: 10,
			});
		});

		it('sets task counts with functional updater', () => {
			const initial = new Map<string, TaskCountEntry>([['doc1.md', { completed: 1, total: 5 }]]);
			useBatchStore.getState().setDocumentTaskCounts(initial);
			useBatchStore.getState().setDocumentTaskCounts((prev) => {
				const next = new Map(prev);
				next.set('doc2.md', { completed: 0, total: 3 });
				return next;
			});
			expect(useBatchStore.getState().documentTaskCounts.size).toBe(2);
		});

		it('updateTaskCount adds or updates a single document', () => {
			useBatchStore.getState().updateTaskCount('doc1.md', 2, 8);
			expect(useBatchStore.getState().documentTaskCounts.get('doc1.md')).toEqual({
				completed: 2,
				total: 8,
			});
			// Update existing
			useBatchStore.getState().updateTaskCount('doc1.md', 5, 8);
			expect(useBatchStore.getState().documentTaskCounts.get('doc1.md')?.completed).toBe(5);
		});

		it('updateTaskCount does not affect other documents', () => {
			useBatchStore.getState().updateTaskCount('doc1.md', 1, 5);
			useBatchStore.getState().updateTaskCount('doc2.md', 2, 10);
			expect(useBatchStore.getState().documentTaskCounts.size).toBe(2);
			expect(useBatchStore.getState().documentTaskCounts.get('doc1.md')?.completed).toBe(1);
		});

		it('updateTaskCount creates new Map reference', () => {
			useBatchStore.getState().updateTaskCount('doc1.md', 1, 5);
			const ref1 = useBatchStore.getState().documentTaskCounts;
			useBatchStore.getState().updateTaskCount('doc2.md', 2, 10);
			const ref2 = useBatchStore.getState().documentTaskCounts;
			expect(ref1).not.toBe(ref2);
		});
	});

	describe('clearDocumentList', () => {
		it('resets documentList, documentTree, and documentTaskCounts', () => {
			// Set up state
			useBatchStore.getState().setDocumentList(['a.md', 'b.md']);
			useBatchStore.getState().setDocumentTree([createTreeNode()]);
			useBatchStore.getState().updateTaskCount('a.md', 3, 5);
			useBatchStore.getState().setIsLoadingDocuments(true);

			// Clear
			useBatchStore.getState().clearDocumentList();

			expect(useBatchStore.getState().documentList).toEqual([]);
			expect(useBatchStore.getState().documentTree).toEqual([]);
			expect(useBatchStore.getState().documentTaskCounts.size).toBe(0);
			// isLoadingDocuments should NOT be cleared
			expect(useBatchStore.getState().isLoadingDocuments).toBe(true);
		});
	});

	// ==========================================================================
	// Batch run state (via dispatchBatch)
	// ==========================================================================

	describe('dispatchBatch', () => {
		it('START_BATCH initializes session state', () => {
			const payload = createStartBatchPayload({
				documents: ['task1.md', 'task2.md'],
				totalTasksAcrossAllDocs: 15,
			});
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload,
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state).toBeDefined();
			expect(state.isRunning).toBe(true);
			expect(state.isStopping).toBe(false);
			expect(state.documents).toEqual(['task1.md', 'task2.md']);
			expect(state.totalTasksAcrossAllDocs).toBe(15);
			expect(state.processingState).toBe('INITIALIZING');
		});

		it('SET_RUNNING transitions to RUNNING state', () => {
			// First start
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			// Then mark running
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.processingState).toBe('RUNNING');
			expect(state.isRunning).toBe(true);
		});

		it('UPDATE_PROGRESS updates counters', () => {
			// Setup: start and run
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			// Update progress
			useBatchStore.getState().dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: {
					currentDocumentIndex: 1,
					currentDocTasksCompleted: 3,
					completedTasksAcrossAllDocs: 7,
				},
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.currentDocumentIndex).toBe(1);
			expect(state.currentDocTasksCompleted).toBe(3);
			expect(state.completedTasksAcrossAllDocs).toBe(7);
		});

		it('SET_STOPPING marks session as stopping', () => {
			// Setup
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			// Stop
			useBatchStore.getState().dispatchBatch({
				type: 'SET_STOPPING',
				sessionId: 'sess-1',
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.isStopping).toBe(true);
			expect(state.processingState).toBe('STOPPING');
		});

		it('SET_ERROR pauses batch with error', () => {
			// Setup
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			// Error
			useBatchStore.getState().dispatchBatch({
				type: 'SET_ERROR',
				sessionId: 'sess-1',
				payload: {
					error: { message: 'Agent crashed', type: 'process_error' } as any,
					documentIndex: 0,
					taskDescription: 'Fix the bug',
				},
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.errorPaused).toBe(true);
			expect(state.error?.message).toBe('Agent crashed');
			expect(state.processingState).toBe('PAUSED_ERROR');
		});

		it('CLEAR_ERROR resumes from error', () => {
			// Setup: start → run → error
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_ERROR',
				sessionId: 'sess-1',
				payload: {
					error: { message: 'err', type: 'process_error' } as any,
					documentIndex: 0,
				},
			});
			// Clear error
			useBatchStore.getState().dispatchBatch({
				type: 'CLEAR_ERROR',
				sessionId: 'sess-1',
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.errorPaused).toBe(false);
			expect(state.error).toBeUndefined();
			expect(state.processingState).toBe('RUNNING');
		});

		it('SET_COMPLETING transitions to COMPLETING', () => {
			// Setup: start → run
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_COMPLETING',
				sessionId: 'sess-1',
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.processingState).toBe('COMPLETING');
		});

		it('COMPLETE_BATCH resets session to idle', () => {
			// Setup: start → run → completing
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_COMPLETING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'COMPLETE_BATCH',
				sessionId: 'sess-1',
				finalSessionIds: ['agent-sess-1'],
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.isRunning).toBe(false);
			expect(state.isStopping).toBe(false);
			expect(state.processingState).toBe('IDLE');
		});

		it('INCREMENT_LOOP increments loop counter', () => {
			// Setup: start → run
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({ loopEnabled: true }),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'INCREMENT_LOOP',
				sessionId: 'sess-1',
				newTotalTasks: 20,
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.loopIteration).toBe(1);
		});

		it('handles multiple sessions independently', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({ documents: ['a.md'] }),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-2',
				payload: createStartBatchPayload({ documents: ['b.md'] }),
			});

			const states = useBatchStore.getState().batchRunStates;
			expect(Object.keys(states)).toHaveLength(2);
			expect(states['sess-1'].documents).toEqual(['a.md']);
			expect(states['sess-2'].documents).toEqual(['b.md']);
		});
	});

	describe('setBatchRunStates', () => {
		it('sets batch run states directly', () => {
			const states = {
				'sess-1': { ...DEFAULT_BATCH_STATE, isRunning: true },
			};
			useBatchStore.getState().setBatchRunStates(states);
			expect(useBatchStore.getState().batchRunStates['sess-1'].isRunning).toBe(true);
		});

		it('sets batch run states with functional updater', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().setBatchRunStates((prev) => {
				const next = { ...prev };
				delete next['sess-1'];
				return next;
			});
			expect(useBatchStore.getState().batchRunStates['sess-1']).toBeUndefined();
		});
	});

	// ==========================================================================
	// Custom prompts
	// ==========================================================================

	describe('custom prompts', () => {
		it('sets custom prompt for a session', () => {
			useBatchStore.getState().setCustomPrompt('sess-1', 'Do the tasks');
			expect(useBatchStore.getState().customPrompts['sess-1']).toBe('Do the tasks');
		});

		it('sets multiple custom prompts independently', () => {
			useBatchStore.getState().setCustomPrompt('sess-1', 'Prompt A');
			useBatchStore.getState().setCustomPrompt('sess-2', 'Prompt B');
			expect(useBatchStore.getState().customPrompts['sess-1']).toBe('Prompt A');
			expect(useBatchStore.getState().customPrompts['sess-2']).toBe('Prompt B');
		});

		it('overwrites existing custom prompt', () => {
			useBatchStore.getState().setCustomPrompt('sess-1', 'Old');
			useBatchStore.getState().setCustomPrompt('sess-1', 'New');
			expect(useBatchStore.getState().customPrompts['sess-1']).toBe('New');
		});

		it('clearCustomPrompts removes all prompts', () => {
			useBatchStore.getState().setCustomPrompt('sess-1', 'A');
			useBatchStore.getState().setCustomPrompt('sess-2', 'B');
			useBatchStore.getState().clearCustomPrompts();
			expect(Object.keys(useBatchStore.getState().customPrompts)).toHaveLength(0);
		});
	});

	// ==========================================================================
	// Selectors
	// ==========================================================================

	describe('selectors', () => {
		describe('selectHasAnyActiveBatch', () => {
			it('returns false when no batches exist', () => {
				expect(selectHasAnyActiveBatch(useBatchStore.getState())).toBe(false);
			});

			it('returns false when all batches are complete', () => {
				useBatchStore.getState().setBatchRunStates({
					'sess-1': { ...DEFAULT_BATCH_STATE, isRunning: false },
				});
				expect(selectHasAnyActiveBatch(useBatchStore.getState())).toBe(false);
			});

			it('returns true when any batch is running', () => {
				useBatchStore.getState().dispatchBatch({
					type: 'START_BATCH',
					sessionId: 'sess-1',
					payload: createStartBatchPayload(),
				});
				expect(selectHasAnyActiveBatch(useBatchStore.getState())).toBe(true);
			});
		});

		describe('selectActiveBatchSessionIds', () => {
			it('returns empty array when no active batches', () => {
				expect(selectActiveBatchSessionIds(useBatchStore.getState())).toEqual([]);
			});

			it('returns only running session IDs', () => {
				useBatchStore.getState().setBatchRunStates({
					'sess-1': { ...DEFAULT_BATCH_STATE, isRunning: true },
					'sess-2': { ...DEFAULT_BATCH_STATE, isRunning: false },
					'sess-3': { ...DEFAULT_BATCH_STATE, isRunning: true },
				});
				const ids = selectActiveBatchSessionIds(useBatchStore.getState());
				expect(ids).toHaveLength(2);
				expect(ids).toContain('sess-1');
				expect(ids).toContain('sess-3');
			});
		});

		describe('selectStoppingBatchSessionIds', () => {
			it('returns empty array when no stopping batches', () => {
				expect(selectStoppingBatchSessionIds(useBatchStore.getState())).toEqual([]);
			});

			it('returns only stopping session IDs', () => {
				useBatchStore.getState().setBatchRunStates({
					'sess-1': { ...DEFAULT_BATCH_STATE, isRunning: true, isStopping: true },
					'sess-2': { ...DEFAULT_BATCH_STATE, isRunning: true, isStopping: false },
					'sess-3': { ...DEFAULT_BATCH_STATE, isRunning: false, isStopping: true },
				});
				const ids = selectStoppingBatchSessionIds(useBatchStore.getState());
				// Only sess-1: isRunning=true AND isStopping=true
				expect(ids).toEqual(['sess-1']);
			});
		});

		describe('selectBatchRunState', () => {
			it('returns undefined for non-existent session', () => {
				expect(selectBatchRunState(useBatchStore.getState(), 'nope')).toBeUndefined();
			});

			it('returns batch state for existing session', () => {
				useBatchStore.getState().dispatchBatch({
					type: 'START_BATCH',
					sessionId: 'sess-1',
					payload: createStartBatchPayload({ documents: ['x.md'] }),
				});
				const state = selectBatchRunState(useBatchStore.getState(), 'sess-1');
				expect(state).toBeDefined();
				expect(state!.documents).toEqual(['x.md']);
			});
		});
	});

	// ==========================================================================
	// Non-React access
	// ==========================================================================

	describe('non-React access', () => {
		it('getBatchState returns current state', () => {
			useBatchStore.getState().setDocumentList(['test.md']);
			const state = getBatchState();
			expect(state.documentList).toEqual(['test.md']);
		});

		it('getBatchActions returns working action references', () => {
			const actions = getBatchActions();
			actions.setDocumentList(['via-actions.md']);
			expect(useBatchStore.getState().documentList).toEqual(['via-actions.md']);
		});

		it('getBatchActions.dispatchBatch works', () => {
			const actions = getBatchActions();
			actions.dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			expect(useBatchStore.getState().batchRunStates['sess-1']).toBeDefined();
			expect(useBatchStore.getState().batchRunStates['sess-1'].isRunning).toBe(true);
		});
	});

	// ==========================================================================
	// Action stability
	// ==========================================================================

	describe('action stability', () => {
		it('action references are stable across state changes', () => {
			const actions1 = useBatchStore.getState();
			useBatchStore.getState().setDocumentList(['changed']);
			const actions2 = useBatchStore.getState();
			expect(actions1.setDocumentList).toBe(actions2.setDocumentList);
			expect(actions1.dispatchBatch).toBe(actions2.dispatchBatch);
			expect(actions1.updateTaskCount).toBe(actions2.updateTaskCount);
		});
	});

	// ==========================================================================
	// Dispatch edge cases & guard clauses
	// ==========================================================================

	describe('dispatch guard clauses', () => {
		it('SET_RUNNING on non-existent session returns state unchanged', () => {
			const before = useBatchStore.getState().batchRunStates;
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'ghost',
			});
			expect(useBatchStore.getState().batchRunStates).toBe(before);
		});

		it('UPDATE_PROGRESS on non-existent session returns state unchanged', () => {
			const before = useBatchStore.getState().batchRunStates;
			useBatchStore.getState().dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'ghost',
				payload: { completedTasksAcrossAllDocs: 5 },
			});
			expect(useBatchStore.getState().batchRunStates).toBe(before);
		});

		it('SET_COMPLETING on non-existent session returns state unchanged', () => {
			const before = useBatchStore.getState().batchRunStates;
			useBatchStore.getState().dispatchBatch({
				type: 'SET_COMPLETING',
				sessionId: 'ghost',
			});
			expect(useBatchStore.getState().batchRunStates).toBe(before);
		});

		it('CLEAR_ERROR on non-existent session returns state unchanged', () => {
			const before = useBatchStore.getState().batchRunStates;
			useBatchStore.getState().dispatchBatch({
				type: 'CLEAR_ERROR',
				sessionId: 'ghost',
			});
			expect(useBatchStore.getState().batchRunStates).toBe(before);
		});

		it('INCREMENT_LOOP on non-existent session returns state unchanged', () => {
			const before = useBatchStore.getState().batchRunStates;
			useBatchStore.getState().dispatchBatch({
				type: 'INCREMENT_LOOP',
				sessionId: 'ghost',
				newTotalTasks: 10,
			});
			expect(useBatchStore.getState().batchRunStates).toBe(before);
		});

		it('SET_ERROR on non-running session returns state unchanged', () => {
			useBatchStore.getState().setBatchRunStates({
				'sess-1': { ...DEFAULT_BATCH_STATE, isRunning: false },
			});
			const before = useBatchStore.getState().batchRunStates;
			useBatchStore.getState().dispatchBatch({
				type: 'SET_ERROR',
				sessionId: 'sess-1',
				payload: {
					error: { message: 'err', type: 'process_error' } as any,
					documentIndex: 0,
				},
			});
			expect(useBatchStore.getState().batchRunStates).toBe(before);
		});
	});

	// ==========================================================================
	// START_BATCH payload details
	// ==========================================================================

	describe('START_BATCH payload details', () => {
		it('initializes worktree fields from payload', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({
					worktreeActive: true,
					worktreePath: '/worktree/feature',
					worktreeBranch: 'feature-branch',
				}),
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.worktreeActive).toBe(true);
			expect(state.worktreePath).toBe('/worktree/feature');
			expect(state.worktreeBranch).toBe('feature-branch');
		});

		it('initializes loop mode fields', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({
					loopEnabled: true,
					maxLoops: 5,
				}),
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.loopEnabled).toBe(true);
			expect(state.maxLoops).toBe(5);
			expect(state.loopIteration).toBe(0);
		});

		it('initializes time tracking fields', () => {
			const now = Date.now();
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({
					startTime: now,
					cumulativeTaskTimeMs: 500,
					accumulatedElapsedMs: 1000,
					lastActiveTimestamp: now - 100,
				}),
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.startTime).toBe(now);
			expect(state.cumulativeTaskTimeMs).toBe(500);
			expect(state.accumulatedElapsedMs).toBe(1000);
			expect(state.lastActiveTimestamp).toBe(now - 100);
		});

		it('initializes locked documents', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({
					lockedDocuments: ['locked1.md', 'locked2.md'],
				}),
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.lockedDocuments).toEqual(['locked1.md', 'locked2.md']);
		});

		it('clears error state on start', () => {
			// Pre-set error state manually
			useBatchStore.getState().setBatchRunStates({
				'sess-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					error: { message: 'old err' } as any,
					errorPaused: true,
					errorDocumentIndex: 2,
					errorTaskDescription: 'old task',
				},
			});

			// Start overwrites everything
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.error).toBeUndefined();
			expect(state.errorPaused).toBe(false);
			expect(state.errorDocumentIndex).toBeUndefined();
			expect(state.errorTaskDescription).toBeUndefined();
		});

		it('initializes custom prompt from payload', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({ customPrompt: 'Run all tests' }),
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.customPrompt).toBe('Run all tests');
		});
	});

	// ==========================================================================
	// UPDATE_PROGRESS partial updates
	// ==========================================================================

	describe('UPDATE_PROGRESS partial updates', () => {
		beforeEach(() => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({ totalTasksAcrossAllDocs: 20 }),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
		});

		it('only updates provided fields, preserves others', () => {
			// Set some initial progress
			useBatchStore.getState().dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: {
					currentDocumentIndex: 2,
					currentDocTasksCompleted: 5,
					completedTasksAcrossAllDocs: 10,
				},
			});

			// Update only one field
			useBatchStore.getState().dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: { completedTasksAcrossAllDocs: 12 },
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.currentDocumentIndex).toBe(2); // preserved
			expect(state.currentDocTasksCompleted).toBe(5); // preserved
			expect(state.completedTasksAcrossAllDocs).toBe(12); // updated
		});

		it('updates time tracking fields', () => {
			const now = Date.now();
			useBatchStore.getState().dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: {
					accumulatedElapsedMs: 5000,
					lastActiveTimestamp: now,
				},
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.accumulatedElapsedMs).toBe(5000);
			expect(state.lastActiveTimestamp).toBe(now);
		});

		it('updates legacy fields', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: {
					totalTasks: 15,
					completedTasks: 8,
					currentTaskIndex: 3,
					sessionIds: ['agent-1', 'agent-2'],
				},
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.totalTasks).toBe(15);
			expect(state.completedTasks).toBe(8);
			expect(state.currentTaskIndex).toBe(3);
			expect(state.sessionIds).toEqual(['agent-1', 'agent-2']);
		});

		it('updates loop iteration via progress', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: { loopIteration: 3 },
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.loopIteration).toBe(3);
		});

		it('updates currentDocTasksTotal', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: { currentDocTasksTotal: 7 },
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.currentDocTasksTotal).toBe(7);
		});

		it('updates totalTasksAcrossAllDocs', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: { totalTasksAcrossAllDocs: 50 },
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.totalTasksAcrossAllDocs).toBe(50);
		});
	});

	// ==========================================================================
	// SET_STOPPING from PAUSED_ERROR
	// ==========================================================================

	describe('SET_STOPPING from PAUSED_ERROR', () => {
		it('clears error state when aborting from error pause', () => {
			// Setup: start → run → error
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_ERROR',
				sessionId: 'sess-1',
				payload: {
					error: { message: 'crash', type: 'process_error' } as any,
					documentIndex: 1,
					taskDescription: 'Do something',
				},
			});

			// Verify error state
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe(
				'PAUSED_ERROR'
			);

			// Abort from error
			useBatchStore.getState().dispatchBatch({
				type: 'SET_STOPPING',
				sessionId: 'sess-1',
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.isStopping).toBe(true);
			expect(state.processingState).toBe('STOPPING');
			// Error should be cleared
			expect(state.error).toBeUndefined();
			expect(state.errorPaused).toBe(false);
			expect(state.errorDocumentIndex).toBeUndefined();
			expect(state.errorTaskDescription).toBeUndefined();
		});
	});

	// ==========================================================================
	// SET_ERROR detail fields
	// ==========================================================================

	describe('SET_ERROR detail fields', () => {
		it('stores errorDocumentIndex and errorTaskDescription', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_ERROR',
				sessionId: 'sess-1',
				payload: {
					error: { message: 'timeout', type: 'timeout_error' } as any,
					documentIndex: 3,
					taskDescription: 'Refactor auth module',
				},
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.errorDocumentIndex).toBe(3);
			expect(state.errorTaskDescription).toBe('Refactor auth module');
		});

		it('SET_ERROR without taskDescription leaves it undefined', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_ERROR',
				sessionId: 'sess-1',
				payload: {
					error: { message: 'err', type: 'process_error' } as any,
					documentIndex: 0,
				},
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.errorDocumentIndex).toBe(0);
			expect(state.errorTaskDescription).toBeUndefined();
		});
	});

	// ==========================================================================
	// COMPLETE_BATCH from different states
	// ==========================================================================

	describe('COMPLETE_BATCH from different states', () => {
		it('completes from STOPPING state', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_STOPPING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'COMPLETE_BATCH',
				sessionId: 'sess-1',
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.isRunning).toBe(false);
			expect(state.isStopping).toBe(false);
			expect(state.processingState).toBe('IDLE');
		});

		it('completes from RUNNING state directly', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'COMPLETE_BATCH',
				sessionId: 'sess-1',
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.isRunning).toBe(false);
			expect(state.processingState).toBe('IDLE');
		});

		it('preserves finalSessionIds when provided', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_COMPLETING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'COMPLETE_BATCH',
				sessionId: 'sess-1',
				finalSessionIds: ['agent-a', 'agent-b', 'agent-c'],
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.sessionIds).toEqual(['agent-a', 'agent-b', 'agent-c']);
		});

		it('keeps existing sessionIds when finalSessionIds not provided', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			// Simulate sessionIds being set via progress
			useBatchStore.getState().dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: { sessionIds: ['existing-1'] },
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_COMPLETING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'COMPLETE_BATCH',
				sessionId: 'sess-1',
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.sessionIds).toEqual(['existing-1']);
		});

		it('resets all fields on completion', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({
					documents: ['a.md', 'b.md'],
					totalTasksAcrossAllDocs: 10,
					worktreeActive: true,
					worktreePath: '/wt',
					loopEnabled: true,
				}),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: { completedTasksAcrossAllDocs: 5, currentDocumentIndex: 1 },
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_COMPLETING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'COMPLETE_BATCH',
				sessionId: 'sess-1',
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.isRunning).toBe(false);
			expect(state.documents).toEqual([]);
			expect(state.totalTasksAcrossAllDocs).toBe(0);
			expect(state.completedTasksAcrossAllDocs).toBe(0);
			expect(state.currentDocumentIndex).toBe(0);
			expect(state.worktreeActive).toBe(false);
			expect(state.worktreePath).toBeUndefined();
			expect(state.loopEnabled).toBe(false);
			expect(state.loopIteration).toBe(0);
			expect(state.folderPath).toBe('');
			expect(state.error).toBeUndefined();
			expect(state.errorPaused).toBe(false);
		});
	});

	// ==========================================================================
	// INCREMENT_LOOP accumulation
	// ==========================================================================

	describe('INCREMENT_LOOP accumulation', () => {
		it('accumulates totalTasksAcrossAllDocs with completed tasks', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({
					totalTasksAcrossAllDocs: 10,
					loopEnabled: true,
				}),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			// Simulate completing 10 tasks
			useBatchStore.getState().dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: { completedTasksAcrossAllDocs: 10, completedTasks: 10 },
			});
			// Loop: 8 new tasks
			useBatchStore.getState().dispatchBatch({
				type: 'INCREMENT_LOOP',
				sessionId: 'sess-1',
				newTotalTasks: 8,
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.loopIteration).toBe(1);
			// newTotalTasks (8) + completedTasksAcrossAllDocs (10) = 18
			expect(state.totalTasksAcrossAllDocs).toBe(18);
			// newTotalTasks (8) + completedTasks (10) = 18
			expect(state.totalTasks).toBe(18);
		});

		it('increments loop counter on successive loops', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({ loopEnabled: true }),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});

			useBatchStore.getState().dispatchBatch({
				type: 'INCREMENT_LOOP',
				sessionId: 'sess-1',
				newTotalTasks: 5,
			});
			expect(useBatchStore.getState().batchRunStates['sess-1'].loopIteration).toBe(1);

			useBatchStore.getState().dispatchBatch({
				type: 'INCREMENT_LOOP',
				sessionId: 'sess-1',
				newTotalTasks: 3,
			});
			expect(useBatchStore.getState().batchRunStates['sess-1'].loopIteration).toBe(2);
		});

		it('stays in RUNNING state after loop', () => {
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({ loopEnabled: true }),
			});
			useBatchStore.getState().dispatchBatch({
				type: 'SET_RUNNING',
				sessionId: 'sess-1',
			});
			useBatchStore.getState().dispatchBatch({
				type: 'INCREMENT_LOOP',
				sessionId: 'sess-1',
				newTotalTasks: 5,
			});

			const state = useBatchStore.getState().batchRunStates['sess-1'];
			expect(state.processingState).toBe('RUNNING');
			expect(state.isRunning).toBe(true);
		});
	});

	// ==========================================================================
	// Full lifecycle flows
	// ==========================================================================

	describe('full lifecycle flows', () => {
		it('happy path: IDLE → INITIALIZING → RUNNING → COMPLETING → IDLE', () => {
			const { dispatchBatch } = useBatchStore.getState();

			dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({ totalTasksAcrossAllDocs: 5 }),
			});
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe(
				'INITIALIZING'
			);

			dispatchBatch({ type: 'SET_RUNNING', sessionId: 'sess-1' });
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe('RUNNING');

			dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: { completedTasksAcrossAllDocs: 5 },
			});
			expect(useBatchStore.getState().batchRunStates['sess-1'].completedTasksAcrossAllDocs).toBe(5);

			dispatchBatch({ type: 'SET_COMPLETING', sessionId: 'sess-1' });
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe('COMPLETING');

			dispatchBatch({ type: 'COMPLETE_BATCH', sessionId: 'sess-1' });
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe('IDLE');
			expect(useBatchStore.getState().batchRunStates['sess-1'].isRunning).toBe(false);
		});

		it('error recovery: RUNNING → PAUSED_ERROR → RUNNING → COMPLETING → IDLE', () => {
			const { dispatchBatch } = useBatchStore.getState();

			dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			dispatchBatch({ type: 'SET_RUNNING', sessionId: 'sess-1' });

			// Error occurs
			dispatchBatch({
				type: 'SET_ERROR',
				sessionId: 'sess-1',
				payload: {
					error: { message: 'crash', type: 'process_error' } as any,
					documentIndex: 0,
				},
			});
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe(
				'PAUSED_ERROR'
			);
			expect(useBatchStore.getState().batchRunStates['sess-1'].errorPaused).toBe(true);

			// Error resolved
			dispatchBatch({ type: 'CLEAR_ERROR', sessionId: 'sess-1' });
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe('RUNNING');
			expect(useBatchStore.getState().batchRunStates['sess-1'].errorPaused).toBe(false);

			// Finish
			dispatchBatch({ type: 'SET_COMPLETING', sessionId: 'sess-1' });
			dispatchBatch({ type: 'COMPLETE_BATCH', sessionId: 'sess-1' });
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe('IDLE');
		});

		it('stop flow: RUNNING → STOPPING → IDLE', () => {
			const { dispatchBatch } = useBatchStore.getState();

			dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			dispatchBatch({ type: 'SET_RUNNING', sessionId: 'sess-1' });
			dispatchBatch({ type: 'SET_STOPPING', sessionId: 'sess-1' });
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe('STOPPING');

			dispatchBatch({ type: 'COMPLETE_BATCH', sessionId: 'sess-1' });
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe('IDLE');
			expect(useBatchStore.getState().batchRunStates['sess-1'].isRunning).toBe(false);
		});

		it('abort from error: PAUSED_ERROR → STOPPING → IDLE', () => {
			const { dispatchBatch } = useBatchStore.getState();

			dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			dispatchBatch({ type: 'SET_RUNNING', sessionId: 'sess-1' });
			dispatchBatch({
				type: 'SET_ERROR',
				sessionId: 'sess-1',
				payload: {
					error: { message: 'fatal', type: 'process_error' } as any,
					documentIndex: 0,
				},
			});
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe(
				'PAUSED_ERROR'
			);

			// User aborts instead of retrying
			dispatchBatch({ type: 'SET_STOPPING', sessionId: 'sess-1' });
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe('STOPPING');
			expect(useBatchStore.getState().batchRunStates['sess-1'].error).toBeUndefined();

			dispatchBatch({ type: 'COMPLETE_BATCH', sessionId: 'sess-1' });
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe('IDLE');
		});

		it('loop flow: RUNNING → loop → RUNNING → COMPLETING → IDLE', () => {
			const { dispatchBatch } = useBatchStore.getState();

			dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({ loopEnabled: true, totalTasksAcrossAllDocs: 5 }),
			});
			dispatchBatch({ type: 'SET_RUNNING', sessionId: 'sess-1' });

			// Complete first iteration
			dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: { completedTasksAcrossAllDocs: 5 },
			});
			dispatchBatch({
				type: 'INCREMENT_LOOP',
				sessionId: 'sess-1',
				newTotalTasks: 3,
			});
			expect(useBatchStore.getState().batchRunStates['sess-1'].loopIteration).toBe(1);
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe('RUNNING');

			// Complete second iteration and finish
			dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: { completedTasksAcrossAllDocs: 8 },
			});
			dispatchBatch({ type: 'SET_COMPLETING', sessionId: 'sess-1' });
			dispatchBatch({
				type: 'COMPLETE_BATCH',
				sessionId: 'sess-1',
				finalSessionIds: ['agent-1'],
			});
			expect(useBatchStore.getState().batchRunStates['sess-1'].processingState).toBe('IDLE');
		});
	});

	// ==========================================================================
	// Concurrent session interactions
	// ==========================================================================

	describe('concurrent session interactions', () => {
		it('stopping one session does not affect another running session', () => {
			const { dispatchBatch } = useBatchStore.getState();

			// Start two batches
			dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({ documents: ['a.md'] }),
			});
			dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-2',
				payload: createStartBatchPayload({ documents: ['b.md'] }),
			});
			dispatchBatch({ type: 'SET_RUNNING', sessionId: 'sess-1' });
			dispatchBatch({ type: 'SET_RUNNING', sessionId: 'sess-2' });

			// Stop only sess-1
			dispatchBatch({ type: 'SET_STOPPING', sessionId: 'sess-1' });

			expect(useBatchStore.getState().batchRunStates['sess-1'].isStopping).toBe(true);
			expect(useBatchStore.getState().batchRunStates['sess-2'].isStopping).toBe(false);
			expect(useBatchStore.getState().batchRunStates['sess-2'].isRunning).toBe(true);
		});

		it('erroring one session does not affect another', () => {
			const { dispatchBatch } = useBatchStore.getState();

			dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-2',
				payload: createStartBatchPayload(),
			});
			dispatchBatch({ type: 'SET_RUNNING', sessionId: 'sess-1' });
			dispatchBatch({ type: 'SET_RUNNING', sessionId: 'sess-2' });

			// Error on sess-1
			dispatchBatch({
				type: 'SET_ERROR',
				sessionId: 'sess-1',
				payload: {
					error: { message: 'err', type: 'process_error' } as any,
					documentIndex: 0,
				},
			});

			expect(useBatchStore.getState().batchRunStates['sess-1'].errorPaused).toBe(true);
			expect(useBatchStore.getState().batchRunStates['sess-2'].errorPaused).toBe(false);
			expect(useBatchStore.getState().batchRunStates['sess-2'].processingState).toBe('RUNNING');
		});

		it('completing one session does not affect another', () => {
			const { dispatchBatch } = useBatchStore.getState();

			dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-2',
				payload: createStartBatchPayload(),
			});
			dispatchBatch({ type: 'SET_RUNNING', sessionId: 'sess-1' });
			dispatchBatch({ type: 'SET_RUNNING', sessionId: 'sess-2' });

			// Complete sess-1
			dispatchBatch({ type: 'SET_COMPLETING', sessionId: 'sess-1' });
			dispatchBatch({ type: 'COMPLETE_BATCH', sessionId: 'sess-1' });

			expect(useBatchStore.getState().batchRunStates['sess-1'].isRunning).toBe(false);
			expect(useBatchStore.getState().batchRunStates['sess-2'].isRunning).toBe(true);
			expect(useBatchStore.getState().batchRunStates['sess-2'].processingState).toBe('RUNNING');
		});

		it('progress on one session preserves other session state', () => {
			const { dispatchBatch } = useBatchStore.getState();

			dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload({ totalTasksAcrossAllDocs: 10 }),
			});
			dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-2',
				payload: createStartBatchPayload({ totalTasksAcrossAllDocs: 20 }),
			});
			dispatchBatch({ type: 'SET_RUNNING', sessionId: 'sess-1' });
			dispatchBatch({ type: 'SET_RUNNING', sessionId: 'sess-2' });

			dispatchBatch({
				type: 'UPDATE_PROGRESS',
				sessionId: 'sess-1',
				payload: { completedTasksAcrossAllDocs: 5 },
			});

			expect(useBatchStore.getState().batchRunStates['sess-1'].completedTasksAcrossAllDocs).toBe(5);
			expect(useBatchStore.getState().batchRunStates['sess-2'].completedTasksAcrossAllDocs).toBe(0);
			expect(useBatchStore.getState().batchRunStates['sess-2'].totalTasksAcrossAllDocs).toBe(20);
		});
	});

	// ==========================================================================
	// Document + batch state isolation
	// ==========================================================================

	describe('document and batch state isolation', () => {
		it('document state changes do not affect batch run states', () => {
			// Start a batch
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			const batchRef = useBatchStore.getState().batchRunStates;

			// Modify document state
			useBatchStore.getState().setDocumentList(['new.md']);
			useBatchStore.getState().setDocumentTree([createTreeNode()]);
			useBatchStore.getState().updateTaskCount('new.md', 1, 3);

			// Batch state object reference should be unchanged
			expect(useBatchStore.getState().batchRunStates).toBe(batchRef);
		});

		it('batch state changes do not affect document state', () => {
			useBatchStore.getState().setDocumentList(['keep.md']);
			const docRef = useBatchStore.getState().documentList;

			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});

			expect(useBatchStore.getState().documentList).toBe(docRef);
			expect(useBatchStore.getState().documentList).toEqual(['keep.md']);
		});

		it('clearDocumentList does not affect batch run states', () => {
			useBatchStore.getState().setDocumentList(['a.md']);
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});

			useBatchStore.getState().clearDocumentList();

			expect(useBatchStore.getState().documentList).toEqual([]);
			expect(useBatchStore.getState().batchRunStates['sess-1'].isRunning).toBe(true);
		});

		it('clearCustomPrompts does not affect batch run states or documents', () => {
			useBatchStore.getState().setDocumentList(['a.md']);
			useBatchStore.getState().setCustomPrompt('sess-1', 'test');
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});

			useBatchStore.getState().clearCustomPrompts();

			expect(Object.keys(useBatchStore.getState().customPrompts)).toHaveLength(0);
			expect(useBatchStore.getState().documentList).toEqual(['a.md']);
			expect(useBatchStore.getState().batchRunStates['sess-1'].isRunning).toBe(true);
		});
	});

	// ==========================================================================
	// Store reset
	// ==========================================================================

	describe('store reset', () => {
		it('can reset entire store mid-batch', () => {
			useBatchStore.getState().setDocumentList(['a.md']);
			useBatchStore.getState().dispatchBatch({
				type: 'START_BATCH',
				sessionId: 'sess-1',
				payload: createStartBatchPayload(),
			});
			useBatchStore.getState().setCustomPrompt('sess-1', 'test');

			// Full reset
			useBatchStore.setState({
				documentList: [],
				documentTree: [],
				isLoadingDocuments: false,
				documentTaskCounts: new Map(),
				batchRunStates: {},
				customPrompts: {},
			});

			expect(useBatchStore.getState().documentList).toEqual([]);
			expect(Object.keys(useBatchStore.getState().batchRunStates)).toHaveLength(0);
			expect(Object.keys(useBatchStore.getState().customPrompts)).toHaveLength(0);
		});
	});
});
