/**
 * System One: typed questions about a state, answered with typed judgments.
 *
 * System One does not write text. A caller hands it a STATE (text or JSON) and
 * typed QUESTIONS keyed by an id of its choosing, and gets one typed answer per
 * id:
 *
 *   - `noul`   - a yes or no question, answered with P(yes).
 *   - `choice` - one option from a named set.
 *   - `score`  - a position on a rubric of 2 to 10 described levels.
 *
 * Three engines answer the same questions. Two speak the Jev HTTP API (TypeSafe's
 * hosted Jev, and a user-run OpenJev at a URL) and return calibrated
 * probabilities. The third, the local judge, asks a text model the same
 * questions through a JSON schema; its numbers are NOT calibrated, and every
 * surface that shows an answer says which engine gave it.
 *
 * This module is the vocabulary all of them share: the question and answer
 * types, the builders, the checks that run before a request leaves, the
 * redaction every outgoing request goes through, and the token and cost
 * arithmetic. It is pure and bundle-safe. The HTTP client is
 * `src/main/local-models/system-one/jev-client.ts`.
 *
 * The question types are also the WIRE shapes of the Jev API, on purpose: one
 * shape, no translation layer to drift.
 */

import { redactSecrets } from '../redactSecrets';

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/** Every engine that can answer a System One question. */
export const SYSTEM_ONE_ENGINE_IDS = ['jev-cloud', 'openjev', 'local-judge'] as const;

export type SystemOneEngineId = (typeof SYSTEM_ONE_ENGINE_IDS)[number];

/** The engines reached over the Jev HTTP API. */
export type SystemOneRemoteEngineId = Exclude<SystemOneEngineId, 'local-judge'>;

export function isSystemOneEngineId(value: unknown): value is SystemOneEngineId {
	return (SYSTEM_ONE_ENGINE_IDS as readonly unknown[]).includes(value);
}

/** TypeSafe's hosted API. The `jev` CLI overrides it with `TYPESAFE_BASE_URL`. */
export const JEV_CLOUD_BASE_URL = 'https://api.typesafe.ai';

/**
 * The alias the hosted API resolves to its newest release. It MOVES: automation
 * whose thresholds were tuned against one version pins the versioned id instead.
 */
export const JEV_DEFAULT_MODEL = 'jev-latest';

/** Default request budget. A healthy Jev answers in about 250 ms. */
export const SYSTEM_ONE_DEFAULT_TIMEOUT_MS = 1_500;

/**
 * The local judge's budget when its caller states none. Far longer than Jev's:
 * the first question after an idle spell pays for loading the model, which
 * takes seconds, and a budget sized for a warm model would fail that one every
 * time.
 */
export const LOCAL_JUDGE_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A remote engine, resolved and ready to call. The key is handed in for the
 * call and never stored on a record; `openjev` may have none.
 */
export interface SystemOneRemoteEngine {
	id: SystemOneRemoteEngineId;
	/** No trailing slash. `/v1/systemone` is appended to it. */
	baseUrl: string;
	apiKey?: string;
}

/** The hosted engine with its key. `baseUrl` is for the `TYPESAFE_BASE_URL` override. */
export function jevCloudEngine(
	apiKey: string | undefined,
	baseUrl: string = JEV_CLOUD_BASE_URL
): SystemOneRemoteEngine {
	return { id: 'jev-cloud', baseUrl, ...(apiKey ? { apiKey } : {}) };
}

/** `host[:port]` of a base URL, or `null` when it is not a URL. */
export function systemOneEngineHost(baseUrl: string): string | null {
	try {
		return new URL(baseUrl).host || null;
	} catch {
		return null;
	}
}

/**
 * What an engine is called, everywhere a person reads it: the picker, the
 * ledger, the CLI, and every error message. The local judge's label carries
 * "not calibrated" so it can never be read as Jev.
 */
export function systemOneEngineLabel(
	id: SystemOneEngineId,
	detail: { host?: string | null; model?: string | null } = {}
): string {
	if (id === 'jev-cloud') return 'Jev (TypeSafe cloud)';
	if (id === 'openjev') return detail.host ? `OpenJev at ${detail.host}` : 'OpenJev';
	return detail.model
		? `Local judge (${detail.model}), not calibrated`
		: 'Local judge, not calibrated';
}

/** True when the engine's probabilities are trained to be calibrated. */
export function isSystemOneEngineCalibrated(id: SystemOneEngineId): boolean {
	return id !== 'local-judge';
}

// ---------------------------------------------------------------------------
// State and questions
// ---------------------------------------------------------------------------

export type SystemOneJson =
	| string
	| number
	| boolean
	| null
	| SystemOneJson[]
	| { [key: string]: SystemOneJson };

/**
 * What is judged. A string, or JSON with named fields a question points at with
 * a backticked path (`ticket.messages[0].text`). Never index into a long array:
 * key each item, or put the item inside its own question.
 */
export type SystemOneState = string | SystemOneJson[] | { [key: string]: SystemOneJson };

/**
 * Instructions and criteria entries are strings, or JSON when two options keep
 * being confused and need structure (`{ what, not_for, examples }`).
 */
export type SystemOneText = string | SystemOneJson[] | { [key: string]: SystemOneJson };

export interface SystemOneNoulQuestion {
	type: 'noul';
	instructions: SystemOneText;
	/** What yes and no mean, when the boundary is subtle. */
	criteria?: { true?: SystemOneText; false?: SystemOneText };
}

export interface SystemOneChoiceQuestion {
	type: 'choice';
	instructions: SystemOneText;
	/** Option id to its description. `null` is an option that needs none. */
	criteria: Record<string, SystemOneText | null>;
}

export interface SystemOneScoreQuestion {
	type: 'score';
	instructions: SystemOneText;
	/** Ordered levels, low to high. Level N is its index. */
	criteria: SystemOneText[];
}

export type SystemOneQuestion =
	| SystemOneNoulQuestion
	| SystemOneChoiceQuestion
	| SystemOneScoreQuestion;

export type SystemOneQuestionType = SystemOneQuestion['type'];

/** Questions keyed by an id the caller chooses. The id is not sent to the model. */
export type SystemOneQuestions = Record<string, SystemOneQuestion>;

/**
 * One request: the state judged and the typed questions about it. What a task
 * that runs on System One builds from its own input
 * (`LocalModelTaskDefinition.systemOneQuestions`).
 */
export interface SystemOneTaskRequest {
	state: SystemOneState;
	questions: SystemOneQuestions;
}

export const SYSTEM_ONE_MAX_CHOICE_OPTIONS = 255;
export const SYSTEM_ONE_MIN_SCORE_LEVELS = 2;
export const SYSTEM_ONE_MAX_SCORE_LEVELS = 10;

/** A yes or no question. Phrase it so a high answer means yes. */
export function noul(
	instructions: SystemOneText,
	criteria?: { true?: SystemOneText; false?: SystemOneText }
): SystemOneNoulQuestion {
	const stated =
		criteria && (criteria.true !== undefined || criteria.false !== undefined)
			? {
					...(criteria.true !== undefined ? { true: criteria.true } : {}),
					...(criteria.false !== undefined ? { false: criteria.false } : {}),
				}
			: null;
	return { type: 'noul', instructions, ...(stated ? { criteria: stated } : {}) };
}

/**
 * Pick one option. Give a map of option id to description so each option is
 * distinct from its neighbor; a bare list of ids is accepted for options that
 * explain themselves.
 */
export function choice(
	instructions: SystemOneText,
	options: readonly string[] | Record<string, SystemOneText | null>
): SystemOneChoiceQuestion {
	const criteria: Record<string, SystemOneText | null> = {};
	if (isReadonlyArray(options)) {
		for (const option of options) criteria[option] = null;
	} else {
		Object.assign(criteria, options);
	}
	return { type: 'choice', instructions, criteria };
}

/** Rate on an ordered rubric. Each level describes a situation, low to high. */
export function score(
	instructions: SystemOneText,
	levels: readonly SystemOneText[]
): SystemOneScoreQuestion {
	return { type: 'score', instructions, criteria: [...levels] };
}

/** Why a state cannot be judged, or `null` when it can. */
export function systemOneStateProblem(state: unknown): string | null {
	if (typeof state === 'string') return state.trim() === '' ? 'The state is empty.' : null;
	if (Array.isArray(state)) return state.length === 0 ? 'The state is empty.' : null;
	if (isPlainObject(state)) return Object.keys(state).length === 0 ? 'The state is empty.' : null;
	return 'The state must be text, a JSON object or a JSON array.';
}

/**
 * Why a set of questions cannot be asked, or `null` when it can. The first
 * problem found is reported, naming the question id, in the words a person who
 * typed the question on the CLI can act on.
 */
export function systemOneQuestionsProblem(questions: unknown): string | null {
	if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
		return 'Give at least one question, as a map of id to question.';
	}
	for (const [id, question] of Object.entries(questions)) {
		const problem = questionProblem(id, question);
		if (problem) return problem;
	}
	return null;
}

function questionProblem(id: string, question: unknown): string | null {
	if (!isPlainObject(question)) return `Question "${id}" must be an object with a type.`;
	const { type, instructions, criteria } = question;
	if (type !== 'noul' && type !== 'choice' && type !== 'score') {
		return `Question "${id}" has type ${JSON.stringify(type)}; it must be noul, choice or score.`;
	}
	if (!isSystemOneText(instructions)) return `Question "${id}" has no instructions.`;

	if (type === 'noul') {
		if (criteria === undefined) return null;
		if (
			!isPlainObject(criteria) ||
			Object.keys(criteria).some((k) => k !== 'true' && k !== 'false')
		) {
			return `Noul "${id}": criteria may only have "true" and "false".`;
		}
		return null;
	}
	if (type === 'choice') {
		if (!isPlainObject(criteria) || Object.keys(criteria).length < 2) {
			return `Choice "${id}" needs at least 2 options.`;
		}
		if (Object.keys(criteria).length > SYSTEM_ONE_MAX_CHOICE_OPTIONS) {
			return `Choice "${id}" has more than ${SYSTEM_ONE_MAX_CHOICE_OPTIONS} options.`;
		}
		return null;
	}
	if (
		!Array.isArray(criteria) ||
		criteria.length < SYSTEM_ONE_MIN_SCORE_LEVELS ||
		criteria.length > SYSTEM_ONE_MAX_SCORE_LEVELS
	) {
		return `Score "${id}" needs ${SYSTEM_ONE_MIN_SCORE_LEVELS} to ${SYSTEM_ONE_MAX_SCORE_LEVELS} levels, low to high.`;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface SystemOneNoulAnswer {
	type: 'noul';
	/** P(yes), 0 to 1. 0.5 is undecided, not "medium". */
	probability: number;
}

export interface SystemOneChoiceAnswer {
	type: 'choice';
	/** The chosen option id. */
	choice: string;
	/**
	 * Probability per option id, and how peaked that distribution is. Present
	 * from an engine that reports a distribution (Jev, OpenJev); absent from the
	 * local judge, which names one option and no more.
	 */
	probabilities?: Record<string, number>;
	confidence?: number;
}

export interface SystemOneScoreAnswer {
	type: 'score';
	/** A position from 0 to levels - 1. From Jev it can fall between two levels. */
	score: number;
	/** Probability per level, indexed by level. Absent from the local judge. */
	probabilities?: number[];
	confidence?: number;
}

export type SystemOneAnswer = SystemOneNoulAnswer | SystemOneChoiceAnswer | SystemOneScoreAnswer;

/** One answer per question id. */
export type SystemOneAnswers = Record<string, SystemOneAnswer>;

export interface SystemOneUsage {
	inputTokens: number;
	outputTokens: number;
}

/** One answered request. */
export interface SystemOneResult {
	engine: SystemOneEngineId;
	/**
	 * The model the engine says answered (`jev-1.13.0` for the alias
	 * `jev-latest`). From the local judge it is the source's spelling,
	 * `local:<model id>` or `endpoint:<endpoint id>:<model>`, which
	 * `parseLocalModelAssignmentSpec` reads back.
	 */
	model: string;
	answers: SystemOneAnswers;
	/** What the engine counted. Zeros when it reports no usage. */
	usage: SystemOneUsage;
	/** {@link systemOneCostUsd} of the reported input tokens. */
	costUsd: number;
	/** Round trip, from send to parsed answer. */
	latencyMs: number;
	/** False for the local judge. A consumer must not act on its numbers as if they were Jev's. */
	calibrated: boolean;
	/** True when a secret-shaped span was removed from the request before it was sent. */
	redacted: boolean;
	/** The engine's own id for the request, when it sends one. */
	requestId?: string;
}

/** A model a remote engine lists. */
export interface SystemOneModel {
	name: string;
	releaseDate?: string;
	description?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Why a System One request has no answer.
 *
 *   - `auth`         - no key for an engine that needs one (nothing was sent),
 *                      or the engine answered 401 or 403.
 *   - `rate-limited` - the engine answered 429.
 *   - `too-large`    - the state and its longest question exceed the request
 *                      budget (`400 max_tokens_exceeded`, or 413).
 *   - `unavailable`  - the engine could not be used: not configured, not
 *                      reachable, overloaded (5xx, 529), not serving this API
 *                      (404), or it answered with something unreadable.
 *   - `timeout`      - no complete answer inside the request budget.
 *   - `invalid`      - the request itself is wrong (an empty state, a malformed
 *                      question, a 400 or 422). Sending it again cannot help.
 *   - `cancelled`    - the caller aborted. Not a fault; never shown as one.
 *
 * A task that gets any of these applies its own fail policy. It never asks a
 * different engine instead.
 */
export const SYSTEM_ONE_ERROR_CODES = [
	'auth',
	'rate-limited',
	'too-large',
	'unavailable',
	'timeout',
	'invalid',
	'cancelled',
] as const;

export type SystemOneErrorCode = (typeof SYSTEM_ONE_ERROR_CODES)[number];

/**
 * What a task does when its engine gives no answer (any `SystemOneErrorCode`
 * but `cancelled`).
 *
 *   - `open`   - the work goes ahead, unchecked.
 *   - `closed` - the work stops.
 *
 * A task that gates something declares its default
 * (`LocalModelTaskDefinition.failPolicy`): the Cue gate fails open, because a
 * model that is down must not silently stop automation the user depends on, and
 * the prompt-injection screen fails closed, because it exists to keep unscreened
 * text out of a run. The user can change either per task; see
 * `resolveSystemOneFailPolicy` in `system-one-settings.ts`.
 */
export const SYSTEM_ONE_FAIL_POLICIES = ['open', 'closed'] as const;

export type SystemOneFailPolicy = (typeof SYSTEM_ONE_FAIL_POLICIES)[number];

export function isSystemOneFailPolicy(value: unknown): value is SystemOneFailPolicy {
	return (SYSTEM_ONE_FAIL_POLICIES as readonly unknown[]).includes(value);
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export interface RedactedSystemOneRequest<S extends SystemOneState = SystemOneState> {
	state: S;
	questions: SystemOneQuestions;
	/** True when at least one span was replaced. */
	redacted: boolean;
}

/**
 * The request with every secret-shaped span replaced, through `redactSecrets`.
 *
 * Every string VALUE is covered, in the state and in the questions: a question
 * can carry the item it judges, so the state alone is not enough. Object keys
 * are left alone, because a choice's option ids are keys and an answer names
 * one of them.
 */
export function redactSystemOneRequest<S extends SystemOneState>(
	state: S,
	questions: SystemOneQuestions
): RedactedSystemOneRequest<S> {
	const seen = { redacted: false };
	const cleanState = redactJson(state, seen) as S;
	const cleanQuestions: SystemOneQuestions = {};
	for (const [id, question] of Object.entries(questions)) {
		cleanQuestions[id] = redactJson(
			question as unknown as SystemOneJson,
			seen
		) as unknown as SystemOneQuestion;
	}
	return { state: cleanState, questions: cleanQuestions, redacted: seen.redacted };
}

function redactJson(value: SystemOneJson, seen: { redacted: boolean }): SystemOneJson {
	if (typeof value === 'string') {
		const result = redactSecrets(value);
		if (result.redacted) seen.redacted = true;
		return result.text;
	}
	if (Array.isArray(value)) return value.map((entry) => redactJson(entry, seen));
	if (value !== null && typeof value === 'object') {
		const out: { [key: string]: SystemOneJson } = {};
		for (const [key, entry] of Object.entries(value)) out[key] = redactJson(entry, seen);
		return out;
	}
	return value;
}

// ---------------------------------------------------------------------------
// Tokens and cost
// ---------------------------------------------------------------------------

/**
 * Characters per token for Jev, MEASURED on English (107,500 characters went
 * through as 32,388 tokens). Not the generic 4 of `estimateTokenCount`: against
 * a hard request budget, the generic figure says a request fits when it does not.
 */
export const JEV_CHARS_PER_TOKEN = 3.32;

/** List price of the hosted Jev, USD per million input tokens. Output tokens are free. */
export const JEV_PRICE_PER_MTOK_INPUT_USD = 0.042;

/** Jev's per-request budget: everything sent, and the state with its longest question. */
export const JEV_MAX_REQUEST_TOKENS = 64_000;
export const JEV_MAX_STATE_AND_QUESTION_TOKENS = 32_388;

/**
 * What a request's input tokens cost. Only the hosted Jev has a price: an
 * OpenJev server and the local judge run on hardware the user already pays for.
 */
export function systemOneCostUsd(engine: SystemOneEngineId, inputTokens: number): number {
	if (engine !== 'jev-cloud' || !(inputTokens > 0)) return 0;
	return (inputTokens / 1_000_000) * JEV_PRICE_PER_MTOK_INPUT_USD;
}

export interface SystemOneRequestEstimate {
	stateTokens: number;
	/** All the questions together. */
	questionTokens: number;
	largestQuestionTokens: number;
	/** State plus every question: what the engine bills. */
	inputTokens: number;
	/**
	 * False when the estimate is over Jev's request budget. An estimate, not a
	 * verdict: the engine has the last word (`too-large`).
	 */
	fits: boolean;
	costUsd: number;
}

/** Estimate a request's tokens and cost before it is sent. */
export function estimateSystemOneRequest(
	engine: SystemOneEngineId,
	state: SystemOneState,
	questions: SystemOneQuestions
): SystemOneRequestEstimate {
	const stateTokens = estimateSystemOneTokens(state);
	const perQuestion = Object.values(questions).map((question) =>
		estimateSystemOneTokens(question as unknown as SystemOneJson)
	);
	const questionTokens = perQuestion.reduce((sum, tokens) => sum + tokens, 0);
	const largestQuestionTokens = perQuestion.reduce((max, tokens) => Math.max(max, tokens), 0);
	const inputTokens = stateTokens + questionTokens;
	return {
		stateTokens,
		questionTokens,
		largestQuestionTokens,
		inputTokens,
		fits:
			inputTokens <= JEV_MAX_REQUEST_TOKENS &&
			stateTokens + largestQuestionTokens <= JEV_MAX_STATE_AND_QUESTION_TOKENS,
		costUsd: systemOneCostUsd(engine, inputTokens),
	};
}

/**
 * The tokens one value (a state, a question) is estimated to cost, at Jev's
 * measured rate. What a caller that packs several questions into a request
 * sizes each of them with.
 */
export function estimateSystemOneTokens(value: SystemOneJson): number {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text ? Math.ceil(text.length / JEV_CHARS_PER_TOKEN) : 0;
}

/** How deep a state or a question may nest. Far past any real request; it stops a hostile one. */
export const SYSTEM_ONE_MAX_JSON_DEPTH = 64;

/**
 * True for a value JSON can carry as it is: text, a finite number, a boolean,
 * null, and arrays and plain objects of those. A request from the CLI bridge
 * has already been through JSON; one from inside the process has not, and a
 * `Date` or a `Map` there must be refused, not sent as `{}`.
 */
export function isSystemOneJson(value: unknown, depth = 0): value is SystemOneJson {
	if (depth > SYSTEM_ONE_MAX_JSON_DEPTH) return false;
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((entry) => isSystemOneJson(entry, depth + 1));
	if (typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.values(value).every((entry) => isSystemOneJson(entry, depth + 1));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// `Array.isArray` does not narrow a `readonly T[] | Record` union.
function isReadonlyArray(value: unknown): value is readonly string[] {
	return Array.isArray(value);
}

/** True for instructions or a criteria entry that says something: text that is not blank, or JSON. */
export function isSystemOneText(value: unknown): value is SystemOneText {
	if (typeof value === 'string') return value.trim() !== '';
	return Array.isArray(value) ? value.length > 0 : isPlainObject(value);
}
