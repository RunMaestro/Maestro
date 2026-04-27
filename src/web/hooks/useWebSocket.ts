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
import type { UsageStats as BaseUsageStats } from '../../shared/types';
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
 * Usage stats for session cost/token tracking (all fields optional in web context)
 */
export type UsageStats = Partial<BaseUsageStats>;

/**
 * AI Tab data for multi-tab support within a Maestro session
 */
export interface AITabData {
	id: string;
	agentSessionId: string | null;
	name: string | null;
	starred: boolean;
	inputValue: string;
	usageStats?: UsageStats | null;
	createdAt: number;
	state: 'idle' | 'busy';
	thinkingStartTime?: number | null;
	hasUnread?: boolean;
}

/**
 * Last response preview for mobile display
 * Contains a truncated version of the last AI response
 */
export interface LastResponsePreview {
	text: string; // First 3 lines or ~500 chars of the last AI response
	timestamp: number;
	source: 'stdout' | 'stderr' | 'system';
	fullLength: number; // Total length of the original response
}

/**
 * Session data received from the server
 */
export interface SessionData {
	id: string;
	name: string;
	toolType: string;
	state: string;
	inputMode: string;
	cwd: string;
	groupId?: string | null;
	groupName?: string | null;
	groupEmoji?: string | null;
	usageStats?: UsageStats | null;
	lastResponse?: LastResponsePreview | null;
	agentSessionId?: string | null;
	thinkingStartTime?: number | null; // Timestamp when AI started thinking (for elapsed time display)
	aiTabs?: AITabData[];
	activeTabId?: string;
	bookmarked?: boolean; // Whether session is bookmarked (shows in Bookmarks group)
	// Worktree subagent support
	parentSessionId?: string | null; // If this is a worktree child, links to parent session
	worktreeBranch?: string | null; // Git branch for this worktree child
	// The session's configured Auto Run folder (null/undefined when not yet set).
	// Used by the mobile/web folder picker to highlight the current selection.
	autoRunFolderPath?: string | null;
}

/**
 * AutoRun state for batch processing
 */
export interface AutoRunState {
	isRunning: boolean;
	totalTasks: number;
	completedTasks: number;
	currentTaskIndex: number;
	isStopping?: boolean;
	// Multi-document progress fields
	totalDocuments?: number; // Total number of documents in the run
	currentDocumentIndex?: number; // Current document being processed (0-based)
	totalTasksAcrossAllDocs?: number; // Total tasks across all documents
	completedTasksAcrossAllDocs?: number; // Completed tasks across all documents
	// Error pause fields (Phase 5.10) — present when batch is paused awaiting resolution
	errorPaused?: boolean;
	errorMessage?: string;
	errorType?: string;
	errorRecoverable?: boolean;
	errorDocumentIndex?: number;
	errorTaskDescription?: string;
}

/**
 * Message types sent by the server
 */
export type ServerMessageType =
	| 'connected'
	| 'auth_required'
	| 'auth_success'
	| 'auth_failed'
	| 'sessions_list'
	| 'session_state_change'
	| 'session_added'
	| 'session_removed'
	| 'active_session_changed'
	| 'session_output'
	| 'session_exit'
	| 'session_live'
	| 'session_offline'
	| 'user_input'
	| 'theme'
	| 'bionify_reading_mode'
	| 'custom_commands'
	| 'autorun_state'
	| 'autorun_docs_changed'
	| 'notification_event'
	| 'settings_changed'
	| 'groups_changed'
	| 'tabs_changed'
	| 'group_chat_message'
	| 'group_chat_state_change'
	| 'context_operation_progress'
	| 'context_operation_complete'
	| 'cue_activity_event'
	| 'cue_subscriptions_changed'
	| 'tool_event'
	| 'terminal_data'
	| 'terminal_ready'
	| 'pong'
	| 'subscribed'
	| 'echo'
	| 'error';

/**
 * Base server message structure
 */
export interface ServerMessage {
	type: ServerMessageType;
	timestamp?: number;
	[key: string]: unknown;
}

/**
 * Connected message from server
 */
export interface ConnectedMessage extends ServerMessage {
	type: 'connected';
	clientId: string;
	message: string;
	authenticated: boolean;
}

/**
 * Auth required message from server
 */
export interface AuthRequiredMessage extends ServerMessage {
	type: 'auth_required';
	clientId: string;
	message: string;
}

/**
 * Auth success message from server
 */
export interface AuthSuccessMessage extends ServerMessage {
	type: 'auth_success';
	clientId: string;
	message: string;
}

/**
 * Auth failed message from server
 */
export interface AuthFailedMessage extends ServerMessage {
	type: 'auth_failed';
	message: string;
}

/**
 * Sessions list message from server
 */
export interface SessionsListMessage extends ServerMessage {
	type: 'sessions_list';
	sessions: SessionData[];
}

/**
 * Session state change message from server
 */
export interface SessionStateChangeMessage extends ServerMessage {
	type: 'session_state_change';
	sessionId: string;
	state: string;
	name?: string;
	toolType?: string;
	inputMode?: string;
	cwd?: string;
}

/**
 * Session added message from server
 */
export interface SessionAddedMessage extends ServerMessage {
	type: 'session_added';
	session: SessionData;
}

/**
 * Session removed message from server
 */
export interface SessionRemovedMessage extends ServerMessage {
	type: 'session_removed';
	sessionId: string;
}

/**
 * Active session changed message from server
 * Sent when the desktop app switches to a different session
 */
export interface ActiveSessionChangedMessage extends ServerMessage {
	type: 'active_session_changed';
	sessionId: string;
}

/**
 * Session output message from server (real-time AI/terminal output)
 */
export interface SessionOutputMessage extends ServerMessage {
	type: 'session_output';
	sessionId: string;
	tabId?: string; // Tab ID for multi-tab sessions (format: {sessionId}-ai-{tabId})
	data: string;
	source: 'ai' | 'terminal';
	msgId?: string; // Unique message ID for deduplication
}

/**
 * Session exit message from server (process completed)
 */
export interface SessionExitMessage extends ServerMessage {
	type: 'session_exit';
	sessionId: string;
	exitCode: number;
}

/**
 * User input message from server (message sent from desktop app)
 */
export interface UserInputMessage extends ServerMessage {
	type: 'user_input';
	sessionId: string;
	command: string;
	inputMode: 'ai' | 'terminal';
}

/**
 * Theme message from server
 */
export interface ThemeMessage extends ServerMessage {
	type: 'theme';
	theme: Theme;
}

/**
 * Bionify reading-mode message from server
 */
export interface BionifyReadingModeMessage extends ServerMessage {
	type: 'bionify_reading_mode';
	enabled: boolean;
}

/**
 * Custom AI command definition
 */
export interface CustomCommand {
	id: string;
	command: string;
	description: string;
	prompt: string;
}

/**
 * Custom commands message from server
 */
export interface CustomCommandsMessage extends ServerMessage {
	type: 'custom_commands';
	commands: CustomCommand[];
}

/**
 * AutoRun state message from server
 * Indicates when batch processing is active on the desktop app
 */
export interface AutoRunStateMessage extends ServerMessage {
	type: 'autorun_state';
	sessionId: string;
	state: AutoRunState | null;
}

/**
 * AutoRun documents changed message from server
 * Sent when Auto Run document list changes on the desktop
 */
export interface AutoRunDocsChangedMessage extends ServerMessage {
	type: 'autorun_docs_changed';
	sessionId: string;
	documents: Array<{
		filename: string;
		path: string;
		taskCount: number;
		completedCount: number;
	}>;
}

/**
 * Notification event message from server
 * Sent when a notification-worthy event occurs (agent complete, error, autorun, etc.)
 */
export interface NotificationEventMessage extends ServerMessage {
	type: 'notification_event';
	eventType:
		| 'agent_complete'
		| 'agent_error'
		| 'autorun_complete'
		| 'autorun_task_complete'
		| 'context_warning';
	sessionId: string;
	sessionName: string;
	message: string;
	severity: 'info' | 'warning' | 'error';
}

/**
 * Settings changed message from server
 * Sent when settings are modified (from web or desktop)
 */
export interface SettingsChangedMessage extends ServerMessage {
	type: 'settings_changed';
	settings: {
		theme: string;
		fontSize: number;
		enterToSendAI: boolean;
		defaultSaveToHistory: boolean;
		defaultShowThinking: string;
		autoScroll: boolean;
		notificationsEnabled: boolean;
		audioFeedbackEnabled: boolean;
		colorBlindMode: string;
		conductorProfile: string;
		/** Max agent output lines per message before truncation. `null` = All (Infinity serialized). */
		maxOutputLines: number | null;
		/** User-customized keyboard shortcut overrides (sparse; unset = use default). */
		shortcuts: Record<string, import('../../shared/shortcut-types').Shortcut>;
	};
}

/**
 * Group data for web clients
 */
export interface GroupData {
	id: string;
	name: string;
	emoji: string | null;
	sessionIds: string[];
}

/**
 * Groups changed message from server
 * Sent when groups are created, renamed, deleted, or membership changes
 */
export interface GroupsChangedMessage extends ServerMessage {
	type: 'groups_changed';
	groups: GroupData[];
}

/**
 * Tabs changed message from server
 * Sent when tabs are added, removed, or active tab changes in a session
 */
export interface TabsChangedMessage extends ServerMessage {
	type: 'tabs_changed';
	sessionId: string;
	aiTabs: AITabData[];
	activeTabId: string;
}

/**
 * Group chat message data
 */
export interface GroupChatMessage {
	id: string;
	participantId: string;
	participantName: string;
	content: string;
	timestamp: number;
	role: 'user' | 'assistant';
}

/**
 * Group chat state data
 */
export interface GroupChatState {
	id: string;
	topic: string;
	participants: Array<{ sessionId: string; name: string; toolType: string }>;
	messages: GroupChatMessage[];
	isActive: boolean;
	currentTurn?: string;
}

/**
 * Group chat message broadcast from server
 */
export interface GroupChatMessageBroadcast extends ServerMessage {
	type: 'group_chat_message';
	chatId: string;
	message: GroupChatMessage;
}

/**
 * Group chat state change broadcast from server
 */
export interface GroupChatStateChangeBroadcast extends ServerMessage {
	type: 'group_chat_state_change';
	chatId: string;
	[key: string]: unknown;
}

/**
 * Tool event message from server (real-time tool execution in thinking stream)
 */
export interface ToolEventMessage extends ServerMessage {
	type: 'tool_event';
	sessionId: string;
	tabId: string;
	toolLog: {
		id: string;
		timestamp: number;
		source: 'tool';
		text: string;
		metadata?: {
			toolState?: {
				name: string;
				status: 'running' | 'completed' | 'error';
				input?: Record<string, unknown>;
			};
		};
	};
}

/**
 * Error message from server
 */
export interface ErrorMessage extends ServerMessage {
	type: 'error';
	message: string;
}

/**
 * Union type of all possible server messages
 */
export type TypedServerMessage =
	| ConnectedMessage
	| AuthRequiredMessage
	| AuthSuccessMessage
	| AuthFailedMessage
	| SessionsListMessage
	| SessionStateChangeMessage
	| SessionAddedMessage
	| SessionRemovedMessage
	| ActiveSessionChangedMessage
	| SessionOutputMessage
	| SessionExitMessage
	| UserInputMessage
	| ThemeMessage
	| BionifyReadingModeMessage
	| CustomCommandsMessage
	| AutoRunStateMessage
	| AutoRunDocsChangedMessage
	| NotificationEventMessage
	| SettingsChangedMessage
	| GroupsChangedMessage
	| TabsChangedMessage
	| GroupChatMessageBroadcast
	| GroupChatStateChangeBroadcast
	| ToolEventMessage
	| ErrorMessage
	| ServerMessage;

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
	onToolEvent?: (sessionId: string, tabId: string, toolLog: ToolEventMessage['toolLog']) => void;
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
	onCustomCommands?: (commands: CustomCommand[]) => void;
	/** Called when AutoRun state changes (batch processing on desktop) */
	onAutoRunStateChange?: (sessionId: string, state: AutoRunState | null) => void;
	/** Called when AutoRun document list changes */
	onAutoRunDocsChanged?: (
		sessionId: string,
		documents: AutoRunDocsChangedMessage['documents']
	) => void;
	/** Called when a notification event is received */
	onNotificationEvent?: (event: NotificationEventMessage) => void;
	/** Called when raw terminal PTY data is received (for xterm.js) */
	onTerminalData?: (sessionId: string, data: string) => void;
	/** Called when the web terminal PTY is spawned and ready (re-send dimensions) */
	onTerminalReady?: (sessionId: string) => void;
	/** Called when settings are changed (from web or desktop) */
	onSettingsChanged?: (settings: SettingsChangedMessage['settings']) => void;
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
	onMessage?: (message: TypedServerMessage) => void;
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
				const message = JSON.parse(event.data) as TypedServerMessage;

				// Check for request-response correlation before dispatching
				const requestId = (message as any).requestId as string | undefined;
				if (requestId && pendingRequestsRef.current.has(requestId)) {
					const pending = pendingRequestsRef.current.get(requestId)!;
					clearTimeout(pending.timer);
					pendingRequestsRef.current.delete(requestId);
					if ((message as any).type === 'error') {
						pending.reject(new Error((message as any).message ?? 'Server error'));
					} else {
						pending.resolve(message);
					}
					return;
				}

				// Log all incoming messages for debugging
				webLogger.debug(`Message received: type=${message.type}`, 'WebSocket');

				// Call the generic message handler
				handlersRef.current?.onMessage?.(message);

				switch (message.type) {
					case 'connected': {
						const connectedMsg = message as ConnectedMessage;
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
						const authReqMsg = message as AuthRequiredMessage;
						setClientId(authReqMsg.clientId);
						setState('connected');
						handlersRef.current?.onConnectionChange?.('connected');
						break;
					}

					case 'auth_success': {
						const authSuccessMsg = message as AuthSuccessMessage;
						setClientId(authSuccessMsg.clientId);
						setState('authenticated');
						handlersRef.current?.onConnectionChange?.('authenticated');
						setError(null);
						break;
					}

					case 'auth_failed': {
						const authFailedMsg = message as AuthFailedMessage;
						setError(authFailedMsg.message);
						handlersRef.current?.onError?.(authFailedMsg.message);
						break;
					}

					case 'sessions_list': {
						const sessionsMsg = message as SessionsListMessage;
						handlersRef.current?.onSessionsUpdate?.(sessionsMsg.sessions);
						break;
					}

					case 'session_state_change': {
						const stateChangeMsg = message as SessionStateChangeMessage;
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
						const addedMsg = message as SessionAddedMessage;
						handlersRef.current?.onSessionAdded?.(addedMsg.session);
						break;
					}

					case 'session_removed': {
						const removedMsg = message as SessionRemovedMessage;
						handlersRef.current?.onSessionRemoved?.(removedMsg.sessionId);
						break;
					}

					case 'active_session_changed': {
						const activeMsg = message as ActiveSessionChangedMessage;
						handlersRef.current?.onActiveSessionChanged?.(activeMsg.sessionId);
						break;
					}

					case 'session_output': {
						const outputMsg = message as SessionOutputMessage;
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
						const toolMsg = message as ToolEventMessage;
						handlersRef.current?.onToolEvent?.(toolMsg.sessionId, toolMsg.tabId, toolMsg.toolLog);
						break;
					}

					case 'session_exit': {
						const exitMsg = message as SessionExitMessage;
						handlersRef.current?.onSessionExit?.(exitMsg.sessionId, exitMsg.exitCode);
						break;
					}

					case 'user_input': {
						const inputMsg = message as UserInputMessage;
						handlersRef.current?.onUserInput?.(
							inputMsg.sessionId,
							inputMsg.command,
							inputMsg.inputMode
						);
						break;
					}

					case 'theme': {
						const themeMsg = message as ThemeMessage;
						handlersRef.current?.onThemeUpdate?.(themeMsg.theme);
						break;
					}

					case 'bionify_reading_mode': {
						const bionifyMsg = message as BionifyReadingModeMessage;
						handlersRef.current?.onBionifyReadingModeUpdate?.(bionifyMsg.enabled);
						break;
					}

					case 'custom_commands': {
						const commandsMsg = message as CustomCommandsMessage;
						handlersRef.current?.onCustomCommands?.(commandsMsg.commands);
						break;
					}

					case 'autorun_state': {
						const autoRunMsg = message as AutoRunStateMessage;
						webLogger.info(
							`[WS] AutoRun state received: session=${autoRunMsg.sessionId}, isRunning=${autoRunMsg.state?.isRunning}, tasks=${autoRunMsg.state?.completedTasks}/${autoRunMsg.state?.totalTasks}`,
							'WebSocket'
						);
						handlersRef.current?.onAutoRunStateChange?.(autoRunMsg.sessionId, autoRunMsg.state);
						break;
					}

					case 'autorun_docs_changed': {
						const docsMsg = message as AutoRunDocsChangedMessage;
						handlersRef.current?.onAutoRunDocsChanged?.(docsMsg.sessionId, docsMsg.documents);
						break;
					}

					case 'notification_event': {
						const notifMsg = message as NotificationEventMessage;
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
						const settingsMsg = message as SettingsChangedMessage;
						handlersRef.current?.onSettingsChanged?.(settingsMsg.settings);
						break;
					}

					case 'groups_changed': {
						const groupsMsg = message as GroupsChangedMessage;
						handlersRef.current?.onGroupsChanged?.(groupsMsg.groups);
						break;
					}

					case 'tabs_changed': {
						const tabsMsg = message as TabsChangedMessage;
						handlersRef.current?.onTabsChanged?.(
							tabsMsg.sessionId,
							tabsMsg.aiTabs,
							tabsMsg.activeTabId
						);
						break;
					}

					case 'group_chat_message': {
						const gcMsg = message as GroupChatMessageBroadcast;
						handlersRef.current?.onGroupChatMessage?.(gcMsg.chatId, gcMsg.message);
						break;
					}

					case 'group_chat_state_change': {
						const gcStateMsg = message as GroupChatStateChangeBroadcast;
						const { chatId: gcChatId, type: _gcType, timestamp: _gcTs, ...gcState } = gcStateMsg;
						handlersRef.current?.onGroupChatStateChange?.(
							gcChatId,
							gcState as Partial<GroupChatState>
						);
						break;
					}

					case 'error': {
						const errorMsg = message as ErrorMessage;
						setError(errorMsg.message);
						handlersRef.current?.onError?.(errorMsg.message);
						break;
					}

					case 'pong':
						// Heartbeat response - no action needed
						break;

					default:
						// Unknown message type - ignore or log for debugging
						break;
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
