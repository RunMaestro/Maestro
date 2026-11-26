import type { AutoRunPendingDelegation } from './autoRunDelegation';

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

	// --- Delegation (both modes) ---
	/** Work the run handed to other agents and is waiting on before its next turn */
	pendingDelegations?: AutoRunPendingDelegation[];

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
	/** Checked tasks the documents held when the run started, for the ETA's pace */
	initialCompletedTasks?: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const wireNumber = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const wireString = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : undefined;

const wireBoolean = (value: unknown): boolean | undefined =>
	typeof value === 'boolean' ? value : undefined;

const wireStrings = (value: unknown): string[] | undefined =>
	Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string')
		: undefined;

function wireDelegations(value: unknown): AutoRunPendingDelegation[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: AutoRunPendingDelegation[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const callbackId = wireString(entry.callbackId);
		const targetAgentId = wireString(entry.targetAgentId);
		const targetTabId = wireString(entry.targetTabId);
		const startedAt = wireNumber(entry.startedAt);
		if (!callbackId || !targetAgentId || !targetTabId || startedAt === undefined) continue;
		out.push({
			callbackId,
			targetAgentId,
			targetTabId,
			targetName: wireString(entry.targetName) ?? targetAgentId,
			subject: typeof entry.subject === 'string' ? entry.subject : '',
			startedAt,
		});
	}
	return out;
}

/**
 * Read an `autorun_state` frame that came from another machine (a Federation host), field by
 * field, into the shape a full mirror of the Auto Run card draws (`buildMirroredBatchState()`).
 * A field of the wrong type is dropped, so a frame from a host built before a field existed, or
 * a damaged one, draws less detail instead of crashing the card. `null` means no run: the host
 * sends `null` when it clears the state, and a payload that is not an object says nothing.
 */
export function parseAutoRunBroadcastState(raw: unknown): AutoRunBroadcastState | null {
	if (!isRecord(raw)) return null;
	const optional: Partial<AutoRunBroadcastState> = {
		isStopping: wireBoolean(raw.isStopping),
		totalDocuments: wireNumber(raw.totalDocuments),
		currentDocumentIndex: wireNumber(raw.currentDocumentIndex),
		totalTasksAcrossAllDocs: wireNumber(raw.totalTasksAcrossAllDocs),
		completedTasksAcrossAllDocs: wireNumber(raw.completedTasksAcrossAllDocs),
		errorPaused: wireBoolean(raw.errorPaused),
		errorMessage: wireString(raw.errorMessage),
		errorType: wireString(raw.errorType),
		errorRecoverable: wireBoolean(raw.errorRecoverable),
		errorDocumentIndex: wireNumber(raw.errorDocumentIndex),
		errorTaskDescription: wireString(raw.errorTaskDescription),
		goalMode: wireBoolean(raw.goalMode),
		goalProgress: wireNumber(raw.goalProgress),
		goalRationale: wireString(raw.goalRationale),
		goalIteration: wireNumber(raw.goalIteration),
		pendingDelegations: wireDelegations(raw.pendingDelegations),
		documents: wireStrings(raw.documents),
		lockedDocuments: wireStrings(raw.lockedDocuments),
		currentDocTasksTotal: wireNumber(raw.currentDocTasksTotal),
		currentDocTasksCompleted: wireNumber(raw.currentDocTasksCompleted),
		worktreeActive: wireBoolean(raw.worktreeActive),
		worktreeBranch: wireString(raw.worktreeBranch),
		startTime: wireNumber(raw.startTime),
		loopEnabled: wireBoolean(raw.loopEnabled),
		loopIteration: wireNumber(raw.loopIteration),
		initialCompletedTasks: wireNumber(raw.initialCompletedTasks),
	};
	const state: AutoRunBroadcastState = {
		isRunning: raw.isRunning === true,
		totalTasks: wireNumber(raw.totalTasks) ?? 0,
		completedTasks: wireNumber(raw.completedTasks) ?? 0,
		currentTaskIndex: wireNumber(raw.currentTaskIndex) ?? 0,
	};
	for (const [key, value] of Object.entries(optional)) {
		if (value !== undefined) (state as unknown as Record<string, unknown>)[key] = value;
	}
	return state;
}
