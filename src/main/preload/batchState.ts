/**
 * Preload API for batch state persistence
 *
 * Provides the window.maestro.batchState namespace for:
 * - Saving batch run state snapshots to main process
 * - Loading persisted batch state after renderer reload
 * - Clearing persisted state on clean completion
 * - Flushing pending writes on shutdown
 */

import { ipcRenderer } from 'electron';

/**
 * Shape of a persisted batch run state entry.
 * Mirrors PersistedBatchRunState from the main process handler.
 */
export interface PersistedBatchRunState {
	sessionId: string;
	isRunning: boolean;
	processingState: string;
	documents: string[];
	lockedDocuments: string[];
	currentDocumentIndex: number;
	currentDocTasksTotal: number;
	currentDocTasksCompleted: number;
	totalTasksAcrossAllDocs: number;
	completedTasksAcrossAllDocs: number;
	loopEnabled: boolean;
	loopIteration: number;
	maxLoops?: number | null;
	folderPath: string;
	worktreeActive: boolean;
	worktreePath?: string;
	worktreeBranch?: string;
	customPrompt?: string;
	startTime?: number;
	cumulativeTaskTimeMs?: number;
	accumulatedElapsedMs?: number;
	lastActiveTimestamp?: number;
	agentSessionId?: string;
	agentType?: string;
}

/**
 * Shape of the persisted batch snapshot
 */
export interface PersistedBatchSnapshot {
	timestamp: number;
	activeBatches: PersistedBatchRunState[];
}

/**
 * Batch State API type
 */
export interface BatchStateApi {
	save: (activeBatches: PersistedBatchRunState[]) => Promise<void>;
	load: () => Promise<PersistedBatchSnapshot | null>;
	clear: () => Promise<void>;
	flush: () => Promise<void>;
}

/**
 * Creates the Batch State API object for preload exposure
 */
export function createBatchStateApi(): BatchStateApi {
	return {
		save: (activeBatches: PersistedBatchRunState[]): Promise<void> =>
			ipcRenderer.invoke('batch-state:save', activeBatches),

		load: (): Promise<PersistedBatchSnapshot | null> =>
			ipcRenderer.invoke('batch-state:load'),

		clear: (): Promise<void> =>
			ipcRenderer.invoke('batch-state:clear'),

		flush: (): Promise<void> =>
			ipcRenderer.invoke('batch-state:flush'),
	};
}
