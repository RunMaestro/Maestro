/**
 * @file maestro-client.test.ts
 * @description Tests for the CLI WebSocket client service
 *
 * Tests the MaestroClient class including:
 * - Connection lifecycle (connect, disconnect)
 * - Command sending with response matching
 * - Timeout handling
 * - withMaestroClient helper lifecycle
 * - resolveSessionId helper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Track WebSocket instances created
let mockWsInstance: EventEmitter & {
	close: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
	readyState: number;
};

vi.mock('ws', async () => {
	const { EventEmitter: EE } = await import('events');
	const WS_OPEN = 1;
	class MockWebSocket extends EE {
		close = vi.fn();
		send = vi.fn();
		readyState = WS_OPEN;
		static OPEN = WS_OPEN;
		constructor() {
			super();
			// eslint-disable-next-line @typescript-eslint/no-use-before-define
			mockWsInstance = this as unknown as typeof mockWsInstance;
		}
	}
	return { default: MockWebSocket };
});

vi.mock('../../../shared/cli-server-discovery', () => ({
	readCliServerInfo: vi.fn(),
	isCliServerRunning: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	readSessions: vi.fn(),
}));

import {
	MaestroClient,
	withMaestroClient,
	resolveSessionId,
} from '../../../cli/services/maestro-client';
import { readCliServerInfo, isCliServerRunning } from '../../../shared/cli-server-discovery';
import { readSessions } from '../../../cli/services/storage';
import WebSocket from 'ws';

describe('MaestroClient', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('connect()', () => {
		it('should throw when no discovery file exists', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue(null);

			const client = new MaestroClient();
			await expect(client.connect()).rejects.toThrow('Maestro desktop app is not running');
		});

		it('should throw when PID is stale', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(false);

			const client = new MaestroClient();
			await expect(client.connect()).rejects.toThrow('Maestro discovery file is stale');
		});

		it('should connect successfully when server is running', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);

			const client = new MaestroClient();
			const connectPromise = client.connect();

			// Simulate WebSocket open event
			mockWsInstance.emit('open');

			await connectPromise;

			// Verify connection was established (mockWsInstance is set)
			expect(mockWsInstance).toBeDefined();
		});

		it('should reject on WebSocket error', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);

			const client = new MaestroClient();
			const connectPromise = client.connect();

			// Simulate WebSocket error
			mockWsInstance.emit('error', new Error('Connection refused'));

			await expect(connectPromise).rejects.toThrow(
				'Failed to connect to Maestro: Connection refused'
			);
		});

		it('should timeout after 5 seconds', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);

			const client = new MaestroClient();
			const connectPromise = client.connect();

			// Advance past timeout
			vi.advanceTimersByTime(5001);

			await expect(connectPromise).rejects.toThrow('Connection to Maestro timed out');
		});
	});

	describe('sendCommand()', () => {
		async function createConnectedClient(): Promise<MaestroClient> {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);

			const client = new MaestroClient();
			const connectPromise = client.connect();
			mockWsInstance.emit('open');
			await connectPromise;
			return client;
		}

		it('should throw when not connected', async () => {
			const client = new MaestroClient();
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
			const sentPayload = JSON.parse(mockWsInstance.send.mock.calls[0][0] as string) as Record<
				string,
				unknown
			>;
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

		it('should reject on timeout', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand({ type: 'ping' }, 'pong', 2000);

			// Advance past timeout
			vi.advanceTimersByTime(2001);

			await expect(commandPromise).rejects.toThrow('Command timed out waiting for pong');
		});

		it('should use default 10s timeout', async () => {
			const client = await createConnectedClient();

			const commandPromise = client.sendCommand({ type: 'ping' }, 'pong');

			// At 9.9s it should still be pending
			vi.advanceTimersByTime(9900);

			// At 10.1s it should timeout
			vi.advanceTimersByTime(200);

			await expect(commandPromise).rejects.toThrow('Command timed out');
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
	});

	describe('disconnect()', () => {
		it('should close the WebSocket connection', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);

			const client = new MaestroClient();
			const connectPromise = client.connect();
			mockWsInstance.emit('open');
			await connectPromise;

			client.disconnect();

			expect(mockWsInstance.close).toHaveBeenCalled();
		});

		it('should reject pending requests on disconnect', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(true);

			const client = new MaestroClient();
			const connectPromise = client.connect();
			mockWsInstance.emit('open');
			await connectPromise;

			const commandPromise = client.sendCommand({ type: 'ping' }, 'pong');

			client.disconnect();

			await expect(commandPromise).rejects.toThrow('Client disconnected');
		});

		it('should be safe to call when not connected', () => {
			const client = new MaestroClient();
			expect(() => client.disconnect()).not.toThrow();
		});
	});
});

describe('withMaestroClient()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should connect, run action, and disconnect', async () => {
		vi.mocked(readCliServerInfo).mockReturnValue({
			port: 3000,
			token: 'test-token',
			pid: 12345,
			startedAt: Date.now(),
		});
		vi.mocked(isCliServerRunning).mockReturnValue(true);

		const actionResult = 'action-result';
		const actionFn = vi.fn().mockResolvedValue(actionResult);

		const resultPromise = withMaestroClient(actionFn);

		// Wait for connect
		mockWsInstance.emit('open');

		const result = await resultPromise;

		expect(result).toBe(actionResult);
		expect(actionFn).toHaveBeenCalledTimes(1);
		// Should disconnect after action
		expect(mockWsInstance.close).toHaveBeenCalled();
	});

	it('should disconnect even when action throws', async () => {
		vi.mocked(readCliServerInfo).mockReturnValue({
			port: 3000,
			token: 'test-token',
			pid: 12345,
			startedAt: Date.now(),
		});
		vi.mocked(isCliServerRunning).mockReturnValue(true);

		const actionFn = vi.fn().mockRejectedValue(new Error('Action failed'));

		const resultPromise = withMaestroClient(actionFn);
		mockWsInstance.emit('open');

		await expect(resultPromise).rejects.toThrow('Action failed');
		expect(mockWsInstance.close).toHaveBeenCalled();
	});

	it('should propagate connection errors', async () => {
		vi.mocked(readCliServerInfo).mockReturnValue(null);

		await expect(withMaestroClient(async () => 'should not reach')).rejects.toThrow(
			'Maestro desktop app is not running'
		);
	});
});

describe('resolveSessionId()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should return provided session option directly', () => {
		const result = resolveSessionId({ session: 'my-session-id' });
		expect(result).toBe('my-session-id');
		expect(readSessions).not.toHaveBeenCalled();
	});

	it('should return first session ID when no option provided', () => {
		vi.mocked(readSessions).mockReturnValue([
			{
				id: 'first-session',
				name: 'First',
				toolType: 'claude-code',
				cwd: '/path',
				projectRoot: '/path',
			},
			{
				id: 'second-session',
				name: 'Second',
				toolType: 'claude-code',
				cwd: '/path',
				projectRoot: '/path',
			},
		]);

		const result = resolveSessionId({});
		expect(result).toBe('first-session');
	});

	it('should exit when no sessions exist and no option provided', () => {
		vi.mocked(readSessions).mockReturnValue([]);
		const processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit called');
		});
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(() => resolveSessionId({})).toThrow('process.exit called');

		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No agents found'));

		processExitSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});
});
