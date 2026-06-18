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

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
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
 * Create mock Fastify connection
 */
function createMockConnection() {
	return {
		socket: createMockSocket(),
	};
}

/**
 * Create mock Fastify request
 */
function createMockRequest(sessionId?: string) {
	const queryString = sessionId ? `?sessionId=${sessionId}` : '';
	return {
		url: `/test-token/ws${queryString}`,
		headers: {
			host: 'localhost:3000',
		},
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
					socket: connection.socket,
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

			const sentMessages = (connection.socket.send as any).mock.calls.map((call: any[]) =>
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

			const sentMessages = (connection.socket.send as any).mock.calls.map((call: any[]) =>
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

			const sentMessages = (connection.socket.send as any).mock.calls.map((call: any[]) =>
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

			const sentMessages = (connection.socket.send as any).mock.calls.map((call: any[]) =>
				JSON.parse(call[0])
			);

			const themeMsg = sentMessages.find((m: any) => m.type === 'theme');
			expect(themeMsg).toBeUndefined();
		});

		it('should send custom_commands', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			const sentMessages = (connection.socket.send as any).mock.calls.map((call: any[]) =>
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

			const sentMessages = (connection.socket.send as any).mock.calls.map((call: any[]) =>
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

			const sentMessages = (connection.socket.send as any).mock.calls.map((call: any[]) =>
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
			connection.socket.emit('message', message);

			expect(callbacks.handleMessage).toHaveBeenCalledWith(expect.stringMatching(/^web-client-/), {
				type: 'ping',
			});
		});

		it('should send error for invalid JSON messages', () => {
			const route = mockFastify.getRoute('GET', `/${securityToken}/ws`);
			const connection = createMockConnection();
			route!.handler(connection, createMockRequest());

			// Clear previous sends
			(connection.socket.send as any).mockClear();

			// Simulate invalid message
			connection.socket.emit('message', 'not valid json');

			const lastSend = (connection.socket.send as any).mock.calls[0];
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
			connection.socket.emit('close');

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
			connection.socket.emit('error', error);

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
			const sentMessages = (connection.socket.send as any).mock.calls.map((call: any[]) =>
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

			const sentMessages = (connection.socket.send as any).mock.calls.map((call: any[]) =>
				JSON.parse(call[0])
			);

			const autoRunMsgs = sentMessages.filter((m: any) => m.type === 'autorun_state');
			expect(autoRunMsgs).toHaveLength(2); // Only running sessions
			expect(autoRunMsgs.map((m: any) => m.sessionId)).toEqual(['session-1', 'session-2']);
		});
	});
});
