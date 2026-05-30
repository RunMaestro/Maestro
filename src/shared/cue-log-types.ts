/**
 * Cue Log Payload — typed discriminated union for structured activity updates.
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
