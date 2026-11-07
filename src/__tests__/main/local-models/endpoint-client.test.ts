/**
 * @file endpoint-client.test.ts
 *
 * The endpoint client against a mocked `fetch`, for all three kinds. Pins the
 * routes each kind is asked on, the Ollama fallbacks (404 to the native route,
 * 400-with-schema to `format`), API key resolution from Settings ->
 * Environment, and the error classification a person reads.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	detectLocalEndpoints,
	endpointChat,
	endpointEmbed,
	endpointTranscribe,
	listEndpointModels,
	listEndpointModelsResult,
	testEndpoint,
} from '../../../main/local-models/endpoint-client';
import {
	LocalModelEndpointError,
	isLocalModelEndpointError,
} from '../../../main/local-models/errors';
import type {
	LocalModelEndpoint,
	LocalModelEndpointKind,
} from '../../../shared/local-models/endpoints';

function endpoint(
	kind: LocalModelEndpointKind,
	extra: Partial<LocalModelEndpoint> = {}
): LocalModelEndpoint {
	return {
		id: `ep-${kind}`,
		name: `My ${kind}`,
		kind,
		baseUrl: kind === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234',
		enabled: true,
		...extra,
	};
}

function jsonResponse(status: number, body: unknown): Response {
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => JSON.parse(text),
		text: async () => text,
	} as unknown as Response;
}

/** Answers each request from a `path -> response` table; unknown paths are a test bug. */
function routeFetch(routes: Record<string, Response | (() => Response)>) {
	const mock = vi.fn(async (url: string) => {
		const path = new URL(url).pathname;
		const route = routes[path];
		if (!route) throw new Error(`unexpected request to ${path}`);
		return typeof route === 'function' ? route() : route;
	});
	globalThis.fetch = mock as unknown as typeof fetch;
	return mock;
}

function requestBody(mock: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
	return JSON.parse((mock.mock.calls[call][1] as RequestInit).body as string);
}

function requestHeaders(mock: ReturnType<typeof vi.fn>, call: number): Record<string, string> {
	return (mock.mock.calls[call][1] as RequestInit).headers as Record<string, string>;
}

/** Answers from a `full URL -> response` table; anything else is refused like a closed port. */
function urlFetch(routes: Record<string, Response | (() => Promise<Response>)>) {
	const mock = vi.fn(async (url: string, init: RequestInit = {}) => {
		const route = routes[url];
		if (!route) {
			// A port with nothing listening: the connection is refused at once.
			throw new TypeError('fetch failed');
		}
		if (typeof route !== 'function') return route;
		return new Promise<Response>((resolve, reject) => {
			init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
			route().then(resolve, reject);
		});
	});
	globalThis.fetch = mock as unknown as typeof fetch;
	return mock;
}

const never = () => new Promise<Response>(() => {});

async function rejection(promise: Promise<unknown>): Promise<LocalModelEndpointError> {
	try {
		await promise;
	} catch (error) {
		expect(isLocalModelEndpointError(error)).toBe(true);
		return error as LocalModelEndpointError;
	}
	throw new Error('expected a rejection');
}

describe('endpoint-client', () => {
	const realFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = realFetch;
		vi.restoreAllMocks();
	});

	describe('listEndpointModels', () => {
		it('lists Ollama models from /api/tags with their size', async () => {
			const mock = routeFetch({
				'/api/tags': jsonResponse(200, {
					models: [{ name: 'llama3.2:3b', size: 2_000_000_000 }, { model: 'nomic-embed-text' }],
				}),
			});

			const models = await listEndpointModels(endpoint('ollama'));

			expect(models).toEqual([
				{ id: 'llama3.2:3b', sizeBytes: 2_000_000_000 },
				{ id: 'nomic-embed-text' },
			]);
			expect(mock.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/tags');
		});

		it.each(['lmstudio', 'openai-compatible'] as const)(
			'lists %s models from /v1/models',
			async (kind) => {
				const mock = routeFetch({
					'/v1/models': jsonResponse(200, { data: [{ id: 'qwen2.5-7b' }, { id: 'phi-4' }] }),
				});

				expect(await listEndpointModels(endpoint(kind))).toEqual([
					{ id: 'qwen2.5-7b' },
					{ id: 'phi-4' },
				]);
				expect(mock.mock.calls[0][0]).toBe('http://127.0.0.1:1234/v1/models');
			}
		);

		it('reports a malformed body naming the endpoint', async () => {
			routeFetch({ '/v1/models': jsonResponse(200, { models: [] }) });

			const error = await rejection(listEndpointModels(endpoint('lmstudio')));

			expect(error.kind).toBe('malformed');
			expect(error.message).toContain('"My lmstudio"');
			expect(error.message).toContain('/v1/models');
		});

		it('reports a body that is not JSON as malformed', async () => {
			routeFetch({ '/api/tags': jsonResponse(200, '<html>not json</html>') });

			const error = await rejection(listEndpointModels(endpoint('ollama')));

			expect(error.kind).toBe('malformed');
		});

		it('classifies a timeout and names the endpoint', async () => {
			globalThis.fetch = vi.fn(
				(_url: string, init: RequestInit = {}) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
					})
			) as unknown as typeof fetch;

			const error = await rejection(listEndpointModels(endpoint('ollama'), { timeoutMs: 20 }));

			expect(error.kind).toBe('timeout');
			expect(error.message).toContain('"My ollama" (http://127.0.0.1:11434)');
			expect(error.endpointId).toBe('ep-ollama');
		});

		it('classifies a caller abort as cancelled, not as a timeout', async () => {
			globalThis.fetch = vi.fn(
				(_url: string, init: RequestInit = {}) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
					})
			) as unknown as typeof fetch;
			const controller = new AbortController();

			const pending = rejection(
				listEndpointModels(endpoint('ollama'), { signal: controller.signal })
			);
			controller.abort();

			expect((await pending).kind).toBe('cancelled');
		});

		it.each([200, 503])(
			'times out a stalled response body after HTTP %s headers',
			async (status) => {
				globalThis.fetch = vi.fn(async (_url: string, init: RequestInit = {}) => ({
					ok: status === 200,
					status,
					text: () =>
						new Promise<string>((_resolve, reject) => {
							init.signal?.addEventListener('abort', () => {
								// Fetch body reads can report AbortError even for a timeout.
								reject(new DOMException('Body aborted', 'AbortError'));
							});
						}),
				})) as unknown as typeof fetch;

				const error = await rejection(listEndpointModels(endpoint('ollama'), { timeoutMs: 20 }));

				expect(error.kind).toBe('timeout');
				expect(error.message).toContain('/api/tags');
			}
		);

		it('classifies cancellation during a response body read as cancelled', async () => {
			const controller = new AbortController();
			globalThis.fetch = vi.fn(async (_url: string, init: RequestInit = {}) => ({
				ok: true,
				status: 200,
				text: () =>
					new Promise<string>((_resolve, reject) => {
						init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
						controller.abort();
					}),
			})) as unknown as typeof fetch;

			const error = await rejection(
				listEndpointModels(endpoint('ollama'), { signal: controller.signal })
			);

			expect(error.kind).toBe('cancelled');
		});

		it('classifies a refused connection as network', async () => {
			globalThis.fetch = vi.fn(async () => {
				throw new TypeError('fetch failed');
			}) as unknown as typeof fetch;

			const error = await rejection(listEndpointModels(endpoint('lmstudio')));

			expect(error.kind).toBe('network');
			expect(error.message).toContain('Check that the server is running');
		});
	});

	describe('API keys', () => {
		it('sends the key named by apiKeyEnvVar, resolved from shellEnvVars', async () => {
			const mock = routeFetch({ '/v1/models': jsonResponse(200, { data: [] }) });

			await listEndpointModels(endpoint('openai-compatible', { apiKeyEnvVar: 'LITELLM_KEY' }), {
				shellEnvVars: { LITELLM_KEY: ' sk-local ' },
			});

			expect(requestHeaders(mock, 0).Authorization).toBe('Bearer sk-local');
		});

		it('sends no Authorization header when no key is named', async () => {
			const mock = routeFetch({ '/api/tags': jsonResponse(200, { models: [] }) });

			await listEndpointModels(endpoint('ollama'));

			expect(requestHeaders(mock, 0).Authorization).toBeUndefined();
		});

		it('refuses before sending when the named key is not set', async () => {
			const mock = routeFetch({ '/v1/models': jsonResponse(200, { data: [] }) });

			const error = await rejection(
				listEndpointModels(endpoint('openai-compatible', { apiKeyEnvVar: 'LITELLM_KEY' }), {
					shellEnvVars: {},
				})
			);

			expect(error.kind).toBe('missing-key');
			expect(error.message).toContain('LITELLM_KEY');
			expect(mock).not.toHaveBeenCalled();
		});

		it('classifies a 401 as auth with the status', async () => {
			routeFetch({
				'/v1/models': jsonResponse(401, { error: { message: 'Invalid API key' } }),
			});

			const error = await rejection(
				listEndpointModels(endpoint('openai-compatible', { apiKeyEnvVar: 'LITELLM_KEY' }), {
					shellEnvVars: { LITELLM_KEY: 'sk-wrong' },
				})
			);

			expect(error.kind).toBe('auth');
			expect(error.httpStatus).toBe(401);
			expect(error.message).toContain('HTTP 401');
			expect(error.message).toContain('Invalid API key');
		});
	});

	describe('endpointChat', () => {
		const completion = jsonResponse(200, {
			model: 'qwen2.5-7b',
			choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 12, completion_tokens: 1 },
		});

		it.each(['ollama', 'lmstudio', 'openai-compatible'] as const)(
			'posts %s chat to /v1/chat/completions',
			async (kind) => {
				const mock = routeFetch({ '/v1/chat/completions': completion });

				const result = await endpointChat(endpoint(kind), {
					model: 'qwen2.5-7b',
					messages: [{ role: 'user', content: 'hi' }],
					maxTokens: 16,
					temperature: 0,
				});

				expect(result).toEqual({
					content: 'hello',
					model: 'qwen2.5-7b',
					finishReason: 'stop',
					usage: { promptTokens: 12, completionTokens: 1 },
				});
				expect(requestBody(mock, 0)).toEqual({
					model: 'qwen2.5-7b',
					messages: [{ role: 'user', content: 'hi' }],
					stream: false,
					max_tokens: 16,
					temperature: 0,
				});
			}
		);

		it('sends a json_schema response format when a schema is given', async () => {
			const mock = routeFetch({ '/v1/chat/completions': completion });
			const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };

			await endpointChat(endpoint('lmstudio'), {
				model: 'm',
				messages: [{ role: 'user', content: 'hi' }],
				jsonSchema: schema,
				jsonSchemaName: 'verdict',
			});

			expect(requestBody(mock, 0).response_format).toEqual({
				type: 'json_schema',
				json_schema: { name: 'verdict', schema },
			});
		});

		it('falls back to Ollama /api/chat with format when the compat layer rejects the schema', async () => {
			const schema = { type: 'object' };
			const mock = routeFetch({
				'/v1/chat/completions': jsonResponse(400, { error: 'invalid response format' }),
				'/api/chat': jsonResponse(200, {
					model: 'llama3.2:3b',
					message: { role: 'assistant', content: '{}' },
					done_reason: 'stop',
					prompt_eval_count: 5,
					eval_count: 2,
				}),
			});

			const result = await endpointChat(endpoint('ollama'), {
				model: 'llama3.2:3b',
				messages: [{ role: 'user', content: 'hi' }],
				maxTokens: 8,
				jsonSchema: schema,
			});

			expect(result).toEqual({
				content: '{}',
				model: 'llama3.2:3b',
				finishReason: 'stop',
				usage: { promptTokens: 5, completionTokens: 2 },
			});
			expect(requestBody(mock, 1)).toEqual({
				model: 'llama3.2:3b',
				messages: [{ role: 'user', content: 'hi' }],
				stream: false,
				format: schema,
				options: { num_predict: 8 },
			});
		});

		it('falls back to Ollama /api/chat on a 404 from an older Ollama', async () => {
			const mock = routeFetch({
				'/v1/chat/completions': jsonResponse(404, '404 page not found'),
				'/api/chat': jsonResponse(200, { message: { content: 'hello' } }),
			});

			const result = await endpointChat(endpoint('ollama'), {
				model: 'llama3.2:3b',
				messages: [{ role: 'user', content: 'hi' }],
			});

			expect(result.content).toBe('hello');
			expect(mock).toHaveBeenCalledTimes(2);
		});

		it('does not fall back for a non-Ollama 404, and names the status', async () => {
			const mock = routeFetch({
				'/v1/chat/completions': jsonResponse(404, { error: { message: 'model not loaded' } }),
			});

			const error = await rejection(
				endpointChat(endpoint('lmstudio'), {
					model: 'missing',
					messages: [{ role: 'user', content: 'hi' }],
				})
			);

			expect(error.kind).toBe('not-found');
			expect(error.httpStatus).toBe(404);
			expect(error.message).toContain('HTTP 404');
			expect(error.message).toContain('model not loaded');
			expect(mock).toHaveBeenCalledTimes(1);
		});

		it('does not fall back on a 400 when no schema was sent', async () => {
			routeFetch({ '/v1/chat/completions': jsonResponse(400, { error: 'bad request' }) });

			const error = await rejection(
				endpointChat(endpoint('ollama'), {
					model: 'm',
					messages: [{ role: 'user', content: 'hi' }],
				})
			);

			expect(error.kind).toBe('http');
			expect(error.httpStatus).toBe(400);
		});

		it('reports a completion with no content as malformed', async () => {
			routeFetch({ '/v1/chat/completions': jsonResponse(200, { choices: [] }) });

			const error = await rejection(
				endpointChat(endpoint('openai-compatible'), {
					model: 'm',
					messages: [{ role: 'user', content: 'hi' }],
				})
			);

			expect(error.kind).toBe('malformed');
		});
	});

	describe('endpointEmbed', () => {
		it.each(['ollama', 'lmstudio', 'openai-compatible'] as const)(
			'embeds %s input via /v1/embeddings in index order',
			async (kind) => {
				const mock = routeFetch({
					'/v1/embeddings': jsonResponse(200, {
						model: 'nomic-embed-text',
						data: [
							{ index: 1, embedding: [0.3, 0.4] },
							{ index: 0, embedding: [0.1, 0.2] },
						],
					}),
				});

				const result = await endpointEmbed(endpoint(kind), {
					model: 'nomic-embed-text',
					input: ['a', 'b'],
				});

				expect(result).toEqual({
					model: 'nomic-embed-text',
					embeddings: [
						[0.1, 0.2],
						[0.3, 0.4],
					],
				});
				expect(requestBody(mock, 0)).toEqual({ model: 'nomic-embed-text', input: ['a', 'b'] });
			}
		);

		it('falls back to Ollama /api/embed on a 404', async () => {
			const mock = routeFetch({
				'/v1/embeddings': jsonResponse(404, '404 page not found'),
				'/api/embed': jsonResponse(200, { model: 'nomic-embed-text', embeddings: [[1, 2]] }),
			});

			const result = await endpointEmbed(endpoint('ollama'), {
				model: 'nomic-embed-text',
				input: ['a'],
			});

			expect(result.embeddings).toEqual([[1, 2]]);
			expect(mock.mock.calls[1][0]).toBe('http://127.0.0.1:11434/api/embed');
		});

		it('does not fall back for a non-Ollama 404', async () => {
			const mock = routeFetch({ '/v1/embeddings': jsonResponse(404, {}) });

			const error = await rejection(
				endpointEmbed(endpoint('openai-compatible'), { model: 'm', input: ['a'] })
			);

			expect(error.kind).toBe('not-found');
			expect(mock).toHaveBeenCalledTimes(1);
		});

		it('reports a vector count that does not match the input as malformed', async () => {
			routeFetch({
				'/v1/embeddings': jsonResponse(200, { data: [{ index: 0, embedding: [1] }] }),
			});

			const error = await rejection(
				endpointEmbed(endpoint('lmstudio'), { model: 'm', input: ['a', 'b'] })
			);

			expect(error.kind).toBe('malformed');
			expect(error.message).toContain('1 embeddings for 2 inputs');
		});

		it('reports a non-numeric vector as malformed', async () => {
			routeFetch({
				'/v1/embeddings': jsonResponse(200, { data: [{ index: 0, embedding: ['x'] }] }),
			});

			const error = await rejection(
				endpointEmbed(endpoint('lmstudio'), { model: 'm', input: ['a'] })
			);

			expect(error.kind).toBe('malformed');
		});
	});

	describe('detectLocalEndpoints', () => {
		const OLLAMA_TAGS = 'http://127.0.0.1:11434/api/tags';
		const LMSTUDIO_MODELS = 'http://127.0.0.1:1234/v1/models';

		it('finds Ollama and LM Studio on their default loopback ports, with their models', async () => {
			urlFetch({
				[OLLAMA_TAGS]: jsonResponse(200, { models: [{ name: 'llama3.2:3b' }] }),
				[LMSTUDIO_MODELS]: jsonResponse(200, { data: [{ id: 'qwen' }, { id: 'phi' }] }),
			});

			const found = await detectLocalEndpoints([]);

			expect(found).toEqual([
				{
					kind: 'ollama',
					name: 'Ollama',
					baseUrl: 'http://127.0.0.1:11434',
					models: [{ id: 'llama3.2:3b' }],
				},
				{
					kind: 'lmstudio',
					name: 'LM Studio',
					baseUrl: 'http://127.0.0.1:1234',
					models: [{ id: 'qwen' }, { id: 'phi' }],
				},
			]);
		});

		it('probes only loopback, and only the two default routes', async () => {
			const mock = urlFetch({});

			await detectLocalEndpoints([]);

			const probed = mock.mock.calls.map(([url]) => url).sort();
			expect(probed).toEqual([OLLAMA_TAGS, LMSTUDIO_MODELS]);
			for (const url of probed) expect(new URL(url).hostname).toBe('127.0.0.1');
		});

		it('returns nothing when no server is running', async () => {
			urlFetch({});

			await expect(detectLocalEndpoints([])).resolves.toEqual([]);
		});

		it('skips a server that is already configured, under any loopback spelling', async () => {
			const mock = urlFetch({
				[OLLAMA_TAGS]: jsonResponse(200, { models: [] }),
				[LMSTUDIO_MODELS]: jsonResponse(200, { data: [] }),
			});

			const found = await detectLocalEndpoints([{ baseUrl: 'http://localhost:11434/' }]);

			expect(found.map((candidate) => candidate.kind)).toEqual(['lmstudio']);
			// A configured server is not even probed.
			expect(mock.mock.calls.map(([url]) => url)).toEqual([LMSTUDIO_MODELS]);
		});

		it('treats a port that accepts and never answers as nothing there, within the budget', async () => {
			urlFetch({
				[OLLAMA_TAGS]: never,
				[LMSTUDIO_MODELS]: jsonResponse(200, { data: [{ id: 'qwen' }] }),
			});

			const found = await detectLocalEndpoints([], { timeoutMs: 20 });

			expect(found.map((candidate) => candidate.kind)).toEqual(['lmstudio']);
		});

		it('treats a port serving the wrong dialect as nothing there', async () => {
			urlFetch({
				[OLLAMA_TAGS]: jsonResponse(200, { hello: 'world' }),
				[LMSTUDIO_MODELS]: jsonResponse(404, '<html>not found</html>'),
			});

			await expect(detectLocalEndpoints([])).resolves.toEqual([]);
		});
	});

	describe('listEndpointModelsResult', () => {
		it('answers a failure as a serializable result that keeps the kind and status', async () => {
			routeFetch({ '/v1/models': jsonResponse(401, { error: { message: 'bad key' } }) });

			const result = await listEndpointModelsResult(endpoint('openai-compatible'));

			expect(result).toEqual({
				ok: false,
				error: expect.objectContaining({ kind: 'auth', httpStatus: 401 }),
			});
		});
	});

	describe('testEndpoint', () => {
		it('probes Ollama with a small native context instead of its server-wide default', async () => {
			const mock = routeFetch({
				'/api/tags': jsonResponse(200, { models: [{ name: 'llama3.2:3b' }, { name: 'phi' }] }),
				'/api/chat': jsonResponse(200, {
					model: 'llama3.2:3b',
					message: { content: 'OK' },
				}),
			});

			const result = await testEndpoint(endpoint('ollama'));

			expect(result).toEqual({
				ok: true,
				model: 'llama3.2:3b',
				latencyMs: expect.any(Number),
				modelCount: 2,
			});
			expect(mock).toHaveBeenCalledTimes(2);
			expect(requestBody(mock, 1)).toEqual({
				model: 'llama3.2:3b',
				messages: [{ role: 'user', content: 'Reply with OK.' }],
				stream: false,
				think: false,
				options: { num_predict: 1, temperature: 0, num_ctx: 2048 },
			});
		});

		it('probes a named Ollama model without listing or using the compatibility route', async () => {
			const mock = routeFetch({
				'/api/chat': jsonResponse(200, { model: 'phi3:instruct', message: { content: 'OK' } }),
			});

			const result = await testEndpoint(endpoint('ollama'), { model: 'phi3:instruct' });

			expect(result).toEqual({ ok: true, model: 'phi3:instruct', latencyMs: expect.any(Number) });
			expect(mock).toHaveBeenCalledTimes(1);
			expect(requestBody(mock, 0)).toMatchObject({
				model: 'phi3:instruct',
				options: { num_ctx: 2048, num_predict: 1 },
			});
		});

		it('tests the named model without listing', async () => {
			const mock = routeFetch({
				'/v1/chat/completions': jsonResponse(200, {
					model: 'gpt-x',
					choices: [{ message: { content: 'O' } }],
				}),
			});

			const result = await testEndpoint(endpoint('openai-compatible'), { model: 'gpt-x' });

			expect(result).toEqual({ ok: true, model: 'gpt-x', latencyMs: expect.any(Number) });
			expect(mock).toHaveBeenCalledTimes(1);
			expect(requestBody(mock, 0)).toMatchObject({
				max_tokens: 1,
			});
			expect(requestBody(mock, 0)).not.toHaveProperty('chat_template_kwargs');
			expect(requestBody(mock, 0)).not.toHaveProperty('options');
		});

		it('reports a server with no models as no-models instead of guessing one', async () => {
			const mock = routeFetch({ '/v1/models': jsonResponse(200, { data: [] }) });

			const result = await testEndpoint(endpoint('lmstudio'));

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe('no-models');
			expect(result.error.message).toContain('"My lmstudio"');
			expect(mock).toHaveBeenCalledTimes(1);
		});

		it('reports a chat failure with its kind and status', async () => {
			routeFetch({
				'/v1/models': jsonResponse(200, { data: [{ id: 'm' }] }),
				'/v1/chat/completions': jsonResponse(500, { error: 'model failed to load' }),
			});

			const result = await testEndpoint(endpoint('lmstudio'));

			expect(result).toEqual({
				ok: false,
				error: {
					kind: 'http',
					httpStatus: 500,
					message: expect.stringContaining('model failed to load'),
				},
			});
		});

		it('refuses an unset key before sending anything', async () => {
			const mock = routeFetch({});

			const result = await testEndpoint(
				endpoint('openai-compatible', { apiKeyEnvVar: 'LITELLM_KEY' }),
				{ shellEnvVars: {} }
			);

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe('missing-key');
			expect(mock).not.toHaveBeenCalled();
		});
	});
});

describe('endpointTranscribe', () => {
	const WAV = Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4]);

	function requestForm(mock: ReturnType<typeof vi.fn>, call: number): FormData {
		return (mock.mock.calls[call][1] as RequestInit).body as FormData;
	}

	it('uploads the clip as a multipart file and returns the transcript', async () => {
		const mock = routeFetch({
			'/v1/audio/transcriptions': jsonResponse(200, { text: ' Ship it. ' }),
		});

		const result = await endpointTranscribe(endpoint('openai-compatible'), {
			model: 'whisper-1',
			wav: WAV,
			language: 'en',
			prompt: 'Pedro Sidián, Maestro',
		});

		// Raw: sanitizing is the speech-to-text service's job, not the transport's.
		expect(result).toEqual({ text: ' Ship it. ' });
		const form = requestForm(mock, 0);
		expect(form.get('model')).toBe('whisper-1');
		expect(form.get('response_format')).toBe('json');
		expect(form.get('language')).toBe('en');
		expect(form.get('prompt')).toBe('Pedro Sidián, Maestro');
		const file = form.get('file') as File;
		expect(file.name).toBe('clip.wav');
		expect(file.type).toBe('audio/wav');
		expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(Array.from(WAV));
		// fetch writes the multipart boundary itself; a JSON content type would
		// make the server reject the upload.
		expect(requestHeaders(mock, 0)['Content-Type']).toBeUndefined();
	});

	it('uploads only the clip when the WAV is a view over a larger buffer', async () => {
		const mock = routeFetch({
			'/v1/audio/transcriptions': jsonResponse(200, { text: 'ok' }),
		});
		const backing = Uint8Array.from([9, 9, 9, 1, 2, 3, 9, 9]);

		await endpointTranscribe(endpoint('openai-compatible'), {
			model: 'whisper-1',
			wav: backing.subarray(3, 6),
		});

		const file = requestForm(mock, 0).get('file') as File;
		expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3]);
	});

	it('sends the API key resolved from Settings -> Environment', async () => {
		const mock = routeFetch({
			'/v1/audio/transcriptions': jsonResponse(200, { text: 'ok' }),
		});

		await endpointTranscribe(endpoint('openai-compatible', { apiKeyEnvVar: 'SPEECH_KEY' }), {
			model: 'whisper-1',
			wav: WAV,
			shellEnvVars: { SPEECH_KEY: 'secret' },
		});

		expect(requestHeaders(mock, 0).Authorization).toBe('Bearer secret');
	});

	it('says an endpoint without the route does not offer speech-to-text', async () => {
		routeFetch({
			'/v1/audio/transcriptions': jsonResponse(404, '404 page not found'),
		});

		const error = await endpointTranscribe(endpoint('ollama'), {
			model: 'whisper-1',
			wav: WAV,
		}).catch((caught) => caught);

		expect(isLocalModelEndpointError(error)).toBe(true);
		expect(error).toMatchObject({ kind: 'not-found', httpStatus: 404 });
		expect((error as Error).message).toMatch(/does not offer speech-to-text/);
		expect((error as Error).message).toContain('My ollama');
	});

	it('passes any other failure through as the server reported it', async () => {
		routeFetch({
			'/v1/audio/transcriptions': jsonResponse(401, { error: { message: 'bad key' } }),
		});

		await expect(
			endpointTranscribe(endpoint('openai-compatible'), { model: 'whisper-1', wav: WAV })
		).rejects.toMatchObject({ kind: 'auth', httpStatus: 401 });
	});

	it('refuses an answer with no transcript in it', async () => {
		routeFetch({
			'/v1/audio/transcriptions': jsonResponse(200, { segments: [] }),
		});

		await expect(
			endpointTranscribe(endpoint('openai-compatible'), { model: 'whisper-1', wav: WAV })
		).rejects.toMatchObject({ kind: 'malformed' });
	});
});
