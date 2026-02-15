/**
 * Tests for operationStore - Zustand store for operation state management
 *
 * Covers: summarize (per-tab), merge (per-tab + global flag),
 * transfer (global + global flag), cross-cutting selectors,
 * non-React access, and store reset.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	useOperationStore,
	getOperationState,
	getOperationActions,
	selectIsAnySummarizing,
	selectIsAnyMerging,
	selectIsAnyOperationInProgress,
} from '../../../renderer/stores/operationStore';
import type {
	TabSummarizeState,
	TabMergeState,
	TransferLastRequest,
} from '../../../renderer/stores/operationStore';

// ============================================================================
// Helpers
// ============================================================================

function createSummarizeState(overrides: Partial<TabSummarizeState> = {}): TabSummarizeState {
	return {
		state: 'idle',
		progress: null,
		result: null,
		error: null,
		startTime: 0,
		...overrides,
	};
}

function createMergeState(overrides: Partial<TabMergeState> = {}): TabMergeState {
	return {
		state: 'idle',
		progress: null,
		result: null,
		error: null,
		startTime: 0,
		...overrides,
	};
}

function createTransferLastRequest(
	overrides: Partial<TransferLastRequest> = {}
): TransferLastRequest {
	return {
		sourceSessionId: 'sess-1',
		sourceTabId: 'tab-1',
		targetAgent: 'claude-code' as any,
		skipGrooming: false,
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe('operationStore', () => {
	beforeEach(() => {
		useOperationStore.setState({
			summarizeStates: new Map(),
			mergeStates: new Map(),
			globalMergeInProgress: false,
			transferState: 'idle',
			transferProgress: null,
			transferError: null,
			transferStructuredError: null,
			transferLastRequest: null,
			globalTransferInProgress: false,
		});
	});

	// ==========================================================================
	// Initial state
	// ==========================================================================

	describe('initial state', () => {
		it('has empty summarize states', () => {
			expect(useOperationStore.getState().summarizeStates.size).toBe(0);
		});

		it('has empty merge states', () => {
			expect(useOperationStore.getState().mergeStates.size).toBe(0);
		});

		it('has globalMergeInProgress as false', () => {
			expect(useOperationStore.getState().globalMergeInProgress).toBe(false);
		});

		it('has transfer state as idle', () => {
			expect(useOperationStore.getState().transferState).toBe('idle');
		});

		it('has null transfer progress', () => {
			expect(useOperationStore.getState().transferProgress).toBeNull();
		});

		it('has null transfer error', () => {
			expect(useOperationStore.getState().transferError).toBeNull();
		});

		it('has null transfer structured error', () => {
			expect(useOperationStore.getState().transferStructuredError).toBeNull();
		});

		it('has null transfer last request', () => {
			expect(useOperationStore.getState().transferLastRequest).toBeNull();
		});

		it('has globalTransferInProgress as false', () => {
			expect(useOperationStore.getState().globalTransferInProgress).toBe(false);
		});
	});

	// ==========================================================================
	// Summarize state
	// ==========================================================================

	describe('summarize state', () => {
		it('sets a tab summarize state', () => {
			const ts = createSummarizeState({ state: 'summarizing', startTime: 1000 });
			useOperationStore.getState().setSummarizeTabState('tab-1', ts);
			expect(useOperationStore.getState().summarizeStates.get('tab-1')).toEqual(ts);
		});

		it('sets multiple tab states independently', () => {
			const ts1 = createSummarizeState({ state: 'summarizing' });
			const ts2 = createSummarizeState({ state: 'complete' });
			useOperationStore.getState().setSummarizeTabState('tab-1', ts1);
			useOperationStore.getState().setSummarizeTabState('tab-2', ts2);
			expect(useOperationStore.getState().summarizeStates.size).toBe(2);
			expect(useOperationStore.getState().summarizeStates.get('tab-1')?.state).toBe('summarizing');
			expect(useOperationStore.getState().summarizeStates.get('tab-2')?.state).toBe('complete');
		});

		it('overwrites existing tab state', () => {
			const ts1 = createSummarizeState({ state: 'summarizing' });
			const ts2 = createSummarizeState({ state: 'error', error: 'Something failed' });
			useOperationStore.getState().setSummarizeTabState('tab-1', ts1);
			useOperationStore.getState().setSummarizeTabState('tab-1', ts2);
			expect(useOperationStore.getState().summarizeStates.get('tab-1')?.state).toBe('error');
			expect(useOperationStore.getState().summarizeStates.get('tab-1')?.error).toBe(
				'Something failed'
			);
		});

		it('updates partial tab state', () => {
			const ts = createSummarizeState({ state: 'summarizing', startTime: 1000 });
			useOperationStore.getState().setSummarizeTabState('tab-1', ts);
			useOperationStore.getState().updateSummarizeTabState('tab-1', {
				progress: {
					stage: 'summarizing',
					progress: 50,
					message: 'Halfway',
					estimatedContextReduction: 0.5,
				},
			});
			const updated = useOperationStore.getState().summarizeStates.get('tab-1');
			expect(updated?.state).toBe('summarizing');
			expect(updated?.progress?.progress).toBe(50);
			expect(updated?.startTime).toBe(1000);
		});

		it('updateSummarizeTabState is a no-op for missing tab', () => {
			const before = useOperationStore.getState().summarizeStates;
			useOperationStore.getState().updateSummarizeTabState('nonexistent', { state: 'complete' });
			expect(useOperationStore.getState().summarizeStates).toBe(before);
		});

		it('clears a specific tab state', () => {
			useOperationStore.getState().setSummarizeTabState('tab-1', createSummarizeState());
			useOperationStore.getState().setSummarizeTabState('tab-2', createSummarizeState());
			useOperationStore.getState().clearSummarizeTabState('tab-1');
			expect(useOperationStore.getState().summarizeStates.has('tab-1')).toBe(false);
			expect(useOperationStore.getState().summarizeStates.has('tab-2')).toBe(true);
		});

		it('clearSummarizeTabState is a no-op for missing tab', () => {
			const before = useOperationStore.getState().summarizeStates;
			useOperationStore.getState().clearSummarizeTabState('nonexistent');
			expect(useOperationStore.getState().summarizeStates).toBe(before);
		});

		it('clears all summarize states', () => {
			useOperationStore.getState().setSummarizeTabState('tab-1', createSummarizeState());
			useOperationStore.getState().setSummarizeTabState('tab-2', createSummarizeState());
			useOperationStore.getState().clearAllSummarizeStates();
			expect(useOperationStore.getState().summarizeStates.size).toBe(0);
		});

		it('creates new Map reference on set', () => {
			const before = useOperationStore.getState().summarizeStates;
			useOperationStore.getState().setSummarizeTabState('tab-1', createSummarizeState());
			expect(useOperationStore.getState().summarizeStates).not.toBe(before);
		});
	});

	// ==========================================================================
	// Merge state
	// ==========================================================================

	describe('merge state', () => {
		it('sets a tab merge state', () => {
			const ms = createMergeState({
				state: 'merging',
				startTime: 2000,
				sourceName: 'Session A',
				targetName: 'Session B',
			});
			useOperationStore.getState().setMergeTabState('tab-1', ms);
			const stored = useOperationStore.getState().mergeStates.get('tab-1');
			expect(stored?.state).toBe('merging');
			expect(stored?.sourceName).toBe('Session A');
			expect(stored?.targetName).toBe('Session B');
		});

		it('sets multiple tab merge states independently', () => {
			useOperationStore
				.getState()
				.setMergeTabState('tab-1', createMergeState({ state: 'merging' }));
			useOperationStore
				.getState()
				.setMergeTabState('tab-2', createMergeState({ state: 'complete' }));
			expect(useOperationStore.getState().mergeStates.size).toBe(2);
		});

		it('updates partial merge tab state', () => {
			const ms = createMergeState({ state: 'merging', startTime: 2000 });
			useOperationStore.getState().setMergeTabState('tab-1', ms);
			useOperationStore.getState().updateMergeTabState('tab-1', {
				progress: { stage: 'grooming', progress: 75, message: 'Almost done' },
			});
			const updated = useOperationStore.getState().mergeStates.get('tab-1');
			expect(updated?.progress?.progress).toBe(75);
			expect(updated?.startTime).toBe(2000);
		});

		it('updateMergeTabState is a no-op for missing tab', () => {
			const before = useOperationStore.getState().mergeStates;
			useOperationStore.getState().updateMergeTabState('nonexistent', { state: 'complete' });
			expect(useOperationStore.getState().mergeStates).toBe(before);
		});

		it('clears a specific merge tab state', () => {
			useOperationStore.getState().setMergeTabState('tab-1', createMergeState());
			useOperationStore.getState().setMergeTabState('tab-2', createMergeState());
			useOperationStore.getState().clearMergeTabState('tab-1');
			expect(useOperationStore.getState().mergeStates.has('tab-1')).toBe(false);
			expect(useOperationStore.getState().mergeStates.has('tab-2')).toBe(true);
		});

		it('clearMergeTabState is a no-op for missing tab', () => {
			const before = useOperationStore.getState().mergeStates;
			useOperationStore.getState().clearMergeTabState('nonexistent');
			expect(useOperationStore.getState().mergeStates).toBe(before);
		});

		it('clears all merge states', () => {
			useOperationStore.getState().setMergeTabState('tab-1', createMergeState());
			useOperationStore.getState().setMergeTabState('tab-2', createMergeState());
			useOperationStore.getState().clearAllMergeStates();
			expect(useOperationStore.getState().mergeStates.size).toBe(0);
		});

		it('sets global merge in progress flag', () => {
			useOperationStore.getState().setGlobalMergeInProgress(true);
			expect(useOperationStore.getState().globalMergeInProgress).toBe(true);
			useOperationStore.getState().setGlobalMergeInProgress(false);
			expect(useOperationStore.getState().globalMergeInProgress).toBe(false);
		});

		it('creates new Map reference on set', () => {
			const before = useOperationStore.getState().mergeStates;
			useOperationStore.getState().setMergeTabState('tab-1', createMergeState());
			expect(useOperationStore.getState().mergeStates).not.toBe(before);
		});
	});

	// ==========================================================================
	// Transfer state
	// ==========================================================================

	describe('transfer state', () => {
		it('sets transfer state partially', () => {
			useOperationStore.getState().setTransferState({ state: 'grooming' });
			expect(useOperationStore.getState().transferState).toBe('grooming');
			expect(useOperationStore.getState().transferProgress).toBeNull();
		});

		it('sets transfer progress', () => {
			const progress = { stage: 'grooming' as const, progress: 30, message: 'Grooming...' };
			useOperationStore.getState().setTransferState({ progress });
			expect(useOperationStore.getState().transferProgress).toEqual(progress);
		});

		it('sets transfer error string', () => {
			useOperationStore.getState().setTransferState({ error: 'Something went wrong' });
			expect(useOperationStore.getState().transferError).toBe('Something went wrong');
		});

		it('sets structured transfer error', () => {
			const transferError = {
				type: 'grooming_failed' as const,
				message: 'Grooming failed',
				details: 'Details here',
				recoverable: true,
			};
			useOperationStore.getState().setTransferState({ transferError });
			expect(useOperationStore.getState().transferStructuredError).toEqual(transferError);
		});

		it('sets transfer last request', () => {
			const lastRequest = createTransferLastRequest();
			useOperationStore.getState().setTransferState({ lastRequest });
			expect(useOperationStore.getState().transferLastRequest).toEqual(lastRequest);
		});

		it('sets multiple transfer fields at once', () => {
			useOperationStore.getState().setTransferState({
				state: 'error',
				error: 'Failed',
				transferError: {
					type: 'grooming_failed' as const,
					message: 'Grooming failed',
					details: 'Details',
					recoverable: true,
				},
			});
			expect(useOperationStore.getState().transferState).toBe('error');
			expect(useOperationStore.getState().transferError).toBe('Failed');
			expect(useOperationStore.getState().transferStructuredError?.type).toBe('grooming_failed');
		});

		it('does not clear unspecified fields on partial update', () => {
			useOperationStore.getState().setTransferState({
				state: 'grooming',
				progress: { stage: 'collecting', progress: 0, message: 'Starting...' },
			});
			useOperationStore.getState().setTransferState({ state: 'creating' });
			// progress should remain unchanged
			expect(useOperationStore.getState().transferProgress?.stage).toBe('collecting');
		});

		it('resets transfer state to initial', () => {
			useOperationStore.getState().setTransferState({
				state: 'error',
				error: 'Failed',
				progress: { stage: 'grooming', progress: 50, message: 'Mid' },
				lastRequest: createTransferLastRequest(),
			});
			useOperationStore.getState().resetTransferState();
			expect(useOperationStore.getState().transferState).toBe('idle');
			expect(useOperationStore.getState().transferProgress).toBeNull();
			expect(useOperationStore.getState().transferError).toBeNull();
			expect(useOperationStore.getState().transferStructuredError).toBeNull();
			expect(useOperationStore.getState().transferLastRequest).toBeNull();
		});

		it('sets global transfer in progress flag', () => {
			useOperationStore.getState().setGlobalTransferInProgress(true);
			expect(useOperationStore.getState().globalTransferInProgress).toBe(true);
			useOperationStore.getState().setGlobalTransferInProgress(false);
			expect(useOperationStore.getState().globalTransferInProgress).toBe(false);
		});

		it('resetTransferState does not affect global flag', () => {
			useOperationStore.getState().setGlobalTransferInProgress(true);
			useOperationStore.getState().resetTransferState();
			expect(useOperationStore.getState().globalTransferInProgress).toBe(true);
		});
	});

	// ==========================================================================
	// Selectors
	// ==========================================================================

	describe('selectors', () => {
		describe('selectIsAnySummarizing', () => {
			it('returns false when no tabs are summarizing', () => {
				expect(selectIsAnySummarizing(useOperationStore.getState())).toBe(false);
			});

			it('returns false when tabs are idle or complete', () => {
				useOperationStore
					.getState()
					.setSummarizeTabState('tab-1', createSummarizeState({ state: 'idle' }));
				useOperationStore
					.getState()
					.setSummarizeTabState('tab-2', createSummarizeState({ state: 'complete' }));
				expect(selectIsAnySummarizing(useOperationStore.getState())).toBe(false);
			});

			it('returns true when any tab is summarizing', () => {
				useOperationStore
					.getState()
					.setSummarizeTabState('tab-1', createSummarizeState({ state: 'idle' }));
				useOperationStore
					.getState()
					.setSummarizeTabState('tab-2', createSummarizeState({ state: 'summarizing' }));
				expect(selectIsAnySummarizing(useOperationStore.getState())).toBe(true);
			});
		});

		describe('selectIsAnyMerging', () => {
			it('returns false when no tabs are merging', () => {
				expect(selectIsAnyMerging(useOperationStore.getState())).toBe(false);
			});

			it('returns false when tabs are idle or error', () => {
				useOperationStore.getState().setMergeTabState('tab-1', createMergeState({ state: 'idle' }));
				useOperationStore
					.getState()
					.setMergeTabState('tab-2', createMergeState({ state: 'error' }));
				expect(selectIsAnyMerging(useOperationStore.getState())).toBe(false);
			});

			it('returns true when any tab is merging', () => {
				useOperationStore
					.getState()
					.setMergeTabState('tab-1', createMergeState({ state: 'merging' }));
				expect(selectIsAnyMerging(useOperationStore.getState())).toBe(true);
			});
		});

		describe('selectIsAnyOperationInProgress', () => {
			it('returns false when all idle', () => {
				expect(selectIsAnyOperationInProgress(useOperationStore.getState())).toBe(false);
			});

			it('returns true when summarizing', () => {
				useOperationStore
					.getState()
					.setSummarizeTabState('tab-1', createSummarizeState({ state: 'summarizing' }));
				expect(selectIsAnyOperationInProgress(useOperationStore.getState())).toBe(true);
			});

			it('returns true when merging', () => {
				useOperationStore
					.getState()
					.setMergeTabState('tab-1', createMergeState({ state: 'merging' }));
				expect(selectIsAnyOperationInProgress(useOperationStore.getState())).toBe(true);
			});

			it('returns true when transfer is grooming', () => {
				useOperationStore.getState().setTransferState({ state: 'grooming' });
				expect(selectIsAnyOperationInProgress(useOperationStore.getState())).toBe(true);
			});

			it('returns true when transfer is creating', () => {
				useOperationStore.getState().setTransferState({ state: 'creating' });
				expect(selectIsAnyOperationInProgress(useOperationStore.getState())).toBe(true);
			});

			it('returns false when transfer is error or complete', () => {
				useOperationStore.getState().setTransferState({ state: 'error' });
				expect(selectIsAnyOperationInProgress(useOperationStore.getState())).toBe(false);
				useOperationStore.getState().setTransferState({ state: 'complete' });
				expect(selectIsAnyOperationInProgress(useOperationStore.getState())).toBe(false);
			});
		});
	});

	// ==========================================================================
	// Cross-cutting: resetAll
	// ==========================================================================

	describe('resetAll', () => {
		it('resets all state to initial values', () => {
			// Set up various state across all operations
			useOperationStore
				.getState()
				.setSummarizeTabState('tab-1', createSummarizeState({ state: 'summarizing' }));
			useOperationStore
				.getState()
				.setMergeTabState('tab-2', createMergeState({ state: 'merging' }));
			useOperationStore.getState().setGlobalMergeInProgress(true);
			useOperationStore.getState().setTransferState({ state: 'grooming', error: 'err' });
			useOperationStore.getState().setGlobalTransferInProgress(true);

			// Reset everything
			useOperationStore.getState().resetAll();

			const state = useOperationStore.getState();
			expect(state.summarizeStates.size).toBe(0);
			expect(state.mergeStates.size).toBe(0);
			expect(state.globalMergeInProgress).toBe(false);
			expect(state.transferState).toBe('idle');
			expect(state.transferProgress).toBeNull();
			expect(state.transferError).toBeNull();
			expect(state.transferStructuredError).toBeNull();
			expect(state.transferLastRequest).toBeNull();
			expect(state.globalTransferInProgress).toBe(false);
		});
	});

	// ==========================================================================
	// Action stability
	// ==========================================================================

	describe('action stability', () => {
		it('actions are stable across state changes', () => {
			const actions1 = {
				setSummarizeTabState: useOperationStore.getState().setSummarizeTabState,
				setMergeTabState: useOperationStore.getState().setMergeTabState,
				setTransferState: useOperationStore.getState().setTransferState,
				resetAll: useOperationStore.getState().resetAll,
			};

			// Trigger state change
			useOperationStore.getState().setSummarizeTabState('tab-1', createSummarizeState());

			const actions2 = {
				setSummarizeTabState: useOperationStore.getState().setSummarizeTabState,
				setMergeTabState: useOperationStore.getState().setMergeTabState,
				setTransferState: useOperationStore.getState().setTransferState,
				resetAll: useOperationStore.getState().resetAll,
			};

			expect(actions1.setSummarizeTabState).toBe(actions2.setSummarizeTabState);
			expect(actions1.setMergeTabState).toBe(actions2.setMergeTabState);
			expect(actions1.setTransferState).toBe(actions2.setTransferState);
			expect(actions1.resetAll).toBe(actions2.resetAll);
		});
	});

	// ==========================================================================
	// Non-React access
	// ==========================================================================

	describe('non-React access', () => {
		it('getOperationState returns current snapshot', () => {
			useOperationStore.getState().setGlobalMergeInProgress(true);
			expect(getOperationState().globalMergeInProgress).toBe(true);
		});

		it('getOperationActions returns working methods', () => {
			const actions = getOperationActions();
			actions.setSummarizeTabState('tab-1', createSummarizeState({ state: 'summarizing' }));
			expect(useOperationStore.getState().summarizeStates.get('tab-1')?.state).toBe('summarizing');
		});

		it('getOperationActions returns all expected methods', () => {
			const actions = getOperationActions();
			const expectedMethods = [
				'setSummarizeTabState',
				'updateSummarizeTabState',
				'clearSummarizeTabState',
				'clearAllSummarizeStates',
				'setMergeTabState',
				'updateMergeTabState',
				'clearMergeTabState',
				'clearAllMergeStates',
				'setGlobalMergeInProgress',
				'setTransferState',
				'resetTransferState',
				'setGlobalTransferInProgress',
				'resetAll',
			];
			for (const method of expectedMethods) {
				expect(typeof (actions as any)[method]).toBe('function');
			}
		});
	});
});
