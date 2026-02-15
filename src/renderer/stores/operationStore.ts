/**
 * operationStore - Zustand store for operation state management
 *
 * Consolidates state from three operation hooks:
 * - useSummarizeAndContinue: per-tab summarization state
 * - useMergeSession: per-tab merge state + global merge flag
 * - useSendToAgent: global transfer state + global transfer flag
 *
 * Hooks retain their async orchestration logic; this store owns the
 * state layer only. Module-level globals (globalMergeInProgress,
 * globalTransferInProgress) become proper store state, making them
 * testable and resettable.
 *
 * Can be used outside React via getOperationState() / getOperationActions().
 */

import { create } from 'zustand';
import type {
	SummarizeProgress,
	SummarizeResult,
	GroomingProgress,
	MergeResult,
} from '../types/contextMerge';
import type { TransferError } from '../components/TransferErrorModal';
import type { ToolType } from '../types';

// ============================================================================
// Types (re-exported from hooks for single import location)
// ============================================================================

export type SummarizeState = 'idle' | 'summarizing' | 'complete' | 'error';

export interface TabSummarizeState {
	state: SummarizeState;
	progress: SummarizeProgress | null;
	result: SummarizeResult | null;
	error: string | null;
	startTime: number;
}

export type MergeState = 'idle' | 'merging' | 'complete' | 'error';

export interface TabMergeState {
	state: MergeState;
	progress: GroomingProgress | null;
	result: MergeResult | null;
	error: string | null;
	startTime: number;
	sourceName?: string;
	targetName?: string;
}

export type TransferState = 'idle' | 'grooming' | 'creating' | 'complete' | 'error';

export interface TransferOperationState {
	state: TransferState;
	progress: GroomingProgress | null;
	error: string | null;
	transferError: TransferError | null;
	lastRequest: TransferLastRequest | null;
}

/** Minimal transfer request info stored for retry (no Session objects). */
export interface TransferLastRequest {
	sourceSessionId: string;
	sourceTabId: string;
	targetAgent: ToolType;
	skipGrooming: boolean;
}

// ============================================================================
// Store interface
// ============================================================================

export interface OperationStoreState {
	// --- Summarize (per-tab) ---
	summarizeStates: Map<string, TabSummarizeState>;

	// --- Merge (per-source-tab + global flag) ---
	mergeStates: Map<string, TabMergeState>;
	globalMergeInProgress: boolean;

	// --- Transfer (global, single operation) ---
	transferState: TransferState;
	transferProgress: GroomingProgress | null;
	transferError: string | null;
	transferStructuredError: TransferError | null;
	transferLastRequest: TransferLastRequest | null;
	globalTransferInProgress: boolean;
}

export interface OperationStoreActions {
	// --- Summarize ---
	setSummarizeTabState: (tabId: string, state: TabSummarizeState) => void;
	updateSummarizeTabState: (tabId: string, partial: Partial<TabSummarizeState>) => void;
	clearSummarizeTabState: (tabId: string) => void;
	clearAllSummarizeStates: () => void;

	// --- Merge ---
	setMergeTabState: (tabId: string, state: TabMergeState) => void;
	updateMergeTabState: (tabId: string, partial: Partial<TabMergeState>) => void;
	clearMergeTabState: (tabId: string) => void;
	clearAllMergeStates: () => void;
	setGlobalMergeInProgress: (v: boolean) => void;

	// --- Transfer ---
	setTransferState: (partial: Partial<TransferOperationState>) => void;
	resetTransferState: () => void;
	setGlobalTransferInProgress: (v: boolean) => void;

	// --- Cross-cutting ---
	/** Reset all operation state. Useful in tests and full cleanup. */
	resetAll: () => void;
}

export type OperationStore = OperationStoreState & OperationStoreActions;

// ============================================================================
// Selectors (pure functions, can be used with useOperationStore(selector))
// ============================================================================

/** True if any tab is currently summarizing. */
export function selectIsAnySummarizing(s: OperationStoreState): boolean {
	for (const ts of s.summarizeStates.values()) {
		if (ts.state === 'summarizing') return true;
	}
	return false;
}

/** True if any tab is currently merging. */
export function selectIsAnyMerging(s: OperationStoreState): boolean {
	for (const ts of s.mergeStates.values()) {
		if (ts.state === 'merging') return true;
	}
	return false;
}

/** True if any operation (summarize, merge, or transfer) is in progress. */
export function selectIsAnyOperationInProgress(s: OperationStoreState): boolean {
	return (
		selectIsAnySummarizing(s) ||
		selectIsAnyMerging(s) ||
		s.transferState === 'grooming' ||
		s.transferState === 'creating'
	);
}

// ============================================================================
// Initial state
// ============================================================================

const INITIAL_TRANSFER_STATE: Pick<
	OperationStoreState,
	| 'transferState'
	| 'transferProgress'
	| 'transferError'
	| 'transferStructuredError'
	| 'transferLastRequest'
> = {
	transferState: 'idle',
	transferProgress: null,
	transferError: null,
	transferStructuredError: null,
	transferLastRequest: null,
};

// ============================================================================
// Store
// ============================================================================

export const useOperationStore = create<OperationStore>()((set) => ({
	// --- State ---
	summarizeStates: new Map(),
	mergeStates: new Map(),
	globalMergeInProgress: false,
	transferState: 'idle',
	transferProgress: null,
	transferError: null,
	transferStructuredError: null,
	transferLastRequest: null,
	globalTransferInProgress: false,

	// --- Summarize actions ---
	setSummarizeTabState: (tabId, state) =>
		set((s) => {
			const next = new Map(s.summarizeStates);
			next.set(tabId, state);
			return { summarizeStates: next };
		}),

	updateSummarizeTabState: (tabId, partial) =>
		set((s) => {
			const existing = s.summarizeStates.get(tabId);
			if (!existing) return s;
			const next = new Map(s.summarizeStates);
			next.set(tabId, { ...existing, ...partial });
			return { summarizeStates: next };
		}),

	clearSummarizeTabState: (tabId) =>
		set((s) => {
			if (!s.summarizeStates.has(tabId)) return s;
			const next = new Map(s.summarizeStates);
			next.delete(tabId);
			return { summarizeStates: next };
		}),

	clearAllSummarizeStates: () => set({ summarizeStates: new Map() }),

	// --- Merge actions ---
	setMergeTabState: (tabId, state) =>
		set((s) => {
			const next = new Map(s.mergeStates);
			next.set(tabId, state);
			return { mergeStates: next };
		}),

	updateMergeTabState: (tabId, partial) =>
		set((s) => {
			const existing = s.mergeStates.get(tabId);
			if (!existing) return s;
			const next = new Map(s.mergeStates);
			next.set(tabId, { ...existing, ...partial });
			return { mergeStates: next };
		}),

	clearMergeTabState: (tabId) =>
		set((s) => {
			if (!s.mergeStates.has(tabId)) return s;
			const next = new Map(s.mergeStates);
			next.delete(tabId);
			return { mergeStates: next };
		}),

	clearAllMergeStates: () => set({ mergeStates: new Map() }),

	setGlobalMergeInProgress: (v) => set({ globalMergeInProgress: v }),

	// --- Transfer actions ---
	setTransferState: (partial) =>
		set({
			...(partial.state !== undefined && { transferState: partial.state }),
			...(partial.progress !== undefined && { transferProgress: partial.progress }),
			...(partial.error !== undefined && { transferError: partial.error }),
			...(partial.transferError !== undefined && {
				transferStructuredError: partial.transferError,
			}),
			...(partial.lastRequest !== undefined && { transferLastRequest: partial.lastRequest }),
		}),

	resetTransferState: () => set(INITIAL_TRANSFER_STATE),

	setGlobalTransferInProgress: (v) => set({ globalTransferInProgress: v }),

	// --- Cross-cutting ---
	resetAll: () =>
		set({
			summarizeStates: new Map(),
			mergeStates: new Map(),
			globalMergeInProgress: false,
			...INITIAL_TRANSFER_STATE,
			globalTransferInProgress: false,
		}),
}));

// ============================================================================
// Non-React access
// ============================================================================

/**
 * Get current operation state snapshot.
 * Use outside React (services, orchestrators, IPC handlers).
 */
export function getOperationState() {
	return useOperationStore.getState();
}

/**
 * Get stable operation action references outside React.
 */
export function getOperationActions() {
	const state = useOperationStore.getState();
	return {
		setSummarizeTabState: state.setSummarizeTabState,
		updateSummarizeTabState: state.updateSummarizeTabState,
		clearSummarizeTabState: state.clearSummarizeTabState,
		clearAllSummarizeStates: state.clearAllSummarizeStates,
		setMergeTabState: state.setMergeTabState,
		updateMergeTabState: state.updateMergeTabState,
		clearMergeTabState: state.clearMergeTabState,
		clearAllMergeStates: state.clearAllMergeStates,
		setGlobalMergeInProgress: state.setGlobalMergeInProgress,
		setTransferState: state.setTransferState,
		resetTransferState: state.resetTransferState,
		setGlobalTransferInProgress: state.setGlobalTransferInProgress,
		resetAll: state.resetAll,
	};
}
