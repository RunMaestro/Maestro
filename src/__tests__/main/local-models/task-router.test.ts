/**
 * @file task-router.test.ts
 *
 * The Local Models task router, with `generateText` and the stats database
 * mocked. Properties worth protecting:
 *
 *   - **Every assignment branch answers as itself.** `off` and `utility-agent`
 *     never touch a model; `local` and `endpoint` call `generateText` with the
 *     source the user picked.
 *   - **No fallback.** A source that cannot run is reported `unavailable`,
 *     naming it, and nothing else is tried.
 *   - **Every call that reaches a model is recorded**, success or failure, and a
 *     stats failure never turns a good run into a bad one.
 *   - **The Maestro model server is one source.** A run it answered is filed as
 *     `server` whichever way the assignment named it, on success, on failure
 *     and on a cancel, and a run the in-process engine answered never is.
 *   - **A run names its agent when the caller knows one**, and the agent is
 *     never handed to a model.
 *   - **Untrusted requests are checked once**, for IPC and the CLI bridge alike.
 *   - **Interactive calls are countable.** Background work (the semantic
 *     indexer) can tell when someone is waiting on a model, and its own calls
 *     never count as that.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => new Map<string, unknown>());
const stats = vi.hoisted(() => ({
	ready: true,
	recordLocalModelRun: vi.fn((_run: unknown) => 'id'),
}));
const generate = vi.hoisted(() => ({ generateText: vi.fn() }));
const embed = vi.hoisted(() => ({ embedTexts: vi.fn() }));
const classify = vi.hoisted(() => ({ classifyText: vi.fn() }));
const speech = vi.hoisted(() => ({ transcribeSpeech: vi.fn() }));
const router = vi.hoisted(() => ({ route: vi.fn() }));

vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
	}),
}));

vi.mock('../../../main/stats/singleton', () => ({
	getStatsDB: () => ({
		isReady: () => stats.ready,
		recordLocalModelRun: stats.recordLocalModelRun,
	}),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
}));

vi.mock('../../../main/local-models/text-gen', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/local-models/text-gen')>()),
	generateText: generate.generateText,
}));

vi.mock('../../../main/local-models/embeddings', () => ({
	embedTexts: embed.embedTexts,
}));

vi.mock('../../../main/local-models/classifier', () => ({
	classifyText: classify.classifyText,
}));

vi.mock('../../../main/local-models/speech-to-text', () => ({
	transcribeSpeech: speech.transcribeSpeech,
}));

vi.mock('../../../main/local-models/model-router', () => ({
	getEmbeddingRouter: () => ({ route: router.route }),
}));

import {
	DEFAULT_TASK_MAX_TOKENS,
	isInteractiveLocalTaskRunning,
	localModelRunSourceType,
	parseLocalTaskInput,
	runClassifierTask,
	runEmbeddingRouteTask,
	runEmbeddingTask,
	runLocalTask,
	runLocalTaskRequest,
	runSpeechToTextTask,
	whenNoInteractiveLocalTask,
} from '../../../main/local-models/task-router';
import { LocalModelEndpointError, LocalModelError } from '../../../main/local-models/errors';
import { captureException } from '../../../main/utils/sentry';
import {
	BGE_SMALL_EN_ID,
	PARAKEET_TDT_V2_ID,
	PROMPT_GUARD_2_22M_ID,
	QWEN3_1_7B_ID,
} from '../../../shared/local-models/model-catalog';
import { MODEL_SERVER_ENDPOINT_ID } from '../../../shared/local-models/model-server';

const LOCAL = { type: 'local', modelId: QWEN3_1_7B_ID } as const;
const ENDPOINT = { type: 'endpoint', endpointId: 'ep-1', model: 'llama3.2' } as const;
const SERVER_ENDPOINT = {
	type: 'endpoint',
	endpointId: MODEL_SERVER_ENDPOINT_ID,
	model: QWEN3_1_7B_ID,
} as const;

/** What a call to the model server fails with: an endpoint error naming the server. */
function serverError(kind: 'network' | 'cancelled'): LocalModelEndpointError {
	return new LocalModelEndpointError('The Maestro model server did not answer.', {
		kind,
		endpointId: MODEL_SERVER_ENDPOINT_ID,
		endpointName: 'Maestro model server',
		url: 'http://127.0.0.1:41234',
	});
}

function assign(taskId: string, assignment: unknown): void {
	settings.set('localModelAssignments', { [taskId]: assignment });
}

function okReply(source: unknown, extra: Record<string, unknown> = {}) {
	return { text: 'Fix login timeout', source, durationMs: 420, ...extra };
}

function recorded(): Record<string, unknown> {
	expect(stats.recordLocalModelRun).toHaveBeenCalledTimes(1);
	return stats.recordLocalModelRun.mock.calls[0][0] as Record<string, unknown>;
}

describe('runLocalTask', () => {
	beforeEach(() => {
		settings.clear();
		stats.ready = true;
		stats.recordLocalModelRun.mockReset().mockReturnValue('id');
		generate.generateText.mockReset();
		vi.mocked(captureException).mockClear();
	});

	describe('assignments that run no model', () => {
		it('answers off for a new task on its default, and records nothing', async () => {
			await expect(runLocalTask('git-drafts', { prompt: 'diff' })).resolves.toEqual({
				status: 'off',
			});
			expect(generate.generateText).not.toHaveBeenCalled();
			expect(stats.recordLocalModelRun).not.toHaveBeenCalled();
		});

		it('answers off when the user switched a Utility Agent task off', async () => {
			assign('tab-naming', { type: 'off' });
			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toEqual({
				status: 'off',
			});
		});

		it('hands a Utility Agent task back to its caller without spawning anything', async () => {
			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toEqual({
				status: 'use-utility-agent',
			});
			expect(generate.generateText).not.toHaveBeenCalled();
			expect(stats.recordLocalModelRun).not.toHaveBeenCalled();
		});

		it('refuses a task that is not text generation (a caller bug)', async () => {
			await expect(runLocalTask('semantic-search', { prompt: 'x' })).rejects.toThrow(
				/embedding task/
			);
		});
	});

	describe('the shared utility source', () => {
		it.each(['tab-naming', 'tab-summary', 'ai-command'] as const)(
			'runs inherited %s on the shared local model and records the actual source',
			async (taskId) => {
				settings.set('utilitySource', LOCAL);
				generate.generateText.mockResolvedValue(okReply(LOCAL));
				await expect(runLocalTask(taskId, { prompt: 'hi' })).resolves.toMatchObject({
					status: 'ok',
					source: LOCAL,
				});
				expect(generate.generateText).toHaveBeenCalledWith(
					expect.objectContaining({ source: LOCAL })
				);
				expect(recorded()).toMatchObject({ taskId, modelId: LOCAL.modelId, sourceType: 'local' });
			}
		);

		it('uses the shared endpoint until a task overrides it', async () => {
			settings.set('utilitySource', ENDPOINT);
			generate.generateText.mockResolvedValue(okReply(ENDPOINT));
			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toMatchObject({
				status: 'ok',
				source: ENDPOINT,
			});
			assign('tab-naming', LOCAL);
			generate.generateText.mockResolvedValue(okReply(LOCAL));
			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toMatchObject({
				status: 'ok',
				source: LOCAL,
			});
			assign('tab-naming', { type: 'off' });
			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toEqual({
				status: 'off',
			});
		});

		it('reports an inherited endpoint failure without handing work to a provider', async () => {
			settings.set('utilitySource', SERVER_ENDPOINT);
			generate.generateText.mockRejectedValue(serverError('network'));
			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toMatchObject({
				status: 'unavailable',
				source: SERVER_ENDPOINT,
				code: 'network',
			});
			expect(generate.generateText).toHaveBeenCalledTimes(1);
		});
	});

	describe('a local assignment', () => {
		beforeEach(() => assign('tab-naming', { type: 'local', modelId: QWEN3_1_7B_ID }));

		it('generates on the assigned model with the default budget and records the run', async () => {
			generate.generateText.mockResolvedValue(okReply(LOCAL, { tokensIn: 40, tokensOut: 6 }));

			const result = await runLocalTask('tab-naming', { prompt: 'hi' });

			expect(generate.generateText).toHaveBeenCalledWith({
				source: LOCAL,
				prompt: 'hi',
				maxTokens: DEFAULT_TASK_MAX_TOKENS,
			});
			expect(result).toEqual({
				status: 'ok',
				text: 'Fix login timeout',
				source: LOCAL,
				durationMs: 420,
				tokensIn: 40,
				tokensOut: 6,
			});
			expect(recorded()).toMatchObject({
				taskId: 'tab-naming',
				sourceType: 'local',
				modelId: QWEN3_1_7B_ID,
				durationMs: 420,
				outcome: 'ok',
				tokensIn: 40,
				tokensOut: 6,
			});
			expect(recorded()).not.toHaveProperty('endpointId');
		});

		it('reports a model that is not downloaded as unavailable, naming it, and tries nothing else', async () => {
			generate.generateText.mockRejectedValue(
				new LocalModelError('Qwen3 1.7B is not downloaded.', {
					code: 'model-not-installed',
					recovery: 'Download it in Settings -> Local Models.',
					consumerId: 'text-gen',
				})
			);

			const result = await runLocalTask('tab-naming', { prompt: 'hi' });

			expect(result).toEqual({
				status: 'unavailable',
				source: LOCAL,
				reason: 'Qwen3 1.7B is not downloaded. Download it in Settings -> Local Models.',
				code: 'model-not-installed',
			});
			expect(generate.generateText).toHaveBeenCalledTimes(1);
			expect(recorded()).toMatchObject({ outcome: 'error', errorCode: 'model-not-installed' });
		});

		it('reports a cancellation as cancelled, not as a failure', async () => {
			generate.generateText.mockRejectedValue(
				new LocalModelError('The request was cancelled.', {
					code: 'cancelled',
					recovery: 'Nothing to do.',
					consumerId: 'text-gen',
				})
			);

			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toEqual({
				status: 'cancelled',
				source: LOCAL,
			});
			expect(recorded()).toMatchObject({ outcome: 'cancelled', errorCode: 'cancelled' });
		});

		it('rethrows an unclassified failure (a bug) after recording it', async () => {
			generate.generateText.mockRejectedValue(new TypeError('boom'));

			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).rejects.toThrow('boom');
			expect(recorded()).toMatchObject({ outcome: 'error', errorCode: 'unexpected' });
		});
	});

	describe('an endpoint assignment', () => {
		beforeEach(() =>
			assign('git-drafts', { type: 'endpoint', endpointId: 'ep-1', model: 'llama3.2' })
		);

		it('passes the caller options through and returns the parsed JSON', async () => {
			const schema = { type: 'object' };
			generate.generateText.mockResolvedValue(okReply(ENDPOINT, { json: { title: 't' } }));

			const result = await runLocalTask('git-drafts', {
				prompt: 'diff',
				system: 'Write a commit message.',
				maxTokens: 64,
				temperature: 0.2,
				jsonSchema: schema,
			});

			expect(generate.generateText).toHaveBeenCalledWith({
				source: ENDPOINT,
				prompt: 'diff',
				system: 'Write a commit message.',
				maxTokens: 64,
				temperature: 0.2,
				jsonSchema: schema,
			});
			expect(result).toMatchObject({ status: 'ok', json: { title: 't' }, source: ENDPOINT });
			expect(recorded()).toMatchObject({
				sourceType: 'endpoint',
				modelId: 'llama3.2',
				endpointId: 'ep-1',
				outcome: 'ok',
			});
		});

		it('reports a server that is down as unavailable with its kind', async () => {
			generate.generateText.mockRejectedValue(
				new LocalModelEndpointError('Ollama is not reachable at http://127.0.0.1:11434.', {
					kind: 'network',
					endpointId: 'ep-1',
					endpointName: 'Ollama',
					url: 'http://127.0.0.1:11434',
				})
			);

			await expect(runLocalTask('git-drafts', { prompt: 'diff' })).resolves.toEqual({
				status: 'unavailable',
				source: ENDPOINT,
				reason: 'Ollama is not reachable at http://127.0.0.1:11434.',
				code: 'network',
			});
			expect(recorded()).toMatchObject({ outcome: 'error', errorCode: 'network' });
		});

		it('treats an endpoint abort as a cancellation', async () => {
			generate.generateText.mockRejectedValue(
				new LocalModelEndpointError('Cancelled.', {
					kind: 'cancelled',
					endpointId: 'ep-1',
					endpointName: 'Ollama',
					url: '',
				})
			);

			await expect(runLocalTask('git-drafts', { prompt: 'diff' })).resolves.toEqual({
				status: 'cancelled',
				source: ENDPOINT,
			});
			// A saved endpoint stays an endpoint, whatever its call ended as.
			expect(recorded()).toMatchObject({
				sourceType: 'endpoint',
				endpointId: 'ep-1',
				outcome: 'cancelled',
			});
		});
	});

	describe('the Maestro model server', () => {
		describe('answering for a local assignment it already holds', () => {
			beforeEach(() => assign('tab-naming', { type: 'local', modelId: QWEN3_1_7B_ID }));

			it('files the run as server, and still answers with the source that was assigned', async () => {
				generate.generateText.mockResolvedValue(
					okReply(LOCAL, { servedByModelServer: true, tokensIn: 40, tokensOut: 6 })
				);

				const result = await runLocalTask('tab-naming', { prompt: 'hi' });

				expect(result).toMatchObject({ status: 'ok', source: LOCAL });
				expect(recorded()).toMatchObject({
					taskId: 'tab-naming',
					sourceType: 'server',
					modelId: QWEN3_1_7B_ID,
					outcome: 'ok',
					tokensIn: 40,
					tokensOut: 6,
				});
				// The source type names the server; there is no saved endpoint to name.
				expect(recorded()).not.toHaveProperty('endpointId');
			});

			it('files a failed call to the server as server, not as an in-process failure', async () => {
				generate.generateText.mockRejectedValue(serverError('network'));

				await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toMatchObject({
					status: 'unavailable',
					source: LOCAL,
					code: 'network',
				});
				expect(recorded()).toMatchObject({
					sourceType: 'server',
					modelId: QWEN3_1_7B_ID,
					outcome: 'error',
					errorCode: 'network',
				});
			});

			it('files a call to the server the caller cancelled as server', async () => {
				generate.generateText.mockRejectedValue(serverError('cancelled'));

				await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toEqual({
					status: 'cancelled',
					source: LOCAL,
				});
				expect(recorded()).toMatchObject({ sourceType: 'server', outcome: 'cancelled' });
			});

			it('keeps a run the in-process engine answered, failed or cancelled as local', async () => {
				const inProcess = [
					() => generate.generateText.mockResolvedValue(okReply(LOCAL)),
					() =>
						generate.generateText.mockRejectedValue(
							new LocalModelError('Qwen3 1.7B could not be opened.', {
								code: 'generation-failed',
								recovery: 'Verify it.',
								consumerId: 'text-gen',
							})
						),
					() =>
						generate.generateText.mockRejectedValue(
							new LocalModelError('The request was cancelled.', {
								code: 'cancelled',
								recovery: 'Nothing to do.',
								consumerId: 'text-gen',
							})
						),
					() => generate.generateText.mockRejectedValue(new TypeError('boom')),
				];
				for (const arrange of inProcess) {
					stats.recordLocalModelRun.mockClear();
					arrange();
					await runLocalTask('tab-naming', { prompt: 'hi' }).catch(() => undefined);
					expect(recorded()).toMatchObject({ sourceType: 'local', modelId: QWEN3_1_7B_ID });
				}
			});
		});

		describe('assigned as an endpoint', () => {
			beforeEach(() => assign('git-drafts', SERVER_ENDPOINT));

			it('files the run as server, with no endpoint id', async () => {
				generate.generateText.mockResolvedValue(okReply(SERVER_ENDPOINT));

				const result = await runLocalTask('git-drafts', { prompt: 'diff' });

				expect(result).toMatchObject({ status: 'ok', source: SERVER_ENDPOINT });
				expect(recorded()).toMatchObject({
					sourceType: 'server',
					modelId: QWEN3_1_7B_ID,
					outcome: 'ok',
				});
				expect(recorded()).not.toHaveProperty('endpointId');
			});

			it('files a server that would not start as a server error', async () => {
				generate.generateText.mockRejectedValue(serverError('network'));

				await runLocalTask('git-drafts', { prompt: 'diff' });

				expect(recorded()).toMatchObject({
					sourceType: 'server',
					outcome: 'error',
					errorCode: 'network',
				});
				expect(recorded()).not.toHaveProperty('endpointId');
			});
		});

		it('reads the source type from the source and where the call ran', () => {
			expect(localModelRunSourceType(LOCAL)).toBe('local');
			expect(localModelRunSourceType(LOCAL, false)).toBe('local');
			expect(localModelRunSourceType(LOCAL, true)).toBe('server');
			expect(localModelRunSourceType(ENDPOINT)).toBe('endpoint');
			// A saved endpoint is never the server, whatever a caller claims.
			expect(localModelRunSourceType(ENDPOINT, true)).toBe('endpoint');
			expect(localModelRunSourceType(SERVER_ENDPOINT)).toBe('server');
			expect(localModelRunSourceType(SERVER_ENDPOINT, false)).toBe('server');
		});
	});

	describe('the agent a run is for', () => {
		beforeEach(() => assign('tab-naming', { type: 'local', modelId: QWEN3_1_7B_ID }));

		it('is kept on the run and never handed to the model', async () => {
			generate.generateText.mockResolvedValue(okReply(LOCAL));

			await runLocalTask('tab-naming', { prompt: 'hi', agentId: 'agent-1' });

			expect(recorded()).toMatchObject({ agentId: 'agent-1', outcome: 'ok' });
			expect(generate.generateText).toHaveBeenCalledWith({
				source: LOCAL,
				prompt: 'hi',
				maxTokens: DEFAULT_TASK_MAX_TOKENS,
			});
		});

		it('is kept on a run that failed', async () => {
			generate.generateText.mockRejectedValue(serverError('network'));

			await runLocalTask('tab-naming', { prompt: 'hi', agentId: 'agent-1' });

			expect(recorded()).toMatchObject({ agentId: 'agent-1', outcome: 'error' });
		});

		it('is left out when the caller knows none', async () => {
			generate.generateText.mockResolvedValue(okReply(LOCAL));

			await runLocalTask('tab-naming', { prompt: 'hi' });

			expect(recorded()).not.toHaveProperty('agentId');
		});
	});

	describe('recording', () => {
		beforeEach(() => {
			assign('tab-naming', { type: 'local', modelId: QWEN3_1_7B_ID });
			generate.generateText.mockResolvedValue(okReply(LOCAL));
		});

		it('records nothing when usage statistics are switched off', async () => {
			settings.set('statsCollectionEnabled', false);
			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toMatchObject({
				status: 'ok',
			});
			expect(stats.recordLocalModelRun).not.toHaveBeenCalled();
		});

		it('skips quietly when the stats database is not ready', async () => {
			stats.ready = false;
			await runLocalTask('tab-naming', { prompt: 'hi' });
			expect(stats.recordLocalModelRun).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
		});

		it('never lets a stats failure fail the task, and reports it', async () => {
			stats.recordLocalModelRun.mockImplementation(() => {
				throw new Error('disk I/O error');
			});

			await expect(runLocalTask('tab-naming', { prompt: 'hi' })).resolves.toMatchObject({
				status: 'ok',
			});
			expect(captureException).toHaveBeenCalledTimes(1);
		});
	});
});

describe('runEmbeddingTask', () => {
	const BGE = { type: 'local', modelId: BGE_SMALL_EN_ID } as const;
	const NOMIC = { type: 'endpoint', endpointId: 'ep-1', model: 'nomic-embed-text' } as const;

	beforeEach(() => {
		settings.clear();
		stats.ready = true;
		stats.recordLocalModelRun.mockReset().mockReturnValue('id');
		embed.embedTexts.mockReset();
	});

	it('answers off on the default assignment and embeds nothing', async () => {
		await expect(
			runEmbeddingTask('semantic-search', { texts: ['a'], mode: 'query' })
		).resolves.toEqual({ status: 'off' });
		expect(embed.embedTexts).not.toHaveBeenCalled();
		expect(stats.recordLocalModelRun).not.toHaveBeenCalled();
	});

	it('embeds on the assigned local model with the mode, and records the run', async () => {
		assign('semantic-search', { type: 'local', modelId: BGE_SMALL_EN_ID });
		const vectors = [new Float32Array([1, 0])];
		embed.embedTexts.mockResolvedValue(vectors);

		const result = await runEmbeddingTask('semantic-search', {
			texts: ['how do I rename a tab'],
			mode: 'query',
		});

		expect(embed.embedTexts).toHaveBeenCalledWith(BGE, ['how do I rename a tab'], {
			mode: 'query',
		});
		expect(result).toMatchObject({ status: 'ok', vectors, source: BGE });
		expect(recorded()).toMatchObject({
			taskId: 'semantic-search',
			sourceType: 'local',
			modelId: BGE_SMALL_EN_ID,
			outcome: 'ok',
		});
	});

	it('embeds on an endpoint and reports a down server as unavailable, trying nothing else', async () => {
		assign('semantic-search', NOMIC);
		embed.embedTexts.mockRejectedValue(
			new LocalModelEndpointError('Ollama is not reachable.', {
				kind: 'network',
				endpointId: 'ep-1',
				endpointName: 'Ollama',
				url: 'http://127.0.0.1:11434',
			})
		);

		await expect(
			runEmbeddingTask('semantic-search', { texts: ['a'], mode: 'document' })
		).resolves.toEqual({
			status: 'unavailable',
			source: NOMIC,
			reason: 'Ollama is not reachable.',
			code: 'network',
		});
		expect(embed.embedTexts).toHaveBeenCalledTimes(1);
		expect(recorded()).toMatchObject({ outcome: 'error', errorCode: 'network' });
	});

	it('reports a cancellation as cancelled', async () => {
		assign('semantic-search', { type: 'local', modelId: BGE_SMALL_EN_ID });
		embed.embedTexts.mockRejectedValue(
			new LocalModelError('The request was cancelled.', {
				code: 'cancelled',
				recovery: 'Nothing to do.',
				consumerId: 'embeddings',
			})
		);

		await expect(
			runEmbeddingTask('semantic-search', { texts: ['a'], mode: 'query' })
		).resolves.toEqual({ status: 'cancelled', source: BGE });
	});

	it('refuses a task that is not an embedding task (a caller bug)', async () => {
		await expect(runEmbeddingTask('tab-naming', { texts: ['a'], mode: 'query' })).rejects.toThrow(
			/text-gen task/
		);
	});
});

describe('runEmbeddingRouteTask', () => {
	const BGE = { type: 'local', modelId: BGE_SMALL_EN_ID } as const;
	const DECISION = {
		tier: 'medium',
		effort: 'low',
		tierConfidence: 0.6,
		effortConfidence: 0.2,
		neighbours: [],
		exampleCount: 57,
		source: BGE,
	};

	beforeEach(() => {
		settings.clear();
		stats.ready = true;
		stats.recordLocalModelRun.mockReset().mockReturnValue('id');
		router.route.mockReset();
	});

	it('answers off on the default assignment and routes nothing', async () => {
		await expect(runEmbeddingRouteTask('model-routing', { text: 'rename it' })).resolves.toEqual({
			status: 'off',
		});
		expect(router.route).not.toHaveBeenCalled();
		expect(stats.recordLocalModelRun).not.toHaveBeenCalled();
	});

	it('routes on the assigned embedding model, passes the signal, and records the run', async () => {
		assign('model-routing', BGE);
		router.route.mockResolvedValue(DECISION);
		const signal = new AbortController().signal;

		const result = await runEmbeddingRouteTask('model-routing', { text: 'rename it', signal });

		expect(router.route).toHaveBeenCalledWith(BGE, 'rename it', { signal });
		expect(result).toMatchObject({ status: 'ok', decision: DECISION, source: BGE });
		expect(recorded()).toMatchObject({
			taskId: 'model-routing',
			sourceType: 'local',
			modelId: BGE_SMALL_EN_ID,
			outcome: 'ok',
		});
		expect(recorded()).not.toHaveProperty('agentId');
	});

	it('keeps the agent whose turn was routed on the run, and not on the router call', async () => {
		assign('model-routing', BGE);
		router.route.mockResolvedValue(DECISION);

		await runEmbeddingRouteTask('model-routing', { text: 'rename it', agentId: 'agent-1' });

		expect(router.route).toHaveBeenCalledWith(BGE, 'rename it', {});
		expect(recorded()).toMatchObject({ taskId: 'model-routing', agentId: 'agent-1' });
	});

	it('reports a model that is not downloaded as unavailable, and asks nothing else', async () => {
		assign('model-routing', BGE);
		router.route.mockRejectedValue(
			new LocalModelError('bge-small is not downloaded.', {
				code: 'model-not-installed',
				recovery: 'Download it in Settings.',
				consumerId: 'embeddings',
			})
		);

		await expect(runEmbeddingRouteTask('model-routing', { text: 'rename it' })).resolves.toEqual({
			status: 'unavailable',
			source: BGE,
			reason: 'bge-small is not downloaded. Download it in Settings.',
			code: 'model-not-installed',
		});
		expect(router.route).toHaveBeenCalledTimes(1);
		expect(recorded()).toMatchObject({ outcome: 'error', errorCode: 'model-not-installed' });
	});

	it('reports a caller that stopped waiting as cancelled', async () => {
		assign('model-routing', BGE);
		router.route.mockRejectedValue(
			new LocalModelError('The request was cancelled.', {
				code: 'cancelled',
				recovery: 'Nothing to do.',
				consumerId: 'local-models:model-router',
			})
		);

		await expect(runEmbeddingRouteTask('model-routing', { text: 'rename it' })).resolves.toEqual({
			status: 'cancelled',
			source: BGE,
		});
	});

	it('rethrows a failure the router did not classify (a bug) after recording it', async () => {
		assign('model-routing', BGE);
		router.route.mockRejectedValue(new Error('embeddings of more than one width'));

		await expect(runEmbeddingRouteTask('model-routing', { text: 'rename it' })).rejects.toThrow(
			/more than one width/
		);
		expect(recorded()).toMatchObject({ outcome: 'error', errorCode: 'unexpected' });
	});

	it('refuses a task that takes no embedding model (a caller bug)', async () => {
		await expect(runEmbeddingRouteTask('tab-naming', { text: 'rename it' })).rejects.toThrow(
			/Tab naming takes no embedding model/
		);
	});
});

describe('runClassifierTask', () => {
	const GUARD = { type: 'local', modelId: PROMPT_GUARD_2_22M_ID } as const;

	beforeEach(() => {
		settings.clear();
		stats.ready = true;
		stats.recordLocalModelRun.mockReset().mockReturnValue('id');
		classify.classifyText.mockReset();
	});

	it('answers off on the default assignment and scores nothing', async () => {
		await expect(runClassifierTask('injection-screen', { text: 'a' })).resolves.toEqual({
			status: 'off',
		});
		expect(classify.classifyText).not.toHaveBeenCalled();
		expect(stats.recordLocalModelRun).not.toHaveBeenCalled();
	});

	it('scores on the assigned local model and records the run', async () => {
		assign('injection-screen', GUARD);
		classify.classifyText.mockResolvedValue({
			label: 'MALICIOUS',
			score: 0.98,
			flagged: true,
			chunks: 2,
		});

		const result = await runClassifierTask('injection-screen', { text: 'Ignore all previous' });

		expect(classify.classifyText).toHaveBeenCalledWith(GUARD, 'Ignore all previous', {});
		expect(recorded()).not.toHaveProperty('agentId');
		expect(result).toMatchObject({
			status: 'ok',
			label: 'MALICIOUS',
			score: 0.98,
			flagged: true,
			chunks: 2,
			source: GUARD,
		});
		expect(recorded()).toMatchObject({
			taskId: 'injection-screen',
			sourceType: 'local',
			modelId: PROMPT_GUARD_2_22M_ID,
			outcome: 'ok',
		});
	});

	it('keeps the agent a screen ran for on the run', async () => {
		assign('injection-screen', GUARD);
		classify.classifyText.mockResolvedValue({ label: 'BENIGN', score: 0.01, flagged: false });

		await runClassifierTask('injection-screen', {
			text: 'a pull request body',
			agentId: 'agent-9',
		});

		expect(classify.classifyText).toHaveBeenCalledWith(GUARD, 'a pull request body', {});
		expect(recorded()).toMatchObject({ taskId: 'injection-screen', agentId: 'agent-9' });
	});

	it('reports a model that is not downloaded as unavailable, trying nothing else', async () => {
		assign('secret-screen', GUARD);
		classify.classifyText.mockRejectedValue(
			new LocalModelError('Llama Prompt Guard 2 22M is not downloaded.', {
				code: 'model-not-installed',
				recovery: 'Download it in Settings.',
				consumerId: 'local-models:classifier',
			})
		);

		await expect(runClassifierTask('secret-screen', { text: 'a' })).resolves.toEqual({
			status: 'unavailable',
			source: GUARD,
			reason: 'Llama Prompt Guard 2 22M is not downloaded. Download it in Settings.',
			code: 'model-not-installed',
		});
		expect(classify.classifyText).toHaveBeenCalledTimes(1);
		expect(recorded()).toMatchObject({ outcome: 'error', errorCode: 'model-not-installed' });
	});

	it('refuses a task that is not a classifier task (a caller bug)', async () => {
		await expect(runClassifierTask('semantic-search', { text: 'a' })).rejects.toThrow(
			/embedding task/
		);
	});
});

describe('runLocalTaskRequest / parseLocalTaskInput', () => {
	beforeEach(() => {
		settings.clear();
		generate.generateText.mockReset();
	});

	it('refuses an unknown task id', async () => {
		await expect(runLocalTaskRequest('tab-nameing', { prompt: 'x' })).rejects.toThrow(
			'Unknown task "tab-nameing".'
		);
	});

	it('runs a valid request through the router', async () => {
		await expect(runLocalTaskRequest('tab-naming', { prompt: 'x' })).resolves.toEqual({
			status: 'use-utility-agent',
		});
	});

	it('accepts the full input shape', () => {
		expect(
			parseLocalTaskInput({
				prompt: 'p',
				system: 's',
				maxTokens: 10,
				temperature: 0,
				jsonSchema: { type: 'object' },
				ignored: true,
			})
		).toEqual({
			prompt: 'p',
			system: 's',
			maxTokens: 10,
			temperature: 0,
			jsonSchema: { type: 'object' },
		});
	});

	it.each([
		[null, /object with a prompt/],
		[{ prompt: '  ' }, /non-empty prompt/],
		[{ prompt: 'p', system: 3 }, /system/],
		[{ prompt: 'p', maxTokens: 0 }, /maxTokens/],
		[{ prompt: 'p', maxTokens: 1.5 }, /maxTokens/],
		[{ prompt: 'p', maxTokens: 100_000 }, /maxTokens/],
		[{ prompt: 'p', temperature: 3 }, /temperature/],
		[{ prompt: 'p', temperature: Number.NaN }, /temperature/],
		[{ prompt: 'p', jsonSchema: [] }, /jsonSchema/],
	])('refuses %j', (input, message) => {
		expect(() => parseLocalTaskInput(input)).toThrow(message);
	});
});

describe('interactive call tracking', () => {
	const BGE = { type: 'local', modelId: BGE_SMALL_EN_ID } as const;

	/** A promise whose settlement the test controls. */
	function deferred<T>() {
		let resolve!: (value: T) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	}

	beforeEach(() => {
		settings.clear();
		stats.ready = true;
		stats.recordLocalModelRun.mockReset().mockReturnValue('id');
		embed.embedTexts.mockReset();
		assign('semantic-search', BGE);
	});

	it('reports a call someone is waiting on for exactly as long as it runs', async () => {
		const call = deferred<Float32Array[]>();
		embed.embedTexts.mockReturnValue(call.promise);
		expect(isInteractiveLocalTaskRunning()).toBe(false);

		const running = runEmbeddingTask('semantic-search', { texts: ['q'], mode: 'query' });
		expect(isInteractiveLocalTaskRunning()).toBe(true);

		let idle = false;
		void whenNoInteractiveLocalTask().then(() => {
			idle = true;
		});
		await Promise.resolve();
		expect(idle).toBe(false);

		call.resolve([new Float32Array([1, 0])]);
		await running;
		await Promise.resolve();
		expect(isInteractiveLocalTaskRunning()).toBe(false);
		expect(idle).toBe(true);
	});

	it('does not count a background call, so background work never waits on itself', async () => {
		const call = deferred<Float32Array[]>();
		embed.embedTexts.mockReturnValue(call.promise);

		const running = runEmbeddingTask('semantic-search', {
			texts: ['a document'],
			mode: 'document',
			background: true,
		});
		expect(isInteractiveLocalTaskRunning()).toBe(false);
		await expect(whenNoInteractiveLocalTask()).resolves.toBeUndefined();

		call.resolve([new Float32Array([1, 0])]);
		await expect(running).resolves.toMatchObject({ status: 'ok' });
	});

	it('does not count a text task marked background (a Computer History digest)', async () => {
		assign('history-digests', LOCAL);
		const call = deferred<ReturnType<typeof okReply>>();
		generate.generateText.mockReset().mockReturnValue(call.promise);

		const running = runLocalTask('history-digests', { prompt: 'a window', background: true });
		expect(isInteractiveLocalTaskRunning()).toBe(false);
		// The flag is the router's own: the model is never handed it.
		expect(generate.generateText.mock.calls[0][0]).not.toHaveProperty('background');

		call.resolve(okReply(LOCAL));
		await expect(running).resolves.toMatchObject({ status: 'ok' });
	});

	it('releases the count when the call fails', async () => {
		embed.embedTexts.mockRejectedValue(
			new LocalModelError('bge is not downloaded.', {
				code: 'model-not-installed',
				recovery: 'Download it.',
				consumerId: 'test',
			})
		);
		await expect(
			runEmbeddingTask('semantic-search', { texts: ['q'], mode: 'query' })
		).resolves.toMatchObject({ status: 'unavailable' });
		expect(isInteractiveLocalTaskRunning()).toBe(false);
	});

	it('answers a task that is off without ever counting as running', async () => {
		settings.clear();
		await runEmbeddingTask('semantic-search', { texts: ['q'], mode: 'query' });
		expect(isInteractiveLocalTaskRunning()).toBe(false);
		expect(embed.embedTexts).not.toHaveBeenCalled();
	});
});

describe('runSpeechToTextTask', () => {
	const PARAKEET = { type: 'local', modelId: PARAKEET_TDT_V2_ID } as const;
	const WHISPER_SERVER = { type: 'endpoint', endpointId: 'ep-1', model: 'whisper-1' } as const;
	const clip = new Float32Array(16000);

	beforeEach(() => {
		settings.clear();
		stats.ready = true;
		stats.recordLocalModelRun.mockReset().mockReturnValue('id');
		speech.transcribeSpeech.mockReset();
	});

	it('answers off on the default assignment and transcribes nothing', async () => {
		await expect(
			runSpeechToTextTask('dictation', { audio: clip, sampleRate: 16000 })
		).resolves.toEqual({ status: 'off' });
		expect(speech.transcribeSpeech).not.toHaveBeenCalled();
		expect(stats.recordLocalModelRun).not.toHaveBeenCalled();
	});

	it('transcribes on the assigned local model and records the run', async () => {
		assign('dictation', PARAKEET);
		speech.transcribeSpeech.mockResolvedValue({ text: 'Ship it.', audioMs: 1000 });

		const result = await runSpeechToTextTask('dictation', { audio: clip, sampleRate: 16000 });

		expect(speech.transcribeSpeech).toHaveBeenCalledWith(PARAKEET, clip, 16000, {});
		expect(result).toMatchObject({
			status: 'ok',
			text: 'Ship it.',
			audioMs: 1000,
			source: PARAKEET,
		});
		expect(recorded()).toMatchObject({
			taskId: 'dictation',
			sourceType: 'local',
			modelId: PARAKEET_TDT_V2_ID,
			outcome: 'ok',
		});
	});

	it('transcribes on an assigned endpoint, passing the abort signal through', async () => {
		assign('dictation', WHISPER_SERVER);
		speech.transcribeSpeech.mockResolvedValue({ text: 'Hello.', audioMs: 500 });
		const abort = new AbortController();

		await runSpeechToTextTask('dictation', {
			audio: clip,
			sampleRate: 48000,
			signal: abort.signal,
		});

		expect(speech.transcribeSpeech).toHaveBeenCalledWith(WHISPER_SERVER, clip, 48000, {
			signal: abort.signal,
		});
		expect(recorded()).toMatchObject({
			sourceType: 'endpoint',
			modelId: 'whisper-1',
			endpointId: 'ep-1',
		});
	});

	it('reports a model that is not downloaded as unavailable, trying nothing else', async () => {
		assign('dictation', PARAKEET);
		speech.transcribeSpeech.mockRejectedValue(
			new LocalModelError('Parakeet TDT 0.6B (English) is not downloaded.', {
				code: 'model-not-installed',
				recovery: 'Download it in Settings.',
				consumerId: 'local-models:speech-to-text',
			})
		);

		await expect(
			runSpeechToTextTask('dictation', { audio: clip, sampleRate: 16000 })
		).resolves.toEqual({
			status: 'unavailable',
			source: PARAKEET,
			reason: 'Parakeet TDT 0.6B (English) is not downloaded. Download it in Settings.',
			code: 'model-not-installed',
		});
		expect(speech.transcribeSpeech).toHaveBeenCalledTimes(1);
		expect(recorded()).toMatchObject({ outcome: 'error', errorCode: 'model-not-installed' });
	});

	it('reports an endpoint with no transcription route as unavailable, in its own words', async () => {
		assign('dictation', WHISPER_SERVER);
		speech.transcribeSpeech.mockRejectedValue(
			new LocalModelEndpointError('"Ollama" does not offer speech-to-text.', {
				kind: 'not-found',
				endpointId: 'ep-1',
				endpointName: 'Ollama',
				url: 'http://127.0.0.1:11434/v1/audio/transcriptions',
				httpStatus: 404,
			})
		);

		await expect(
			runSpeechToTextTask('dictation', { audio: clip, sampleRate: 16000 })
		).resolves.toEqual({
			status: 'unavailable',
			source: WHISPER_SERVER,
			reason: '"Ollama" does not offer speech-to-text.',
			code: 'not-found',
		});
	});

	it('refuses a task that is not a speech-to-text task (a caller bug)', async () => {
		await expect(
			runSpeechToTextTask('tab-naming', { audio: clip, sampleRate: 16000 })
		).rejects.toThrow(/text-gen task/);
	});
});
