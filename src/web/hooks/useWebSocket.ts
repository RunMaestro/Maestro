/**
 * useWebSocket hook for Maestro web interface
 *
 * Provides WebSocket connection management for the web interface,
 * handling connection, reconnection, and message handling.
 *
 * Note: Authentication is handled via URL path (security token in URL),
 * so no separate auth handshake is needed.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Theme } from '../../shared/theme-types';
import type {
	AITabData,
	AutoRunState,
	CustomAICommand,
	GroupChatMessage,
	GroupChatState,
	GroupData,
	SessionData,
} from '../../shared/web-protocol/session';
import { isWebServerMessage, type ServerMessage } from '../../shared/web-protocol/server-messages';
import { buildWebSocketUrl as buildWsUrl, getCurrentSessionId } from '../utils/config';
import { webLogger } from '../utils/logger';

/**
 * WebSocket connection states
 */
export type WebSocketState =
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'authenticating'
	| 'authenticated';

/**
 * Event handlers for WebSocket events
 */
export interface WebSocketEventHandlers {
	/** Called when sessions list is received or updated */
	onSessionsUpdate?: (sessions: SessionData[]) => void;
	/** Called when a single session state changes */
	onSessionStateChange?: (
		sessionId: string,
		state: string,
		additionalData?: Partial<SessionData>
	) => void;
	/** Called when a session is added */
	onSessionAdded?: (session: SessionData) => void;
	/** Called when a session is removed */
	onSessionRemoved?: (sessionId: string) => void;
	/** Called when the active session changes on the desktop */
	onActiveSessionChanged?: (sessionId: string) => void;
	/** Called when a tool execution event is received (real-time tool usage in thinking stream) */
	onToolEvent?: (
		sessionId: string,
		tabId: string,
		toolLog: Extract<ServerMessage, { type: 'tool_event' }>['toolLog']
	) => void;
	/** Called when session output is received (real-time AI/terminal output) */
	onSessionOutput?: (
		sessionId: string,
		data: string,
		source: 'ai' | 'terminal',
		tabId?: string
	) => void;
	/** Called when a session process exits */
	onSessionExit?: (sessionId: string, exitCode: number) => void;
	/** Called when user input is received (message sent from desktop app) */
	onUserInput?: (sessionId: string, command: string, inputMode: 'ai' | 'terminal') => void;
	/** Called when theme is received or updated */
	onThemeUpdate?: (theme: Theme) => void;
	/** Called when the global Bionify reading-mode setting is received or updated */
	onBionifyReadingModeUpdate?: (enabled: boolean) => void;
	/** Called when custom commands are received */
	onCustomCommands?: (commands: CustomAICommand[]) => void;
	/** Called when AutoRun state changes (batch processing on desktop) */
	onAutoRunStateChange?: (sessionId: string, state: AutoRunState | null) => void;
	/** Called when AutoRun document list changes */
	onAutoRunDocsChanged?: (
		sessionId: string,
		documents: Extract<ServerMessage, { type: 'autorun_docs_changed' }>['documents']
	) => void;
	/** Called when a notification event is received */
	onNotificationEvent?: (event: Extract<ServerMessage, { type: 'notification_event' }>) => void;
	/** Called when raw terminal PTY data is received (for xterm.js) */
	onTerminalData?: (sessionId: string, data: string) => void;
	/** Called when the web terminal PTY is spawned and ready (re-send dimensions) */
	onTerminalReady?: (sessionId: string) => void;
	/** Called when settings are changed (from web or desktop) */
	onSettingsChanged?: (
		settings: Extract<ServerMessage, { type: 'settings_changed' }>['settings']
	) => void;
	/** Called when groups are changed (created, renamed, deleted, membership) */
	onGroupsChanged?: (groups: GroupData[]) => void;
	/** Called when tabs change in a session */
	onTabsChanged?: (sessionId: string, aiTabs: AITabData[], activeTabId: string) => void;
	/** Called when a group chat message is broadcast */
	onGroupChatMessage?: (chatId: string, message: GroupChatMessage) => void;
	/** Called when group chat state changes */
	onGroupChatStateChange?: (chatId: string, state: Partial<GroupChatState>) => void;
	/** Called when connection state changes */
	onConnectionChange?: (state: WebSocketState) => void;
	/** Called when an error occurs */
	onError?: (error: string) => void;
	/** Called for any message (for debugging or custom handling) */
	onMessage?: (message: ServerMessage) => void;
}

/**
 * Configuration options for the WebSocket connection
 */
export interface UseWebSocketOptions {
	/** WebSocket URL (defaults to /ws/web on current host) */
	url?: string;
	/** Authentication token (optional, can also be provided via URL query param) */
	token?: string;
	/** Whether to automatically reconnect on disconnection */
	autoReconnect?: boolean;
	/** Maximum number of reconnection attempts */
	maxReconnectAttempts?: number;
	/** Delay between reconnection attempts in milliseconds */
	reconnectDelay?: number;
	/** Ping interval in milliseconds (0 to disable) */
	pingInterval?: number;
	/** Event handlers */
	handlers?: WebSocketEventHandlers;
}

/**
 * Return value from useWebSocket hook
 */
export interface UseWebSocketReturn {
	/** Current connection state */
	state: WebSocketState;
	/** Whether the connection is fully authenticated */
	isAuthenticated: boolean;
	/** Whether the connection is active (connected or authenticated) */
	isConnected: boolean;
	/** Client ID assigned by the server */
	clientId: string | null;
	/** Last error message */
	error: string | null;
	/** Number of reconnection attempts made */
	reconnectAttempts: number;
	/** Manually connect to the WebSocket server */
	connect: () => void;
	/** Manually disconnect from the WebSocket server */
	disconnect: () => void;
	/** Send an authentication token */
	authenticate: (token: string) => void;
	/** Send a ping message */
	ping: () => void;
	/** Send a raw message to the server */
	send: (message: object) => boolean;
	/** Send a request and wait for a correlated response */
	sendRequest: <T = any>(
		type: string,
		payload?: Record<string, unknown>,
		timeoutMs?: number
	) => Promise<T>;
}

/**
 * Default configuration values
 */
const DEFAULT_OPTIONS: Required<Omit<UseWebSocketOptions, 'handlers' | 'token'>> = {
	url: '',
	autoReconnect: true,
	maxReconnectAttempts: 10,
	reconnectDelay: 2000,
	pingInterval: 30000,
};

/**
 * Build the WebSocket URL using the config
 * The security token is in the URL path, not as a query param
 */
function buildWebSocketUrl(baseUrl?: string, sessionId?: string): string {
	if (baseUrl) {
		return baseUrl;
	}

	// Use config to build the URL with security token in path
	// If sessionId is provided, subscribe to that session's updates
	return buildWsUrl(sessionId || getCurrentSessionId() || undefined);
}

/**
 * useWebSocket hook for managing WebSocket connections to the Maestro server
 *
 * @example
 * ```tsx
 * function App() {
 *   const { state, isAuthenticated, connect, authenticate } = useWebSocket({
 *     handlers: {
 *       onSessionsUpdate: (sessions) => setSessions(sessions),
 *       onThemeUpdate: (theme) => setTheme(theme),
 *     },
 *   });
 *
 *   if (state === 'disconnected') {
 *     return <button onClick={connect}>Connect</button>;
 *   }
 *
 *   if (!isAuthenticated) {
 *     return <AuthForm onSubmit={(token) => authenticate(token)} />;
 *   }
 *
 *   return <Dashboard />;
 * }
 * ```
 */
export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
	const {
		url: baseUrl,
		token: _token,
		autoReconnect = DEFAULT_OPTIONS.autoReconnect,
		maxReconnectAttempts = DEFAULT_OPTIONS.maxReconnectAttempts,
		reconnectDelay = DEFAULT_OPTIONS.reconnectDelay,
		pingInterval = DEFAULT_OPTIONS.pingInterval,
		handlers,
	} = options;

	// State
	const [state, setState] = useState<WebSocketState>('disconnected');
	const [clientId, setClientId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [reconnectAttempts, setReconnectAttempts] = useState(0);

	// Refs for mutable values
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
	const handlersRef = useRef(handlers);
	const shouldReconnectRef = useRef(true);
	// Connection ID to handle StrictMode double-mounting - each mount gets unique ID
	const connectionIdRef = useRef<number>(0);
	const mountIdRef = useRef<number>(0);
	// Track seen message IDs to dedupe duplicate broadcasts
	const seenMsgIdsRef = useRef<Set<string>>(new Set());
	// Ref for handleMessage to avoid stale closure issues
	const handleMessageRef = useRef<((event: MessageEvent) => void) | null>(null);
	// Pending request-response map for sendRequest correlation
	const pendingRequestsRef = useRef<
		Map<
			string,
			{
				resolve: (data: any) => void;
				reject: (err: Error) => void;
				timer: ReturnType<typeof setTimeout>;
			}
		>
	>(new Map());

	// Keep handlers ref up to date SYNCHRONOUSLY to avoid race conditions
	// This must happen before any WebSocket messages are processed
	handlersRef.current = handlers;

	/**
	 * Clear all timers
	 */
	const clearTimers = useCallback(() => {
		if (reconnectTimeoutRef.current) {
			clearTimeout(reconnectTimeoutRef.current);
			reconnectTimeoutRef.current = null;
		}
		if (pingIntervalRef.current) {
			clearInterval(pingIntervalRef.current);
			pingIntervalRef.current = null;
		}
	}, []);

	/**
	 * Start the ping interval
	 */
	const startPingInterval = useCallback(() => {
		if (pingInterval > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
			pingIntervalRef.current = setInterval(() => {
				if (wsRef.current?.readyState === WebSocket.OPEN) {
					wsRef.current.send(JSON.stringify({ type: 'ping' }));
				}
			}, pingInterval);
		}
	}, [pingInterval]);

	/**
	 * Handle incoming messages from the server
	 */
	const handleMessage = useCallback(
		(event: MessageEvent) => {
			try {
				const parsed: unknown = JSON.parse(event.data);
				const parsedRecord =
					typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
						? (parsed as Record<string, unknown>)
						: null;

				// Correlated request responses use command-specific payloads; they are
				// accepted only for an outstanding request, never as unsolicited events.
				const requestId =
					parsedRecord && typeof parsedRecord.requestId === 'string'
						? parsedRecord.requestId
						: undefined;
				if (requestId && pendingRequestsRef.current.has(requestId)) {
					const pending = pendingRequestsRef.current.get(requestId)!;
					clearTimeout(pending.timer);
					pendingRequestsRef.current.delete(requestId);
					if (parsedRecord?.type === 'error') {
						pending.reject(
							new Error(
								typeof parsedRecord.message === 'string' ? parsedRecord.message : 'Server error'
							)
						);
					} else {
						pending.resolve(parsed);
					}
					return;
				}

				if (!isWebServerMessage(parsed)) {
					webLogger.warn('Rejected malformed or unknown WebSocket message', 'WebSocket');
					return;
				}
				const message = parsed;

				// Log all incoming messages for debugging
				webLogger.debug(`Message received: type=${message.type}`, 'WebSocket');

				// Call the generic message handler
				handlersRef.current?.onMessage?.(message);

				switch (message.type) {
					case 'connected': {
						const connectedMsg = message;
						setClientId(connectedMsg.clientId);
						if (connectedMsg.authenticated) {
							setState('authenticated');
							handlersRef.current?.onConnectionChange?.('authenticated');
						} else {
							setState('connected');
							handlersRef.current?.onConnectionChange?.('connected');
						}
						setError(null);
						setReconnectAttempts(0);
						startPingInterval();
						break;
					}

					case 'auth_required': {
						const authReqMsg = message;
						setClientId(authReqMsg.clientId);
						setState('connected');
						handlersRef.current?.onConnectionChange?.('connected');
						break;
					}

					case 'auth_success': {
						const authSuccessMsg = message;
						setClientId(authSuccessMsg.clientId);
						setState('authenticated');
						handlersRef.current?.onConnectionChange?.('authenticated');
						setError(null);
						break;
					}

					case 'auth_failed': {
						const authFailedMsg = message;
						setError(authFailedMsg.message);
						handlersRef.current?.onError?.(authFailedMsg.message);
						break;
					}

					case 'sessions_list': {
						const sessionsMsg = message;
						handlersRef.current?.onSessionsUpdate?.(sessionsMsg.sessions);
						break;
					}

					case 'session_state_change': {
						const stateChangeMsg = message;
						handlersRef.current?.onSessionStateChange?.(
							stateChangeMsg.sessionId,
							stateChangeMsg.state,
							{
								name: stateChangeMsg.name,
								toolType: stateChangeMsg.toolType,
								inputMode: stateChangeMsg.inputMode,
								cwd: stateChangeMsg.cwd,
							}
						);
						break;
					}

					case 'session_added': {
						const addedMsg = message;
						handlersRef.current?.onSessionAdded?.(addedMsg.session);
						break;
					}

					case 'session_removed': {
						const removedMsg = message;
						handlersRef.current?.onSessionRemoved?.(removedMsg.sessionId);
						break;
					}

					case 'active_session_changed': {
						const activeMsg = message;
						handlersRef.current?.onActiveSessionChanged?.(activeMsg.sessionId);
						break;
					}

					case 'session_output': {
						const outputMsg = message;
						// Dedupe using message ID if available
						if (outputMsg.msgId) {
							if (seenMsgIdsRef.current.has(outputMsg.msgId)) {
								webLogger.debug(
									`DEDUPE: Skipping duplicate session_output msgId=${outputMsg.msgId}`,
									'WebSocket'
								);
								break;
							}
							seenMsgIdsRef.current.add(outputMsg.msgId);
							// Limit set size to prevent memory leaks (keep last 1000 IDs)
							if (seenMsgIdsRef.current.size > 1000) {
								const idsArray = Array.from(seenMsgIdsRef.current);
								seenMsgIdsRef.current = new Set(idsArray.slice(-500));
							}
						}
						webLogger.debug(
							`Received session_output: msgId=${outputMsg.msgId || 'none'}, session=${outputMsg.sessionId}, tabId=${outputMsg.tabId || 'none'}, source=${outputMsg.source}, dataLen=${outputMsg.data?.length || 0}`,
							'WebSocket'
						);
						handlersRef.current?.onSessionOutput?.(
							outputMsg.sessionId,
							outputMsg.data,
							outputMsg.source,
							outputMsg.tabId
						);
						break;
					}

					case 'tool_event': {
						const toolMsg = message;
						handlersRef.current?.onToolEvent?.(toolMsg.sessionId, toolMsg.tabId, toolMsg.toolLog);
						break;
					}

					case 'session_exit': {
						const exitMsg = message;
						handlersRef.current?.onSessionExit?.(exitMsg.sessionId, exitMsg.exitCode);
						break;
					}

					case 'user_input': {
						const inputMsg = message;
						handlersRef.current?.onUserInput?.(
							inputMsg.sessionId,
							inputMsg.command,
							inputMsg.inputMode
						);
						break;
					}

					case 'theme': {
						const themeMsg = message;
						handlersRef.current?.onThemeUpdate?.(themeMsg.theme);
						break;
					}

					case 'bionify_reading_mode': {
						const bionifyMsg = message;
						handlersRef.current?.onBionifyReadingModeUpdate?.(bionifyMsg.enabled);
						break;
					}

					case 'custom_commands': {
						const commandsMsg = message;
						handlersRef.current?.onCustomCommands?.(commandsMsg.commands);
						break;
					}

					case 'autorun_state': {
						const autoRunMsg = message;
						webLogger.info(
							`[WS] AutoRun state received: session=${autoRunMsg.sessionId}, isRunning=${autoRunMsg.state?.isRunning}, tasks=${autoRunMsg.state?.completedTasks}/${autoRunMsg.state?.totalTasks}`,
							'WebSocket'
						);
						handlersRef.current?.onAutoRunStateChange?.(autoRunMsg.sessionId, autoRunMsg.state);
						break;
					}

					case 'autorun_docs_changed': {
						const docsMsg = message;
						handlersRef.current?.onAutoRunDocsChanged?.(docsMsg.sessionId, docsMsg.documents);
						break;
					}

					case 'notification_event': {
						const notifMsg = message;
						handlersRef.current?.onNotificationEvent?.(notifMsg);
						break;
					}

					case 'terminal_data': {
						const sessionId = message.sessionId as string;
						const data = message.data as string;
						if (sessionId && data) {
							handlersRef.current?.onTerminalData?.(sessionId, data);
						}
						break;
					}

					case 'terminal_ready': {
						const sessionId = message.sessionId as string;
						if (sessionId) {
							handlersRef.current?.onTerminalReady?.(sessionId);
						}
						break;
					}

					case 'settings_changed': {
						const settingsMsg = message;
						handlersRef.current?.onSettingsChanged?.(settingsMsg.settings);
						break;
					}

					case 'groups_changed': {
						const groupsMsg = message;
						handlersRef.current?.onGroupsChanged?.(groupsMsg.groups);
						break;
					}

					case 'tabs_changed': {
						const tabsMsg = message;
						handlersRef.current?.onTabsChanged?.(
							tabsMsg.sessionId,
							tabsMsg.aiTabs,
							tabsMsg.activeTabId
						);
						break;
					}

					case 'group_chat_message': {
						const gcMsg = message;
						handlersRef.current?.onGroupChatMessage?.(gcMsg.chatId, gcMsg.message);
						break;
					}

					case 'group_chat_state_change': {
						const gcStateMsg = message;
						const { chatId: gcChatId, type: _gcType, timestamp: _gcTs, ...gcState } = gcStateMsg;
						handlersRef.current?.onGroupChatStateChange?.(
							gcChatId,
							gcState as Partial<GroupChatState>
						);
						break;
					}

					case 'error': {
						const errorMsg = message;
						setError(errorMsg.message);
						handlersRef.current?.onError?.(errorMsg.message);
						break;
					}

					case 'pong':
					case 'subscribed':
					case 'echo':
					case 'session_live':
					case 'session_offline':
					case 'context_operation_progress':
					case 'context_operation_complete':
					case 'cue_activity_event':
					case 'cue_subscriptions_changed':
						// Valid protocol events with no web-hook callback yet.
						break;

					default: {
						const exhaustive: never = message;
						void exhaustive;
					}
				}
			} catch (err) {
				webLogger.error('Failed to parse WebSocket message', 'WebSocket', err);
			}
		},
		[startPingInterval]
	);

	// Keep handleMessageRef up to date SYNCHRONOUSLY to avoid race conditions
	// This must happen before any WebSocket messages are received
	// Using useEffect would cause a race condition where messages arrive before the ref is set
	handleMessageRef.current = handleMessage;

	/**
	 * Attempt to reconnect to the server
	 */
	const attemptReconnect = useCallback(() => {
		if (!shouldReconnectRef.current || !autoReconnect) {
			return;
		}

		if (reconnectAttempts >= maxReconnectAttempts) {
			setError(`Failed to connect after ${maxReconnectAttempts} attempts`);
			handlersRef.current?.onError?.(`Failed to connect after ${maxReconnectAttempts} attempts`);
			return;
		}

		reconnectTimeoutRef.current = setTimeout(() => {
			setReconnectAttempts((prev) => prev + 1);
			// We'll call connect which is defined below
			connectInternal();
		}, reconnectDelay);
	}, [autoReconnect, maxReconnectAttempts, reconnectAttempts, reconnectDelay]);

	/**
	 * Internal connect function (to avoid circular dependency)
	 */
	const connectInternal = useCallback(() => {
		// Increment connection ID to track this specific connection
		const thisConnectionId = ++connectionIdRef.current;

		// Clean up existing connection
		if (wsRef.current) {
			wsRef.current.close();
			wsRef.current = null;
		}
		clearTimers();

		// Build the URL using config (token is in URL path, not query param)
		const url = buildWebSocketUrl(baseUrl);

		setState('connecting');
		handlersRef.current?.onConnectionChange?.('connecting');

		try {
			const ws = new WebSocket(url);
			wsRef.current = ws;

			ws.onopen = () => {
				// Only process if this is still the current connection (handles StrictMode)
				if (connectionIdRef.current !== thisConnectionId) return;
				// State will be set when we receive the 'connected' or 'auth_required' message
				setState('authenticating');
				handlersRef.current?.onConnectionChange?.('authenticating');
			};

			// Use a wrapper to always call the latest handleMessage (avoids stale closure)
			ws.onmessage = (event: MessageEvent) => {
				handleMessageRef.current?.(event);
			};

			ws.onerror = (event) => {
				// Only process if this is still the current connection (handles StrictMode)
				if (connectionIdRef.current !== thisConnectionId) return;
				webLogger.error('WebSocket connection error', 'WebSocket', event);
				setError('WebSocket connection error');
				handlersRef.current?.onError?.('WebSocket connection error');
				// Reject all pending requests
				for (const [, pending] of pendingRequestsRef.current) {
					clearTimeout(pending.timer);
					pending.reject(new Error('Connection lost'));
				}
				pendingRequestsRef.current.clear();
			};

			ws.onclose = (event) => {
				// Only process if this is still the current connection (handles StrictMode)
				if (connectionIdRef.current !== thisConnectionId) return;
				clearTimers();
				wsRef.current = null;
				setState('disconnected');
				handlersRef.current?.onConnectionChange?.('disconnected');
				// Reject all pending requests
				for (const [, pending] of pendingRequestsRef.current) {
					clearTimeout(pending.timer);
					pending.reject(new Error('Connection lost'));
				}
				pendingRequestsRef.current.clear();

				// Attempt to reconnect if not a clean close
				if (event.code !== 1000 && shouldReconnectRef.current) {
					attemptReconnect();
				}
			};
		} catch (err) {
			webLogger.error('Failed to create WebSocket', 'WebSocket', err);
			setError('Failed to create WebSocket connection');
			handlersRef.current?.onError?.('Failed to create WebSocket connection');
			setState('disconnected');
			handlersRef.current?.onConnectionChange?.('disconnected');
		}
		// Note: handleMessage is not a dependency because we use handleMessageRef pattern
	}, [baseUrl, clearTimers, attemptReconnect]);

	/**
	 * Connect to the WebSocket server
	 */
	const connect = useCallback(() => {
		shouldReconnectRef.current = true;
		setReconnectAttempts(0);
		setError(null);
		connectInternal();
	}, [connectInternal]);

	/**
	 * Disconnect from the WebSocket server
	 */
	const disconnect = useCallback(() => {
		shouldReconnectRef.current = false;
		clearTimers();

		if (wsRef.current) {
			wsRef.current.close(1000, 'Client disconnect');
			wsRef.current = null;
		}

		setState('disconnected');
		setClientId(null);
		handlersRef.current?.onConnectionChange?.('disconnected');
	}, [clearTimers]);

	/**
	 * Send an authentication token
	 */
	const authenticate = useCallback((authToken: string) => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify({ type: 'auth', token: authToken }));
			setState('authenticating');
			handlersRef.current?.onConnectionChange?.('authenticating');
		}
	}, []);

	/**
	 * Send a ping message
	 */
	const ping = useCallback(() => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify({ type: 'ping' }));
		}
	}, []);

	/**
	 * Send a raw message to the server
	 */
	const send = useCallback((message: object): boolean => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			const messageStr = JSON.stringify(message);
			webLogger.debug(`[WS Send] Sending message: ${messageStr.substring(0, 200)}`, 'WebSocket');
			wsRef.current.send(messageStr);
			return true;
		}
		webLogger.warn(
			`[WS Send] Cannot send - WebSocket not open (readyState=${wsRef.current?.readyState})`,
			'WebSocket'
		);
		return false;
	}, []);

	/**
	 * Send a request and wait for a correlated response.
	 * The server must echo back the requestId in its response.
	 */
	const sendRequest = useCallback(
		<T = any>(
			type: string,
			payload?: Record<string, unknown>,
			timeoutMs: number = 10000
		): Promise<T> => {
			return new Promise<T>((resolve, reject) => {
				const requestId =
					typeof crypto !== 'undefined' && crypto.randomUUID
						? crypto.randomUUID()
						: Date.now().toString(36) + Math.random().toString(36);

				const timer = setTimeout(() => {
					pendingRequestsRef.current.delete(requestId);
					reject(new Error('Request timed out'));
				}, timeoutMs);

				pendingRequestsRef.current.set(requestId, { resolve, reject, timer });

				const sent = send({ type, ...payload, requestId });
				if (!sent) {
					clearTimeout(timer);
					pendingRequestsRef.current.delete(requestId);
					reject(new Error('WebSocket not connected'));
				}
			});
		},
		[send]
	);

	// Cleanup on unmount - track mount ID to handle StrictMode double-mount
	useEffect(() => {
		const thisMountId = ++mountIdRef.current;

		return () => {
			// Only cleanup if this is the most recent mount (handles StrictMode)
			if (mountIdRef.current !== thisMountId) return;

			shouldReconnectRef.current = false;
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
				reconnectTimeoutRef.current = null;
			}
			if (pingIntervalRef.current) {
				clearInterval(pingIntervalRef.current);
				pingIntervalRef.current = null;
			}
			if (wsRef.current) {
				wsRef.current.close(1000, 'Component unmount');
				wsRef.current = null;
			}
		};
	}, []);

	// Derived state
	const isAuthenticated = state === 'authenticated';
	const isConnected =
		state === 'connected' || state === 'authenticated' || state === 'authenticating';

	return {
		state,
		isAuthenticated,
		isConnected,
		clientId,
		error,
		reconnectAttempts,
		connect,
		disconnect,
		authenticate,
		ping,
		send,
		sendRequest,
	};
}

export default useWebSocket;
