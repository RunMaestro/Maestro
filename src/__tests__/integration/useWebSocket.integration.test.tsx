import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWebSocket, type WebSocketEventHandlers } from '../../web/hooks/useWebSocket';
import { webLogger } from '../../web/utils/logger';

vi.mock('../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	readyState = MockWebSocket.CONNECTING;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	sent: string[] = [];
	closeCalls: Array<{ code?: number; reason?: string }> = [];

	constructor(readonly url: string) {
		if (MockWebSocket.failNextConstructor) {
			MockWebSocket.failNextConstructor = false;
			throw new Error('constructor failed');
		}
		MockWebSocket.instances.push(this);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close(code?: number, reason?: string) {
		this.closeCalls.push({ code, reason });
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({
			code: code ?? 1000,
			reason: reason ?? '',
			wasClean: (code ?? 1000) === 1000,
		} as CloseEvent);
	}

	open() {
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.(new Event('open'));
	}

	error() {
		this.onerror?.(new Event('error'));
	}

	serverClose(code = 1006) {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code, reason: 'server closed', wasClean: code === 1000 } as CloseEvent);
	}

	message(data: object | string) {
		const payload = typeof data === 'string' ? data : JSON.stringify(data);
		this.onmessage?.({ data: payload } as MessageEvent);
	}

	static instances: MockWebSocket[] = [];
	static failNextConstructor = false;
}

function createHandlers(): Required<WebSocketEventHandlers> {
	return {
		onSessionsUpdate: vi.fn(),
		onSessionStateChange: vi.fn(),
		onSessionAdded: vi.fn(),
		onSessionRemoved: vi.fn(),
		onActiveSessionChanged: vi.fn(),
		onSessionOutput: vi.fn(),
		onSessionExit: vi.fn(),
		onUserInput: vi.fn(),
		onThemeUpdate: vi.fn(),
		onBionifyReadingModeUpdate: vi.fn(),
		onCustomCommands: vi.fn(),
		onAutoRunStateChange: vi.fn(),
		onTabsChanged: vi.fn(),
		onConnectionChange: vi.fn(),
		onError: vi.fn(),
		onMessage: vi.fn(),
	};
}

describe('useWebSocket integration', () => {
	let originalWebSocket: typeof WebSocket;

	beforeEach(() => {
		vi.clearAllMocks();
		MockWebSocket.instances = [];
		MockWebSocket.failNextConstructor = false;
		originalWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		window.__MAESTRO_CONFIG__ = {
			securityToken: 'token-123',
			sessionId: 'session-from-config',
			tabId: null,
			apiBase: '/token-123/api',
			wsUrl: '/token-123/ws',
		};
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.WebSocket = originalWebSocket;
		delete window.__MAESTRO_CONFIG__;
		vi.restoreAllMocks();
	});

	it('connects, authenticates, sends commands, and cleans up the socket', async () => {
		vi.useFakeTimers();
		const handlers = createHandlers();
		const { result, unmount } = renderHook(() =>
			useWebSocket({
				url: 'ws://maestro.test/ws',
				pingInterval: 250,
				handlers,
			})
		);

		expect(result.current.state).toBe('disconnected');
		expect(result.current.send({ type: 'before-open' })).toBe(false);
		expect(webLogger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Cannot send'),
			'WebSocket'
		);

		act(() => result.current.connect());
		expect(MockWebSocket.instances[0].url).toBe('ws://maestro.test/ws');
		expect(result.current.state).toBe('connecting');
		expect(handlers.onConnectionChange).toHaveBeenCalledWith('connecting');

		act(() => MockWebSocket.instances[0].open());
		expect(result.current.state).toBe('authenticating');

		act(() =>
			MockWebSocket.instances[0].message({
				type: 'connected',
				clientId: 'client-1',
				message: 'connected',
				authenticated: false,
			})
		);
		expect(result.current.clientId).toBe('client-1');
		expect(result.current.state).toBe('connected');

		act(() => result.current.authenticate('secret-token'));
		expect(MockWebSocket.instances[0].sent.at(-1)).toBe(
			JSON.stringify({ type: 'auth', token: 'secret-token' })
		);
		expect(result.current.state).toBe('authenticating');

		act(() =>
			MockWebSocket.instances[0].message({
				type: 'auth_success',
				clientId: 'client-1',
				message: 'ok',
			})
		);
		expect(result.current.isAuthenticated).toBe(true);
		expect(result.current.isConnected).toBe(true);

		expect(result.current.send({ type: 'subscribe', sessionId: 'session-1' })).toBe(true);
		act(() => result.current.ping());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(250);
		});
		expect(MockWebSocket.instances[0].sent).toContain(JSON.stringify({ type: 'ping' }));

		act(() => result.current.disconnect());
		expect(MockWebSocket.instances[0].closeCalls.at(-1)).toEqual({
			code: 1000,
			reason: 'Client disconnect',
		});
		expect(result.current.state).toBe('disconnected');

		unmount();
	});

	it('routes typed server messages and deduplicates repeated session output', async () => {
		const handlers = createHandlers();
		const { result } = renderHook(() =>
			useWebSocket({ url: 'ws://maestro.test/ws', pingInterval: 0, handlers })
		);
		act(() => result.current.connect());
		const socket = MockWebSocket.instances[0];

		act(() => {
			socket.open();
			socket.message({ type: 'connected', clientId: 'client-1', authenticated: true });
			socket.message({
				type: 'sessions_list',
				sessions: [{ id: 'session-1', name: 'Planning' }],
			});
			socket.message({
				type: 'session_state_change',
				sessionId: 'session-1',
				state: 'busy',
				name: 'Planning',
				toolType: 'claude-code',
				inputMode: 'ai',
				cwd: '/workspace',
			});
			socket.message({ type: 'session_added', session: { id: 'session-2', name: 'New' } });
			socket.message({ type: 'session_removed', sessionId: 'session-2' });
			socket.message({ type: 'active_session_changed', sessionId: 'session-1' });
			socket.message({
				type: 'session_output',
				sessionId: 'session-1',
				tabId: 'tab-1',
				data: 'hello',
				source: 'ai',
				msgId: 'msg-1',
			});
			socket.message({
				type: 'session_output',
				sessionId: 'session-1',
				tabId: 'tab-1',
				data: 'duplicate',
				source: 'ai',
				msgId: 'msg-1',
			});
			socket.message({ type: 'session_exit', sessionId: 'session-1', exitCode: 0 });
			socket.message({
				type: 'user_input',
				sessionId: 'session-1',
				command: 'npm test',
				inputMode: 'terminal',
			});
			socket.message({ type: 'theme', theme: { id: 'custom', colors: {} } });
			socket.message({ type: 'bionify_reading_mode', enabled: true });
			socket.message({
				type: 'custom_commands',
				commands: [{ id: 'cmd-1', command: '/commit', description: 'Commit', prompt: 'commit' }],
			});
			socket.message({
				type: 'autorun_state',
				sessionId: 'session-1',
				state: { isRunning: true, totalTasks: 3, completedTasks: 1, currentTaskIndex: 1 },
			});
			socket.message({
				type: 'tabs_changed',
				sessionId: 'session-1',
				aiTabs: [{ id: 'tab-1', agentSessionId: null, name: null, starred: false }],
				activeTabId: 'tab-1',
			});
			socket.message({ type: 'error', message: 'server error' });
			socket.message({ type: 'pong' });
			socket.message({ type: 'unknown_type' });
			socket.message('{bad json');
		});

		await waitFor(() => {
			expect(result.current.state).toBe('authenticated');
			expect(result.current.error).toBe('server error');
		});
		expect(handlers.onSessionsUpdate).toHaveBeenCalledWith([{ id: 'session-1', name: 'Planning' }]);
		expect(handlers.onSessionStateChange).toHaveBeenCalledWith('session-1', 'busy', {
			name: 'Planning',
			toolType: 'claude-code',
			inputMode: 'ai',
			cwd: '/workspace',
		});
		expect(handlers.onSessionAdded).toHaveBeenCalledWith({ id: 'session-2', name: 'New' });
		expect(handlers.onSessionRemoved).toHaveBeenCalledWith('session-2');
		expect(handlers.onActiveSessionChanged).toHaveBeenCalledWith('session-1');
		expect(handlers.onSessionOutput).toHaveBeenCalledTimes(1);
		expect(handlers.onSessionOutput).toHaveBeenCalledWith('session-1', 'hello', 'ai', 'tab-1');
		expect(handlers.onSessionExit).toHaveBeenCalledWith('session-1', 0);
		expect(handlers.onUserInput).toHaveBeenCalledWith('session-1', 'npm test', 'terminal');
		expect(handlers.onThemeUpdate).toHaveBeenCalledWith({ id: 'custom', colors: {} });
		expect(handlers.onBionifyReadingModeUpdate).toHaveBeenCalledWith(true);
		expect(handlers.onCustomCommands).toHaveBeenCalledWith([
			{ id: 'cmd-1', command: '/commit', description: 'Commit', prompt: 'commit' },
		]);
		expect(handlers.onAutoRunStateChange).toHaveBeenCalledWith('session-1', {
			isRunning: true,
			totalTasks: 3,
			completedTasks: 1,
			currentTaskIndex: 1,
		});
		expect(handlers.onTabsChanged).toHaveBeenCalledWith(
			'session-1',
			[{ id: 'tab-1', agentSessionId: null, name: null, starred: false }],
			'tab-1'
		);
		expect(handlers.onError).toHaveBeenCalledWith('server error');
		expect(handlers.onMessage).toHaveBeenCalled();
		expect(webLogger.error).toHaveBeenCalledWith(
			'Failed to parse WebSocket message',
			'WebSocket',
			expect.any(SyntaxError)
		);
		expect(webLogger.debug).toHaveBeenCalledWith(
			'DEDUPE: Skipping duplicate session_output msgId=msg-1',
			'WebSocket'
		);
	});

	it('uses config URL fallback and reconnects after an unclean close', async () => {
		vi.useFakeTimers();
		const handlers = createHandlers();
		const { result } = renderHook(() =>
			useWebSocket({
				reconnectDelay: 50,
				pingInterval: 0,
				handlers,
			})
		);

		act(() => result.current.connect());
		expect(MockWebSocket.instances[0].url).toContain('/token-123/ws?sessionId=session-from-config');

		act(() => MockWebSocket.instances[0].serverClose(1006));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(50);
		});

		expect(result.current.reconnectAttempts).toBe(1);
		expect(MockWebSocket.instances).toHaveLength(2);
		expect(handlers.onConnectionChange).toHaveBeenCalledWith('disconnected');
	});

	it('reports connection failures and stops when reconnect attempts are exhausted', async () => {
		const handlers = createHandlers();
		MockWebSocket.failNextConstructor = true;

		const failedConnect = renderHook(() =>
			useWebSocket({ url: 'ws://bad.test/ws', pingInterval: 0, handlers })
		);
		act(() => failedConnect.result.current.connect());

		await waitFor(() => {
			expect(failedConnect.result.current.error).toBe('Failed to create WebSocket connection');
			expect(failedConnect.result.current.state).toBe('disconnected');
		});
		expect(handlers.onError).toHaveBeenCalledWith('Failed to create WebSocket connection');

		const maxedHandlers = createHandlers();
		const maxedConnect = renderHook(() =>
			useWebSocket({
				url: 'ws://maestro.test/ws',
				pingInterval: 0,
				maxReconnectAttempts: 0,
				handlers: maxedHandlers,
			})
		);
		act(() => maxedConnect.result.current.connect());
		act(() => MockWebSocket.instances.at(-1)!.error());
		expect(maxedHandlers.onError).toHaveBeenCalledWith('WebSocket connection error');

		act(() => MockWebSocket.instances.at(-1)!.serverClose(1006));
		await waitFor(() => {
			expect(maxedConnect.result.current.error).toBe('Failed to connect after 0 attempts');
		});
		expect(maxedHandlers.onError).toHaveBeenCalledWith('Failed to connect after 0 attempts');
	});
});
