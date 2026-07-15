/**
 * Type contracts for Goal-Driven Auto Run mode.
 *
 * Goal-Driven mode is the document-less counterpart to Maestro's existing
 * task/document-driven Auto Run. Instead of counting `- [ ]` checkboxes, the
 * agent pursues a free-text goal and, at the end of each iteration, emits a
 * structured `<!-- maestro:... -->` marker (see `goalMarkers.ts`) that the
 * engine parses to drive a progress bar and decide when to stop (see
 * `goalExitEvaluator.ts`).
 *
 * These types are pure data contracts - no Electron, React, or IPC. They are
 * consumed by later phases (the engine, the modal, the progress UI).
 */

/** User-authored configuration for a goal-driven run. */
export interface GoalRunConfig {
	/** The free-text objective the agent pursues. */
	goal: string;
	/**
	 * Free-text guidance describing what "done" looks like and when to declare
	 * a deadlock. Surfaced to the agent in its prompt; not machine-parsed here.
	 */
	exitCriteria: string;
	/** Maximum iterations before forcing a stop. `null` = run indefinitely. */
	maxIterations: number | null;
}

/**
 * Parsed markers from a single iteration's agent output.
 *
 * Any field may be absent in the raw text; the parser normalizes missing
 * values to `null`/`false`. The caller (the exit evaluator) decides how to
 * treat a missing progress report.
 */
export interface GoalMarkers {
	/** Reported progress, clamped to 0–100 and rounded; `null` if not reported. */
	progress: number | null;
	/** Optional short rationale accompanying the progress marker; `null` if absent or empty. */
	rationale: string | null;
	/** True if the agent declared the goal complete (bare marker or progress === 100). */
	complete: boolean;
	/** True if the agent declared a deadlock. */
	deadlock: boolean;
	/** Optional reason the agent gave for the deadlock; `null` if absent. */
	deadlockReason: string | null;
}

/** One row of run history, recorded per completed iteration. */
export interface GoalIterationRecord {
	/** 1-based iteration number. */
	iteration: number;
	/** Normalized progress for this iteration (0–100, never null in history). */
	progress: number;
	/** Optional rationale captured from the iteration's progress marker. */
	rationale: string | null;
	/** Whether the iteration reported completion. */
	complete: boolean;
	/** Whether the iteration reported a deadlock. */
	deadlock: boolean;
	/** Optional reason captured from the iteration's deadlock marker; `null` if absent. */
	deadlockReason: string | null;
}

/** The reason a goal-driven run stopped. */
export type GoalExitReason =
	| 'completed'
	| 'deadlock'
	| 'max-iterations'
	| 'stalled'
	| 'stopped-by-user';

/** The evaluator's decision after an iteration: keep going or stop (and why). */
export type GoalExitDecision =
	| { action: 'continue' }
	| { action: 'stop'; reason: GoalExitReason; detail: string };

/**
 * Number of consecutive non-progressing iterations that trips stall detection.
 *
 * Mirrors `MAX_CONSECUTIVE_NO_CHANGES` (= 3) in the task-mode runner
 * (`src/renderer/hooks/batch/internal/useBatchRunner.ts`). Both detectors share
 * the same intent: an agent that keeps running without moving the needle is
 * making no real progress. Keeping the values aligned keeps the two Auto Run
 * modes conceptually consistent.
 */
export const STALL_THRESHOLD = 3;

/**
 * Absolute upper bound on iterations for an "infinite" (`maxIterations: null`)
 * run.
 *
 * The normal exit paths - completion, deadlock, and stall detection - should
 * stop any healthy run long before this. But a buggy or adversarial agent can
 * defeat the stall detector indefinitely (e.g. oscillating its reported
 * progress 50 → 51 → 50 → 51 so a strict upward tick keeps resetting the stall
 * window) while never reaching 100 or declaring a deadlock. Without a hard
 * ceiling that pattern would spin forever, burning tokens and money. The cap is
 * deliberately high so it never interferes with a legitimately long goal; it is
 * a last-resort safety net, not a tuning knob, and hitting it is reported as a
 * "safety limit reached" stop rather than a normal completion.
 */
export const GOAL_RUN_HARD_ITERATION_CAP = 500;
