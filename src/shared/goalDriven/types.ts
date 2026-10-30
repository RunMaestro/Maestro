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
	/** Reported progress, clamped to 0-100 and rounded; `null` if not reported. */
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
	/** Normalized progress for this iteration (0-100, never null in history). */
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

/*
 * Plan Doc contracts.
 *
 * A goal run keeps its plan in one Markdown file per run, the Plan Doc (see
 * `.maestro/scratch/goal-live-plan.md`). The engine is its only writer: the
 * agent proposes Plan changes through a `<!-- maestro:plan -->` marker block,
 * the human edits the file in the Auto Run editor, and the engine merges the
 * two at each iteration boundary (`goalPlan.ts`). The doc comments below
 * record who may change each field, because the merge enforces exactly those
 * rules and a later "simplification" that lets the agent write a human field
 * would silently discard the conductor's edits.
 */

/** Lifecycle state the engine stamps into the Plan Doc front matter. */
export type GoalPlanStatus = 'running' | 'paused' | 'done' | 'deadlock' | 'stalled' | 'stopped';

/** One `- [ ]` / `- [x]` line of the Plan section. */
export interface GoalPlanItem {
	/**
	 * Stable identity the merge keys on (`a<n>` for agent items, `h<n>` for
	 * human items). Assigned once and never reused, so a reworded or moved
	 * item is still recognized as the same item across iterations.
	 */
	id: string;
	/**
	 * The step text, without the checkbox or the trailing id comment. The
	 * agent may reword its own (`by:agent`) items; it may never reword a
	 * `by:human` item. The human may reword anything.
	 */
	text: string;
	/**
	 * Done state. The agent may check and uncheck any item, including human
	 * items; the human may too, and the human wins when both change it.
	 */
	checked: boolean;
	/** Nesting level, 0 for top level; two spaces of indentation per level. */
	depth: number;
	/**
	 * Who created the item. Decides the ownership rule: the agent can never
	 * delete or reword a `by:human` item, and a conflict is recorded instead.
	 */
	author: 'agent' | 'human';
	/**
	 * Iteration that created the item; `null` for human items, which are
	 * typed in the editor outside any iteration.
	 */
	iteration: number | null;
}

/** Engine-owned YAML front matter of the Plan Doc. */
export interface GoalPlanFrontMatter {
	/** Run id this doc belongs to. Engine writes; human edits are overwritten. */
	goalRun: string;
	/** Run lifecycle state. Engine writes; human edits are overwritten. */
	status: GoalPlanStatus;
	/** Last completed iteration (0 before the first). Engine writes; human edits are overwritten. */
	iteration: number;
	/**
	 * Iteration cap, `null` = run indefinitely. The one front-matter key the
	 * human may edit: the change takes effect at the next iteration. The
	 * agent reads it and never writes it.
	 */
	maxIterations: number | null;
	/** Last self-reported progress, 0-100. Engine writes; human edits are overwritten. */
	progress: number;
	/** ISO-8601 timestamp of the last engine write. Engine writes; human edits are overwritten. */
	updated: string;
}

/** A parsed Plan Doc. */
export interface GoalPlanDoc {
	/** Engine-owned front matter; see each key for its ownership rule. */
	frontMatter: GoalPlanFrontMatter;
	/**
	 * `## Goal` text. Human edits; the agent reads it. The next iteration
	 * uses this text, not the goal captured at run start.
	 */
	goal: string;
	/** `## Exit Criteria` text. Human edits; the agent reads it. */
	exitCriteria: string;
	/**
	 * `## Plan` items in display order. The agent proposes changes (add,
	 * check, uncheck, reorder, reword its own items); the human edits
	 * anything. The engine merges the two with `mergeGoalPlan`.
	 */
	items: GoalPlanItem[];
	/**
	 * `## Conductor Notes` text. Human only: the agent reads it every
	 * iteration and never edits it. Persistent, unlike a steering note.
	 */
	conductorNotes: string;
	/**
	 * `## Iteration Log` lines, oldest first, without the leading `- `.
	 * The engine appends one per iteration; the human reads it.
	 */
	iterationLog: string[];
	/**
	 * Human content the doc has no field for, kept verbatim so a render
	 * never loses it. Human-owned: the engine carries it from the on-disk
	 * copy and the agent never sees or changes it.
	 */
	preserved: GoalPlanPreserved;
}

/** A Plan Doc section key the parser owns, in canonical render order. */
export type GoalPlanSectionKey =
	| 'goal'
	| 'exitCriteria'
	| 'plan'
	| 'conductorNotes'
	| 'iterationLog';

/** A `## ` section the Plan Doc does not own (`## Links`, `## Scratch`). */
export interface GoalPlanExtraSection {
	/** The heading line exactly as typed, including the `## `. */
	heading: string;
	/** Body lines verbatim, without leading or trailing blank lines. */
	body: string;
	/**
	 * The owned section this one followed in the file, `null` when it came
	 * before all of them. Render puts it back in the same place.
	 */
	after: GoalPlanSectionKey | null;
}

/** Non-item lines inside `## Plan` (a paragraph, a fenced block, a plain bullet). */
export interface GoalPlanFreeText {
	/** Id of the item the lines followed, `null` when they came before every item. */
	afterId: string | null;
	/** The lines verbatim, joined with `\n`. */
	text: string;
}

/** Everything in a Plan Doc that `parseGoalPlanDoc` does not model. */
export interface GoalPlanPreserved {
	/** Front-matter lines that are not one of the six engine keys (`tags: [x]`). */
	frontMatterLines: string[];
	/** Text between the front matter and the first `## ` heading (`# My title`). */
	preamble: string;
	/** Unknown `## ` sections, in file order. */
	sections: GoalPlanExtraSection[];
	/** Free text inside `## Plan`, anchored to the item it followed. */
	planText: GoalPlanFreeText[];
}

/** Outcome of merging the agent's proposed Plan into the file on disk. */
export interface GoalPlanMergeResult {
	/** The merged doc. Every section except Plan comes from the on-disk copy. */
	doc: GoalPlanDoc;
	/**
	 * Agent changes the merge refused because the human wins, for example
	 * an attempt to reword or delete a `by:human` item. Recorded in History,
	 * never fatal.
	 */
	conflicts: { id: string; reason: string }[];
	/** Non-fatal oddities (an unknown id in the agent's list, a duplicate id). */
	warnings: string[];
}
