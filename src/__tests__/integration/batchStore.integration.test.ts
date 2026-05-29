import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BATCH_STATE } from '../../renderer/hooks/batch/batchReducer';
import {
	getBatchActions,
	getBatchState,
	selectActiveBatchSessionIds,
	selectBatchRunState,
	selectHasAnyActiveBatch,
	selectStoppingBatchSessionIds,
	useBatchStore,
	type BatchStore,
} from '../../renderer/stores/batchStore';

const initialState: BatchStore = useBatchStore.getState();

describe('batchStore integration', () => {
	beforeEach(() => {
		useBatchStore.setState(initialState, true);
	});

	it('exposes default document and batch state snapshots', () => {
		expect(getBatchState()).toEqual(
			expect.objectContaining({
				documentList: [],
				documentTree: [],
				isLoadingDocuments: false,
				documentTaskCounts: new Map(),
				batchRunStates: {},
				customPrompts: {},
			})
		);
		expect(selectHasAnyActiveBatch(getBatchState())).toBe(false);
		expect(selectActiveBatchSessionIds(getBatchState())).toEqual([]);
		expect(selectStoppingBatchSessionIds(getBatchState())).toEqual([]);
		expect(selectBatchRunState(getBatchState(), 'missing')).toBeUndefined();
	});

	it('updates document state through value setters and stable action accessors', () => {
		const actions = getBatchActions();
		const counts = new Map([['draft.md', { completed: 1, total: 3 }]]);

		actions.setDocumentList(['draft.md']);
		actions.setDocumentTree([{ name: 'draft.md', path: 'draft.md', type: 'file' }]);
		actions.setIsLoadingDocuments(true);
		actions.setDocumentTaskCounts(counts);
		actions.updateTaskCount('notes.md', 2, 5);

		const state = getBatchState();
		expect(state.documentList).toEqual(['draft.md']);
		expect(state.documentTree).toEqual([{ name: 'draft.md', path: 'draft.md', type: 'file' }]);
		expect(state.isLoadingDocuments).toBe(true);
		expect(state.documentTaskCounts.get('draft.md')).toEqual({ completed: 1, total: 3 });
		expect(state.documentTaskCounts.get('notes.md')).toEqual({ completed: 2, total: 5 });

		actions.clearDocumentList();

		expect(getBatchState()).toEqual(
			expect.objectContaining({
				documentList: [],
				documentTree: [],
				documentTaskCounts: new Map(),
			})
		);
	});

	it('supports updater functions for document and bulk batch state', () => {
		const actions = getBatchActions();

		actions.setDocumentList((previous) => [...previous, 'one.md']);
		actions.setDocumentTree((previous) => [
			...previous,
			{ name: 'one.md', path: 'one.md', type: 'file' },
		]);
		actions.setIsLoadingDocuments((loading) => !loading);
		actions.setDocumentTaskCounts((previous) => {
			const next = new Map(previous);
			next.set('one.md', { completed: 0, total: 2 });
			return next;
		});
		actions.setBatchRunStates((previous) => ({
			...previous,
			'session-1': {
				...DEFAULT_BATCH_STATE,
				isRunning: true,
				isStopping: true,
				processingState: 'STOPPING',
			},
		}));

		const state = getBatchState();
		expect(state.documentList).toEqual(['one.md']);
		expect(state.documentTree).toHaveLength(1);
		expect(state.isLoadingDocuments).toBe(true);
		expect(state.documentTaskCounts.get('one.md')).toEqual({ completed: 0, total: 2 });
		expect(selectHasAnyActiveBatch(state)).toBe(true);
		expect(selectActiveBatchSessionIds(state)).toEqual(['session-1']);
		expect(selectStoppingBatchSessionIds(state)).toEqual(['session-1']);
		expect(selectBatchRunState(state, 'session-1')).toEqual(
			expect.objectContaining({ isRunning: true, isStopping: true })
		);
	});

	it('dispatches reducer actions and manages custom prompts', () => {
		const actions = getBatchActions();

		actions.dispatchBatch({
			type: 'START_BATCH',
			sessionId: 'session-2',
			payload: {
				documents: ['plan.md'],
				lockedDocuments: ['locked.md'],
				totalTasksAcrossAllDocs: 4,
				loopEnabled: true,
				maxLoops: 2,
				folderPath: '/tmp/docs',
				worktreeActive: true,
				worktreePath: '/tmp/worktree',
				worktreeBranch: 'feature/test',
				customPrompt: 'ship it',
				startTime: 100,
				cumulativeTaskTimeMs: 25,
				accumulatedElapsedMs: 50,
				lastActiveTimestamp: 150,
			},
		});
		actions.dispatchBatch({ type: 'SET_RUNNING', sessionId: 'session-2' });
		actions.setCustomPrompt('session-2', 'custom follow-up');

		expect(getBatchState().batchRunStates['session-2']).toEqual(
			expect.objectContaining({
				isRunning: true,
				processingState: 'RUNNING',
				documents: ['plan.md'],
				lockedDocuments: ['locked.md'],
				totalTasksAcrossAllDocs: 4,
				customPrompt: 'ship it',
				worktreePath: '/tmp/worktree',
				worktreeBranch: 'feature/test',
			})
		);
		expect(getBatchState().customPrompts).toEqual({ 'session-2': 'custom follow-up' });

		actions.clearCustomPrompts();

		expect(getBatchState().customPrompts).toEqual({});
	});
});
