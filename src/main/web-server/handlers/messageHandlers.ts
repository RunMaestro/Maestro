/**
 * WebSocket Message Handlers for Web Server
 *
 * This module contains all WebSocket message handlers extracted from web-server.ts.
 * It handles incoming messages from web clients including commands, mode switching,
 * session/tab management, and health checks.
 *
 * Message Types Handled:
 * - ping: Health check, responds with pong
 * - subscribe: Subscribe to session updates
 * - send_command: Execute command in session (AI or terminal)
 * - switch_mode: Switch between AI and terminal mode
 * - select_session: Select/switch to a session in desktop
 * - get_sessions: Request updated sessions list
 * - select_tab: Select a tab within a session
 * - new_tab: Create a new tab within a session
 * - close_tab: Close a tab within a session
 * - rename_tab: Rename a tab within a session
 */

import { WebSocket } from 'ws';
import { logger } from '../../utils/logger';

// Logger context for all message handler logs
const LOG_CONTEXT = 'WebServer';

/**
 * Web client message interface
 */
export interface WebClientMessage {
	type: string;
	sessionId?: string;
	tabId?: string;
	command?: string;
	mode?: 'ai' | 'terminal';
	inputMode?: 'ai' | 'terminal';
	newName?: string;
	[key: string]: unknown;
}

/**
 * Web client connection info
 */
export interface WebClient {
	socket: WebSocket;
	id: string;
	connectedAt: number;
	subscribedSessionId?: string;
}

/**
 * Session detail for command validation
 */
export interface SessionDetailForHandler {
	state: string;
	inputMode: string;
	agentSessionId?: string;
}

/**
 * Live session info for enriching sessions
 */
export interface LiveSessionInfo {
	sessionId: string;
	agentSessionId?: string;
	enabledAt: number;
}

/**
 * Callbacks required by the message handler
 */
export interface MessageHandlerCallbacks {
	getSessionDetail: (sessionId: string) => SessionDetailForHandler | null;
	executeCommand: (
		sessionId: string,
		command: string,
		inputMode?: 'ai' | 'terminal'
	) => Promise<boolean>;
	switchMode: (sessionId: string, mode: 'ai' | 'terminal') => Promise<boolean>;
	selectSession: (sessionId: string, tabId?: string) => Promise<boolean>;
	selectTab: (sessionId: string, tabId: string) => Promise<boolean>;
	newTab: (sessionId: string) => Promise<{ tabId: string } | null>;
	closeTab: (sessionId: string, tabId: string) => Promise<boolean>;
	renameTab: (sessionId: string, tabId: string, newName: string) => Promise<boolean>;
	starTab: (sessionId: string, tabId: string, starred: boolean) => Promise<boolean>;
	reorderTab: (sessionId: string, fromIndex: number, toIndex: number) => Promise<boolean>;
	toggleBookmark: (sessionId: string) => Promise<boolean>;
	getSessions: () => Array<{
		id: string;
		name: string;
		toolType: string;
		state: string;
		inputMode: string;
		cwd: string;
		agentSessionId?: string | null;
	}>;
	getLiveSessionInfo: (sessionId: string) => LiveSessionInfo | undefined;
	isSessionLive: (sessionId: string) => boolean;
}

/**
 * WebSocket Message Handler Class
 *
 * Handles all incoming WebSocket messages from web clients.
 * Uses dependency injection for callbacks to maintain separation from WebServer class.
 */
export class WebSocketMessageHandler {
	private callbacks: Partial<MessageHandlerCallbacks> = {};

	/**
	 * Set the callbacks for message handling
	 */
	setCallbacks(callbacks: Partial<MessageHandlerCallbacks>): void {
		this.callbacks = { ...this.callbacks, ...callbacks };
	}

	/**
	 * Helper to send a JSON message to a client with timestamp
	 */
	private send(client: WebClient, data: Record<string, unknown>): void {
		client.socket.send(JSON.stringify({ ...data, timestamp: Date.now() }));
	}

	/**
	 * Helper to send an error message to a client
	 */
	private sendError(client: WebClient, message: string, extra?: Record<string, unknown>): void {
		this.send(client, { type: 'error', message, ...extra });
	}

	/**
	 * Handle incoming WebSocket message from a web client
	 *
	 * @param client - The web client connection info
	 * @param message - The parsed message from the client
	 */
	handleMessage(client: WebClient, message: WebClientMessage): void {
		// Log all incoming messages for debugging
		logger.info(
			`[Web] handleWebClientMessage: type=${message.type}, clientId=${client.id}`,
			LOG_CONTEXT
		);

		switch (message.type) {
			case 'ping':
				this.handlePing(client);
				break;

			case 'subscribe':
				this.handleSubscribe(client, message);
				break;

			case 'send_command':
				this.handleSendCommand(client, message);
				break;

			case 'switch_mode':
				this.handleSwitchMode(client, message);
				break;

			case 'select_session':
				this.handleSelectSession(client, message);
				break;

			case 'get_sessions':
				this.handleGetSessions(client);
				break;

			case 'select_tab':
				this.handleSelectTab(client, message);
				break;

			case 'new_tab':
				this.handleNewTab(client, message);
				break;

			case 'close_tab':
				this.handleCloseTab(client, message);
				break;

			case 'rename_tab':
				this.handleRenameTab(client, message);
				break;

			case 'star_tab':
				this.handleStarTab(client, message);
				break;

			case 'reorder_tab':
				this.handleReorderTab(client, message);
				break;

			case 'toggle_bookmark':
				this.handleToggleBookmark(client, message);
				break;

			default:
				this.handleUnknown(client, message);
		}
	}

	/**
	 * Handle ping message - respond with pong
	 */
	private handlePing(client: WebClient): void {
		this.send(client, { type: 'pong' });
	}

	/**
	 * Handle subscribe message - update client's session subscription
	 */
	private handleSubscribe(client: WebClient, message: WebClientMessage): void {
		if (message.sessionId) {
			client.subscribedSessionId = message.sessionId as string;
		}
		this.send(client, { type: 'subscribed', sessionId: message.sessionId });
	}

	/**
	 * Handle send_command message - execute command in session
	 */
	private handleSendCommand(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const command = message.command as string;
		// inputMode from web client - use this instead of server state to avoid sync issues
		const clientInputMode = message.inputMode as 'ai' | 'terminal' | undefined;

		logger.info(
			`[Web Command] Received: sessionId=${sessionId}, inputMode=${clientInputMode}, command=${command?.substring(0, 50)}`,
			LOG_CONTEXT
		);

		if (!sessionId || !command) {
			logger.warn(
				`[Web Command] Missing sessionId or command: sessionId=${sessionId}, commandLen=${command?.length}`,
				LOG_CONTEXT
			);
			this.sendError(client, 'Missing sessionId or command');
			return;
		}

		// Get session details to check state and determine how to handle
		const sessionDetail = this.callbacks.getSessionDetail?.(sessionId);
		if (!sessionDetail) {
			this.sendError(client, 'Session not found');
			return;
		}

		// Check if session is busy - prevent race conditions between desktop and web
		if (sessionDetail.state === 'busy') {
			this.sendError(
				client,
				'Session is busy - please wait for the current operation to complete',
				{
					sessionId,
				}
			);
			logger.debug(`Command rejected - session ${sessionId} is busy`, LOG_CONTEXT);
			return;
		}

		// Use client's inputMode if provided, otherwise fall back to server state
		const effectiveMode = clientInputMode || sessionDetail.inputMode;
		const isAiMode = effectiveMode === 'ai';
		const mode = isAiMode ? 'AI' : 'CLI';
		const claudeId = sessionDetail.agentSessionId || 'none';

		// Log all web interface commands prominently
		logger.info(
			`[Web Command] Mode: ${mode} | Session: ${sessionId}${isAiMode ? ` | Claude: ${claudeId}` : ''} | Message: ${command}`,
			LOG_CONTEXT
		);

		// Route ALL commands through the renderer for consistent handling
		// The renderer handles both AI and terminal modes, updating UI and state
		// Pass clientInputMode so renderer uses the web's intended mode
		if (this.callbacks.executeCommand) {
			this.callbacks
				.executeCommand(sessionId, command, clientInputMode)
				.then((success) => {
					this.send(client, { type: 'command_result', success, sessionId });
					if (!success) {
						logger.warn(
							`[Web Command] ${mode} command rejected for session ${sessionId}`,
							LOG_CONTEXT
						);
					}
				})
				.catch((error) => {
					logger.error(
						`[Web Command] ${mode} command failed for session ${sessionId}: ${error.message}`,
						LOG_CONTEXT
					);
					this.sendError(client, `Failed to execute command: ${error.message}`);
				});
		} else {
			this.sendError(client, 'Command execution not configured');
		}
	}

	/**
	 * Handle switch_mode message - switch between AI and terminal mode
	 */
	private handleSwitchMode(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const mode = message.mode as 'ai' | 'terminal';
		logger.info(
			`[Web] Received switch_mode message: session=${sessionId}, mode=${mode}`,
			LOG_CONTEXT
		);

		if (!sessionId || !mode) {
			this.sendError(client, 'Missing sessionId or mode');
			return;
		}

		if (!this.callbacks.switchMode) {
			logger.warn(`[Web] switchModeCallback is not set!`, LOG_CONTEXT);
			this.sendError(client, 'Mode switching not configured');
			return;
		}

		// Forward to desktop's mode switching logic
		// This ensures single source of truth - desktop handles state updates and broadcasts
		logger.info(`[Web] Calling switchModeCallback for session ${sessionId}: ${mode}`, LOG_CONTEXT);
		this.callbacks
			.switchMode(sessionId, mode)
			.then((success) => {
				this.send(client, { type: 'mode_switch_result', success, sessionId, mode });
				logger.debug(
					`Mode switch for session ${sessionId} to ${mode}: ${success ? 'success' : 'failed'}`,
					LOG_CONTEXT
				);
			})
			.catch((error) => {
				this.sendError(client, `Failed to switch mode: ${error.message}`);
			});
	}

	/**
	 * Handle select_session message - select/switch to a session in desktop
	 */
	private handleSelectSession(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const tabId = message.tabId as string | undefined;
		logger.info(
			`[Web] Received select_session message: session=${sessionId}, tab=${tabId || 'none'}`,
			LOG_CONTEXT
		);

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!this.callbacks.selectSession) {
			logger.warn(`[Web] selectSessionCallback is not set!`, LOG_CONTEXT);
			this.sendError(client, 'Session selection not configured');
			return;
		}

		// Forward to desktop's session selection logic (include tabId if provided)
		logger.info(
			`[Web] Calling selectSessionCallback for session ${sessionId}${tabId ? `, tab ${tabId}` : ''}`,
			LOG_CONTEXT
		);
		this.callbacks
			.selectSession(sessionId, tabId)
			.then((success) => {
				if (success) {
					// Subscribe client to this session's output so they receive session_output messages
					client.subscribedSessionId = sessionId;
					logger.debug(`Session ${sessionId} selected in desktop, client subscribed`, LOG_CONTEXT);
				} else {
					logger.warn(`Failed to select session ${sessionId} in desktop`, LOG_CONTEXT);
				}
				this.send(client, { type: 'select_session_result', success, sessionId });
			})
			.catch((error) => {
				this.sendError(client, `Failed to select session: ${error.message}`);
			});
	}

	/**
	 * Handle get_sessions message - request updated sessions list
	 */
	private handleGetSessions(client: WebClient): void {
		if (
			this.callbacks.getSessions &&
			this.callbacks.getLiveSessionInfo &&
			this.callbacks.isSessionLive
		) {
			const allSessions = this.callbacks.getSessions();
			// Enrich sessions with live info if available
			const sessionsWithLiveInfo = allSessions.map((s) => {
				const liveInfo = this.callbacks.getLiveSessionInfo!(s.id);
				return {
					...s,
					agentSessionId: liveInfo?.agentSessionId || s.agentSessionId,
					liveEnabledAt: liveInfo?.enabledAt,
					isLive: this.callbacks.isSessionLive!(s.id),
				};
			});
			this.send(client, { type: 'sessions_list', sessions: sessionsWithLiveInfo });
		}
	}

	/**
	 * Handle select_tab message - select a tab within a session
	 */
	private handleSelectTab(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const tabId = message.tabId as string;
		logger.info(
			`[Web] Received select_tab message: session=${sessionId}, tab=${tabId}`,
			LOG_CONTEXT
		);

		if (!sessionId || !tabId) {
			this.sendError(client, 'Missing sessionId or tabId');
			return;
		}

		if (!this.callbacks.selectTab) {
			this.sendError(client, 'Tab selection not configured');
			return;
		}

		this.callbacks
			.selectTab(sessionId, tabId)
			.then((success) => {
				this.send(client, { type: 'select_tab_result', success, sessionId, tabId });
			})
			.catch((error) => {
				this.sendError(client, `Failed to select tab: ${error.message}`);
			});
	}

	/**
	 * Handle new_tab message - create a new tab within a session
	 */
	private handleNewTab(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		logger.info(`[Web] Received new_tab message: session=${sessionId}`, LOG_CONTEXT);

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!this.callbacks.newTab) {
			this.sendError(client, 'Tab creation not configured');
			return;
		}

		this.callbacks
			.newTab(sessionId)
			.then((result) => {
				this.send(client, {
					type: 'new_tab_result',
					success: !!result,
					sessionId,
					tabId: result?.tabId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to create tab: ${error.message}`);
			});
	}

	/**
	 * Handle close_tab message - close a tab within a session
	 */
	private handleCloseTab(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const tabId = message.tabId as string;
		logger.info(
			`[Web] Received close_tab message: session=${sessionId}, tab=${tabId}`,
			LOG_CONTEXT
		);

		if (!sessionId || !tabId) {
			this.sendError(client, 'Missing sessionId or tabId');
			return;
		}

		if (!this.callbacks.closeTab) {
			this.sendError(client, 'Tab closing not configured');
			return;
		}

		this.callbacks
			.closeTab(sessionId, tabId)
			.then((success) => {
				this.send(client, { type: 'close_tab_result', success, sessionId, tabId });
			})
			.catch((error) => {
				this.sendError(client, `Failed to close tab: ${error.message}`);
			});
	}

	/**
	 * Handle rename_tab message - rename a tab within a session
	 */
	private handleRenameTab(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const tabId = message.tabId as string;
		const newName = message.newName as string;
		logger.info(
			`[Web] Received rename_tab message: session=${sessionId}, tab=${tabId}, newName=${newName}`,
			LOG_CONTEXT
		);

		if (!sessionId || !tabId) {
			this.sendError(client, 'Missing sessionId or tabId');
			return;
		}

		if (!this.callbacks.renameTab) {
			this.sendError(client, 'Tab renaming not configured');
			return;
		}

		// newName can be empty string to clear the name
		this.callbacks
			.renameTab(sessionId, tabId, newName || '')
			.then((success) => {
				this.send(client, {
					type: 'rename_tab_result',
					success,
					sessionId,
					tabId,
					newName: newName || '',
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to rename tab: ${error.message}`);
			});
	}

	/**
	 * Handle star_tab message - star/unstar a tab within a session
	 */
	private handleStarTab(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const tabId = message.tabId as string;
		const starred = message.starred as boolean;
		logger.info(
			`[Web] Received star_tab message: session=${sessionId}, tab=${tabId}, starred=${starred}`,
			LOG_CONTEXT
		);

		if (!sessionId || !tabId) {
			this.sendError(client, 'Missing sessionId or tabId');
			return;
		}

		if (!this.callbacks.starTab) {
			this.sendError(client, 'Tab starring not configured');
			return;
		}

		this.callbacks
			.starTab(sessionId, tabId, !!starred)
			.then((success) => {
				this.send(client, { type: 'star_tab_result', success, sessionId, tabId, starred });
			})
			.catch((error) => {
				this.sendError(client, `Failed to star tab: ${error.message}`);
			});
	}

	/**
	 * Handle reorder_tab message - move a tab to a new position within a session
	 */
	private handleReorderTab(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const fromIndex = message.fromIndex as number;
		const toIndex = message.toIndex as number;
		logger.info(
			`[Web] Received reorder_tab message: session=${sessionId}, from=${fromIndex}, to=${toIndex}`,
			LOG_CONTEXT
		);

		if (!sessionId || fromIndex == null || toIndex == null) {
			this.sendError(client, 'Missing sessionId, fromIndex, or toIndex');
			return;
		}

		if (!this.callbacks.reorderTab) {
			this.sendError(client, 'Tab reordering not configured');
			return;
		}

		this.callbacks
			.reorderTab(sessionId, fromIndex, toIndex)
			.then((success) => {
				this.send(client, {
					type: 'reorder_tab_result',
					success,
					sessionId,
					fromIndex,
					toIndex,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to reorder tab: ${error.message}`);
			});
	}

	/**
	 * Handle toggle_bookmark message - toggle bookmark state on a session
	 */
	private handleToggleBookmark(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		logger.info(`[Web] Received toggle_bookmark message: session=${sessionId}`, LOG_CONTEXT);

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!this.callbacks.toggleBookmark) {
			this.sendError(client, 'Bookmark toggling not configured');
			return;
		}

		this.callbacks
			.toggleBookmark(sessionId)
			.then((success) => {
				this.send(client, { type: 'toggle_bookmark_result', success, sessionId });
			})
			.catch((error) => {
				this.sendError(client, `Failed to toggle bookmark: ${error.message}`);
			});
	}

	/**
	 * Handle unknown message types - echo back for debugging
	 */
	private handleUnknown(client: WebClient, message: WebClientMessage): void {
		logger.debug(`Unknown message type: ${message.type}`, LOG_CONTEXT);
		this.send(client, { type: 'echo', originalType: message.type, data: message });
	}
}
