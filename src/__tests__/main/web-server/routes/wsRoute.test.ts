/**
 * Tests for WsRoute
 *
 * WebSocket Route handles WebSocket connections, initial state sync, and message delegation.
 * Route: /$TOKEN/ws
 *
 * Connection Flow:
 * 1. Client connects with optional ?sessionId= query param
 * 2. Server sends 'connected' message with client ID
 * 3. Server sends 'sessions_list' with all sessions (enriched with live info)
 * 4. Server sends 'theme' with current theme
 * 5. Server sends 'custom_commands' with available commands
 * 6. Server sends 'autorun_state' for active AutoRun sessions
 * 7. Client can send messages which are delegated to WebSocketMessageHandler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { WsRoute, type WsRouteCallbacks } from '../../../../main/web-server/routes/wsRoute';
import { getCliSecret } from '../../../../main/web-server/auth/cli-secret';
import { CLI_SECRET_HEADER } from '../../../../shared/webLogin';
import { WEB_LOGIN_COOKIE, WEB_LOGIN_WS_CLOSE_CODE } from '../../../../shared/webLogin';

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Web Login. The REAL policy runs (the CLI secret and the cookie rule are
// exactly what the gate tests below are about); only its two data sources are
// stubbed, because both reach for Electron's userData path.
const { webLogin } = vi.hoisted(() => ({
	webLogin: {
		/** The `webLogin` Encore flag. */
		enabled: false,
		/** Session id -> the account behind it. */
		sessions: new Map<string, { id: string; username: string; displayName: string }>(),
	},
}));

vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: () => ({ webLogin: webLogin.enabled }),
	}),
}));

vi.mock('../../../../main/web-server/auth/web-user-store', () => ({
	getWebUserStore: () => ({
		resolveSession: (sessionId?: string) =>
			sessionId ? webLogin.sessions.get(sessionId) : undefined,
	}),
}));

/**
 * Create mock callbacks with all methods as vi.fn()
 */
function createMockCallbacks(): WsRouteCallbacks {
	return {
		getSessions: vi.fn().mockReturnValue([
			{
				id: 'session-1',
				name: 'Session 1',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/test/project',
				groupId: null,
			},
			{
				id: 'session-2',
				name: 'Session 2',
				toolType: 'codex',
				state: 'busy',
				inputMode: 'terminal',
				cwd: '/test/project2',
				groupId: 'group-1',
			},
		]),
		getTheme: vi.fn().mockReturnValue({
			name: 'dark',
			background: '#1a1a1a',
			foreground: '#ffffff',
		}),
		getCustomCommands: vi
			.fn()
			.mockReturnValue([{ id: 'cmd-1', name: 'Test Command', prompt: 'Do something' }]),
		getAutoRunStates: vi.fn().mockReturnValue(
			new Map([
				[
					'session-1',
					{
						isRunning: true,
						totalTasks: 5,
						completedTasks: 2,
						currentTask: 'Task 3',
					},
				],
			])
		),
		getLiveSessionInfo: vi.fn().mockReturnValue({
			sessionId: 'session-1',
			agentSessionId: 'claude-agent-123',
			enabledAt: Date.now(),
		}),
		isSessionLive: vi.fn().mockReturnValue(true),
		onClientConnect: vi.fn(),
		onClientDisconnect: vi.fn(),
		onClientError: vi.fn(),
		handleMessage: vi.fn(),
	};
}

/**
 * Create mock WebSocket
 */
function createMockSocket() {
	const eventHandlers: Map<string, Function[]> = new Map();
	return {
		readyState: WebSocket.OPEN,
		send: vi.fn(),
		close: vi.fn(),
		on: vi.fn((event: string, handler: Function) => {
			if (!eventHandlers.has(event)) {
				eventHandlers.set(event, []);
			}
			eventHandlers.get(event)!.push(handler);
		}),
		emit: (event: string, ...args: any[]) => {
			const handlers = eventHandlers.get(event) || [];
			handlers.forEach((h) => h(...args));
		},
		eventHandlers,
	};
}

/**
 * Create mock Fastify connection.
 *
 * @fastify/websocket v10+ passes the raw WebSocket to the route handler
 * directly (no `{ socket }` wrapper), so the mock IS the socket.
 */
function createMockConnection() {
	return createMockSocket();
}

/**
 * Create mock Fastify request
 */
function createMockRequest(sessionId?: string, overrides: Record<string, unknown> = {}) {
	const queryString = sessionId ? `?sessionId=${sessionId}` : '';
	return {
		url: `/test-token/ws${queryString}`,
		headers: {
			host: 'localhost:3000',
		},
		...overrides,
	};
}

/**
 * Mock Fastify instance with route registration tracking
 */
function createMockFastify() {
	const routes: Map<string, { handler: Function; options?: any }> = new Map();

	return {
		get: vi.fn((path: string, options: any, handler?: Function) => {
			const h = handler || options;
			const opts = handler ? options : undefined;
			routes.set(`GET:${path}`, { handler: h, options: opts });
		}),
		getRoute: (method: string, path: string) => routes.get(`${method}:${path}`),
		routes,
	};
}

describe('WsRoute', () => {
	const securityToken = 'test-token-123';

	let wsRoute: WsRoute;
	let callbacks: WsRouteCallbacks;
	let mockFastify: ReturnType<typeof createMockFastify>;

	beforeEach(() => {
		webLogin.enabled = false;
		webLogin.sessions.clear();
		wsRoute = new WsRoute(securityToken);
		callbacks = createMockCallbacks();
		wsRoute.setCallbacks(callbacks);
		mockFastify = createMockFastify();
		wsRoute.registerRoute(mockFastify as any);
	});

	describe('Route Registration', () => {
		it('should register WebSocket route with correct path', () => {
			expect(mockFastify.get).toHaveBeenCalledTimes(1);
			expect(mockFastify.routes.has(`GET:/${securityToken}/ws`)).toBe(true);
		});

		it('should register route with websocket option', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			expect(route?.options?.websocket).toBe(true);
		});
	});

	describe('Connection Handling', () => {
		it('should generate unique client IDs', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);

			// Connect first client
			const conn1 = createMockConnection();
			route!.handler(conn1, createMockRequest());

			// Connect second client
			const conn2 = createMockConnection();
			route!.handler(conn2, createMockRequest());

			// Verify unique IDs
			expect(callbacks.onClientConnect).toHaveBeenCalledTimes(2);
			const client1 = (callbacks.onClientConnect as any).mock.calls[0][0];
			const client2 = (callbacks.onClientConnect as any).mock.calls[1][0];
			expect(client1.id).not.toBe(client2.id);
			expect(client1.id).toMatch(/^web-client-\d+$/);
			expect(client2.id).toMatch(/^web-client-\d+$/);
		});

		it('should notify parent on client connect', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			expect(callbacks.onClientConnect).toHaveBeenCalledWith(
				expect.objectContaining({
					id: expect.stringMatching(/^web-client-/),
					socket: connection,
					connectedAt: expect.any(Number),
				})
			);
		});

		it('should extract sessionId from query string', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest('session-123'));

			expect(callbacks.onClientConnect).toHaveBeenCalledWith(
				expect.objectContaining({
					subscribedSessionId: 'session-123',
				})
			);
		});

		it('should set subscribedSessionId to undefined when not in query', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			expect(callbacks.onClientConnect).toHaveBeenCalledWith(
				expect.objectContaining({
					subscribedSessionId: undefined,
				})
			);
		});
	});

	describe('Initial Sync Messages', () => {
		it('should send connected message', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest('session-123'));

			const sentMessages = (connection.send as any).mock.calls.map((call: any[]) =>
				JSON.parse(call[0])
			);

			const connectedMsg = sentMessages.find((m: any) => m.type === 'connected');
			expect(connectedMsg).toBeDefined();
			expect(connectedMsg.clientId).toMatch(/^web-client-/);
			expect(connectedMsg.subscribedSessionId).toBe('session-123');
			expect(connectedMsg.timestamp).toBeDefined();
		});

		it('should send sessions_list with enriched live info', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			const sentMessages = (connection.send as any).mock.calls.map((call: any[]) =>
				JSON.parse(call[0])
			);

			const sessionsMsg = sentMessages.find((m: any) => m.type === 'sessions_list');
			expect(sessionsMsg).toBeDefined();
			expect(sessionsMsg.sessions).toHaveLength(2);
			expect(sessionsMsg.sessions[0].agentSessionId).toBe('claude-agent-123');
			expect(sessionsMsg.sessions[0].isLive).toBe(true);
			expect(sessionsMsg.sessions[0].liveEnabledAt).toBeDefined();
		});

		it('should send theme', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			const sentMessages = (connection.send as any).mock.calls.map((call: any[]) =>
				JSON.parse(call[0])
			);

			const themeMsg = sentMessages.find((m: any) => m.type === 'theme');
			expect(themeMsg).toBeDefined();
			expect(themeMsg.theme.name).toBe('dark');
		});

		it('should not send theme when null', () => {
			(callbacks.getTheme as any).mockReturnValue(null);

			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			const sentMessages = (connection.send as any).mock.calls.map((call: any[]) =>
				JSON.parse(call[0])
			);

			const themeMsg = sentMessages.find((m: any) => m.type === 'theme');
			expect(themeMsg).toBeUndefined();
		});

		it('should send custom_commands', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			const sentMessages = (connection.send as any).mock.calls.map((call: any[]) =>
				JSON.parse(call[0])
			);

			const commandsMsg = sentMessages.find((m: any) => m.type === 'custom_commands');
			expect(commandsMsg).toBeDefined();
			expect(commandsMsg.commands).toHaveLength(1);
			expect(commandsMsg.commands[0].name).toBe('Test Command');
		});

		it('should send autorun_state for running sessions', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			const sentMessages = (connection.send as any).mock.calls.map((call: any[]) =>
				JSON.parse(call[0])
			);

			const autoRunMsg = sentMessages.find((m: any) => m.type === 'autorun_state');
			expect(autoRunMsg).toBeDefined();
			expect(autoRunMsg.sessionId).toBe('session-1');
			expect(autoRunMsg.state.isRunning).toBe(true);
			expect(autoRunMsg.state.completedTasks).toBe(2);
			expect(autoRunMsg.state.totalTasks).toBe(5);
		});

		it('should not send autorun_state for non-running sessions', () => {
			(callbacks.getAutoRunStates as any).mockReturnValue(
				new Map([
					[
						'session-1',
						{
							isRunning: false,
							totalTasks: 5,
							completedTasks: 5,
						},
					],
				])
			);

			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			const sentMessages = (connection.send as any).mock.calls.map((call: any[]) =>
				JSON.parse(call[0])
			);

			const autoRunMsg = sentMessages.find((m: any) => m.type === 'autorun_state');
			expect(autoRunMsg).toBeUndefined();
		});
	});

	describe('Message Handling', () => {
		it('should delegate messages to handleMessage callback', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			// Simulate incoming message
			const message = JSON.stringify({ type: 'ping' });
			connection.emit('message', message);

			expect(callbacks.handleMessage).toHaveBeenCalledWith(expect.stringMatching(/^web-client-/), {
				type: 'ping',
			});
		});

		it('should send error for invalid JSON messages', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			// Clear previous sends
			(connection.send as any).mockClear();

			// Simulate invalid message
			connection.emit('message', 'not valid json');

			const lastSend = (connection.send as any).mock.calls[0];
			const errorMsg = JSON.parse(lastSend[0]);
			expect(errorMsg.type).toBe('error');
			expect(errorMsg.message).toBe('Invalid message format');
		});
	});

	describe('Disconnection Handling', () => {
		it('should notify parent on client disconnect', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			const clientId = (callbacks.onClientConnect as any).mock.calls[0][0].id;

			// Simulate close event
			connection.emit('close');

			expect(callbacks.onClientDisconnect).toHaveBeenCalledWith(clientId);
		});
	});

	describe('Error Handling', () => {
		it('should notify parent on client error', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			const clientId = (callbacks.onClientConnect as any).mock.calls[0][0].id;
			const error = new Error('Connection lost');

			// Simulate error event
			connection.emit('error', error);

			expect(callbacks.onClientError).toHaveBeenCalledWith(clientId, error);
		});
	});

	describe('Callback Resilience', () => {
		it('should handle missing callbacks gracefully', () => {
			const emptyWsRoute = new WsRoute(securityToken);
			// Don't set any callbacks
			const emptyFastify = createMockFastify();
			emptyWsRoute.registerRoute(emptyFastify as any);

			const route = emptyFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();

			// Should not throw
			expect(() => {
				route!.handler(connection, createMockRequest());
			}).not.toThrow();

			// Should still send connected message
			const sentMessages = (connection.send as any).mock.calls.map((call: any[]) =>
				JSON.parse(call[0])
			);
			const connectedMsg = sentMessages.find((m: any) => m.type === 'connected');
			expect(connectedMsg).toBeDefined();
		});

		it('should handle partial callbacks', () => {
			const partialWsRoute = new WsRoute(securityToken);
			partialWsRoute.setCallbacks({
				getSessions: vi.fn().mockReturnValue([]),
				getTheme: vi.fn().mockReturnValue(null),
				getCustomCommands: vi.fn().mockReturnValue([]),
				getAutoRunStates: vi.fn().mockReturnValue(new Map()),
				getLiveSessionInfo: vi.fn().mockReturnValue(undefined),
				isSessionLive: vi.fn().mockReturnValue(false),
				onClientConnect: vi.fn(),
				onClientDisconnect: vi.fn(),
				onClientError: vi.fn(),
				handleMessage: vi.fn(),
			});
			const partialFastify = createMockFastify();
			partialWsRoute.registerRoute(partialFastify as any);

			const route = partialFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();

			// Should not throw
			expect(() => {
				route!.handler(connection, createMockRequest());
			}).not.toThrow();
		});
	});

	describe('Multiple AutoRun States', () => {
		it('should send autorun_state for all running sessions', () => {
			(callbacks.getAutoRunStates as any).mockReturnValue(
				new Map([
					['session-1', { isRunning: true, totalTasks: 5, completedTasks: 2 }],
					['session-2', { isRunning: true, totalTasks: 3, completedTasks: 1 }],
					['session-3', { isRunning: false, totalTasks: 2, completedTasks: 2 }],
				])
			);

			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			const sentMessages = (connection.send as any).mock.calls.map((call: any[]) =>
				JSON.parse(call[0])
			);

			const autoRunMsgs = sentMessages.filter((m: any) => m.type === 'autorun_state');
			expect(autoRunMsgs).toHaveLength(2); // Only running sessions
			expect(autoRunMsgs.map((m: any) => m.sessionId)).toEqual(['session-1', 'session-2']);
		});
	});
});

describe('WsRoute bridge resume', () => {
	const securityToken = 'test-token-123';

	function setup(extra: Partial<WsRouteCallbacks>) {
		const route = new WsRoute(securityToken);
		const callbacks = { ...createMockCallbacks(), ...extra };
		route.setCallbacks(callbacks);
		const fastify = createMockFastify();
		route.registerRoute(fastify as any);
		return fastify.getRoute('GET', `/${securityToken}/ws`)!;
	}

	function sentFrames(connection: ReturnType<typeof createMockConnection>) {
		return (connection.send as any).mock.calls.map((call: any[]) => JSON.parse(call[0]));
	}

	function resumeRequest(query: string) {
		return { url: `/test-token/ws?${query}`, headers: { host: 'localhost:3000' } };
	}

	it('replays the missed frames right after `connected` when the client can be resumed', () => {
		const resumeBridgeClient = vi
			.fn()
			.mockReturnValue([
				JSON.stringify({ type: 'bridge.event', seq: 4 }),
				JSON.stringify({ type: 'bridge.event', seq: 5 }),
			]);
		const route = setup({ resumeBridgeClient, getBridgeEpoch: () => 'run-1' });

		const connection = createMockConnection();
		route.handler(connection, resumeRequest('since=3&epoch=run-1'));

		expect(resumeBridgeClient).toHaveBeenCalledWith('run-1', 3, undefined);
		const frames = sentFrames(connection);
		expect(frames[0]).toMatchObject({ type: 'connected', bridgeEpoch: 'run-1', resumed: true });
		expect(frames[1]).toMatchObject({ type: 'bridge.event', seq: 4 });
		expect(frames[2]).toMatchObject({ type: 'bridge.event', seq: 5 });
	});

	it('hands the client subscription to the replay so it is narrowed like a live send', () => {
		const resumeBridgeClient = vi.fn().mockReturnValue([]);
		const route = setup({ resumeBridgeClient, getBridgeEpoch: () => 'run-1' });

		const connection = createMockConnection();
		route.handler(connection, resumeRequest('since=3&epoch=run-1&sessionId=session-a'));

		expect(resumeBridgeClient).toHaveBeenCalledWith('run-1', 3, 'session-a');
	});

	it('reports resumed=false when the gap cannot be replayed, and never asks without a since', () => {
		const resumeBridgeClient = vi.fn().mockReturnValue(null);
		const route = setup({
			resumeBridgeClient,
			getBridgeEpoch: () => 'run-1',
			getBridgeSeq: () => 42,
		});

		const stale = createMockConnection();
		route.handler(stale, resumeRequest('since=3&epoch=run-0'));
		expect(resumeBridgeClient).toHaveBeenCalledWith('run-0', 3, undefined);
		expect(sentFrames(stale)[0]).toMatchObject({ type: 'connected', resumed: false });

		const fresh = createMockConnection();
		route.handler(fresh, createMockRequest());
		expect(resumeBridgeClient).toHaveBeenCalledTimes(1);
		// A fresh client is told where the counter stands so its first resume
		// asks for frames after THIS point, not after 0.
		expect(sentFrames(fresh)[0]).toMatchObject({
			type: 'connected',
			resumed: false,
			bridgeSeq: 42,
		});
	});
});

/**
 * The Web Login gate on the WebSocket upgrade.
 *
 * This is the enforcement point that matters most: the socket minted here can
 * invoke every registered ipcMain handler, so it IS the app. An unauthorized
 * upgrade must be closed before `onClientConnect`, or the client lands in
 * `webClients` and starts receiving every broadcast in the process.
 *
 * `maestro-cli` is admitted by the per-boot secret it presents as a header,
 * NOT by arriving over loopback: the Cloudflare tunnel and any local reverse
 * proxy deliver every remote request over 127.0.0.1 too, so an address-based
 * exemption would wave the whole internet through the moment Remote Control
 * was on.
 */
describe('WsRoute Web Login gate', () => {
	const securityToken = 'test-token-123';

	function setup() {
		const route = new WsRoute(securityToken);
		const callbacks = createMockCallbacks();
		route.setCallbacks(callbacks);
		const fastify = createMockFastify();
		route.registerRoute(fastify as any);
		return { route: fastify.getRoute('GET', `/${securityToken}/ws`)!, callbacks };
	}

	beforeEach(() => {
		webLogin.enabled = false;
		webLogin.sessions.clear();
	});

	it('accepts a maestro-cli upgrade carrying the boot secret while the gate is on', () => {
		webLogin.enabled = true;
		const { route, callbacks } = setup();
		const connection = createMockConnection();

		route.handler(
			connection,
			createMockRequest(undefined, {
				ip: '127.0.0.1',
				headers: { host: 'localhost:3000', [CLI_SECRET_HEADER]: getCliSecret() },
			})
		);

		expect(connection.close).not.toHaveBeenCalled();
		expect(callbacks.onClientConnect).toHaveBeenCalledTimes(1);
		// Admitted is not the same as signed in: a CLI caller acts as the desktop.
		expect((callbacks.onClientConnect as any).mock.calls[0][0].user).toBeUndefined();
	});

	it('closes a bare loopback upgrade: the tunnel arrives over loopback too', () => {
		webLogin.enabled = true;
		const { route, callbacks } = setup();
		const connection = createMockConnection();

		route.handler(connection, createMockRequest(undefined, { ip: '127.0.0.1' }));

		expect(connection.close).toHaveBeenCalledWith(WEB_LOGIN_WS_CLOSE_CODE, 'Login required');
		expect(callbacks.onClientConnect).not.toHaveBeenCalled();
	});

	it('closes a LAN upgrade with no cookie using the login close code', () => {
		webLogin.enabled = true;
		const { route, callbacks } = setup();
		const connection = createMockConnection();

		route.handler(connection, createMockRequest(undefined, { ip: '192.168.1.42' }));

		expect(connection.close).toHaveBeenCalledWith(WEB_LOGIN_WS_CLOSE_CODE, 'Login required');
		// Closed BEFORE the client exists anywhere: nothing can broadcast to it.
		expect(callbacks.onClientConnect).not.toHaveBeenCalled();
		expect(connection.send).not.toHaveBeenCalled();
	});

	it('accepts a LAN upgrade carrying a valid session and stamps the account on the client', () => {
		webLogin.enabled = true;
		webLogin.sessions.set('sid-1', { id: 'u1', username: 'ada', displayName: 'Ada' });
		const { route, callbacks } = setup();
		const connection = createMockConnection();

		route.handler(
			connection,
			createMockRequest(undefined, {
				ip: '192.168.1.42',
				headers: { host: 'localhost:3000', cookie: `${WEB_LOGIN_COOKIE}=sid-1` },
			})
		);

		expect(connection.close).not.toHaveBeenCalled();
		const client = (callbacks.onClientConnect as any).mock.calls[0][0];
		expect(client.user).toEqual({ id: 'u1', username: 'ada', displayName: 'Ada' });
		// Revocation is keyed on the session, so the client must remember it.
		expect(client.sessionId).toBe('sid-1');
	});

	it('leaves a LAN upgrade alone while the Encore flag is off', () => {
		const { route, callbacks } = setup();
		const connection = createMockConnection();

		route.handler(connection, createMockRequest(undefined, { ip: '192.168.1.42' }));

		expect(connection.close).not.toHaveBeenCalled();
		expect(callbacks.onClientConnect).toHaveBeenCalledTimes(1);
	});
});
