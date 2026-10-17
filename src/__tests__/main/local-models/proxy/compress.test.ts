/**
 * @file compress.test.ts
 *
 * The token proxy's request compressor: only large tool results change, they
 * change to the same bytes on every turn, and every other byte of the request
 * is the byte the client sent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const tempRoot = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
	app: { getPath: () => tempRoot.dir },
}));

const logger = vi.hoisted(() => ({
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({ logger }));

vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => `PROMPT:${id}`),
}));

vi.mock('../../../../main/local-models/task-router', () => ({
	runLocalTask: vi.fn(),
}));

import {
	compressRequestBody,
	DEFAULT_COMPRESS_MIN_TOKENS,
	formatCompressionMarker,
	MODEL_CHUNK_MAX_TOKENS,
	MODEL_MAX_INPUT_TOKENS,
	parseCompressionMarker,
	summarizeToolResult,
	type CompressRequestOptions,
	type ModelSummary,
} from '../../../../main/local-models/proxy/compress';
import {
	contentHash,
	createCompressionCache,
	type CompressionCache,
} from '../../../../main/local-models/proxy/compression-cache';
import { runLocalTask } from '../../../../main/local-models/task-router';

const SOURCE = { type: 'local', modelId: 'qwen3-1.7b' } as const;

/** A log the heuristics fold to two lines. About 2500 tokens. */
const LOG = 'INFO worker heartbeat ok\n'.repeat(400);
const LOG_FOLDED = [
	'INFO worker heartbeat ok',
	'[maestro: previous line repeated 399 more times]',
	'',
].join('\n');
const LOG_TOKENS = Math.ceil(LOG.length / 4);

/** Another one, so two blocks in a request do not share a hash. */
const OTHER_LOG = 'WARN queue depth above limit\n'.repeat(300);

/** Text no heuristic shortens: every line differs and none is long. About 2500 tokens. */
const SOURCE_FILE = Array.from(
	{ length: 250 },
	(_, n) => `export const value${n} = compute(${n}, 'x');`
).join('\n');

function compressedLog(original = LOG, folded = LOG_FOLDED): string {
	return `${folded}\n${formatCompressionMarker(contentHash(original), Math.ceil(original.length / 4))}`;
}

function newCache(): CompressionCache {
	return createCompressionCache({ dir: () => tempRoot.dir });
}

function options(extra: CompressRequestOptions = {}): CompressRequestOptions {
	return { cache: newCache(), summarize: async () => ({ status: 'skipped' }), ...extra };
}

/** An Anthropic request: one answered tool result, then a fresh one in the last user message. */
function anthropicBody(answered: unknown, fresh: unknown = 'fresh result'): string {
	return JSON.stringify({
		model: 'claude-opus-5-5',
		system: [{ type: 'text', text: 'You are a coding agent.' }],
		tools: [{ name: 'Bash', description: 'Run a command', input_schema: { type: 'object' } }],
		messages: [
			{ role: 'user', content: 'run the build' },
			{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
			{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: answered }] },
			{ role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] },
			{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: fresh }] },
		],
	});
}

beforeEach(async () => {
	tempRoot.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-proxy-compress-'));
	vi.clearAllMocks();
});

afterEach(async () => {
	await fs.rm(tempRoot.dir, { recursive: true, force: true });
});

describe('the compression marker', () => {
	it('names the hash and the original size, and reads back', () => {
		const hash = contentHash('some tool output');
		const marker = formatCompressionMarker(hash, 4321);
		expect(marker).toBe(`[maestro-compressed sha256=${hash} original_tokens=4321]`);
		expect(parseCompressionMarker(`shortened text\n${marker}`)).toEqual({
			hash,
			originalTokens: 4321,
		});
		expect(parseCompressionMarker('a tool result nobody compressed')).toBeNull();
	});
});

describe('compressRequestBody: Anthropic Messages', () => {
	it('replaces an answered tool result and nothing else in the request', async () => {
		// Hand-written, so the bytes around the tool result are ones a
		// parse-and-print round trip would NOT reproduce: spacing, an escaped
		// character, an integer past 2^53, and an integer-like key out of order.
		const before =
			'{ "model":"claude-opus-5-5", "max_tokens": 32000,\n' +
			'  "system": [ {"type":"text","text":"Caf\\u00e9 rules. \\/ always"} ],\n' +
			'  "tools": [ {"name":"Bash","input_schema":{"b":1,"1":2}} ],\n' +
			'  "messages": [\n' +
			'    {"role":"user","content":"run it"},\n' +
			'    {"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"id":12345678901234567890}}]},\n' +
			'    {"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":';
		const after =
			'}]},\n' +
			'    {"role":"assistant","content":[{"type":"text","text":"Done."}]},\n' +
			'    {"role":"user","content":"thanks,  now the next thing"}\n' +
			'  ] }';
		const body = `${before}${JSON.stringify(LOG)}${after}`;

		const result = await compressRequestBody('anthropic-messages', body, options());

		expect(result.changed).toBe(true);
		expect(result.body).toBe(`${before}${JSON.stringify(compressedLog())}${after}`);
		expect(result.blocks).toEqual([
			{
				hash: contentHash(LOG),
				originalTokens: LOG_TOKENS,
				compressedTokens: Math.ceil(compressedLog().length / 4),
				compressors: ['logs'],
				cached: false,
			},
		]);
		expect(result.stats).toMatchObject({
			candidates: 1,
			compressed: 1,
			kept: 0,
			cacheHits: 0,
			originalTokens: LOG_TOKENS,
			compressors: { json: 0, logs: 1, 'long-lines': 0, model: 0 },
		});
	});

	it('never touches the most recent user message', async () => {
		const body = anthropicBody('small', LOG);
		const result = await compressRequestBody('anthropic-messages', body, options());
		expect(result.changed).toBe(false);
		expect(result.body).toBe(body);
		// The fresh result is not even a candidate: it is never hashed or stored.
		expect(result.stats.candidates).toBe(1);
		expect(await fs.readdir(tempRoot.dir)).toEqual([]);
	});

	it('compresses the same result once it is no longer the most recent', async () => {
		const first = await compressRequestBody(
			'anthropic-messages',
			anthropicBody('small', LOG),
			options()
		);
		expect(first.changed).toBe(false);

		const next = await compressRequestBody(
			'anthropic-messages',
			anthropicBody(LOG, 'the newest result'),
			options()
		);
		expect(next.body).toBe(anthropicBody(compressedLog(), 'the newest result'));
	});

	it('never touches the system prompt, tool definitions, or what a user or assistant wrote', async () => {
		const body = JSON.stringify({
			system: LOG,
			tools: [{ name: 'Read', description: LOG, input_schema: { type: 'object' } }],
			messages: [
				{ role: 'user', content: LOG },
				{ role: 'user', content: [{ type: 'text', text: LOG }] },
				{ role: 'assistant', content: [{ type: 'text', text: LOG }] },
				{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
				{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
				{ role: 'user', content: 'and the latest question' },
			],
		});
		const result = await compressRequestBody('anthropic-messages', body, options());
		expect(result.body).toBe(body);
		expect(result.changed).toBe(false);
	});

	it('never touches a block marked with cache_control, or anything inside it', async () => {
		const messages = [
			{
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 't1',
						content: LOG,
						cache_control: { type: 'ephemeral' },
					},
					{
						type: 'tool_result',
						tool_use_id: 't2',
						content: [
							{ type: 'text', text: LOG, cache_control: { type: 'ephemeral' } },
							{ type: 'text', text: OTHER_LOG },
						],
					},
				],
			},
			{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
			{ role: 'user', content: 'next' },
		];
		const body = JSON.stringify({ messages });
		const result = await compressRequestBody('anthropic-messages', body, options());

		// Only the one unmarked text part changed.
		expect(result.blocks.map((block) => block.hash)).toEqual([contentHash(OTHER_LOG)]);
		const out = JSON.parse(result.body) as { messages: typeof messages };
		const [marked, mixed] = out.messages[0].content as Array<{ content: unknown }>;
		expect(marked.content).toBe(LOG);
		expect((mixed.content as unknown[])[0]).toEqual({
			type: 'text',
			text: LOG,
			cache_control: { type: 'ephemeral' },
		});
		expect((mixed.content as Array<{ text: string }>)[1].text).toBe(
			`WARN queue depth above limit\n[maestro: previous line repeated 299 more times]\n\n${formatCompressionMarker(
				contentHash(OTHER_LOG),
				Math.ceil(OTHER_LOG.length / 4)
			)}`
		);
	});

	it('treats cache_control: null as no mark', async () => {
		const body = JSON.stringify({
			messages: [
				{
					role: 'user',
					content: [{ type: 'tool_result', tool_use_id: 't1', content: LOG, cache_control: null }],
				},
				{ role: 'assistant', content: 'ok' },
				{ role: 'user', content: 'next' },
			],
		});
		const result = await compressRequestBody('anthropic-messages', body, options());
		expect(result.stats.compressed).toBe(1);
	});

	it('leaves a tool result under the size threshold alone, without hashing it', async () => {
		const body = anthropicBody('x'.repeat(DEFAULT_COMPRESS_MIN_TOKENS * 4 - 4));
		const result = await compressRequestBody('anthropic-messages', body, options());
		expect(result.body).toBe(body);
		expect(result.stats).toMatchObject({ candidates: 1, belowThreshold: 1, kept: 0 });
		expect(await fs.readdir(tempRoot.dir)).toEqual([]);
	});

	it('replaces two copies of one result with the same bytes', async () => {
		const body = JSON.stringify({
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'tool_result', tool_use_id: 't1', content: LOG },
						{ type: 'tool_result', tool_use_id: 't2', content: LOG },
					],
				},
				{ role: 'assistant', content: 'ok' },
				{ role: 'user', content: 'next' },
			],
		});
		const result = await compressRequestBody('anthropic-messages', body, options());
		const out = JSON.parse(result.body) as {
			messages: Array<{ content: Array<{ content: string }> }>;
		};
		expect(out.messages[0].content[0].content).toBe(compressedLog());
		expect(out.messages[0].content[1].content).toBe(compressedLog());
		expect(result.stats).toMatchObject({ compressed: 2, cacheHits: 1 });
	});
});

describe('compressRequestBody: OpenAI Chat Completions', () => {
	it('compresses answered tool messages and holds back the ones not answered yet', async () => {
		const messages = [
			{ role: 'system', content: LOG },
			{ role: 'user', content: LOG },
			{ role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
			{ role: 'tool', tool_call_id: 'c1', content: LOG },
			{ role: 'assistant', content: null, tool_calls: [{ id: 'c2' }, { id: 'c3' }] },
			{ role: 'tool', tool_call_id: 'c2', content: OTHER_LOG },
			{ role: 'tool', tool_call_id: 'c3', content: [{ type: 'text', text: LOG }] },
		];
		const result = await compressRequestBody(
			'openai-chat-completions',
			JSON.stringify({ model: 'gpt-5', messages }),
			options()
		);
		const out = JSON.parse(result.body) as { messages: Array<{ content: unknown }> };

		expect(out.messages[3].content).toBe(compressedLog());
		// Everything else is as sent, the two fresh tool messages included.
		expect(out.messages.filter((_, index) => index !== 3)).toEqual(
			messages.filter((_, index) => index !== 3)
		);
		expect(result.stats.candidates).toBe(1);
	});

	it('reads the text parts of a tool message given as a list', async () => {
		const result = await compressRequestBody(
			'openai-chat-completions',
			JSON.stringify({
				messages: [
					{ role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: LOG }] },
					{ role: 'assistant', content: 'done' },
				],
			}),
			options()
		);
		const out = JSON.parse(result.body) as {
			messages: Array<{ content: Array<{ text: string }> }>;
		};
		expect(out.messages[0].content[0].text).toBe(compressedLog());
	});
});

describe('compressRequestBody: OpenAI Responses', () => {
	it('compresses answered tool outputs and holds back the ones not answered yet', async () => {
		const input = [
			{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: LOG }] },
			{ type: 'message', role: 'user', content: [{ type: 'input_text', text: LOG }] },
			{ type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' },
			{ type: 'function_call_output', call_id: 'c1', output: LOG },
			{ type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: '' },
			{ type: 'custom_tool_call_output', call_id: 'c2', output: OTHER_LOG },
			{ type: 'reasoning', summary: [] },
			{ type: 'function_call', call_id: 'c3', name: 'shell', arguments: '{}' },
			{ type: 'function_call_output', call_id: 'c3', output: LOG },
		];
		const result = await compressRequestBody(
			'openai-responses',
			JSON.stringify({ model: 'gpt-5-codex', instructions: LOG, input }),
			options()
		);
		const out = JSON.parse(result.body) as { instructions: string; input: typeof input };

		expect(out.instructions).toBe(LOG);
		expect(out.input[3].output).toBe(compressedLog());
		expect(parseCompressionMarker(out.input[5].output ?? '')).toEqual({
			hash: contentHash(OTHER_LOG),
			originalTokens: Math.ceil(OTHER_LOG.length / 4),
		});
		// The developer and user messages, and the output after the last call.
		expect([out.input[0], out.input[1], out.input[8]]).toEqual([input[0], input[1], input[8]]);
	});

	it('compresses the inner output of a shell result that is itself JSON', async () => {
		const shellResult = JSON.stringify({ output: LOG, metadata: { exit_code: 0 } });
		const result = await compressRequestBody(
			'openai-responses',
			JSON.stringify({
				input: [
					{ type: 'function_call_output', call_id: 'c1', output: shellResult },
					{ type: 'message', role: 'assistant', content: [] },
				],
			}),
			options()
		);
		const out = JSON.parse(result.body) as { input: Array<{ output: string }> };
		const [json] = out.input[0].output.split('\n[maestro-compressed');
		expect(JSON.parse(json)).toEqual({ output: LOG_FOLDED, metadata: { exit_code: 0 } });
		expect(result.blocks[0].compressors).toEqual(['json', 'logs']);
	});

	it('leaves a request whose input is one string alone', async () => {
		const body = JSON.stringify({ model: 'gpt-5', input: LOG });
		const result = await compressRequestBody('openai-responses', body, options());
		expect(result.body).toBe(body);
	});
});

describe('compressRequestBody: early mode', () => {
	const early = (extra: CompressRequestOptions = {}) => options({ early: true, ...extra });

	it('shortens a fresh tool result before the model has read it', async () => {
		const body = anthropicBody('small', LOG);
		const result = await compressRequestBody('anthropic-messages', body, early());

		// Without `early` this request goes out untouched (see "never touches the
		// most recent user message"). With it, nothing is ever cached in full.
		expect(result.body).toBe(anthropicBody('small', compressedLog()));
		expect(result.stats.candidates).toBe(2);
		expect(result.blocks.map((block) => block.hash)).toEqual([contentHash(LOG)]);
	});

	it('sends the same bytes on the next request, when the result is no longer fresh', async () => {
		const cache = newCache();
		const first = await compressRequestBody(
			'anthropic-messages',
			anthropicBody('small', LOG),
			early({ cache })
		);
		const next = await compressRequestBody(
			'anthropic-messages',
			anthropicBody(LOG, 'the newest result'),
			early({ cache })
		);

		// The prefix a provider cached on the first request is byte for byte the
		// prefix of the second: that is what keeps the prompt cache reading.
		const firstFresh = (JSON.parse(first.body) as { messages: Array<{ content: unknown }> })
			.messages[4].content as Array<{ content: string }>;
		const nextAnswered = (JSON.parse(next.body) as { messages: Array<{ content: unknown }> })
			.messages[2].content as Array<{ content: string }>;
		expect(nextAnswered[0].content).toBe(firstFresh[0].content);
		expect(next.blocks[0].cached).toBe(true);
	});

	it('shortens the block that carries the cache breakpoint, and leaves the breakpoint', async () => {
		const messages = [
			{ role: 'user', content: 'run the build' },
			{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
			{
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 't1',
						content: [{ type: 'text', text: LOG, cache_control: { type: 'ephemeral' } }],
						cache_control: { type: 'ephemeral' },
					},
				],
			},
		];
		const result = await compressRequestBody(
			'anthropic-messages',
			JSON.stringify({ messages }),
			early()
		);
		const out = JSON.parse(result.body) as { messages: typeof messages };
		const block = (out.messages[2].content as Array<Record<string, unknown>>)[0];

		expect(block.cache_control).toEqual({ type: 'ephemeral' });
		expect((block.content as Array<Record<string, unknown>>)[0]).toEqual({
			type: 'text',
			text: compressedLog(),
			cache_control: { type: 'ephemeral' },
		});
	});

	it('still reads only tool results: what the user typed is never touched', async () => {
		const body = JSON.stringify({
			system: LOG,
			tools: [{ name: 'Bash', description: LOG }],
			messages: [
				{ role: 'user', content: LOG },
				{ role: 'assistant', content: [{ type: 'text', text: LOG }] },
				{ role: 'user', content: [{ type: 'text', text: LOG }] },
			],
		});
		const result = await compressRequestBody('anthropic-messages', body, early());

		expect(result.changed).toBe(false);
		expect(result.body).toBe(body);
		expect(result.stats.candidates).toBe(0);
	});

	it('shortens tool messages and outputs the model has not answered yet, in the OpenAI formats', async () => {
		const chat = await compressRequestBody(
			'openai-chat-completions',
			JSON.stringify({
				messages: [
					{ role: 'user', content: LOG },
					{ role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
					{ role: 'tool', tool_call_id: 'c1', content: LOG },
				],
			}),
			early()
		);
		const chatOut = JSON.parse(chat.body) as { messages: Array<{ content: unknown }> };
		expect(chatOut.messages[0].content).toBe(LOG);
		expect(chatOut.messages[2].content).toBe(compressedLog());

		const responses = await compressRequestBody(
			'openai-responses',
			JSON.stringify({
				instructions: LOG,
				input: [
					{ type: 'message', role: 'user', content: [{ type: 'input_text', text: LOG }] },
					{ type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' },
					{ type: 'function_call_output', call_id: 'c1', output: LOG },
				],
			}),
			early()
		);
		const responsesOut = JSON.parse(responses.body) as {
			instructions: string;
			input: Array<{ output?: string }>;
		};
		expect(responsesOut.instructions).toBe(LOG);
		expect(responsesOut.input[2].output).toBe(compressedLog());
	});

	it('leaves a small fresh result alone', async () => {
		const body = anthropicBody('small', 'also small');
		const result = await compressRequestBody('anthropic-messages', body, early());
		expect(result.changed).toBe(false);
		expect(result.body).toBe(body);
	});
});

describe('compressRequestBody: what it leaves alone', () => {
	it('returns the same string for a path that carries no message list', async () => {
		const body = anthropicBody(LOG);
		const result = await compressRequestBody('other', body, options());
		expect(result.body).toBe(body);
		expect(result.changed).toBe(false);
	});

	it('returns the same string for a body that is not JSON', async () => {
		const body = `not json ${LOG}`;
		const result = await compressRequestBody('anthropic-messages', body, options());
		expect(result.body).toBe(body);
		expect(result.changed).toBe(false);
	});

	it('keeps a large result no compressor shortens, and remembers that', async () => {
		const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'skipped' }));
		const cache = newCache();
		const body = anthropicBody(SOURCE_FILE);

		const first = await compressRequestBody('anthropic-messages', body, { cache, summarize });
		expect(first.body).toBe(body);
		expect(first.stats).toMatchObject({ kept: 1, compressed: 0, cacheHits: 0 });
		// Under the model threshold, so the model was never asked.
		expect(summarize).not.toHaveBeenCalled();

		const second = await compressRequestBody('anthropic-messages', body, {
			cache: newCache(),
			summarize,
		});
		expect(second.body).toBe(body);
		expect(second.stats).toMatchObject({ kept: 1, cacheHits: 1 });
	});
});

describe('compressRequestBody: determinism', () => {
	it('gives the same bytes on a second run, from the cache', async () => {
		const cache = newCache();
		const body = anthropicBody(LOG);
		const first = await compressRequestBody('anthropic-messages', body, options({ cache }));
		const second = await compressRequestBody('anthropic-messages', body, options({ cache }));

		expect(second.body).toBe(first.body);
		expect(first.blocks[0].cached).toBe(false);
		expect(second.blocks[0].cached).toBe(true);
		expect(second.stats.cacheHits).toBe(1);
	});

	it('gives the same bytes after the cache is reloaded from disk', async () => {
		const body = anthropicBody(LOG);
		const first = await compressRequestBody('anthropic-messages', body, options());
		// `options()` builds a new cache over the same directory: nothing in memory.
		const reloaded = await compressRequestBody('anthropic-messages', body, options());

		expect(reloaded.body).toBe(first.body);
		expect(reloaded.blocks[0].cached).toBe(true);
	});

	it('gives the same bytes in a second, unrelated run with an empty cache', async () => {
		const body = anthropicBody(LOG);
		const first = await compressRequestBody('anthropic-messages', body, options());
		const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-proxy-compress-b-'));
		try {
			const second = await compressRequestBody('anthropic-messages', body, {
				cache: createCompressionCache({ dir: () => elsewhere }),
				summarize: async () => ({ status: 'skipped' }),
			});
			expect(second.body).toBe(first.body);
			expect(second.blocks[0].cached).toBe(false);
		} finally {
			await fs.rm(elsewhere, { recursive: true, force: true });
		}
	});

	it('gives a block the same bytes when it appears in a different request', async () => {
		const early = await compressRequestBody(
			'anthropic-messages',
			anthropicBody(LOG, 'first fresh result'),
			options()
		);
		const later = await compressRequestBody(
			'openai-chat-completions',
			JSON.stringify({
				messages: [
					{ role: 'tool', tool_call_id: 'c1', content: LOG },
					{ role: 'assistant', content: 'ok' },
				],
			}),
			options()
		);
		const earlyText = (
			JSON.parse(early.body) as { messages: Array<{ content: Array<{ content: string }> }> }
		).messages[2].content[0].content;
		const laterText = (JSON.parse(later.body) as { messages: Array<{ content: string }> })
			.messages[0].content;
		expect(laterText).toBe(earlyText);
	});

	it('stores the original beside what replaced it', async () => {
		const cache = newCache();
		await compressRequestBody('anthropic-messages', anthropicBody(LOG), options({ cache }));
		expect(await newCache().readOriginal(contentHash(LOG))).toBe(LOG);
		expect((await newCache().read(contentHash(LOG)))?.outcome).toBe('compressed');
	});
});

describe('compressRequestBody: the model tier', () => {
	/** Low thresholds, so the unshortenable file is large enough for the model. */
	const MODEL_OPTIONS = { modelMinTokens: 500 } as const;

	it('asks the model only for a result still large after the heuristics', async () => {
		const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'ok', text: 'short' }));
		// The log folds to two lines: far under the model threshold.
		await compressRequestBody('anthropic-messages', anthropicBody(LOG), {
			...MODEL_OPTIONS,
			cache: newCache(),
			summarize,
		});
		expect(summarize).not.toHaveBeenCalled();

		const result = await compressRequestBody('anthropic-messages', anthropicBody(SOURCE_FILE), {
			...MODEL_OPTIONS,
			cache: newCache(),
			summarize,
		});
		expect(summarize).toHaveBeenCalledTimes(1);
		expect(summarize).toHaveBeenCalledWith(SOURCE_FILE);
		expect(result.blocks[0].compressors).toEqual(['model']);
		expect(result.stats.compressors.model).toBe(1);
		const sent = (
			JSON.parse(result.body) as { messages: Array<{ content: Array<{ content: string }> }> }
		).messages[2].content[0].content;
		expect(sent).toBe(
			`short\n${formatCompressionMarker(contentHash(SOURCE_FILE), Math.ceil(SOURCE_FILE.length / 4))}`
		);
	});

	it('keeps the first summary forever, whatever the model would say later', async () => {
		const body = anthropicBody(SOURCE_FILE);
		const first = await compressRequestBody('anthropic-messages', body, {
			...MODEL_OPTIONS,
			cache: newCache(),
			summarize: async () => ({ status: 'ok', text: 'the first summary' }),
		});

		const later = vi.fn(
			async (): Promise<ModelSummary> => ({ status: 'ok', text: 'a different summary' })
		);
		const second = await compressRequestBody('anthropic-messages', body, {
			...MODEL_OPTIONS,
			cache: newCache(),
			summarize: later,
		});
		expect(second.body).toBe(first.body);
		expect(later).not.toHaveBeenCalled();
	});

	it('freezes the heuristic result when the model fails, and does not ask again', async () => {
		const body = anthropicBody(SOURCE_FILE);
		const first = await compressRequestBody('anthropic-messages', body, {
			...MODEL_OPTIONS,
			cache: newCache(),
			summarize: async () => ({ status: 'failed', code: 'model-not-installed' }),
		});
		// Nothing shortened it, so it went out as sent, and the failure is counted.
		expect(first.body).toBe(body);
		expect(first.stats).toMatchObject({ kept: 1, modelFailures: 1 });

		const recovered = vi.fn(async (): Promise<ModelSummary> => ({ status: 'ok', text: 'short' }));
		const second = await compressRequestBody('anthropic-messages', body, {
			...MODEL_OPTIONS,
			cache: newCache(),
			summarize: recovered,
		});
		expect(second.body).toBe(body);
		expect(recovered).not.toHaveBeenCalled();
		// Counted in the request that tried, not in the ones that read the verdict.
		expect(second.stats).toMatchObject({ kept: 1, cacheHits: 1, modelFailures: 0 });
		expect((await newCache().read(contentHash(SOURCE_FILE)))?.modelFailure).toBe(
			'model-not-installed'
		);
	});

	it('does not use a summary that is no shorter than what it was given', async () => {
		const result = await compressRequestBody('anthropic-messages', anthropicBody(SOURCE_FILE), {
			...MODEL_OPTIONS,
			cache: newCache(),
			summarize: async (text) => ({ status: 'ok', text: `${text} and more` }),
		});
		expect(result.changed).toBe(false);
		expect((await newCache().read(contentHash(SOURCE_FILE)))?.modelFailure).toBe('not-shorter');
	});

	it('decides a block once when two requests carry it at the same time', async () => {
		let release: (summary: ModelSummary) => void = () => {};
		const summarize = vi.fn(() => new Promise<ModelSummary>((resolve) => (release = resolve)));
		const body = anthropicBody(SOURCE_FILE);
		const shared = { ...MODEL_OPTIONS, summarize };
		const both = Promise.all([
			compressRequestBody('anthropic-messages', body, { ...shared, cache: newCache() }),
			compressRequestBody('anthropic-messages', body, { ...shared, cache: newCache() }),
		]);
		await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
		release({ status: 'ok', text: 'one summary' });
		const [a, b] = await both;

		expect(summarize).toHaveBeenCalledTimes(1);
		expect(b.body).toBe(a.body);
		expect([a.blocks[0].cached, b.blocks[0].cached].sort()).toEqual([false, true]);
	});
});

describe('compressRequestBody: a cache that cannot be used', () => {
	function failingCache(error: unknown, on: 'read' | 'write'): CompressionCache {
		const real = newCache();
		return {
			read: on === 'read' ? async () => Promise.reject(error) : real.read,
			write: on === 'write' ? async () => Promise.reject(error) : real.write,
			readOriginal: real.readOriginal,
		};
	}

	it.each(['read', 'write'] as const)(
		'sends the block as it was when the cache %s fails',
		async (on) => {
			const diskFull = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
			const body = anthropicBody(LOG);
			const result = await compressRequestBody(
				'anthropic-messages',
				body,
				options({ cache: failingCache(diskFull, on) })
			);
			expect(result.body).toBe(body);
			expect(result.changed).toBe(false);
			expect(result.stats.storeFailures).toBe(1);
			expect(logger.warn).toHaveBeenCalledTimes(1);
		}
	);

	it('does not hide a failure that is not the file system', async () => {
		await expect(
			compressRequestBody(
				'anthropic-messages',
				anthropicBody(LOG),
				options({ cache: failingCache(new TypeError('a bug'), 'write') })
			)
		).rejects.toThrow('a bug');
	});
});

describe('summarizeToolResult', () => {
	const mockedRun = vi.mocked(runLocalTask);

	function ok(text: string) {
		return { status: 'ok', text, source: SOURCE, durationMs: 5 } as const;
	}

	it('is skipped while the task is off', async () => {
		mockedRun.mockResolvedValue({ status: 'off' });
		expect(await summarizeToolResult(SOURCE_FILE)).toEqual({ status: 'skipped' });
		expect(mockedRun).toHaveBeenCalledTimes(1);
	});

	it('shortens the text piece by piece, in order, on the token-proxy task', async () => {
		let piece = 0;
		mockedRun.mockImplementation(async () => ok(`summary ${++piece}`));
		const text = SOURCE_FILE.repeat(3);

		const summary = await summarizeToolResult(text);

		const calls = mockedRun.mock.calls;
		expect(calls.length).toBeGreaterThan(1);
		expect(summary).toEqual({
			status: 'ok',
			text: calls.map((_, index) => `summary ${index + 1}`).join('\n'),
		});
		for (const [taskId, input] of calls) {
			expect(taskId).toBe('token-proxy');
			expect(input.system).toBe('PROMPT:token-proxy-local');
			expect(input.maxTokens).toBe(MODEL_CHUNK_MAX_TOKENS);
			expect(input.signal).toBeInstanceOf(AbortSignal);
		}
		// Every line of the text reached the model, once, in order.
		const seen = calls.map(([, input]) => input.prompt).join('\n');
		expect(seen.split('\n').filter(Boolean)).toEqual(text.split('\n').filter(Boolean));
	});

	it('fails as a whole, and says so, when the assigned model is unavailable', async () => {
		const verdict = {
			status: 'unavailable',
			source: SOURCE,
			reason: 'Qwen3 1.7B is not downloaded.',
			code: 'model-not-installed',
		} as const;
		mockedRun.mockResolvedValueOnce(ok('first piece')).mockResolvedValueOnce(verdict);
		const onUnavailable = vi.fn();

		expect(await summarizeToolResult(SOURCE_FILE.repeat(3), { onUnavailable })).toEqual({
			status: 'failed',
			code: 'model-not-installed',
		});
		expect(onUnavailable).toHaveBeenCalledWith(verdict);
		expect(mockedRun).toHaveBeenCalledTimes(2);
	});

	it('reports a timeout and an empty reply as failures', async () => {
		mockedRun.mockResolvedValueOnce({ status: 'cancelled', source: SOURCE });
		expect(await summarizeToolResult(SOURCE_FILE)).toEqual({ status: 'failed', code: 'timeout' });

		mockedRun.mockResolvedValueOnce(ok('   \n'));
		expect(await summarizeToolResult(SOURCE_FILE)).toEqual({
			status: 'failed',
			code: 'empty-reply',
		});
	});

	it('does not ask the model to read a text past its limit', async () => {
		const huge = 'y'.repeat((MODEL_MAX_INPUT_TOKENS + 1) * 4);
		expect(await summarizeToolResult(huge)).toEqual({ status: 'skipped' });
		expect(mockedRun).not.toHaveBeenCalled();
	});
});
