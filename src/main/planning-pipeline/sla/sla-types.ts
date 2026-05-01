/**
 * sla-types.ts
 *
 * Type contracts for the SLA tracking subsystem of the Planning Pipeline.
 *
 * These types are intentionally minimal and storage-agnostic.  The SlaTracker
 * keeps durations in memory; a future task can hydrate from the CCPM mirror.
 *
 * @see sla-tracker.ts        — in-memory SLA tracking implementation
 * @see notification-emitter.ts — breach → notification bridge
 */

import type { AnyPipelineStage } from '../../../shared/planning-pipeline-types';

// ---------------------------------------------------------------------------
// Duration record
// ---------------------------------------------------------------------------

/**
 * Records the time a work item spent (or is spending) in a single stage.
 *
 * When `exitedAt` is undefined the item is still in that stage.
 * `durationMs` is derived from `exitedAt - enteredAt` and is set at exit time
 * as a convenience cache — callers should not set it manually.
 */
export interface StageDuration {
	/** The pipeline stage this duration record refers to. */
	stage: AnyPipelineStage;
	/** Unix epoch ms when the item entered this stage. */
	enteredAt: number;
	/** Unix epoch ms when the item exited this stage.  Undefined means open. */
	exitedAt?: number;
	/** Closed duration in ms.  Undefined for open durations. */
	durationMs?: number;
}

// ---------------------------------------------------------------------------
// SLA configuration
// ---------------------------------------------------------------------------

/**
 * Per-stage SLA budgets in milliseconds.
 *
 * `thresholdsMs` is a partial map so callers only need to specify the stages
 * they care about.  Any stage not listed falls back to `defaultThresholdMs`.
 * When `defaultThresholdMs` is also absent, items in that stage are never
 * flagged as breached.
 *
 * Suggested defaults (per issue #259):
 *   agent-ready     1h   (3_600_000)
 *   runner-active   4h  (14_400_000)
 *   quality-gating  15m    (900_000)  — spec uses 'quality-gating' label
 *   review-active   30m  (1_800_000)  — maps to 'needs-review'
 *   merge-active    10m    (600_000)  — maps to 'review-approved'
 */
export interface SlaConfig {
	/**
	 * Stage-specific thresholds in milliseconds.
	 * Keys are any valid `AnyPipelineStage` value.
	 */
	thresholdsMs: Partial<Record<AnyPipelineStage, number>>;
	/**
	 * Fallback threshold used for stages not present in `thresholdsMs`.
	 * When omitted, stages without an explicit threshold are never breached.
	 */
	defaultThresholdMs?: number;
}

// ---------------------------------------------------------------------------
// SLA breach record
// ---------------------------------------------------------------------------

/**
 * Emitted by `SlaTracker.findBreaches()` for every open duration that has
 * exceeded its configured threshold.
 */
export interface SlaBreach {
	/** Work Graph item ID that is in breach. */
	workItemId: string;
	/** The stage the item is currently stuck in. */
	stage: AnyPipelineStage;
	/** How long the item has been in this stage as of the `now` passed to `findBreaches`. */
	durationMs: number;
	/** The configured threshold that was exceeded. */
	thresholdMs: number;
	/** Unix epoch ms when the item entered this stage. */
	enteredAt: number;
}
