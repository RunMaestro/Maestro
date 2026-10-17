/**
 * Cue Log Payload - typed discriminated union for structured activity updates.
 *
 * Every `onLog(level, message, data?)` emission in the Cue engine should pass a
 * payload conforming to this union (or omit it entirely). The renderer narrows
 * on `payload.type` to route toasts, refreshes, and inline banners.
 *
 * Adding a new log type:
 *   1) Add a new union member here.
 *   2) Emit it from the appropriate Cue module.
 *   3) If the renderer needs to react specifically, narrow in useCue's
 *      onActivityUpdate listener.
 */

export type CueLogPayload =
	| { type: 'engineStarted' }
	| { type: 'engineStopped' }
	| { type: 'configReloaded'; sessionId: string }
	| { type: 'configRemoved'; sessionId: string }
	| { type: 'triggerHealthWarning'; sessionId: string; message: string }
	| {
			type: 'runStarted';
			runId: string;
			sessionId: string;
			subscriptionName: string;
	  }
	| {
			type: 'runFinished';
			runId: string;
			sessionId: string;
			subscriptionName: string;
			status: string;
	  }
	| {
			type: 'runStopped';
			runId: string;
			sessionId: string;
			subscriptionName: string;
	  }
	| {
			/**
			 * A subscription's `gate` skipped an event: nothing was spawned, and
			 * a `gated` row was recorded with the reason. Not a `runFinished`,
			 * because no run started, so it must not count as one.
			 */
			type: 'runGated';
			runId: string;
			sessionId: string;
			subscriptionName: string;
			reason: string;
	  }
	| {
			/**
			 * A subscription's `gate` could not be checked (the `cue-gate` task
			 * is off, its model is not installed, its server is down). `ran`
			 * says which way the subscription's `gate_on_unavailable` policy
			 * went. Raised to the user as a sticky notice even with the Cue
			 * modal closed: an unchecked gate is either spending turns the gate
			 * was meant to save, or skipping events the user expects handled.
			 */
			type: 'gateUnavailable';
			sessionId: string;
			subscriptionName: string;
			message: string;
			ran: boolean;
	  }
	| {
			/**
			 * The prompt-injection screen refused a dispatch: nothing was
			 * spawned, and a `blocked-injection` row was recorded. Raised to
			 * the user as a red notice they have to dismiss. `variable` and
			 * `score` are absent when the block is the fail-closed one (the
			 * screen could not run on a command).
			 */
			type: 'injectionBlocked';
			runId: string;
			sessionId: string;
			/** The owning agent's name, for the notice's header strip. */
			sessionName: string;
			subscriptionName: string;
			pipelineName?: string;
			reason: string;
			variable?: string;
			score?: number;
	  }
	| {
			/**
			 * A subscription asked for the prompt-injection screen and it could
			 * not run, and the run started anyway (an agent prompt fails open).
			 * Raised as a sticky notice: text the user wanted screened is
			 * reaching an agent unscreened.
			 */
			type: 'injectionScreenUnavailable';
			sessionId: string;
			subscriptionName: string;
			message: string;
	  }
	| {
			type: 'queueOverflow';
			sessionId: string;
			sessionName: string;
			subscriptionName: string;
			queuedAt: number;
	  }
	| { type: 'queueRestored'; sessionId: string; count: number }
	| {
			type: 'queueDropped';
			/** Omitted for aggregate restore-path drops that span multiple sessions. */
			sessionId?: string;
			count: number;
			reason: 'stale' | 'malformed' | 'session-missing';
	  }
	| {
			type: 'fanInTimeout';
			ownerSessionId: string;
			subscriptionName: string;
			mode: 'continue' | 'break';
	  }
	| {
			type: 'fanInComplete';
			ownerSessionId: string;
			subscriptionName: string;
			sourceCount: number;
	  }
	| {
			/**
			 * Unattended AI time to credit toward the Conductor level (badge
			 * progression + leaderboard). Emitted once per terminal Cue run that
			 * represents agent work, whatever its status - a failed, timed-out,
			 * or stopped run still consumed unattended machine time. Command
			 * nodes never emit this event.
			 *
			 * `creditMs` is always a whole number of minutes, but the engine
			 * carries the sub-minute remainder across runs, so a run shorter
			 * than a minute contributes rather than being floored away (it just
			 * may not emit until a later run pushes the total over a minute).
			 * See cue-engine's creditConductorTime().
			 */
			type: 'conductorTimeCredit';
			creditMs: number;
	  }
	| { type: 'rateLimitBackoff'; triggerName: string; backoffMs: number }
	| { type: 'githubPollError'; triggerName: string }
	| { type: 'heartbeatFailure'; consecutiveFailures: number }
	| { type: 'zombieProcess'; pid: number; runId: string }
	| {
			type: 'pathTraversalBlocked';
			kind: 'glob' | 'watcher' | 'prompt';
			pattern: string;
	  };

/** Narrowing helper for the renderer when matching by type string. */
export type CueLogPayloadType = CueLogPayload['type'];
