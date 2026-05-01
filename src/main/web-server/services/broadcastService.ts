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
 * - autorun_docs_changed: Auto Run document list changes
 * - user_input: User input from desktop (for web client sync)
 * - session_output: Session output data
 */

import { WebSocket } from 'ws';
import { logger } from '../../utils/logger';
import type {
	Theme,
	WebClient,
	CustomAICommand,
	AITabData,
	SessionBroadcastData,
	AutoRunState,
	AutoRunDocument,
	CliActivity,
	NotificationEvent,
	WebSettings,
	GroupData,
	GroupChatMessage,
	GroupChatState,
	CueActivityEntry,
	CueSubscriptionInfo,
	GitStatusData,
	ToolExecutionData,
	QueuedItemData,
} from '../types';

// Re-export types for backwards compatibility
export type {
	CustomAICommand,
	AITabData,
	SessionBroadcastData,
	AutoRunState,
	CliActivity,
} from '../types';

// Logger context for broadcast service logs
const LOG_CONTEXT = 'BroadcastService';

/**
 * Web client connection info (alias for backwards compatibility)
 */
export type WebClientInfo = WebClient;

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
	private previousAutoRunStates: Map<string, { running: boolean; completedTasks: number }> =
		new Map();

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
	 * Broadcast a notification event to all connected web clients
	 */
	broadcastNotificationEvent(event: NotificationEvent): void {
		this.broadcastToAll({
			type: 'notification_event',
			...event,
			timestamp: Date.now(),
		});
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
			currentCycleTokens?: number;
			thinkingStartTime?: number;
		}
	): void {
		this.broadcastToAll({
			type: 'session_state_change',
			sessionId,
			state,
			...additionalData,
			timestamp: Date.now(),
		});

		// Trigger notification events on state transitions
		if (state === 'idle') {
			this.broadcastNotificationEvent({
				eventType: 'agent_complete',
				sessionId,
				sessionName: additionalData?.name ?? sessionId,
				message: 'Agent finished processing',
				severity: 'info',
			});
		} else if (state === 'error') {
			this.broadcastNotificationEvent({
				eventType: 'agent_error',
				sessionId,
				sessionName: additionalData?.name ?? sessionId,
				message: 'Agent encountered an error',
				severity: 'error',
			});
		}
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
	 * Broadcast git status changes to all connected web clients.
	 */
	broadcastGitStatus(sessionId: string, gitStatus: GitStatusData | null): void {
		this.broadcastToAll({
			type: 'git_status_changed',
			sessionId,
			gitStatus,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast execution queue changes to all connected web clients.
	 */
	broadcastExecutionQueue(sessionId: string, executionQueue: QueuedItemData[]): void {
		this.broadcastToAll({
			type: 'execution_queue_changed',
			sessionId,
			executionQueue,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast structured tool execution events to clients subscribed to the session.
	 */
	broadcastToolExecution(
		sessionId: string,
		tabId: string | undefined,
		tool: ToolExecutionData
	): void {
		this.broadcastToSession(sessionId, {
			type: 'tool_execution',
			sessionId,
			tabId,
			tool,
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
	 * Broadcast Bionify reading-mode changes to all connected web clients
	 * Called when the user toggles the global reading-mode setting in the desktop app
	 */
	broadcastBionifyReadingModeChange(enabled: boolean): void {
		this.broadcastToAll({
			type: 'bionify_reading_mode',
			enabled,
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
	 * Broadcast settings change to all connected web clients
	 * Called when a setting is modified (from web or desktop)
	 */
	broadcastSettingsChanged(settings: WebSettings): void {
		this.broadcastToAll({
			type: 'settings_changed',
			settings,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast groups change to all connected web clients
	 * Called when groups are created, renamed, deleted, or sessions are moved
	 */
	broadcastGroupsChanged(groups: GroupData[]): void {
		this.broadcastToAll({
			type: 'groups_changed',
			groups,
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

		// Detect transitions for notification events
		const previous = this.previousAutoRunStates.get(sessionId);
		if (state) {
			// Detect autorun_complete: running → not running
			if (previous?.running && !state.isRunning) {
				this.broadcastNotificationEvent({
					eventType: 'autorun_complete',
					sessionId,
					sessionName: sessionId,
					message: `Auto Run finished (${state.completedTasks}/${state.totalTasks} tasks)`,
					severity: 'info',
				});
			}

			// Detect autorun_task_complete: completedTasks increased
			if (previous && state.completedTasks > previous.completedTasks) {
				this.broadcastNotificationEvent({
					eventType: 'autorun_task_complete',
					sessionId,
					sessionName: sessionId,
					message: `Task ${state.completedTasks}/${state.totalTasks} completed`,
					severity: 'info',
				});
			}

			// Update previous state
			this.previousAutoRunStates.set(sessionId, {
				running: state.isRunning,
				completedTasks: state.completedTasks,
			});
		} else {
			// State cleared — remove tracking
			this.previousAutoRunStates.delete(sessionId);
		}
	}

	/**
	 * Broadcast Auto Run documents changed to all connected web clients
	 * Called when Auto Run documents are added, removed, or modified
	 */
	broadcastAutoRunDocsChanged(sessionId: string, documents: AutoRunDocument[]): void {
		this.broadcastToAll({
			type: 'autorun_docs_changed',
			sessionId,
			documents,
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

	/**
	 * Broadcast a group chat message to all connected web clients
	 */
	broadcastGroupChatMessage(chatId: string, message: GroupChatMessage): void {
		this.broadcastToAll({
			type: 'group_chat_message',
			chatId,
			message,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast a group chat state change to all connected web clients
	 */
	broadcastGroupChatStateChange(chatId: string, state: Partial<GroupChatState>): void {
		this.broadcastToAll({
			type: 'group_chat_state_change',
			chatId,
			...state,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast context operation progress to all connected web clients
	 */
	broadcastContextOperationProgress(sessionId: string, operation: string, progress: number): void {
		this.broadcastToAll({
			type: 'context_operation_progress',
			sessionId,
			operation,
			progress,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast context operation completion to all connected web clients
	 */
	broadcastContextOperationComplete(sessionId: string, operation: string, success: boolean): void {
		this.broadcastToAll({
			type: 'context_operation_complete',
			sessionId,
			operation,
			success,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast a Cue activity event to all connected web clients
	 */
	broadcastCueActivity(entry: CueActivityEntry): void {
		this.broadcastToAll({
			type: 'cue_activity_event',
			entry,
			timestamp: Date.now(),
		});
	}

	/**
	 * Broadcast a tool execution event for the thinking stream
	 */
	broadcastToolEvent(
		sessionId: string,
		tabId: string,
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
		}
	): void {
		// Only send tool events to clients explicitly subscribed to this session.
		// Unlike broadcastToSession, this excludes unsubscribed clients (e.g., dashboard/overview)
		// to avoid unnecessary fan-out of high-volume, potentially sensitive tool data.
		if (!this.getWebClients) return;

		const data = JSON.stringify({
			type: 'tool_event',
			sessionId,
			tabId,
			toolLog,
			timestamp: Date.now(),
		});
		for (const client of this.getWebClients().values()) {
			if (client.socket.readyState === WebSocket.OPEN && client.subscribedSessionId === sessionId) {
				client.socket.send(data);
			}
		}
	}

	/**
	 * Broadcast Cue subscriptions changed to all connected web clients
	 */
	broadcastCueSubscriptionsChanged(subscriptions: CueSubscriptionInfo[]): void {
		this.broadcastToAll({
			type: 'cue_subscriptions_changed',
			subscriptions,
			timestamp: Date.now(),
		});
	}
}
