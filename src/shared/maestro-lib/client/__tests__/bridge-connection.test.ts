/**
 * @file bridge-connection.test.ts
 * @description Tests for the desktop bridge connection (moved from the CLI's
 * maestro-client service, which re-exports it as `MaestroClient`)
 *
 * Tests the BridgeConnection class including:
 * - Connection lifecycle (connect, disconnect)
 * - The upgrade request: 127.0.0.1, the URL token, and the per-boot CLI secret
 * - Command sending with response matching
 * - Timeout handling and the typed errors callers map to exit codes
 * - withBridgeConnection helper lifecycle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Track WebSocket instances created
let mockWsInstance: EventEmitter & {
	close: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
	readyState: number;
};
// What the most recent WebSocket was constructed with
let mockWsUrl: string | undefined;
let mockWsOptions: { headers?: Record<string, string> } | undefined;

vi.mock('ws', async () => {
	const { EventEmitter: EE } = await import('events');
	const WS_OPEN = 1;
	class MockWebSocket extends EE {
		close = vi.fn();
		send = vi.fn();
		readyState = WS_OPEN;
		static OPEN = WS_OPEN;
		constructor(url: string, options?: { headers?: Record<string, string> }) {
			super();
			mockWsInstance = this as unknown as typeof mockWsInstance;
			mockWsUrl = url;
			mockWsOptions = options;
		}
	}
	return { default: MockWebSocket };
});

vi.mock('../discovery', () => ({
	readCliServerInfo: vi.fn(),
	isCliServerRunning: vi.fn(),
}));

import {
	BridgeConnection,
	CommandTimeoutError,
	UnsupportedCommandError,
	withBridgeConnection,
} from '../bridge-connection';
import { readCliServerInfo, isCliServerRunning, type CliServerInfo } from '../discovery';
import { CLI_SECRET_HEADER } from '../../../webLogin';

const RUNNING_SERVER: CliServerInfo = {
	port: 3000,
	token: 'test-token',
	pid: 12345,
	startedAt: 1700000000000,
};

function mockRunningServer(info: CliServerInfo = RUNNING_SERVER): void {
	vi.mocked(readCliServerInfo).mockReturnValue(info);
	vi.mocked(isCliServerRunning).mockReturnValue(true);
}

async function createConnectedClient(): Promise<BridgeConnection> {
	mockRunningServer();
	const client = new BridgeConnection();
	const connectPromise = client.connect();
	mockWsInstance.emit('open');
	await connectPromise;
	return client;
}

function lastSentPayload(): Record<string, unknown> {
	const calls = mockWsInstance.send.mock.calls;
	return JSON.parse(calls[calls.length - 1][0] as string) as Record<string, unknown>;
}

describe('BridgeConnection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockWsUrl = undefined;
		mockWsOptions = undefined;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('connect()', () => {
		it('should throw when no discovery file exists', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue(null);

			const client = new BridgeConnection();
			await expect(client.connect()).rejects.toThrow('Maestro desktop app is not running');
		});

		it('should throw when PID is stale', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue(RUNNING_SERVER);
			vi.mocked(isCliServerRunning).mockReturnValue(false);

			const client = new BridgeConnection();
			await expect(client.connect()).rejects.toThrow('Maestro discovery file is stale');
		});

		it('should connect successfully when server is running', async () => {
			mockRunningServer();

			const client = new BridgeConnection();
			const connectPromise = client.connect();

			// Simulate WebSocket open event
			mockWsInstance.emit('open');

			await connectPromise;

			// Verify connection was established (mockWsInstance is set)
			expect(mockWsInstance).toBeDefined();
		});

		it('dials 127.0.0.1 with the URL token, never localhost', async () => {
			mockRunningServer();

			const connectPromise = new BridgeConnection().connect();
			mockWsInstance.emit('open');
			await connectPromise;

			expect(mockWsUrl).toBe('ws://127.0.0.1:3000/test-token/ws');
		});

		it('presents the per-boot CLI secret from the discovery file on the upgrade', async () => {
			mockRunningServer({ ...RUNNING_SERVER, cliSecret: 'per-boot-secret' });

			const connectPromise = new BridgeConnection().connect();
			mockWsInstance.emit('open');
			await connectPromise;

			expect(CLI_SECRET_HEADER).toBe('x-maestro-cli-secret');
			expect(mockWsOptions).toEqual({ headers: { [CLI_SECRET_HEADER]: 'per-boot-secret' } });
		});

		it('sends no secret header when the discovery file has none (an older desktop)', async () => {
			mockRunningServer();

			const connectPromise = new BridgeConnection().connect();
			mockWsInstance.emit('open');
			await connectPromise;

			expect(mockWsOptions).toBeUndefined();
		});

		it('should reject on WebSocket error', async () => {
			mockRunningServer();

			const client = new BridgeConnection();
			const connectPromise = client.connect();

			// Simulate WebSocket error
			mockWsInstance.emit('error', new Error('Connection refused'));

			await expect(connectPromise).rejects.toThrow(
				'Failed to connect to Maestro: Connection refused'
			);
		});

		it('should timeout after 5 seconds', async () => {
			mockRunningServer();

			const client = new BridgeConnection();
			const connectPromise = client.connect();

			// Advance past timeout
			vi.advanceTimersByTime(5001);

			await expect(connectPromise).rejects.toThrow('Connection to Maestro timed out');
		});
	});

	describe('sendCommand()', () => {
		it('should throw when not connected', async () => {
			const client = new BridgeConnection();
			await expect(client.sendCommand({ type: 'ping' }, 'pong')).rejects.toThrow(
				'Not connected to Maestro'
			);
		});

		it('should resolve via requestId when response includes matching requestId', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand<{ type: string; data: string }>(
				{ type: 'ping' },
				'pong'
			);

			// Extract the requestId that was sent
			const sentPayload = lastSentPayload();
			expect(sentPayload.requestId).toBeDefined();

			// Respond with the same requestId (triggers requestId-based resolution)
			mockWsInstance.emit(
				'message',
				JSON.stringify({ type: 'pong', data: 'ok', requestId: sentPayload.requestId })
			);

			const result = await commandPromise;
			expect(result.type).toBe('pong');
			expect(result.data).toBe('ok');
		});

		it('should resolve on matching response type', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand<{ type: string; data: string }>(
				{ type: 'ping' },
				'pong'
			);

			// Simulate matching response
			mockWsInstance.emit('message', JSON.stringify({ type: 'pong', data: 'ok' }));

			const result = await commandPromise;
			expect(result.type).toBe('pong');
			expect(result.data).toBe('ok');
			expect(mockWsInstance.send).toHaveBeenCalledWith(expect.stringContaining('"type":"ping"'));
		});

		it('should reject on timeout with a CommandTimeoutError naming the expected reply', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand({ type: 'ping' }, 'pong', 2000);

			// Advance past timeout
			vi.advanceTimersByTime(2001);

			// The error names the expected response type so callers can tell which
			// command stalled.
			await expect(commandPromise).rejects.toThrow("expected 'pong'");
			await expect(commandPromise).rejects.toBeInstanceOf(CommandTimeoutError);
			await expect(commandPromise).rejects.toMatchObject({ responseType: 'pong' });
		});

		it('should use default 10s timeout', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand({ type: 'ping' }, 'pong');

			// At 9.9s it should still be pending
			vi.advanceTimersByTime(9900);

			// At 10.1s it should timeout
			vi.advanceTimersByTime(200);

			await expect(commandPromise).rejects.toThrow('Timed out waiting for the Maestro app');
		});

		it('rejects immediately with UnsupportedCommandError when the app echoes back', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand({ type: 'brand_new_cmd' }, 'brand_new_cmd_result');

			// The app does not recognize the type and replies with an echo carrying
			// the original message (and its requestId) under `data`.
			const sent = lastSentPayload();
			mockWsInstance.emit(
				'message',
				JSON.stringify({
					type: 'echo',
					originalType: 'brand_new_cmd',
					data: { type: 'brand_new_cmd', requestId: sent.requestId },
				})
			);

			await expect(commandPromise).rejects.toThrow("does not support the 'brand_new_cmd' command");
			await expect(commandPromise).rejects.toBeInstanceOf(UnsupportedCommandError);
			await expect(commandPromise).rejects.toMatchObject({ commandType: 'brand_new_cmd' });
		});

		it('should ignore non-matching response types', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand<{ type: string }>({ type: 'ping' }, 'pong');

			// Send non-matching response first
			mockWsInstance.emit('message', JSON.stringify({ type: 'other_event', data: 'ignored' }));

			// Then matching one
			mockWsInstance.emit('message', JSON.stringify({ type: 'pong' }));

			const result = await commandPromise;
			expect(result.type).toBe('pong');
		});

		it('should ignore non-JSON messages', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand<{ type: string }>({ type: 'ping' }, 'pong');

			// Send invalid JSON
			mockWsInstance.emit('message', 'not json');

			// Then send valid matching message
			mockWsInstance.emit('message', JSON.stringify({ type: 'pong' }));

			const result = await commandPromise;
			expect(result.type).toBe('pong');
		});

		it('rejects pending requests with the close code when the server closes the socket', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand({ type: 'ping' }, 'pong');

			// 4401 is the Web Login refusal (WEB_LOGIN_WS_CLOSE_CODE).
			mockWsInstance.emit('close', 4401, Buffer.from('Login required'));

			await expect(commandPromise).rejects.toThrow('Connection closed (code=4401): Login required');
			await expect(client.sendCommand({ type: 'ping' }, 'pong')).rejects.toThrow(
				'Not connected to Maestro'
			);
		});
	});

	describe('disconnect()', () => {
		it('should close the WebSocket connection', async () => {
			const client = await createConnectedClient();

			client.disconnect();

			expect(mockWsInstance.close).toHaveBeenCalled();
		});

		it('should reject pending requests on disconnect', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand({ type: 'ping' }, 'pong');

			client.disconnect();

			await expect(commandPromise).rejects.toThrow('Client disconnected');
		});

		it('should be safe to call when not connected', () => {
			const client = new BridgeConnection();
			expect(() => client.disconnect()).not.toThrow();
		});
	});
});

describe('withBridgeConnection()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should connect, run action, and disconnect', async () => {
		mockRunningServer();

		const actionResult = 'action-result';
		const actionFn = vi.fn().mockResolvedValue(actionResult);

		const resultPromise = withBridgeConnection(actionFn);

		// Wait for connect
		mockWsInstance.emit('open');

		const result = await resultPromise;

		expect(result).toBe(actionResult);
		expect(actionFn).toHaveBeenCalledTimes(1);
		expect(actionFn.mock.calls[0][0]).toBeInstanceOf(BridgeConnection);
		// Should disconnect after action
		expect(mockWsInstance.close).toHaveBeenCalled();
	});

	it('should disconnect even when action throws', async () => {
		mockRunningServer();

		const actionFn = vi.fn().mockRejectedValue(new Error('Action failed'));

		const resultPromise = withBridgeConnection(actionFn);
		mockWsInstance.emit('open');

		await expect(resultPromise).rejects.toThrow('Action failed');
		expect(mockWsInstance.close).toHaveBeenCalled();
	});

	it('should propagate connection errors', async () => {
		vi.mocked(readCliServerInfo).mockReturnValue(null);

		await expect(withBridgeConnection(async () => 'should not reach')).rejects.toThrow(
			'Maestro desktop app is not running'
		);
	});
});
