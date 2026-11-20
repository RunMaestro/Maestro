/**
 * @file response-usage.test.ts
 * @description The provider's own token counts, read from the answer the
 * proxy forwards: Anthropic event streams (message_start, then cumulative
 * message_delta), OpenAI Chat Completions and Responses (cached tokens moved
 * out of the prompt total), whole JSON bodies, compressed bodies, and the
 * bounds that make an unreadable answer unknown rather than zero.
 */

import { describe, it, expect } from 'vitest';
import * as zlib from 'zlib';
import {
	createProviderUsageReader,
	parseProviderUsage,
	USAGE_READ_MAX_BYTES,
} from '../../../../main/local-models/proxy/response-usage';
import type { TokenProxyRequestKind } from '../../../../shared/local-models/token-proxy';
import type {
	ProxyProviderClassStatus,
	ProxyProviderReportedness,
} from '../../../../shared/stats-types';

function sse(...events: Array<[string, unknown]>): string {
	return events
		.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
		.join('');
}

/** How each class got its number, in the order a row stores them. */
function statuses(
	input: ProxyProviderClassStatus,
	cacheRead: ProxyProviderClassStatus,
	cacheWrite: ProxyProviderClassStatus,
	output: ProxyProviderClassStatus
): ProxyProviderReportedness {
	return { input, cacheRead, cacheWrite, output };
}

const ALL_REPORTED = statuses('reported', 'reported', 'reported', 'reported');
const OPENAI_WITH_CACHE_DETAIL = statuses('derived', 'reported', 'not-applicable', 'reported');

const ANTHROPIC_STREAM = sse(
	[
		'message_start',
		{
			type: 'message_start',
			message: {
				id: 'msg_1',
				usage: {
					input_tokens: 12,
					cache_creation_input_tokens: 1750,
					cache_read_input_tokens: 26102,
					output_tokens: 1,
				},
			},
		},
	],
	['content_block_delta', { type: 'content_block_delta', delta: { text: '"usage" in prose' } }],
	['message_delta', { type: 'message_delta', usage: { output_tokens: 214 } }],
	['message_stop', { type: 'message_stop' }]
);

describe('parseProviderUsage', () => {
	it('reads an Anthropic stream, later counts replacing earlier ones', () => {
		expect(parseProviderUsage('anthropic-messages', ANTHROPIC_STREAM)).toEqual({
			inputTokens: 12,
			cacheReadTokens: 26102,
			cacheWriteTokens: 1750,
			outputTokens: 214,
			reportedness: ALL_REPORTED,
		});
	});

	it('reads a whole Anthropic JSON answer, and says it never named a cache write', () => {
		const body = JSON.stringify({
			id: 'msg_1',
			usage: { input_tokens: 5, cache_read_input_tokens: 9, output_tokens: 3 },
		});
		expect(parseProviderUsage('anthropic-messages', body)).toEqual({
			inputTokens: 5,
			cacheReadTokens: 9,
			cacheWriteTokens: 0,
			outputTokens: 3,
			reportedness: statuses('reported', 'reported', 'unreported', 'reported'),
		});
	});

	it('moves OpenAI cached tokens out of the prompt total', () => {
		const chat = `data: ${JSON.stringify({ choices: [] })}\n\ndata: ${JSON.stringify({
			choices: [],
			usage: {
				prompt_tokens: 1000,
				completion_tokens: 40,
				prompt_tokens_details: { cached_tokens: 800 },
			},
		})}\n\ndata: [DONE]\n\n`;
		expect(parseProviderUsage('openai-chat-completions', chat)).toEqual({
			inputTokens: 200,
			cacheReadTokens: 800,
			cacheWriteTokens: 0,
			outputTokens: 40,
			reportedness: OPENAI_WITH_CACHE_DETAIL,
		});

		const responses = sse([
			'response.completed',
			{
				type: 'response.completed',
				response: {
					usage: {
						input_tokens: 51150,
						input_tokens_details: { cached_tokens: 50000 },
						output_tokens: 90,
					},
				},
			},
		]);
		expect(parseProviderUsage('openai-responses', responses)).toEqual({
			inputTokens: 1150,
			cacheReadTokens: 50000,
			cacheWriteTokens: 0,
			outputTokens: 90,
			reportedness: OPENAI_WITH_CACHE_DETAIL,
		});
	});

	it('answers null for an answer that names no usage, or a request that is not a message', () => {
		expect(parseProviderUsage('anthropic-messages', sse(['ping', { type: 'ping' }]))).toBeNull();
		expect(
			parseProviderUsage('anthropic-messages', '{"error":{"message":"overloaded"}}')
		).toBeNull();
		expect(parseProviderUsage('anthropic-messages', 'data: {"usage": not json\n')).toBeNull();
		expect(parseProviderUsage('other', ANTHROPIC_STREAM)).toBeNull();
	});
});

describe('createProviderUsageReader', () => {
	it('reads a stream split across chunks at any byte', () => {
		const bytes = Buffer.from(ANTHROPIC_STREAM, 'utf-8');
		const reader = createProviderUsageReader('anthropic-messages', null);
		for (let at = 0; at < bytes.length; at += 7) reader.push(bytes.subarray(at, at + 7));
		expect(reader.finish()?.outputTokens).toBe(214);
	});

	it.each([
		['gzip', (b: Buffer) => zlib.gzipSync(b)],
		['br', (b: Buffer) => zlib.brotliCompressSync(b)],
		['deflate', (b: Buffer) => zlib.deflateSync(b)],
	] as const)('decodes a %s answer', (encoding, encode) => {
		const reader = createProviderUsageReader('anthropic-messages', encoding);
		reader.push(encode(Buffer.from(ANTHROPIC_STREAM, 'utf-8')));
		expect(reader.finish()?.cacheReadTokens).toBe(26102);
	});

	it('still reads the usage of a gzip stream cut short after message_start', async () => {
		// Flush after message_start, so the cut lands after bytes that decode to it.
		const split = ANTHROPIC_STREAM.indexOf('event: content_block_delta');
		const gzip = zlib.createGzip();
		const out: Buffer[] = [];
		gzip.on('data', (chunk: Buffer) => out.push(chunk));
		gzip.write(ANTHROPIC_STREAM.slice(0, split));
		await new Promise<void>((resolve) => gzip.flush(zlib.constants.Z_SYNC_FLUSH, () => resolve()));
		const flushed = Buffer.concat(out).length;
		gzip.end(ANTHROPIC_STREAM.slice(split));
		await new Promise((resolve) => gzip.on('end', resolve));
		const whole = Buffer.concat(out);

		const reader = createProviderUsageReader('anthropic-messages', 'gzip');
		// Cut at the flush: no final block and no trailer, as a dropped connection leaves it.
		expect(whole.length).toBeGreaterThan(flushed);
		reader.push(whole.subarray(0, flushed));
		expect(reader.finish()).toEqual({
			inputTokens: 12,
			cacheReadTokens: 26102,
			cacheWriteTokens: 1750,
			outputTokens: 1,
			reportedness: ALL_REPORTED,
		});
	});

	it('reads a plain stream without keeping it: past the bound, the usage lines still count', () => {
		const reader = createProviderUsageReader('anthropic-messages', null);
		const [start, rest] = [
			ANTHROPIC_STREAM.slice(0, ANTHROPIC_STREAM.indexOf('event: content_block_delta')),
			ANTHROPIC_STREAM.slice(ANTHROPIC_STREAM.indexOf('event: content_block_delta')),
		];
		reader.push(Buffer.from(start, 'utf-8'));
		// More than the bound in ordinary delta lines, which a kept copy could not hold.
		const delta = Buffer.from(
			`event: content_block_delta\ndata: ${JSON.stringify({ delta: { text: 'x'.repeat(4000) } })}\n\n`
		);
		for (let sent = 0; sent <= USAGE_READ_MAX_BYTES; sent += delta.length) reader.push(delta);
		reader.push(Buffer.from(rest, 'utf-8'));
		expect(reader.finish()).toEqual({
			inputTokens: 12,
			cacheReadTokens: 26102,
			cacheWriteTokens: 1750,
			outputTokens: 214,
			reportedness: ALL_REPORTED,
		});
	});

	it('skips one stream line past the bound and reads the lines after it', () => {
		const reader = createProviderUsageReader('anthropic-messages', null);
		reader.push(Buffer.from('data: {"text":"'));
		reader.push(Buffer.alloc(USAGE_READ_MAX_BYTES + 1, 0x61));
		reader.push(Buffer.from('","usage":{"input_tokens":999}}\n'));
		reader.push(Buffer.from(ANTHROPIC_STREAM.replace(/\n/g, '\r\n')));
		expect(reader.finish()).toMatchObject({ inputTokens: 12, outputTokens: 214 });
	});

	it('reads a final data line the stream never ended, and a JSON body after leading blank lines', () => {
		const cut = createProviderUsageReader('anthropic-messages', null);
		cut.push(Buffer.from('event: message_delta\ndata: {"usage":{"output_tokens":7}}'));
		expect(cut.finish()).toMatchObject({ outputTokens: 7 });

		const body = createProviderUsageReader('anthropic-messages', 'identity');
		body.push(Buffer.from('\n  '));
		body.push(
			Buffer.from('{\n  "usage": {\n    "input_tokens": 3,\n    "output_tokens": 2\n  }\n}')
		);
		expect(body.finish()).toEqual({
			inputTokens: 3,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 2,
			reportedness: statuses('reported', 'unreported', 'unreported', 'reported'),
		});
	});

	it('answers null for an encoding it cannot decode, an empty body, and past its bound', () => {
		const unknown = createProviderUsageReader('anthropic-messages', 'compress');
		unknown.push(Buffer.from(ANTHROPIC_STREAM));
		expect(unknown.finish()).toBeNull();

		expect(createProviderUsageReader('anthropic-messages', null).finish()).toBeNull();

		const large = createProviderUsageReader('anthropic-messages', null);
		large.push(Buffer.from('{"usage":{"input_tokens":1,"pad":"'));
		large.push(Buffer.alloc(USAGE_READ_MAX_BYTES + 1, 0x20));
		large.push(Buffer.from('"}}'));
		expect(large.finish()).toBeNull();

		const encoded = createProviderUsageReader('anthropic-messages', 'gzip');
		encoded.push(Buffer.alloc(USAGE_READ_MAX_BYTES + 1));
		expect(encoded.finish()).toBeNull();
	});
});

/** The three APIs that carry a usage. */
type ApiKind = Exclude<TokenProxyRequestKind, 'other'>;

/** Text of an answer that no stored figure may ever hold. */
const ANSWER_TEXT = 'PRIVATE-ANSWER-TEXT';

/**
 * One `usage` object as each API sends it, in the two shapes an answer takes: a
 * whole JSON body and an event stream. The rest of the answer is real too (its
 * text, its other events), so the reader meets what a provider writes.
 */
function answersNaming(kind: ApiKind, usage: Record<string, unknown>): Array<[string, string]> {
	switch (kind) {
		case 'anthropic-messages':
			return [
				[
					'a whole answer',
					JSON.stringify({
						id: 'msg_1',
						type: 'message',
						content: [{ type: 'text', text: ANSWER_TEXT }],
						usage,
					}),
				],
				[
					'an event stream',
					sse(
						['message_start', { type: 'message_start', message: { id: 'msg_1', usage } }],
						['content_block_delta', { type: 'content_block_delta', delta: { text: ANSWER_TEXT } }],
						['message_stop', { type: 'message_stop' }]
					),
				],
			];
		case 'openai-chat-completions':
			return [
				[
					'a whole answer',
					JSON.stringify({
						id: 'chatcmpl_1',
						object: 'chat.completion',
						choices: [{ message: { content: ANSWER_TEXT } }],
						usage,
					}),
				],
				[
					'an event stream',
					`data: ${JSON.stringify({ choices: [{ delta: { content: ANSWER_TEXT } }] })}\n\n` +
						`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`,
				],
			];
		case 'openai-responses':
			return [
				[
					'a whole answer',
					JSON.stringify({ id: 'resp_1', object: 'response', output_text: ANSWER_TEXT, usage }),
				],
				[
					'an event stream',
					sse(
						[
							'response.output_text.delta',
							{ type: 'response.output_text.delta', delta: ANSWER_TEXT },
						],
						[
							'response.completed',
							{ type: 'response.completed', response: { id: 'resp_1', usage } },
						]
					),
				],
			];
	}
}

/** The reader as the proxy drives it: the answer in small pieces, cut anywhere. */
function readInPieces(kind: ApiKind, text: string, pieceBytes = 5) {
	const reader = createProviderUsageReader(kind, null);
	const bytes = Buffer.from(text, 'utf-8');
	for (let at = 0; at < bytes.length; at += pieceBytes) {
		reader.push(bytes.subarray(at, at + pieceBytes));
	}
	return reader.finish();
}

interface ClassCase {
	name: string;
	kind: ApiKind;
	usage: Record<string, unknown>;
	/** The four numbers, in the order a row stores them. */
	tokens: [input: number, cacheRead: number, cacheWrite: number, output: number];
	reportedness: ProxyProviderReportedness;
}

const CLASS_CASES: ClassCase[] = [
	{
		name: 'Anthropic names only output: input and both cache classes are unreported, not zero',
		kind: 'anthropic-messages',
		usage: { output_tokens: 7 },
		tokens: [0, 0, 0, 7],
		reportedness: statuses('unreported', 'unreported', 'unreported', 'reported'),
	},
	{
		name: 'Anthropic names only input: output and both cache classes are unreported, not zero',
		kind: 'anthropic-messages',
		usage: { input_tokens: 5 },
		tokens: [5, 0, 0, 0],
		reportedness: statuses('reported', 'unreported', 'unreported', 'unreported'),
	},
	{
		name: 'Anthropic names a zero for every class: each is a reported zero',
		kind: 'anthropic-messages',
		usage: {
			input_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
			output_tokens: 0,
		},
		tokens: [0, 0, 0, 0],
		reportedness: ALL_REPORTED,
	},
	{
		name: 'Anthropic names a zero cache write: reported, where the cache read it left out is not',
		kind: 'anthropic-messages',
		usage: { input_tokens: 12, cache_creation_input_tokens: 0, output_tokens: 3 },
		tokens: [12, 0, 0, 3],
		reportedness: statuses('reported', 'unreported', 'reported', 'reported'),
	},
	{
		name: 'Anthropic names only a cache read: that is a class named, so the usage is not unknown',
		kind: 'anthropic-messages',
		usage: { cache_read_input_tokens: 9 },
		tokens: [0, 9, 0, 0],
		reportedness: statuses('unreported', 'reported', 'unreported', 'unreported'),
	},
	{
		name: 'OpenAI Chat Completions with cache detail: input is derived, the cache read is reported',
		kind: 'openai-chat-completions',
		usage: {
			prompt_tokens: 20,
			prompt_tokens_details: { cached_tokens: 5 },
			completion_tokens: 3,
		},
		tokens: [15, 5, 0, 3],
		reportedness: OPENAI_WITH_CACHE_DETAIL,
	},
	{
		name: 'OpenAI Responses with cache detail: input is derived, the cache read is reported',
		kind: 'openai-responses',
		usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 5 }, output_tokens: 3 },
		tokens: [15, 5, 0, 3],
		reportedness: OPENAI_WITH_CACHE_DETAIL,
	},
	{
		name: 'OpenAI Chat Completions with a cache read of zero: the zero is reported',
		kind: 'openai-chat-completions',
		usage: {
			prompt_tokens: 20,
			prompt_tokens_details: { cached_tokens: 0 },
			completion_tokens: 3,
		},
		tokens: [20, 0, 0, 3],
		reportedness: OPENAI_WITH_CACHE_DETAIL,
	},
	{
		name: 'OpenAI Responses with a cache read of zero: the zero is reported',
		kind: 'openai-responses',
		usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3 },
		tokens: [20, 0, 0, 3],
		reportedness: OPENAI_WITH_CACHE_DETAIL,
	},
	{
		name: 'OpenAI cached count above the prompt total: input derives to zero, never below it',
		kind: 'openai-chat-completions',
		usage: {
			prompt_tokens: 5,
			prompt_tokens_details: { cached_tokens: 8 },
			completion_tokens: 3,
		},
		tokens: [0, 8, 0, 3],
		reportedness: OPENAI_WITH_CACHE_DETAIL,
	},
	{
		name: 'OpenAI Chat Completions with a prompt total and no cache detail: the total is not uncached input',
		kind: 'openai-chat-completions',
		usage: { prompt_tokens: 20, completion_tokens: 3 },
		tokens: [0, 0, 0, 3],
		reportedness: statuses('unreported', 'unreported', 'not-applicable', 'reported'),
	},
	{
		name: 'OpenAI Responses with a prompt total and no cache detail: the total is not uncached input',
		kind: 'openai-responses',
		usage: { input_tokens: 20, output_tokens: 3 },
		tokens: [0, 0, 0, 3],
		reportedness: statuses('unreported', 'unreported', 'not-applicable', 'reported'),
	},
	{
		name: 'OpenAI detail that names no cached count is no cache detail',
		kind: 'openai-chat-completions',
		usage: {
			prompt_tokens: 20,
			prompt_tokens_details: { audio_tokens: 2 },
			completion_tokens: 3,
		},
		tokens: [0, 0, 0, 3],
		reportedness: statuses('unreported', 'unreported', 'not-applicable', 'reported'),
	},
	{
		name: 'OpenAI names only output',
		kind: 'openai-chat-completions',
		usage: { completion_tokens: 3 },
		tokens: [0, 0, 0, 3],
		reportedness: statuses('unreported', 'unreported', 'not-applicable', 'reported'),
	},
	{
		name: 'OpenAI names a cached count and no prompt total: it is a cache read, and input cannot be derived',
		kind: 'openai-responses',
		usage: { input_tokens_details: { cached_tokens: 5 } },
		tokens: [0, 5, 0, 0],
		reportedness: statuses('unreported', 'reported', 'not-applicable', 'unreported'),
	},
];

describe('what the provider reported, class by class', () => {
	describe.each(CLASS_CASES)('$name', ({ kind, usage, tokens, reportedness }) => {
		const [inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens] = tokens;
		const expected = { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reportedness };

		it.each(answersNaming(kind, usage))(
			'is read from %s, whole, in pieces and gzipped',
			(_shape, text) => {
				expect(parseProviderUsage(kind, text)).toEqual(expected);
				expect(readInPieces(kind, text)).toEqual(expected);

				const encoded = createProviderUsageReader(kind, 'gzip');
				encoded.push(zlib.gzipSync(Buffer.from(text, 'utf-8')));
				expect(encoded.finish()).toEqual(expected);
			}
		);
	});

	it('keeps the numbers a normalized reader always gave: an unreported or inapplicable class is 0', () => {
		for (const { kind, usage, tokens, reportedness } of CLASS_CASES) {
			const [, text] = answersNaming(kind, usage)[0];
			const read = parseProviderUsage(kind, text)!;
			const numbers = [
				read.inputTokens,
				read.cacheReadTokens,
				read.cacheWriteTokens,
				read.outputTokens,
			];
			const states = [
				reportedness.input,
				reportedness.cacheRead,
				reportedness.cacheWrite,
				reportedness.output,
			];
			expect(numbers).toEqual(tokens);
			states.forEach((status, at) => {
				if (status === 'unreported' || status === 'not-applicable') expect(numbers[at]).toBe(0);
			});
		}
	});

	it('carries no text of the answer: five fields, and statuses from a closed set', () => {
		const allowed = new Set<string>(['reported', 'derived', 'not-applicable', 'unreported']);
		for (const { kind, usage } of CLASS_CASES) {
			for (const [, text] of answersNaming(kind, usage)) {
				const read = readInPieces(kind, text)!;
				expect(Object.keys(read).sort()).toEqual([
					'cacheReadTokens',
					'cacheWriteTokens',
					'inputTokens',
					'outputTokens',
					'reportedness',
				]);
				expect(Object.values(read.reportedness!).every((status) => allowed.has(status))).toBe(true);
				expect(JSON.stringify(read)).not.toContain(ANSWER_TEXT);
			}
		}
	});

	describe('across the events of one stream', () => {
		const PARTIAL_STREAM = sse(
			[
				'message_start',
				{
					type: 'message_start',
					message: { usage: { input_tokens: 5, cache_read_input_tokens: 9 } },
				},
			],
			['message_delta', { type: 'message_delta', usage: { output_tokens: 3 } }]
		);

		it('keeps what an earlier event reported and leaves unreported what no event named', () => {
			const expected = {
				inputTokens: 5,
				cacheReadTokens: 9,
				cacheWriteTokens: 0,
				outputTokens: 3,
				reportedness: statuses('reported', 'reported', 'unreported', 'reported'),
			};
			expect(parseProviderUsage('anthropic-messages', PARTIAL_STREAM)).toEqual(expected);
			expect(readInPieces('anthropic-messages', PARTIAL_STREAM)).toEqual(expected);
		});

		it('leaves output unreported when a stream was cut before any event named it', () => {
			const cutAfterStart = PARTIAL_STREAM.slice(0, PARTIAL_STREAM.indexOf('event: message_delta'));
			expect(readInPieces('anthropic-messages', cutAfterStart)).toEqual({
				inputTokens: 5,
				cacheReadTokens: 9,
				cacheWriteTokens: 0,
				outputTokens: 0,
				reportedness: statuses('reported', 'reported', 'unreported', 'unreported'),
			});
		});

		it('lets a later event replace a count without changing how the class was given', () => {
			const stream = sse(
				['message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }],
				['message_delta', { usage: { output_tokens: 40 } }]
			);
			expect(parseProviderUsage('anthropic-messages', stream)).toEqual({
				inputTokens: 5,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				outputTokens: 40,
				reportedness: statuses('reported', 'unreported', 'unreported', 'reported'),
			});
		});
	});

	describe('an answer that names no class', () => {
		it.each([
			['Anthropic: an empty usage', 'anthropic-messages', {}],
			[
				'Anthropic: counts that are not counts',
				'anthropic-messages',
				{ input_tokens: -1, output_tokens: 'many', cache_read_input_tokens: null },
			],
			[
				'OpenAI: a prompt total alone, which names no class',
				'openai-chat-completions',
				{ prompt_tokens: 20 },
			],
			['OpenAI: a grand total and nothing else', 'openai-responses', { total_tokens: 23 }],
		] as const)('is unknown, not a row of zeros: %s', (_name, kind, usage) => {
			for (const [, text] of answersNaming(kind, usage)) {
				expect(parseProviderUsage(kind, text)).toBeNull();
				expect(readInPieces(kind, text)).toBeNull();
			}
		});
	});
});
