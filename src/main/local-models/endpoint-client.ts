/**
 * The client for user-run model servers: Ollama, LM Studio, and any
 * OpenAI-compatible base URL (LiteLLM, vLLM, ...).
 *
 * Four calls, one transport. Every request goes through `fetchWithTimeout`, so
 * a server that accepted the connection and then went quiet cannot hang an IPC
 * handler forever, and every failure comes back as a `LocalModelEndpointError`
 * that names the endpoint and, for an HTTP failure, the status.
 *
 * The dialects overlap more than they differ. All three serve
 * `/v1/chat/completions` and `/v1/embeddings`; only listing differs (Ollama's
 * `/api/tags` is the one route every Ollama version has, where `/v1/models` is
 * newer). Ollama's native routes are kept as FALLBACKS for the cases an older
 * Ollama cannot serve on `/v1`: a 404 (the compat layer predates the route) and,
 * for structured output, a 400 (the compat layer predates `json_schema`).
 *
 * Speech-to-text (`/v1/audio/transcriptions`) is the one route NOT every server
 * has: an OpenAI-compatible gateway or a speech server offers it, a chat-only
 * server does not. There is no native fallback to reach for, so a 404 there is
 * reported as what it is: this endpoint does not offer speech-to-text.
 *
 * Non-streaming only for now. Note that the timeout covers the response
 * headers; a non-streaming server sends those once generation is done, so for
 * chat the budget is effectively the whole generation.
 *
 * Whether an endpoint is `enabled` is the CALLER's question, not this module's:
 * a consumer picking a server skips disabled ones, while "Test" in Settings must
 * work on an endpoint before the user switches it on.
 */

import {
	DEFAULT_ENDPOINT_BASE_URLS,
	LOCAL_MODEL_ENDPOINT_KIND_LABELS,
	isLoopbackEndpointUrl,
	isSameEndpointServer,
	resolveEndpointApiKey,
	type LocalModelEndpoint,
	type LocalModelEndpointKind,
} from '../../shared/local-models/endpoints';
import { fetchWithTimeout, isFetchTimeoutError } from '../utils/fetchWithTimeout';
import {
	LocalModelEndpointError,
	isLocalModelEndpointError,
	type LocalModelEndpointErrorKind,
} from './errors';

/** Listing is a metadata read; a healthy local server answers in milliseconds. */
export const ENDPOINT_LIST_TIMEOUT_MS = 5_000;

/**
 * Generous on purpose: the first request after idle makes Ollama and LM Studio
 * load the model into memory, which alone can take tens of seconds.
 */
export const ENDPOINT_CHAT_TIMEOUT_MS = 120_000;

export const ENDPOINT_EMBED_TIMEOUT_MS = 60_000;

/**
 * One clip, uploaded whole. A minute of speech transcribes in a few seconds on
 * a warm server; the budget is for the first request after idle, when the
 * server loads the model before it reads a single sample.
 */
export const ENDPOINT_TRANSCRIBE_TIMEOUT_MS = 60_000;

/**
 * A server on loopback that is running answers in a few milliseconds, and one
 * that is not refuses the connection at once. The budget only matters for a
 * port held by something that accepts and never answers.
 */
export const ENDPOINT_DETECT_TIMEOUT_MS = 800;

/**
 * Shorter than a real chat, longer than a listing: a Test is often the first
 * request after idle, and the server loads the model before it answers even one
 * token.
 */
export const ENDPOINT_TEST_TIMEOUT_MS = 30_000;

/** Longest server-supplied error detail quoted into a message. */
const MAX_ERROR_DETAIL_CHARS = 200;

/** Options every call accepts. */
export interface EndpointCallOptions {
	/**
	 * Settings -> Environment (`shellEnvVars`), where the endpoint's API key is
	 * looked up by name at call time. Never the key itself; see
	 * `LocalModelEndpoint.apiKeyEnvVar` for why.
	 */
	shellEnvVars?: Record<string, string>;
	/**
	 * A key handed in directly, for the one endpoint whose key Maestro holds
	 * itself: the Maestro model server, sealed in its own config file. Never
	 * persisted with a record. Takes the place of `apiKeyEnvVar`.
	 */
	apiKey?: string;
	/** Request budget. Each call has its own default. */
	timeoutMs?: number;
	/** Caller cancellation, composed with the timeout. */
	signal?: AbortSignal;
}

export interface EndpointModel {
	/** The id to pass back as `model` in a chat or embed request. */
	id: string;
	/** On-disk size, when the server reports it (Ollama does; `/v1/models` does not). */
	sizeBytes?: number;
}

export interface EndpointChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface EndpointChatRequest extends EndpointCallOptions {
	model: string;
	messages: EndpointChatMessage[];
	maxTokens?: number;
	temperature?: number;
	/**
	 * A JSON Schema the reply must satisfy. Sent as an OpenAI `json_schema`
	 * response format, or as Ollama's native `format` on the fallback route.
	 */
	jsonSchema?: Record<string, unknown>;
	/** Schema name for the OpenAI response format. Defaults to `response`. */
	jsonSchemaName?: string;
	/**
	 * Ask the chat template to skip the reasoning segment
	 * (`chat_template_kwargs.enable_thinking: false`, which llama-server reads).
	 * A thinking model otherwise spends `maxTokens` on a thought and can return
	 * an empty answer. Sent only when set, since not every server knows the field.
	 */
	disableThinking?: boolean;
}

export interface EndpointChatResult {
	content: string;
	/** The model the server says answered, which can differ from the one asked for (aliases). */
	model: string;
	finishReason?: string;
	usage?: { promptTokens: number; completionTokens: number };
}

export interface EndpointEmbedRequest extends EndpointCallOptions {
	model: string;
	input: string[];
}

export interface EndpointEmbedResult {
	/** One vector per input, in input order. */
	embeddings: number[][];
	model: string;
}

export interface EndpointTranscribeRequest extends EndpointCallOptions {
	model: string;
	/**
	 * The clip as a WAV file (16-bit PCM, mono). A container rather than raw
	 * samples because the route takes a file and infers the format from it.
	 */
	wav: Uint8Array;
	/** Optional BCP-47 hint. Given, it improves both speed and accuracy. */
	language?: string;
}

export interface EndpointTranscribeResult {
	/** The transcript exactly as the server returned it. */
	text: string;
}

// ---------------------------------------------------------------------------
// Public calls
// ---------------------------------------------------------------------------

/** The models the server can serve right now. */
export async function listEndpointModels(
	endpoint: LocalModelEndpoint,
	options: EndpointCallOptions = {}
): Promise<EndpointModel[]> {
	const call = { ...options, timeoutMs: options.timeoutMs ?? ENDPOINT_LIST_TIMEOUT_MS };

	if (endpoint.kind === 'ollama') {
		const body = await requestJson(endpoint, 'GET', '/api/tags', undefined, call);
		const models = (body as { models?: unknown }).models;
		if (!Array.isArray(models)) throw malformed(endpoint, '/api/tags', 'no "models" list');
		return models.map((entry) => {
			const record = entry as { name?: unknown; model?: unknown; size?: unknown };
			const id = typeof record.name === 'string' ? record.name : record.model;
			if (typeof id !== 'string' || id === '') {
				throw malformed(endpoint, '/api/tags', 'a model with no name');
			}
			return typeof record.size === 'number' ? { id, sizeBytes: record.size } : { id };
		});
	}

	const body = await requestJson(endpoint, 'GET', '/v1/models', undefined, call);
	const data = (body as { data?: unknown }).data;
	if (!Array.isArray(data)) throw malformed(endpoint, '/v1/models', 'no "data" list');
	return data.map((entry) => {
		const id = (entry as { id?: unknown }).id;
		if (typeof id !== 'string' || id === '') {
			throw malformed(endpoint, '/v1/models', 'a model with no id');
		}
		return { id };
	});
}

/** One non-streaming chat completion. */
export async function endpointChat(
	endpoint: LocalModelEndpoint,
	request: EndpointChatRequest
): Promise<EndpointChatResult> {
	const call = { ...request, timeoutMs: request.timeoutMs ?? ENDPOINT_CHAT_TIMEOUT_MS };
	const body = {
		model: request.model,
		messages: request.messages,
		stream: false,
		...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
		...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
		...(request.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
		...(request.jsonSchema
			? {
					response_format: {
						type: 'json_schema',
						json_schema: {
							name: request.jsonSchemaName ?? 'response',
							schema: request.jsonSchema,
						},
					},
				}
			: {}),
	};

	let payload: unknown;
	try {
		payload = await requestJson(endpoint, 'POST', '/v1/chat/completions', body, call);
	} catch (error) {
		if (endpoint.kind !== 'ollama' || !shouldUseOllamaChatFallback(error, request)) throw error;
		return ollamaNativeChat(endpoint, request, call);
	}

	const choice = (payload as { choices?: unknown }).choices;
	const first = Array.isArray(choice) ? (choice[0] as Record<string, unknown> | undefined) : null;
	const content = (first?.message as { content?: unknown } | undefined)?.content;
	if (typeof content !== 'string') {
		throw malformed(endpoint, '/v1/chat/completions', 'no message content');
	}
	const usage = (payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } })
		.usage;
	return {
		content,
		model: stringOr((payload as { model?: unknown }).model, request.model),
		...(typeof first?.finish_reason === 'string' ? { finishReason: first.finish_reason } : {}),
		...(usage &&
		typeof usage.prompt_tokens === 'number' &&
		typeof usage.completion_tokens === 'number'
			? { usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens } }
			: {}),
	};
}

/** Embed every input, returning vectors in input order. */
export async function endpointEmbed(
	endpoint: LocalModelEndpoint,
	request: EndpointEmbedRequest
): Promise<EndpointEmbedResult> {
	const call = { ...request, timeoutMs: request.timeoutMs ?? ENDPOINT_EMBED_TIMEOUT_MS };
	const body = { model: request.model, input: request.input };

	let payload: unknown;
	try {
		payload = await requestJson(endpoint, 'POST', '/v1/embeddings', body, call);
	} catch (error) {
		if (endpoint.kind !== 'ollama' || !isEndpointStatus(error, 404)) throw error;
		const native = await requestJson(endpoint, 'POST', '/api/embed', body, call);
		const vectors = (native as { embeddings?: unknown }).embeddings;
		return {
			embeddings: requireVectors(endpoint, '/api/embed', vectors, request.input.length),
			model: stringOr((native as { model?: unknown }).model, request.model),
		};
	}

	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) throw malformed(endpoint, '/v1/embeddings', 'no "data" list');
	// The spec carries an `index` per vector and does not promise order, so sort
	// by it when every entry has one rather than trusting array position.
	const indexed = data.every((entry) => typeof (entry as { index?: unknown }).index === 'number');
	const ordered = indexed
		? [...data].sort((a, b) => (a as { index: number }).index - (b as { index: number }).index)
		: data;
	return {
		embeddings: requireVectors(
			endpoint,
			'/v1/embeddings',
			ordered.map((entry) => (entry as { embedding?: unknown }).embedding),
			request.input.length
		),
		model: stringOr((payload as { model?: unknown }).model, request.model),
	};
}

/** The route every OpenAI-compatible speech server transcribes on. */
const TRANSCRIBE_PATH = '/v1/audio/transcriptions';

/**
 * Transcribe one clip on a server that offers speech-to-text.
 *
 * The clip is uploaded whole as one multipart request and the transcript comes
 * back as JSON. Not every endpoint has this route (see the file comment), so a
 * 404 is restated to say so rather than left as a bare status: "HTTP 404" in
 * front of someone who assigned a chat server to dictation explains nothing.
 */
export async function endpointTranscribe(
	endpoint: LocalModelEndpoint,
	request: EndpointTranscribeRequest
): Promise<EndpointTranscribeResult> {
	const call = { ...request, timeoutMs: request.timeoutMs ?? ENDPOINT_TRANSCRIBE_TIMEOUT_MS };
	const form = new FormData();
	form.append('model', request.model);
	form.append('response_format', 'json');
	if (request.language) form.append('language', request.language);
	// Copied into its own buffer: `wav` may be a view over a larger one, and a
	// Blob built from `.buffer` would upload the bytes around it too.
	form.append(
		'file',
		new Blob([new Uint8Array(request.wav).buffer as ArrayBuffer], { type: 'audio/wav' }),
		'clip.wav'
	);

	let payload: unknown;
	try {
		payload = await requestJson(endpoint, 'POST', TRANSCRIBE_PATH, form, call);
	} catch (error) {
		if (!isEndpointStatus(error, 404)) throw error;
		throw endpointError(
			endpoint,
			'not-found',
			`${describeEndpoint(endpoint)} does not offer speech-to-text (${TRANSCRIBE_PATH} answered HTTP 404), or does not serve "${request.model}".`,
			`${endpoint.baseUrl}${TRANSCRIBE_PATH}`,
			{ httpStatus: 404, cause: error }
		);
	}

	const text = (payload as { text?: unknown }).text;
	if (typeof text !== 'string') throw malformed(endpoint, TRANSCRIBE_PATH, 'no "text"');
	return { text };
}

// ---------------------------------------------------------------------------
// Detection and testing
// ---------------------------------------------------------------------------

/**
 * A failure in the shape that survives IPC and the CLI bridge. An `Error`
 * thrown across `ipcMain.handle` arrives as a bare message, which would lose
 * `kind`, the field a UI switches on to tell "not running" from "bad key".
 */
export interface EndpointFailure {
	kind: LocalModelEndpointErrorKind;
	message: string;
	httpStatus?: number;
}

export type EndpointModelsResult =
	| { ok: true; models: EndpointModel[] }
	| { ok: false; error: EndpointFailure };

export type EndpointTestResult =
	| {
			ok: true;
			/** The model that answered. */
			model: string;
			/** Round trip of the one-token chat, from send to parsed reply. */
			latencyMs: number;
			/** How many models the server lists. Absent when the caller named the model. */
			modelCount?: number;
	  }
	| { ok: false; error: EndpointFailure };

/** A running server on this machine that is not configured yet. Nothing is saved. */
export interface DetectedEndpoint {
	kind: LocalModelEndpointKind;
	/** Suggested display name ("Ollama"). */
	name: string;
	baseUrl: string;
	/** What it serves right now, so the offer can say "3 models". */
	models: EndpointModel[];
}

export interface EndpointTestRequest extends EndpointCallOptions {
	/** Test against this model. Defaults to the first model the server lists. */
	model?: string;
}

/** Flatten a classified endpoint error into its serializable form. */
export function toEndpointFailure(error: LocalModelEndpointError): EndpointFailure {
	return {
		kind: error.kind,
		message: error.message,
		...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
	};
}

/**
 * Look for Ollama and LM Studio on their default loopback ports and return the
 * ones not already in `configured`.
 *
 * Read-only by contract: it never adds an endpoint. A found server is an OFFER
 * the user accepts with an explicit click, because a server on a port is not
 * consent to route prompts to it. Only loopback is probed, ever, so running
 * detection cannot send a request off this machine. A probe that fails for any
 * classified reason (refused, timed out, not the dialect expected) simply means
 * nothing is there.
 */
export async function detectLocalEndpoints(
	configured: readonly Pick<LocalModelEndpoint, 'baseUrl'>[],
	options: Pick<EndpointCallOptions, 'timeoutMs' | 'signal'> = {}
): Promise<DetectedEndpoint[]> {
	const candidates = (
		Object.entries(DEFAULT_ENDPOINT_BASE_URLS) as [LocalModelEndpointKind, string][]
	).filter(
		([, baseUrl]) =>
			isLoopbackEndpointUrl(baseUrl) &&
			!configured.some((endpoint) => isSameEndpointServer(endpoint.baseUrl, baseUrl))
	);

	const probes = candidates.map(async ([kind, baseUrl]): Promise<DetectedEndpoint | null> => {
		const name = LOCAL_MODEL_ENDPOINT_KIND_LABELS[kind];
		const probe: LocalModelEndpoint = {
			id: `detected-${kind}`,
			name,
			kind,
			baseUrl,
			enabled: false,
		};
		try {
			const models = await listEndpointModels(probe, {
				timeoutMs: options.timeoutMs ?? ENDPOINT_DETECT_TIMEOUT_MS,
				...(options.signal ? { signal: options.signal } : {}),
			});
			return { kind, name, baseUrl, models };
		} catch (error) {
			if (isLocalModelEndpointError(error)) return null;
			throw error;
		}
	});

	return (await Promise.all(probes)).filter((found): found is DetectedEndpoint => found !== null);
}

/** {@link listEndpointModels}, answered as a result instead of a throw. */
export async function listEndpointModelsResult(
	endpoint: LocalModelEndpoint,
	options: EndpointCallOptions = {}
): Promise<EndpointModelsResult> {
	try {
		return { ok: true, models: await listEndpointModels(endpoint, options) };
	} catch (error) {
		if (isLocalModelEndpointError(error)) return { ok: false, error: toEndpointFailure(error) };
		throw error;
	}
}

/**
 * Prove an endpoint works end to end: send a one-token chat and time it.
 *
 * Listing alone is not enough, since a server can list models it then fails to
 * load, and a gateway can list models the key is not allowed to call. With no
 * `model` named, the first listed model is used; a server that lists none is
 * reported as `no-models` rather than tested against a guess.
 */
export async function testEndpoint(
	endpoint: LocalModelEndpoint,
	request: EndpointTestRequest = {}
): Promise<EndpointTestResult> {
	const { model: requestedModel, ...call } = request;
	try {
		let model = requestedModel;
		let modelCount: number | undefined;
		if (!model) {
			const models = await listEndpointModels(endpoint, call);
			modelCount = models.length;
			model = models[0]?.id;
			if (!model) {
				return {
					ok: false,
					error: {
						kind: 'no-models',
						message: `${describeEndpoint(endpoint)} is running but serves no models. Load or pull one, then test again.`,
					},
				};
			}
		}

		const started = performance.now();
		const reply = await endpointChat(endpoint, {
			...call,
			timeoutMs: call.timeoutMs ?? ENDPOINT_TEST_TIMEOUT_MS,
			model,
			messages: [{ role: 'user', content: 'Reply with OK.' }],
			maxTokens: 1,
			temperature: 0,
		});
		return {
			ok: true,
			model: reply.model,
			latencyMs: Math.round(performance.now() - started),
			...(modelCount !== undefined ? { modelCount } : {}),
		};
	} catch (error) {
		if (isLocalModelEndpointError(error)) return { ok: false, error: toEndpointFailure(error) };
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Ollama native fallback
// ---------------------------------------------------------------------------

/**
 * A 404 means this Ollama predates `/v1/chat/completions`. A 400 on a request
 * carrying a schema means it predates `json_schema` in the compat layer; the
 * native route has taken a schema as `format` for longer. Any other failure is
 * the real answer and is rethrown.
 */
function shouldUseOllamaChatFallback(error: unknown, request: EndpointChatRequest): boolean {
	if (isEndpointStatus(error, 404)) return true;
	return request.jsonSchema !== undefined && isEndpointStatus(error, 400);
}

async function ollamaNativeChat(
	endpoint: LocalModelEndpoint,
	request: EndpointChatRequest,
	call: EndpointCallOptions
): Promise<EndpointChatResult> {
	const modelOptions = {
		...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
		...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
	};
	const payload = await requestJson(
		endpoint,
		'POST',
		'/api/chat',
		{
			model: request.model,
			messages: request.messages,
			stream: false,
			...(request.jsonSchema ? { format: request.jsonSchema } : {}),
			...(Object.keys(modelOptions).length > 0 ? { options: modelOptions } : {}),
		},
		call
	);
	const record = payload as {
		model?: unknown;
		message?: { content?: unknown };
		done_reason?: unknown;
		prompt_eval_count?: unknown;
		eval_count?: unknown;
	};
	const content = record.message?.content;
	if (typeof content !== 'string') throw malformed(endpoint, '/api/chat', 'no message content');
	return {
		content,
		model: stringOr(record.model, request.model),
		...(typeof record.done_reason === 'string' ? { finishReason: record.done_reason } : {}),
		...(typeof record.prompt_eval_count === 'number' && typeof record.eval_count === 'number'
			? { usage: { promptTokens: record.prompt_eval_count, completionTokens: record.eval_count } }
			: {}),
	};
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** "Ollama" (http://127.0.0.1:11434), the way every message names an endpoint. */
function describeEndpoint(endpoint: LocalModelEndpoint): string {
	return `"${endpoint.name}" (${endpoint.baseUrl})`;
}

function endpointError(
	endpoint: LocalModelEndpoint,
	kind: LocalModelEndpointErrorKind,
	message: string,
	url: string,
	extra: { httpStatus?: number; cause?: unknown } = {}
): LocalModelEndpointError {
	return new LocalModelEndpointError(message, {
		kind,
		endpointId: endpoint.id,
		endpointName: endpoint.name,
		url,
		...extra,
	});
}

function malformed(
	endpoint: LocalModelEndpoint,
	path: string,
	what: string,
	cause?: unknown
): LocalModelEndpointError {
	return endpointError(
		endpoint,
		'malformed',
		`${describeEndpoint(endpoint)} returned an unreadable answer for ${path}: ${what}. Check that its kind (${endpoint.kind}) is right.`,
		`${endpoint.baseUrl}${path}`,
		{ cause }
	);
}

function isEndpointStatus(error: unknown, status: number): boolean {
	return error instanceof LocalModelEndpointError && error.httpStatus === status;
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === 'string' && value !== '' ? value : fallback;
}

function requireVectors(
	endpoint: LocalModelEndpoint,
	path: string,
	vectors: unknown,
	expected: number
): number[][] {
	if (!Array.isArray(vectors)) throw malformed(endpoint, path, 'no embeddings');
	if (vectors.length !== expected) {
		throw malformed(endpoint, path, `${vectors.length} embeddings for ${expected} inputs`);
	}
	for (const vector of vectors) {
		if (!Array.isArray(vector) || !vector.every((n) => typeof n === 'number')) {
			throw malformed(endpoint, path, 'an embedding that is not a list of numbers');
		}
	}
	return vectors as number[][];
}

/**
 * The server's own one-line explanation, when it sent JSON with one. OpenAI
 * shapes it `{ error: { message } }`, Ollama `{ error: "..." }`. A non-JSON body
 * (a proxy's HTML error page) is not quoted.
 */
async function readErrorDetail(response: Response): Promise<string | null> {
	return errorDetailFromBody(await response.text().catch(() => ''));
}

/** {@link readErrorDetail} for a body already read. Shared with the System One client. */
export function errorDetailFromBody(text: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const error = (parsed as { error?: unknown; message?: unknown })?.error;
	const detail =
		typeof error === 'string'
			? error
			: typeof (error as { message?: unknown })?.message === 'string'
				? (error as { message: string }).message
				: typeof (parsed as { message?: unknown })?.message === 'string'
					? (parsed as { message: string }).message
					: null;
	if (!detail) return null;
	const trimmed = detail.trim();
	return trimmed.length > MAX_ERROR_DETAIL_CHARS
		? `${trimmed.slice(0, MAX_ERROR_DETAIL_CHARS)}...`
		: trimmed;
}

/**
 * One request, answered with the parsed JSON body or a classified failure.
 *
 * A named key that does not resolve is refused BEFORE the request: sending the
 * call unauthenticated would come back as a 401 that blames the server for a
 * setting the user never finished.
 *
 * `body` is sent as JSON, except a `FormData`, which is sent as the multipart
 * upload it is (fetch writes its own boundary header).
 */
async function requestJson(
	endpoint: LocalModelEndpoint,
	method: 'GET' | 'POST',
	path: string,
	body: unknown,
	options: EndpointCallOptions
): Promise<unknown> {
	const url = `${endpoint.baseUrl}${path}`;
	const apiKey = options.apiKey ?? resolveEndpointApiKey(endpoint, options.shellEnvVars);
	if (endpoint.apiKeyEnvVar && !apiKey) {
		throw endpointError(
			endpoint,
			'missing-key',
			`${describeEndpoint(endpoint)} uses the API key in ${endpoint.apiKeyEnvVar}, which is not set. Add it in Settings -> Environment.`,
			url
		);
	}

	const multipart = body instanceof FormData;
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (body !== undefined && !multipart) headers['Content-Type'] = 'application/json';
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	let response: Response;
	try {
		response = await fetchWithTimeout(
			url,
			{
				method,
				headers,
				...(body !== undefined ? { body: multipart ? body : JSON.stringify(body) } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			},
			options.timeoutMs
		);
	} catch (error) {
		if (options.signal?.aborted) {
			throw endpointError(
				endpoint,
				'cancelled',
				`The request to ${describeEndpoint(endpoint)} was cancelled.`,
				url,
				{ cause: error }
			);
		}
		if (isFetchTimeoutError(error)) {
			throw endpointError(
				endpoint,
				'timeout',
				`${describeEndpoint(endpoint)} did not answer ${path} within ${Math.round((options.timeoutMs ?? 0) / 1000)}s.`,
				url,
				{ cause: error }
			);
		}
		throw endpointError(
			endpoint,
			'network',
			`Could not reach ${describeEndpoint(endpoint)}. Check that the server is running.`,
			url,
			{ cause: error }
		);
	}

	if (!response.ok) {
		const status = response.status;
		const detail = await readErrorDetail(response);
		const suffix = detail ? `: ${detail}` : '.';
		const kind: LocalModelEndpointErrorKind =
			status === 401 || status === 403 ? 'auth' : status === 404 ? 'not-found' : 'http';
		const lead =
			kind === 'auth'
				? `${describeEndpoint(endpoint)} rejected the request (HTTP ${status}). Check the API key in ${endpoint.apiKeyEnvVar ?? 'Settings -> Environment'}`
				: `${describeEndpoint(endpoint)} answered HTTP ${status} for ${path}`;
		throw endpointError(endpoint, kind, `${lead}${suffix}`, url, { httpStatus: status });
	}

	try {
		const parsed: unknown = await response.json();
		if (typeof parsed !== 'object' || parsed === null) {
			throw new Error('Body is not a JSON object');
		}
		return parsed;
	} catch (error) {
		throw malformed(endpoint, path, 'the body is not a JSON object', error);
	}
}
