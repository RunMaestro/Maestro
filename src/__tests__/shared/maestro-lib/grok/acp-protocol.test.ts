import { describe, expect, it, vi } from 'vitest';
import {
	AcpFrameDecoder,
	type AcpMessage,
	GROK_ACP_MAX_FRAME_BYTES,
	GrokAcpTransportError,
	parseAcpMessage,
} from '../../../../shared/maestro-lib/grok/acp-protocol';

describe('Grok ACP JSON-RPC framing', () => {
	it('preserves a UTF-8 frame split at every byte boundary', () => {
		const message = { jsonrpc: '2.0', method: 'session/update', params: { text: '雪🌱' } };
		const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
		for (let split = 1; split < bytes.length; split++) {
			const decoder = new AcpFrameDecoder(bytes.length);
			const accept = vi.fn<(message: AcpMessage) => boolean>(() => true);
			decoder.push(bytes.subarray(0, split), accept);
			expect(accept).not.toHaveBeenCalled();
			expect(decoder.bufferedBytes).toBe(split);
			decoder.push(bytes.subarray(split), accept);
			expect(accept).toHaveBeenCalledExactlyOnceWith(message);
			expect(decoder.bufferedBytes).toBe(0);
		}
	});

	it('dispatches concatenated frames in order and retains only the unfinished tail', () => {
		const first = { jsonrpc: '2.0', id: 1, result: null };
		const second = { jsonrpc: '2.0', method: 'session/update' };
		const tail = '{"jsonrpc":"2.0","id":"remote","result":';
		const decoder = new AcpFrameDecoder(128);
		const accept = vi.fn<(message: AcpMessage) => boolean>(() => true);
		decoder.push(
			Buffer.from(` \t\r\n${JSON.stringify(first)}\r\n${JSON.stringify(second)}\n${tail}`),
			accept
		);
		expect(accept.mock.calls.map(([message]) => message)).toEqual([first, second]);
		expect(decoder.bufferedBytes).toBe(Buffer.byteLength(tail));
		decoder.push(Buffer.from('true}\n'), accept);
		expect(accept).toHaveBeenLastCalledWith({ jsonrpc: '2.0', id: 'remote', result: true });
		expect(decoder.bufferedBytes).toBe(0);
	});

	it('stops dispatch and discards the rest of a chunk when the consumer closes', () => {
		const decoder = new AcpFrameDecoder(64);
		const accept = vi.fn<(message: AcpMessage) => boolean>(() => false);
		const frame = '{"jsonrpc":"2.0","id":1,"result":null}\n';
		decoder.push(Buffer.from(frame + 'untrusted stdout noise\n'), accept);
		expect(accept).toHaveBeenCalledOnce();
		expect(decoder.bufferedBytes).toBe(0);
		accept.mockReturnValue(true);
		decoder.push(Buffer.from(frame), accept);
		expect(accept).toHaveBeenCalledTimes(2);
	});

	it('accepts the exact byte ceiling including LF, independently for each frame', () => {
		const frame = Buffer.from('{"jsonrpc":"2.0","id":1,"result":"雪"}\n');
		const decoder = new AcpFrameDecoder(frame.length);
		const accept = vi.fn<(message: AcpMessage) => boolean>(() => true);
		decoder.push(Buffer.concat([frame, frame]), accept);
		expect(accept).toHaveBeenCalledTimes(2);
		expect(decoder.bufferedBytes).toBe(0);
	});

	it.each(['whole', 'split'] as const)(
		'rejects an oversized %s frame before dispatch and releases retained bytes',
		(mode) => {
			const frame = Buffer.from('{"jsonrpc":"2.0","id":1,"result":"雪"}\n');
			const decoder = new AcpFrameDecoder(frame.length - 1);
			const accept = vi.fn<(message: AcpMessage) => boolean>(() => true);
			if (mode === 'split') {
				decoder.push(frame.subarray(0, -1), accept);
				expect(decoder.bufferedBytes).toBe(frame.length - 1);
			}
			expect(() => decoder.push(mode === 'split' ? frame.subarray(-1) : frame, accept)).toThrow(
				new GrokAcpTransportError('frame-too-large')
			);
			expect(accept).not.toHaveBeenCalled();
			expect(decoder.bufferedBytes).toBe(0);
			decoder.push(Buffer.from('{"jsonrpc":"2.0","id":2,"result":0}\n'), accept);
			expect(accept).toHaveBeenCalledExactlyOnceWith({ jsonrpc: '2.0', id: 2, result: 0 });
		}
	);

	it('bounds an unterminated stream and resets an unfinished UTF-8 sequence', () => {
		const decoder = new AcpFrameDecoder(64);
		const accept = vi.fn<(message: AcpMessage) => boolean>(() => true);
		decoder.push(Buffer.alloc(64, 32), accept);
		expect(decoder.bufferedBytes).toBe(64);
		expect(() => decoder.push(Buffer.from('x'), accept)).toThrow(
			new GrokAcpTransportError('frame-too-large')
		);
		expect(decoder.bufferedBytes).toBe(0);
		decoder.push(Uint8Array.of(0xe9), accept);
		expect(decoder.bufferedBytes).toBe(1);
		decoder.reset();
		decoder.reset();
		expect(decoder.bufferedBytes).toBe(0);
		decoder.push(Buffer.from('{"jsonrpc":"2.0","id":2,"result":null}\n'), accept);
		expect(accept).toHaveBeenCalledExactlyOnceWith({ jsonrpc: '2.0', id: 2, result: null });
	});

	it.each([
		Buffer.from('stdout banner: synthetic-secret\n'),
		Buffer.from('{"token":"synthetic-secret"\n'),
		Buffer.from('{"jsonrpc":"2.0","id":null,"result":"synthetic-secret"}\n'),
		Uint8Array.of(0xff, 10),
		Uint8Array.of(0xe9, 10),
	])('rejects malformed input without retaining bytes or exposing payloads: %#', (bytes) => {
		const decoder = new AcpFrameDecoder(128);
		const accept = vi.fn<(message: AcpMessage) => boolean>(() => true);
		expect(() => decoder.push(bytes, accept)).toThrow(new GrokAcpTransportError('malformed-frame'));
		expect(accept).not.toHaveBeenCalled();
		expect(decoder.bufferedBytes).toBe(0);
	});

	it.each([0, -1, 1.5, Number.NaN, Infinity, GROK_ACP_MAX_FRAME_BYTES + 1])(
		'refuses an invalid byte ceiling: %s',
		(limit) => {
			expect(() => new AcpFrameDecoder(limit)).toThrow(
				new GrokAcpTransportError('invalid-frame-limit')
			);
		}
	);
});

describe('Grok ACP envelopes', () => {
	it.each([
		{ jsonrpc: '2.0', method: 'session/update' },
		{ jsonrpc: '2.0', id: 'remote', method: 'session/request_permission', params: [] },
		{ jsonrpc: '2.0', id: 0, result: null },
		{ jsonrpc: '2.0', id: 'remote', error: { code: -32601, message: 'unsupported' } },
	])('preserves valid call, notification and response data: %#', (message) => {
		expect(parseAcpMessage(JSON.stringify(message))).toEqual(message);
	});

	it.each([
		null,
		[],
		[{ jsonrpc: '2.0', id: 1, result: null }],
		{ jsonrpc: '1.0', id: 1, result: null },
		{ jsonrpc: '2.0', id: Number.MAX_SAFE_INTEGER + 1, result: null },
		{ jsonrpc: '2.0', id: 1 },
		{ jsonrpc: '2.0', id: 1, result: null, error: { code: 1, message: 'error' } },
		{ jsonrpc: '2.0', id: 1, result: null, params: {} },
		{ jsonrpc: '2.0', method: 'session/new', result: null },
		{ jsonrpc: '2.0', method: 'session/new', params: 'synthetic-secret' },
		{ jsonrpc: '2.0', id: 1, error: { code: 1.5, message: 'synthetic-secret' } },
		{ jsonrpc: '2.0', id: 1, error: { code: -1, message: {} } },
	])('rejects invalid envelopes with a fixed diagnostic: %#', (message) => {
		expect(() => parseAcpMessage(JSON.stringify(message))).toThrow(
			new GrokAcpTransportError('malformed-frame')
		);
	});
});

describe('Grok ACP lossless cost tokens', () => {
	it('preserves raw notification and nested prompt totals at every byte split and byte ceiling', () => {
		const notification = Buffer.from(
			'{"jsonrpc":"2.0","method":"_x.ai/session/update","params":{"sessionId":"native","update":{"sessionUpdate":"turn_usage","usage":{"costUsdTicks":9007199254740993}},"text":"雪"}}\n'
		);
		const response = Buffer.from(
			'{"jsonrpc":"2.0","id":"prompt","result":{"_meta":{"usage":{"costUsdTicks":9223372036854775807,"modelUsage":{"grok-fixture":{"costUsdTicks":9007199254740993}}}}}}\n'
		);
		const frames = Buffer.concat([notification, response]);
		const limit = Math.max(notification.length, response.length);
		for (let split = 1; split < frames.length; split++) {
			const decoder = new AcpFrameDecoder(limit);
			const accept = vi.fn<(message: AcpMessage) => boolean>(() => true);
			decoder.push(frames.subarray(0, split), accept);
			decoder.push(frames.subarray(split), accept);
			expect(accept.mock.calls.map(([message]) => message)).toEqual([
				{
					jsonrpc: '2.0',
					method: '_x.ai/session/update',
					params: {
						sessionId: 'native',
						update: { sessionUpdate: 'turn_usage', usage: { costUsdTicks: '9007199254740993' } },
						text: '雪',
					},
				},
				{
					jsonrpc: '2.0',
					id: 'prompt',
					result: {
						_meta: {
							usage: {
								costUsdTicks: '9223372036854775807',
								modelUsage: { 'grok-fixture': { costUsdTicks: '9007199254740993' } },
							},
						},
					},
				},
			]);
			expect(decoder.bufferedBytes).toBe(0);
		}
		const accept = vi.fn<(message: AcpMessage) => boolean>(() => true);
		expect(() => new AcpFrameDecoder(response.length - 1).push(response, accept)).toThrow(
			new GrokAcpTransportError('frame-too-large')
		);
		expect(accept).not.toHaveBeenCalled();
	});

	it.each(['0', '"0"', '-1', '-0', '1.0', '1e3', '0.99999999999999999', '1e-9999', 'null'])(
		'preserves cost lexeme %s without coercing malformed costs to exact integers',
		(token) => {
			const accept = vi.fn<(message: AcpMessage) => boolean>(() => true);
			new AcpFrameDecoder().push(
				Buffer.from(`{"jsonrpc":"2.0","id":0,"result":{"costUsdTicks":${token}}}\n`),
				accept
			);
			expect(accept).toHaveBeenCalledExactlyOnceWith({
				jsonrpc: '2.0',
				id: 0,
				result: { costUsdTicks: token === 'null' ? null : token === '"0"' ? '0' : token },
			});
		}
	);

	it.each(['01', '+1', '1.', '1e+', 'NaN', 'Infinity'])(
		'rejects invalid JSON cost syntax %s without exposing payloads',
		(token) => {
			const decoder = new AcpFrameDecoder();
			const accept = vi.fn<(message: AcpMessage) => boolean>(() => true);
			expect(() =>
				decoder.push(
					Buffer.from(
						`{"jsonrpc":"2.0","id":1,"result":{"secret":"synthetic-secret","costUsdTicks":${token}}}\n`
					),
					accept
				)
			).toThrow(new GrokAcpTransportError('malformed-frame'));
			expect(accept).not.toHaveBeenCalled();
			expect(decoder.bufferedBytes).toBe(0);
		}
	);

	it('keeps quoted lookalikes, escaped keys, duplicate keys, nested arrays and absent costs distinct', () => {
		const lookalike = '雪 {"costUsdTicks":9007199254740993} \\ "quoted"';
		const accept = vi.fn<(message: AcpMessage) => boolean>(() => true);
		new AcpFrameDecoder().push(
			Buffer.from(
				`{"jsonrpc":"2.0","id":7,"result":{"text":${JSON.stringify(lookalike)},"inputTokens":12,"rows":[{}, {"costUsdTicks":1,"costUsdTicks":9007199254740993},{"costUsd\\u0054icks":9223372036854775807}]}}\n`
			),
			accept
		);
		expect(accept).toHaveBeenCalledExactlyOnceWith({
			jsonrpc: '2.0',
			id: 7,
			result: {
				text: lookalike,
				inputTokens: 12,
				rows: [{}, { costUsdTicks: '9007199254740993' }, { costUsdTicks: '9223372036854775807' }],
			},
		});
		expect(() =>
			parseAcpMessage(
				'{"jsonrpc":"2.0","id":9007199254740993,"result":{"costUsdTicks":9007199254740993}}'
			)
		).toThrow(new GrokAcpTransportError('malformed-frame'));
	});
});
