/**
 * @file maestro-client.test.ts
 * @description Tests for the CLI Maestro WebSocket client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const wsMock = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;

	class MockWebSocket {
		static OPEN = 1;

		url: string;
		readyState = MockWebSocket.OPEN;
		sent: string[] = [];
		listeners = new Map<string, Listener[]>();

		constructor(url: string) {
			this.url = url;
			wsMock.instances.push(this);
		}

		on(event: string, listener: Listener): this {
			this.listeners.set(event, [...(this.listeners.get(event) || []), listener]);
			return this;
		}

		once(event: string, listener: Listener): this {
			const onceListener: Listener = (...args) => {
				this.off(event, onceListener);
				listener(...args);
			};
			return this.on(event, onceListener);
		}

		off(event: string, listener: Listener): this {
			this.listeners.set(
				event,
				(this.listeners.get(event) || []).filter((current) => current !== listener)
			);
			return this;
		}

		send(data: string, callback?: (error?: Error) => void): void {
			this.sent.push(data);
			callback?.();
		}

		close(): void {
			this.readyState = 3;
			this.emit('close');
		}

		emit(event: string, ...args: unknown[]): void {
			for (const listener of this.listeners.get(event) || []) {
				listener(...args);
			}
		}
	}

	return {
		MockWebSocket,
		instances: [] as MockWebSocket[],
	};
});

vi.mock('ws', () => ({
	default: wsMock.MockWebSocket,
}));

vi.mock('../../../shared/cli-server-discovery', () => ({
	readCliServerInfo: vi.fn(),
	isCliServerRunning: vi.fn(),
}));

import { MaestroClient, withMaestroClient } from '../../../cli/services/maestro-client';
import { readCliServerInfo, isCliServerRunning } from '../../../shared/cli-server-discovery';

describe('MaestroClient', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		wsMock.instances.length = 0;
		vi.mocked(readCliServerInfo).mockReturnValue({
			port: 47321,
			token: 'test-token',
			pid: 1234,
			startedAt: 1710000000000,
		});
		vi.mocked(isCliServerRunning).mockReturnValue(true);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('connect() throws when no discovery file exists', async () => {
		vi.mocked(readCliServerInfo).mockReturnValue(null);
		const client = new MaestroClient();

		await expect(client.connect()).rejects.toThrow('Maestro desktop app is not running');
		expect(wsMock.instances).toHaveLength(0);
	});

	it('connect() throws when the discovery PID is stale', async () => {
		vi.mocked(isCliServerRunning).mockReturnValue(false);
		const client = new MaestroClient();

		await expect(client.connect()).rejects.toThrow('Maestro desktop app is not running');
		expect(wsMock.instances).toHaveLength(0);
	});

	it('connects to the discovered WebSocket endpoint', async () => {
		const client = new MaestroClient();
		const connectPromise = client.connect();

		expect(wsMock.instances).toHaveLength(1);
		expect(wsMock.instances[0].url).toBe('ws://localhost:47321/test-token/ws');

		wsMock.instances[0].emit('open');
		await expect(connectPromise).resolves.toBeUndefined();
	});

	it('sendCommand() resolves on a matching response type', async () => {
		const client = new MaestroClient();
		const connectPromise = client.connect();
		const ws = wsMock.instances[0];
		ws.emit('open');
		await connectPromise;

		const responsePromise = client.sendCommand<{ type: string; ok: boolean }>(
			{ type: 'ping' },
			'pong'
		);
		const payload = JSON.parse(ws.sent[0]) as { requestId: string; type: string };

		expect(payload.type).toBe('ping');
		expect(payload.requestId).toBeTruthy();

		ws.emit(
			'message',
			Buffer.from(JSON.stringify({ type: 'pong', requestId: payload.requestId, ok: true }))
		);

		await expect(responsePromise).resolves.toMatchObject({ type: 'pong', ok: true });
	});

	it('sendCommand() rejects on timeout', async () => {
		vi.useFakeTimers();
		const client = new MaestroClient();
		const connectPromise = client.connect();
		wsMock.instances[0].emit('open');
		await connectPromise;

		const responsePromise = client.sendCommand({ type: 'ping' }, 'pong', 50);
		const assertion = expect(responsePromise).rejects.toThrow('Timed out waiting for pong');
		await vi.advanceTimersByTimeAsync(50);

		await assertion;
	});

	it('withMaestroClient() connects, runs the action, and disconnects', async () => {
		const resultPromise = withMaestroClient(async (client) => {
			const response = await client.sendCommand<{ type: string; success: boolean }>(
				{ type: 'ping' },
				'pong'
			);
			return response.success;
		});

		const ws = wsMock.instances[0];
		ws.emit('open');
		await vi.waitFor(() => {
			expect(ws.sent).toHaveLength(1);
		});
		const payload = JSON.parse(ws.sent[0]) as { requestId: string };
		ws.emit(
			'message',
			Buffer.from(JSON.stringify({ type: 'pong', requestId: payload.requestId, success: true }))
		);

		await expect(resultPromise).resolves.toBe(true);
		expect(ws.readyState).toBe(3);
	});
});
