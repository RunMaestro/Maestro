/**
 * Role-based pipeline state machine for Agent Dispatch (#427).
 *
 * Default happy path:  runner → reviewer → merger
 * Reject branch:       reviewer reject → fixer → reviewer (loop until approve)
 *
 * All functions are pure — no side effects.  The dispatch engine wires these
 * into the broader claim lifecycle.
 */

import type { WorkItemPipeline, WorkItemPipelineRole } from '../../shared/work-graph-types';

// ---------------------------------------------------------------------------
// Event vocabulary
// ---------------------------------------------------------------------------

export type PipelineEvent =
	| 'runner-done'
	| 'review-approve'
	| 'review-reject'
	| 'fixer-done'
	| 'merger-done';

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Allowed (from-role, event) → next-role transitions.
 * `null` means the pipeline terminates (no next role).
 */
const TRANSITIONS: ReadonlyMap<
	WorkItemPipelineRole,
	Partial<Record<PipelineEvent, WorkItemPipelineRole | null>>
> = new Map([
	[
		'runner',
		{
			'runner-done': 'reviewer',
		} satisfies Partial<Record<PipelineEvent, WorkItemPipelineRole | null>>,
	],
	[
		'reviewer',
		{
			'review-approve': 'merger',
			'review-reject': 'fixer',
		} satisfies Partial<Record<PipelineEvent, WorkItemPipelineRole | null>>,
	],
	[
		'fixer',
		{
			'fixer-done': 'reviewer',
		} satisfies Partial<Record<PipelineEvent, WorkItemPipelineRole | null>>,
	],
	[
		'merger',
		{
			'merger-done': null, // terminal
		} satisfies Partial<Record<PipelineEvent, WorkItemPipelineRole | null>>,
	],
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate whether transitioning from `from` to `to` via `event` is legal.
 *
 * Returns `true` on success, or a descriptive reason string on failure.
 */
export function validateTransition(
	from: WorkItemPipelineRole,
	to: WorkItemPipelineRole | null,
	event: PipelineEvent
): true | string {
	const allowed = TRANSITIONS.get(from);
	if (!allowed) {
		return `Unknown source role '${from}'`;
	}

	if (!(event in allowed)) {
		return `Event '${event}' is not valid from role '${from}'`;
	}

	const expectedNext = allowed[event];
	if (expectedNext !== to) {
		const expectedLabel = expectedNext === null ? 'terminal (null)' : `'${expectedNext}'`;
		const actualLabel = to === null ? 'terminal (null)' : `'${to}'`;
		return (
			`Transition from '${from}' via '${event}' should lead to ${expectedLabel}` +
			`, but got ${actualLabel}`
		);
	}

	return true;
}

/**
 * Advance the pipeline given the current state and an event.
 *
 * Returns a new `WorkItemPipeline` object (the input is not mutated).
 * Throws if the transition is invalid.
 */
export function nextRole(pipeline: WorkItemPipeline, event: PipelineEvent): WorkItemPipeline {
	const from = pipeline.currentRole;
	const allowed = TRANSITIONS.get(from);

	if (!allowed) {
		throw new Error(`[state-machine] Unknown pipeline role '${from}'`);
	}

	if (!(event in allowed)) {
		throw new Error(
			`[state-machine] Event '${event}' is not a valid transition from role '${from}'`
		);
	}

	const nextRoleValue = allowed[event];

	// Build the updated completedRoles list (avoid duplicates on re-review loops)
	const completedRoles: WorkItemPipelineRole[] = pipeline.completedRoles.includes(from)
		? [...pipeline.completedRoles]
		: [...pipeline.completedRoles, from];

	// Terminal transition (merger-done) — nextRoleValue is null
	if (nextRoleValue === null || nextRoleValue === undefined) {
		return {
			currentRole: from, // role stays 'merger' until the item is marked done externally
			completedRoles,
		};
	}

	const nextRoleNarrowed: WorkItemPipelineRole = nextRoleValue;
	return {
		currentRole: nextRoleNarrowed,
		completedRoles,
	};
}

/**
 * Returns true when the pipeline has reached its terminal state.
 * A pipeline is terminal when the merger has completed its stage.
 */
export function isTerminal(pipeline: WorkItemPipeline): boolean {
	return pipeline.currentRole === 'merger' && pipeline.completedRoles.includes('merger');
}

/**
 * Build an initial pipeline state for a freshly-created work item.
 */
export function createInitialPipeline(): WorkItemPipeline {
	return {
		currentRole: 'runner',
		completedRoles: [],
	};
}
