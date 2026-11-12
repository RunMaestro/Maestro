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

vi.mock('fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('fs/promises')>()),
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
	findToolResultDescriptors,
	findToolResultSpans,
	formatCompressionMarker,
	MODEL_CHUNK_MAX_TOKENS,
	MODEL_MAX_INPUT_TOKENS,
	parseCompressionMarker,
	requestProfile,
	summarizeToolResult,
	verdictKey,
	type CompressRequestOptions,
	type LocalRecoveryCapability,
	type RetrieveToolCapability,
	type ModelSummary,
} from '../../../../main/local-models/proxy/compress';
import {
	contentHash,
	createCompressionCache,
	type CompressionCache,
} from '../../../../main/local-models/proxy/compression-cache';
import { compressWithHeuristics } from '../../../../main/local-models/proxy/compressors';
import { shellEscape } from '../../../../main/utils/shell-escape';
import { runLocalTask } from '../../../../main/local-models/task-router';
import {
	memberOf,
	parseJsonSpans,
	stringValue,
} from '../../../../main/local-models/proxy/json-spans';

const SOURCE = { type: 'local', modelId: 'qwen3-1.7b' } as const;

/** Host evidence that a launch was given the MCP retrieve tool. */
const RETRIEVE_TOOL: RetrieveToolCapability = { kind: 'mcp-retrieve-tool' };

// Synthetic host evidence only; none of these paths is opened or executed.
const LOCAL_RECOVERY: LocalRecoveryCapability = {
	kind: 'local-posix-cli',
	environmentId: contentHash('synthetic same-host tool environment'),
	runtimePath: "/opt/Maestro's $bundle/Maestro",
	cliPath: "/opt/Maestro's $bundle/maestro-cli.js",
	dataDir: "/home/user/Maestro's $data",
};

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

/** The same fold as early mode sends it: under the `complete` profile's key. */
function earlyCompressedLog(original = LOG, folded = LOG_FOLDED): string {
	return `${folded}\n${formatCompressionMarker(verdictKey(original, 'complete'), Math.ceil(original.length / 4))}`;
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
	vi.restoreAllMocks();
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

describe('request-local tool result descriptors', () => {
	const formats = [
		{
			kind: 'anthropic-messages' as const,
			call: { type: 'tool_use', id: 'one', name: 'shell', input: { command: 'printf ok' } },
			result: { type: 'tool_result', tool_use_id: 'one', content: 'ok' },
			contentKey: 'content',
			resultIdKey: 'tool_use_id',
			wrap: (calls: unknown[], results: unknown[], answered = true) =>
				JSON.stringify({
					messages: [
						{ role: 'assistant', content: calls },
						{ role: 'user', content: results },
						...(answered
							? [
									{ role: 'assistant', content: 'done' },
									{ role: 'user', content: 'next' },
								]
							: []),
					],
				}),
		},
		{
			kind: 'openai-chat-completions' as const,
			call: {
				type: 'function',
				id: 'one',
				function: { name: 'shell', arguments: '{"command":"printf ok"}' },
			},
			result: { role: 'tool', tool_call_id: 'one', content: 'ok' },
			contentKey: 'content',
			resultIdKey: 'tool_call_id',
			wrap: (calls: unknown[], results: unknown[], answered = true) =>
				JSON.stringify({
					messages: [
						{ role: 'assistant', tool_calls: calls },
						...results,
						...(answered ? [{ role: 'assistant', content: 'done' }] : []),
					],
				}),
		},
		{
			kind: 'openai-responses' as const,
			call: {
				type: 'function_call',
				call_id: 'one',
				name: 'shell',
				arguments: '{"command":"printf ok"}',
			},
			result: { type: 'function_call_output', call_id: 'one', output: 'ok' },
			contentKey: 'output',
			resultIdKey: 'call_id',
			wrap: (calls: unknown[], results: unknown[], answered = true) =>
				JSON.stringify({
					input: [
						...calls,
						...results,
						...(answered ? [{ type: 'message', role: 'assistant', content: [] }] : []),
					],
				}),
		},
	];

	it.each(formats)(
		'$kind links a unique call and preserves an unreplaced body',
		async ({ kind, call, result, wrap }) => {
			const body = wrap([call], [result]);
			const root = parseJsonSpans(body)!;
			const [descriptor] = findToolResultDescriptors(kind, body, root);
			expect(descriptor).toMatchObject({
				callId: 'one',
				linkage: 'matched',
				toolName: 'shell',
				input: { kind: 'structured' },
				contentStatus: 'text',
				failureStatus: 'unknown',
				recoveryEligibility: 'inspectable',
			});
			expect(body.slice(descriptor.call!.start, descriptor.call!.end)).toBe(JSON.stringify(call));
			expect(body.slice(descriptor.result.start, descriptor.result.end)).toBe(
				JSON.stringify(result)
			);
			if (descriptor.input.kind !== 'structured') throw new Error('Expected structured input');
			expect(stringValue(descriptor.input.source, memberOf(descriptor.input.span, 'command'))).toBe(
				'printf ok'
			);
			expect(descriptor.contentSpans.map((span) => stringValue(body, span))).toEqual(['ok']);
			expect(findToolResultSpans(kind, body, root)).toEqual(descriptor.eligibleSpans);
			const compressed = await compressRequestBody(kind, body, options());
			expect(compressed.body).toBe(body);
			expect(compressed.changed).toBe(false);
			expect(await fs.readdir(tempRoot.dir)).toEqual([]);
		}
	);

	it.each(formats)(
		'$kind leaves absent calls, absent IDs and non-string IDs unresolved',
		({ kind, call, result, resultIdKey, wrap }) => {
			for (const id of ['absent', '', undefined, 7, null]) {
				const body = wrap([call], [{ ...result, [resultIdKey]: id }]);
				const [descriptor] = findToolResultDescriptors(kind, body, parseJsonSpans(body)!);
				expect(descriptor).toMatchObject({
					linkage: 'missing',
					call: null,
					toolName: null,
					input: { kind: 'unknown' },
					recoveryEligibility: 'unknown',
				});
			}
			const body = wrap([], [result]);
			expect(findToolResultDescriptors(kind, body, parseJsonSpans(body)!)[0].linkage).toBe(
				'missing'
			);
		}
	);

	it.each(formats)(
		'$kind refuses duplicate call IDs and duplicate result IDs, including fresh results',
		({ kind, call, result, wrap }) => {
			for (const body of [wrap([call, call], [result]), wrap([call], [result, result], false)]) {
				const descriptors = findToolResultDescriptors(kind, body, parseJsonSpans(body)!);
				for (const descriptor of descriptors) {
					expect(descriptor).toMatchObject({
						callId: 'one',
						linkage: 'ambiguous',
						call: null,
						toolName: null,
						input: { kind: 'unknown' },
						recoveryEligibility: 'unknown',
					});
				}
			}
		}
	);

	it.each(formats)(
		'$kind refuses repeated identifier keys and conflicting failure flags',
		({ kind, call, result, resultIdKey, wrap }) => {
			const callKey = kind === 'openai-responses' ? 'call_id' : 'id';
			const body = wrap([call], [{ ...result, is_error: true }]);
			for (const [target, key] of [
				[JSON.stringify(call), callKey],
				[JSON.stringify({ ...result, is_error: true }), resultIdKey],
			]) {
				const repeated = body.replace(
					target,
					target.replace(`"${key}":"one"`, `"${key}":"other","${key}":"one"`)
				);
				const [descriptor] = findToolResultDescriptors(kind, repeated, parseJsonSpans(repeated)!);
				expect(descriptor).toMatchObject({
					linkage: 'ambiguous',
					call: null,
					recoveryEligibility: 'unknown',
				});
			}
			const conflicting = body.replace('"is_error":true', '"is_error":true,"is_error":false');
			expect(
				findToolResultDescriptors(kind, conflicting, parseJsonSpans(conflicting)!)[0].failureStatus
			).toBe('unknown');
		}
	);

	it.each(formats)(
		'$kind treats repeated input or name fields as unknown recovery evidence',
		({ kind, call, result, wrap }) => {
			const body = wrap([call], [result]);
			const inputKey = kind === 'anthropic-messages' ? 'input' : 'arguments';
			const repeatedInput = body.replace(`"${inputKey}":`, `"${inputKey}":null,"${inputKey}":`);
			const [input] = findToolResultDescriptors(
				kind,
				repeatedInput,
				parseJsonSpans(repeatedInput)!
			);
			expect(input).toMatchObject({
				linkage: 'matched',
				input: { kind: 'unknown' },
				recoveryEligibility: 'unknown',
			});
			const repeatedName = body.replace('"name":"shell"', '"name":"other","name":"shell"');
			const [name] = findToolResultDescriptors(kind, repeatedName, parseJsonSpans(repeatedName)!);
			expect(name).toMatchObject({
				linkage: 'matched',
				toolName: null,
				recoveryEligibility: 'unknown',
			});
		}
	);

	it.each(formats)(
		'$kind reads only explicit boolean failure evidence',
		({ kind, call, result, contentKey, wrap }) => {
			for (const [is_error, expected] of [
				[true, 'failed'],
				[false, 'not-failed'],
				[undefined, 'unknown'],
				['true', 'unknown'],
				[1, 'unknown'],
				[null, 'unknown'],
			]) {
				const body = wrap(
					[call],
					[{ ...result, [contentKey]: 'ERROR: exit code 1', is_error, status: 'completed' }]
				);
				const [descriptor] = findToolResultDescriptors(kind, body, parseJsonSpans(body)!);
				expect(descriptor.failureStatus).toBe(expected);
				// Descriptors retain span selection; the request layer applies vetoes.
				expect(descriptor.eligibleSpans).toHaveLength(1);
			}
		}
	);

	it.each(formats)(
		'$kind reports mixed or malformed content as unknown without changing span selection',
		({ kind, call, result, contentKey, wrap }) => {
			for (const content of [
				[
					{ type: 'text', text: 'ok' },
					{ type: 'image', source: { data: 'not decoded' } },
				],
				[
					{ type: 'text', text: 'ok' },
					{ type: 'text', text: 7 },
				],
				null,
			]) {
				const body = wrap([call], [{ ...result, [contentKey]: content }]);
				const root = parseJsonSpans(body)!;
				const [descriptor] = findToolResultDescriptors(kind, body, root);
				expect(descriptor.contentStatus).toBe('unknown');
				expect(descriptor.contentSpans.map((span) => stringValue(body, span))).toEqual(
					content === null ? [] : ['ok']
				);
				expect(findToolResultSpans(kind, body, root)).toEqual(descriptor.eligibleSpans);
			}
		}
	);

	it.each(formats)(
		'$kind retains freshness and cache-control gates in both modes',
		({ kind, call, result, contentKey, wrap }) => {
			const fresh = wrap([call], [result], false);
			const freshRoot = parseJsonSpans(fresh)!;
			expect(findToolResultDescriptors(kind, fresh, freshRoot)[0]).toMatchObject({
				linkage: 'matched',
				eligibleSpans: [],
			});
			expect(findToolResultSpans(kind, fresh, freshRoot, { early: true })).toHaveLength(1);
			const marked = wrap([call], [{ ...result, cache_control: { type: 'ephemeral' } }]);
			expect(findToolResultSpans(kind, marked, parseJsonSpans(marked)!)).toEqual([]);
			expect(
				findToolResultSpans(kind, marked, parseJsonSpans(marked)!, { early: true })
			).toHaveLength(1);
			const parts = wrap(
				[call],
				[
					{
						...result,
						[contentKey]: [
							{ type: 'text', text: 'marked', cache_control: { type: 'ephemeral' } },
							{ type: 'text', text: 'plain', cache_control: null },
						],
					},
				]
			);
			const root = parseJsonSpans(parts)!;
			const [descriptor] = findToolResultDescriptors(kind, parts, root);
			expect(descriptor.contentSpans.map((span) => stringValue(parts, span))).toEqual([
				'marked',
				'plain',
			]);
			expect(descriptor.eligibleSpans.map((span) => stringValue(parts, span))).toEqual(['plain']);
			expect(findToolResultSpans(kind, parts, root, { early: true })).toHaveLength(2);
		}
	);

	it('preserves exact numeric lexemes and escapes in structured inputs across APIs', () => {
		const input = '{ "command":"printf \\u006f\\u006b", "limit":900719925474099312345 }';
		for (const format of formats) {
			const call =
				format.kind === 'anthropic-messages'
					? { ...format.call, input: 'RAW_INPUT' }
					: format.kind === 'openai-chat-completions'
						? { ...format.call, function: { name: 'shell', arguments: input } }
						: { ...format.call, arguments: input };
			const body = format.wrap([call], [format.result]).replace('"RAW_INPUT"', input);
			const [descriptor] = findToolResultDescriptors(format.kind, body, parseJsonSpans(body)!);
			if (descriptor.input.kind !== 'structured') throw new Error('Expected structured input');
			expect(
				descriptor.input.source.slice(descriptor.input.span.start, descriptor.input.span.end)
			).toBe(input);
			expect(stringValue(descriptor.input.source, memberOf(descriptor.input.span, 'command'))).toBe(
				'printf ok'
			);
		}
	});

	it.each(formats)('$kind keeps malformed or non-object inputs explicitly unknown', (format) => {
		for (const input of [
			'not JSON',
			'[]',
			'null',
			'{"command":"bad\\q"}',
			'{"command":"one","command":"two"}',
		]) {
			const call =
				format.kind === 'anthropic-messages'
					? { ...format.call, input: 'RAW_INPUT' }
					: format.kind === 'openai-chat-completions'
						? { ...format.call, function: { name: 'shell', arguments: input } }
						: { ...format.call, arguments: input };
			let body = format.wrap([call], [format.result]);
			if (format.kind === 'anthropic-messages' && input !== 'not JSON')
				body = body.replace('"RAW_INPUT"', input);
			const [descriptor] = findToolResultDescriptors(format.kind, body, parseJsonSpans(body)!);
			expect(descriptor).toMatchObject({
				linkage: 'matched',
				input: { kind: 'unknown' },
				recoveryEligibility: 'unknown',
			});
		}
	});

	it('retains custom Responses input as text and refuses a mismatched call type', () => {
		const body = JSON.stringify({
			input: [
				{
					type: 'custom_tool_call',
					call_id: 'custom',
					name: 'apply_patch',
					input: '*** Begin Patch',
				},
				{ type: 'custom_tool_call_output', call_id: 'custom', output: 'ok' },
				{ type: 'function_call', call_id: 'wrong-kind', name: 'shell', arguments: '{}' },
				{ type: 'custom_tool_call_output', call_id: 'wrong-kind', output: 'ok' },
			],
		});
		const [custom, mismatch] = findToolResultDescriptors(
			'openai-responses',
			body,
			parseJsonSpans(body)!
		);
		expect(custom).toMatchObject({
			linkage: 'matched',
			toolName: 'apply_patch',
			input: { kind: 'custom', text: '*** Begin Patch' },
			recoveryEligibility: 'unknown',
		});
		expect(mismatch).toMatchObject({ linkage: 'missing', call: null, input: { kind: 'unknown' } });
	});

	it('does not attach a later call or infer the missing name from a tool result', () => {
		const body = JSON.stringify({
			input: [
				{ type: 'function_call_output', call_id: 'later', output: 'ok', name: 'shell' },
				{ type: 'function_call', call_id: 'later', name: 'shell', arguments: '{}' },
				{ type: 'function_call', call_id: 'unnamed', arguments: '{}' },
				{ type: 'function_call_output', call_id: 'unnamed', output: 'ok', name: 'shell' },
			],
		});
		const [later, unnamed] = findToolResultDescriptors(
			'openai-responses',
			body,
			parseJsonSpans(body)!
		);
		expect(later).toMatchObject({ linkage: 'missing', call: null, toolName: null });
		expect(unnamed).toMatchObject({
			linkage: 'matched',
			toolName: null,
			recoveryEligibility: 'unknown',
		});
	});

	describe('compression eligibility vetoes', () => {
		const hash = contentHash(LOG);
		const recovery = `maestro-cli models proxy block ${hash} --original`;

		function withInvocation(format: (typeof formats)[number], name: string, input: unknown) {
			if (format.kind === 'anthropic-messages') return { ...format.call, name, input };
			if (format.kind === 'openai-chat-completions')
				return { ...format.call, function: { name, arguments: JSON.stringify(input) } };
			return { ...format.call, name, arguments: JSON.stringify(input) };
		}

		it.each(formats)(
			'$kind vetoes a failed copy before reading a frozen successful verdict in either mode',
			async ({ kind, call, result, contentKey, wrap }) => {
				for (const early of [false, true]) {
					const cache = newCache();
					const successful = wrap(
						[call],
						[{ ...result, [contentKey]: LOG, is_error: false }],
						!early
					);
					const first = await compressRequestBody(kind, successful, options({ cache, early }));
					expect(first.stats.compressed).toBe(1);
					const frozen = await cache.read(hash);
					const read = vi.spyOn(cache, 'read');
					const write = vi.spyOn(cache, 'write');
					const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'skipped' }));
					const failed = wrap(
						[call],
						[{ ...result, [contentKey]: LOG, is_error: true }],
						!early
					).replace('{', '{  "exact":9007199254740993, ');
					const guarded = await compressRequestBody(
						kind,
						failed,
						options({ cache, early, summarize, modelMinTokens: 1 })
					);
					expect(guarded).toMatchObject({
						body: failed,
						changed: false,
						blocks: [],
						stats: {
							candidates: 0,
							compressed: 0,
							cacheHits: 0,
							eligibilityVetoes: { failed: 1, recovery: 0 },
						},
					});
					expect(read).not.toHaveBeenCalled();
					expect(write).not.toHaveBeenCalled();
					expect(summarize).not.toHaveBeenCalled();
					expect(await newCache().read(hash)).toEqual(frozen);
					const repeated = await compressRequestBody(kind, successful, options({ cache, early }));
					expect(repeated.body).toBe(first.body);
					expect(repeated.blocks[0].cached).toBe(true);
					expect(write).not.toHaveBeenCalled();
				}
			}
		);

		it.each(formats)(
			'$kind changes only the successful occurrence of identical output in one request',
			async ({ kind, call, result, contentKey, resultIdKey, wrap }) => {
				const body = wrap(
					[call, { ...call, [kind === 'openai-responses' ? 'call_id' : 'id']: 'two' }],
					[
						{ ...result, [contentKey]: LOG, is_error: false },
						{ ...result, [resultIdKey]: 'two', [contentKey]: LOG, is_error: true },
					]
				);
				const compressed = await compressRequestBody(kind, body, options());
				expect(compressed.body).toBe(
					body.replace(JSON.stringify(LOG), JSON.stringify(compressedLog()))
				);
				expect(compressed.stats).toMatchObject({
					compressed: 1,
					eligibilityVetoes: { failed: 1, recovery: 0 },
				});
			}
		);

		it.each(formats)(
			'$kind protects every failed text part even without call linkage or a usable store',
			async ({ kind, result, contentKey, wrap }) => {
				const cache = newCache();
				const read = vi.spyOn(cache, 'read').mockRejectedValue(new TypeError('must not read'));
				const write = vi.spyOn(cache, 'write');
				const body = wrap(
					[],
					[
						{
							...result,
							is_error: true,
							[contentKey]: [
								{ type: 'text', text: LOG },
								{ type: 'image', source: {} },
								{ type: 'text', text: OTHER_LOG },
							],
						},
					]
				);
				const guarded = await compressRequestBody(kind, body, options({ cache }));
				expect(guarded.body).toBe(body);
				expect(guarded.stats.eligibilityVetoes).toEqual({ failed: 2, recovery: 0 });
				expect(read).not.toHaveBeenCalled();
				expect(write).not.toHaveBeenCalled();
			}
		);

		it.each(formats)(
			'$kind leaves unknown statuses and error-looking prose eligible',
			async ({ kind, call, result, contentKey, wrap }) => {
				for (const flags of [
					{},
					{ is_error: false },
					{ is_error: 'true' },
					{ is_error: 1 },
					{ is_error: null },
					{ status: 'failed' },
				]) {
					const body = wrap(
						[call],
						[{ ...result, ...flags, [contentKey]: `ERROR: exit code 1\n${LOG}` }]
					);
					const compressed = await compressRequestBody(kind, body, options());
					expect(compressed.changed).toBe(true);
					expect(compressed.stats.eligibilityVetoes).toBeUndefined();
				}
			}
		);

		it.each(formats)(
			'$kind exempts literal original recovery, argv, quoting and numeric ranges before cache reuse',
			async (format) => {
				const { kind, call, result, contentKey, wrap } = format;
				const cache = newCache();
				const primed = await compressRequestBody(
					kind,
					wrap([call], [{ ...result, [contentKey]: LOG }]),
					options({ cache })
				);
				expect(primed.stats.compressed).toBe(1);
				const frozen = await cache.read(hash);
				const read = vi.spyOn(cache, 'read');
				const write = vi.spyOn(cache, 'write');
				const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'skipped' }));
				const dataDir = path.join(os.tmpdir(), "Maestro's $data");
				const runtime = path.join(os.tmpdir(), 'Maestro bundle', 'Maestro');
				const cli = path.join(os.tmpdir(), 'Maestro bundle', 'maestro-cli.js');
				const scoped = `MAESTRO_USER_DATA=${shellEscape(dataDir)}`;
				const bundled = `${scoped} ELECTRON_RUN_AS_NODE=1 ${shellEscape(runtime)} ${shellEscape(cli)} models proxy block ${hash} --original`;
				for (const [name, input] of [
					['Bash', { command: recovery }],
					['Bash', { command: `${scoped} ${recovery}` }],
					[
						'exec_command',
						{
							cmd: `${scoped} node ${shellEscape(cli)} models proxy block ${hash} --original --lines 2:8`,
						},
					],
					['exec_command', { cmd: bundled }],
					['Bash', { command: `${bundled} --lines=2:8 --json` }],
					['shell', { command: ['sh', '-lc', `${bundled} --lines 2:8`] }],
					[
						'bash',
						{
							command: `node '/Applications/Maestro App/maestro-cli.js' models proxy block '${hash}' --original --lines 2:8`,
						},
					],
					[
						'shell',
						{
							command: [
								'/usr/local/bin/node',
								'/Applications/Maestro App/maestro-cli.js',
								'models',
								'proxy',
								'block',
								hash,
								'--original',
								'--lines=2:8',
							],
						},
					],
					['shell', { command: ['/bin/bash', '-lc', `${recovery} --start-line=2 --end-line 8`] }],
					[
						'shell',
						{
							command: [
								'node.exe',
								'C:\\Program Files\\Maestro\\maestro-cli.js',
								'models',
								'proxy',
								'block',
								hash,
								'--original',
							],
						},
					],
					[
						'shell_command',
						{
							command: `node /Applications/Maestro\\ App/maestro-cli.js models proxy block ${hash} --lines 2:8 --original`,
						},
					],
					[
						'exec_command',
						{
							cmd: `node "/Applications/Maestro App/maestro-cli.js" models proxy block ${hash.toUpperCase()} --original --json`,
						},
					],
					[
						'functions.exec_command',
						{
							cmd: `maestro-cli models proxy block ${hash} --start-line 2 --original --end-line=8`,
						},
					],
				] as const) {
					for (const early of [false, true]) {
						const body = wrap(
							[withInvocation(format, name, input)],
							[{ ...result, [contentKey]: LOG }],
							!early
						);
						const guarded = await compressRequestBody(
							kind,
							body,
							options({ cache, early, summarize, modelMinTokens: 1 })
						);
						expect(guarded).toMatchObject({
							body,
							changed: false,
							stats: { candidates: 0, cacheHits: 0, eligibilityVetoes: { failed: 0, recovery: 1 } },
						});
					}
				}
				expect(read).not.toHaveBeenCalled();
				expect(write).not.toHaveBeenCalled();
				expect(summarize).not.toHaveBeenCalled();
				expect(await newCache().read(hash)).toEqual(frozen);
			}
		);

		it.each(formats)(
			'$kind does not exempt mentions, compound commands or ambiguous recovery options',
			async (format) => {
				const { kind, result, contentKey, wrap } = format;
				const dataDir = shellEscape(path.join(os.tmpdir(), 'Maestro data'));
				const runtime = shellEscape(path.join(os.tmpdir(), 'Maestro bundle', 'Maestro'));
				const cli = shellEscape(path.join(os.tmpdir(), 'Maestro bundle', 'maestro-cli.js'));
				for (const command of [
					`echo '${recovery}'`,
					`printf '%s' '${recovery}'`,
					`cat file # ${recovery}`,
					`echo ok && ${recovery}`,
					`${recovery} | cat`,
					`${recovery}\necho done`,
					`${recovery} > output.txt`,
					`${recovery} --compressed`,
					`${recovery} --help`,
					`${recovery} --no-original=1`,
					`maestro-cli models proxy block ${hash} -- --original`,
					`maestro-cli models proxy block ${hash} --original=false`,
					`maestro-cli models proxy block ${hash} --note --original`,
					`maestro-cli models proxy block ${hash} --compressed`,
					`maestro-cli models proxy block bad-hash --original`,
					`maestro-cli models proxy block ${hash} '--original`,
					`maestro-cli models proxy block ${hash} --original\\`,
					`node "$CLI_PATH" models proxy block ${hash} --original`,
					`node other-maestro-cli.js models proxy block ${hash} --original`,
					`MAESTRO_USER_DATA=relative ${recovery}`,
					`MAESTRO_USER_DATA= ${recovery}`,
					`MAESTRO_USER_DATA="$HOME" ${recovery}`,
					`MAESTRO_USER_DATA=$(pwd) ${recovery}`,
					`'MAESTRO_USER_DATA'=${dataDir} ${recovery}`,
					`MAESTRO_USER_DATA'='${dataDir} ${recovery}`,
					`'MAESTRO_USER_DATA=/literal/data' ${recovery}`,
					`MAESTRO_USER_DATA\\=/literal/data ${recovery}`,
					`MAESTRO_USER_DATA=${dataDir} MAESTRO_USER_DATA=${dataDir} ${recovery}`,
					`NODE_OPTIONS=--require=other.js ${recovery}`,
					`PATH=/other ${recovery}`,
					`ELECTRON_RUN_AS_NODE=0 ${runtime} ${cli} models proxy block ${hash} --original`,
					`ELECTRON_RUN_AS_NODE=1 Maestro ${cli} models proxy block ${hash} --original`,
					`ELECTRON_RUN_AS_NODE=1 ${runtime} other-cli.js models proxy block ${hash} --original`,
					`ELECTRON_RUN_AS_NODE=1 ${recovery}`,
					`MAESTRO_USER_DATA=${dataDir} ${recovery} | cat`,
					`MAESTRO_USER_DATA=${dataDir} ${recovery} --compressed`,
					`MAESTRO_USER_DATA=${dataDir} ${recovery} --data-dir ${dataDir}`,
				]) {
					const body = wrap(
						[withInvocation(format, 'Bash', { command })],
						[{ ...result, [contentKey]: LOG }]
					);
					const compressed = await compressRequestBody(kind, body, options());
					expect(compressed.changed).toBe(true);
					expect(compressed.stats.eligibilityVetoes).toBeUndefined();
				}
			}
		);

		it.each(formats)(
			'$kind requires a recognized shell tool, structured input and unique linkage for recovery',
			async (format) => {
				const { kind, result, contentKey, wrap } = format;
				const call = withInvocation(format, 'Bash', { command: recovery });
				for (const calls of [
					[],
					[call, call],
					[withInvocation(format, 'Read', { command: recovery })],
					[withInvocation(format, 'Bash', recovery)],
					[withInvocation(format, 'Bash', { command: ['maestro-cli', 1, '--original'] })],
					[
						withInvocation(format, 'shell', {
							command: [
								`MAESTRO_USER_DATA=${path.join(os.tmpdir(), 'Maestro data')}`,
								'maestro-cli',
								'models',
								'proxy',
								'block',
								hash,
								'--original',
							],
						}),
					],
				]) {
					const body = wrap(calls, [{ ...result, [contentKey]: LOG }]);
					const compressed = await compressRequestBody(kind, body, options());
					expect(compressed.changed).toBe(true);
					expect(compressed.stats.eligibilityVetoes).toBeUndefined();
				}
			}
		);

		it.each(formats)(
			'$kind never compresses a result of the retrieve tool, under any client prefix, in either mode',
			async (format) => {
				const { kind, result, contentKey, wrap } = format;
				const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'skipped' }));
				for (const name of [
					'retrieve_compressed_original',
					'mcp__maestro__retrieve_compressed_original',
					'maestro__retrieve_compressed_original',
					'functions.mcp__maestro__retrieve_compressed_original',
					'MCP__Other-Server__Retrieve_Compressed_Original',
				]) {
					for (const early of [false, true]) {
						for (const recovery of [undefined, RETRIEVE_TOOL]) {
							const cache = newCache();
							const read = vi.spyOn(cache, 'read');
							const body = wrap(
								[withInvocation(format, name, { hash: hash, start_line: 1 })],
								[{ ...result, [contentKey]: LOG }],
								!early
							);
							const guarded = await compressRequestBody(
								kind,
								body,
								options({ cache, early, summarize, modelMinTokens: 1, recovery })
							);
							expect(guarded).toMatchObject({
								body,
								changed: false,
								stats: {
									candidates: 0,
									eligibilityVetoes: { failed: 0, recovery: 0, retrieval: 1 },
								},
							});
							expect(read).not.toHaveBeenCalled();
						}
					}
				}
				expect(summarize).not.toHaveBeenCalled();
			}
		);

		it.each(formats)(
			'$kind decides a tool that only resembles the retrieve tool as usual',
			async (format) => {
				const { kind, result, contentKey, wrap } = format;
				for (const name of ['myretrieve_compressed_original', 'retrieve_compressed_original_v2']) {
					const body = wrap(
						[withInvocation(format, name, { hash })],
						[{ ...result, [contentKey]: LOG }]
					);
					const compressed = await compressRequestBody(kind, body, options());
					expect(compressed.stats.compressed).toBe(1);
					expect(compressed.stats.eligibilityVetoes).toBeUndefined();
				}
				// An unlinked result names no tool: nothing to exempt.
				const unlinked = wrap([], [{ ...result, [contentKey]: LOG }]);
				expect((await compressRequestBody(kind, unlinked, options())).stats.compressed).toBe(1);
			}
		);

		it.each(formats)(
			'$kind retains freshness/cache-control gates before counting vetoes',
			async (format) => {
				const { kind, result, contentKey, wrap } = format;
				for (const [call, is_error, expectedVetoes] of [
					[format.call, true, { failed: 1, recovery: 0 }],
					[
						withInvocation(format, 'Bash', { command: recovery }),
						undefined,
						{ failed: 0, recovery: 1 },
					],
					[withInvocation(format, 'Bash', { command: recovery }), true, { failed: 1, recovery: 0 }],
				]) {
					const body = wrap(
						[call],
						[
							{
								...result,
								[contentKey]: LOG,
								is_error,
								cache_control: { type: 'ephemeral' },
							},
						],
						false
					);
					const delayed = await compressRequestBody(kind, body, options());
					expect(delayed).toMatchObject({ body, changed: false, stats: { candidates: 0 } });
					expect(delayed.stats.eligibilityVetoes).toBeUndefined();
					const early = await compressRequestBody(kind, body, options({ early: true }));
					expect(early.body).toBe(body);
					expect(early.stats.eligibilityVetoes).toEqual(expectedVetoes);
				}
			}
		);
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
		expect(result.body).toBe(anthropicBody('small', earlyCompressedLog()));
		expect(result.stats.candidates).toBe(2);
		expect(result.blocks.map((block) => block.hash)).toEqual([verdictKey(LOG, 'complete')]);
	});

	it('never leaves content out: no sampling, no line cuts, no model', async () => {
		const array = JSON.stringify(
			Array.from({ length: 60 }, (_, index) => ({ id: index, nested: { note: 'x'.repeat(40) } }))
		);
		const longLines = Array.from({ length: 12 }, (_, index) => `${index} ${'y'.repeat(1500)}`).join(
			'\n'
		);
		const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'ok', text: 'tiny' }));
		for (const text of [array, longLines]) {
			const full = await compressRequestBody(
				'anthropic-messages',
				anthropicBody(text),
				options({ summarize })
			);
			expect(full.stats.compressed).toBe(1);
			summarize.mockClear();

			const body = anthropicBody('small', text);
			const result = await compressRequestBody(
				'anthropic-messages',
				body,
				early({ summarize, modelMinTokens: 1 })
			);
			// Early mode would have to omit items or characters to shorten these,
			// and the model never reads the original: they go out whole.
			expect(result.body).toBe(body);
			expect(result.stats).toMatchObject({ compressed: 0, kept: 1 });
			expect(summarize).not.toHaveBeenCalled();
		}
	});

	it('keeps early and full verdicts apart in the shared cache', async () => {
		const cache = newCache();
		await compressRequestBody('anthropic-messages', anthropicBody(LOG), options({ cache }));
		const result = await compressRequestBody(
			'anthropic-messages',
			anthropicBody('small', LOG),
			early({ cache })
		);
		expect(result.blocks).toEqual([expect.objectContaining({ cached: false })]);
		expect((await cache.read(contentHash(LOG)))?.outcome).toBe('compressed');
		expect((await cache.read(verdictKey(LOG, 'complete')))?.outcome).toBe('compressed');
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
			text: earlyCompressedLog(),
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
		expect(chatOut.messages[2].content).toBe(earlyCompressedLog());

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
		expect(responsesOut.input[2].output).toBe(earlyCompressedLog());
	});

	describe('a launch that carries the retrieve tool', () => {
		const ARRAY = JSON.stringify(
			Array.from({ length: 60 }, (_, index) => ({ id: index, nested: { note: 'x'.repeat(40) } }))
		);

		it('chooses the profile from the launch capability, never from early alone', () => {
			expect(requestProfile({})).toBe('full');
			expect(requestProfile({ early: false, recovery: RETRIEVE_TOOL })).toBe('full');
			expect(requestProfile({ early: true })).toBe('complete');
			expect(requestProfile({ early: true, recovery: LOCAL_RECOVERY })).toBe('complete');
			expect(requestProfile({ early: true, recovery: RETRIEVE_TOOL })).toBe('full');
		});

		it('decides a fresh result with the full profile under the plain key, as compress does', async () => {
			const cache = newCache();
			const delayed = await compressRequestBody(
				'anthropic-messages',
				anthropicBody(ARRAY),
				options({ cache })
			);
			expect(delayed.stats.compressed).toBe(1);
			const delayedText = (
				(JSON.parse(delayed.body) as { messages: Array<{ content: unknown }> }).messages[2]
					.content as Array<{ content: string }>
			)[0].content;

			const result = await compressRequestBody(
				'anthropic-messages',
				anthropicBody('small', ARRAY),
				early({ cache, recovery: RETRIEVE_TOOL })
			);
			// The same verdict `compress` stored: shared key, same bytes, a cache hit.
			expect(result.blocks).toEqual([
				expect.objectContaining({ hash: verdictKey(ARRAY, 'full'), cached: true }),
			]);
			expect(verdictKey(ARRAY, 'full')).toBe(contentHash(ARRAY));
			expect(result.body).toBe(anthropicBody('small', delayedText));
		});

		it('asks the model tier, which the complete profile never does', async () => {
			const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'skipped' }));
			await compressRequestBody(
				'anthropic-messages',
				anthropicBody('small', SOURCE_FILE),
				early({ summarize, modelMinTokens: 1, recovery: RETRIEVE_TOOL })
			);
			expect(summarize).toHaveBeenCalledTimes(1);
		});

		it('never sends a lossy block to a later launch of the same conversation without it', async () => {
			const cache = newCache();
			const body = anthropicBody('small', ARRAY);
			const withTool = await compressRequestBody(
				'anthropic-messages',
				body,
				early({ cache, recovery: RETRIEVE_TOOL })
			);
			expect(withTool.stats.compressed).toBe(1);
			expect(withTool.blocks[0].hash).toBe(contentHash(ARRAY));

			// The client resends the original text it holds; the full verdict for it
			// is in the shared cache, and must not be used for this launch.
			for (const next of [body, anthropicBody(ARRAY, 'the newest result')]) {
				const without = await compressRequestBody('anthropic-messages', next, early({ cache }));
				expect(without.body).toBe(next);
				// Kept whole under its own `complete` key (a hit, after the first time).
				expect(without.stats).toMatchObject({ compressed: 0, kept: 1 });
			}
			expect((await cache.read(verdictKey(ARRAY, 'complete')))?.outcome).toBe('kept');
		});
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

	it('keeps protected diagnostics when the recovery marker erases the minimum reduction', async () => {
		const diagnostic = `Error: ${'x'.repeat(4000)}`;
		const original = `${diagnostic}\n${'z'.repeat(1440)}`;
		const shortened = `${diagnostic}\n${'z'.repeat(800)} [maestro: 640 more characters on this line]`;
		const marker = formatCompressionMarker(contentHash(original), Math.ceil(original.length / 4));
		// The line cut alone clears 10%, but its full recovery marker does not.
		expect(shortened.length).toBeLessThan(original.length * 0.9);
		expect(`${shortened}\n${marker}`.length).toBeGreaterThan(original.length * 0.9);
		const body = anthropicBody(original);
		const cache = newCache();
		const result = await compressRequestBody('anthropic-messages', body, options({ cache }));
		expect(result.body).toBe(body);
		expect(result.changed).toBe(false);
		expect(result.stats).toMatchObject({ kept: 1, compressed: 0 });
		expect(await cache.read(contentHash(original))).toMatchObject({ outcome: 'kept' });
	});
});

describe('compressRequestBody: prepared local recovery hints', () => {
	it('freezes a quoted bounded recovery command and includes its entire size in accounting', async () => {
		const cache = newCache();
		const body = anthropicBody(LOG);
		const result = await compressRequestBody(
			'anthropic-messages',
			body,
			options({ cache, recovery: LOCAL_RECOVERY })
		);
		const hash = contentHash(LOG);
		const verdict = await cache.read(hash);
		if (verdict?.outcome !== 'compressed') throw new Error('Expected a frozen replacement');
		const command = `MAESTRO_USER_DATA=${shellEscape(LOCAL_RECOVERY.dataDir)} ELECTRON_RUN_AS_NODE=1 ${shellEscape(LOCAL_RECOVERY.runtimePath)} ${shellEscape(LOCAL_RECOVERY.cliPath)} models proxy block ${hash} --original --lines 1:200`;
		expect(verdict.text).toBe(
			`${LOG_FOLDED}\n[maestro-recovery ${command}]\n${formatCompressionMarker(hash, LOG_TOKENS)}`
		);
		expect(verdict.recoveryScope).toMatch(/^[0-9a-f]{64}$/);
		expect(parseCompressionMarker(verdict.text)).toEqual({ hash, originalTokens: LOG_TOKENS });
		expect(result.stats).toMatchObject({
			compressed: 1,
			compressedTokens: Math.ceil(verdict.text.length / 4),
		});
		expect(result.blocks[0].compressedTokens).toBe(verdict.compressedTokens);
		expect(result.body).toBe(body.replace(JSON.stringify(LOG), JSON.stringify(verdict.text)));
		expect(await newCache().readOriginal(hash)).toBe(LOG);
		expect(runLocalTask).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		{ ...LOCAL_RECOVERY, kind: 'remote' },
		{ ...LOCAL_RECOVERY, environmentId: '' },
		{ ...LOCAL_RECOVERY, environmentId: `${LOCAL_RECOVERY.environmentId}\n` },
		{ ...LOCAL_RECOVERY, runtimePath: 'node' },
		{ ...LOCAL_RECOVERY, cliPath: '/opt/other-cli.js' },
		{ ...LOCAL_RECOVERY, cliPath: 'C:\\Maestro\\maestro-cli.js' },
		{ ...LOCAL_RECOVERY, dataDir: '~/.maestro' },
		{ ...LOCAL_RECOVERY, dataDir: '/data\nother' },
		{ ...LOCAL_RECOVERY, dataDir: '/data\0other' },
		{ ...LOCAL_RECOVERY, dataDir: '/data\tother' },
		{ ...LOCAL_RECOVERY, dataDir: `/${'x'.repeat(2048)}` },
		{ ...LOCAL_RECOVERY, runtimePath: `/${'x'.repeat(1000)}`, dataDir: `/${'y'.repeat(1000)}` },
	])('keeps hash-only output for absent/unsupported route syntax %#', async (recovery) => {
		const cache = newCache();
		const result = await compressRequestBody(
			'anthropic-messages',
			anthropicBody(LOG),
			options({
				cache,
				recovery: recovery as LocalRecoveryCapability | undefined,
			})
		);
		expect(result.body).toContain(JSON.stringify(compressedLog()));
		expect(result.body).not.toContain('[maestro-recovery ');
		expect(await cache.read(contentHash(LOG))).not.toHaveProperty('recoveryScope');
	});

	it('replays only the same route/environment after memory reuse and disk reload', async () => {
		const cache = newCache();
		const body = anthropicBody(LOG);
		const first = await compressRequestBody(
			'anthropic-messages',
			body,
			options({ cache, recovery: LOCAL_RECOVERY })
		);
		const frozen = await cache.read(contentHash(LOG));
		const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'ok', text: 'changed' }));
		for (const currentCache of [cache, newCache()]) {
			const write = vi.spyOn(currentCache, 'write');
			for (const recovery of [
				undefined,
				{ ...LOCAL_RECOVERY, environmentId: contentHash('another host') },
				{ ...LOCAL_RECOVERY, runtimePath: '/opt/other-runtime' },
				{ ...LOCAL_RECOVERY, cliPath: '/opt/other/maestro-cli.js' },
				{ ...LOCAL_RECOVERY, dataDir: '/other-data' },
			]) {
				const rejected = await compressRequestBody(
					'anthropic-messages',
					body,
					options({ cache: currentCache, recovery, summarize, modelMinTokens: 1 })
				);
				expect(rejected).toMatchObject({
					body,
					changed: false,
					blocks: [],
					stats: {
						kept: 1,
						compressed: 0,
						cacheHits: 1,
						recoveryScopeVetoes: 1,
						originalTokens: 0,
						compressedTokens: 0,
					},
				});
			}
			const repeated = await compressRequestBody(
				'anthropic-messages',
				body,
				options({
					cache: currentCache,
					recovery: { ...LOCAL_RECOVERY },
					summarize,
					modelMinTokens: 1,
				})
			);
			expect(repeated.body).toBe(first.body);
			expect(repeated.stats).toMatchObject({ compressed: 1, cacheHits: 1 });
			expect(repeated.stats.recoveryScopeVetoes).toBeUndefined();
			expect(write).not.toHaveBeenCalled();
			expect(await currentCache.read(contentHash(LOG))).toEqual(frozen);
		}
		expect(summarize).not.toHaveBeenCalled();
	});

	it('serializes simultaneous proven and unproven requests without a second verdict', async () => {
		const body = anthropicBody(LOG);
		const cache = newCache();
		const write = vi.spyOn(cache, 'write');
		const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'skipped' }));
		const [local, unknown] = await Promise.all([
			compressRequestBody(
				'anthropic-messages',
				body,
				options({ cache, recovery: LOCAL_RECOVERY, summarize, modelMinTokens: 1 })
			),
			compressRequestBody(
				'anthropic-messages',
				body,
				options({ cache: newCache(), summarize, modelMinTokens: 1 })
			),
		]);
		expect(local.changed).toBe(true);
		expect(unknown).toMatchObject({
			body,
			changed: false,
			stats: { cacheHits: 1, recoveryScopeVetoes: 1 },
		});
		expect(write).toHaveBeenCalledTimes(1);
		expect(summarize).toHaveBeenCalledTimes(1);
		expect(await newCache().read(contentHash(LOG))).toEqual(await cache.read(contentHash(LOG)));
	});

	it.each([undefined, null, 'not-a-scope', 42])(
		'withholds a hinted record with missing/malformed scope %# without re-deciding it',
		async (scope) => {
			const body = anthropicBody(LOG);
			await compressRequestBody('anthropic-messages', body, options({ recovery: LOCAL_RECOVERY }));
			const hash = contentHash(LOG);
			const recordPath = path.join(tempRoot.dir, hash.slice(0, 2), `${hash}.json`);
			const record = JSON.parse(await fs.readFile(recordPath, 'utf-8'));
			if (scope === undefined) delete record.recoveryScope;
			else record.recoveryScope = scope;
			const serialized = JSON.stringify(record);
			await fs.writeFile(recordPath, serialized);
			const cache = newCache();
			const write = vi.spyOn(cache, 'write');
			const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'skipped' }));
			const result = await compressRequestBody(
				'anthropic-messages',
				body,
				options({ cache, recovery: LOCAL_RECOVERY, summarize, modelMinTokens: 1 })
			);
			expect(result).toMatchObject({
				body,
				changed: false,
				stats: { cacheHits: 1, recoveryScopeVetoes: 1, kept: 1 },
			});
			expect(write).not.toHaveBeenCalled();
			expect(summarize).not.toHaveBeenCalled();
			expect(await fs.readFile(recordPath, 'utf-8')).toBe(serialized);
		}
	);

	it('does not add a hint to a frozen hash-only verdict or retry a kept verdict', async () => {
		for (const text of [LOG, SOURCE_FILE]) {
			const body = anthropicBody(text);
			const cache = newCache();
			const first = await compressRequestBody('anthropic-messages', body, options({ cache }));
			const frozen = await cache.read(contentHash(text));
			const write = vi.spyOn(cache, 'write');
			const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'ok', text: 'short' }));
			const second = await compressRequestBody(
				'anthropic-messages',
				body,
				options({ cache, recovery: LOCAL_RECOVERY, summarize, modelMinTokens: 1 })
			);
			expect(second.body).toBe(first.body);
			expect(second.body).not.toContain('[maestro-recovery ');
			expect(second.stats.cacheHits).toBe(1);
			expect(write).not.toHaveBeenCalled();
			expect(summarize).not.toHaveBeenCalled();
			expect(await newCache().read(contentHash(text))).toEqual(frozen);
		}
	});

	it('counts the full hint against minimum reduction, freezing a kept result when it does not fit', async () => {
		const text = 'INFO worker heartbeat ok\n'.repeat(30);
		const candidate = compressWithHeuristics(text);
		expect(
			`${candidate.text}\n${formatCompressionMarker(contentHash(text), Math.ceil(text.length / 4))}`
				.length
		).toBeLessThan(text.length * 0.9);
		const cache = newCache();
		const body = anthropicBody(text);
		const result = await compressRequestBody(
			'anthropic-messages',
			body,
			options({
				cache,
				minTokens: 1,
				recovery: { ...LOCAL_RECOVERY, dataDir: `/${'x'.repeat(650)}` },
			})
		);
		expect(result).toMatchObject({ body, changed: false, stats: { kept: 1, compressed: 0 } });
		expect(await cache.read(contentHash(text))).toMatchObject({ outcome: 'kept' });
		expect(await cache.read(contentHash(text))).not.toHaveProperty('recoveryScope');
	});

	it('also counts Unicode hint bytes against serialized UTF-8 reduction', async () => {
		const text = SOURCE_FILE.slice(0, 2000);
		const recovery = { ...LOCAL_RECOVERY, dataDir: `/${'界'.repeat(850)}` };
		const hint = `[maestro-recovery MAESTRO_USER_DATA=${shellEscape(recovery.dataDir)} ELECTRON_RUN_AS_NODE=1 ${shellEscape(recovery.runtimePath)} ${shellEscape(recovery.cliPath)} models proxy block ${contentHash(text)} --original --lines 1:200]`;
		const replacement = `short\n${hint}\n${formatCompressionMarker(contentHash(text), Math.ceil(text.length / 4))}`;
		expect(replacement.length).toBeLessThan(text.length * 0.9);
		expect(Buffer.byteLength(JSON.stringify(replacement))).toBeGreaterThan(
			Buffer.byteLength(JSON.stringify(text))
		);
		const body = anthropicBody(text);
		const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'ok', text: 'short' }));
		const result = await compressRequestBody(
			'anthropic-messages',
			body,
			options({ recovery, minTokens: 1, modelMinTokens: 1, summarize })
		);
		expect(result).toMatchObject({ body, changed: false, stats: { kept: 1, compressed: 0 } });
		expect(summarize).toHaveBeenCalledTimes(1);
	});

	it('exposes no command if the original archive cannot be committed', async () => {
		const cache = newCache();
		const error = Object.assign(new Error('archive full'), { code: 'ENOSPC' });
		const write = vi.spyOn(cache, 'write').mockRejectedValue(error);
		const body = anthropicBody(LOG);
		const result = await compressRequestBody(
			'anthropic-messages',
			body,
			options({ cache, recovery: LOCAL_RECOVERY })
		);
		expect(result).toMatchObject({
			body,
			changed: false,
			blocks: [],
			stats: { storeFailures: 1, compressed: 0 },
		});
		expect(write).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: 'compressed',
				recoveryScope: expect.any(String),
				text: expect.stringContaining('[maestro-recovery '),
			}),
			LOG
		);
		expect(await newCache().read(contentHash(LOG))).toBeNull();
	});

	it('exempts repeated results of the generated command before cache/model work', async () => {
		const cache = newCache();
		await compressRequestBody(
			'anthropic-messages',
			anthropicBody(LOG),
			options({ cache, recovery: LOCAL_RECOVERY })
		);
		const frozen = await cache.read(contentHash(LOG));
		if (frozen?.outcome !== 'compressed') throw new Error('Expected a frozen replacement');
		const hint = frozen.text.split('\n').find((line) => line.startsWith('[maestro-recovery '))!;
		const command = hint.slice('[maestro-recovery '.length, -1);
		const body = JSON.parse(anthropicBody(LOG));
		body.messages[1].content[0].input = { command };
		const original = JSON.stringify(body);
		const read = vi.spyOn(cache, 'read');
		const write = vi.spyOn(cache, 'write');
		const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'skipped' }));
		for (const early of [false, true]) {
			const result = await compressRequestBody(
				'anthropic-messages',
				original,
				options({ cache, recovery: LOCAL_RECOVERY, summarize, modelMinTokens: 1, early })
			);
			expect(result).toMatchObject({
				body: original,
				changed: false,
				stats: { eligibilityVetoes: { failed: 0, recovery: 1 } },
			});
		}
		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(summarize).not.toHaveBeenCalled();
		expect(runLocalTask).not.toHaveBeenCalled();
		expect(await newCache().read(contentHash(LOG))).toEqual(frozen);
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

	it.each(['compressed', 'kept'] as const)(
		'preserves a legacy %s verdict through upgrades, guard vetoes and repeat requests',
		async (outcome) => {
			const hash = contentHash(LOG);
			const prefix = path.join(tempRoot.dir, hash.slice(0, 2), hash);
			const text = 'old compressor output\r\n{"id":9007199254740993,"label":"東京"}\n';
			const record = ` {"version":1,"hash":"${hash}","outcome":"${outcome}","originalTokens":${LOG_TOKENS},"createdAt":1760000000000${outcome === 'compressed' ? ',"compressedTokens":20,"compressors":["model"]' : ''}}\n`;
			const files = [
				['.json', record],
				...(outcome === 'compressed'
					? [
							['.original.txt', LOG],
							['.compressed.txt', text],
						]
					: []),
			];
			await fs.mkdir(path.dirname(prefix), { recursive: true });
			for (const [suffix, contents] of files) await fs.writeFile(`${prefix}${suffix}`, contents);

			// LOG is shortened by today's heuristics, but even an old kept verdict wins.
			const body = anthropicBody(LOG).replace('{', '{ "exact":9007199254740993, ');
			const expected =
				outcome === 'compressed' ? body.replace(JSON.stringify(LOG), JSON.stringify(text)) : body;
			const cache = newCache();
			const read = vi.spyOn(cache, 'read');
			const write = vi.spyOn(cache, 'write');
			const summarize = vi.fn(
				async (): Promise<ModelSummary> => ({
					status: 'ok',
					text: 'a new summary must never replace the old verdict',
				})
			);
			for (const guardedBody of [
				body.replace('"tool_use_id":"t1"', '"tool_use_id":"t1","is_error":true'),
				body.replace(
					'"input":{}',
					`"input":${JSON.stringify({ command: `maestro-cli models proxy block ${hash} --original` })}`
				),
			]) {
				const guarded = await compressRequestBody(
					'anthropic-messages',
					guardedBody,
					options({ cache, summarize, modelMinTokens: 1 })
				);
				expect(guarded).toMatchObject({ body: guardedBody, changed: false, blocks: [] });
				expect(read).not.toHaveBeenCalled();
				expect(write).not.toHaveBeenCalled();
			}
			for (const currentCache of [cache, cache, newCache()]) {
				const result = await compressRequestBody(
					'anthropic-messages',
					body,
					options({ cache: currentCache, summarize, modelMinTokens: 1 })
				);
				expect(result.body).toBe(expected);
				expect(result.stats).toMatchObject({
					cacheHits: 1,
					compressed: outcome === 'compressed' ? 1 : 0,
					kept: outcome === 'kept' ? 1 : 0,
				});
			}
			expect(write).not.toHaveBeenCalled();
			expect(summarize).not.toHaveBeenCalled();
			for (const [suffix, contents] of files) {
				expect(await fs.readFile(`${prefix}${suffix}`)).toEqual(Buffer.from(contents, 'utf-8'));
			}
			expect((await fs.readdir(path.dirname(prefix))).sort()).toEqual(
				files.map(([suffix]) => `${hash}${suffix}`).sort()
			);
		}
	);

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

describe('compressRequestBody: deterministic filter integration', () => {
	const fixtures = [
		{
			compressor: 'git-status',
			text: Array.from({ length: 500 }, (_, index) => ` M f${index}.ts`).join('\n'),
			retained: 'f499.ts',
		},
		{
			compressor: 'git-log',
			text: [
				`commit ${'a'.repeat(40)}`,
				'Author: Fixture <fixture@example.invalid>',
				'Date:   Fri Nov 6 10:11:12 2026 -0600',
				'',
				'    Preserve this subject',
				...Array.from({ length: 50 }, (_, index) => `    detail ${index} ${'x'.repeat(100)}`),
			].join('\n'),
			retained: `commit ${'a'.repeat(40)}`,
		},
		{
			compressor: 'search',
			text: Array.from(
				{ length: 100 },
				(_, index) => `src/工程/directory with spaces/file.ts:${index + 1}:match ${index}`
			).join('\n'),
			retained: '100:match 99',
		},
		{
			compressor: 'test-output',
			text: [
				' RUN  v4.1.11 /fixture/maestro',
				...Array.from({ length: 500 }, (_, index) => ` ✓ a${index} (1 test) 1ms`),
				' Test Files  500 passed (500)',
				'      Tests  500 passed (500)',
				'Exit code: 0',
			].join('\n'),
			retained: 'a499 (1 test) 1ms',
		},
		{
			compressor: 'build-output',
			text: [
				'vite v8.3.4 building client environment for production...',
				'transforming...',
				'✓ 1200 modules transformed.',
				...Array.from(
					{ length: 60 },
					(_, index) => `dist/a${index}.js${' '.repeat(60)}1.23 kB  | gzip: 0.80 kB`
				),
				'✓ built in 2.34s',
			].join('\n'),
			retained: 'dist/a59.js 1.23 kB | gzip: 0.80 kB',
		},
		{
			compressor: 'lint-output',
			text: [
				'/fixture/src/工程/file.ts',
				...Array.from(
					{ length: 50 },
					(_, index) =>
						`        ${index + 1}:3        warning${' '.repeat(40)}Unused binding ${index}  no-unused-vars`
				),
				'✖ 50 problems (0 errors, 50 warnings)',
			].join('\n'),
			retained: '50:3 warning Unused binding 49  no-unused-vars',
		},
		{
			compressor: 'json-table',
			text:
				'[' +
				Array.from(
					{ length: 100 },
					(_, index) =>
						`{"record_identifier":9007199254740993,"record_label":"東京 ${index}","optional_value":null}`
				).join(',') +
				']',
			retained: '9007199254740993\t"東京 99"\tnull',
		},
	] as const;
	// Handwritten envelopes expose changes to escapes, ordering, large numbers,
	// system/developer/user/assistant text, tool declarations and call linkage.
	const envelopes = [
		{
			kind: 'anthropic-messages',
			before: String.raw`{ "model":"fixture", "system":"Caf\u00e9 \/ rules", "tools":[{"name":"Bash","input_schema":{"b":9007199254740993,"1":2}}], "messages":[{"role":"user","content":"keep  spacing"},{"role":"assistant","content":[{"type":"tool_use","id":"c1","name":"Bash","input":{"command":"printf fixture"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":`,
			after: String.raw`} ]},{"role":"assistant","content":[{"type":"text","text":"Done \/ exactly"}]},{"role":"user","content":"next  step"}] }`,
		},
		{
			kind: 'openai-chat-completions',
			before: String.raw`{ "model":"fixture", "tools":[{"type":"function","function":{"name":"shell","parameters":{"b":9007199254740993,"1":2}}}], "messages":[{"role":"system","content":"Caf\u00e9 \/ rules"},{"role":"user","content":"keep  spacing"},{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"shell","arguments":"{\"command\":\"git status\"}"}}]},{"role":"tool","tool_call_id":"c1","content":`,
			after: String.raw`},{"role":"assistant","content":"Done \/ exactly"},{"role":"user","content":"next  step"}] }`,
		},
		{
			kind: 'openai-responses',
			before: String.raw`{ "model":"fixture", "instructions":"Caf\u00e9 \/ rules", "tools":[{"type":"function","name":"exec_command","parameters":{"b":9007199254740993,"1":2}}], "input":[{"type":"message","role":"developer","content":[{"type":"input_text","text":"keep  spacing"}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"original  request"}]},{"type":"function_call","call_id":"c1","name":"exec_command","arguments":"{\"cmd\":\"rg fixture\"}"},{"type":"function_call_output","call_id":"c1","output":`,
			after: String.raw`},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done \/ exactly"}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"next  step"}]}] }`,
		},
	] as const;

	it.each(fixtures)(
		'integrates $compressor once across APIs and modes, preserving every surrounding byte',
		async ({ compressor, text, retained }) => {
			const cache = newCache();
			const write = vi.spyOn(cache, 'write');
			const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'skipped' }));
			let replacement: string | undefined;
			for (const { kind, before, after } of envelopes) {
				const body = `${before}${JSON.stringify(text)}${after}`;
				const first = await compressRequestBody(kind, body, options({ cache, summarize }));
				const verdict = await cache.read(contentHash(text));
				expect(verdict?.outcome).toBe('compressed');
				if (verdict?.outcome !== 'compressed') throw new Error('Expected a frozen replacement');
				replacement ??= verdict.text;
				expect(verdict.text).toBe(replacement);
				expect(replacement).toContain(retained);
				expect(verdict.compressors).toEqual([compressor]);
				expect(parseCompressionMarker(replacement)).toEqual({
					hash: contentHash(text),
					originalTokens: Math.ceil(text.length / 4),
				});
				expect(replacement.length).toBeLessThanOrEqual(text.length * 0.9);
				expect(first.changed).toBe(true);
				expect(first.body).toBe(`${before}${JSON.stringify(replacement)}${after}`);
				expect(Buffer.byteLength(first.body)).toBeLessThan(Buffer.byteLength(body));
				expect(first.stats.compressors[compressor]).toBe(1);
				expect(Object.values(first.stats.compressors).reduce((sum, count) => sum + count, 0)).toBe(
					1
				);
				const again = await compressRequestBody(kind, body, options({ cache, summarize }));
				expect(again.body).toBe(first.body);
				expect(again.stats).toMatchObject({ compressed: 1, cacheHits: 1 });
				expect(again.stats.compressors[compressor]).toBe(1);

				// Early mode decides under its own key with the `complete` profile:
				// the same reduction when it leaves nothing out, none when it samples.
				const earlyResult = await compressRequestBody(
					kind,
					body,
					options({ cache: newCache(), summarize, early: true })
				);
				if (compressor === 'git-log' || compressor === 'search') {
					expect(earlyResult.body).toBe(body);
					expect(earlyResult.stats.compressed).toBe(0);
				} else {
					const fullMarker = formatCompressionMarker(contentHash(text), Math.ceil(text.length / 4));
					const earlyMarker = formatCompressionMarker(
						verdictKey(text, 'complete'),
						Math.ceil(text.length / 4)
					);
					expect(earlyResult.body).toBe(
						`${before}${JSON.stringify(replacement.replace(fullMarker, earlyMarker))}${after}`
					);
					expect(earlyResult.stats.compressors[compressor]).toBe(1);
				}
			}
			expect(write).toHaveBeenCalledTimes(1);
			expect(summarize).not.toHaveBeenCalled();
			expect(runLocalTask).not.toHaveBeenCalled();
			expect(await newCache().readOriginal(contentHash(text))).toBe(text);
		}
	);

	it.each(['kept', 'compressed'] as const)(
		'retains an existing %s verdict for newly recognized table content',
		async (outcome) => {
			const text = fixtures[6].text;
			const hash = contentHash(text);
			const cache = newCache();
			const base = { hash, originalTokens: Math.ceil(text.length / 4), createdAt: 1760000000000 };
			const legacy = 'legacy replacement bytes';
			await cache.write(
				outcome === 'kept'
					? { ...base, outcome }
					: { ...base, outcome, text: legacy, compressedTokens: 6, compressors: ['json'] },
				text
			);
			const write = vi.spyOn(cache, 'write');
			for (const currentCache of [cache, newCache()]) {
				const body = anthropicBody(text);
				const result = await compressRequestBody(
					'anthropic-messages',
					body,
					options({ cache: currentCache })
				);
				expect(result.body).toBe(
					outcome === 'kept' ? body : body.replace(JSON.stringify(text), JSON.stringify(legacy))
				);
				expect(result.stats.cacheHits).toBe(1);
			}
			expect(write).not.toHaveBeenCalled();
		}
	);

	it('counts the recovery marker before accepting a new command filter', async () => {
		const text = Array.from({ length: 80 }, (_, index) => ` M a${index}.ts`).join('\n');
		const candidate = compressWithHeuristics(text);
		expect(candidate.applied).toEqual(['git-status']);
		expect(candidate.text.length).toBeLessThan(text.length * 0.9);
		const marker = formatCompressionMarker(contentHash(text), Math.ceil(text.length / 4));
		expect(`${candidate.text}\n${marker}`.length).toBeGreaterThan(text.length * 0.9);
		const body = anthropicBody(text);
		const cache = newCache();
		const result = await compressRequestBody(
			'anthropic-messages',
			body,
			options({ cache, minTokens: 1 })
		);
		expect(result).toMatchObject({ body, changed: false, stats: { kept: 1, compressed: 0 } });
		expect(await cache.read(contentHash(text))).toMatchObject({ outcome: 'kept' });
	});

	it('does not follow or expand a native persisted-output stub', async () => {
		const nativeFile = path.join(tempRoot.dir, 'native-output.txt');
		await fs.writeFile(nativeFile, fixtures[6].text);
		const read = vi.spyOn(fs, 'readFile');
		const text = `Tool output truncated.\nFull output saved to: ${nativeFile}\nPreview: first row only`;
		const body = anthropicBody(text);
		const result = await compressRequestBody('anthropic-messages', body, options({ minTokens: 1 }));
		expect(result).toMatchObject({ body, changed: false });
		expect(read.mock.calls.filter(([file]) => file === nativeFile)).toEqual([]);
		expect(runLocalTask).not.toHaveBeenCalled();
	});

	it('keeps a shorter decoded candidate when its serialized UTF-8 would expand the result', async () => {
		const text = SOURCE_FILE.slice(0, 1000);
		const summary = '界'.repeat(400);
		const replacement = `${summary}\n${formatCompressionMarker(contentHash(text), Math.ceil(text.length / 4))}`;
		expect(replacement.length).toBeLessThan(text.length * 0.9);
		expect(Buffer.byteLength(JSON.stringify(replacement))).toBeGreaterThan(
			Buffer.byteLength(JSON.stringify(text))
		);
		const summarize = vi.fn(async (): Promise<ModelSummary> => ({ status: 'ok', text: summary }));
		const body = anthropicBody(text);
		const result = await compressRequestBody(
			'anthropic-messages',
			body,
			options({ minTokens: 1, modelMinTokens: 1, summarize })
		);
		expect(result).toMatchObject({ body, changed: false, stats: { kept: 1, compressed: 0 } });
		expect(summarize).toHaveBeenCalledTimes(1);
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
			withEntry: real.withEntry,
			usage: real.usage,
			prune: real.prune,
		};
	}

	it.each([false, true])(
		'waits for the archive commit before exposing a replacement (hint=%s)',
		async (hinted) => {
			const cache = newCache();
			const commit = cache.write;
			let release: () => void = () => {};
			const ready = new Promise<void>((resolve) => (release = resolve));
			const write = vi.spyOn(cache, 'write').mockImplementation(async (verdict, original) => {
				await ready;
				await commit(verdict, original);
			});
			let finished = false;
			const request = compressRequestBody(
				'anthropic-messages',
				anthropicBody(LOG),
				options({ cache, recovery: hinted ? LOCAL_RECOVERY : undefined })
			);
			void request.then(() => (finished = true));
			try {
				await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
				expect(finished).toBe(false);
				expect(await newCache().read(contentHash(LOG))).toBeNull();
			} finally {
				release();
			}
			const result = await request;
			expect(result.stats.compressed).toBe(1);
			expect(await newCache().readOriginal(contentHash(LOG))).toBe(LOG);
			expect(await newCache().read(contentHash(LOG))).toMatchObject({
				outcome: 'compressed',
				text: hinted ? expect.stringContaining('[maestro-recovery ') : compressedLog(),
				...(hinted ? { recoveryScope: expect.stringMatching(/^[0-9a-f]{64}$/) } : {}),
			});
		}
	);

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
