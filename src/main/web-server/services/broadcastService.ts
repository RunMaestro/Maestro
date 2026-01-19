/**
 * Broadcast Service for Web Server
 *
 * This module contains all broadcast methods extracted from web-server.ts.
 * It handles outgoing messages to web clients including session state changes,
 * theme updates, tab changes, and Auto Run state.
 *
 * Broadcast Types:
 * - session_live/session_offline: Session live status changes
 * - session_state_change: Session state transitions (idle, busy, error, connecting)
 * - session_added/session_removed: Session lifecycle events
 * - sessions_list: Full sessions list (for initial sync or bulk updates)
 * - active_session_changed: Active session change in desktop
 * - tabs_changed: Tab array or active tab changes
 * - theme: Theme updates
 * - custom_commands: Custom AI commands updates
 * - autorun_state: Auto Run batch processing state
 * - user_input: User input from desktop (for web client sync)
 * - session_output: Session output data
 */

import { WebSocket } from 'ws';
import type { Theme } from '../../../shared/theme-types';
import { logger } from '../../utils/logger';

// Logger context for broadcast service logs
const LOG_CONTEXT = 'BroadcastService';

/**
 * Web client connection info (shared with messageHandlers)
 */
export interface WebClientInfo {
	socket: WebSocket;
	id: string;
	connectedAt: number;
	subscribedSessionId?: string;
}

/**
 * Custom AI command definition (matches renderer's CustomAICommand)
 */
export interface CustomAICommand {
	id: string;
	command: string;
	description: string;
	prompt: string;
}

/**
 * AI Tab data for multi-tab support within a Maestro session
 */
export interface AITabData {
	id: string;
	agentSessionId: string | null;
	name: string | null;
	starred: boolean;
	inputValue: string;
	usageStats?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		totalCostUsd?: number;
		contextWindow?: number;
	} | null;
	createdAt: number;
	state: 'idle' | 'busy';
	thinkingStartTime?: number | null;
}

/**
 * Session data for broadcast messages
 */
export interface SessionBroadcastData {
	id: string;
	name: string;
	toolType: string;
	state: string;
	inputMode: string;
	cwd: string;
	groupId?: string | null;
	groupName?: string | null;
	groupEmoji?: string | null;
	// Worktree subagent support
	parentSessionId?: string | null;
	worktreeBranch?: string | null;
}

/**
 * Auto Run state for broadcast messages
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
}

/**
 * CLI activity data for session state broadcasts
 */
export interface CliActivity {
	playbookId: string;
	playbookName: string;
	startedAt: number;
}

/**
 * Callback to get all connected web clients
 */
export type GetWebClientsCallback = () => Map<string, WebClientInfo>;

/**
 * Broadcast Service Class
 *
 * Handles all outgoing WebSocket broadcasts to web clients.
 * Uses dependency injection for the web clients map to maintain separation from WebServer class.
 */
export class BroadcastService {
	private getWebClients: GetWebClientsCallback | null = null;

	/**
	 * Set the callback for getting web clients
	 */
	setGetWebClientsCallback(callback: GetWebClientsCallback): void {
		this.getWebClients = callback;
	}

	/**
	 * Broadcast a message to all connected web clients
	 */
	broadcastToAll(message: object): void {
		if (!this.getWebClients) return;

		const data = JSON.stringify(message);
		for (const client of this.getWebClients().values()) {
			if (client.socket.readyState === WebSocket.OPEN) {
				client.socket.send(data);
			}
		}
	}

	/**
	 * Broadcast a message to clients subscribed to a specific session
	 */
	broadcastToSession(sessionId: string, message: object): void {
		if (!this.getWebClients) return;

		const data = JSON.stringify(message);
		for (const client of this.getWebClients().values()) {
			if (
				client.socket.readyState === WebSocket.OPEN &&
				(client.subscribedSessionId === sessionId || !client.subscribedSessionId)
			) {
				client.socket.send(data);
			}
		}
	}

	/**
	 * Broadcast a session state change to all connected web clients
	 * Called when any session's state changes (idle, busy, error, connecting)
	 */
	broadcastSessionStateChange(
		sessionId: string,
		state: string,
		additionalData?: {
			name?: string;
			toolType?: string;
			inputMode?: string;
			cwd?: string;
			cliActivity?: CliActivity;
		}
	): void {
		this.broadcastToAll({
			type: 'session_state_change',
			sessionId,
			state,
			...additionalData,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast when a session is added
	 */
	broadcastSessionAdded(session: SessionBroadcastData): void {
		this.broadcastToAll({
			type: 'session_added',
			session,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast when a session is removed
	 */
	broadcastSessionRemoved(sessionId: string): void {
		this.broadcastToAll({
			type: 'session_removed',
			sessionId,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast the full sessions list to all connected web clients
	 * Used for initial sync or bulk updates
	 */
	broadcastSessionsList(sessions: SessionBroadcastData[]): void {
		this.broadcastToAll({
			type: 'sessions_list',
			sessions,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast active session change to all connected web clients
	 * Called when the user switches sessions in the desktop app
	 */
	broadcastActiveSessionChange(sessionId: string): void {
		this.broadcastToAll({
			type: 'active_session_changed',
			sessionId,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast tab change to all connected web clients
	 * Called when the tabs array or active tab changes in a session
	 */
	broadcastTabsChange(sessionId: string, aiTabs: AITabData[], activeTabId: string): void {
		this.broadcastToAll({
			type: 'tabs_changed',
			sessionId,
			aiTabs,
			activeTabId,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast theme change to all connected web clients
	 * Called when the user changes the theme in the desktop app
	 */
	broadcastThemeChange(theme: Theme): void {
		this.broadcastToAll({
			type: 'theme',
			theme,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast custom commands update to all connected web clients
	 * Called when the user modifies custom AI commands in the desktop app
	 */
	broadcastCustomCommands(commands: CustomAICommand[]): void {
		this.broadcastToAll({
			type: 'custom_commands',
			commands,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast AutoRun state to all connected web clients
	 * Called when batch processing starts, progresses, or stops
	 */
	broadcastAutoRunState(sessionId: string, state: AutoRunState | null): void {
		logger.info(
			`[AutoRun Broadcast] sessionId=${sessionId}, isRunning=${state?.isRunning}, tasks=${state?.completedTasks}/${state?.totalTasks}`,
			LOG_CONTEXT
		);
		this.broadcastToAll({
			type: 'autorun_state',
			sessionId,
			state,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast user input to web clients subscribed to a session
	 * Called when a command is sent from the desktop app so web clients stay in sync
	 */
	broadcastUserInput(sessionId: string, command: string, inputMode: 'ai' | 'terminal'): void {
		this.broadcastToSession(sessionId, {
			type: 'user_input',
			sessionId,
			command,
			inputMode,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast session live status change
	 * Called when a session is marked as live (visible in web interface)
	 */
	broadcastSessionLive(sessionId: string, agentSessionId?: string): void {
		this.broadcastToAll({
			type: 'session_live',
			sessionId,
			agentSessionId,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast session offline status change
	 * Called when a session is marked as offline (no longer visible in web interface)
	 */
	broadcastSessionOffline(sessionId: string): void {
		this.broadcastToAll({
			type: 'session_offline',
			sessionId,
			timestamp: Date.now(),
		});
	}
}
