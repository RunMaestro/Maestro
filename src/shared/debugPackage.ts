/**
 * Shared types for the debug/support package.
 *
 * These cross the IPC boundary (renderer -> preload -> main), so they live here
 * rather than being redeclared per process. `DebugPackageOptions` used to be
 * copy-pasted into three files and drifted the moment a field was added.
 *
 * Privacy: nothing in here carries document content, prompts, task text, or
 * filesystem paths. Auto Run's live state is counters and flags only.
 */

/**
 * One agent's Auto Run (batch) state at the moment a debug package is captured.
 *
 * The authoritative state lives in the renderer's in-memory `batchStore` and is
 * deliberately never persisted (see `useAutoResumeCoordinator` - the
 * orchestration loop does not survive a restart by design). Main therefore has
 * no way to read it on its own, so the renderer hands over this snapshot when
 * it asks for a package.
 */
export interface AutoRunDebugSnapshot {
	sessionId: string;
	isRunning: boolean;
	isStopping: boolean;
	/** Batch state-machine phase, e.g. 'idle' | 'processing' | 'paused'. */
	processingState?: string;

	// Document-level progress
	documentCount: number;
	currentDocumentIndex: number;

	// Task-level progress
	currentDocTasksTotal: number;
	currentDocTasksCompleted: number;
	totalTasksAcrossAllDocs: number;
	completedTasksAcrossAllDocs: number;

	// Loop mode
	loopEnabled: boolean;
	loopIteration: number;
	maxLoops?: number | null;

	worktreeActive: boolean;

	// Error state. The message and the failing task's description are omitted on
	// purpose - they can quote document content.
	hasError: boolean;
	errorType?: string;
	errorPaused: boolean;
	errorDocumentIndex?: number;

	// Timing. `startTime` plus a long-idle `lastActiveTimestamp` is the signature
	// of a hung run, which is the main thing this section exists to show.
	startTime?: number;
	cumulativeTaskTimeMs?: number;
	accumulatedElapsedMs?: number;
	lastActiveTimestamp?: number;
}

/**
 * Which optional sections to include in a generated package.
 */
export interface DebugPackageOptions {
	includeLogs?: boolean; // Default: true
	includeErrors?: boolean; // Default: true
	includeSessions?: boolean; // Default: true
	includeGroupChats?: boolean; // Default: true
	includeBatchState?: boolean; // Default: true
	/**
	 * Auto Run state captured by the renderer at request time. When omitted, a
	 * package main builds asks the app windows for it; if none can answer, the
	 * section records why rather than silently claiming no runs were active.
	 */
	autoRunSnapshots?: AutoRunDebugSnapshot[];
}

/**
 * Main asks every app window for its Auto Run snapshots on this channel when
 * it builds a package with no renderer in the loop (`maestro-cli
 * support-package`, Feedback's support package). The request carries a
 * per-call response channel; see `requestAutoRunSnapshots()` in
 * `src/main/debug-package/autorun-snapshots.ts`.
 */
export const AUTO_RUN_SNAPSHOT_REQUEST_CHANNEL = 'debug:autoRunSnapshotRequest';

/**
 * A window's answer to `AUTO_RUN_SNAPSHOT_REQUEST_CHANNEL`. A capture that
 * throws answers `ok: false` at once, so main records the reason instead of
 * waiting out its timeout.
 */
export type AutoRunSnapshotReply =
	| { ok: true; snapshots: AutoRunDebugSnapshot[] }
	| { ok: false; error: string };
