/**
 * useMaestroWebSocket - M1 WebSocket hook for Maestro mobile
 *
 * A simplified WebSocket hook that connects to the Maestro desktop app
 * and handles the core message types needed for M1 chat functionality.
 *
 * This is a local implementation to avoid cross-tree import resolution issues.
 * For full desktop web interface, see src/web/hooks/useWebSocket.ts
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { buildWebSocketUrl } from '../../shims/config';
import type { Theme } from '@maestro/shared/theme-types';

// ============================================================================
// Types
// ============================================================================

export type WebSocketState = 'disconnected' | 'connecting' | 'connected' | 'authenticated';

/**
 * AI Tab data for multi-tab support within a Maestro session
 */
export interface AITabData {
	id: string;
	agentSessionId: string | null;
	name: string | null;
	starred: boolean;
	inputValue: string;
	createdAt: number;
	state: 'idle' | 'busy';
	thinkingStartTime?: number | null;
	hasUnread?: boolean;
}

export interface SessionData {
	id: string;
	name: string;
	toolType: string;
	state: string;
	inputMode: string;
	cwd: string;
	aiTabs?: AITabData[];
	activeTabId?: string;
}

export interface ToolEventLog {
	id: string;
	timestamp: number;
	source: 'tool';
	text: string;
	metadata?: {
		toolState?: {
			name: string;
			status: 'running' | 'completed' | 'error';
		};
	};
}

/**
 * Single message from a `get_session_history` response. Matches the desktop's
 * `SessionHistoryMessage` shape in `src/main/web-server/types.ts` and is the
 * payload the CLI's `session show` command consumes.
 */
export interface SessionHistoryMessage {
	id: string;
	role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking' | 'error' | 'unknown';
	source: string;
	content: string;
	/** ISO-8601 timestamp. */
	timestamp: string;
}

export interface SessionHistoryResult {
	tabId: string;
	sessionId: string;
	agentId: string;
	agentSessionId: string | null;
	messages: SessionHistoryMessage[];
}

export interface WebSocketHandlers {
	onConnectionChange?: (state: WebSocketState) => void;
	onSessionsUpdate?: (sessions: SessionData[]) => void;
	/**
	 * Fired when the desktop creates a new agent. The desktop broadcasts an
	 * incremental `session_added` rather than resending the full `sessions_list`,
	 * so without this the mobile sidebar never sees agents created after connect.
	 */
	onSessionAdded?: (session: SessionData) => void;
	/** Fired when the desktop removes an agent (incremental `session_removed`). */
	onSessionRemoved?: (sessionId: string) => void;
	onSessionStateChange?: (sessionId: string, state: string) => void;
	onSessionOutput?: (
		sessionId: string,
		data: string,
		source: 'ai' | 'terminal',
		tabId?: string
	) => void;
	/**
	 * Fired when the desktop signals a session has finished its current turn.
	 * Used as a fallback turn-complete signal when session_state_change is not
	 * emitted for the active code path. `tabId` is the AI tab that exited when
	 * the desktop includes it, so multi-tab screens can ignore exits for tabs
	 * other than the one the user is looking at.
	 */
	onSessionExit?: (sessionId: string, tabId?: string) => void;
	onToolEvent?: (sessionId: string, tabId: string, toolLog: ToolEventLog) => void;
	onUserInput?: (sessionId: string, command: string, inputMode: 'ai' | 'terminal') => void;
	/**
	 * Fired when the desktop acknowledges a `send_command`. `success` is false
	 * when the desktop rejected the command (e.g. the session was busy or has
	 * been removed), so the UI can roll back an optimistic "generating" state
	 * instead of waiting forever for output that will never arrive.
	 */
	onCommandResult?: (sessionId: string, success: boolean, tabId?: string) => void;
	onTabsChanged?: (sessionId: string, aiTabs: AITabData[], activeTabId: string) => void;
	/**
	 * Fired when the desktop acknowledges a `new_tab` request with success. The
	 * desktop also emits `tabs_changed` (via its live-broadcast poll), but that
	 * can lag or be gated, so this lets the client optimistically add the new tab
	 * immediately. The later `tabs_changed`/reconnect reconciles authoritatively.
	 */
	onTabCreated?: (sessionId: string, tabId: string) => void;
	/**
	 * Fired when the desktop acknowledges a `close_tab` request with success.
	 * Lets the client optimistically drop the tab without waiting on the
	 * (possibly gated) `tabs_changed` broadcast. Reconciles on the next
	 * `tabs_changed`/reconnect.
	 */
	onTabClosed?: (sessionId: string, tabId: string) => void;
	/** Called when theme is received or updated from Maestro desktop */
	onThemeUpdate?: (theme: Theme) => void;
	onError?: (error: string) => void;
	/**
	 * Fired when the desktop rejects the stored token (revoked, expired, or
	 * never paired). After this fires, the hook stops auto-reconnecting so a
	 * stale token can't loop. Callers should clear credentials and route the
	 * user back to pairing.
	 */
	onAuthFailed?: (reason: string) => void;
}

export interface UseMaestroWebSocketOptions {
	autoReconnect?: boolean;
	handlers?: WebSocketHandlers;
}

export interface UseMaestroWebSocketReturn {
	state: WebSocketState;
	isAuthenticated: boolean;
	error: string | null;
	connect: () => void;
	disconnect: () => void;
	send: (message: object) => boolean;
	/**
	 * Request the conversation backlog for a tab. Resolves with the messages
	 * (oldest first) so callers can seed their local message list before any
	 * streaming events arrive. Rejects if the socket isn't open or the desktop
	 * returns an error.
	 */
	requestSessionHistory: (
		tabId: string,
		options?: { sinceMs?: number; tail?: number; timeoutMs?: number }
	) => Promise<SessionHistoryResult>;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useMaestroWebSocket(
	options: UseMaestroWebSocketOptions = {}
): UseMaestroWebSocketReturn {
	const { autoReconnect = true, handlers } = options;

	const [state, setState] = useState<WebSocketState>('disconnected');
	const [error, setError] = useState<string | null>(null);

	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const handlersRef = useRef(handlers);
	const shouldReconnectRef = useRef(true);
	const reconnectAttemptsRef = useRef(0);
	// In-flight connect guard. AppState/NetInfo/mount effects can all call
	// connect() during the credential-loading await window, before wsRef is set.
	// Without this guard two sockets could open concurrently and the older one's
	// onclose would clear wsRef even when the newer socket is the active one.
	const connectInFlightRef = useRef(false);

	// In-flight `get_session_history` requests, keyed by requestId. The desktop
	// echoes the same requestId in `session_history_result`, so we resolve the
	// matching promise on arrival. A reconnect rejects every pending entry.
	const pendingHistoryRequestsRef = useRef(
		new Map<
			string,
			{
				resolve: (result: SessionHistoryResult) => void;
				reject: (error: Error) => void;
				timeoutId: ReturnType<typeof setTimeout>;
			}
		>()
	);

	// Keep handlers ref up to date
	handlersRef.current = handlers;

	const clearTimers = useCallback(() => {
		if (reconnectTimeoutRef.current) {
			clearTimeout(reconnectTimeoutRef.current);
			reconnectTimeoutRef.current = null;
		}
	}, []);

	const handleMessage = useCallback((event: MessageEvent) => {
		try {
			const message = JSON.parse(event.data);

			switch (message.type) {
				case 'connected':
					if (message.authenticated) {
						setState('authenticated');
						handlersRef.current?.onConnectionChange?.('authenticated');
					} else {
						setState('connected');
						handlersRef.current?.onConnectionChange?.('connected');
					}
					setError(null);
					reconnectAttemptsRef.current = 0;
					break;

				case 'auth_success':
					setState('authenticated');
					handlersRef.current?.onConnectionChange?.('authenticated');
					break;

				case 'auth_failed':
					setError(message.message);
					shouldReconnectRef.current = false;
					handlersRef.current?.onError?.(message.message);
					handlersRef.current?.onAuthFailed?.(message.message || 'Authentication failed');
					break;

				case 'sessions_list':
					handlersRef.current?.onSessionsUpdate?.(message.sessions);
					break;

				case 'session_added':
					handlersRef.current?.onSessionAdded?.(message.session);
					break;

				case 'session_removed':
					handlersRef.current?.onSessionRemoved?.(message.sessionId);
					break;

				case 'session_state_change':
					handlersRef.current?.onSessionStateChange?.(message.sessionId, message.state);
					break;

				case 'session_output':
					handlersRef.current?.onSessionOutput?.(
						message.sessionId,
						message.data,
						message.source,
						message.tabId
					);
					break;

				case 'session_exit':
					handlersRef.current?.onSessionExit?.(message.sessionId, message.tabId);
					break;

				case 'command_result':
					handlersRef.current?.onCommandResult?.(
						message.sessionId,
						message.success !== false,
						message.tabId
					);
					break;

				case 'tool_event':
					handlersRef.current?.onToolEvent?.(message.sessionId, message.tabId, message.toolLog);
					break;

				case 'user_input':
					handlersRef.current?.onUserInput?.(message.sessionId, message.command, message.inputMode);
					break;

				case 'tabs_changed':
					handlersRef.current?.onTabsChanged?.(
						message.sessionId,
						message.aiTabs,
						message.activeTabId
					);
					break;

				case 'new_tab_result':
					if (message.success && typeof message.tabId === 'string') {
						handlersRef.current?.onTabCreated?.(message.sessionId, message.tabId);
					}
					break;

				case 'close_tab_result':
					if (message.success && typeof message.tabId === 'string') {
						handlersRef.current?.onTabClosed?.(message.sessionId, message.tabId);
					}
					break;

				case 'error':
					setError(message.message);
					if (message.code === 'AUTH_FAILED') {
						shouldReconnectRef.current = false;
						handlersRef.current?.onAuthFailed?.(message.message || 'Authentication failed');
					}
					handlersRef.current?.onError?.(message.message);
					break;

				case 'theme':
					// Theme update from Maestro desktop (per decision 5C)
					handlersRef.current?.onThemeUpdate?.(message.theme);
					break;

				case 'session_history_result': {
					const requestId = typeof message.requestId === 'string' ? message.requestId : null;
					if (!requestId) break;
					const pending = pendingHistoryRequestsRef.current.get(requestId);
					if (!pending) break;
					pendingHistoryRequestsRef.current.delete(requestId);
					clearTimeout(pending.timeoutId);
					if (message.success === false) {
						pending.reject(new Error(message.error || 'Failed to fetch session history'));
					} else {
						pending.resolve({
							tabId: message.tabId,
							sessionId: message.sessionId,
							agentId: message.agentId,
							agentSessionId: message.agentSessionId ?? null,
							messages: Array.isArray(message.messages) ? message.messages : [],
						});
					}
					break;
				}

				case 'pong':
					// Heartbeat response - no action needed
					break;

				default:
					// Unknown message type - ignore
					break;
			}
		} catch (err) {
			console.error('Failed to parse WebSocket message:', err);
		}
	}, []);

	const attemptReconnect = useCallback(() => {
		if (!shouldReconnectRef.current || !autoReconnect) {
			return;
		}

		if (reconnectAttemptsRef.current >= 10) {
			setError('Failed to connect after 10 attempts');
			handlersRef.current?.onError?.('Failed to connect after 10 attempts');
			return;
		}

		reconnectTimeoutRef.current = setTimeout(() => {
			reconnectAttemptsRef.current++;
			void connectInternal();
		}, 2000);
	}, [autoReconnect]);

	const connectInternal = useCallback(async () => {
		// Bail if another connect is already mid-flight. Otherwise the second
		// caller would open a second socket while the first one is still
		// awaiting credential load, and the older socket's onclose would later
		// clear wsRef even after the newer socket became the active one.
		if (connectInFlightRef.current) {
			return;
		}
		connectInFlightRef.current = true;

		// Clean up existing connection
		if (wsRef.current) {
			wsRef.current.close();
			wsRef.current = null;
		}
		clearTimers();

		setState('connecting');
		handlersRef.current?.onConnectionChange?.('connecting');

		// Build URL without a specific sessionId - session is selected after connection
		const url = await buildWebSocketUrl();

		// disconnect() may have run while we were awaiting the credential read
		// (e.g. the app backgrounded mid-SecureStore-load). It flips
		// shouldReconnectRef off, so honor that here instead of opening a socket
		// the lifecycle wrapper already asked us to tear down - otherwise a live
		// socket leaks in the background and keeps receiving events.
		if (!shouldReconnectRef.current) {
			setState('disconnected');
			handlersRef.current?.onConnectionChange?.('disconnected');
			connectInFlightRef.current = false;
			return;
		}

		if (!url) {
			// No credentials available - need pairing
			setError('No credentials - please pair with Maestro desktop');
			handlersRef.current?.onError?.('No credentials - please pair with Maestro desktop');
			setState('disconnected');
			handlersRef.current?.onConnectionChange?.('disconnected');
			connectInFlightRef.current = false;
			return;
		}

		try {
			const ws = new WebSocket(url);
			wsRef.current = ws;
			connectInFlightRef.current = false;

			ws.onopen = () => {
				// Wait for 'connected' message from server
			};

			ws.onmessage = handleMessage;

			ws.onerror = (event) => {
				console.error('WebSocket error:', event);
				setError('WebSocket connection error');
				handlersRef.current?.onError?.('WebSocket connection error');
			};

			ws.onclose = (event) => {
				clearTimers();
				// Only clear wsRef if this is still the active socket. A stale
				// onclose from a superseded connect attempt must not wipe a newer
				// live socket out from under send().
				if (wsRef.current === ws) {
					wsRef.current = null;
					setState('disconnected');
					handlersRef.current?.onConnectionChange?.('disconnected');
				}

				// 4001 = desktop rejected the token. Looping a rejected token just
				// burns CPU and shows the same error forever, so latch off.
				if (event.code === 4001) {
					shouldReconnectRef.current = false;
					handlersRef.current?.onAuthFailed?.(event.reason || 'Authentication failed');
				}

				// Attempt to reconnect if not a clean close
				if (event.code !== 1000 && shouldReconnectRef.current && wsRef.current === null) {
					attemptReconnect();
				}
			};
		} catch (err) {
			console.error('Failed to create WebSocket:', err);
			setError('Failed to create WebSocket connection');
			handlersRef.current?.onError?.('Failed to create WebSocket connection');
			setState('disconnected');
			handlersRef.current?.onConnectionChange?.('disconnected');
			connectInFlightRef.current = false;
		}
	}, [clearTimers, handleMessage, attemptReconnect]);

	const connect = useCallback(() => {
		shouldReconnectRef.current = true;
		reconnectAttemptsRef.current = 0;
		setError(null);
		void connectInternal();
	}, [connectInternal]);

	const disconnect = useCallback(() => {
		shouldReconnectRef.current = false;
		clearTimers();

		if (wsRef.current) {
			wsRef.current.close(1000, 'Client disconnect');
			wsRef.current = null;
		}

		setState('disconnected');
		handlersRef.current?.onConnectionChange?.('disconnected');
	}, [clearTimers]);

	const send = useCallback((message: object): boolean => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify(message));
			return true;
		}
		return false;
	}, []);

	const rejectPendingHistoryRequests = useCallback((reason: string) => {
		const pending = pendingHistoryRequestsRef.current;
		if (pending.size === 0) return;
		for (const entry of pending.values()) {
			clearTimeout(entry.timeoutId);
			entry.reject(new Error(reason));
		}
		pending.clear();
	}, []);

	const requestSessionHistory = useCallback(
		(
			tabId: string,
			options?: { sinceMs?: number; tail?: number; timeoutMs?: number }
		): Promise<SessionHistoryResult> => {
			return new Promise<SessionHistoryResult>((resolve, reject) => {
				if (!tabId) {
					reject(new Error('tabId is required'));
					return;
				}
				if (wsRef.current?.readyState !== WebSocket.OPEN) {
					reject(new Error('WebSocket is not open'));
					return;
				}

				const requestId = `history-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
				const timeoutMs = options?.timeoutMs ?? 10_000;

				const timeoutId = setTimeout(() => {
					if (pendingHistoryRequestsRef.current.delete(requestId)) {
						reject(new Error('Session history request timed out'));
					}
				}, timeoutMs);

				pendingHistoryRequestsRef.current.set(requestId, { resolve, reject, timeoutId });

				const message: Record<string, unknown> = {
					type: 'get_session_history',
					tabId,
					requestId,
				};
				if (options?.sinceMs !== undefined) message.sinceMs = options.sinceMs;
				if (options?.tail !== undefined) message.tail = options.tail;

				try {
					wsRef.current.send(JSON.stringify(message));
				} catch (err) {
					pendingHistoryRequestsRef.current.delete(requestId);
					clearTimeout(timeoutId);
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});
		},
		[]
	);

	// Reject any in-flight history fetches whenever the socket drops so callers
	// get a deterministic error instead of hanging forever.
	useEffect(() => {
		if (state === 'disconnected') {
			rejectPendingHistoryRequests('WebSocket disconnected');
		}
	}, [state, rejectPendingHistoryRequests]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			shouldReconnectRef.current = false;
			clearTimers();
			rejectPendingHistoryRequests('WebSocket hook unmounted');
			if (wsRef.current) {
				wsRef.current.close(1000, 'Component unmount');
				wsRef.current = null;
			}
		};
	}, [clearTimers, rejectPendingHistoryRequests]);

	return {
		state,
		isAuthenticated: state === 'authenticated',
		error,
		connect,
		disconnect,
		send,
		requestSessionHistory,
	};
}

export default useMaestroWebSocket;
