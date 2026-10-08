/**
 * Types for `maestro-cli dispatch --notify-on-complete` (dispatch with callback).
 *
 * A dispatch callback is an ephemeral, in-memory promise that "when THIS
 * dispatch finishes, wake the caller with a real turn in its live tab". It is
 * deliberately NOT a Cue subscription: Cue subscriptions are persistent YAML and
 * Cue dispatch spawns a fresh headless process, which would answer without the
 * orchestrator's accumulated context.
 */

/** Terminal status reported to the caller in {{DISPATCH_STATUS}}. */
export type DispatchCallbackStatus = 'completed' | 'failed' | 'timeout' | 'cancelled';

/**
 * Lifecycle of a callback entry.
 *
 * - `pending` - registered, but the dispatched process has not started yet.
 *   Exits observed in this state belong to a turn that was already running (or
 *   to a queued dispatch's predecessor) and must NOT fire the callback.
 * - `armed` - the dispatched process started; the next exit is ours.
 * - `grace` - the process exited with no Auto Run active. We wait a short grace
 *   window before firing, because the dispatched turn may have just kicked off
 *   an Auto Run whose state broadcast has not landed yet.
 * - `awaiting-autorun` - the process exited while an Auto Run is running in the
 *   target agent. We stay parked until the Auto Run's running -> not-running
 *   edge so an N-task run wakes the caller once, not N times.
 * - `fired` / `cancelled` - terminal.
 */
export type DispatchCallbackState =
	| 'pending'
	| 'armed'
	| 'grace'
	| 'awaiting-autorun'
	| 'fired'
	| 'cancelled';

/** What the dispatch site knows when it arms a callback. */
export interface DispatchCallbackRegistration {
	/** Agent the prompt was dispatched to. */
	targetAgentId: string;
	/** Tab within the target agent the prompt landed in. */
	targetTabId: string;
	/** Display name of the target agent (for the callback prompt). */
	targetName?: string;
	/** Agent to wake when the dispatch finishes. */
	callerAgentId: string;
	/** Specific caller tab to wake. Defaults to the caller's active AI tab. */
	callerTabId?: string;
	/** Overrides the whole default callback prompt body. */
	callbackPrompt?: string;
	/** Give up and fire a `timeout` callback after this long. */
	timeoutMs: number;
	/** The prompt that was dispatched (surfaced as {{DISPATCH_PROMPT}}). */
	prompt: string;
	/**
	 * Arm immediately if a process for this tab already spawned in the recent
	 * past. Only safe for `--new-tab`, where the tab id is brand new and any
	 * spawn against it must be our dispatch - it closes the race where the
	 * renderer spawns before the new-tab ack round-trips back to the server.
	 * Never set this for an existing tab: a still-running predecessor turn would
	 * arm (and then fire) the callback.
	 */
	armFromRecentSpawn?: boolean;
}

export interface DispatchCallbackEntry extends DispatchCallbackRegistration {
	callbackId: string;
	/**
	 * Composite process session id the exit listener sees for this tab:
	 * `{agentId}-ai-{tabId}`. This is the correlation key - completions from
	 * other tabs of the same agent never match.
	 */
	processSessionId: string;
	createdAt: number;
	expiresAt: number;
	state: DispatchCallbackState;
	/** Wall-clock ms when the dispatched process started (set on spawn). */
	startedAt?: number;
	exitCode?: number | null;
	durationMs?: number;
}

/** Payload handed to the delivery side when a callback fires. */
export interface DispatchCallbackFire {
	entry: DispatchCallbackEntry;
	status: DispatchCallbackStatus;
	exitCode: number | null;
	durationMs: number;
	/** Auto Run progress, when the dispatch ended via an Auto Run batch. */
	tasksCompleted?: number;
	tasksTotal?: number;
}
