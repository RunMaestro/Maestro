/**
 * @file maestro-client.test.ts
 * @description Tests for the CLI WebSocket client service
 *
 * The connection itself moved into maestro-lib as `BridgeConnection` (its own
 * tests live in src/shared/maestro-lib/client/__tests__/bridge-connection.test.ts).
 * This service keeps the CLI's names for it, so these tests cover:
 * - The aliases resolve to the library's connection and error classes
 * - withMaestroClient helper lifecycle, through the alias
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
			mockWsInstance = this as unknown as typeof mockWsInstance;
		}
	}
	return { default: MockWebSocket };
});

// The connection reads discovery from inside the library, so the mock goes on
// the library module rather than on the src/shared/cli-server-discovery shim.
vi.mock('../../../shared/maestro-lib/client/discovery', () => ({
	readCliServerInfo: vi.fn(),
	isCliServerRunning: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => {
	const readSessions = vi.fn();
	// The live list is the stored list here: no fixture holds a dormant agent.
	return { readSessions, readLiveSessions: (...args: unknown[]) => readSessions(...args) };
});

import {
	MaestroClient,
	withMaestroClient,
	resolveSessionId,
	UnsupportedCommandError,
	CommandTimeoutError,
} from '../../../cli/services/maestro-client';
import {
	BridgeConnection,
	withBridgeConnection,
	UnsupportedCommandError as LibraryUnsupportedCommandError,
	CommandTimeoutError as LibraryCommandTimeoutError,
} from '../../../shared/maestro-lib/client/bridge-connection';
import {
	readCliServerInfo,
	isCliServerRunning,
} from '../../../shared/maestro-lib/client/discovery';
import { readSessions } from '../../../cli/services/storage';
import { MaestroNotRunningError } from '../../../cli/services/maestro-bridge-errors';
import WebSocket from 'ws';

describe('CLI names for the library bridge connection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.mocked(isCliServerRunning).mockReturnValue(true);
	});
	it('MaestroClient and withMaestroClient are the library connection and helper', () => {
		expect(MaestroClient).toBe(BridgeConnection);
		expect(withMaestroClient).toBe(withBridgeConnection);
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

		it('should name an unreachable app with MaestroNotRunningError, so a verb exits 3', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue(null);
			await expect(new MaestroClient().connect()).rejects.toBeInstanceOf(MaestroNotRunningError);

			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(false);
			await expect(new MaestroClient().connect()).rejects.toBeInstanceOf(MaestroNotRunningError);

			vi.mocked(isCliServerRunning).mockReturnValue(true);
			const client = new MaestroClient();
			const connecting = client.connect();
			mockWsInstance.emit(
				'error',
				Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' })
			);
			await expect(connecting).rejects.toBeInstanceOf(MaestroNotRunningError);
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
			await expect(client.connect()).rejects.toMatchObject({ reason: 'stale-discovery-file' });
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

			await expect(connectPromise).rejects.toMatchObject({ reason: 'connect-timeout' });
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

			// The error names the expected response type so callers can tell which
			// command stalled.
			await expect(commandPromise).rejects.toThrow("expected 'pong'");
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
			const sent = JSON.parse((mockWsInstance.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
			mockWsInstance.emit(
				'message',
				JSON.stringify({
					type: 'echo',
					originalType: 'brand_new_cmd',
					data: { type: 'brand_new_cmd', requestId: sent.requestId },
				})
			);

			await expect(commandPromise).rejects.toThrow("does not support the 'brand_new_cmd' command");
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

	it('re-exports the library error classes, so instanceof checks keep matching', () => {
		expect(UnsupportedCommandError).toBe(LibraryUnsupportedCommandError);
		expect(CommandTimeoutError).toBe(LibraryCommandTimeoutError);
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
		expect(actionFn.mock.calls[0][0]).toBeInstanceOf(MaestroClient);
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
