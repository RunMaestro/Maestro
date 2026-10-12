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

const mockWsConstructor = vi.fn();
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
		constructor(url: string, options?: unknown) {
			super();
			mockWsConstructor(url, options);
			try {
				new URL(url);
			} catch {
				throw new SyntaxError(`Invalid URL: ${url}`);
			}
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
		vi.stubEnv('MAESTRO_CLI_HOST', undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
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

		it.each([
			['maestro.local', 'maestro.local:3000'],
			['192.0.2.1', '192.0.2.1:3000'],
			['maestro.local:4444', 'maestro.local:4444'],
			['maestro.local:80', 'maestro.local:80'],
			['[::1]', '[::1]:3000'],
			['::1', '[::1]:3000'],
		])('uses remote host %s and skips only its local PID probe', async (host, authority) => {
			vi.stubEnv('MAESTRO_CLI_HOST', host);
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'test-token',
				pid: 12345,
				startedAt: Date.now(),
			});
			vi.mocked(isCliServerRunning).mockReturnValue(false);
			const client = new MaestroClient();
			const promise = client.connect();
			mockWsInstance.emit('open');
			await promise;
			expect(mockWsConstructor.mock.calls[0][0]).toBe(`ws://${authority}/test-token/ws`);
			expect(isCliServerRunning).not.toHaveBeenCalled();
			client.disconnect();
		});

		it.each([
			'bad host',
			'user:pass@host',
			'host/path',
			'host?query',
			'host#fragment',
			'ws://host',
			'host:99999',
			'host\\path',
			'h!ost',
			'-host',
			'host:',
			'[::1]:',
		])('rejects invalid host %s without exposing credentials', async (host) => {
			vi.stubEnv('MAESTRO_CLI_HOST', host);
			vi.mocked(readCliServerInfo).mockReturnValue({
				port: 3000,
				token: 'PRIVATE_TOKEN',
				cliSecret: 'PRIVATE_SECRET',
				pid: 12345,
				startedAt: Date.now(),
			});
			const promise = new MaestroClient().connect().catch((error: Error) => error);
			if (mockWsConstructor.mock.calls.length) mockWsInstance.emit('open');
			const error = await promise;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe(
				'Invalid MAESTRO_CLI_HOST: expected a hostname or IP address, optionally with a port'
			);
			expect(String(error)).not.toContain('PRIVATE_TOKEN');
			expect(String(error)).not.toContain('PRIVATE_SECRET');
			expect(mockWsConstructor).not.toHaveBeenCalled();
		});

		it.each([undefined, '', '   '])(
			'keeps the original loopback URL for unset or empty host %s',
			async (host) => {
				vi.stubEnv('MAESTRO_CLI_HOST', host);
				vi.mocked(readCliServerInfo).mockReturnValue({
					port: 3000,
					token: 'test-token',
					cliSecret: 'test-secret',
					pid: 12345,
					startedAt: Date.now(),
				});
				vi.mocked(isCliServerRunning).mockReturnValue(true);
				const client = new MaestroClient();
				const promise = client.connect();
				mockWsInstance.emit('open');
				await promise;
				expect(mockWsConstructor.mock.calls[0][0]).toBe('ws://127.0.0.1:3000/test-token/ws');
				expect(isCliServerRunning).toHaveBeenCalledOnce();
				client.disconnect();
			}
		);

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
