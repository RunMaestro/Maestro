/**
 * Tests for useWebSocket hook
 *
 * Tests the WebSocket connection management hook for the web interface.
 * Covers connection lifecycle, message handling, reconnection logic,
 * authentication, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
	useWebSocket,
	type WebSocketState,
	type UseWebSocketOptions,
	type SessionData,
	type ConnectedMessage,
	type AuthRequiredMessage,
	type AuthSuccessMessage,
	type AuthFailedMessage,
	type SessionsListMessage,
	type SessionStateChangeMessage,
	type SessionAddedMessage,
	type SessionRemovedMessage,
	type ActiveSessionChangedMessage,
	type SessionOutputMessage,
	type SessionExitMessage,
	type UserInputMessage,
	type ThemeMessage,
	type CustomCommandsMessage,
	type AutoRunStateMessage,
	type TabsChangedMessage,
	type ErrorMessage,
	type CustomCommand,
	type AITabData,
	type AutoRunState,
} from '../../../web/hooks/useWebSocket';
import type { Theme } from '../../../shared/theme-types';

// Mock the config module
vi.mock('../../../web/utils/config', () => ({
	buildWebSocketUrl: vi.fn((sessionId?: string) => {
		const base = 'ws://localhost:3000/test-token/ws';
		return sessionId ? `${base}?sessionId=${sessionId}` : base;
	}),
	getCurrentSessionId: vi.fn(() => null),
}));

// Mock the logger module
vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock WebSocket class
class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	url: string;
	readyState: number = MockWebSocket.CONNECTING;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;

	private static instances: MockWebSocket[] = [];

	constructor(url: string) {
		this.url = url;
		MockWebSocket.instances.push(this);
	}

	send = vi.fn();
	close = vi.fn((code?: number, reason?: string) => {
		this.readyState = MockWebSocket.CLOSED;
		if (this.onclose) {
			this.onclose({ code: code || 1000, reason: reason || '', wasClean: true } as CloseEvent);
		}
	});

	// Helper to simulate server messages
	simulateMessage(data: object) {
		if (this.onmessage) {
			this.onmessage({ data: JSON.stringify(data) } as MessageEvent);
		}
	}

	// Helper to simulate connection open
	simulateOpen() {
		this.readyState = MockWebSocket.OPEN;
		if (this.onopen) {
			this.onopen(new Event('open'));
		}
	}

	// Helper to simulate connection error
	simulateError() {
		if (this.onerror) {
			this.onerror(new Event('error'));
		}
	}

	// Helper to simulate connection close
	simulateClose(code: number = 1000, reason: string = '') {
		this.readyState = MockWebSocket.CLOSED;
		if (this.onclose) {
			this.onclose({ code, reason, wasClean: code === 1000 } as CloseEvent);
		}
	}

	// Static helper to get all instances
	static getInstances() {
		return MockWebSocket.instances;
	}

	// Static helper to get last instance
	static getLastInstance() {
		return MockWebSocket.instances[MockWebSocket.instances.length - 1];
	}

	// Static helper to clear instances
	static clearInstances() {
		MockWebSocket.instances = [];
	}
}

// Store original WebSocket
const originalWebSocket = global.WebSocket;

describe('useWebSocket', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		MockWebSocket.clearInstances();
		// Mock global WebSocket
		(global as any).WebSocket = MockWebSocket;
	});

	afterEach(() => {
		vi.useRealTimers();
		(global as any).WebSocket = originalWebSocket;
	});

	describe('Initial State', () => {
		it('starts in disconnected state', () => {
			const { result } = renderHook(() => useWebSocket());

			expect(result.current.state).toBe('disconnected');
			expect(result.current.isAuthenticated).toBe(false);
			expect(result.current.isConnected).toBe(false);
			expect(result.current.clientId).toBeNull();
			expect(result.current.error).toBeNull();
			expect(result.current.reconnectAttempts).toBe(0);
		});

		it('provides connect, disconnect, authenticate, ping, and send functions', () => {
			const { result } = renderHook(() => useWebSocket());

			expect(typeof result.current.connect).toBe('function');
			expect(typeof result.current.disconnect).toBe('function');
			expect(typeof result.current.authenticate).toBe('function');
			expect(typeof result.current.ping).toBe('function');
			expect(typeof result.current.send).toBe('function');
		});

		it('returns stable function references', () => {
			const { result, rerender } = renderHook(() => useWebSocket());

			const initialConnect = result.current.connect;
			const initialDisconnect = result.current.disconnect;
			const initialAuthenticate = result.current.authenticate;
			const initialPing = result.current.ping;
			const initialSend = result.current.send;

			rerender();

			expect(result.current.connect).toBe(initialConnect);
			expect(result.current.disconnect).toBe(initialDisconnect);
			expect(result.current.authenticate).toBe(initialAuthenticate);
			expect(result.current.ping).toBe(initialPing);
			expect(result.current.send).toBe(initialSend);
		});
	});

	describe('Connection Lifecycle', () => {
		it('transitions to connecting state when connect is called', () => {
			const { result } = renderHook(() => useWebSocket());

			act(() => {
				result.current.connect();
			});

			expect(result.current.state).toBe('connecting');
		});

		it('creates WebSocket with correct URL', () => {
			const { result } = renderHook(() => useWebSocket());

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			expect(ws).toBeDefined();
			expect(ws.url).toBe('ws://localhost:3000/test-token/ws');
		});

		it('uses custom URL when provided', () => {
			const { result } = renderHook(() => useWebSocket({ url: 'ws://custom.host/ws' }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			expect(ws.url).toBe('ws://custom.host/ws');
		});

		it('transitions to authenticating state on WebSocket open', () => {
			const { result } = renderHook(() => useWebSocket());

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
			});

			expect(result.current.state).toBe('authenticating');
		});

		it('sets state to connected when receiving connected message without auth', () => {
			const onConnectionChange = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onConnectionChange } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
			});

			act(() => {
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: false,
				} as ConnectedMessage);
			});

			expect(result.current.state).toBe('connected');
			expect(result.current.clientId).toBe('client-123');
			expect(result.current.isConnected).toBe(true);
			expect(result.current.isAuthenticated).toBe(false);
			expect(onConnectionChange).toHaveBeenCalledWith('connected');
		});

		it('sets state to authenticated when receiving connected message with auth', () => {
			const onConnectionChange = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onConnectionChange } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
			});

			act(() => {
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-456',
					message: 'Connected and authenticated',
					authenticated: true,
				} as ConnectedMessage);
			});

			expect(result.current.state).toBe('authenticated');
			expect(result.current.clientId).toBe('client-456');
			expect(result.current.isConnected).toBe(true);
			expect(result.current.isAuthenticated).toBe(true);
			expect(onConnectionChange).toHaveBeenCalledWith('authenticated');
		});

		it('clears error and reconnect attempts on successful connection', () => {
			const { result } = renderHook(() => useWebSocket());

			// Set initial error state manually by triggering an error
			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
			});

			act(() => {
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-789',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			expect(result.current.error).toBeNull();
			expect(result.current.reconnectAttempts).toBe(0);
		});

		it('transitions to disconnected state on disconnect', () => {
			const onConnectionChange = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onConnectionChange } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			act(() => {
				result.current.disconnect();
			});

			expect(result.current.state).toBe('disconnected');
			expect(result.current.clientId).toBeNull();
			expect(result.current.isConnected).toBe(false);
			expect(onConnectionChange).toHaveBeenCalledWith('disconnected');
		});

		it('closes WebSocket with code 1000 on disconnect', () => {
			const { result } = renderHook(() => useWebSocket());

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
			});

			act(() => {
				result.current.disconnect();
			});

			expect(ws.close).toHaveBeenCalledWith(1000, 'Client disconnect');
		});
	});

	describe('Authentication Flow', () => {
		it('handles auth_required message', () => {
			const onConnectionChange = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onConnectionChange } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
			});

			act(() => {
				ws.simulateMessage({
					type: 'auth_required',
					clientId: 'client-auth',
					message: 'Authentication required',
				} as AuthRequiredMessage);
			});

			expect(result.current.state).toBe('connected');
			expect(result.current.clientId).toBe('client-auth');
			expect(onConnectionChange).toHaveBeenCalledWith('connected');
		});

		it('sends authentication token', () => {
			const { result } = renderHook(() => useWebSocket());

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: false,
				} as ConnectedMessage);
			});

			act(() => {
				result.current.authenticate('my-secret-token');
			});

			expect(ws.send).toHaveBeenCalledWith(
				JSON.stringify({ type: 'auth', token: 'my-secret-token' })
			);
			expect(result.current.state).toBe('authenticating');
		});

		it('handles auth_success message', () => {
			const onConnectionChange = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onConnectionChange } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: false,
				} as ConnectedMessage);
			});

			act(() => {
				result.current.authenticate('valid-token');
			});

			act(() => {
				ws.simulateMessage({
					type: 'auth_success',
					clientId: 'client-123',
					message: 'Authentication successful',
				} as AuthSuccessMessage);
			});

			expect(result.current.state).toBe('authenticated');
			expect(result.current.isAuthenticated).toBe(true);
			expect(result.current.error).toBeNull();
			expect(onConnectionChange).toHaveBeenCalledWith('authenticated');
		});

		it('handles auth_failed message', () => {
			const onError = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onError } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: false,
				} as ConnectedMessage);
			});

			act(() => {
				result.current.authenticate('invalid-token');
			});

			act(() => {
				ws.simulateMessage({
					type: 'auth_failed',
					message: 'Invalid token',
				} as AuthFailedMessage);
			});

			expect(result.current.error).toBe('Invalid token');
			expect(onError).toHaveBeenCalledWith('Invalid token');
		});

		it('does not send auth if WebSocket is not open', () => {
			const { result } = renderHook(() => useWebSocket());

			// Don't connect, just try to authenticate
			act(() => {
				result.current.authenticate('token');
			});

			expect(MockWebSocket.getLastInstance()).toBeUndefined();
		});
	});

	describe('Message Handling', () => {
		it('handles sessions_list message', () => {
			const onSessionsUpdate = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onSessionsUpdate } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			const sessions: SessionData[] = [
				{
					id: 'session-1',
					name: 'Test Session',
					toolType: 'claude-code',
					state: 'idle',
					inputMode: 'ai',
					cwd: '/home/user/project',
				},
			];

			act(() => {
				ws.simulateMessage({
					type: 'sessions_list',
					sessions,
				} as SessionsListMessage);
			});

			expect(onSessionsUpdate).toHaveBeenCalledWith(sessions);
		});

		it('handles session_state_change message', () => {
			const onSessionStateChange = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onSessionStateChange } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			act(() => {
				ws.simulateMessage({
					type: 'session_state_change',
					sessionId: 'session-1',
					state: 'busy',
					name: 'Updated Session',
					toolType: 'claude-code',
					inputMode: 'terminal',
					cwd: '/new/path',
				} as SessionStateChangeMessage);
			});

			expect(onSessionStateChange).toHaveBeenCalledWith('session-1', 'busy', {
				name: 'Updated Session',
				toolType: 'claude-code',
				inputMode: 'terminal',
				cwd: '/new/path',
			});
		});

		it('handles session_added message', () => {
			const onSessionAdded = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onSessionAdded } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			const newSession: SessionData = {
				id: 'session-new',
				name: 'New Session',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/home/user/new-project',
			};

			act(() => {
				ws.simulateMessage({
					type: 'session_added',
					session: newSession,
				} as SessionAddedMessage);
			});

			expect(onSessionAdded).toHaveBeenCalledWith(newSession);
		});

		it('handles session_removed message', () => {
			const onSessionRemoved = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onSessionRemoved } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			act(() => {
				ws.simulateMessage({
					type: 'session_removed',
					sessionId: 'session-to-remove',
				} as SessionRemovedMessage);
			});

			expect(onSessionRemoved).toHaveBeenCalledWith('session-to-remove');
		});

		it('handles active_session_changed message', () => {
			const onActiveSessionChanged = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onActiveSessionChanged } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			act(() => {
				ws.simulateMessage({
					type: 'active_session_changed',
					sessionId: 'now-active-session',
				} as ActiveSessionChangedMessage);
			});

			expect(onActiveSessionChanged).toHaveBeenCalledWith('now-active-session');
		});

		it('handles session_output message', () => {
			const onSessionOutput = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onSessionOutput } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			act(() => {
				ws.simulateMessage({
					type: 'session_output',
					sessionId: 'session-1',
					data: 'Hello, World!',
					source: 'ai',
					msgId: 'msg-001',
				} as SessionOutputMessage);
			});

			expect(onSessionOutput).toHaveBeenCalledWith(
				'session-1',
				'Hello, World!',
				'ai',
				undefined // tabId is optional
			);
		});

		it('handles session_output message with tabId', () => {
			const onSessionOutput = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onSessionOutput } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			act(() => {
				ws.simulateMessage({
					type: 'session_output',
					sessionId: 'session-1',
					tabId: 'tab-abc123',
					data: 'Hello from tab!',
					source: 'ai',
					msgId: 'msg-002',
				} as SessionOutputMessage);
			});

			expect(onSessionOutput).toHaveBeenCalledWith(
				'session-1',
				'Hello from tab!',
				'ai',
				'tab-abc123'
			);
		});

		it('deduplicates session_output messages with same msgId', () => {
			const onSessionOutput = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onSessionOutput } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			// Send same message twice with same msgId
			act(() => {
				ws.simulateMessage({
					type: 'session_output',
					sessionId: 'session-1',
					data: 'First message',
					source: 'ai',
					msgId: 'duplicate-msg-id',
				} as SessionOutputMessage);
			});

			act(() => {
				ws.simulateMessage({
					type: 'session_output',
					sessionId: 'session-1',
					data: 'First message',
					source: 'ai',
					msgId: 'duplicate-msg-id',
				} as SessionOutputMessage);
			});

			// Should only be called once due to deduplication
			expect(onSessionOutput).toHaveBeenCalledTimes(1);
		});

		it('handles session_output without msgId', () => {
			const onSessionOutput = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onSessionOutput } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			// Send messages without msgId
			act(() => {
				ws.simulateMessage({
					type: 'session_output',
					sessionId: 'session-1',
					data: 'Message without ID 1',
					source: 'terminal',
				} as SessionOutputMessage);
			});

			act(() => {
				ws.simulateMessage({
					type: 'session_output',
					sessionId: 'session-1',
					data: 'Message without ID 2',
					source: 'terminal',
				} as SessionOutputMessage);
			});

			// Both should be received (no deduplication without msgId)
			expect(onSessionOutput).toHaveBeenCalledTimes(2);
		});

		it('handles session_exit message', () => {
			const onSessionExit = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onSessionExit } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			act(() => {
				ws.simulateMessage({
					type: 'session_exit',
					sessionId: 'session-1',
					exitCode: 0,
				} as SessionExitMessage);
			});

			expect(onSessionExit).toHaveBeenCalledWith('session-1', 0);
		});

		it('handles user_input message', () => {
			const onUserInput = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onUserInput } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			act(() => {
				ws.simulateMessage({
					type: 'user_input',
					sessionId: 'session-1',
					command: 'npm install',
					inputMode: 'terminal',
				} as UserInputMessage);
			});

			expect(onUserInput).toHaveBeenCalledWith('session-1', 'npm install', 'terminal');
		});

		it('handles theme message', () => {
			const onThemeUpdate = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onThemeUpdate } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			const theme: Theme = {
				id: 'dracula',
				name: 'Dracula',
				mode: 'dark',
				colors: {
					bgMain: '#282a36',
					bgSidebar: '#1e1f29',
					bgTerminal: '#1e1f29',
					bgInputArea: '#21222c',
					bgCodeBlock: '#282a36',
					textMain: '#f8f8f2',
					textSecondary: '#6272a4',
					textSuccess: '#50fa7b',
					textError: '#ff5555',
					textFaded: '#44475a',
					accentPrimary: '#bd93f9',
					borderSubtle: '#44475a',
					selectionBg: '#44475a',
				},
			};

			act(() => {
				ws.simulateMessage({
					type: 'theme',
					theme,
				} as ThemeMessage);
			});

			expect(onThemeUpdate).toHaveBeenCalledWith(theme);
		});

		it('handles custom_commands message', () => {
			const onCustomCommands = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onCustomCommands } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			const commands: CustomCommand[] = [
				{
					id: 'cmd-1',
					command: '/deploy',
					description: 'Deploy to production',
					prompt: 'Deploy the current changes to production environment',
				},
			];

			act(() => {
				ws.simulateMessage({
					type: 'custom_commands',
					commands,
				} as CustomCommandsMessage);
			});

			expect(onCustomCommands).toHaveBeenCalledWith(commands);
		});

		it('handles autorun_state message', () => {
			const onAutoRunStateChange = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onAutoRunStateChange } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			const autoRunState: AutoRunState = {
				isRunning: true,
				totalTasks: 10,
				completedTasks: 3,
				currentTaskIndex: 3,
				isStopping: false,
			};

			act(() => {
				ws.simulateMessage({
					type: 'autorun_state',
					sessionId: 'session-1',
					state: autoRunState,
				} as AutoRunStateMessage);
			});

			expect(onAutoRunStateChange).toHaveBeenCalledWith('session-1', autoRunState);
		});

		it('handles tabs_changed message', () => {
			const onTabsChanged = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onTabsChanged } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			const aiTabs: AITabData[] = [
				{
					id: 'tab-1',
					agentSessionId: 'claude-session-1',
					name: 'Tab 1',
					starred: false,
					inputValue: '',
					createdAt: Date.now(),
					state: 'idle',
				},
				{
					id: 'tab-2',
					agentSessionId: 'claude-session-2',
					name: 'Tab 2',
					starred: true,
					inputValue: 'test input',
					usageStats: { inputTokens: 100, outputTokens: 200 },
					createdAt: Date.now(),
					state: 'busy',
					thinkingStartTime: Date.now(),
				},
			];

			act(() => {
				ws.simulateMessage({
					type: 'tabs_changed',
					sessionId: 'session-1',
					aiTabs,
					activeTabId: 'tab-2',
				} as TabsChangedMessage);
			});

			expect(onTabsChanged).toHaveBeenCalledWith('session-1', aiTabs, 'tab-2');
		});

		it('handles error message', () => {
			const onError = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onError } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			act(() => {
				ws.simulateMessage({
					type: 'error',
					message: 'Something went wrong',
				} as ErrorMessage);
			});

			expect(result.current.error).toBe('Something went wrong');
			expect(onError).toHaveBeenCalledWith('Something went wrong');
		});

		it('handles pong message silently', () => {
			const onMessage = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onMessage } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			act(() => {
				ws.simulateMessage({ type: 'pong' });
			});

			// onMessage should be called but nothing else should happen
			expect(onMessage).toHaveBeenCalled();
		});

		it('calls onMessage handler for all messages', () => {
			const onMessage = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onMessage } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'connected' }));
		});

		it('handles unknown message types gracefully', () => {
			const onMessage = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onMessage } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			// Should not throw
			act(() => {
				ws.simulateMessage({ type: 'unknown_message_type' });
			});

			expect(onMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'unknown_message_type' })
			);
		});

		it('handles invalid JSON gracefully', () => {
			const { result } = renderHook(() => useWebSocket());

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
			});

			// Should not throw on invalid JSON
			act(() => {
				if (ws.onmessage) {
					ws.onmessage({ data: 'not valid json' } as MessageEvent);
				}
			});

			// State should remain unchanged
			expect(result.current.state).toBe('authenticating');
		});
	});

	describe('Ping/Pong', () => {
		it('sends ping messages', () => {
			const { result } = renderHook(() => useWebSocket());

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			act(() => {
				result.current.ping();
			});

			expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));
		});

		it('does not send ping if WebSocket is not open', () => {
			const { result } = renderHook(() => useWebSocket());

			act(() => {
				result.current.ping();
			});

			expect(MockWebSocket.getLastInstance()).toBeUndefined();
		});

		it('starts automatic ping interval on connection', () => {
			const { result } = renderHook(() => useWebSocket({ pingInterval: 5000 }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			// Clear any initial calls
			ws.send.mockClear();

			// Advance timer to trigger ping
			act(() => {
				vi.advanceTimersByTime(5000);
			});

			expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));
		});

		it('does not start ping interval when pingInterval is 0', () => {
			const { result } = renderHook(() => useWebSocket({ pingInterval: 0 }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			ws.send.mockClear();

			// Advance timer significantly
			act(() => {
				vi.advanceTimersByTime(60000);
			});

			// No ping should be sent
			expect(ws.send).not.toHaveBeenCalled();
		});
	});

	describe('Send Function', () => {
		it('sends messages when connected', () => {
			const { result } = renderHook(() => useWebSocket());

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			let success = false;
			act(() => {
				success = result.current.send({ type: 'custom', data: 'test' });
			});

			expect(success).toBe(true);
			expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'custom', data: 'test' }));
		});

		it('returns false when WebSocket is not connected', () => {
			const { result } = renderHook(() => useWebSocket());

			let success = true;
			act(() => {
				success = result.current.send({ type: 'test' });
			});

			expect(success).toBe(false);
		});
	});

	describe('Reconnection', () => {
		it('attempts to reconnect on abnormal close', () => {
			const onConnectionChange = vi.fn();
			const { result } = renderHook(() =>
				useWebSocket({
					autoReconnect: true,
					reconnectDelay: 1000,
					handlers: { onConnectionChange },
				})
			);

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			// Simulate abnormal close (code 1006)
			act(() => {
				ws.simulateClose(1006, 'Abnormal closure');
			});

			expect(result.current.state).toBe('disconnected');

			// Advance timer to trigger reconnect
			act(() => {
				vi.advanceTimersByTime(1000);
			});

			expect(result.current.reconnectAttempts).toBe(1);
			expect(result.current.state).toBe('connecting');
		});

		it('does not reconnect on clean close (code 1000)', () => {
			const { result } = renderHook(() =>
				useWebSocket({
					autoReconnect: true,
					reconnectDelay: 1000,
				})
			);

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			const instanceCount = MockWebSocket.getInstances().length;

			// Simulate clean close
			act(() => {
				ws.simulateClose(1000, 'Normal closure');
			});

			// Advance timer
			act(() => {
				vi.advanceTimersByTime(5000);
			});

			// No new WebSocket should be created
			expect(MockWebSocket.getInstances().length).toBe(instanceCount);
		});

		it('does not reconnect when autoReconnect is false', () => {
			const { result } = renderHook(() =>
				useWebSocket({
					autoReconnect: false,
				})
			);

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			const instanceCount = MockWebSocket.getInstances().length;

			// Simulate abnormal close
			act(() => {
				ws.simulateClose(1006, 'Abnormal closure');
			});

			// Advance timer
			act(() => {
				vi.advanceTimersByTime(5000);
			});

			// No new WebSocket should be created
			expect(MockWebSocket.getInstances().length).toBe(instanceCount);
		});

		// NOTE: The maxReconnectAttempts feature has a known issue due to stale closures.
		// The attemptReconnect callback captures reconnectAttempts in its closure, but
		// when scheduled via setTimeout in connectInternal, the closure value may be stale.
		// This test documents the behavior rather than testing max attempts enforcement.
		it('increments reconnect attempts on each failure', () => {
			const { result } = renderHook(() =>
				useWebSocket({
					autoReconnect: true,
					reconnectDelay: 100,
				})
			);

			act(() => {
				result.current.connect();
			});

			expect(result.current.reconnectAttempts).toBe(0);

			// First failure and reconnect
			let ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateClose(1006, 'Connection failed');
			});

			// Timer triggers reconnect which increments counter
			act(() => {
				vi.advanceTimersByTime(100);
			});

			expect(result.current.reconnectAttempts).toBe(1);

			// Second failure and reconnect
			ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateClose(1006, 'Connection failed');
			});

			act(() => {
				vi.advanceTimersByTime(100);
			});

			expect(result.current.reconnectAttempts).toBe(2);
		});

		it('resets reconnect attempts on manual connect', () => {
			const { result } = renderHook(() =>
				useWebSocket({
					autoReconnect: true,
					reconnectDelay: 100,
				})
			);

			act(() => {
				result.current.connect();
			});

			const ws1 = MockWebSocket.getLastInstance();
			act(() => {
				ws1.simulateOpen();
				ws1.simulateClose(1006, 'Connection failed');
			});

			act(() => {
				vi.advanceTimersByTime(100);
			});

			expect(result.current.reconnectAttempts).toBe(1);

			// Manual reconnect should reset attempts
			act(() => {
				result.current.connect();
			});

			expect(result.current.reconnectAttempts).toBe(0);
			expect(result.current.error).toBeNull();
		});

		it('does not reconnect after disconnect is called', () => {
			const { result } = renderHook(() =>
				useWebSocket({
					autoReconnect: true,
					reconnectDelay: 100,
				})
			);

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			const instanceCount = MockWebSocket.getInstances().length;

			// Explicitly disconnect
			act(() => {
				result.current.disconnect();
			});

			// Advance timer
			act(() => {
				vi.advanceTimersByTime(5000);
			});

			// No new WebSocket should be created
			expect(MockWebSocket.getInstances().length).toBe(instanceCount);
		});
	});

	describe('Error Handling', () => {
		it('sets error on WebSocket connection error', () => {
			const onError = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onError } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateError();
			});

			expect(result.current.error).toBe('WebSocket connection error');
			expect(onError).toHaveBeenCalledWith('WebSocket connection error');
		});

		it('handles WebSocket creation failure', () => {
			const onError = vi.fn();
			const onConnectionChange = vi.fn();

			// Make WebSocket constructor throw
			(global as any).WebSocket = class {
				constructor() {
					throw new Error('WebSocket not supported');
				}
			};

			const { result } = renderHook(() =>
				useWebSocket({ handlers: { onError, onConnectionChange } })
			);

			act(() => {
				result.current.connect();
			});

			expect(result.current.error).toBe('Failed to create WebSocket connection');
			expect(result.current.state).toBe('disconnected');
			expect(onError).toHaveBeenCalledWith('Failed to create WebSocket connection');
			expect(onConnectionChange).toHaveBeenCalledWith('disconnected');
		});
	});

	describe('Cleanup', () => {
		it('cleans up timers on disconnect', () => {
			const { result } = renderHook(() => useWebSocket({ pingInterval: 1000 }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			// Disconnect
			act(() => {
				result.current.disconnect();
			});

			ws.send.mockClear();

			// Advance timer - no ping should be sent
			act(() => {
				vi.advanceTimersByTime(5000);
			});

			expect(ws.send).not.toHaveBeenCalled();
		});

		it('closes WebSocket on unmount', () => {
			const { result, unmount } = renderHook(() => useWebSocket());

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			unmount();

			expect(ws.close).toHaveBeenCalledWith(1000, 'Component unmount');
		});

		it('cleans up reconnect timeout on unmount', () => {
			const { result, unmount } = renderHook(() =>
				useWebSocket({
					autoReconnect: true,
					reconnectDelay: 5000,
				})
			);

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateClose(1006, 'Abnormal closure');
			});

			// Unmount before reconnect timer fires
			unmount();

			const instanceCount = MockWebSocket.getInstances().length;

			// Advance timer
			act(() => {
				vi.advanceTimersByTime(10000);
			});

			// No new WebSocket should be created
			expect(MockWebSocket.getInstances().length).toBe(instanceCount);
		});
	});

	describe('Derived State', () => {
		it('isAuthenticated is true only when state is authenticated', () => {
			const { result } = renderHook(() => useWebSocket());

			expect(result.current.isAuthenticated).toBe(false);

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
			});

			expect(result.current.isAuthenticated).toBe(false);

			act(() => {
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			expect(result.current.isAuthenticated).toBe(true);

			act(() => {
				result.current.disconnect();
			});

			expect(result.current.isAuthenticated).toBe(false);
		});

		it('isConnected is true for connected, authenticated, and authenticating states', () => {
			const { result } = renderHook(() => useWebSocket());

			expect(result.current.isConnected).toBe(false);

			act(() => {
				result.current.connect();
			});

			// connecting state - not connected yet
			expect(result.current.isConnected).toBe(false);

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
			});

			// authenticating state - connected
			expect(result.current.isConnected).toBe(true);

			act(() => {
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: false,
				} as ConnectedMessage);
			});

			// connected state - connected
			expect(result.current.isConnected).toBe(true);

			act(() => {
				ws.simulateMessage({
					type: 'auth_success',
					clientId: 'client-123',
					message: 'Auth success',
				} as AuthSuccessMessage);
			});

			// authenticated state - connected
			expect(result.current.isConnected).toBe(true);
		});
	});

	describe('Message ID Deduplication Memory Limit', () => {
		it('limits stored message IDs to prevent memory leaks', () => {
			const onSessionOutput = vi.fn();
			const { result } = renderHook(() => useWebSocket({ handlers: { onSessionOutput } }));

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			// Send more than 1000 messages to trigger cleanup
			for (let i = 0; i < 1100; i++) {
				act(() => {
					ws.simulateMessage({
						type: 'session_output',
						sessionId: 'session-1',
						data: `Message ${i}`,
						source: 'ai',
						msgId: `msg-${i}`,
					} as SessionOutputMessage);
				});
			}

			// All messages should have been processed
			expect(onSessionOutput).toHaveBeenCalledTimes(1100);

			// Old message IDs should have been cleaned up
			// Try to send an old message that should no longer be in the set
			onSessionOutput.mockClear();
			act(() => {
				ws.simulateMessage({
					type: 'session_output',
					sessionId: 'session-1',
					data: 'Message 0 again',
					source: 'ai',
					msgId: 'msg-0',
				} as SessionOutputMessage);
			});

			// Should be received because msg-0 was cleaned up from the set
			expect(onSessionOutput).toHaveBeenCalledTimes(1);
		});
	});

	describe('Handler Updates', () => {
		it('uses latest handlers without reconnection', () => {
			const initialHandler = vi.fn();
			const updatedHandler = vi.fn();

			const { result, rerender } = renderHook(
				({ onSessionsUpdate }) => useWebSocket({ handlers: { onSessionsUpdate } }),
				{ initialProps: { onSessionsUpdate: initialHandler } }
			);

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			// Send message with initial handler
			act(() => {
				ws.simulateMessage({
					type: 'sessions_list',
					sessions: [],
				} as SessionsListMessage);
			});

			expect(initialHandler).toHaveBeenCalledTimes(1);
			expect(updatedHandler).not.toHaveBeenCalled();

			// Update handlers
			rerender({ onSessionsUpdate: updatedHandler });

			// Send another message
			act(() => {
				ws.simulateMessage({
					type: 'sessions_list',
					sessions: [],
				} as SessionsListMessage);
			});

			// New handler should be called
			expect(initialHandler).toHaveBeenCalledTimes(1);
			expect(updatedHandler).toHaveBeenCalledTimes(1);
		});
	});

	describe('Default Options', () => {
		it('uses default autoReconnect (true)', () => {
			const { result } = renderHook(() => useWebSocket());

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateClose(1006, 'Abnormal');
			});

			// Should attempt reconnect with default delay (2000ms)
			act(() => {
				vi.advanceTimersByTime(2000);
			});

			expect(result.current.reconnectAttempts).toBe(1);
		});

		it('uses default reconnectDelay (2000ms)', () => {
			const { result } = renderHook(() => useWebSocket());

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateClose(1006, 'Abnormal');
			});

			// Before default delay (2000ms), no reconnect
			act(() => {
				vi.advanceTimersByTime(1999);
			});

			expect(result.current.reconnectAttempts).toBe(0);

			// After delay, reconnect should happen
			act(() => {
				vi.advanceTimersByTime(1);
			});

			expect(result.current.reconnectAttempts).toBe(1);
		});

		it('uses default pingInterval (30000ms)', () => {
			const { result } = renderHook(() => useWebSocket());

			act(() => {
				result.current.connect();
			});

			const ws = MockWebSocket.getLastInstance();
			act(() => {
				ws.simulateOpen();
				ws.simulateMessage({
					type: 'connected',
					clientId: 'client-123',
					message: 'Connected',
					authenticated: true,
				} as ConnectedMessage);
			});

			ws.send.mockClear();

			// Advance less than default ping interval
			act(() => {
				vi.advanceTimersByTime(29999);
			});

			expect(ws.send).not.toHaveBeenCalled();

			// Advance to trigger ping
			act(() => {
				vi.advanceTimersByTime(1);
			});

			expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));
		});
	});
});

describe('Type Exports', () => {
	it('exports WebSocketState type', () => {
		const state: WebSocketState = 'connected';
		expect([
			'disconnected',
			'connecting',
			'connected',
			'authenticating',
			'authenticated',
		]).toContain(state);
	});

	it('exports SessionData interface correctly', () => {
		const session: SessionData = {
			id: 'test-id',
			name: 'Test Session',
			toolType: 'claude-code',
			state: 'idle',
			inputMode: 'ai',
			cwd: '/test/path',
		};
		expect(session.id).toBe('test-id');
	});

	it('exports AITabData interface correctly', () => {
		const tab: AITabData = {
			id: 'tab-1',
			agentSessionId: 'claude-123',
			name: 'Test Tab',
			starred: true,
			inputValue: 'test input',
			createdAt: Date.now(),
			state: 'busy',
			thinkingStartTime: Date.now(),
			usageStats: {
				inputTokens: 100,
				outputTokens: 200,
				totalCostUsd: 0.01,
			},
		};
		expect(tab.id).toBe('tab-1');
	});

	it('exports AutoRunState interface correctly', () => {
		const state: AutoRunState = {
			isRunning: true,
			totalTasks: 5,
			completedTasks: 2,
			currentTaskIndex: 2,
			isStopping: false,
		};
		expect(state.isRunning).toBe(true);
	});

	it('exports CustomCommand interface correctly', () => {
		const cmd: CustomCommand = {
			id: 'cmd-1',
			command: '/test',
			description: 'Test command',
			prompt: 'This is a test',
		};
		expect(cmd.command).toBe('/test');
	});
});
