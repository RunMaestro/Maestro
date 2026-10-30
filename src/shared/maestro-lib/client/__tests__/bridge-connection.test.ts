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
import { MaestroNotRunningError, MAESTRO_NOT_RUNNING_MESSAGE } from '../not-running';

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
	readCliServerInfoFrom: vi.fn(),
	isCliServerRunning: vi.fn(),
	isPidAlive: vi.fn(),
}));

import {
	BridgeConnection,
	CommandTimeoutError,
	ConnectionClosedError,
	UnsupportedCommandError,
	withBridgeConnection,
} from '../bridge-connection';
import {
	readCliServerInfo,
	readCliServerInfoFrom,
	isCliServerRunning,
	isPidAlive,
	type CliServerInfo,
} from '../discovery';
import { HEADLESS_RUN_COMPLETION_TIMEOUT_MS } from '../../../plugins/headless-agent-timeouts';
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

	it('holds a headless reply past sixty-one minutes but polls cannot extend the six-hour authority', async () => {
		const client = await createConnectedClient();
		try {
			const reply = client.sendCommand(
				{ type: 'plugins_send_agent' },
				'plugins_send_agent_result',
				HEADLESS_RUN_COMPLETION_TIMEOUT_MS
			);
			const { requestId } = lastSentPayload();
			await vi.advanceTimersByTimeAsync(61 * 60_000);
			mockWsInstance.emit(
				'message',
				JSON.stringify({ type: 'plugins_send_agent_result', requestId, success: true })
			);
			expect(await reply).toMatchObject({ success: true });
			const pending = client.sendCommand(
				{ type: 'plugins_send_agent' },
				'plugins_send_agent_result',
				HEADLESS_RUN_COMPLETION_TIMEOUT_MS
			);
			const rejected = expect(pending).rejects.toBeInstanceOf(CommandTimeoutError);
			for (let n = 0; n < 6; n++) {
				await vi.advanceTimersByTimeAsync(60 * 60_000);
				mockWsInstance.emit(
					'message',
					JSON.stringify({ type: 'bridge.event', channel: 'poll', args: [] })
				);
			}
			await vi.advanceTimersByTimeAsync(60_000);
			await rejected;
		} finally {
			client.disconnect();
		}
	});

	describe('connect()', () => {
		it('should throw when no discovery file exists', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue(null);

			const client = new BridgeConnection();
			await expect(client.connect()).rejects.toThrow('Maestro desktop app is not running');
		});

		it('names the headless host as the other way to get a peer when nothing is running', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue(null);

			const error = await new BridgeConnection().connect().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(MaestroNotRunningError);
			expect(error).toMatchObject({
				message: MAESTRO_NOT_RUNNING_MESSAGE,
				code: 'MAESTRO_NOT_RUNNING',
				reason: 'no-discovery-file',
			});
			expect((error as MaestroNotRunningError).hint).toContain('maestro-cli host start');
		});

		it('should throw when PID is stale', async () => {
			vi.mocked(readCliServerInfo).mockReturnValue(RUNNING_SERVER);
			vi.mocked(isCliServerRunning).mockReturnValue(false);

			const error = await new BridgeConnection().connect().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(MaestroNotRunningError);
			expect(error).toMatchObject({
				message: MAESTRO_NOT_RUNNING_MESSAGE,
				reason: 'stale-discovery-file',
			});
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

			// A socket-level failure carries an errno: nothing is listening.
			mockWsInstance.emit(
				'error',
				Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), { code: 'ECONNREFUSED' })
			);

			const error = await connectPromise.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(MaestroNotRunningError);
			expect(error).toMatchObject({
				message: MAESTRO_NOT_RUNNING_MESSAGE,
				reason: 'connect-failed',
				detail: 'connect ECONNREFUSED 127.0.0.1:3000',
			});
		});

		it('keeps an HTTP rejection of the upgrade as an ordinary error (the app is running)', async () => {
			mockRunningServer();

			const connectPromise = new BridgeConnection().connect();
			// What ws emits when the Web Login gate answers 401: no errno.
			mockWsInstance.emit('error', new Error('Unexpected server response: 401'));

			const error = await connectPromise.catch((e: unknown) => e);
			expect(error).not.toBeInstanceOf(MaestroNotRunningError);
			expect((error as Error).message).toBe(
				'Failed to connect to Maestro: Unexpected server response: 401'
			);
		});

		it('should timeout after 5 seconds', async () => {
			mockRunningServer();

			const client = new BridgeConnection();
			const connectPromise = client.connect();

			// Advance past timeout
			vi.advanceTimersByTime(5001);

			const error = await connectPromise.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(MaestroNotRunningError);
			expect(error).toMatchObject({ reason: 'connect-timeout' });
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

		it('says the headless host does not support the command when the peer is one', async () => {
			mockRunningServer({ ...RUNNING_SERVER, hostKind: 'headless' });
			const client = new BridgeConnection();
			const connectPromise = client.connect();
			mockWsInstance.emit('open');
			await connectPromise;

			const commandPromise = client.sendCommand({ type: 'open_file_tab' }, 'open_file_tab_result');
			const sent = lastSentPayload();
			mockWsInstance.emit(
				'message',
				JSON.stringify({
					type: 'echo',
					originalType: 'open_file_tab',
					data: { type: 'open_file_tab', requestId: sent.requestId },
				})
			);

			await expect(commandPromise).rejects.toBeInstanceOf(UnsupportedCommandError);
			await expect(commandPromise).rejects.toThrow(
				"The headless Maestro host (`maestro-cli host`) does not support the 'open_file_tab' command"
			);
			// Nobody with only a headless host running has a desktop app to rebuild.
			await expect(commandPromise).rejects.not.toThrow('rebuild and restart the desktop app');
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

	describe('options for a client that owns its connection', () => {
		it('reads discovery from the data dir it was given, not the CLI derivation', async () => {
			vi.mocked(readCliServerInfoFrom).mockReturnValue(RUNNING_SERVER);
			vi.mocked(isPidAlive).mockReturnValue(true);

			const connectPromise = new BridgeConnection({ userDataDir: '/data/maestro' }).connect();
			mockWsInstance.emit('open');
			await connectPromise;

			expect(readCliServerInfoFrom).toHaveBeenCalledWith('/data/maestro');
			expect(readCliServerInfo).not.toHaveBeenCalled();
			expect(isPidAlive).toHaveBeenCalledWith(RUNNING_SERVER.pid);
			expect(mockWsUrl).toBe('ws://127.0.0.1:3000/test-token/ws');
		});

		it('says so when that data dir has no live desktop', async () => {
			vi.mocked(readCliServerInfoFrom).mockReturnValue(null);
			await expect(new BridgeConnection({ userDataDir: '/nope' }).connect()).rejects.toThrow(
				'Maestro desktop app is not running'
			);

			vi.mocked(readCliServerInfoFrom).mockReturnValue(RUNNING_SERVER);
			vi.mocked(isPidAlive).mockReturnValue(false);
			await expect(new BridgeConnection({ userDataDir: '/stale' }).connect()).rejects.toMatchObject(
				{
					name: 'MaestroNotRunningError',
					reason: 'stale-discovery-file',
				}
			);
		});

		it('appends the query parameters a resume needs', async () => {
			mockRunningServer();
			const connectPromise = new BridgeConnection({
				query: { since: 42, epoch: 'boot-1' },
			}).connect();
			mockWsInstance.emit('open');
			await connectPromise;
			expect(mockWsUrl).toBe('ws://127.0.0.1:3000/test-token/ws?since=42&epoch=boot-1');
		});

		it('hands every frame that answers no call to onFrame, and none that does', async () => {
			mockRunningServer();
			const onFrame = vi.fn();
			const client = new BridgeConnection({ onFrame });
			const connectPromise = client.connect();
			mockWsInstance.emit('open');
			await connectPromise;

			const commandPromise = client.sendCommand({ type: 'ping' }, 'pong');
			const { requestId } = lastSentPayload();
			mockWsInstance.emit(
				'message',
				JSON.stringify({ type: 'bridge.event', channel: 'x', args: [] })
			);
			mockWsInstance.emit('message', JSON.stringify({ type: 'pong', requestId }));
			await commandPromise;
			mockWsInstance.emit('message', 'not json');

			expect(onFrame).toHaveBeenCalledTimes(1);
			expect(onFrame).toHaveBeenCalledWith({ type: 'bridge.event', channel: 'x', args: [] });
		});

		it('does not resolve a call by reply type alone when replies are strict', async () => {
			mockRunningServer();
			const onFrame = vi.fn();
			const client = new BridgeConnection({ strictReplies: true, onFrame });
			const connectPromise = client.connect();
			mockWsInstance.emit('open');
			await connectPromise;

			const commandPromise = client.sendCommand<{ type: string }>({ type: 'ping' }, 'pong', 50);
			const settled = commandPromise.then(
				(value) => ({ value }),
				(error: unknown) => ({ error })
			);
			// A late reply to some other call carries a request id this call never sent.
			mockWsInstance.emit('message', JSON.stringify({ type: 'pong', requestId: 'req_other' }));
			vi.advanceTimersByTime(60);
			expect(await settled).toMatchObject({ error: expect.any(CommandTimeoutError) });
			expect(onFrame).toHaveBeenCalledWith({ type: 'pong', requestId: 'req_other' });
		});

		it('lets one strict call opt back into type matching', async () => {
			mockRunningServer();
			const client = new BridgeConnection({ strictReplies: true });
			const connectPromise = client.connect();
			mockWsInstance.emit('open');
			await connectPromise;

			const commandPromise = client.sendCommand<{ type: string }>(
				{ type: 'get_sessions' },
				'sessions_list',
				1000,
				{
					matchByType: true,
				}
			);
			mockWsInstance.emit('message', JSON.stringify({ type: 'sessions_list', sessions: [] }));
			expect((await commandPromise).type).toBe('sessions_list');
		});

		it('keeps a strict echo from rejecting a call it did not answer', async () => {
			mockRunningServer();
			const client = new BridgeConnection({ strictReplies: true });
			const connectPromise = client.connect();
			mockWsInstance.emit('open');
			await connectPromise;

			const commandPromise = client.sendCommand({ type: 'thing' }, 'thing_result', 50);
			const settled = commandPromise.then(
				(value) => ({ value }),
				(error: unknown) => ({ error })
			);
			mockWsInstance.emit(
				'message',
				JSON.stringify({ type: 'echo', originalType: 'thing', data: { type: 'thing' } })
			);
			vi.advanceTimersByTime(60);
			expect(await settled).toMatchObject({ error: expect.any(CommandTimeoutError) });
		});

		it('reports a socket close with its code and reason, and fails calls in flight with ConnectionClosedError', async () => {
			mockRunningServer();
			const onClose = vi.fn();
			const client = new BridgeConnection({ onClose });
			const connectPromise = client.connect();
			mockWsInstance.emit('open');
			await connectPromise;

			const commandPromise = client.sendCommand({ type: 'ping' }, 'pong');
			mockWsInstance.emit('close', 4401, Buffer.from('Login required'));

			await expect(commandPromise).rejects.toBeInstanceOf(ConnectionClosedError);
			await expect(commandPromise).rejects.toMatchObject({
				closedByCaller: false,
				code: 4401,
				reason: 'Login required',
				message: 'Connection closed (code=4401): Login required',
			});
			expect(onClose).toHaveBeenCalledWith(4401, 'Login required');
			expect(client.isOpen).toBe(false);
		});

		it('does not report a close the caller asked for, and marks those calls as closed by the caller', async () => {
			mockRunningServer();
			const onClose = vi.fn();
			const client = new BridgeConnection({ onClose });
			const connectPromise = client.connect();
			mockWsInstance.emit('open');
			await connectPromise;

			const commandPromise = client.sendCommand({ type: 'ping' }, 'pong');
			client.disconnect();
			mockWsInstance.emit('close', 1000, Buffer.from(''));

			await expect(commandPromise).rejects.toMatchObject({
				closedByCaller: true,
				message: 'Client disconnected',
			});
			expect(onClose).not.toHaveBeenCalled();
		});

		it('sends a message that expects no reply, and says whether the socket is open', async () => {
			const client = await createConnectedClient();
			expect(client.isOpen).toBe(true);
			expect(client.send({ type: 'ping' })).toBe(true);
			expect(lastSentPayload()).toEqual({ type: 'ping' });
			client.disconnect();
			expect(client.send({ type: 'ping' })).toBe(false);
			expect(client.isOpen).toBe(false);
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
