/**
 * The Auto Run state that crosses a process boundary.
 *
 * Auto Run is renderer-owned state: the run loop, its cursors, and its
 * `BatchRunState` live in one client's memory and nowhere else. This is the
 * flattened projection of that state which travels
 * renderer -> `web:broadcastAutoRunState` -> main -> every WebSocket client,
 * and it is the only way any other client (the mobile web app, a web-desktop
 * browser tab) learns that a run exists at all.
 *
 * It lives in `shared` because the same shape is spelled out at three
 * boundaries - the renderer's `window.maestro.web.broadcastAutoRunState`
 * signature, the main-process IPC handler that receives it, and the web
 * server's broadcast types. They were three hand-written copies and had
 * already drifted; a field added to one and not the others is silently
 * dropped somewhere in the middle, which reads as the receiving client
 * rendering stale or partial state.
 *
 * Every field past the first four is optional, so a client built against an
 * older copy of this type degrades to less detail rather than failing.
 */
export interface AutoRunBroadcastState {
	isRunning: boolean;
	totalTasks: number;
	completedTasks: number;
	currentTaskIndex: number;
	isStopping?: boolean;

	// --- Multi-document progress ---
	/** Total number of documents in the run */
	totalDocuments?: number;
	/** Current document being processed (0-based) */
	currentDocumentIndex?: number;
	/** Total tasks across all documents */
	totalTasksAcrossAllDocs?: number;
	/** Completed tasks across all documents */
	completedTasksAcrossAllDocs?: number;

	// --- Error pause, so a receiving client can show recovery UI ---
	/** True if the run is paused waiting for error resolution */
	errorPaused?: boolean;
	/** Human-readable description of the error that paused the run */
	errorMessage?: string;
	/** Error type tag (e.g. 'rate_limit', 'auth', 'context_window') */
	errorType?: string;
	/** Whether the error is recoverable (resume vs. abort) */
	errorRecoverable?: boolean;
	/** Document index that hit the error (for skip-document UI) */
	errorDocumentIndex?: number;
	/** Description of the task that failed (for UI display) */
	errorTaskDescription?: string;

	// --- Goal-Driven mode: receivers render percent + iteration in place of counts ---
	/** True when this run pursues a free-text goal instead of documents */
	goalMode?: boolean;
	/** Latest self-reported progress toward the goal (0-100) */
	goalProgress?: number;
	/** One-line rationale accompanying the latest goal progress report */
	goalRationale?: string;
	/** 1-based iteration number the goal loop is on */
	goalIteration?: number;

	// --- Fields a full mirror of the desktop Auto Run card needs ---
	// The mobile web app draws a progress bar and needs none of these. A
	// web-desktop client renders the same components the owning client does, so
	// without them it draws a visibly poorer version of the same run.
	/** Ordered document filenames in the run */
	documents?: string[];
	/** Documents held read-only for the duration of the run */
	lockedDocuments?: string[];
	/** Total tasks in the document currently being processed */
	currentDocTasksTotal?: number;
	/** Completed tasks in the document currently being processed */
	currentDocTasksCompleted?: number;
	/** True when the run is executing inside a git worktree */
	worktreeActive?: boolean;
	/** Branch name of the active worktree, when there is one */
	worktreeBranch?: string;
	/** Epoch ms the run started, for the elapsed-time readout */
	startTime?: number;
	/** True when the run loops over its documents repeatedly */
	loopEnabled?: boolean;
	/** How many times the run has looped (0 = first pass) */
	loopIteration?: number;
}

/**
 * Who started an Auto Run, and what it takes to start it again.
 *
 * The run loop is a live async closure in the client that pressed Go, so a
 * page reload kills it while the task it spawned keeps running in main
 * (#1470). Main survives the reload, so main is where the run's identity has to
 * live for the reloaded page to pick it back up. Recorded with the start claim
 * (`window.maestro.web.claimAutoRunStart`).
 */
export interface AutoRunOwner<Config = unknown> {
	/**
	 * Reload-stable id of the client that started the run
	 * (`getClientInstanceId()` in the renderer). It lives in sessionStorage,
	 * which survives a reload and dies with the tab, so the same id after a
	 * reload is the same tab, and that tab's old loop is provably gone.
	 */
	instanceId: string;
	/** The run's `BatchRunConfig`. Opaque to main; handed back verbatim. */
	config: Config;
	/** The Auto Run folder the run reads its documents from. */
	folderPath: string;
}

/** An orphaned run handed back to the client that started it. */
export interface OrphanedAutoRun<State = Partial<AutoRunBroadcastState>, Config = unknown> {
	agentId: string;
	config: Config;
	folderPath: string;
	/** The last state the dead loop published, if it published any. */
	state?: State;
}
