// @vitest-environment jsdom

import { createServer, createConnection, type Socket } from 'node:net';
import { Transform, type TransformCallback } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import {
	BroadcastService,
	type WebClientInfo,
} from '../../../../main/web-server/services/broadcastService';
import {
	acknowledgeWebSocketChunk,
	enableWebSocketChunks,
	sendBounded,
} from '../../../../main/web-server/services/socket-send';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** A constrained link, with ordinary TCP backpressure on the producer. */
class ConstrainedLink extends Transform {
	limited = false;
	_transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
		if (!this.limited) {
			this.push(chunk);
			callback();
			return;
		}
		// net.Socket reads at most 64 KiB at a time. This limits the link to
		// roughly 640 KiB/s, while leaving the event loop free to run timers.
		void delay(100).then(() => {
			if (!this.destroyed) this.push(chunk);
			callback();
		});
	}
}

it('keeps a progressing large transcript transfer alive and acknowledges saves', async () => {
	const sockets = new Set<Socket>();
	const links: ConstrainedLink[] = [];
	const browserSockets: NodeWebSocket[] = [];
	const closeCodes: number[] = [];
	const invocations: string[] = [];
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const intervals = new Set<ReturnType<typeof setInterval>>();
	const realSetTimeout = globalThis.setTimeout;
	const realSetInterval = globalThis.setInterval;
	vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
		...args: Parameters<typeof setTimeout>
	) => {
		const timer = realSetTimeout(...args);
		timers.add(timer);
		return timer;
	}) as typeof setTimeout);
	vi.spyOn(globalThis, 'setInterval').mockImplementation(((
		...args: Parameters<typeof setInterval>
	) => {
		const timer = realSetInterval(...args);
		intervals.add(timer);
		return timer;
	}) as typeof setInterval);
	class BrowserSocket extends NodeWebSocket {
		constructor(url: string) {
			super(url);
			browserSockets.push(this);
		}
		close(code?: number, data?: string | Buffer): void {
			if (code !== undefined) closeCodes.push(code);
			super.close(code, data);
		}
	}
	const clients = new Map<string, WebClientInfo>();
	const broadcasts = new BroadcastService();
	broadcasts.setGetWebClientsCallback(() => clients);
	const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await once(server, 'listening');
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Missing test server port');
	server.on('connection', (socket, request) => {
		if (new URL(request.url ?? '/', 'http://localhost').searchParams.get('bridgeChunks') === '1')
			enableWebSocketChunks(socket);
		clients.set('browser', { id: 'browser', socket, connectedAt: Date.now() });
		sendBounded(
			socket,
			JSON.stringify({ type: 'connected', bridgeEpoch: broadcasts.bridgeEpoch, bridgeSeq: 0 })
		);
		socket.on('message', (data) => {
			const message = JSON.parse(String(data));
			if (message.type === 'bridge.chunkAck') acknowledgeWebSocketChunk(socket, message.offset);
			if (message.type === 'ping')
				sendBounded(socket, JSON.stringify({ type: 'pong' }), undefined, true);
			if (message.type === 'bridge.invoke') {
				invocations.push(message.channel);
				sendBounded(
					socket,
					JSON.stringify({
						type: 'bridge.response',
						requestId: message.requestId,
						ok: true,
						result: message.channel === 'process:getActiveProcesses' ? [] : undefined,
					}),
					undefined,
					true
				);
			}
		});
	});
	const proxy = createServer((downstream) => {
		const upstream = createConnection({ host: '127.0.0.1', port: address.port });
		sockets.add(downstream);
		sockets.add(upstream);
		const link = new ConstrainedLink();
		links.push(link);
		downstream.pipe(upstream);
		upstream.pipe(link).pipe(downstream);
		downstream.on('error', () => {});
		upstream.on('error', () => {});
	});
	proxy.listen(0, '127.0.0.1');
	await once(proxy, 'listening');
	const proxyAddress = proxy.address();
	if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Missing proxy port');
	window.__MAESTRO_CONFIG__ = { wsUrl: `ws://127.0.0.1:${proxyAddress.port}` } as never;
	vi.stubGlobal('WebSocket', BrowserSocket);
	const originalMaestro = window.maestro;
	try {
		const { ipcRenderer, BRIDGE_PONG_TIMEOUT_MS } =
			await import('../../../../web-desktop/electron-shim');
		window.maestro = {
			process: {
				getActiveProcesses: (options: unknown) =>
					ipcRenderer.invoke('process:getActiveProcesses', options),
			},
		} as never;
		const { probeSessionAiProcesses } = await import('../../../../renderer/services/process');
		while ((window as any).__MAESTRO_BRIDGE_STATE__ !== 'connected') await delay(5);
		// Let the initial connected frame finish before imposing the bandwidth cap.
		await delay(20);
		const browser = browserSockets[0] as NodeWebSocket & { _socket: Socket };
		let rawBytes = 0;
		let completeMessages = 0;
		let transferStarted = 0;
		const responseDelayMs: Record<string, number> = {};
		browser._socket.on('data', (data: Buffer) => {
			rawBytes += data.length;
		});
		browser.on('message', (data) => {
			completeMessages++;
			const packet = JSON.parse(String(data));
			if (packet.type === 'bridge.response')
				responseDelayMs[String(packet.requestId)] = Date.now() - transferStarted;
		});
		links[0].limited = true;
		const transcript = 'x'.repeat(10 * 1024 * 1024 - 1) + '😀漢字 café';
		const received: string[] = [];
		let resolveTranscript!: () => void;
		const receivedTranscript = new Promise<void>((resolve) => {
			resolveTranscript = resolve;
		});
		ipcRenderer.on('sessions:transcriptSync', (_event, patch) => {
			received.push((patch as { text: string }).text);
			resolveTranscript();
		});
		transferStarted = Date.now();
		broadcasts.broadcastToAll({
			type: 'bridge.event',
			channel: 'sessions:transcriptSync',
			args: [{ sessionId: 'large-chat', text: transcript }],
		});
		const saves = ['sessions:setMany', 'settings:set'].map((channel) =>
			ipcRenderer.invoke(channel, []).then(
				() => 'acknowledged',
				(error: Error) => error.message
			)
		);
		const processProbe = probeSessionAiProcesses('large-chat', 'tab-1');
		window.dispatchEvent(new Event('pageshow'));
		await delay(BRIDGE_PONG_TIMEOUT_MS / 2);
		const halfwayBytes = rawBytes;
		await delay(BRIDGE_PONG_TIMEOUT_MS / 2 + 150);
		const outcomes = await Promise.race([Promise.all(saves), delay(5).then(() => ['pending'])]);
		const processState = await processProbe;
		console.info('Bridge constrained-link evidence', {
			rawBytes,
			completeMessages,
			closeCodes,
			invocations,
			outcomes,
			processState,
			responseDelayMs,
		});
		expect(halfwayBytes).toBeGreaterThan(0);
		expect(rawBytes).toBeGreaterThan(halfwayBytes);
		expect(invocations).toEqual(['sessions:setMany', 'settings:set', 'process:getActiveProcesses']);
		// Raw transport bytes keep arriving throughout the deadline, but native
		// WS continuation fragments do not emit a browser message before FIN.
		expect(closeCodes).toEqual([]);
		expect(processState).toEqual({ anyActive: false, targetTabActive: false, probeFailed: false });
		// Remove the cap after crossing the real heartbeat deadline, so the
		// regression also proves complete, exactly-once delivery without making
		// the suite wait for the full constrained download.
		links[0].limited = false;
		expect(await Promise.race([Promise.all(saves), delay(5000).then(() => ['pending'])])).toEqual([
			'acknowledged',
			'acknowledged',
		]);
		expect(
			await Promise.race([receivedTranscript.then(() => true), delay(5000).then(() => false)])
		).toBe(true);
		expect(received).toHaveLength(1);
		expect(received[0].length).toBe(transcript.length);
		expect(received[0] === transcript).toBe(true);
	} finally {
		// Wait for close listeners before clearing their newly scheduled retries.
		await Promise.all(
			browserSockets.map((socket) => {
				if (socket.readyState === NodeWebSocket.CLOSED) return Promise.resolve();
				const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
				socket.terminate();
				return closed;
			})
		);
		for (const socket of server.clients) socket.terminate();
		for (const link of links) link.destroy();
		for (const socket of sockets) socket.destroy();
		await Promise.all([
			new Promise<void>((resolve) => server.close(() => resolve())),
			new Promise<void>((resolve) => proxy.close(() => resolve())),
		]);
		for (const timer of timers) clearTimeout(timer);
		for (const interval of intervals) clearInterval(interval);
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		delete window.__MAESTRO_CONFIG__;
		window.maestro = originalMaestro;
	}
}, 20_000);
