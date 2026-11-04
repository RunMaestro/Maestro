import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import {
	acknowledgeWebSocketChunk,
	enableWebSocketChunks,
	sendBounded,
} from '../../main/web-server/services/socket-send';

vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.resetModules();
	delete window.__MAESTRO_CONFIG__;
});

it('completes a 5 MiB read at 100 ms RTT within the unchanged read deadline', async () => {
	vi.useFakeTimers();
	const payload = 'x'.repeat(5 * 1024 * 1024);
	const peers: EventEmitter[] = [];
	let sent = 0;
	let acknowledged = 0;
	let largestOutstanding = 0;
	class BrowserSocket extends EventTarget {
		static readonly OPEN = 1;
		static readonly CONNECTING = 0;
		readyState = 0;
		readonly host;
		constructor(_url: string) {
			super();
			const browser = this;
			this.host = Object.assign(new EventEmitter(), {
				readyState: 1,
				bufferedAmount: 0,
				send(data: string, _options?: unknown, complete?: () => void) {
					const packet = JSON.parse(data);
					if (packet.type === 'bridge.chunk') {
						sent = packet.offset + packet.data.length;
						largestOutstanding = Math.max(largestOutstanding, sent - acknowledged);
					}
					setTimeout(() => browser.dispatchEvent(new MessageEvent('message', { data })), 50);
					setTimeout(() => complete?.(), 0);
				},
				close: vi.fn(),
				terminate: vi.fn(),
			});
			peers.push(this.host);
			enableWebSocketChunks(this.host as never);
			setTimeout(() => {
				this.readyState = 1;
				this.dispatchEvent(new Event('open'));
			}, 0);
		}
		send(data: string) {
			setTimeout(() => {
				const packet = JSON.parse(data);
				if (packet.type === 'bridge.chunkAck') {
					acknowledged = packet.offset;
					acknowledgeWebSocketChunk(this.host as never, packet.offset);
				} else if (packet.type === 'bridge.invoke') {
					sendBounded(
						this.host as never,
						JSON.stringify({
							type: 'bridge.response',
							requestId: packet.requestId,
							ok: true,
							result: payload,
						})
					);
				} else if (packet.type === 'ping') {
					sendBounded(this.host as never, JSON.stringify({ type: 'pong' }), undefined, true);
				}
			}, 50);
		}
		close() {
			this.readyState = 3;
			this.dispatchEvent(new Event('close'));
		}
	}
	vi.stubGlobal('WebSocket', BrowserSocket);
	window.__MAESTRO_CONFIG__ = { wsUrl: 'ws://localhost/test-window' } as never;
	const { ipcRenderer } = await import('../../web-desktop/electron-shim');
	await vi.advanceTimersByTimeAsync(0);
	let outcome: unknown;
	let settledAt: number | undefined;
	const startedAt = Date.now();
	void ipcRenderer.invoke('sessions:getDeferredContent', 'agent', 'tab', false).then(
		(value) => {
			outcome = value;
			settledAt = Date.now();
		},
		(error) => {
			outcome = error;
		}
	);
	await vi.advanceTimersByTimeAsync(30_001);
	expect(outcome === payload).toBe(true);
	expect((settledAt ?? Infinity) - startedAt).toBeLessThan(30_000);
	expect(largestOutstanding).toBeGreaterThan(16_384);
	expect(largestOutstanding).toBeLessThanOrEqual(256 * 1024);
	for (const peer of peers) peer.emit('close');
});
