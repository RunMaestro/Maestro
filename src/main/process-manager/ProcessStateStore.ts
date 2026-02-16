import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'ProcessStateStore';
const SNAPSHOT_FILENAME = 'process-state.json';

export interface ProcessSnapshot {
	sessionId: string;
	pid: number;
	toolType: string;
	cwd: string;
	isTerminal: boolean;
	startTime: number;
	command?: string;
	args?: string[];
	isBatchMode?: boolean;
	/** The tab within the session that owns this process */
	tabId?: string;
	/** Process type for VIBES attribution (group chat, wizard, etc.). Currently derived renderer-side from sessionId patterns; reserved for future main-process population. */
	processType?: string;
}

export interface ProcessStateSnapshot {
	timestamp: number;
	processes: ProcessSnapshot[];
}

/**
 * Persist active process state to disk for recovery after reload/restart.
 * The snapshot is a lightweight JSON file in the app's userData directory.
 *
 * Uses a getter callback so the snapshot always reflects live state at
 * write time, not stale data captured when the debounce was triggered.
 */
export class ProcessStateStore {
	private snapshotPath: string;
	private writeTimer: ReturnType<typeof setTimeout> | null = null;
	private snapshotGetter: (() => ProcessSnapshot[]) | null = null;

	constructor() {
		this.snapshotPath = path.join(app.getPath('userData'), SNAPSHOT_FILENAME);
	}

	/**
	 * Schedule a snapshot write to disk.
	 * Debounced — call frequently, writes at most every 2 seconds.
	 * The getter is called at write time so the snapshot reflects current state.
	 */
	saveSnapshot(getProcesses: () => ProcessSnapshot[]): void {
		this.snapshotGetter = getProcesses;
		if (this.writeTimer) return; // Already scheduled

		this.writeTimer = setTimeout(() => {
			this.writeTimer = null;
			this.writeSnapshotToDisk();
		}, 2000);
	}

	/**
	 * Load the most recent process snapshot from disk.
	 * Returns null if no snapshot exists or it's too old (>5 minutes).
	 */
	async loadSnapshot(): Promise<ProcessStateSnapshot | null> {
		try {
			const content = await fs.readFile(this.snapshotPath, 'utf-8');
			const snapshot: ProcessStateSnapshot = JSON.parse(content);

			// Reject snapshots older than 5 minutes — processes are likely dead
			const age = Date.now() - snapshot.timestamp;
			if (age > 5 * 60 * 1000) {
				logger.info('Process snapshot too old, ignoring', LOG_CONTEXT, { ageMs: age });
				return null;
			}

			return snapshot;
		} catch {
			return null;
		}
	}

	/**
	 * Clear the snapshot file (called on clean shutdown).
	 */
	async clear(): Promise<void> {
		if (this.writeTimer) {
			clearTimeout(this.writeTimer);
			this.writeTimer = null;
		}
		try {
			await fs.unlink(this.snapshotPath);
		} catch {
			// File may not exist
		}
	}

	/**
	 * Flush any pending write immediately to disk.
	 */
	async flush(): Promise<void> {
		if (this.writeTimer) {
			clearTimeout(this.writeTimer);
			this.writeTimer = null;
		}
		await this.writeSnapshotToDisk();
	}

	private async writeSnapshotToDisk(): Promise<void> {
		if (!this.snapshotGetter) return;
		try {
			const snapshot: ProcessStateSnapshot = {
				timestamp: Date.now(),
				processes: this.snapshotGetter(),
			};
			await fs.writeFile(
				this.snapshotPath,
				JSON.stringify(snapshot, null, '\t'),
				'utf-8',
			);
		} catch (err) {
			logger.warn('Failed to save process state snapshot', LOG_CONTEXT, { error: String(err) });
		}
	}
}
