/**
 * The `model-routing` task: a fast judgment of how much model a turn needs.
 *
 * `routeTurn` (`src/main/local-models/route-turn.ts`) hands the task a prompt
 * and gets back a tier and an effort, or the reason there is no decision. Three
 * kinds of router answer it, and the task's ONE assignment says which
 * ({@link modelRouterKind}):
 *
 *   - `local:<embedding model>`  - the embedding router: the prompt's nearest
 *     labeled prompts vote (`model-routing.ts`, `model-router.ts`).
 *   - `local:<text model>` or `endpoint:<id>:<model>` - a local judge: that text
 *     model answers the two `score` questions below through a JSON schema.
 *   - `system-one`               - the System One engine in force answers the
 *     same two questions.
 *
 * This module is the vocabulary all three share, pure and bundle-safe: what is
 * routed, the two typed questions, how an answer is read back as a tier and an
 * effort, what the router that decided is called, and the reasons a turn gets
 * no decision. Only Jev and OpenJev return calibrated numbers; every surface
 * that names a router says which it is.
 *
 * Import note: the task registry (`tasks.ts`) imports this module, and
 * `modelTiers.ts` reaches the registry through `run-on.ts`. So the three levels
 * come from `tierLevels.ts`, and nothing here may import `modelTiers.ts`: that
 * closes a cycle, and `modelTiers.ts` then builds its constants from values
 * that are not loaded yet.
 */

import { redactSecrets } from '../redactSecrets';
import { TIER_LEVELS, type EffortLevel, type ModelTier } from '../tierLevels';
import { getLocalModel } from './model-catalog';
import { normalizeModelRoutingText } from './model-routing';
import {
	isSystemOneEngineCalibrated,
	score,
	systemOneEngineLabel,
	type SystemOneAnswer,
	type SystemOneAnswers,
	type SystemOneEngineId,
	type SystemOneJson,
	type SystemOneTaskRequest,
} from './system-one';
import type { LocalModelAssignment } from './tasks';

/** The task's id in `LOCAL_MODEL_TASKS`. */
export const MODEL_ROUTING_TASK_ID = 'model-routing';

/**
 * How long a send may wait for a decision. Past it the turn runs at the agent's
 * default tier: a slow router must cost a decision, never a slow send.
 */
export const MODEL_ROUTING_TIMEOUT_MS = 400;

/**
 * How long a turn nobody is typing at may wait for a decision: an Auto Run
 * task, a Cue run, a `maestro-cli send`. A person at the composer feels 400 ms;
 * an unattended turn that runs for minutes does not feel five seconds, and a
 * router that is still loading its model is worth the wait there. Still a hard
 * bound: past it the turn runs at the agent's default like any other.
 */
export const MODEL_ROUTING_UNATTENDED_TIMEOUT_MS = 5_000;

/** The most of each recent message a router is shown. */
export const MODEL_ROUTING_RECENT_MAX_CHARS = 600;

// ---------------------------------------------------------------------------
// What is routed
// ---------------------------------------------------------------------------

/**
 * The last exchange before the prompt. Only so a short prompt ("do it", "yes,
 * go ahead") can be read; never the whole transcript.
 */
export interface ModelRoutingRecent {
	/** The user's previous message. */
	user?: string;
	/** The assistant's last message. */
	assistant?: string;
}

/** What a router judges: the prompt being sent and the exchange before it. */
export interface ModelRoutingInput {
	prompt: string;
	recent?: ModelRoutingRecent;
}

/** Which end of a recent message is kept when it is longer than the cap. */
type ClipEnd = 'head' | 'tail';

/**
 * One recent message as a router reads it: secrets replaced, then cut to
 * {@link MODEL_ROUTING_RECENT_MAX_CHARS}. Replaced before the cut, so a cut can
 * never leave half a secret. Empty when there is nothing to show.
 */
function clipRecentMessage(text: string | undefined, keep: ClipEnd): string {
	if (!text) return '';
	const clean = redactSecrets(text.trim()).text;
	if (clean.length <= MODEL_ROUTING_RECENT_MAX_CHARS) return clean;
	return keep === 'head'
		? `${clean.slice(0, MODEL_ROUTING_RECENT_MAX_CHARS).trimEnd()} ...`
		: `... ${clean.slice(clean.length - MODEL_ROUTING_RECENT_MAX_CHARS).trimStart()}`;
}

/**
 * The recent exchange as a router reads it, or `null` when there is none. The
 * user's message keeps its START (where a request is stated) and the
 * assistant's keeps its END (where it says what it will do next, or asks).
 */
export function clipModelRoutingRecent(
	recent: ModelRoutingRecent | undefined
): ModelRoutingRecent | null {
	const user = clipRecentMessage(recent?.user, 'head');
	const assistant = clipRecentMessage(recent?.assistant, 'tail');
	if (!user && !assistant) return null;
	return { ...(user ? { user } : {}), ...(assistant ? { assistant } : {}) };
}

// ---------------------------------------------------------------------------
// The two questions
// ---------------------------------------------------------------------------

export const MODEL_ROUTING_TIER_QUESTION_ID = 'tier';
export const MODEL_ROUTING_EFFORT_QUESTION_ID = 'effort';

/** The ids a routing decision is recorded under, in the order they are asked. */
export const MODEL_ROUTING_QUESTION_IDS: readonly string[] = Object.freeze([
	MODEL_ROUTING_TIER_QUESTION_ID,
	MODEL_ROUTING_EFFORT_QUESTION_ID,
]);

/** What each tier means, as the rubric a judge rates the prompt on. */
export const MODEL_ROUTING_TIER_DESCRIPTIONS: Readonly<Record<ModelTier, string>> = Object.freeze({
	low: 'A lookup, a rename, a one-line fix, or a question about code already in context.',
	medium: 'A change to a few files, or a bounded investigation.',
	high: 'A design decision, a multi-file refactor, a hard bug, or anything where a wrong answer is costly.',
});

/** What each effort level means: how hard the model has to think, whichever model it is. */
export const MODEL_ROUTING_EFFORT_DESCRIPTIONS: Readonly<Record<EffortLevel, string>> =
	Object.freeze({
		low: 'The answer is direct once the request is read: nothing to weigh and nothing to work out.',
		medium: 'Some reasoning: several steps to plan, or a few things to keep consistent.',
		high: 'Careful reasoning: trade-offs to weigh, a subtle cause to find, or many constraints at once.',
	});

/**
 * The task as a System One request: the prompt (and the exchange before it) is
 * the state, and tier and effort are two `score` questions over the three
 * levels. A local judge is asked exactly this too, so every router that reads
 * text is held to one rubric.
 *
 * The prompt goes through `normalizeModelRoutingText`, the same text the
 * embedding router embeds and a correction stores.
 */
export function modelRoutingSystemOneRequest(input: ModelRoutingInput): SystemOneTaskRequest {
	const state: { [key: string]: SystemOneJson } = {
		prompt: normalizeModelRoutingText(input.prompt),
	};
	const recent = clipModelRoutingRecent(input.recent);
	if (recent) state.recent = { ...recent };
	const context = recent
		? ' Judge the request itself. `recent` is the exchange before it, given only so a short request can be read.'
		: '';
	return {
		state,
		questions: {
			[MODEL_ROUTING_TIER_QUESTION_ID]: score(
				`How much model does the coding request in \`prompt\` need?${context}`,
				TIER_LEVELS.map((level) => MODEL_ROUTING_TIER_DESCRIPTIONS[level])
			),
			[MODEL_ROUTING_EFFORT_QUESTION_ID]: score(
				`How hard does a model have to think to do the request in \`prompt\` well?${context}`,
				TIER_LEVELS.map((level) => MODEL_ROUTING_EFFORT_DESCRIPTIONS[level])
			),
		},
	};
}

// ---------------------------------------------------------------------------
// A decision
// ---------------------------------------------------------------------------

/** A tier and an effort, and how sure the router was of each when it can say. */
export interface ModelRoute {
	tier: ModelTier;
	effort: EffortLevel;
	/**
	 * 0 to 1. The vote's margin from the embedding router, the peak of the
	 * distribution from Jev or OpenJev. Absent from a local judge, which names a
	 * level and no more.
	 */
	tierConfidence?: number;
	effortConfidence?: number;
}

/**
 * The level a `score` answer names, or `null` when it is not one. Jev can
 * answer between two levels; the nearer one is taken, and a position exactly
 * between two goes to the HIGHER (too much model costs money, too little costs
 * a wrong answer: the same rule the embedding router's vote uses for a tie).
 */
function levelFromAnswer(
	answer: SystemOneAnswer | undefined
): { level: ModelTier; confidence?: number } | null {
	if (answer?.type !== 'score' || !Number.isFinite(answer.score)) return null;
	const top = TIER_LEVELS.length - 1;
	if (answer.score < 0 || answer.score > top) return null;
	return {
		level: TIER_LEVELS[Math.round(answer.score)],
		...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
	};
}

/**
 * Read an engine's answers as a route. `null` when either question has no
 * usable answer: a route is both axes or nothing, and the caller treats `null`
 * as "no decision", never as a default.
 */
export function modelRouteFromSystemOne(answers: SystemOneAnswers): ModelRoute | null {
	const tier = levelFromAnswer(answers[MODEL_ROUTING_TIER_QUESTION_ID]);
	const effort = levelFromAnswer(answers[MODEL_ROUTING_EFFORT_QUESTION_ID]);
	if (!tier || !effort) return null;
	return {
		tier: tier.level,
		effort: effort.level,
		...(tier.confidence !== undefined ? { tierConfidence: tier.confidence } : {}),
		...(effort.confidence !== undefined ? { effortConfidence: effort.confidence } : {}),
	};
}

/**
 * A route as the typed answers the decision ledger keeps, so a decision made by
 * the embedding router or a local judge reads the same as one an engine made.
 * The inverse of {@link modelRouteFromSystemOne}.
 */
export function modelRouteAnswers(route: ModelRoute): SystemOneAnswers {
	const answer = (level: ModelTier, confidence: number | undefined): SystemOneAnswer => ({
		type: 'score',
		score: TIER_LEVELS.indexOf(level),
		...(confidence !== undefined ? { confidence } : {}),
	});
	return {
		[MODEL_ROUTING_TIER_QUESTION_ID]: answer(route.tier, route.tierConfidence),
		[MODEL_ROUTING_EFFORT_QUESTION_ID]: answer(route.effort, route.effortConfidence),
	};
}

// ---------------------------------------------------------------------------
// Who decided
// ---------------------------------------------------------------------------

/** The embedding router's id wherever a router is named. It is not a System One engine. */
export const EMBEDDING_ROUTER_ENGINE_ID = 'embedding-router';

/** Everything that can make a routing decision. */
export type ModelRoutingEngineId = typeof EMBEDDING_ROUTER_ENGINE_ID | SystemOneEngineId;

/** The router that decided (or was asked), as every surface names it. */
export interface ModelRoutingEngine {
	id: ModelRoutingEngineId;
	/** "Embedding router (EmbeddingGemma 300M), not calibrated", "Jev (TypeSafe cloud)". */
	label: string;
	/** True only for Jev and OpenJev. */
	calibrated: boolean;
}

/** True when the router's numbers are trained to be calibrated: Jev and OpenJev only. */
export function isModelRoutingEngineCalibrated(id: ModelRoutingEngineId): boolean {
	return id !== EMBEDDING_ROUTER_ENGINE_ID && isSystemOneEngineCalibrated(id);
}

/**
 * What the embedding router is called. Like the local judge's label, it carries
 * "not calibrated": a vote margin is not a measured probability.
 */
export function embeddingRouterLabel(model?: string | null): string {
	return model ? `Embedding router (${model}), not calibrated` : 'Embedding router, not calibrated';
}

/** Which kind of router an assignment makes of the task. */
export type ModelRouterKind = typeof EMBEDDING_ROUTER_ENGINE_ID | 'local-judge' | 'system-one';

/**
 * The router an assignment names, or `null` for one that routes nothing (`off`).
 *
 * A catalog embedding model is the embedding router. Every other model is a
 * judge: a catalog text model, a model the build does not know (it fails as
 * itself when asked), and ANY endpoint model, because an endpoint does not
 * report a model's kind and the judge is the reading that needs none.
 */
export function modelRouterKind(assignment: LocalModelAssignment): ModelRouterKind | null {
	switch (assignment.type) {
		case 'local':
			return getLocalModel(assignment.modelId)?.kind === 'embedding'
				? EMBEDDING_ROUTER_ENGINE_ID
				: 'local-judge';
		case 'endpoint':
			return 'local-judge';
		case 'system-one':
			return 'system-one';
		default:
			return null;
	}
}

/**
 * What a source picker says beside a routing source: which router it is, and
 * whether its answer is calibrated. `systemOneEngine` is the engine in force,
 * read only for the `system-one` assignment.
 */
export function modelRouterSourceNote(
	kind: ModelRouterKind,
	systemOneEngine: SystemOneEngineId | 'off' = 'off'
): string {
	if (kind === EMBEDDING_ROUTER_ENGINE_ID) return 'embedding router, not calibrated';
	if (kind === 'local-judge') return 'local judge, not calibrated';
	return systemOneEngine !== 'off' && isSystemOneEngineCalibrated(systemOneEngine)
		? 'calibrated'
		: 'not calibrated';
}

/**
 * What a router is called, wherever one is named before it has answered: the
 * record of a decision, and the tooltip of the Auto model choice. `sourceName`
 * is the assigned model as a person reads it. System One is named as itself:
 * which engine is in force is the main process's to say, when it answers.
 */
export function modelRouterEngineLabel(kind: ModelRouterKind, sourceName?: string | null): string {
	if (kind === EMBEDDING_ROUTER_ENGINE_ID) return embeddingRouterLabel(sourceName);
	if (kind === 'local-judge') return systemOneEngineLabel(kind, { model: sourceName });
	return 'System One';
}

// ---------------------------------------------------------------------------
// The result of one routing
// ---------------------------------------------------------------------------

/**
 * Why a turn got no decision. None of them is an error for the send: the turn
 * runs at the agent's default tier.
 *
 *   - `off`         - the task is off. Nothing was asked and nothing is recorded.
 *   - `no-prompt`   - there is nothing to route (a blank prompt).
 *   - `timeout`     - the router did not answer inside the hard timeout.
 *   - `unavailable` - the assigned router could not run, or its answer was not
 *                     a tier and an effort. `detail` names it.
 *   - `cancelled`   - the caller stopped waiting.
 */
export const MODEL_ROUTING_SKIP_REASONS = [
	'off',
	'no-prompt',
	'timeout',
	'unavailable',
	'cancelled',
] as const;

export type ModelRoutingSkipReason = (typeof MODEL_ROUTING_SKIP_REASONS)[number];

/** A turn that was routed. */
export interface ModelRouteDecision extends ModelRoute {
	engine: ModelRoutingEngine;
	/** From the call to the decision, with machine sleep removed. */
	latencyMs: number;
}

/** A turn that got no decision. */
export interface ModelRouteSkipped {
	skipped: ModelRoutingSkipReason;
	/** Written for a person: what was asked and why there is no answer. */
	detail: string;
	/** The router that was asked. Absent when none was (`off`, `no-prompt`). */
	engine?: ModelRoutingEngine;
	latencyMs: number;
}

/** What `routeTurn` answers. */
export type RouteTurnResult = ModelRouteDecision | ModelRouteSkipped;

export function isModelRouteSkipped(result: RouteTurnResult): result is ModelRouteSkipped {
	return 'skipped' in result;
}

// ---------------------------------------------------------------------------
// Asking for a routing from another process
// ---------------------------------------------------------------------------

/**
 * The most a caller may ask a routing to wait. A send keeps the default (a slow
 * router costs it the decision); a dry run that only prints the answer may be
 * more patient, up to this.
 */
export const MODEL_ROUTING_MAX_TIMEOUT_MS = 30_000;

/**
 * One routing as the renderer and the CLI ask the main process for it, where
 * `routeTurn` runs. `agentId` and `tabId` are who the turn is for, kept on the
 * decision record.
 */
export interface RouteTurnRequest extends ModelRoutingInput {
	agentId?: string;
	tabId?: string;
	/** How long to wait, in ms. Defaults to {@link MODEL_ROUTING_TIMEOUT_MS}. */
	timeoutMs?: number;
}

export type RouteTurnRequestParse =
	| { ok: true; request: RouteTurnRequest }
	| { ok: false; error: string };

function optionalText(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Read a routing request that crossed a process boundary. Only the shape is
 * checked: the texts are redacted and cut where they are used
 * (`normalizeModelRoutingText`, `clipModelRoutingRecent`), in that order, so
 * nothing here may cut them first. A blank prompt is not refused; `routeTurn`
 * answers it with `no-prompt`.
 */
export function parseRouteTurnRequest(value: unknown): RouteTurnRequestParse {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { ok: false, error: 'A routing request is an object with a prompt.' };
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.prompt !== 'string') {
		return { ok: false, error: "A routing request's prompt is text." };
	}
	const request: RouteTurnRequest = { prompt: raw.prompt };

	if (raw.recent !== undefined && raw.recent !== null) {
		if (typeof raw.recent !== 'object' || Array.isArray(raw.recent)) {
			return {
				ok: false,
				error:
					"A routing request's recent exchange is an object with a user and an assistant message.",
			};
		}
		const recent = raw.recent as Record<string, unknown>;
		const user = optionalText(recent.user);
		const assistant = optionalText(recent.assistant);
		if (user || assistant) {
			request.recent = { ...(user ? { user } : {}), ...(assistant ? { assistant } : {}) };
		}
	}

	const agentId = optionalText(raw.agentId);
	if (agentId) request.agentId = agentId;
	const tabId = optionalText(raw.tabId);
	if (tabId) request.tabId = tabId;

	if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
		if (
			typeof raw.timeoutMs !== 'number' ||
			!Number.isFinite(raw.timeoutMs) ||
			raw.timeoutMs <= 0
		) {
			return {
				ok: false,
				error: "A routing request's timeout is a number of milliseconds above 0.",
			};
		}
		request.timeoutMs = Math.min(Math.round(raw.timeoutMs), MODEL_ROUTING_MAX_TIMEOUT_MS);
	}
	return { ok: true, request };
}
