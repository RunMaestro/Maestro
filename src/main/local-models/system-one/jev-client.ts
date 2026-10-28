/**
 * The client for the Jev HTTP API: TypeSafe's hosted Jev, and a user-run
 * OpenJev that serves the same routes.
 *
 *   POST {baseUrl}/v1/systemone   { state, model?, questions: { id: Question } }
 *                              -> { model, answers: { id: Answer }, usage }
 *   GET  {baseUrl}/v1/models   -> { models: [{ name, release_date, description }] }
 *
 * Four rules hold for every caller, so no caller has to remember them:
 *
 *   1. **Redacted before it leaves.** The state and the questions go through
 *      `redactSystemOneRequest` on the way out. The result says when a span was
 *      removed.
 *   2. **One attempt.** No retry and no backoff: the budget is about a second,
 *      and a task that gets no answer applies its own fail policy. (The `jev`
 *      CLI retries; it is a batch tool with a 30 s budget.)
 *   3. **The budget covers the whole answer**, body included, not only the
 *      response headers.
 *   4. **Every failure is a `SystemOneError`** that names the engine that was
 *      asked. Nothing here falls back to a different engine.
 *
 * The local judge does not come through here: it is not HTTP and it is not Jev.
 */

import { endpointBaseUrlProblem } from '../../../shared/local-models/endpoints';
import { modelsSettingsLocation } from '../../../shared/local-models/settings-location';
import {
	JEV_DEFAULT_MODEL,
	JEV_MAX_STATE_AND_QUESTION_TOKENS,
	SYSTEM_ONE_DEFAULT_TIMEOUT_MS,
	estimateSystemOneRequest,
	isSystemOneEngineCalibrated,
	redactSystemOneRequest,
	systemOneCostUsd,
	systemOneEngineHost,
	systemOneEngineLabel,
	systemOneQuestionsProblem,
	systemOneStateProblem,
	type SystemOneAnswer,
	type SystemOneAnswers,
	type SystemOneErrorCode,
	type SystemOneModel,
	type SystemOneQuestion,
	type SystemOneQuestions,
	type SystemOneRemoteEngine,
	type SystemOneResult,
	type SystemOneState,
	type SystemOneUsage,
} from '../../../shared/local-models/system-one';
import { fetchWithTimeout, isFetchTimeoutError } from '../../utils/fetchWithTimeout';
import { errorDetailFromBody } from '../endpoint-client';
import { SystemOneError } from '../errors';

// The builders live with the types, so a task definition in `src/shared` can
// declare its questions. They are re-exported here because this is where a
// main-process caller reaches for them.
export { choice, noul, score } from '../../../shared/local-models/system-one';

const SYSTEM_ONE_PATH = '/v1/systemone';
const MODELS_PATH = '/v1/models';

/** Listing is a metadata read a person waits on in Settings, not a gate on a run. */
export const SYSTEM_ONE_MODELS_TIMEOUT_MS = 5_000;

/** The header the hosted API stamps each response with. */
const REQUEST_ID_HEADER = 'x-typesafe-request-id';

/** Longest server-supplied body quoted into a message when it has no error field. */
const MAX_ERROR_BODY_CHARS = 200;

export interface SystemOneCallOptions {
	/** Request budget for the whole answer. */
	timeoutMs?: number;
	/** Caller cancellation, composed with the budget. */
	signal?: AbortSignal;
}

export interface AskSystemOneOptions extends SystemOneCallOptions {
	/**
	 * The model to ask. The hosted engine defaults to the moving alias
	 * `jev-latest`; pin a versioned id where thresholds were tuned against one.
	 * An OpenJev server is sent a model only when one is pinned, since it serves
	 * the one it was started with.
	 */
	model?: string;
}

// ---------------------------------------------------------------------------
// Public calls
// ---------------------------------------------------------------------------

/**
 * Ask a remote engine typed questions about a state.
 *
 * Resolves with one typed answer per question id, or rejects with a
 * `SystemOneError`. Identical requests can return slightly different numbers,
 * so compare an answer against a threshold, never against a stored answer.
 */
export async function askSystemOne(
	engine: SystemOneRemoteEngine,
	state: SystemOneState,
	questions: SystemOneQuestions,
	options: AskSystemOneOptions = {}
): Promise<SystemOneResult> {
	const invalid = systemOneStateProblem(state) ?? systemOneQuestionsProblem(questions);
	if (invalid) throw systemOneError(engine, 'invalid', invalid);

	const request = redactSystemOneRequest(state, questions);
	const model = options.model ?? (engine.id === 'jev-cloud' ? JEV_DEFAULT_MODEL : undefined);
	const body = {
		state: request.state,
		...(model ? { model } : {}),
		questions: request.questions,
	};

	const started = performance.now();
	const { payload, response } = await requestJson(engine, 'POST', SYSTEM_ONE_PATH, body, {
		...options,
		timeoutMs: options.timeoutMs ?? SYSTEM_ONE_DEFAULT_TIMEOUT_MS,
		tooLarge: () => tooLargeMessage(engine, request.state, request.questions),
	});
	const latencyMs = Math.round(performance.now() - started);

	const answers = parseSystemOneAnswers(engine, questions, payload);
	const usage = readUsage(payload);
	const answeredBy = (payload as { model?: unknown }).model;
	const requestId = response.headers.get(REQUEST_ID_HEADER);
	return {
		engine: engine.id,
		model: typeof answeredBy === 'string' && answeredBy !== '' ? answeredBy : (model ?? ''),
		answers,
		usage,
		costUsd: systemOneCostUsd(engine.id, usage.inputTokens),
		latencyMs,
		calibrated: isSystemOneEngineCalibrated(engine.id),
		redacted: request.redacted,
		...(requestId ? { requestId } : {}),
	};
}

/** The models a remote engine lists, aliases included. */
export async function listSystemOneModels(
	engine: SystemOneRemoteEngine,
	options: SystemOneCallOptions = {}
): Promise<SystemOneModel[]> {
	const { payload } = await requestJson(engine, 'GET', MODELS_PATH, undefined, {
		...options,
		timeoutMs: options.timeoutMs ?? SYSTEM_ONE_MODELS_TIMEOUT_MS,
	});
	const models = (payload as { models?: unknown }).models;
	if (!Array.isArray(models)) throw unreadable(engine, MODELS_PATH, 'no "models" list');
	return models.map((entry) => {
		const record = entry as { name?: unknown; release_date?: unknown; description?: unknown };
		if (typeof record.name !== 'string' || record.name === '') {
			throw unreadable(engine, MODELS_PATH, 'a model with no name');
		}
		return {
			name: record.name,
			...(typeof record.release_date === 'string' ? { releaseDate: record.release_date } : {}),
			...(typeof record.description === 'string' ? { description: record.description } : {}),
		};
	});
}

/**
 * Turn a `/v1/systemone` response body into typed answers, one per question.
 *
 * Strict on purpose. A question with no answer, an answer of another type, a
 * choice that is not one of the options, or a probability outside 0 to 1 means
 * the server is not speaking this API, and a gate must not act on a guess at
 * what it meant. Answers to ids nobody asked are ignored.
 */
export function parseSystemOneAnswers(
	engine: SystemOneRemoteEngine,
	questions: SystemOneQuestions,
	payload: unknown
): SystemOneAnswers {
	const raw = (payload as { answers?: unknown } | null)?.answers;
	if (!isRecord(raw)) throw unreadable(engine, SYSTEM_ONE_PATH, 'no "answers" object');
	const answers: SystemOneAnswers = {};
	for (const [id, question] of Object.entries(questions)) {
		const parsed = parseAnswer(question, raw[id]);
		if (typeof parsed === 'string') {
			throw unreadable(engine, SYSTEM_ONE_PATH, `question "${id}": ${parsed}`);
		}
		answers[id] = parsed;
	}
	return answers;
}

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

/** The typed answer, or what is wrong with the raw one. */
function parseAnswer(question: SystemOneQuestion, raw: unknown): SystemOneAnswer | string {
	if (!isRecord(raw)) return 'no answer';
	if (raw.type !== question.type) {
		return `a ${String(raw.type)} answer to a ${question.type} question`;
	}

	if (question.type === 'noul') {
		const probability = inRange(raw.noul, 1);
		return probability === null ? 'no probability' : { type: 'noul', probability };
	}

	const confidence = inRange(raw.confidence, 1);
	if (confidence === null) return 'no confidence';
	if (!isRecord(raw.probabilities)) return 'no probabilities';

	if (question.type === 'choice') {
		const options = Object.keys(question.criteria);
		if (typeof raw.choice !== 'string' || !options.includes(raw.choice)) {
			return 'a choice that is not one of the options';
		}
		const probabilities: Record<string, number> = {};
		for (const option of options) {
			const p = inRange(raw.probabilities[option], 1);
			if (p === null) return `no probability for option "${option}"`;
			probabilities[option] = p;
		}
		return { type: 'choice', choice: raw.choice, probabilities, confidence };
	}

	const top = question.criteria.length - 1;
	const position = inRange(raw.score, top);
	if (position === null) return `a score outside 0 to ${top}`;
	// The wire keys levels by index as a string: { "0": p, "1": p, ... }.
	const probabilities: number[] = [];
	for (let level = 0; level <= top; level++) {
		const p = inRange(raw.probabilities[String(level)], 1);
		if (p === null) return `no probability for level ${level}`;
		probabilities.push(p);
	}
	return { type: 'score', score: position, probabilities, confidence };
}

/** What the engine counted. A server that reports no usage reads as zeros. */
function readUsage(payload: unknown): SystemOneUsage {
	const usage = (payload as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)
		?.usage;
	return {
		inputTokens: tokenCount(usage?.input_tokens),
		outputTokens: tokenCount(usage?.output_tokens),
	};
}

function tokenCount(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Slack for float arithmetic. A score is a sum of level times probability, so it
 * can land a hair past the top level; that is rounding, not a wrong answer.
 */
const RANGE_EPSILON = 1e-6;

/** `value` clamped into 0 to `max`, or `null` when it is not a number in that range. */
function inRange(value: unknown, max: number): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	if (value < -RANGE_EPSILON || value > max + RANGE_EPSILON) return null;
	return Math.min(max, Math.max(0, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** "Jev (TypeSafe cloud)" or "OpenJev at host", the way every message names the engine. */
function describeEngine(engine: SystemOneRemoteEngine): string {
	return systemOneEngineLabel(engine.id, { host: systemOneEngineHost(engine.baseUrl) });
}

function systemOneError(
	engine: SystemOneRemoteEngine,
	code: SystemOneErrorCode,
	message: string,
	extra: { httpStatus?: number; cause?: unknown } = {}
): SystemOneError {
	return new SystemOneError(message, { code, engine: engine.id, ...extra });
}

function unreadable(
	engine: SystemOneRemoteEngine,
	path: string,
	what: string,
	cause?: unknown
): SystemOneError {
	const hint = engine.id === 'openjev' ? ' Check that the URL is an OpenJev server.' : '';
	return systemOneError(
		engine,
		'unavailable',
		`${describeEngine(engine)} returned an unreadable answer for ${path}: ${what}.${hint}`,
		{ cause }
	);
}

function tooLargeMessage(
	engine: SystemOneRemoteEngine,
	state: SystemOneState,
	questions: SystemOneQuestions
): string {
	const estimate = estimateSystemOneRequest(engine.id, state, questions);
	const sent = (estimate.stateTokens + estimate.largestQuestionTokens).toLocaleString('en-US');
	const budget = JEV_MAX_STATE_AND_QUESTION_TOKENS.toLocaleString('en-US');
	return `The request is too large for ${describeEngine(engine)}: the state and its longest question must fit in about ${budget} tokens, and this one is about ${sent}. Send less state.`;
}

/** The server's own explanation: its error field, else a JSON body, clipped. Never an HTML page. */
function errorDetail(text: string): string | null {
	const named = errorDetailFromBody(text);
	if (named) return named;
	const trimmed = text.trim();
	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
	return trimmed.length > MAX_ERROR_BODY_CHARS
		? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}...`
		: trimmed;
}

/** Why the engine cannot be called at all, before anything is sent. */
function engineProblem(engine: SystemOneRemoteEngine): SystemOneError | null {
	const where = modelsSettingsLocation('system-one');
	if (engine.id === 'jev-cloud' && !engine.apiKey) {
		return systemOneError(
			engine,
			'auth',
			`${describeEngine(engine)} has no API key. Add one in ${where}.`
		);
	}
	const urlProblem = endpointBaseUrlProblem(engine.baseUrl);
	if (urlProblem) {
		return systemOneError(
			engine,
			'unavailable',
			`${systemOneEngineLabel(engine.id)} has no usable URL: ${urlProblem} Set it in ${where}.`
		);
	}
	return null;
}

interface RequestOptions extends SystemOneCallOptions {
	timeoutMs: number;
	/** The message for a request the server refused as too large. */
	tooLarge?: () => string;
}

/**
 * One request, answered with the parsed JSON body or a classified failure.
 *
 * `fetchWithTimeout` stops its clock when the response headers land. The budget
 * here is for the whole answer, so a second deadline rides on the request's
 * signal and also aborts a body that stalls after the headers.
 */
async function requestJson(
	engine: SystemOneRemoteEngine,
	method: 'GET' | 'POST',
	path: string,
	body: unknown,
	options: RequestOptions
): Promise<{ payload: unknown; response: Response }> {
	const refused = engineProblem(engine);
	if (refused) throw refused;

	const label = describeEngine(engine);
	const deadline = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (body !== undefined) headers['Content-Type'] = 'application/json';
	if (engine.apiKey) headers.Authorization = `Bearer ${engine.apiKey}`;

	let response: Response;
	let text: string;
	try {
		response = await fetchWithTimeout(
			`${engine.baseUrl.replace(/\/+$/, '')}${path}`,
			{ method, headers, signal, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
			options.timeoutMs
		);
		text = await response.text();
	} catch (error) {
		if (options.signal?.aborted) {
			throw systemOneError(engine, 'cancelled', `The request to ${label} was cancelled.`, {
				cause: error,
			});
		}
		if (deadline.aborted || isFetchTimeoutError(error)) {
			throw systemOneError(
				engine,
				'timeout',
				`${label} did not answer within ${options.timeoutMs} ms.`,
				{ cause: error }
			);
		}
		const hint = engine.id === 'openjev' ? ' Check the URL and that the server is running.' : '';
		throw systemOneError(engine, 'unavailable', `Could not reach ${label}.${hint}`, {
			cause: error,
		});
	}

	if (!response.ok) throw httpError(engine, path, response.status, text, options);

	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch (error) {
		throw unreadable(engine, path, 'the body is not JSON', error);
	}
	if (typeof payload !== 'object' || payload === null) {
		throw unreadable(engine, path, 'the body is not a JSON object');
	}
	return { payload, response };
}

/** Classify a non-2xx answer. The message says what a person can do about it. */
function httpError(
	engine: SystemOneRemoteEngine,
	path: string,
	status: number,
	text: string,
	options: RequestOptions
): SystemOneError {
	const label = describeEngine(engine);
	const detail = errorDetail(text);
	const suffix = detail ? `: ${detail}` : '.';
	const where = modelsSettingsLocation('system-one');

	if (status === 401 || status === 403) {
		return systemOneError(
			engine,
			'auth',
			`${label} rejected the API key (HTTP ${status}). Check the key in ${where}.`,
			{ httpStatus: status }
		);
	}
	if (status === 429) {
		return systemOneError(
			engine,
			'rate-limited',
			`${label} is rate limiting requests (HTTP 429). Send fewer requests, or try again in a moment.`,
			{ httpStatus: status }
		);
	}
	// The hosted API answers an oversized request `400 max_tokens_exceeded`, a
	// code its docs do not list. A proxy in front of an OpenJev answers 413.
	if (status === 413 || (status === 400 && text.includes('max_tokens_exceeded'))) {
		return systemOneError(
			engine,
			'too-large',
			options.tooLarge?.() ?? `The request is too large for ${label}${suffix}`,
			{ httpStatus: status }
		);
	}
	if (status === 400 || status === 422) {
		return systemOneError(
			engine,
			'invalid',
			`${label} refused the request (HTTP ${status})${suffix}`,
			{ httpStatus: status }
		);
	}
	if (status === 404) {
		return systemOneError(
			engine,
			'unavailable',
			`${label} does not serve ${path} (HTTP 404). Check the URL in ${where}.`,
			{ httpStatus: status }
		);
	}
	return systemOneError(
		engine,
		'unavailable',
		`${label} answered HTTP ${status} for ${path}${suffix}`,
		{
			httpStatus: status,
		}
	);
}
