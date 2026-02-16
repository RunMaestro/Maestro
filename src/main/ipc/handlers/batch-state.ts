/**
 * Batch State Persistence IPC Handlers
 *
 * Persists Auto Run batch state to disk so batch runs survive renderer reloads.
 * The main process acts as a dumb persistence layer — the renderer drives recovery.
 *
 * Handlers:
 * - batch-state:save   — Save snapshot of active batch runs (debounced to 3s)
 * - batch-state:load   — Load the most recent snapshot (rejected if >10 min old)
 * - batch-state:clear  — Delete the snapshot file (on clean completion or kill)
 * - batch-state:flush  — Force-write any pending snapshot immediately
 */

import { ipcMain, app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../utils/logger';

// ==========================================================================
// Constants
// ==========================================================================

const LOG_CONTEXT = 'BatchStatePersistence';
const BATCH_STATE_FILENAME = 'batch-run-state.json';

/**
 * Debounce interval for batch state writes (milliseconds).
 * Prevents excessive disk I/O during rapid progress updates.
 */
const WRITE_DEBOUNCE_MS = 3000;

/**
 * Maximum age (milliseconds) before a snapshot is considered stale.
 * Batch runs can take hours, so 10 minutes is a reasonable window
 * for reload recovery while still rejecting truly stale state.
 */
const MAX_SNAPSHOT_AGE_MS = 10 * 60 * 1000;

// ==========================================================================
// Types
// ==========================================================================

/**
 * Shape of the persisted batch run state.
 * This is a subset of BatchRunState — only the fields needed for recovery.
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
	/** Agent session ID for resume (Claude session_id, Codex thread_id) */
	agentSessionId?: string;
	/** Agent type (claude-code, codex, etc.) — needed to build correct resume args */
	agentType?: string;
}

export interface PersistedBatchSnapshot {
	timestamp: number;
	activeBatches: PersistedBatchRunState[];
}

// ==========================================================================
// Module State
// ==========================================================================

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSnapshot: PersistedBatchSnapshot | null = null;

// ==========================================================================
// Helpers
// ==========================================================================

function getSnapshotPath(): string {
	return path.join(app.getPath('userData'), BATCH_STATE_FILENAME);
}

async function writeSnapshotToDisk(snapshot: PersistedBatchSnapshot): Promise<void> {
	await fs.writeFile(
		getSnapshotPath(),
		JSON.stringify(snapshot, null, '\t'),
		'utf-8'
	);
}

// ==========================================================================
// Handler Registration
// ==========================================================================

/**
 * Register all batch state persistence IPC handlers
 */
export function registerBatchStateHandlers(): void {
	/**
	 * Save batch run state snapshot. Called by renderer on every progress update.
	 * Debounced internally to avoid excessive disk writes.
	 */
	ipcMain.handle('batch-state:save', async (_event, activeBatches: PersistedBatchRunState[]) => {
		pendingSnapshot = {
			timestamp: Date.now(),
			activeBatches,
		};

		if (!writeTimer) {
			writeTimer = setTimeout(async () => {
				writeTimer = null;
				if (pendingSnapshot) {
					try {
						await writeSnapshotToDisk(pendingSnapshot);
					} catch (err) {
						logger.warn('Failed to save batch state snapshot', LOG_CONTEXT, { error: String(err) });
					}
					pendingSnapshot = null;
				}
			}, WRITE_DEBOUNCE_MS);
		}
	});

	/**
	 * Load the most recent batch state snapshot.
	 * Returns null if no snapshot exists or it's stale (>10 minutes).
	 */
	ipcMain.handle('batch-state:load', async (): Promise<PersistedBatchSnapshot | null> => {
		try {
			const content = await fs.readFile(getSnapshotPath(), 'utf-8');
			const snapshot: PersistedBatchSnapshot = JSON.parse(content);

			const age = Date.now() - snapshot.timestamp;
			if (age > MAX_SNAPSHOT_AGE_MS) {
				logger.info('Batch state snapshot too old, ignoring', LOG_CONTEXT, { ageMs: age });
				return null;
			}

			logger.info('Loaded batch state snapshot', LOG_CONTEXT, {
				batchCount: snapshot.activeBatches.length,
				ageMs: age,
			});
			return snapshot;
		} catch {
			return null;
		}
	});

	/**
	 * Clear the batch state snapshot (called on clean batch completion or kill).
	 */
	ipcMain.handle('batch-state:clear', async () => {
		try {
			await fs.unlink(getSnapshotPath());
			logger.debug('Cleared batch state snapshot', LOG_CONTEXT);
		} catch {
			// File may not exist — that's fine
		}
	});

	/**
	 * Flush any pending write immediately (called before clean shutdown).
	 */
	ipcMain.handle('batch-state:flush', async () => {
		if (writeTimer) {
			clearTimeout(writeTimer);
			writeTimer = null;
		}
		if (pendingSnapshot) {
			try {
				await writeSnapshotToDisk(pendingSnapshot);
				logger.debug('Flushed pending batch state snapshot', LOG_CONTEXT);
			} catch (err) {
				logger.warn('Failed to flush batch state snapshot', LOG_CONTEXT, { error: String(err) });
			}
			pendingSnapshot = null;
		}
	});
}
