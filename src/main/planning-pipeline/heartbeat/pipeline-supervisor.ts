/**
 * pipeline-supervisor.ts
 *
 * PipelineSupervisor — tick-based safety net for the autonomous planning loop.
 *
 * On each call to `tick()` the supervisor:
 *   1. Fetches all in-flight work items from the injected `listInFlight()` dep.
 *   2. For each item whose claim has `expiresAt < now()`:
 *      a. Calls `releaseClaim()` to force-release the stalled claim.
 *      b. If `attempt < maxRetries`: calls `retryClaim()` to re-queue the item
 *         for pickup by a different agent.
 *      c. If `attempt >= maxRetries`: calls `deadLetter()` to move the item
 *         to `needs-fix` for human triage.
 *   3. Returns a tick summary `{ released, retried, deadLettered }`.
 *
 * Per-item errors are swallowed so that a failure on item A never blocks item B.
 *
 * Interval scheduling is OUT OF SCOPE — the consumer is responsible for
 * calling `tick()` on a cadence (e.g. via `setInterval`).
 *
 * @see supervisor-types.ts  — PipelineSupervisorDeps and SupervisorTickResult
 * @see src/main/agent-dispatch/heartbeat.ts  — per-claim heartbeat (lower layer)
 */

import type {
	InFlightWorkItem,
	PipelineSupervisorDeps,
	SupervisorTickResult,
} from './supervisor-types';

const DEFAULT_MAX_RETRIES = 2;

export class PipelineSupervisor {
	private readonly now: () => number;
	private readonly maxRetries: number;

	constructor(private readonly deps: PipelineSupervisorDeps) {
		this.now = deps.now ?? (() => Date.now());
		this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
	}

	/**
	 * Execute one supervisor pass.
	 *
	 * Iterates all in-flight items, detects expired claims, and applies the
	 * release → retry-or-dead-letter policy.  Per-item errors are caught and
	 * logged to `console.error` so that one bad item never blocks the others.
	 *
	 * Returns a summary of what happened during this tick.
	 */
	async tick(): Promise<SupervisorTickResult> {
		const result: SupervisorTickResult = { released: 0, retried: 0, deadLettered: 0 };

		let items: InFlightWorkItem[];
		try {
			items = await this.deps.listInFlight();
		} catch (err) {
			// If we cannot list items at all, bail early — nothing to do.
			console.error('[PipelineSupervisor] listInFlight failed:', err);
			return result;
		}

		const nowMs = this.now();
		const nowIso = new Date(nowMs).toISOString();

		for (const item of items) {
			const { workItemId, claim } = item;

			// Skip items that have no expiry or have not yet expired.
			if (!claim.expiresAt || claim.expiresAt > nowIso) {
				continue;
			}

			await this.handleExpiredItem(workItemId, claim.sessionId, claim.attempt ?? 0, result);
		}

		return result;
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private async handleExpiredItem(
		workItemId: string,
		sessionId: string,
		attempt: number,
		result: SupervisorTickResult
	): Promise<void> {
		// Step 1: force-release the stalled claim.
		const released = await this.tryRelease(workItemId, sessionId, attempt);
		if (!released) {
			// releaseClaim threw — skip the retry/dead-letter decision for this item
			// to avoid acting on a claim we may not have successfully released.
			return;
		}
		result.released += 1;

		// Step 2: retry or dead-letter.
		if (attempt < this.maxRetries) {
			await this.tryRetry(workItemId, sessionId, attempt, result);
		} else {
			await this.tryDeadLetter(workItemId, attempt, result);
		}
	}

	/**
	 * Attempt to release the claim.  Returns `true` on success, `false` if the
	 * dep threw (error is swallowed after logging).
	 */
	private async tryRelease(
		workItemId: string,
		sessionId: string,
		attempt: number
	): Promise<boolean> {
		try {
			await this.deps.releaseClaim(
				workItemId,
				`pipeline-supervisor: claim expired (sessionId=${sessionId}, attempt=${attempt})`
			);
			return true;
		} catch (err) {
			console.error(`[PipelineSupervisor] releaseClaim failed for workItemId=${workItemId}:`, err);
			return false;
		}
	}

	private async tryRetry(
		workItemId: string,
		sessionId: string,
		attempt: number,
		result: SupervisorTickResult
	): Promise<void> {
		try {
			await this.deps.retryClaim(workItemId, { previousSessionId: sessionId, attempt });
			result.retried += 1;
		} catch (err) {
			console.error(`[PipelineSupervisor] retryClaim failed for workItemId=${workItemId}:`, err);
		}
	}

	private async tryDeadLetter(
		workItemId: string,
		attempt: number,
		result: SupervisorTickResult
	): Promise<void> {
		const totalAttempts = attempt + 1; // attempt is 0-based index
		const reason = `exceeded retry budget after ${totalAttempts} attempt${totalAttempts === 1 ? '' : 's'}`;
		try {
			await this.deps.deadLetter(workItemId, reason);
			result.deadLettered += 1;
		} catch (err) {
			console.error(`[PipelineSupervisor] deadLetter failed for workItemId=${workItemId}:`, err);
		}
	}
}
