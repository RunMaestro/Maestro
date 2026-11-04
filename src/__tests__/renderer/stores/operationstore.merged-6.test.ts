// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/stores/operationStore.test.ts
// Source: src/__tests__/renderer/stores/contextTimelineStore.test.ts
// Source: src/__tests__/renderer/stores/crossAgentInFlightStore.test.ts
// Source: src/__tests__/renderer/stores/composerInputStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
	useOperationStore,
	selectIsAnySummarizing,
	selectIsAnyMerging,
} from '../../../renderer/stores/operationStore';
import type {
	TabSummarizeState,
	TabMergeState,
	TransferLastRequest,
} from '../../../renderer/stores/operationStore';
import {
	useContextTimelineStore,
	selectPoints,
	MAX_POINTS_PER_SESSION,
	CONTEXT_SURFACE_MIN_WIDTH,
	CONTEXT_SURFACE_WIDTH,
	resolveContextSurfaceWidth,
	type ContextTimelinePointInput,
} from '../../../renderer/stores/contextTimelineStore';
import {
	useCrossAgentInFlightStore,
	selectInFlightForTab,
	selectConsultedSessionIds,
	type InFlightCrossAgentRequest,
} from '../../../renderer/stores/crossAgentInFlightStore';
import {
	useComposerInputStore,
	selectAiComposerValue,
	selectTerminalComposerValue,
	selectMentionRoutingOverride,
} from '../../../renderer/stores/composerInputStore';
// Source: src/__tests__/renderer/stores/operationStore.test.ts
describe('', () => {
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
				expect(useOperationStore.getState().summarizeStates.get('tab-1')?.state).toBe(
					'summarizing'
				);
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
					useOperationStore
						.getState()
						.setMergeTabState('tab-1', createMergeState({ state: 'idle' }));
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
			it('useOperationStore.getState() returns current snapshot', () => {
				useOperationStore.getState().setGlobalMergeInProgress(true);
				expect(useOperationStore.getState().globalMergeInProgress).toBe(true);
			});
			it('useOperationStore.getState() exposes working methods', () => {
				useOperationStore
					.getState()
					.setSummarizeTabState('tab-1', createSummarizeState({ state: 'summarizing' }));
				expect(useOperationStore.getState().summarizeStates.get('tab-1')?.state).toBe(
					'summarizing'
				);
			});
			it('useOperationStore.getState() exposes all expected methods', () => {
				const state = useOperationStore.getState();
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
					expect(typeof (state as any)[method]).toBe('function');
				}
			});
		});
	});
});
// Source: src/__tests__/renderer/stores/contextTimelineStore.test.ts
describe('', () => {
	const SID = 'session-1';
	const TAB = 'tab-a';
	/** Build a point input with sane defaults; override per test. */
	function pt(overrides: Partial<ContextTimelinePointInput> = {}): ContextTimelinePointInput {
		return {
			tabId: TAB,
			inputTokens: 100,
			outputTokens: 20,
			cacheReadInputTokens: 50,
			cacheCreationInputTokens: 10,
			reasoningTokens: 0,
			totalCostUsd: 0,
			contextTokens: 160,
			contextWindow: 200000,
			percentage: 1,
			...overrides,
		};
	}
	function reset() {
		useContextTimelineStore.setState({
			panelSessionId: null,
			anchorRect: null,
			sourceSize: null,
			buffers: {},
		});
	}
	describe('contextTimelineStore', () => {
		beforeEach(reset);
		it('starts hidden with no buffers', () => {
			const s = useContextTimelineStore.getState();
			expect(s.panelSessionId).toBeNull();
			expect(s.buffers).toEqual({});
		});
		it('appendPoint records points without any panel being open (always-on)', () => {
			useContextTimelineStore.getState().appendPoint(SID, pt({ percentage: 5 }));
			const points = selectPoints(SID)(useContextTimelineStore.getState());
			expect(points).toHaveLength(1);
			expect(points[0].percentage).toBe(5);
			expect(points[0].tabId).toBe(TAB);
			// id + timestamp are stamped by the store.
			expect(points[0].id).toBeTruthy();
			expect(typeof points[0].timestamp).toBe('number');
			// The panel stays hidden - capture is independent of focus.
			expect(useContextTimelineStore.getState().panelSessionId).toBeNull();
		});
		it('appendPoint is a no-op for an empty session id', () => {
			useContextTimelineStore.getState().appendPoint('', pt());
			expect(useContextTimelineStore.getState().buffers).toEqual({});
		});
		it('keeps separate buffers per session', () => {
			const store = useContextTimelineStore.getState();
			store.appendPoint(SID, pt({ percentage: 1 }));
			store.appendPoint('session-2', pt({ percentage: 2 }));
			expect(selectPoints(SID)(useContextTimelineStore.getState())).toHaveLength(1);
			expect(selectPoints('session-2')(useContextTimelineStore.getState())).toHaveLength(1);
		});
		it('openPanel focuses the session and seeds an empty buffer when none exists', () => {
			useContextTimelineStore.getState().openPanel(SID);
			const s = useContextTimelineStore.getState();
			expect(s.panelSessionId).toBe(SID);
			expect(s.buffers[SID]).toEqual({ points: [], trimmed: false });
		});
		it('openPanel preserves history already captured before the panel opened', () => {
			const store = useContextTimelineStore.getState();
			store.appendPoint(SID, pt());
			store.openPanel(SID);
			expect(selectPoints(SID)(useContextTimelineStore.getState())).toHaveLength(1);
		});
		it('openPanel stores the anchor rect it was given', () => {
			const rect = { top: 10, left: 20, bottom: 30, right: 120, width: 100, height: 20 };
			useContextTimelineStore.getState().openPanel(SID, rect);
			expect(useContextTimelineStore.getState().anchorRect).toEqual(rect);
		});
		it('openPanel with no anchor clears any previous anchor (dock fallback)', () => {
			const rect = { top: 10, left: 20, bottom: 30, right: 120, width: 100, height: 20 };
			useContextTimelineStore.getState().openPanel(SID, rect);
			useContextTimelineStore.getState().openPanel(SID);
			expect(useContextTimelineStore.getState().anchorRect).toBeNull();
		});
		it('closePanel clears the anchor rect', () => {
			const rect = { top: 10, left: 20, bottom: 30, right: 120, width: 100, height: 20 };
			useContextTimelineStore.getState().openPanel(SID, rect);
			useContextTimelineStore.getState().closePanel();
			expect(useContextTimelineStore.getState().anchorRect).toBeNull();
		});
		it('togglePanel opens when hidden and closes on a second call for the same session', () => {
			const rect = { top: 10, left: 20, bottom: 30, right: 120, width: 100, height: 20 };
			const store = useContextTimelineStore.getState();
			store.appendPoint(SID, pt());
			store.togglePanel(SID, rect);
			expect(useContextTimelineStore.getState().panelSessionId).toBe(SID);
			expect(useContextTimelineStore.getState().anchorRect).toEqual(rect);
			// The gauge is the only open/close control, so the second press must put
			// the panel away rather than re-opening it in place.
			store.togglePanel(SID, rect);
			expect(useContextTimelineStore.getState().panelSessionId).toBeNull();
			expect(useContextTimelineStore.getState().anchorRect).toBeNull();
			// Closing is not clearing: the recorded history survives the round trip.
			expect(selectPoints(SID)(useContextTimelineStore.getState())).toHaveLength(1);
		});
		it('togglePanel re-targets rather than closing when a DIFFERENT session is showing', () => {
			const rect = { top: 10, left: 20, bottom: 30, right: 120, width: 100, height: 20 };
			const store = useContextTimelineStore.getState();
			store.togglePanel(SID, rect);
			// Clicking another agent's gauge asks to see THAT agent, not to dismiss.
			store.togglePanel('other', rect);
			const s = useContextTimelineStore.getState();
			expect(s.panelSessionId).toBe('other');
			expect(s.buffers.other).toEqual({ points: [], trimmed: false });
		});
		it('togglePanel carries the measured popover size, and closing clears it', () => {
			const rect = { top: 10, left: 20, bottom: 30, right: 120, width: 100, height: 20 };
			const size = { width: 480, height: 512 };
			const store = useContextTimelineStore.getState();
			store.togglePanel(SID, rect, size);
			expect(useContextTimelineStore.getState().sourceSize).toEqual(size);
			store.togglePanel(SID, rect, size);
			expect(useContextTimelineStore.getState().sourceSize).toBeNull();
		});
		it('an open with nothing measured does not inherit the previous open size', () => {
			const store = useContextTimelineStore.getState();
			store.openPanel(SID, null, { width: 480, height: 512 });
			store.openPanel(SID);
			expect(useContextTimelineStore.getState().sourceSize).toBeNull();
		});
		it('closePanel clears the measured size', () => {
			const store = useContextTimelineStore.getState();
			store.openPanel(SID, null, { width: 480, height: 512 });
			store.closePanel();
			expect(useContextTimelineStore.getState().sourceSize).toBeNull();
		});
		it('closePanel hides the panel but KEEPS the history', () => {
			const store = useContextTimelineStore.getState();
			store.appendPoint(SID, pt());
			store.openPanel(SID);
			store.closePanel();
			const s = useContextTimelineStore.getState();
			expect(s.panelSessionId).toBeNull();
			expect(selectPoints(SID)(s)).toHaveLength(1);
		});
		it('clearSession wipes the points but keeps the session key', () => {
			const store = useContextTimelineStore.getState();
			store.appendPoint(SID, pt());
			store.appendPoint(SID, pt());
			store.clearSession(SID);
			const s = useContextTimelineStore.getState();
			expect(selectPoints(SID)(s)).toHaveLength(0);
			// `hydrated` stays true after a clear: Clear also wipes main's capture log,
			// so re-fetching would only restore what the user just discarded.
			expect(s.buffers[SID]).toEqual({ points: [], trimmed: false, hydrated: true });
		});
		it('bounds the buffer at MAX_POINTS_PER_SESSION and sets trimmed', () => {
			const store = useContextTimelineStore.getState();
			for (let i = 0; i < MAX_POINTS_PER_SESSION + 5; i++) {
				store.appendPoint(SID, pt({ percentage: i }));
			}
			const s = useContextTimelineStore.getState();
			const points = selectPoints(SID)(s);
			expect(points).toHaveLength(MAX_POINTS_PER_SESSION);
			expect(s.buffers[SID].trimmed).toBe(true);
			// Oldest dropped: the first surviving point is index 5, not 0.
			expect(points[0].percentage).toBe(5);
			expect(points[points.length - 1].percentage).toBe(MAX_POINTS_PER_SESSION + 4);
		});
		it('selectPoints returns a stable empty array for unknown sessions', () => {
			const a = selectPoints('nope')(useContextTimelineStore.getState());
			const b = selectPoints(null)(useContextTimelineStore.getState());
			expect(a).toEqual([]);
			expect(b).toEqual([]);
			// The empty array is a shared constant, not a fresh allocation each call.
			expect(a).toBe(b);
		});
		it('removeSession drops the buffer entirely and hides the panel if focused', () => {
			const store = useContextTimelineStore.getState();
			store.appendPoint(SID, pt());
			store.openPanel(SID);
			store.removeSession(SID);
			const s = useContextTimelineStore.getState();
			// Key is gone (not just emptied), and the focused panel is hidden.
			expect(s.buffers[SID]).toBeUndefined();
			expect(s.panelSessionId).toBeNull();
		});
		it('removeSession leaves an unfocused panel untouched', () => {
			const store = useContextTimelineStore.getState();
			store.appendPoint(SID, pt());
			store.appendPoint('other', pt());
			store.openPanel('other');
			store.removeSession(SID);
			const s = useContextTimelineStore.getState();
			expect(s.buffers[SID]).toBeUndefined();
			expect(s.panelSessionId).toBe('other');
		});
		// --- hydrateSession (finding S1) ---
		it('hydrateSession fills an empty buffer and marks it hydrated', () => {
			useContextTimelineStore
				.getState()
				.hydrateSession(SID, [{ ...pt(), seq: 1, timestamp: 111 }], false);
			const buffer = useContextTimelineStore.getState().buffers[SID];
			expect(buffer.points).toHaveLength(1);
			expect(buffer.points[0].timestamp).toBe(111);
			expect(buffer.hydrated).toBe(true);
		});
		it('hydrateSession skips a capture whose seq already landed live', () => {
			const store = useContextTimelineStore.getState();
			store.appendPoint(SID, pt({ seq: 2, contextTokens: 222 }));
			store.hydrateSession(
				SID,
				[
					{ ...pt(), seq: 1, timestamp: 100, contextTokens: 111 },
					{ ...pt(), seq: 2, timestamp: 200, contextTokens: 999 },
				],
				false
			);
			const points = useContextTimelineStore.getState().buffers[SID].points;
			expect(points.map((p) => p.seq)).toEqual([1, 2]);
			expect(points.map((p) => p.contextTokens)).toEqual([111, 222]);
		});
		it('hydrateSession bounds the merged buffer at MAX_POINTS_PER_SESSION', () => {
			const incoming = Array.from({ length: MAX_POINTS_PER_SESSION + 3 }, (_, i) => ({
				...pt({ contextTokens: i }),
				seq: i + 1,
				timestamp: i + 1,
			}));
			useContextTimelineStore.getState().hydrateSession(SID, incoming, false);
			const buffer = useContextTimelineStore.getState().buffers[SID];
			expect(buffer.points).toHaveLength(MAX_POINTS_PER_SESSION);
			expect(buffer.trimmed).toBe(true);
			expect(buffer.points[0].contextTokens).toBe(3);
		});
		it('hydrateSession marks the buffer hydrated even when nothing came back', () => {
			useContextTimelineStore.getState().hydrateSession(SID, [], true);
			const buffer = useContextTimelineStore.getState().buffers[SID];
			expect(buffer.points).toHaveLength(0);
			expect(buffer.trimmed).toBe(true);
			expect(buffer.hydrated).toBe(true);
		});
	});
	describe('resolveContextSurfaceWidth', () => {
		it('uses the shared default when the Timeline was never resized', () => {
			expect(resolveContextSurfaceWidth(undefined)).toBe(CONTEXT_SURFACE_WIDTH);
		});
		it('follows the width the user dragged the Timeline to', () => {
			expect(resolveContextSurfaceWidth({ width: 430, height: 502 })).toBe(430);
		});
		it('never goes narrower than the Timeline allows', () => {
			expect(resolveContextSurfaceWidth({ width: 200, height: 502 })).toBe(
				CONTEXT_SURFACE_MIN_WIDTH
			);
		});
		it('ignores a malformed saved size', () => {
			expect(resolveContextSurfaceWidth({ width: 'wide', height: 502 })).toBe(
				CONTEXT_SURFACE_WIDTH
			);
		});
	});
});
// Source: src/__tests__/renderer/stores/crossAgentInFlightStore.test.ts
describe('', () => {
	/**
	 * The in-flight store backs the "N agents responding…" indicator. It must
	 * register/remove requests cleanly and let the indicator scope to one source
	 * tab.
	 */
	function req(overrides: Partial<InFlightCrossAgentRequest> = {}): InFlightCrossAgentRequest {
		return {
			requestId: 'r1',
			sourceSessionId: 'src',
			sourceTabId: 'tab',
			targetSessionId: 'tgt',
			targetAgentName: 'Codex',
			targetToolType: 'codex',
			startedAt: 1000,
			...overrides,
		};
	}
	describe('crossAgentInFlightStore', () => {
		beforeEach(() => {
			useCrossAgentInFlightStore.setState({ requests: {} });
		});
		it('registers a dispatched request and removes it on finish', () => {
			const { start, finish } = useCrossAgentInFlightStore.getState();
			start(req());
			expect(useCrossAgentInFlightStore.getState().requests['r1']).toBeDefined();
			finish('r1');
			expect(useCrossAgentInFlightStore.getState().requests['r1']).toBeUndefined();
		});
		it('ignores a duplicate start for the same requestId', () => {
			const { start } = useCrossAgentInFlightStore.getState();
			start(req({ targetAgentName: 'First' }));
			start(req({ targetAgentName: 'Second' }));
			expect(useCrossAgentInFlightStore.getState().requests['r1'].targetAgentName).toBe('First');
		});
		it('no-ops finishing an unknown request', () => {
			const { finish } = useCrossAgentInFlightStore.getState();
			expect(() => finish('nope')).not.toThrow();
			expect(useCrossAgentInFlightStore.getState().requests).toEqual({});
		});
	});
	describe('selectInFlightForTab', () => {
		it('scopes to a single source tab, oldest first', () => {
			const requests: Record<string, InFlightCrossAgentRequest> = {
				a: req({ requestId: 'a', startedAt: 200 }),
				b: req({ requestId: 'b', startedAt: 100 }),
				c: req({ requestId: 'c', sourceTabId: 'other', startedAt: 50 }),
			};
			const scoped = selectInFlightForTab(requests, 'src', 'tab');
			expect(scoped.map((r) => r.requestId)).toEqual(['b', 'a']);
		});
		it('returns nothing when the source tab/session is missing', () => {
			const requests = { a: req() };
			expect(selectInFlightForTab(requests, null, 'tab')).toEqual([]);
			expect(selectInFlightForTab(requests, 'src', undefined)).toEqual([]);
		});
	});
	/**
	 * The Left Bar dot reads the TARGET side of the same store: a consulted agent
	 * is doing real work that `session.state` deliberately never records.
	 */
	describe('selectConsultedSessionIds', () => {
		it('collects every agent currently answering a consult', () => {
			const requests: Record<string, InFlightCrossAgentRequest> = {
				a: req({ requestId: 'a', targetSessionId: 'rc' }),
				b: req({ requestId: 'b', targetSessionId: 'maestro' }),
			};
			expect([...selectConsultedSessionIds(requests)].sort()).toEqual(['maestro', 'rc']);
		});
		// One agent fielding two consults must not double-count or flicker when the
		// first of them finishes.
		it('collapses several requests aimed at one agent', () => {
			const requests: Record<string, InFlightCrossAgentRequest> = {
				a: req({ requestId: 'a', targetSessionId: 'rc', sourceSessionId: 's1' }),
				b: req({ requestId: 'b', targetSessionId: 'rc', sourceSessionId: 's2' }),
			};
			expect([...selectConsultedSessionIds(requests)]).toEqual(['rc']);
		});
		it('is empty when nothing is in flight', () => {
			expect(selectConsultedSessionIds({}).size).toBe(0);
		});
	});
});
// Source: src/__tests__/renderer/stores/composerInputStore.test.ts
describe('', () => {
	describe('composerInputStore', () => {
		beforeEach(() => {
			useComposerInputStore.setState({
				aiValue: '',
				terminalValue: '',
				mentionRoutingOverride: null,
			});
		});
		it('initializes both slices empty', () => {
			const s = useComposerInputStore.getState();
			expect(s.aiValue).toBe('');
			expect(s.terminalValue).toBe('');
		});
		it('setAiValue sets a literal value without touching the terminal slice', () => {
			useComposerInputStore.getState().setAiValue('hello AI');
			expect(useComposerInputStore.getState().aiValue).toBe('hello AI');
			expect(useComposerInputStore.getState().terminalValue).toBe('');
		});
		it('setTerminalValue sets a literal value without touching the AI slice', () => {
			useComposerInputStore.getState().setTerminalValue('ls -la');
			expect(useComposerInputStore.getState().terminalValue).toBe('ls -la');
			expect(useComposerInputStore.getState().aiValue).toBe('');
		});
		it('setAiValue accepts a functional updater that sees the previous value', () => {
			useComposerInputStore.getState().setAiValue('hello');
			useComposerInputStore.getState().setAiValue((prev) => prev + ' world');
			expect(useComposerInputStore.getState().aiValue).toBe('hello world');
		});
		it('setTerminalValue accepts a functional updater', () => {
			useComposerInputStore.getState().setTerminalValue('git');
			useComposerInputStore.getState().setTerminalValue((prev) => `${prev} status`);
			expect(useComposerInputStore.getState().terminalValue).toBe('git status');
		});
		it('selectors read the matching slice', () => {
			useComposerInputStore.setState({ aiValue: 'a', terminalValue: 't' });
			const s = useComposerInputStore.getState();
			expect(selectAiComposerValue(s)).toBe('a');
			expect(selectTerminalComposerValue(s)).toBe('t');
		});
		it("drops a picked mention routing when another tab's draft loads", () => {
			// The pick qualified the mentions in THIS draft; the next tab's draft has
			// its own wording and must not inherit it.
			useComposerInputStore.getState().setMentionRoutingOverride('handoff');
			expect(selectMentionRoutingOverride(useComposerInputStore.getState())).toBe('handoff');
			useComposerInputStore.getState().loadAiDraft('tab-2', 'ask @Backend', 'off');
			expect(selectMentionRoutingOverride(useComposerInputStore.getState())).toBeNull();
		});
		it('notifies subscribers only when a slice actually changes', () => {
			let calls = 0;
			const unsub = useComposerInputStore.subscribe(() => {
				calls += 1;
			});
			useComposerInputStore.getState().setAiValue('x');
			expect(calls).toBe(1);
			unsub();
		});
	});
});
