/**
 * restart-recovery.ts
 *
 * recoverPipelineState — reconciles in-flight pipeline items on app startup.
 *
 * On boot, after the Work Graph is initialized, call `recoverPipelineState(deps)`
 * to walk every in-flight work item and reconcile its pipeline state:
 *
 *   - Claim EXPIRED and stage is a "claimed" stage → release the claim and
 *     roll back the stage to its predecessor (e.g. `runner-active` → `agent-ready`).
 *   - Claim is still VALID (or absent) → leave the item untouched.
 *
 * Rolling back rather than dead-lettering gives the dispatch engine a clean
 * opportunity to re-pick up the item as soon as the tick fires, without manual
 * intervention.  The supervisor (#253) will handle the dead-letter path if the
 * same item expires again after retry-budget exhaustion.
 *
 * Design decisions:
 *   - Per-item errors are swallowed so one broken item never blocks recovery of
 *     the rest.
 *   - `now()` is injectable so tests are fully deterministic.
 *   - No dependency on the event bus or supervisor — this is a one-shot
 *     function called before those loops start.
 *
 * @see pipeline-supervisor.ts — ongoing expired-claim handling (post-boot)
 * @see sla-types.ts           — SlaConfig / SlaBreach for SLA layer
 */

import type { AnyPipelineStage } from '../../../shared/planning-pipeline-types';

// ---------------------------------------------------------------------------
// Stage predecessor map
// ---------------------------------------------------------------------------

/**
 * Maps each "claimed" stage to the predecessor stage that an item should roll
 * back to when its claim is found expired on restart.
 *
 * Only stages where a claim makes semantic sense are listed here.  Stages
 * without a predecessor entry are left alone by recovery.
 */
const STAGE_PREDECESSOR: Partial<Record<AnyPipelineStage, AnyPipelineStage>> = {
	'runner-active': 'agent-ready',
	'fix-active': 'needs-fix',
	// 'needs-review' items have no active claim — they wait for human review,
	// so no rollback is required.
	// 'review-approved' → 'fork-merged' transition is atomic; no recovery needed.
};

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Description of an in-flight work item as returned by `listInFlight`.
 *
 * Fields are intentionally minimal.  The consumer builds this from whatever
 * storage backend it uses (Work Graph DB, external mirror, etc.).
 */
export interface InFlightRecoveryItem {
	/** Work Graph item ID. */
	workItemId: string;
	/** The stage the item is currently recorded as being in. */
	currentStage: AnyPipelineStage;
	/** Active claim, if any.  Absent means the item is queue-eligible already. */
	claim?: {
		/** Agent session that holds this claim. */
		sessionId: string;
		/**
		 * Unix epoch ms when the claim expires.
		 * When undefined the claim is treated as non-expiring and left alone.
		 */
		expiresAt?: number;
	};
}

/** Dependencies injected into `recoverPipelineState`. */
export interface RecoveryDeps {
	/**
	 * Returns all work items that are considered "in flight" — i.e. not yet
	 * in a terminal stage (`fork-merged`).
	 */
	listInFlight(): Promise<InFlightRecoveryItem[]>;

	/**
	 * Force-releases an expired claim so the item becomes pickup-eligible.
	 *
	 * @param id     Work item ID.
	 * @param reason Human-readable reason string for audit logs.
	 */
	releaseClaim(id: string, reason: string): Promise<void>;

	/**
	 * Moves a work item from `fromStage` to `toStage`.
	 *
	 * Called AFTER a successful `releaseClaim` to roll the stage back to the
	 * predecessor so the dispatch engine can re-pick it up.
	 */
	applyStageTransition(id: string, from: AnyPipelineStage, to: AnyPipelineStage): Promise<void>;

	/**
	 * Returns the current time in Unix epoch ms.
	 * Defaults to `Date.now()` when not provided.
	 */
	now?: () => number;
}

/** Summary returned by `recoverPipelineState`. */
export interface RecoveryResult {
	/** Number of items whose expired claims were released and stage rolled back. */
	rolledBack: number;
	/**
	 * Number of items whose claims were expired but had no predecessor stage
	 * to roll back to — only the claim was released.
	 */
	releasedExpired: number;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Walks all in-flight pipeline items and reconciles their state.
 *
 * Must be called BEFORE the dispatch tick loop starts to avoid double-claim
 * races.
 *
 * @returns A summary of what was reconciled.
 */
export async function recoverPipelineState(deps: RecoveryDeps): Promise<RecoveryResult> {
	const now = deps.now ? deps.now() : Date.now();
	const result: RecoveryResult = { rolledBack: 0, releasedExpired: 0 };

	let items: InFlightRecoveryItem[];
	try {
		items = await deps.listInFlight();
	} catch (err) {
		console.error('[recoverPipelineState] listInFlight failed:', err);
		return result;
	}

	for (const item of items) {
		await recoverItem(item, now, deps, result);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function recoverItem(
	item: InFlightRecoveryItem,
	now: number,
	deps: RecoveryDeps,
	result: RecoveryResult
): Promise<void> {
	const { workItemId, currentStage, claim } = item;

	// No claim or no expiry — nothing to reconcile.
	if (!claim || claim.expiresAt === undefined) {
		return;
	}

	// Claim is still valid — leave the item alone.
	if (claim.expiresAt > now) {
		return;
	}

	// Claim is expired.  Release it first, then roll back stage.
	const released = await tryReleaseClaim(workItemId, claim.sessionId, deps);
	if (!released) {
		// releaseClaim threw — skip the rollback to avoid acting on a partially-
		// released claim.
		return;
	}

	const predecessor = STAGE_PREDECESSOR[currentStage];
	if (!predecessor) {
		// Stage has no rollback target — only the claim release was needed.
		result.releasedExpired += 1;
		return;
	}

	const rolledBack = await tryApplyTransition(workItemId, currentStage, predecessor, deps);
	if (rolledBack) {
		result.rolledBack += 1;
	} else {
		// Transition failed — the release still happened, count as released-only.
		result.releasedExpired += 1;
	}
}

async function tryReleaseClaim(
	workItemId: string,
	sessionId: string,
	deps: RecoveryDeps
): Promise<boolean> {
	try {
		await deps.releaseClaim(
			workItemId,
			`restart-recovery: claim expired at boot (sessionId=${sessionId})`
		);
		return true;
	} catch (err) {
		console.error(`[recoverPipelineState] releaseClaim failed for workItemId=${workItemId}:`, err);
		return false;
	}
}

async function tryApplyTransition(
	workItemId: string,
	from: AnyPipelineStage,
	to: AnyPipelineStage,
	deps: RecoveryDeps
): Promise<boolean> {
	try {
		await deps.applyStageTransition(workItemId, from, to);
		return true;
	} catch (err) {
		console.error(
			`[recoverPipelineState] applyStageTransition failed for workItemId=${workItemId} (${from} → ${to}):`,
			err
		);
		return false;
	}
}
