// @vitest-environment node
import { EventEmitter, once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
	acknowledgeWebSocketChunk,
	enableWebSocketChunks,
	sendBounded,
	WEB_CLIENT_CHUNK_WINDOW_BYTES,
	WEB_CLIENT_MAX_BUFFERED_BYTES,
} from '../../../../main/web-server/services/socket-send';

describe('bounded WebSocket output', () => {
	it.each(['resume', 'close', 'backlog', 'timeout'] as const)(
		'keeps one scheduled chunk continuation across ACKs and %s',
		async (action) => {
			vi.useFakeTimers();
			const continuations: Array<() => void> = [];
			const immediate = vi.spyOn(globalThis, 'setImmediate').mockImplementation(((
				callback: () => void
			) => {
				continuations.push(callback);
				return {} as NodeJS.Immediate;
			}) as typeof setImmediate);
			const frames: Array<{ data: string; offset: number; final: boolean }> = [];
			const socket = Object.assign(new EventEmitter(), {
				readyState: WebSocket.OPEN,
				bufferedAmount: 0,
				send: vi.fn((data: string, _options: unknown, callback: () => void) => {
					const frame = JSON.parse(data);
					frames.push(frame);
					if (frames.length < 16)
						acknowledgeWebSocketChunk(socket, frame.offset + frame.data.length);
					callback();
				}),
				close: vi.fn(),
				terminate: vi.fn(),
			}) as unknown as WebSocket;
			try {
				enableWebSocketChunks(socket);
				const payload = 'a😀漢'.repeat(300_000);
				expect(sendBounded(socket, payload)).toBe(true);
				expect(frames).toHaveLength(16);
				expect(continuations).toHaveLength(1);
				const last = frames.at(-1)!;
				if (action !== 'timeout') {
					acknowledgeWebSocketChunk(socket, last.offset + last.data.length);
					acknowledgeWebSocketChunk(socket, last.offset + last.data.length);
				}
				expect(continuations).toHaveLength(1);
				if (action === 'close') socket.emit('close');
				if (action === 'backlog')
					expect(sendBounded(socket, 'x'.repeat(WEB_CLIENT_MAX_BUFFERED_BYTES + 1))).toBe(false);
				if (action === 'timeout') vi.advanceTimersByTime(30_000);
				continuations[0]();
				if (action === 'resume') {
					expect(frames.length).toBeGreaterThan(16);
					let offset = 0;
					for (const frame of frames) {
						expect(frame.offset).toBe(offset);
						expect(frame.data).toBe(payload.slice(offset, offset + frame.data.length));
						offset += frame.data.length;
					}
				} else {
					expect(frames).toHaveLength(16);
					if (action !== 'close') expect(socket.close).toHaveBeenCalledOnce();
				}
			} finally {
				socket.emit('close');
				immediate.mockRestore();
				vi.clearAllTimers();
				vi.useRealTimers();
			}
		}
	);
	it('does not revive a chunk transfer when ACK and close race a yielded continuation', async () => {
		const frames: Array<{ data: string; offset: number; final: boolean }> = [];
		const socket = Object.assign(new EventEmitter(), {
			readyState: WebSocket.OPEN,
			bufferedAmount: 0,
			send: vi.fn((data: string, _options: unknown, callback: () => void) => {
				const frame = JSON.parse(data);
				frames.push(frame);
				process.nextTick(() => {
					acknowledgeWebSocketChunk(socket, frame.offset + frame.data.length);
					callback();
				});
			}),
			close: vi.fn(),
			terminate: vi.fn(),
		}) as unknown as WebSocket;
		enableWebSocketChunks(socket);
		const payload = 'a😀漢'.repeat(600_000);
		const sentinel = new Promise<void>((resolve) => setImmediate(resolve));
		expect(sendBounded(socket, payload)).toBe(true);
		await sentinel;
		expect(frames.length).toBeGreaterThan(0);
		expect(frames.at(-1)?.final).toBe(false);
		const sentBeforeClose = frames.length;
		const last = frames.at(-1)!;
		acknowledgeWebSocketChunk(socket, last.offset + last.data.length);
		Object.assign(socket, { readyState: WebSocket.CLOSED });
		socket.emit('close');
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(frames).toHaveLength(sentBeforeClose);
		let offset = 0;
		for (const frame of frames) {
			expect(frame.offset).toBe(offset);
			expect(frame.data).toBe(payload.slice(offset, offset + frame.data.length));
			offset += frame.data.length;
		}
	});

	it('rejects an oversized queued message and prevents pending completion from sending more', async () => {
		let completion!: (error?: Error) => void;
		const socket = Object.assign(new EventEmitter(), {
			readyState: WebSocket.OPEN,
			bufferedAmount: 0,
			send: vi.fn((_data: string, _options: unknown, callback: (error?: Error) => void) => {
				completion = callback;
			}),
			close: vi.fn(),
			terminate: vi.fn(),
		}) as unknown as WebSocket;
		expect(sendBounded(socket, 'x'.repeat(WEB_CLIENT_MAX_BUFFERED_BYTES + 1))).toBe(true);
		expect(sendBounded(socket, 'y'.repeat(WEB_CLIENT_MAX_BUFFERED_BYTES + 1))).toBe(false);
		expect(socket.close).toHaveBeenCalledOnce();
		completion();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(socket.send).toHaveBeenCalledOnce();
		socket.emit('close');
	});

	it('cleans up a failed write and ignores later acknowledgements', async () => {
		let completion!: (error?: Error) => void;
		const socket = Object.assign(new EventEmitter(), {
			readyState: WebSocket.OPEN,
			bufferedAmount: 0,
			send: vi.fn((_data: string, _options: unknown, callback: (error?: Error) => void) => {
				completion = callback;
			}),
			close: vi.fn(),
			terminate: vi.fn(),
		}) as unknown as WebSocket;
		enableWebSocketChunks(socket);
		expect(sendBounded(socket, 'x'.repeat(100_000))).toBe(true);
		const first = JSON.parse(vi.mocked(socket.send).mock.calls[0][0] as string);
		completion(new Error('write failed'));
		acknowledgeWebSocketChunk(socket, first.offset + first.data.length);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(socket.close).toHaveBeenCalledOnce();
		expect(socket.send).toHaveBeenCalledOnce();
		socket.emit('close');
	});
	it('yields native Unicode fragments to the event loop while preserving FIN and queued order', async () => {
		const frames: Array<{ data: string; fin: boolean }> = [];
		let sentinelFrames = -1;
		let finish!: () => void;
		const complete = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const socket = Object.assign(new EventEmitter(), {
			readyState: WebSocket.OPEN,
			bufferedAmount: 0,
			send: vi.fn((data: string, options?: { fin: boolean }, callback?: () => void) => {
				frames.push({ data, fin: options?.fin ?? true });
				if (data === 'following') finish();
				if (callback) process.nextTick(callback);
			}),
			close: vi.fn(),
			terminate: vi.fn(),
		}) as unknown as WebSocket;
		const payload = ('a'.repeat(262_143) + '😀漢').repeat(40);
		const sentinel = new Promise<void>((resolve) =>
			setImmediate(() => {
				sentinelFrames = frames.length;
				resolve();
			})
		);
		expect(sendBounded(socket, payload)).toBe(true);
		expect(sendBounded(socket, 'following')).toBe(true);
		await Promise.all([sentinel, complete]);
		expect(sentinelFrames).toBeGreaterThan(0);
		expect(sentinelFrames).toBeLessThan(frames.length - 1);
		const fragments = frames.slice(0, -1);
		expect(fragments.map((frame) => frame.data).join('')).toBe(payload);
		expect(fragments.slice(0, -1).every((frame) => !frame.fin)).toBe(true);
		expect(fragments.at(-1)?.fin).toBe(true);
		for (const frame of fragments) {
			expect(frame.data).not.toMatch(/[\ud800-\udbff]$/u);
			expect(frame.data).not.toMatch(/^[\udc00-\udfff]/u);
		}
		expect(frames.at(-1)?.data).toBe('following');
		socket.emit('close');
	});

	it('does not duplicate chunks when ACK and write completion overlap, and stops after close', async () => {
		const frames: string[] = [];
		const completions: Array<(error?: Error) => void> = [];
		const socket = Object.assign(new EventEmitter(), {
			readyState: WebSocket.OPEN,
			bufferedAmount: 0,
			send: vi.fn((data: string, _options: unknown, callback: (error?: Error) => void) => {
				frames.push(data);
				completions.push(callback);
			}),
			close: vi.fn(),
			terminate: vi.fn(),
		}) as unknown as WebSocket;
		enableWebSocketChunks(socket);
		const payload = '😀ab'.repeat(100_000);
		expect(sendBounded(socket, payload)).toBe(true);
		const first = JSON.parse(frames[0]);
		acknowledgeWebSocketChunk(socket, first.offset + first.data.length);
		expect(frames).toHaveLength(1);
		completions.shift()!();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(frames).toHaveLength(2);
		const second = JSON.parse(frames[1]);
		expect(second.offset).toBe(first.offset + first.data.length);
		socket.emit('close');
		Object.assign(socket, { readyState: WebSocket.CLOSED });
		completions.shift()!();
		acknowledgeWebSocketChunk(socket, second.offset + second.data.length);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(frames).toHaveLength(2);
	});

	it('bounds the window and ignores invalid ACKs without renewing the oldest chunk deadline', () => {
		vi.useFakeTimers();
		const socket = Object.assign(new EventEmitter(), {
			readyState: WebSocket.OPEN,
			bufferedAmount: 0,
			send: vi.fn((_data: string, _options: unknown, callback?: () => void) => callback?.()),
			close: vi.fn(),
			terminate: vi.fn(),
		}) as unknown as WebSocket;
		try {
			enableWebSocketChunks(socket);
			expect(sendBounded(socket, 'x'.repeat(1024 * 1024))).toBe(true);
			const initial = vi.mocked(socket.send).mock.calls;
			const count = initial.length;
			expect(count).toBeGreaterThan(1);
			expect(
				initial.reduce((bytes, call) => bytes + Buffer.byteLength(call[0] as string), 0)
			).toBeLessThanOrEqual(WEB_CLIENT_CHUNK_WINDOW_BYTES);
			const first = JSON.parse(vi.mocked(socket.send).mock.calls[0][0] as string);
			const firstEnd = first.offset + first.data.length;
			for (const offset of [undefined, -1, firstEnd - 1, String(firstEnd), 1024 * 1024]) {
				acknowledgeWebSocketChunk(socket, offset);
			}
			expect(socket.send).toHaveBeenCalledTimes(count);
			vi.advanceTimersByTime(5000);
			acknowledgeWebSocketChunk(socket, firstEnd);
			expect(socket.send).toHaveBeenCalledTimes(count + 1);
			// A duplicate acknowledgement must not credit the next chunk.
			acknowledgeWebSocketChunk(socket, firstEnd);
			expect(socket.send).toHaveBeenCalledTimes(count + 1);
			vi.advanceTimersByTime(24_999);
			expect(socket.close).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(socket.close).toHaveBeenCalledExactlyOnceWith(
				1013,
				'Client output backlog exceeded; reconnect to resynchronize'
			);
			socket.emit('close');
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it('accepts cumulative ACKs, preserves escaped chunks, and ages newly sent data independently', () => {
		vi.useFakeTimers();
		const socket = Object.assign(new EventEmitter(), {
			readyState: WebSocket.OPEN,
			bufferedAmount: 0,
			send: vi.fn((_data: string, _options: unknown, callback?: () => void) => callback?.()),
			close: vi.fn(),
			terminate: vi.fn(),
		}) as unknown as WebSocket;
		try {
			enableWebSocketChunks(socket);
			const payload = '\u0000'.repeat(100_000) + '😀';
			expect(sendBounded(socket, payload)).toBe(true);
			const initial = vi
				.mocked(socket.send)
				.mock.calls.map((call) => JSON.parse(call[0] as string));
			expect(initial).toHaveLength(2);
			const end = initial.at(-1).offset + initial.at(-1).data.length;
			vi.advanceTimersByTime(5000);
			acknowledgeWebSocketChunk(socket, end);
			expect(socket.send).toHaveBeenCalledTimes(4);
			// All old data was confirmed. The next window really was sent at 5s.
			vi.advanceTimersByTime(25_000);
			expect(socket.close).not.toHaveBeenCalled();
			while (true) {
				const last = JSON.parse(vi.mocked(socket.send).mock.calls.at(-1)![0] as string);
				acknowledgeWebSocketChunk(socket, last.offset + last.data.length);
				if (last.final) break;
			}
			const chunks = vi.mocked(socket.send).mock.calls.map((call) => JSON.parse(call[0] as string));
			expect(chunks.map((chunk) => chunk.data).join('')).toBe(payload);
			vi.advanceTimersByTime(30_000);
			expect(socket.close).not.toHaveBeenCalled();
			socket.emit('close');
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it('delivers complete negotiated chunks while replies pass and events retain their order', async () => {
		const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await once(server, 'listening');
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('No loopback listener');
		const connection = once(server, 'connection');
		const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
		const received: string[] = [];
		client.on('message', (data) => {
			received.push(data.toString());
			if (data.toString() === 'following event') return;
			const packet = JSON.parse(data.toString());
			if (packet.type === 'bridge.chunk') {
				client.send(
					JSON.stringify({ type: 'bridge.chunkAck', offset: packet.offset + packet.data.length })
				);
			}
		});
		await once(client, 'open');
		const [peer] = await connection;
		try {
			enableWebSocketChunks(peer);
			peer.on('message', (data) => {
				const packet = JSON.parse(data.toString());
				if (packet.type === 'bridge.chunkAck') acknowledgeWebSocketChunk(peer, packet.offset);
			});
			// The pair straddles the chunk boundary unless the sender preserves it.
			const payload = 'a'.repeat(16_384 - 1) + '😀' + '\\"\n'.repeat(10_000);
			const reply = JSON.stringify({ type: 'bridge.response', requestId: 4, ok: true });
			expect(sendBounded(peer, payload)).toBe(true);
			expect(sendBounded(peer, 'following event')).toBe(true);
			expect(sendBounded(peer, reply, Buffer.byteLength(reply), true)).toBe(true);
			await vi.waitFor(() => expect(received.at(-1)).toBe('following event'));

			const packets = received.slice(0, -1).map((data) => JSON.parse(data));
			const chunks = packets.filter((packet) => packet.type === 'bridge.chunk');
			expect(chunks.length).toBeGreaterThan(1);
			expect(packets[0].type).toBe('bridge.chunk');
			expect(packets[1]).toEqual(JSON.parse(reply));
			expect(packets.at(-1)).toEqual(
				expect.objectContaining({ type: 'bridge.chunk', final: true })
			);
			expect(chunks.map((packet) => packet.data).join('')).toBe(payload);
			let offset = 0;
			for (const [index, chunk] of chunks.entries()) {
				expect(chunk).toEqual({
					type: 'bridge.chunk',
					data: expect.any(String),
					offset,
					total: payload.length,
					final: index === chunks.length - 1,
				});
				// Neither complete wire message may contain a replacement character.
				expect(chunk.data).not.toContain('\ufffd');
				expect(chunk.data).not.toMatch(/[\ud800-\udbff]$/u);
				expect(chunk.data).not.toMatch(/^[\udc00-\udfff]/u);
				offset += chunk.data.length;
			}
			expect(client.readyState).toBe(WebSocket.OPEN);
		} finally {
			client.terminate();
			peer.terminate();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it('keeps packets above the chunk threshold unchanged without negotiation', async () => {
		const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await once(server, 'listening');
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('No loopback listener');
		const connection = once(server, 'connection');
		const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
		const received: string[] = [];
		client.on('message', (data) => received.push(data.toString()));
		await once(client, 'open');
		const [peer] = await connection;
		try {
			const payload = JSON.stringify({ type: 'bridge.event', text: '😀'.repeat(10_000) });
			expect(sendBounded(peer, payload)).toBe(true);
			await vi.waitFor(() => expect(received).toEqual([payload]));
		} finally {
			client.terminate();
			peer.terminate();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it('delivers a large Unicode reply and the following event in order on a healthy socket', async () => {
		const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		await once(server, 'listening');
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('No loopback listener');
		const connection = once(server, 'connection');
		const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
		const received: string[] = [];
		client.on('message', (data) => received.push(data.toString()));
		await once(client, 'open');
		const [peer] = await connection;
		try {
			const payload = 'a'.repeat(256 * 1024 - 1) + '😀' + 'z'.repeat(WEB_CLIENT_MAX_BUFFERED_BYTES);
			expect(sendBounded(peer, payload)).toBe(true);
			expect(sendBounded(peer, 'following event')).toBe(true);
			await vi.waitFor(() => expect(received[1]).toBe('following event'), { timeout: 5000 });
			expect(received).toEqual([payload, 'following event']);
			expect(client.readyState).toBe(WebSocket.OPEN);
		} finally {
			client.terminate();
			peer.terminate();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
