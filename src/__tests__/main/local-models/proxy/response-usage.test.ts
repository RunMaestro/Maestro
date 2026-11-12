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

function sse(...events: Array<[string, unknown]>): string {
	return events
		.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
		.join('');
}

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
		});
	});

	it('reads a whole Anthropic JSON answer', () => {
		const body = JSON.stringify({
			id: 'msg_1',
			usage: { input_tokens: 5, cache_read_input_tokens: 9, output_tokens: 3 },
		});
		expect(parseProviderUsage('anthropic-messages', body)).toEqual({
			inputTokens: 5,
			cacheReadTokens: 9,
			cacheWriteTokens: 0,
			outputTokens: 3,
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
