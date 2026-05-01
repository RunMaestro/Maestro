/**
 * planning-pipeline-types.ts
 *
 * Canonical contracts for the Planning Pipeline — the machine-enforced
 * representation of the idea → PRD → epic → tasks → agent-ready → dispatch
 * → review → merge workflow inside Maestro.
 *
 * This file is intentionally types-only with a single pure helper.  No I/O,
 * no IPC, no main-process imports.  The runtime event bus (#246) and transition
 * guards (#245) build on top of these definitions.
 *
 * Stage-to-WorkItemStatus mapping (for cross-system readers):
 *   runner-active  ↔  WorkItemStatus 'claimed'
 *   needs-review   ↔  WorkItemStatus 'review'
 *   fork-merged    ↔  WorkItemStatus 'done'
 *
 * The pipeline stage is a SUPERSET of Work Graph status — it carries
 * lifecycle semantics that the generic Work Graph vocabulary does not
 * express (e.g. 'prd-draft' vs 'prd-finalized', 'needs-fix' vs 'fix-active').
 * The existing WORK_GRAPH_READY_TAG ('agent-ready') remains the canonical
 * pickup eligibility signal; 'agent-ready' as a pipeline stage simply mirrors
 * the moment that tag is applied.
 *
 * @see src/shared/work-graph-types.ts — WorkItem shape and WORK_GRAPH_READY_TAG
 * @see src/shared/delivery-planner-types.ts — PRD/epic/task conventions
 * @see src/shared/cross-major-contracts.ts — metadata namespace registry
 */

// ---------------------------------------------------------------------------
// Stage vocabularies
// ---------------------------------------------------------------------------

/**
 * Ordered list of forward pipeline stages.
 *
 * The ordering here is intentional documentation, not a runtime constraint —
 * the authoritative forward/backward rules live in PIPELINE_TRANSITIONS.
 */
export const PIPELINE_STAGES = [
	'idea',
	'prd-draft',
	'prd-finalized',
	'epic-decomposed',
	'tasks-decomposed',
	'agent-ready',
	'runner-active',
	'needs-review',
	'review-approved',
	'fork-merged',
] as const;

/**
 * Failure-loop stages that can be entered from 'needs-review' and exit
 * back toward 'needs-review' once a fix is complete.
 */
export const PIPELINE_FAILURE_STAGES = ['needs-fix', 'fix-active'] as const;

/** Union type of all forward pipeline stages. */
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Union type of all failure-loop stages. */
export type PipelineFailureStage = (typeof PIPELINE_FAILURE_STAGES)[number];

/** Any valid pipeline stage (forward or failure-loop). */
export type AnyPipelineStage = PipelineStage | PipelineFailureStage;

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Valid forward (and failure-loop) transitions for each pipeline stage.
 *
 * Rules:
 * - Only edges listed here are permitted.  All other transitions are rejected.
 * - Failure-loop entries: 'needs-review' → 'needs-fix' → 'fix-active' → 'needs-review'.
 * - Terminal stages ('fork-merged') have no outbound transitions.
 * - Stages that have not yet reached 'needs-review' cannot enter the failure loop.
 */
export const PIPELINE_TRANSITIONS: Record<PipelineStage, AnyPipelineStage[]> = {
	idea: ['prd-draft'],
	'prd-draft': ['prd-finalized'],
	'prd-finalized': ['epic-decomposed'],
	'epic-decomposed': ['tasks-decomposed'],
	'tasks-decomposed': ['agent-ready'],
	'agent-ready': ['runner-active'],
	'runner-active': ['needs-review'],
	'needs-review': ['review-approved', 'needs-fix'],
	'review-approved': ['fork-merged'],
	'fork-merged': [],
} as const;

/**
 * Valid transitions out of each failure-loop stage.
 *
 * Kept separate from PIPELINE_TRANSITIONS so that PIPELINE_TRANSITIONS can
 * remain typed as `Record<PipelineStage, …>` without widening the key set.
 */
export const PIPELINE_FAILURE_TRANSITIONS: Record<PipelineFailureStage, AnyPipelineStage[]> = {
	'needs-fix': ['fix-active'],
	'fix-active': ['needs-review'],
} as const;

// ---------------------------------------------------------------------------
// Label mapping
// ---------------------------------------------------------------------------

/**
 * Canonical GitHub label name for each pipeline stage.
 *
 * The future engine syncs these labels to GitHub issues/PRs so that
 * human reviewers and CLI tools can read pipeline state from labels alone.
 * Label names use the 'pipeline:' prefix to avoid collisions with existing
 * Work Graph or Delivery Planner labels.
 */
export const PIPELINE_LABEL_BY_STAGE: Record<AnyPipelineStage, string> = {
	idea: 'pipeline:idea',
	'prd-draft': 'pipeline:prd-draft',
	'prd-finalized': 'pipeline:prd-finalized',
	'epic-decomposed': 'pipeline:epic-decomposed',
	'tasks-decomposed': 'pipeline:tasks-decomposed',
	'agent-ready': 'pipeline:agent-ready',
	'runner-active': 'pipeline:runner-active',
	'needs-review': 'pipeline:needs-review',
	'review-approved': 'pipeline:review-approved',
	'fork-merged': 'pipeline:fork-merged',
	'needs-fix': 'pipeline:needs-fix',
	'fix-active': 'pipeline:fix-active',
} as const;

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------

/**
 * Event emitted whenever a work item moves between pipeline stages.
 *
 * The runtime event bus (#246) will persist and broadcast these.
 * Kept minimal here so downstream types can extend without circular deps.
 */
export interface PipelineStageEvent {
	/** Work Graph item ID whose pipeline stage changed. */
	workItemId: string;
	/** Stage the item was in before this transition. */
	fromStage: AnyPipelineStage;
	/** Stage the item moved to. */
	toStage: AnyPipelineStage;
	/**
	 * Actor that triggered the transition.  Mirrors WorkGraphActor.id
	 * (agent id, user id, or system identifier) — typed as string here
	 * to avoid a direct import of work-graph-types and the circular-dep
	 * risk that comes with it.
	 */
	actor: string;
	/** ISO-8601 timestamp of when the transition occurred. */
	occurredAt: string;
}

// ---------------------------------------------------------------------------
// Pure transition helper
// ---------------------------------------------------------------------------

/**
 * Returns `true` when moving from `from` to `to` is listed as a valid
 * edge in the combined transition tables.
 *
 * This is a pure function with no side effects — suitable for use in
 * renderers, tests, and the main-process engine alike.
 */
export function isValidTransition(from: AnyPipelineStage, to: AnyPipelineStage): boolean {
	const forwardTargets =
		PIPELINE_TRANSITIONS[from as PipelineStage] ??
		PIPELINE_FAILURE_TRANSITIONS[from as PipelineFailureStage] ??
		[];
	return (forwardTargets as AnyPipelineStage[]).includes(to);
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown by the pipeline engine when a requested stage transition is not
 * present in the transition table.
 *
 * Having a typed error class allows callers to distinguish a rejected
 * transition from other unexpected failures without string-matching.
 */
export class InvalidPipelineTransitionError extends Error {
	readonly from: AnyPipelineStage;
	readonly to: AnyPipelineStage;

	constructor(from: AnyPipelineStage, to: AnyPipelineStage, message?: string) {
		super(message ?? `Invalid pipeline transition: '${from}' → '${to}'`);
		this.name = 'InvalidPipelineTransitionError';
		this.from = from;
		this.to = to;
		// Ensure correct prototype chain in compiled-down ES5 targets.
		Object.setPrototypeOf(this, new.target.prototype);
	}
}
