/**
 * stage-mirror-types.ts
 *
 * Type contracts for the external mirror stage-transition module.
 *
 * Every time a work item moves between pipeline stages — or is retried /
 * dead-lettered — a single audit line is appended to the item's existing
 * external markdown mirror file under a `## Stage transitions` section.  This
 * gives the file-level git history a complete, chronological pipeline trail for
 * the item without rewriting the whole document.
 *
 * @see stage-mirror.ts          — appendStageTransition / appendRetryEvent impl
 * @see src/main/delivery-planner/external-mirror.ts — the full-rewrite mirror path
 * @see src/shared/planning-pipeline-types.ts   — AnyPipelineStage vocabulary
 */

import type { AnyPipelineStage } from '../../../shared/planning-pipeline-types';

// ---------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------

/**
 * Identifies who (or what) triggered a stage transition or retry event.
 *
 * Examples:
 *   { type: 'agent',  id: 'session-abc123' }
 *   { type: 'system', id: 'planning-pipeline' }
 *   { type: 'user',   id: 'jdh@humpf.tech' }
 */
export interface StageTransitionActor {
	/** Broad category: 'agent' | 'system' | 'user'. */
	type: string;
	/** Opaque identifier within the actor type (session id, email, system label). */
	id: string;
}

// ---------------------------------------------------------------------------
// StageTransitionEntry
// ---------------------------------------------------------------------------

/**
 * Data required to record a single pipeline stage transition in the external mirror.
 */
export interface StageTransitionEntry {
	/** Work Graph item ID whose stage changed. */
	workItemId: string;
	/**
	 * Stage the item was in before this transition.
	 * `null` for the very first stage assignment (initial placement).
	 */
	fromStage: AnyPipelineStage | null;
	/** Stage the item moved to. */
	toStage: AnyPipelineStage;
	/** ISO-8601 timestamp when the transition occurred. */
	occurredAt: string;
	/** Who (or what) triggered the transition. */
	actor: StageTransitionActor;
	/**
	 * Retry attempt number (0-based).
	 * Present when this transition is part of a retry cycle; absent otherwise.
	 */
	attempt?: number;
	/**
	 * Human-readable reason for the transition.
	 * Present for retries, dead-letters, and quality-gate failures.
	 */
	reason?: string;
}
