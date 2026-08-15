/**
 * A Cappella route decision - what the Brain decided to do with an utterance.
 *
 * This is the one shape that crosses every layer: a Brain provider produces it,
 * the session service validates and announces it, the dispatch executor performs
 * it, and every client narrates it. The JSON Schema below is exported alongside
 * the type on purpose: Phase 07 compiles it into a GBNF grammar so a local model
 * is structurally incapable of emitting an invalid decision, and a second,
 * drifting copy of the shape would defeat that.
 */

/** Where the prompt goes: the conductor, or one specific agent by id. */
export type RouteTarget = 'conductor' | { sessionId: string };

/**
 * What to do with tabs on the target:
 *   current - use whatever tab is active
 *   new     - open a fresh AI tab, named `tabName` when the Brain suggested one
 *   recall  - return to an existing tab by `tabId` ("back to the auth one")
 */
export const ROUTE_TAB_ACTIONS = ['current', 'new', 'recall'] as const;

export type RouteTabAction = (typeof ROUTE_TAB_ACTIONS)[number];

export interface RouteDecision {
	target: RouteTarget;
	tabAction: RouteTabAction;
	/** Required by `recall`; ignored otherwise. */
	tabId?: string;
	/** Suggested name for a `new` tab. */
	tabName?: string;
	/** What to actually send the agent, cleaned of routing chatter. */
	prompt: string;
	/** 0 to 1. A low-confidence decision may be confirmed out loud before dispatch. */
	confidence: number;
	/**
	 * When set, this is NOT a dispatch: it is one spoken line the user has to
	 * answer before anything is sent ("the backend agent or the API agent?").
	 *
	 * A field on the decision rather than a separate return type because every
	 * layer between the Brain and the floor already carries a `RouteDecision`, and
	 * a second parallel shape would need the same grammar, the same validation and
	 * the same event. The invariant that makes it safe is one line of code:
	 * {@link isClarification} is checked before dispatch, never after.
	 */
	clarify?: string;
}

/**
 * True when the decision is a question rather than an instruction.
 *
 * The one guard between a low-confidence guess and a spoken instruction landing
 * in the wrong repository. Anything that dispatches must check it first.
 */
export function isClarification(decision: RouteDecision): boolean {
	return typeof decision.clarify === 'string' && decision.clarify.trim().length > 0;
}

/** True when the decision targets the conductor rather than a specific agent. */
export function isConductorTarget(target: RouteTarget): target is 'conductor' {
	return target === 'conductor';
}

/** The agent id a decision targets, or null for the conductor. */
export function routeTargetSessionId(target: RouteTarget): string | null {
	return isConductorTarget(target) ? null : target.sessionId;
}

/**
 * JSON Schema (draft-07 subset) for `RouteDecision`, kept deliberately plain so
 * it survives compilation to a GBNF grammar: no `$ref`, no conditionals, and a
 * closed `oneOf` for the target. Keep this in sync with the type above; the
 * shape is small enough that duplication is cheaper than a code generator.
 */
export const ROUTE_DECISION_JSON_SCHEMA = {
	$schema: 'http://json-schema.org/draft-07/schema#',
	title: 'RouteDecision',
	type: 'object',
	properties: {
		target: {
			oneOf: [
				{ type: 'string', const: 'conductor' },
				{
					type: 'object',
					properties: { sessionId: { type: 'string' } },
					required: ['sessionId'],
					additionalProperties: false,
				},
			],
		},
		tabAction: { type: 'string', enum: ROUTE_TAB_ACTIONS },
		tabId: { type: 'string' },
		tabName: { type: 'string' },
		prompt: { type: 'string' },
		confidence: { type: 'number', minimum: 0, maximum: 1 },
		clarify: { type: 'string' },
	},
	required: ['target', 'tabAction', 'prompt', 'confidence'],
	additionalProperties: false,
} as const;
