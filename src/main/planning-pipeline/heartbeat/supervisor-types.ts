/**
 * supervisor-types.ts
 *
 * Dependency interface and supporting types for PipelineSupervisor.
 *
 * Deliberately thin — no imports from work-graph internals, no IPC, no DB.
 * The consumer wires concrete implementations against these contracts when
 * constructing a PipelineSupervisor.
 */

// ---------------------------------------------------------------------------
// In-flight item descriptor
// ---------------------------------------------------------------------------

/**
 * Minimal claim shape required by the supervisor.  Only the fields the
 * supervisor actually reads are present here; the full WorkItemClaim from
 * work-graph-types is a superset.
 */
export interface InFlightClaim {
	/** Session / agent that holds the claim. */
	sessionId: string;
	/**
	 * ISO-8601 expiry deadline.  When omitted the supervisor treats the item
	 * as not-yet-expired and skips it for this tick.
	 */
	expiresAt?: string;
	/**
	 * How many times this item has already been retried.  Starts at 0 for
	 * the initial attempt.  The supervisor increments this counter by calling
	 * `retryClaim` and reading the returned `attempt` field.
	 */
	attempt?: number;
}

export interface InFlightWorkItem {
	workItemId: string;
	claim: InFlightClaim;
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface RetryResult {
	/** Whether a new claim was queued (false when at or beyond maxRetries). */
	retried: boolean;
	/** Attempt number after this retry (1-based: 1 = first retry). */
	attempt: number;
}

/**
 * All external side-effects the supervisor needs, injected so that the class
 * itself stays pure and unit-testable without a real DB.
 */
export interface PipelineSupervisorDeps {
	/**
	 * Returns the current Unix timestamp in milliseconds.
	 * Injectable for deterministic tests.  Defaults to `Date.now`.
	 */
	now?: () => number;

	/**
	 * Force-release a stalled claim.
	 *
	 * Must not throw when the claim is already released.
	 */
	releaseClaim(workItemId: string, reason: string): Promise<void>;

	/**
	 * Re-queue the work item for pickup by a different agent.
	 *
	 * The consumer is responsible for excluding the previous claimant so the
	 * same agent is not selected again.  Returns whether a retry was queued
	 * and the resulting attempt number.
	 */
	retryClaim(
		workItemId: string,
		args: { previousSessionId: string; attempt: number }
	): Promise<RetryResult>;

	/**
	 * Transition the work item to a dead-letter state (e.g. `needs-fix`)
	 * for human triage.
	 */
	deadLetter(workItemId: string, reason: string): Promise<void>;

	/** List all work items that currently have an active in-flight claim. */
	listInFlight(): Promise<InFlightWorkItem[]>;

	/**
	 * Maximum number of *retries* after the initial attempt.
	 *
	 * With the default of 2:
	 *   - attempt 0 → fails → retry #1 (attempt becomes 1)
	 *   - attempt 1 → fails → retry #2 (attempt becomes 2)
	 *   - attempt 2 → fails → dead-letter
	 *
	 * Total attempts = maxRetries + 1.  Default: 2.
	 */
	maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Tick result
// ---------------------------------------------------------------------------

/** Summary returned by each `PipelineSupervisor.tick()` call. */
export interface SupervisorTickResult {
	/** Number of claims that were force-released this tick. */
	released: number;
	/** Number of items re-queued for retry this tick. */
	retried: number;
	/** Number of items moved to the dead-letter state this tick. */
	deadLettered: number;
}
