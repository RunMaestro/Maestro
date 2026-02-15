/**
 * batchStore - Zustand store for batch/Auto Run state management
 *
 * Consolidates state from two sources:
 * - AutoRunContext: document list, tree, loading state, task counts
 * - useBatchProcessor: batch run states (via reducer), custom prompts
 *
 * The batch reducer logic is reused directly — dispatchBatch applies the
 * existing batchReducer function to the current state. Hooks retain their
 * async orchestration; this store owns the state layer only.
 *
 * Can be used outside React via getBatchState() / getBatchActions().
 */

import { create } from 'zustand';
import type { BatchRunState } from '../types';
import type { AutoRunTreeNode } from '../hooks/batch/useAutoRunHandlers';
import { batchReducer, type BatchAction } from '../hooks/batch/batchReducer';

// ============================================================================
// Types
// ============================================================================

/**
 * Task count entry — tracks completed vs total tasks for a document.
 * Moved from AutoRunContext.
 */
export interface TaskCountEntry {
	completed: number;
	total: number;
}

/** Batch run states keyed by session ID */
export type BatchState = Record<string, BatchRunState>;

// ============================================================================
// Store interface
// ============================================================================

export interface BatchStoreState {
	// --- AutoRun document state ---
	documentList: string[];
	documentTree: AutoRunTreeNode[];
	isLoadingDocuments: boolean;
	documentTaskCounts: Map<string, TaskCountEntry>;

	// --- Batch run state ---
	batchRunStates: BatchState;
	customPrompts: Record<string, string>;
}

export interface BatchStoreActions {
	// --- AutoRun document actions ---
	setDocumentList: (v: string[] | ((prev: string[]) => string[])) => void;
	setDocumentTree: (
		v: AutoRunTreeNode[] | ((prev: AutoRunTreeNode[]) => AutoRunTreeNode[])
	) => void;
	setIsLoadingDocuments: (v: boolean | ((prev: boolean) => boolean)) => void;
	setDocumentTaskCounts: (
		v:
			| Map<string, TaskCountEntry>
			| ((prev: Map<string, TaskCountEntry>) => Map<string, TaskCountEntry>)
	) => void;
	/** Update task count for a single document */
	updateTaskCount: (filename: string, completed: number, total: number) => void;
	/** Reset documentList, documentTree, and documentTaskCounts */
	clearDocumentList: () => void;

	// --- Batch run actions ---
	/** Apply a batch action via the existing batchReducer */
	dispatchBatch: (action: BatchAction) => void;
	/** Direct setter for bulk updates (e.g., from debounced flush) */
	setBatchRunStates: (v: BatchState | ((prev: BatchState) => BatchState)) => void;
	/** Set custom prompt for a session */
	setCustomPrompt: (sessionId: string, prompt: string) => void;
	/** Clear all custom prompts */
	clearCustomPrompts: () => void;
}

export type BatchStore = BatchStoreState & BatchStoreActions;

// ============================================================================
// Helpers
// ============================================================================

function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T {
	return typeof valOrFn === 'function' ? (valOrFn as (prev: T) => T)(prev) : valOrFn;
}

// ============================================================================
// Selectors
// ============================================================================

/** True if any session has an active (running) batch */
export function selectHasAnyActiveBatch(s: BatchStoreState): boolean {
	return Object.values(s.batchRunStates).some((state) => state.isRunning);
}

/** List of session IDs with active batches */
export function selectActiveBatchSessionIds(s: BatchStoreState): string[] {
	return Object.entries(s.batchRunStates)
		.filter(([, state]) => state.isRunning)
		.map(([sessionId]) => sessionId);
}

/** List of session IDs that are in stopping state */
export function selectStoppingBatchSessionIds(s: BatchStoreState): string[] {
	return Object.entries(s.batchRunStates)
		.filter(([, state]) => state.isRunning && state.isStopping)
		.map(([sessionId]) => sessionId);
}

/** Get batch run state for a specific session */
export function selectBatchRunState(
	s: BatchStoreState,
	sessionId: string
): BatchRunState | undefined {
	return s.batchRunStates[sessionId];
}

// ============================================================================
// Store
// ============================================================================

export const useBatchStore = create<BatchStore>()((set) => ({
	// --- State ---
	documentList: [],
	documentTree: [],
	isLoadingDocuments: false,
	documentTaskCounts: new Map(),
	batchRunStates: {},
	customPrompts: {},

	// --- AutoRun document actions ---
	setDocumentList: (v) => set((s) => ({ documentList: resolve(v, s.documentList) })),
	setDocumentTree: (v) => set((s) => ({ documentTree: resolve(v, s.documentTree) })),
	setIsLoadingDocuments: (v) =>
		set((s) => ({ isLoadingDocuments: resolve(v, s.isLoadingDocuments) })),
	setDocumentTaskCounts: (v) =>
		set((s) => ({ documentTaskCounts: resolve(v, s.documentTaskCounts) })),

	updateTaskCount: (filename, completed, total) =>
		set((s) => {
			const next = new Map(s.documentTaskCounts);
			next.set(filename, { completed, total });
			return { documentTaskCounts: next };
		}),

	clearDocumentList: () =>
		set({
			documentList: [],
			documentTree: [],
			documentTaskCounts: new Map(),
		}),

	// --- Batch run actions ---
	dispatchBatch: (action) =>
		set((s) => ({
			batchRunStates: batchReducer(s.batchRunStates, action),
		})),

	setBatchRunStates: (v) => set((s) => ({ batchRunStates: resolve(v, s.batchRunStates) })),

	setCustomPrompt: (sessionId, prompt) =>
		set((s) => ({
			customPrompts: { ...s.customPrompts, [sessionId]: prompt },
		})),

	clearCustomPrompts: () => set({ customPrompts: {} }),
}));

// ============================================================================
// Non-React access
// ============================================================================

/**
 * Get current batch state snapshot.
 * Use outside React (services, orchestrators, IPC handlers).
 */
export function getBatchState() {
	return useBatchStore.getState();
}

/**
 * Get stable batch action references outside React.
 */
export function getBatchActions() {
	const state = useBatchStore.getState();
	return {
		setDocumentList: state.setDocumentList,
		setDocumentTree: state.setDocumentTree,
		setIsLoadingDocuments: state.setIsLoadingDocuments,
		setDocumentTaskCounts: state.setDocumentTaskCounts,
		updateTaskCount: state.updateTaskCount,
		clearDocumentList: state.clearDocumentList,
		dispatchBatch: state.dispatchBatch,
		setBatchRunStates: state.setBatchRunStates,
		setCustomPrompt: state.setCustomPrompt,
		clearCustomPrompts: state.clearCustomPrompts,
	};
}
