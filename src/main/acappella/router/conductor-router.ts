/**
 * The Conductor router: the decision layer between a transcript and a dispatch.
 *
 * It is a DECORATOR over whichever Brain the registry resolved, not a fourth
 * Brain. The wrapped provider still does the inference - locally under a GBNF
 * grammar, or hosted under a structured-output schema - and this file owns the
 * four things that must behave identically whichever one is running:
 *
 *   1. **The context.** One assembler builds it, bounded and cached, and the
 *      recall shortlist is computed here rather than by asking a 1.7B model to
 *      read sixty tab summaries.
 *   2. **Validation.** Every decision is checked against the roster it will run
 *      on, whatever produced it. A grammar guarantees a well-formed id; only the
 *      roster knows whether it is a real one, and the user can close a tab while
 *      the model is thinking.
 *   3. **Recovery.** A rejected decision gets ONE constrained retry with the
 *      errors fed back. A second failure does not become a guess: it becomes a
 *      spoken question.
 *   4. **Honesty about confidence.** Below the threshold the router asks rather
 *      than dispatches. Sending someone's spoken instruction to the wrong
 *      repository is worse than taking two seconds to ask which one they meant.
 *
 * The decorator keeps the wrapped provider's id, label and tier, so the
 * `provider-state` event still names the engine that is really running. A router
 * that renamed itself in the HUD would be the silent-substitution failure this
 * subsystem is built to prevent, wearing a different hat.
 */

import type { RosterAgent } from '../../../shared/acappella/protocol';
import type {
	BrainProvider,
	VoiceConverseContext,
	VoiceRouteContext,
} from '../../../shared/acappella/providers';
import type { RouteDecision } from '../../../shared/acappella/route-decision';
import { isClarification, routeTargetSessionId } from '../../../shared/acappella/route-decision';
import { generateUUID } from '../../../shared/uuid';
import { logger } from '../../utils/logger';
import { validateRouteDecision } from './grammar';
import { getRoutingContext, type RoutingContext } from './routing-context';
import { recordRoutingTurn } from './routing-log';
import {
	narrowRosterForRecall,
	rankRecallCandidates,
	resolveRecall,
	type RecallCandidate,
} from './tab-recall';

const LOG_CONTEXT = 'ACappella';

/**
 * Below this, ask instead of dispatching.
 *
 * 0.55 rather than 0.5 because the models routing here are calibrated loosely
 * and a bare majority is not a belief. It is the one number worth tuning against
 * the routing log's hit rate, which is why the log records confidence per turn.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.55;

export interface ConductorRouterOptions {
	/** The resolved Brain. Its inference, this file's rules. */
	brain: BrainProvider;
	confidenceThreshold?: number;
	/** Injected in tests; production reads the cached assembler. */
	loadContext?: (recentUtterances: string[]) => Promise<RoutingContext>;
	/** Injected in tests so the log is not a file. */
	record?: typeof recordRoutingTurn;
	now?: () => number;
}

/** The router, plus the read-only bits the HUD and the log need. */
export interface ConductorRouter extends BrainProvider {
	/** Routing-log id of the most recent turn, or null before the first one. */
	lastTurnId(): string | null;
}

export function createConductorRouter(options: ConductorRouterOptions): ConductorRouter {
	const brain = options.brain;
	const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
	const loadContext = options.loadContext ?? ((recent) => getRoutingContext(recent));
	const record = options.record ?? recordRoutingTurn;
	const now = options.now ?? (() => Date.now());

	let lastTurnId: string | null = null;

	return {
		id: brain.id,
		label: brain.label,
		tier: brain.tier,
		lastTurnId: () => lastTurnId,

		async route(input: string, context: VoiceRouteContext): Promise<RouteDecision> {
			const startedAt = now();
			const enriched = await enrichContext(input, context, loadContext);
			const roster = enriched.context.roster;

			let retries = 0;
			let decision = await brain.route(input, enriched.context);
			let validation = validateRouteDecision(decision, roster);

			if (!validation.ok) {
				// One retry, with the reasons. A rejected decision is recoverable
				// information, not a dead turn: the model usually fixes an id it
				// invented when it is told which ids exist.
				retries = 1;
				logger.warn(`Route decision rejected: ${validation.errors.join('; ')}`, LOG_CONTEXT);
				decision = await brain.route(input, {
					...enriched.context,
					retryNotes: validation.errors,
				});
				validation = validateRouteDecision(decision, roster);
			}

			if (!validation.ok) {
				// Twice rejected. The conductor takes it and asks, which is the only
				// outcome that is neither a guess nor silence.
				logger.warn(`Route decision rejected twice: ${validation.errors.join('; ')}`, LOG_CONTEXT);
				decision = fallbackClarification(input, roster, enriched.candidates);
			} else {
				decision = applyRecallPolicy(decision, roster, context);
				decision = applyConfidencePolicy(decision, roster, enriched.candidates, threshold);
			}

			lastTurnId = record({
				id: generateUUID(),
				utterance: input,
				decision,
				brainProviderId: brain.id,
				latencyMs: now() - startedAt,
				contextChars: enriched.contextChars,
				droppedTabs: enriched.droppedTabs,
				retries,
			});

			return decision;
		},

		converse(agentText: string, context: VoiceConverseContext): Promise<string> {
			// Nothing to add: reshaping an answer for the ear is the Brain's own job
			// and has no roster, no ids, and nothing to validate.
			return brain.converse(agentText, context);
		},
	};
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface EnrichedContext {
	context: VoiceRouteContext;
	candidates: RecallCandidate[];
	contextChars: number;
	droppedTabs: number;
}

/**
 * Replace the caller's roster with the assembled one and shortlist the recall
 * candidates.
 *
 * The assembler is authoritative because it is the only thing that knows about
 * snoozed and closed tabs, carries the per-tab topics, and enforces the size
 * cap. When it cannot be built - no store in a test, a store read that threw -
 * the caller's roster is used unchanged rather than failing the turn: routing on
 * a thinner context is a worse decision, and routing on nothing is no decision.
 */
async function enrichContext(
	input: string,
	context: VoiceRouteContext,
	loadContext: (recentUtterances: string[]) => Promise<RoutingContext>
): Promise<EnrichedContext> {
	let assembled: RoutingContext | null = null;
	try {
		assembled = await loadContext(context.recentUtterances ?? []);
	} catch (error) {
		logger.warn(`Routing context unavailable: ${(error as Error).message}`, LOG_CONTEXT);
	}

	const roster = assembled?.agents ?? context.roster;
	const activeAgentSessionId =
		context.activeAgentSessionId ?? assembled?.activeAgentSessionId ?? null;

	const candidates = rankRecallCandidates(input, roster, { activeAgentSessionId });

	return {
		context: {
			...context,
			// Only the shortlisted prior tabs, plus everything still open: a model
			// handed sixty topic lines picks the one it saw most recently.
			roster: narrowRosterForRecall(roster, candidates),
			activeAgentSessionId,
		},
		candidates,
		contextChars: assembled?.serializedChars ?? 0,
		droppedTabs: assembled?.droppedTabs ?? 0,
	};
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Turn a recall of a closed tab into an offer.
 *
 * The executor knows how to wake a snoozed tab and how to reopen a closed one,
 * but reopening is the user's call: the alternative the router must never take
 * is quietly opening a fresh tab, because the reply then has no memory of the
 * conversation the user asked to return to and they find that out by reading it.
 */
function applyRecallPolicy(
	decision: RouteDecision,
	roster: readonly RosterAgent[],
	context: VoiceRouteContext
): RouteDecision {
	if (decision.tabAction !== 'recall' || isClarification(decision)) return decision;

	const resolution = resolveRecall(decision, roster, {
		// The user has already been asked once and this utterance is their answer.
		confirmed: Boolean(context.clarification),
	});

	if (resolution.kind === 'offer') {
		return { ...decision, clarify: resolution.question };
	}
	return decision;
}

/**
 * Ask rather than guess when the decision is not confident enough to act on.
 *
 * The question names the alternatives, because "which agent?" makes the user
 * repeat their whole sentence while "the backend agent or the API agent?" is
 * answered in two words.
 */
function applyConfidencePolicy(
	decision: RouteDecision,
	roster: readonly RosterAgent[],
	candidates: readonly RecallCandidate[],
	threshold: number
): RouteDecision {
	if (isClarification(decision) || decision.confidence >= threshold) return decision;

	const question = buildDisambiguation(decision, roster, candidates);
	if (!question) return decision;
	return { ...decision, clarify: question };
}

/**
 * One spoken line offering the two most plausible targets.
 *
 * Returns null when there is nothing to disambiguate between - a single agent,
 * or a conductor-targeted utterance - because asking "the backend agent?" of
 * someone who only has one agent is worse than a low-confidence dispatch.
 */
function buildDisambiguation(
	decision: RouteDecision,
	roster: readonly RosterAgent[],
	candidates: readonly RecallCandidate[]
): string | null {
	if (roster.length < 2) return null;

	if (decision.tabAction === 'recall' && candidates.length >= 2) {
		const [first, second] = candidates;
		return `${tabLabel(first)} or ${tabLabel(second)}?`;
	}

	// The agent the model leaned toward comes first so the likely answer is the
	// first thing the user hears. With no such agent - a conductor target, or an
	// id that was rejected - the two most plausible are simply the first two.
	const targetId = routeTargetSessionId(decision.target);
	const chosen = roster.find((agent) => agent.sessionId === targetId) ?? roster[0];
	const other = roster.find((agent) => agent.sessionId !== chosen.sessionId);
	if (!other) return null;

	return `${chosen.name} or ${other.name}?`;
}

// ---------------------------------------------------------------------------
// Correction
// ---------------------------------------------------------------------------

/**
 * Phrases that mean "that went to the wrong place", rather than being a request.
 *
 * Matched on the WHOLE utterance, not as a substring: "no, not that one" is a
 * correction and "no, not that one, use the other endpoint" is a sentence about
 * endpoints. A correction is a short interjection by nature, so requiring the
 * whole utterance to be one is both the accurate rule and the safe one - a false
 * positive silently moves a prompt the user never asked to move.
 */
const CORRECTION_PHRASES = [
	'no the other one',
	'no not that one',
	'not that one',
	'the other one',
	'wrong tab',
	'wrong agent',
	'wrong one',
];

/** True when the utterance is a correction of the last dispatch and nothing else. */
export function isCorrectionUtterance(text: string): boolean {
	const normalized = text
		.toLowerCase()
		.replace(/[^a-z ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return CORRECTION_PHRASES.includes(normalized);
}

/** What a correction should do, once one has been recognised. */
export type CorrectionPlan =
	| { kind: 'move'; agentSessionId: string }
	| { kind: 'ask'; question: string };

/**
 * Where a correction moves the prompt.
 *
 * With exactly one alternative there is nothing to ask about. With several,
 * asking is the only honest move: "the other one" does not name anything, and
 * guessing a second time after guessing wrong the first time is how a user
 * decides the feature does not work.
 */
export function planCorrection(
	roster: readonly RosterAgent[],
	fromAgentSessionId: string
): CorrectionPlan {
	const alternatives = roster.filter((agent) => agent.sessionId !== fromAgentSessionId);
	if (alternatives.length === 1) {
		return { kind: 'move', agentSessionId: alternatives[0].sessionId };
	}
	if (alternatives.length === 0) {
		return { kind: 'ask', question: 'There is nowhere else to send that.' };
	}
	return {
		kind: 'ask',
		question: `${alternatives
			.slice(0, 3)
			.map((agent) => agent.name)
			.join(', or ')}?`,
	};
}

function tabLabel(candidate: RecallCandidate): string {
	return candidate.tab.name ?? candidate.tab.topic ?? `the tab on ${candidate.agentName}`;
}

/**
 * The decision of last resort: a question, targeted at the conductor.
 *
 * Reached only when the model produced something unusable twice. It carries the
 * user's own words as the prompt so that, if they answer, the request is intact.
 */
function fallbackClarification(
	input: string,
	roster: readonly RosterAgent[],
	candidates: readonly RecallCandidate[]
): RouteDecision {
	const named = buildDisambiguation(
		{ target: 'conductor', tabAction: 'current', prompt: input, confidence: 0 },
		roster,
		candidates
	);

	return {
		target: 'conductor',
		tabAction: 'current',
		prompt: input.trim(),
		confidence: 0,
		clarify: named
			? `I did not catch which one you meant. ${named}`
			: 'Which agent should take that?',
	};
}
