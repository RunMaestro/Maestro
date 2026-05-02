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
 * - open_file_tab: Open a file in a preview tab
 * - refresh_file_tree: Refresh the file tree for a session
 * - get_file_tree: Read directory tree from filesystem for web file explorer
 * - refresh_auto_run_docs: Refresh auto-run documents for a session
 * - configure_auto_run: Configure and optionally launch an auto-run session
 * - get_auto_run_docs: List auto-run documents for a session
 * - get_auto_run_state: Get current auto-run state for a session
 * - get_auto_run_document: Read content of a specific auto-run document
 * - save_auto_run_document: Write content to a specific auto-run document
 * - stop_auto_run: Stop an active auto-run for a session
 * - get_settings: Fetch current web settings
 * - set_setting: Modify a single setting (allowlisted keys only)
 */

import path from 'path';
import fs from 'fs/promises';
import { WebSocket } from 'ws';
import { logger } from '../../utils/logger';
import type {
	AutoRunDocument,
	AutoRunState,
	WebSettings,
	SettingValue,
	GroupData,
	GitStatusResult,
	GitDiffResult,
	GroupChatState,
	CueSubscriptionInfo,
	CueActivityEntry,
	UsageDashboardData,
	AchievementData,
	CreateSessionConfig,
	DirectorNotesSynopsisResult,
	NotifyToastClickAction,
	NotifyToastParams,
	NotifyCenterFlashParams,
	NotifyToastKind,
	NotifyToastColor,
	NotifyCenterFlashColor,
	NotifyCenterFlashVariant,
} from '../types';

/** Canonical Toast / Center Flash color set (shared design language). */
const NOTIFY_COLORS: readonly NotifyCenterFlashColor[] = [
	'green',
	'yellow',
	'orange',
	'red',
	'theme',
];
const NOTIFY_FLASH_COLORS = NOTIFY_COLORS;
const NOTIFY_TOAST_COLORS = NOTIFY_COLORS;

const NOTIFY_TOAST_KINDS: readonly NotifyToastKind[] = ['success', 'info', 'warning', 'error'];

/**
 * Legacy variant/type → color mapping. Lets older CLI scripts keep working
 * while we transition external integrations to `--color`.
 */
const VARIANT_TO_COLOR: Record<NotifyCenterFlashVariant, NotifyCenterFlashColor> = {
	success: 'green',
	info: 'theme',
	warning: 'yellow',
	error: 'red',
};

/**
 * Hard upper bound on flash duration for **externally-triggered** flashes
 * (CLI / web). The renderer-side `notifyCenterFlash` itself is uncapped so
 * internal in-app callers can still use longer durations if ever needed —
 * the cap lives at the IPC boundary so external scripts can't stick a
 * permanent overlay on the user.
 */
const EXTERNAL_FLASH_MAX_DURATION_MS = 5000;

/**
 * Hard upper bound on toast duration (seconds) for externally-triggered
 * toasts. Toasts are corner notifications so the cap is more generous than
 * Center Flash, but `0` (never auto-dismiss) is rejected — external scripts
 * that want a sticky toast must opt in explicitly via `dismissible: true`.
 */
const EXTERNAL_TOAST_MAX_DURATION_SECONDS = 60;
import { AGENT_IDS } from '../../../shared/agentIds';

// Logger context for all message handler logs
const LOG_CONTEXT = 'WebServer';

/**
 * Web client message interface
 */
export interface WebClientMessage {
	type: string;
	requestId?: string;
	sessionId?: string;
	tabId?: string;
	command?: string;
	mode?: 'ai' | 'terminal';
	inputMode?: 'ai' | 'terminal';
	newName?: string;
	filePath?: string;
	focus?: boolean;
	force?: boolean;
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
	cwd?: string;
	/** Currently active AI tab id; surfaced in send_command responses so callers
	 *  (`maestro-cli dispatch`) can address the same tab on follow-up calls. */
	activeTabId?: string;
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
		inputMode?: 'ai' | 'terminal',
		tabId?: string,
		force?: boolean,
		images?: string[]
	) => Promise<boolean>;
	switchMode: (sessionId: string, mode: 'ai' | 'terminal') => Promise<boolean>;
	selectSession: (sessionId: string, tabId?: string, focus?: boolean) => Promise<boolean>;
	selectTab: (sessionId: string, tabId: string) => Promise<boolean>;
	newTab: (sessionId: string) => Promise<{ tabId: string } | null>;
	closeTab: (sessionId: string, tabId: string) => Promise<boolean>;
	renameTab: (sessionId: string, tabId: string, newName: string) => Promise<boolean>;
	starTab: (sessionId: string, tabId: string, starred: boolean) => Promise<boolean>;
	reorderTab: (sessionId: string, fromIndex: number, toIndex: number) => Promise<boolean>;
	toggleBookmark: (sessionId: string) => Promise<boolean>;
	openFileTab: (sessionId: string, filePath: string) => Promise<boolean>;
	refreshFileTree: (sessionId: string) => Promise<boolean>;
	openBrowserTab: (sessionId: string, url: string) => Promise<boolean>;
	openTerminalTab: (
		sessionId: string,
		config: { cwd?: string; shell?: string; name?: string | null }
	) => Promise<boolean>;
	newAITabWithPrompt: (
		sessionId: string,
		prompt: string
	) => Promise<{ success: boolean; tabId?: string }>;
	refreshAutoRunDocs: (sessionId: string) => Promise<boolean>;
	configureAutoRun: (
		sessionId: string,
		config: {
			documents: Array<{ filename: string; resetOnCompletion?: boolean }>;
			prompt?: string;
			loopEnabled?: boolean;
			maxLoops?: number;
			saveAsPlaybook?: string;
			launch?: boolean;
			worktree?: {
				enabled: boolean;
				path: string;
				branchName: string;
				createPROnCompletion: boolean;
				prTargetBranch: string;
			};
		}
	) => Promise<{ success: boolean; playbookId?: string; error?: string }>;
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
	getAutoRunDocs: (sessionId: string) => Promise<AutoRunDocument[]>;
	getAutoRunDocContent: (sessionId: string, filename: string) => Promise<string>;
	saveAutoRunDoc: (sessionId: string, filename: string, content: string) => Promise<boolean>;
	stopAutoRun: (sessionId: string) => Promise<boolean>;
	getSettings: () => WebSettings;
	setSetting: (key: string, value: SettingValue) => Promise<boolean>;
	getGroups: () => GroupData[];
	createGroup: (name: string, emoji?: string) => Promise<{ id: string } | null>;
	renameGroup: (groupId: string, name: string) => Promise<boolean>;
	deleteGroup: (groupId: string) => Promise<boolean>;
	moveSessionToGroup: (sessionId: string, groupId: string | null) => Promise<boolean>;
	createSession: (
		name: string,
		toolType: string,
		cwd: string,
		groupId?: string,
		config?: CreateSessionConfig
	) => Promise<{ sessionId: string } | null>;
	deleteSession: (sessionId: string) => Promise<boolean>;
	renameSession: (sessionId: string, newName: string) => Promise<boolean>;
	getGitStatus: (sessionId: string) => Promise<GitStatusResult>;
	getGitDiff: (sessionId: string, filePath?: string) => Promise<GitDiffResult>;
	getGroupChats: () => Promise<GroupChatState[]>;
	startGroupChat: (topic: string, participantIds: string[]) => Promise<{ chatId: string } | null>;
	getGroupChatState: (chatId: string) => Promise<GroupChatState | null>;
	stopGroupChat: (chatId: string) => Promise<boolean>;
	sendGroupChatMessage: (chatId: string, message: string) => Promise<boolean>;
	mergeContext: (sourceSessionId: string, targetSessionId: string) => Promise<boolean>;
	transferContext: (sourceSessionId: string, targetSessionId: string) => Promise<boolean>;
	summarizeContext: (sessionId: string) => Promise<boolean>;
	createGist: (
		sessionId: string,
		description: string,
		isPublic: boolean
	) => Promise<{ success: boolean; gistUrl?: string; error?: string }>;
	getCueSubscriptions: (sessionId?: string) => Promise<CueSubscriptionInfo[]>;
	toggleCueSubscription: (subscriptionId: string, enabled: boolean) => Promise<boolean>;
	getCueActivity: (sessionId?: string, limit?: number) => Promise<CueActivityEntry[]>;
	triggerCueSubscription: (
		subscriptionName: string,
		prompt?: string,
		sourceAgentId?: string
	) => Promise<boolean>;
	getUsageDashboard: (timeRange: 'day' | 'week' | 'month' | 'all') => Promise<UsageDashboardData>;
	getAchievements: () => Promise<AchievementData[]>;
	generateDirectorNotesSynopsis: (
		lookbackDays: number,
		provider: string
	) => Promise<DirectorNotesSynopsisResult>;
	writeToTerminal: (sessionId: string, data: string) => boolean;
	resizeTerminal: (sessionId: string, cols: number, rows: number) => boolean;
	spawnTerminalForWeb: (
		sessionId: string,
		config: { cwd: string; cols?: number; rows?: number }
	) => Promise<{ success: boolean; pid: number }>;
	killTerminalForWeb: (sessionId: string) => boolean;
	notifyToast: (params: NotifyToastParams) => Promise<boolean>;
	notifyCenterFlash: (params: NotifyCenterFlashParams) => Promise<boolean>;
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

			case 'open_file_tab':
				this.handleOpenFileTab(client, message);
				break;

			case 'open_browser_tab':
				this.handleOpenBrowserTab(client, message);
				break;

			case 'open_terminal_tab':
				this.handleOpenTerminalTab(client, message);
				break;

			case 'new_ai_tab_with_prompt':
				this.handleNewAITabWithPrompt(client, message);
				break;

			case 'refresh_file_tree':
				this.handleRefreshFileTree(client, message);
				break;

			case 'get_file_tree':
				this.handleGetFileTree(client, message);
				break;

			case 'refresh_auto_run_docs':
				this.handleRefreshAutoRunDocs(client, message);
				break;

			case 'configure_auto_run':
				this.handleConfigureAutoRun(client, message);
				break;

			case 'get_auto_run_docs':
				this.handleGetAutoRunDocs(client, message);
				break;

			case 'get_auto_run_state':
				this.handleGetAutoRunState(client, message);
				break;

			case 'get_auto_run_document':
				this.handleGetAutoRunDocument(client, message);
				break;

			case 'save_auto_run_document':
				this.handleSaveAutoRunDocument(client, message);
				break;

			case 'stop_auto_run':
				this.handleStopAutoRun(client, message);
				break;

			case 'get_settings':
				this.handleGetSettings(client, message);
				break;

			case 'set_setting':
				this.handleSetSetting(client, message);
				break;

			case 'create_session':
				this.handleCreateSession(client, message);
				break;

			case 'delete_session':
				this.handleDeleteSession(client, message);
				break;

			case 'rename_session':
				this.handleRenameSession(client, message);
				break;

			case 'get_groups':
				this.handleGetGroups(client, message);
				break;

			case 'create_group':
				this.handleCreateGroup(client, message);
				break;

			case 'rename_group':
				this.handleRenameGroup(client, message);
				break;

			case 'delete_group':
				this.handleDeleteGroup(client, message);
				break;

			case 'move_session_to_group':
				this.handleMoveSessionToGroup(client, message);
				break;

			case 'get_git_status':
				this.handleGetGitStatus(client, message);
				break;

			case 'get_git_diff':
				this.handleGetGitDiff(client, message);
				break;

			case 'get_group_chats':
				this.handleGetGroupChats(client, message);
				break;

			case 'start_group_chat':
				this.handleStartGroupChat(client, message);
				break;

			case 'get_group_chat_state':
				this.handleGetGroupChatState(client, message);
				break;

			case 'send_group_chat_message':
				this.handleSendGroupChatMessage(client, message);
				break;

			case 'stop_group_chat':
				this.handleStopGroupChat(client, message);
				break;

			case 'merge_context':
				this.handleMergeContext(client, message);
				break;

			case 'transfer_context':
				this.handleTransferContext(client, message);
				break;

			case 'summarize_context':
				this.handleSummarizeContext(client, message);
				break;

			case 'create_gist':
				this.handleCreateGist(client, message);
				break;

			case 'get_cue_subscriptions':
				this.handleGetCueSubscriptions(client, message);
				break;

			case 'toggle_cue_subscription':
				this.handleToggleCueSubscription(client, message);
				break;

			case 'get_cue_activity':
				this.handleGetCueActivity(client, message);
				break;

			case 'trigger_cue_subscription':
				this.handleTriggerCueSubscription(client, message);
				break;

			case 'get_usage_dashboard':
				this.handleGetUsageDashboard(client, message);
				break;

			case 'get_achievements':
				this.handleGetAchievements(client, message);
				break;

			case 'generate_director_notes_synopsis':
				this.handleGenerateDirectorNotesSynopsis(client, message);
				break;

			case 'terminal_write':
				this.handleTerminalWrite(client, message);
				break;

			case 'terminal_resize':
				this.handleTerminalResize(client, message);
				break;

			case 'notify_toast':
				this.handleNotifyToast(client, message);
				break;

			case 'notify_center_flash':
				this.handleNotifyCenterFlash(client, message);
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
		this.send(client, {
			type: 'subscribed',
			sessionId: message.sessionId,
			requestId: message.requestId,
		});
	}

	/**
	 * Handle send_command message - execute command in session
	 */
	private handleSendCommand(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const command = message.command as string;
		// inputMode from web client - use this instead of server state to avoid sync issues
		const clientInputMode = message.inputMode as 'ai' | 'terminal' | undefined;
		// Optional explicit tab target. When omitted, the renderer falls back to
		// the active tab (legacy `send --live` behavior). Used by
		// `maestro-cli dispatch --session <tabId>` to address a specific tab.
		const requestedTabId = typeof message.tabId === 'string' ? message.tabId : undefined;
		// force=true bypasses the busy-state guard below, allowing callers to
		// dispatch concurrent writes to an already-running agent. Used by
		// `maestro-cli dispatch --force`.
		const force = message.force === true;
		// Optional base64 data URLs pasted from the web client. Threaded through
		// to the renderer so AI tabs can include them in the agent prompt.
		const images = Array.isArray(message.images)
			? (message.images as unknown[]).filter((v): v is string => typeof v === 'string')
			: undefined;

		logger.info(
			`[Web Command] Received: sessionId=${sessionId}, inputMode=${clientInputMode}, command=${command?.substring(0, 50)}, images=${images?.length ?? 0}`,
			LOG_CONTEXT
		);

		// Image-only sends are valid in AI mode (the composer lets users paste
		// images and submit without typing), so the guard accepts either a
		// non-empty command OR at least one image. Normalize a missing command
		// to '' so the renderer's downstream LogEntry.text stays a string.
		const hasImages = !!images && images.length > 0;
		if (!sessionId || (!command && !hasImages)) {
			logger.warn(
				`[Web Command] Missing sessionId or command/images: sessionId=${sessionId}, commandLen=${command?.length}, images=${images?.length ?? 0}`,
				LOG_CONTEXT
			);
			this.sendError(client, 'Missing sessionId or command');
			return;
		}
		const effectiveCommand = command ?? '';

		// Get session details to check state and determine how to handle
		const sessionDetail = this.callbacks.getSessionDetail?.(sessionId);
		if (!sessionDetail) {
			this.sendError(client, 'Session not found');
			return;
		}

		// Check if session is busy - prevent race conditions between desktop and web.
		// `force: true` opts out of this guard (see `maestro-cli send --live --force`).
		if (sessionDetail.state === 'busy' && !force) {
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
		if (sessionDetail.state === 'busy' && force) {
			logger.info(`[Web Command] Force-dispatching to busy session ${sessionId}`, LOG_CONTEXT);
		}

		// Use client's inputMode if provided, otherwise fall back to server state
		const effectiveMode = clientInputMode || sessionDetail.inputMode;
		const isAiMode = effectiveMode === 'ai';
		const mode = isAiMode ? 'AI' : 'CLI';
		const claudeId = sessionDetail.agentSessionId || 'none';

		// Log all web interface commands prominently
		logger.info(
			`[Web Command] Mode: ${mode} | Session: ${sessionId}${isAiMode ? ` | Claude: ${claudeId}` : ''} | Message: ${effectiveCommand} | Images: ${images?.length ?? 0}`,
			LOG_CONTEXT
		);

		// Only echo a tabId in command_result when the caller passed one
		// explicitly. Returning the server's snapshot of `activeTabId` for the
		// no-tabId path would lie when the user switches active tabs between
		// the IPC send and IPC receive — callers chaining `dispatch --session
		// <returnedTabId>` would think they are continuing a conversation that
		// actually went to a different tab. For deterministic addressing,
		// callers should use `dispatch --new-tab` (returns the new tabId from
		// the renderer ack) and then `dispatch --session <tabId>` (echoes back
		// the caller-supplied authoritative tabId).
		const resolvedTabId = requestedTabId;

		// Route ALL commands through the renderer for consistent handling
		// The renderer handles both AI and terminal modes, updating UI and state
		// Pass clientInputMode so renderer uses the web's intended mode
		if (this.callbacks.executeCommand) {
			this.callbacks
				.executeCommand(sessionId, effectiveCommand, clientInputMode, requestedTabId, force, images)
				.then((success) => {
					this.send(client, {
						type: 'command_result',
						success,
						sessionId,
						...(resolvedTabId ? { tabId: resolvedTabId } : {}),
						requestId: message.requestId,
					});
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
	 *
	 * When switching to terminal mode, spawns a dedicated PTY process for the web client
	 * (session ID: {sessionId}-terminal). When switching back to AI, kills it.
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
			.then(async (success) => {
				// Spawn or kill the web terminal PTY based on mode
				if (success && mode === 'terminal') {
					// Look up session CWD for the terminal working directory
					const sessionDetail = this.callbacks.getSessionDetail?.(sessionId);
					const cwd = sessionDetail?.cwd || process.cwd();
					try {
						const spawnResult = await this.callbacks.spawnTerminalForWeb?.(sessionId, { cwd });
						logger.info(
							`[Web] Terminal PTY spawn for ${sessionId}: success=${spawnResult?.success}`,
							LOG_CONTEXT
						);
						if (spawnResult?.success) {
							// Notify the web client that the PTY is ready so it can re-send
							// its current dimensions (the initial resize fired before the PTY existed)
							this.send(client, {
								type: 'terminal_ready',
								sessionId,
							});
						} else {
							// PTY failed to spawn — report failure so the client can roll back
							this.send(client, {
								type: 'mode_switch_result',
								success: false,
								sessionId,
								mode,
								error: 'Failed to spawn terminal PTY',
								requestId: message.requestId,
							});
							return;
						}
					} catch (err) {
						logger.error(
							`[Web] Failed to spawn terminal PTY for ${sessionId}: ${err}`,
							LOG_CONTEXT
						);
						this.send(client, {
							type: 'mode_switch_result',
							success: false,
							sessionId,
							mode,
							error: `Failed to spawn terminal: ${err instanceof Error ? err.message : String(err)}`,
							requestId: message.requestId,
						});
						return;
					}
				}
				// When switching back to AI, keep the terminal PTY alive so the user
				// can return to a running process (e.g. npm run dev). The PTY is only
				// killed when the session itself is removed.

				this.send(client, {
					type: 'mode_switch_result',
					success,
					sessionId,
					mode,
					requestId: message.requestId,
				});
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
		const focus = message.focus as boolean | undefined;
		logger.info(
			`[Web] Received select_session message: session=${sessionId}, tab=${tabId || 'none'}, focus=${focus || false}`,
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
			.selectSession(sessionId, tabId, focus)
			.then((success) => {
				if (success) {
					// Subscribe client to this session's output so they receive session_output messages
					client.subscribedSessionId = sessionId;
					logger.debug(`Session ${sessionId} selected in desktop, client subscribed`, LOG_CONTEXT);
				} else {
					logger.warn(`Failed to select session ${sessionId} in desktop`, LOG_CONTEXT);
				}
				this.send(client, {
					type: 'select_session_result',
					success,
					sessionId,
					requestId: message.requestId,
				});
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
				this.send(client, {
					type: 'select_tab_result',
					success,
					sessionId,
					tabId,
					requestId: message.requestId,
				});
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
					requestId: message.requestId,
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
				this.send(client, {
					type: 'close_tab_result',
					success,
					sessionId,
					tabId,
					requestId: message.requestId,
				});
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
					requestId: message.requestId,
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
				this.send(client, {
					type: 'star_tab_result',
					success,
					sessionId,
					tabId,
					starred,
					requestId: message.requestId,
				});
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
					requestId: message.requestId,
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
				this.send(client, {
					type: 'toggle_bookmark_result',
					success,
					sessionId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to toggle bookmark: ${error.message}`);
			});
	}

	/**
	 * Handle refresh_file_tree message - refresh the file tree for a session
	 */
	private handleRefreshFileTree(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		logger.info(`[Web] Received refresh_file_tree message: session=${sessionId}`, LOG_CONTEXT);

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!this.callbacks.refreshFileTree) {
			this.sendError(client, 'File tree refresh not configured');
			return;
		}

		this.callbacks
			.refreshFileTree(sessionId)
			.then((success) => {
				this.send(client, {
					type: 'refresh_file_tree_result',
					success,
					sessionId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to refresh file tree: ${error.message}`);
			});
	}

	/**
	 * Handle get_file_tree message - read directory tree for file explorer
	 * Uses Node.js fs directly (no IPC to renderer needed)
	 */
	private handleGetFileTree(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const dirPath = message.path as string;
		const maxDepth = Math.min((message.maxDepth as number) || 3, 5);

		if (!dirPath) {
			this.sendError(client, 'Missing path for get_file_tree');
			return;
		}

		// Validate dirPath is within the session's working directory
		const sessionDetail = this.callbacks.getSessionDetail?.(sessionId);
		if (!sessionDetail?.cwd) {
			this.sendError(client, 'Cannot resolve session working directory');
			return;
		}
		const resolvedDir = path.resolve(dirPath);
		const resolvedCwd = path.resolve(sessionDetail.cwd);
		if (!resolvedDir.startsWith(resolvedCwd + path.sep) && resolvedDir !== resolvedCwd) {
			this.sendError(client, 'Requested path is outside the session working directory');
			return;
		}

		this.buildFileTree(dirPath, maxDepth)
			.then((tree) => {
				this.send(client, {
					type: 'file_tree_data',
					sessionId,
					tree,
					path: dirPath,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.send(client, {
					type: 'file_tree_data',
					sessionId,
					tree: [],
					error: error.message,
					path: dirPath,
					requestId: message.requestId,
				});
			});
	}

	/**
	 * Recursively build a file tree from a directory path
	 */
	private async buildFileTree(
		dirPath: string,
		maxDepth: number,
		currentDepth = 0
	): Promise<
		Array<{
			name: string;
			type: 'file' | 'folder';
			children?: Array<{ name: string; type: 'file' | 'folder'; children?: any[]; path: string }>;
			path: string;
		}>
	> {
		// Common ignore patterns
		const IGNORE = new Set([
			'node_modules',
			'.git',
			'.next',
			'.nuxt',
			'dist',
			'build',
			'.cache',
			'__pycache__',
			'.tox',
			'.mypy_cache',
			'.pytest_cache',
			'venv',
			'.venv',
			'target',
			'.idea',
			'.vscode',
			'.DS_Store',
			'Thumbs.db',
			'.turbo',
			'coverage',
			'.nyc_output',
			'.parcel-cache',
			'.svelte-kit',
		]);

		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true });
			const result: Array<{
				name: string;
				type: 'file' | 'folder';
				children?: any[];
				path: string;
			}> = [];

			// Sort: folders first, then alphabetically
			const sorted = entries
				.filter((e) => !IGNORE.has(e.name) && !e.name.startsWith('.'))
				.sort((a, b) => {
					if (a.isDirectory() && !b.isDirectory()) return -1;
					if (!a.isDirectory() && b.isDirectory()) return 1;
					return a.name.localeCompare(b.name);
				});

			for (const entry of sorted) {
				const fullPath = path.join(dirPath, entry.name);

				if (entry.isDirectory()) {
					const children =
						currentDepth < maxDepth
							? await this.buildFileTree(fullPath, maxDepth, currentDepth + 1)
							: undefined;
					result.push({
						name: entry.name,
						type: 'folder',
						children,
						path: fullPath,
					});
				} else {
					result.push({
						name: entry.name,
						type: 'file',
						path: fullPath,
					});
				}
			}

			return result;
		} catch {
			// Permission denied or other errors — return empty
			return [];
		}
	}

	/**
	 * Handle refresh_auto_run_docs message - refresh auto-run documents for a session
	 */
	private handleRefreshAutoRunDocs(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		logger.info(`[Web] Received refresh_auto_run_docs message: session=${sessionId}`, LOG_CONTEXT);

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!this.callbacks.refreshAutoRunDocs) {
			this.sendError(client, 'Auto-run docs refresh not configured');
			return;
		}

		this.callbacks
			.refreshAutoRunDocs(sessionId)
			.then((success) => {
				this.send(client, {
					type: 'refresh_auto_run_docs_result',
					success,
					sessionId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to refresh auto-run docs: ${error.message}`);
			});
	}

	/**
	 * Handle configure_auto_run message - configure and optionally launch an auto-run
	 */
	private handleConfigureAutoRun(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const documents = message.documents as
			| Array<{ filename: string; resetOnCompletion?: boolean }>
			| undefined;
		logger.info(
			`[Web] Received configure_auto_run message: session=${sessionId}, documents=${documents?.length || 0}`,
			LOG_CONTEXT
		);

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!documents || !Array.isArray(documents) || documents.length === 0) {
			this.sendError(client, 'Missing or empty documents array');
			return;
		}

		// Validate each document entry
		for (const doc of documents) {
			if (typeof doc !== 'object' || doc === null) {
				this.sendError(client, 'Each document must be an object');
				return;
			}
			if (typeof doc.filename !== 'string' || doc.filename.trim() === '') {
				this.sendError(client, 'Each document must have a non-empty string filename');
				return;
			}
			if (doc.resetOnCompletion !== undefined && typeof doc.resetOnCompletion !== 'boolean') {
				this.sendError(client, 'resetOnCompletion must be a boolean if provided');
				return;
			}
		}

		if (!this.callbacks.configureAutoRun) {
			this.sendError(client, 'Auto-run configuration not configured');
			return;
		}

		// Validate and coerce optional config fields at the WebSocket boundary
		if (message.loopEnabled !== undefined && typeof message.loopEnabled !== 'boolean') {
			this.sendError(client, 'loopEnabled must be a boolean');
			return;
		}
		if (message.maxLoops !== undefined) {
			const maxLoops = Number(message.maxLoops);
			if (!Number.isFinite(maxLoops) || maxLoops < 0) {
				this.sendError(client, 'maxLoops must be a finite non-negative number');
				return;
			}
		}
		if (message.launch !== undefined && typeof message.launch !== 'boolean') {
			this.sendError(client, 'launch must be a boolean');
			return;
		}
		if (
			message.saveAsPlaybook !== undefined &&
			(typeof message.saveAsPlaybook !== 'string' || message.saveAsPlaybook.trim() === '')
		) {
			this.sendError(client, 'saveAsPlaybook must be a non-empty string');
			return;
		}

		// Validate optional worktree config — desktop app uses this to create a
		// git worktree, checkout the branch, and optionally open a PR on completion.
		let worktree:
			| {
					enabled: boolean;
					path: string;
					branchName: string;
					createPROnCompletion: boolean;
					prTargetBranch: string;
			  }
			| undefined;
		if (message.worktree !== undefined) {
			const w = message.worktree as Record<string, unknown> | null;
			if (typeof w !== 'object' || w === null) {
				this.sendError(client, 'worktree must be an object');
				return;
			}
			if (typeof w.enabled !== 'boolean') {
				this.sendError(client, 'worktree.enabled must be a boolean');
				return;
			}
			if (typeof w.path !== 'string' || w.path.trim() === '') {
				this.sendError(client, 'worktree.path must be a non-empty string');
				return;
			}
			if (typeof w.branchName !== 'string' || w.branchName.trim() === '') {
				this.sendError(client, 'worktree.branchName must be a non-empty string');
				return;
			}
			if (w.createPROnCompletion !== undefined && typeof w.createPROnCompletion !== 'boolean') {
				this.sendError(client, 'worktree.createPROnCompletion must be a boolean');
				return;
			}
			if (w.prTargetBranch !== undefined && typeof w.prTargetBranch !== 'string') {
				this.sendError(client, 'worktree.prTargetBranch must be a string');
				return;
			}
			worktree = {
				enabled: w.enabled,
				path: w.path,
				branchName: w.branchName,
				createPROnCompletion: Boolean(w.createPROnCompletion),
				prTargetBranch: (w.prTargetBranch as string | undefined) ?? '',
			};
		}

		const config = {
			documents,
			prompt: message.prompt as string | undefined,
			loopEnabled: message.loopEnabled as boolean | undefined,
			maxLoops: message.maxLoops !== undefined ? Number(message.maxLoops) : undefined,
			saveAsPlaybook: message.saveAsPlaybook as string | undefined,
			launch: message.launch as boolean | undefined,
			worktree,
		};

		this.callbacks
			.configureAutoRun(sessionId, config)
			.then((result) => {
				this.send(client, {
					type: 'configure_auto_run_result',
					success: result.success,
					playbookId: result.playbookId,
					error: result.error,
					sessionId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to configure auto-run: ${error.message}`);
			});
	}

	/**
	 * Handle open_file_tab message - open a file in a preview tab
	 */
	private handleOpenFileTab(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const filePath = message.filePath as string;
		logger.info(
			`[Web] Received open_file_tab message: session=${sessionId}, filePath=${filePath}`,
			LOG_CONTEXT
		);

		// Helper to send typed error responses with requestId (prevents client timeouts)
		const sendErrorResult = (error: string) => {
			this.send(client, {
				type: 'open_file_tab_result',
				success: false,
				error,
				sessionId,
				requestId: message.requestId,
			});
		};

		if (!sessionId || !filePath) {
			sendErrorResult('Missing sessionId or filePath');
			return;
		}

		// Path traversal protection: resolve against session root
		const sessions = this.callbacks.getSessions?.();
		const session = sessions?.find((s) => s.id === sessionId);
		if (!session?.cwd) {
			sendErrorResult('Session not found or has no working directory');
			return;
		}
		const sessionRoot = path.resolve(session.cwd);
		const resolved = path.resolve(sessionRoot, filePath);
		if (!resolved.startsWith(sessionRoot + path.sep) && resolved !== sessionRoot) {
			sendErrorResult('Invalid file path: path is outside the agent working directory');
			return;
		}

		if (!this.callbacks.openFileTab) {
			sendErrorResult('File tab opening not configured');
			return;
		}

		this.callbacks
			.openFileTab(sessionId, resolved)
			.then((success) => {
				this.send(client, {
					type: 'open_file_tab_result',
					success,
					sessionId,
					filePath,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				sendErrorResult(`Failed to open file tab: ${error.message}`);
			});
	}

	/**
	 * Handle open_browser_tab message - open a URL in a browser tab
	 */
	private handleOpenBrowserTab(client: WebClient, message: WebClientMessage): void {
		const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
		const url = typeof message.url === 'string' ? message.url : '';
		// URLs can embed bearer tokens or session IDs — log length only.
		logger.info(
			`[Web] Received open_browser_tab message: session=${sessionId}, urlLength=${url.length}`,
			LOG_CONTEXT
		);

		const sendErrorResult = (error: string) => {
			this.send(client, {
				type: 'open_browser_tab_result',
				success: false,
				error,
				sessionId,
				requestId: message.requestId,
			});
		};

		if (!sessionId || !url) {
			sendErrorResult('Missing sessionId or url');
			return;
		}

		const session = this.callbacks.getSessions?.().find((s) => s.id === sessionId);
		if (!session) {
			sendErrorResult('Session not found');
			return;
		}

		// Only http(s) URLs are allowed in browser tabs; everything else is rejected
		// (mailto:, file:, javascript:, etc. would be unsafe or nonsensical here).
		// Normalize bare host:port inputs (e.g. `localhost:3000`) to http:// so
		// WHATWG URL parsing doesn't mistake the host for a protocol.
		const trimmedUrl = url.trim();
		const hasExplicitScheme = trimmedUrl.includes('://');
		const candidate = hasExplicitScheme ? trimmedUrl : `http://${trimmedUrl}`;
		let parsed: URL;
		try {
			parsed = new URL(candidate);
		} catch {
			sendErrorResult('Invalid URL');
			return;
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			sendErrorResult(`Unsupported URL protocol: ${parsed.protocol}`);
			return;
		}
		// A bare input that parses with userinfo is almost certainly malformed
		// (e.g. `foo:bar@baz` accidentally looking like `user:pass@host`).
		if (!hasExplicitScheme && (parsed.username || parsed.password)) {
			sendErrorResult('Invalid URL');
			return;
		}

		if (!this.callbacks.openBrowserTab) {
			sendErrorResult('Browser tab opening not configured');
			return;
		}

		this.callbacks
			.openBrowserTab(sessionId, parsed.toString())
			.then((success) => {
				this.send(client, {
					type: 'open_browser_tab_result',
					success,
					sessionId,
					url: parsed.toString(),
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				sendErrorResult(`Failed to open browser tab: ${error.message}`);
			});
	}

	/**
	 * Handle open_terminal_tab message - open a new terminal tab
	 */
	private async handleOpenTerminalTab(client: WebClient, message: WebClientMessage): Promise<void> {
		const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
		const rawCwd = message.cwd;
		const rawShell = message.shell;
		const rawName = message.name;
		// cwd/shell/name can leak local usernames or project names — log
		// presence flags only.
		logger.info(
			`[Web] Received open_terminal_tab message: session=${sessionId}, cwdProvided=${
				typeof rawCwd === 'string' && rawCwd.length > 0
			}, shellProvided=${
				typeof rawShell === 'string' && rawShell.length > 0
			}, nameProvided=${rawName !== undefined}`,
			LOG_CONTEXT
		);

		const sendErrorResult = (error: string) => {
			this.send(client, {
				type: 'open_terminal_tab_result',
				success: false,
				error,
				sessionId,
				requestId: message.requestId,
			});
		};

		if (!sessionId) {
			sendErrorResult('Missing sessionId');
			return;
		}

		// Reject malformed optional fields rather than silently defaulting them,
		// which could spawn a terminal in the wrong cwd or with the wrong shell.
		if (rawCwd !== undefined && typeof rawCwd !== 'string') {
			sendErrorResult('Invalid cwd: must be a string');
			return;
		}
		if (rawShell !== undefined && typeof rawShell !== 'string') {
			sendErrorResult('Invalid shell: must be a string');
			return;
		}
		if (rawName !== undefined && rawName !== null && typeof rawName !== 'string') {
			sendErrorResult('Invalid name: must be a string or null');
			return;
		}
		const cwd = typeof rawCwd === 'string' ? rawCwd : undefined;
		const shell = typeof rawShell === 'string' ? rawShell : undefined;
		const name = typeof rawName === 'string' ? rawName : rawName === null ? null : undefined;

		const session = this.callbacks.getSessions?.().find((s) => s.id === sessionId);
		if (!session) {
			sendErrorResult('Session not found');
			return;
		}

		// If a cwd is provided, confine it to the agent working directory
		// (same rule as open_file_tab — prevents spawning a shell outside scope).
		// Resolve symlinks via fs.realpath so a `link-to-outside` inside the
		// session root can't slip past the lexical prefix check.
		let resolvedCwd: string | undefined;
		if (cwd) {
			if (!session.cwd) {
				sendErrorResult('Session has no working directory');
				return;
			}
			let sessionRoot: string;
			let resolved: string;
			try {
				sessionRoot = await fs.realpath(path.resolve(session.cwd));
				resolved = await fs.realpath(path.resolve(sessionRoot, cwd));
			} catch {
				sendErrorResult('Invalid cwd');
				return;
			}
			if (!resolved.startsWith(sessionRoot + path.sep) && resolved !== sessionRoot) {
				sendErrorResult('Invalid cwd: path is outside the agent working directory');
				return;
			}
			resolvedCwd = resolved;
		}

		if (!this.callbacks.openTerminalTab) {
			sendErrorResult('Terminal tab opening not configured');
			return;
		}

		this.callbacks
			.openTerminalTab(sessionId, { cwd: resolvedCwd, shell, name })
			.then((success) => {
				this.send(client, {
					type: 'open_terminal_tab_result',
					success,
					sessionId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				sendErrorResult(`Failed to open terminal tab: ${error.message}`);
			});
	}

	/**
	 * Handle new_ai_tab_with_prompt message - atomically create a new AI tab
	 * and dispatch an initial prompt into it. Used by `send --live --new-tab`
	 * to guarantee a fresh conversation rather than writing into whichever tab
	 * happens to be active.
	 */
	private handleNewAITabWithPrompt(client: WebClient, message: WebClientMessage): void {
		const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
		const prompt = typeof message.prompt === 'string' ? message.prompt : '';
		// Prompts can contain user-authored content with secrets or PII —
		// log length only rather than a raw preview.
		logger.info(
			`[Web] Received new_ai_tab_with_prompt message: session=${sessionId}, promptLength=${prompt.length}`,
			LOG_CONTEXT
		);

		const sendErrorResult = (error: string) => {
			this.send(client, {
				type: 'new_ai_tab_with_prompt_result',
				success: false,
				error,
				sessionId,
				requestId: message.requestId,
			});
		};

		if (!sessionId || !prompt) {
			sendErrorResult('Missing sessionId or prompt');
			return;
		}

		const session = this.callbacks.getSessions?.().find((s) => s.id === sessionId);
		if (!session) {
			sendErrorResult('Session not found');
			return;
		}

		if (!this.callbacks.newAITabWithPrompt) {
			sendErrorResult('New AI tab with prompt not configured');
			return;
		}

		this.callbacks
			.newAITabWithPrompt(sessionId, prompt)
			.then((result) => {
				this.send(client, {
					type: 'new_ai_tab_with_prompt_result',
					success: result.success,
					sessionId,
					...(result.tabId ? { tabId: result.tabId } : {}),
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				sendErrorResult(`Failed to create AI tab with prompt: ${error.message}`);
			});
	}

	/**
	 * Validate that a filename does not contain path traversal sequences.
	 * Returns true if the filename is safe, false otherwise.
	 */
	private isValidFilename(filename: string): boolean {
		return (
			typeof filename === 'string' &&
			filename.length > 0 &&
			!filename.includes('..') &&
			!filename.includes('/') &&
			!filename.includes('\\')
		);
	}

	/**
	 * Handle get_auto_run_docs message - list Auto Run documents for a session
	 */
	private handleGetAutoRunDocs(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		logger.info(`[Web] Received get_auto_run_docs message: session=${sessionId}`, LOG_CONTEXT);

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!this.callbacks.getAutoRunDocs) {
			this.sendError(client, 'Auto-run docs listing not configured');
			return;
		}

		this.callbacks
			.getAutoRunDocs(sessionId)
			.then((documents) => {
				this.send(client, {
					type: 'auto_run_docs',
					sessionId,
					documents,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to get auto-run docs: ${error.message}`);
			});
	}

	/**
	 * Handle get_auto_run_state message - get current Auto Run state for a session
	 */
	private handleGetAutoRunState(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		logger.info(`[Web] Received get_auto_run_state message: session=${sessionId}`, LOG_CONTEXT);

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!this.callbacks.getSessionDetail) {
			this.sendError(client, 'Session detail not configured');
			return;
		}

		const detail = this.callbacks.getSessionDetail(sessionId);
		const state: AutoRunState | null =
			((detail as any)?.autoRunState as AutoRunState | null) ?? null;

		this.send(client, {
			type: 'auto_run_state',
			sessionId,
			state,
			requestId: message.requestId,
		});
	}

	/**
	 * Handle get_auto_run_document message - read content of a specific Auto Run document
	 */
	private handleGetAutoRunDocument(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const filename = message.filename as string;
		logger.info(
			`[Web] Received get_auto_run_document message: session=${sessionId}, filename=${filename}`,
			LOG_CONTEXT
		);

		if (!sessionId || !filename) {
			this.sendError(client, 'Missing sessionId or filename');
			return;
		}

		if (!this.isValidFilename(filename)) {
			this.sendError(
				client,
				'Invalid filename: must not contain path separators or traversal sequences'
			);
			return;
		}

		if (!this.callbacks.getAutoRunDocContent) {
			this.sendError(client, 'Auto-run document reading not configured');
			return;
		}

		this.callbacks
			.getAutoRunDocContent(sessionId, filename)
			.then((content) => {
				this.send(client, {
					type: 'auto_run_document_content',
					sessionId,
					filename,
					content,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to read auto-run document: ${error.message}`);
			});
	}

	/**
	 * Handle save_auto_run_document message - write content to a specific Auto Run document
	 */
	private handleSaveAutoRunDocument(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const filename = message.filename as string;
		const content = message.content as string;
		logger.info(
			`[Web] Received save_auto_run_document message: session=${sessionId}, filename=${filename}`,
			LOG_CONTEXT
		);

		if (!sessionId || !filename) {
			this.sendError(client, 'Missing sessionId or filename');
			return;
		}

		if (typeof content !== 'string') {
			this.sendError(client, 'Missing or invalid content');
			return;
		}

		if (!this.isValidFilename(filename)) {
			this.sendError(
				client,
				'Invalid filename: must not contain path separators or traversal sequences'
			);
			return;
		}

		if (!this.callbacks.saveAutoRunDoc) {
			this.sendError(client, 'Auto-run document saving not configured');
			return;
		}

		this.callbacks
			.saveAutoRunDoc(sessionId, filename, content)
			.then((success) => {
				this.send(client, {
					type: 'save_auto_run_document_result',
					success,
					sessionId,
					filename,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to save auto-run document: ${error.message}`);
			});
	}

	/**
	 * Handle stop_auto_run message - stop an active Auto Run for a session
	 */
	private handleStopAutoRun(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		logger.info(`[Web] Received stop_auto_run message: session=${sessionId}`, LOG_CONTEXT);

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!this.callbacks.stopAutoRun) {
			this.sendError(client, 'Auto-run stopping not configured');
			return;
		}

		this.callbacks
			.stopAutoRun(sessionId)
			.then((success) => {
				this.send(client, {
					type: 'stop_auto_run_result',
					success,
					sessionId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to stop auto-run: ${error.message}`);
			});
	}

	/**
	 * Allowlist of setting keys modifiable from the web interface.
	 */
	private static readonly ALLOWED_SETTING_KEYS = new Set([
		'activeThemeId',
		'fontSize',
		'enterToSendAI',
		'defaultSaveToHistory',
		'defaultShowThinking',
		'notificationsEnabled',
		'audioFeedbackEnabled',
		'colorBlindMode',
		'conductorProfile',
		'maxOutputLines',
	]);

	/**
	 * Handle get_settings message - return current settings
	 */
	private handleGetSettings(client: WebClient, message: WebClientMessage): void {
		if (!this.callbacks.getSettings) {
			this.sendError(client, 'Settings not configured');
			return;
		}

		const settings = this.callbacks.getSettings();
		this.send(client, {
			type: 'settings',
			settings,
			requestId: message.requestId,
		});
	}

	/**
	 * Handle set_setting message - modify a single setting
	 */
	private handleSetSetting(client: WebClient, message: WebClientMessage): void {
		const key = message.key as string;
		const value = message.value as SettingValue;

		if (!key || typeof key !== 'string') {
			this.sendError(client, 'Missing or invalid setting key');
			return;
		}

		if (!WebSocketMessageHandler.ALLOWED_SETTING_KEYS.has(key)) {
			this.sendError(client, `Setting key '${key}' is not modifiable from the web interface`);
			return;
		}

		if (value === undefined) {
			this.sendError(client, 'Missing setting value');
			return;
		}

		if (!this.callbacks.setSetting) {
			this.sendError(client, 'Setting modification not configured');
			return;
		}

		this.callbacks
			.setSetting(key, value)
			.then((success) => {
				this.send(client, {
					type: 'set_setting_result',
					success,
					key,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to set setting: ${error.message}`);
			});
	}

	/**
	 * Known agent types for validation — derived from the canonical AGENT_IDS list.
	 * Excludes 'terminal' since it's an internal-only agent type.
	 */
	private static readonly VALID_AGENT_TYPES: Set<string> = new Set(
		AGENT_IDS.filter((id) => id !== 'terminal')
	);

	/**
	 * Handle create_session message - create a new agent session
	 */
	private handleCreateSession(client: WebClient, message: WebClientMessage): void {
		const name = message.name as string;
		const toolType = message.toolType as string;
		const cwd = message.cwd as string;
		const groupId = message.groupId as string | undefined;

		if (!name || typeof name !== 'string') {
			this.sendError(client, 'Missing or invalid name');
			return;
		}

		if (!toolType || !WebSocketMessageHandler.VALID_AGENT_TYPES.has(toolType)) {
			this.sendError(
				client,
				`Invalid toolType. Must be one of: ${[...WebSocketMessageHandler.VALID_AGENT_TYPES].join(', ')}`
			);
			return;
		}

		if (!cwd || typeof cwd !== 'string') {
			this.sendError(client, 'Missing or invalid cwd');
			return;
		}

		if (!this.callbacks.createSession) {
			this.sendError(client, 'Session creation not configured');
			return;
		}

		// Extract optional config fields
		const config: CreateSessionConfig = {};
		if (message.nudgeMessage) config.nudgeMessage = message.nudgeMessage as string;
		if (message.newSessionMessage) config.newSessionMessage = message.newSessionMessage as string;
		if (message.customPath) config.customPath = message.customPath as string;
		if (message.customArgs) config.customArgs = message.customArgs as string;
		if (message.customEnvVars)
			config.customEnvVars = message.customEnvVars as Record<string, string>;
		if (message.customModel) config.customModel = message.customModel as string;
		if (message.customEffort) config.customEffort = message.customEffort as string;
		if (message.customContextWindow)
			config.customContextWindow = message.customContextWindow as number;
		if (message.customProviderPath)
			config.customProviderPath = message.customProviderPath as string;
		if (message.sessionSshRemoteConfig) {
			config.sessionSshRemoteConfig =
				message.sessionSshRemoteConfig as CreateSessionConfig['sessionSshRemoteConfig'];
		}
		// autoRunFolderPath can be set outside of the agent's cwd (no confinement needed)
		if (message.autoRunFolderPath) config.autoRunFolderPath = message.autoRunFolderPath as string;
		const hasConfig = Object.keys(config).length > 0;

		this.callbacks
			.createSession(name, toolType, cwd, groupId, hasConfig ? config : undefined)
			.then((result) => {
				this.send(client, {
					type: 'create_session_result',
					success: !!result,
					sessionId: result?.sessionId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to create session: ${error.message}`);
			});
	}

	/**
	 * Handle delete_session message - delete an agent session
	 */
	private handleDeleteSession(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!this.callbacks.deleteSession) {
			this.sendError(client, 'Session deletion not configured');
			return;
		}

		this.callbacks
			.deleteSession(sessionId)
			.then((success) => {
				this.send(client, {
					type: 'delete_session_result',
					success,
					sessionId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to delete session: ${error.message}`);
			});
	}

	/**
	 * Handle rename_session message - rename an agent session
	 */
	private handleRenameSession(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const newName = message.newName as string;

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!newName || typeof newName !== 'string' || newName.length === 0) {
			this.sendError(client, 'Missing or empty newName');
			return;
		}

		if (newName.length > 100) {
			this.sendError(client, 'newName must be 100 characters or less');
			return;
		}

		if (!this.callbacks.renameSession) {
			this.sendError(client, 'Session renaming not configured');
			return;
		}

		this.callbacks
			.renameSession(sessionId, newName)
			.then((success) => {
				this.send(client, {
					type: 'rename_session_result',
					success,
					sessionId,
					newName,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to rename session: ${error.message}`);
			});
	}

	/**
	 * Handle get_groups message - return list of groups
	 */
	private handleGetGroups(client: WebClient, message: WebClientMessage): void {
		if (!this.callbacks.getGroups) {
			this.sendError(client, 'Groups not configured');
			return;
		}

		const groups = this.callbacks.getGroups();
		this.send(client, {
			type: 'groups_list',
			groups,
			requestId: message.requestId,
		});
	}

	/**
	 * Handle create_group message - create a new group
	 */
	private handleCreateGroup(client: WebClient, message: WebClientMessage): void {
		const name = message.name as string;
		const emoji = message.emoji as string | undefined;

		if (!name || typeof name !== 'string') {
			this.sendError(client, 'Missing or invalid group name');
			return;
		}

		if (!this.callbacks.createGroup) {
			this.sendError(client, 'Group creation not configured');
			return;
		}

		this.callbacks
			.createGroup(name, emoji)
			.then((result) => {
				this.send(client, {
					type: 'create_group_result',
					success: !!result,
					groupId: result?.id,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to create group: ${error.message}`);
			});
	}

	/**
	 * Handle rename_group message - rename a group
	 */
	private handleRenameGroup(client: WebClient, message: WebClientMessage): void {
		const groupId = message.groupId as string;
		const name = message.name as string;

		if (!groupId) {
			this.sendError(client, 'Missing groupId');
			return;
		}

		if (!name || typeof name !== 'string') {
			this.sendError(client, 'Missing or invalid group name');
			return;
		}

		if (!this.callbacks.renameGroup) {
			this.sendError(client, 'Group renaming not configured');
			return;
		}

		this.callbacks
			.renameGroup(groupId, name)
			.then((success) => {
				this.send(client, {
					type: 'rename_group_result',
					success,
					groupId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to rename group: ${error.message}`);
			});
	}

	/**
	 * Handle delete_group message - delete a group
	 */
	private handleDeleteGroup(client: WebClient, message: WebClientMessage): void {
		const groupId = message.groupId as string;

		if (!groupId) {
			this.sendError(client, 'Missing groupId');
			return;
		}

		if (!this.callbacks.deleteGroup) {
			this.sendError(client, 'Group deletion not configured');
			return;
		}

		this.callbacks
			.deleteGroup(groupId)
			.then((success) => {
				this.send(client, {
					type: 'delete_group_result',
					success,
					groupId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to delete group: ${error.message}`);
			});
	}

	/**
	 * Handle move_session_to_group message - move a session to a group (or ungrouped)
	 */
	private handleMoveSessionToGroup(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const groupId = message.groupId as string | null;

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		// groupId can be null (for ungrouped), but must be present in message
		if (!('groupId' in message)) {
			this.sendError(client, 'Missing groupId (use null for ungrouped)');
			return;
		}

		if (!this.callbacks.moveSessionToGroup) {
			this.sendError(client, 'Move to group not configured');
			return;
		}

		this.callbacks
			.moveSessionToGroup(sessionId, groupId)
			.then((success) => {
				this.send(client, {
					type: 'move_session_to_group_result',
					success,
					sessionId,
					groupId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to move session to group: ${error.message}`);
			});
	}

	/**
	 * Handle get_git_status message - fetch git status for a session
	 */
	private handleGetGitStatus(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!this.callbacks.getGitStatus) {
			this.sendError(client, 'Git status not configured');
			return;
		}

		this.callbacks
			.getGitStatus(sessionId)
			.then((status) => {
				this.send(client, {
					type: 'git_status',
					sessionId,
					status,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to get git status: ${error.message}`);
			});
	}

	/**
	 * Handle get_git_diff message - fetch git diff for a session
	 */
	private handleGetGitDiff(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const filePath = message.filePath as string | undefined;

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!this.callbacks.getGitDiff) {
			this.sendError(client, 'Git diff not configured');
			return;
		}

		this.callbacks
			.getGitDiff(sessionId, filePath)
			.then((diff) => {
				this.send(client, {
					type: 'git_diff',
					sessionId,
					diff,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to get git diff: ${error.message}`);
			});
	}

	/**
	 * Handle get_group_chats message - return list of all group chats
	 */
	private handleGetGroupChats(client: WebClient, message: WebClientMessage): void {
		if (!this.callbacks.getGroupChats) {
			this.sendError(client, 'Group chats not configured');
			return;
		}

		this.callbacks
			.getGroupChats()
			.then((chats) => {
				this.send(client, {
					type: 'group_chats_list',
					chats,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to get group chats: ${error.message}`);
			});
	}

	/**
	 * Handle start_group_chat message - start a new group chat
	 */
	private handleStartGroupChat(client: WebClient, message: WebClientMessage): void {
		const topic = message.topic as string;
		const participantIds = message.participantIds as string[];

		if (!topic || typeof topic !== 'string') {
			this.sendError(client, 'Missing or invalid topic');
			return;
		}

		if (!participantIds || !Array.isArray(participantIds) || participantIds.length < 2) {
			this.sendError(client, 'At least 2 participants are required');
			return;
		}

		if (!this.callbacks.startGroupChat) {
			this.sendError(client, 'Group chat not configured');
			return;
		}

		this.callbacks
			.startGroupChat(topic, participantIds)
			.then((result) => {
				this.send(client, {
					type: 'start_group_chat_result',
					success: !!result,
					chatId: result?.chatId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to start group chat: ${error.message}`);
			});
	}

	/**
	 * Handle get_group_chat_state message - get state of a specific group chat
	 */
	private handleGetGroupChatState(client: WebClient, message: WebClientMessage): void {
		const chatId = message.chatId as string;

		if (!chatId) {
			this.sendError(client, 'Missing chatId');
			return;
		}

		if (!this.callbacks.getGroupChatState) {
			this.sendError(client, 'Group chat not configured');
			return;
		}

		this.callbacks
			.getGroupChatState(chatId)
			.then((state) => {
				this.send(client, {
					type: 'group_chat_state',
					chatId,
					state,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to get group chat state: ${error.message}`);
			});
	}

	/**
	 * Handle send_group_chat_message message - send a message to a group chat
	 */
	private handleSendGroupChatMessage(client: WebClient, message: WebClientMessage): void {
		const chatId = message.chatId as string;
		const chatMessage = message.message as string;

		if (!chatId) {
			this.sendError(client, 'Missing chatId');
			return;
		}

		if (!chatMessage || typeof chatMessage !== 'string') {
			this.sendError(client, 'Missing or invalid message');
			return;
		}

		if (!this.callbacks.sendGroupChatMessage) {
			this.sendError(client, 'Group chat not configured');
			return;
		}

		this.callbacks
			.sendGroupChatMessage(chatId, chatMessage)
			.then((success) => {
				this.send(client, {
					type: 'send_group_chat_message_result',
					success,
					chatId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to send group chat message: ${error.message}`);
			});
	}

	/**
	 * Handle stop_group_chat message - stop an active group chat
	 */
	private handleStopGroupChat(client: WebClient, message: WebClientMessage): void {
		const chatId = message.chatId as string;

		if (!chatId) {
			this.sendError(client, 'Missing chatId');
			return;
		}

		if (!this.callbacks.stopGroupChat) {
			this.sendError(client, 'Group chat not configured');
			return;
		}

		this.callbacks
			.stopGroupChat(chatId)
			.then((success) => {
				this.send(client, {
					type: 'stop_group_chat_result',
					success,
					chatId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to stop group chat: ${error.message}`);
			});
	}

	/**
	 * Handle merge_context message - merge context from source to target session
	 */
	private handleMergeContext(client: WebClient, message: WebClientMessage): void {
		const sourceSessionId = message.sourceSessionId as string;
		const targetSessionId = message.targetSessionId as string;

		if (!sourceSessionId || !targetSessionId) {
			this.sendError(client, 'Missing sourceSessionId or targetSessionId');
			return;
		}

		if (sourceSessionId === targetSessionId) {
			this.sendError(client, 'Source and target sessions must be different');
			return;
		}

		if (!this.callbacks.mergeContext) {
			this.sendError(client, 'Context merge not configured');
			return;
		}

		this.callbacks
			.mergeContext(sourceSessionId, targetSessionId)
			.then((success) => {
				this.send(client, {
					type: 'merge_context_result',
					success,
					requestId: message.requestId,
					timestamp: Date.now(),
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to merge context: ${error.message}`);
			});
	}

	/**
	 * Handle transfer_context message - transfer context from source to target session
	 */
	private handleTransferContext(client: WebClient, message: WebClientMessage): void {
		const sourceSessionId = message.sourceSessionId as string;
		const targetSessionId = message.targetSessionId as string;

		if (!sourceSessionId || !targetSessionId) {
			this.sendError(client, 'Missing sourceSessionId or targetSessionId');
			return;
		}

		if (sourceSessionId === targetSessionId) {
			this.sendError(client, 'Source and target sessions must be different');
			return;
		}

		if (!this.callbacks.transferContext) {
			this.sendError(client, 'Context transfer not configured');
			return;
		}

		this.callbacks
			.transferContext(sourceSessionId, targetSessionId)
			.then((success) => {
				this.send(client, {
					type: 'transfer_context_result',
					success,
					requestId: message.requestId,
					timestamp: Date.now(),
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to transfer context: ${error.message}`);
			});
	}

	/**
	 * Handle summarize_context message - summarize context for a session
	 */
	private handleSummarizeContext(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!this.callbacks.summarizeContext) {
			this.sendError(client, 'Context summarize not configured');
			return;
		}

		this.callbacks
			.summarizeContext(sessionId)
			.then((success) => {
				this.send(client, {
					type: 'summarize_context_result',
					success,
					requestId: message.requestId,
					timestamp: Date.now(),
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to summarize context: ${error.message}`);
			});
	}

	/**
	 * Handle create_gist message - publish a session's transcript to a GitHub gist.
	 * Always replies with `create_gist_result` (even on failure) so waiting
	 * clients don't hang until their request timeout.
	 */
	private handleCreateGist(client: WebClient, message: WebClientMessage): void {
		const reply = (result: { success: boolean; gistUrl?: string; error?: string }) => {
			this.send(client, {
				type: 'create_gist_result',
				...result,
				requestId: message.requestId,
			});
		};

		const sessionId = message.sessionId;
		if (typeof sessionId !== 'string' || !sessionId) {
			reply({ success: false, error: 'Missing sessionId' });
			return;
		}

		// Strict validation — avoid truthy coercion so a string like "false"
		// cannot flip a private gist to public.
		if (message.description !== undefined && typeof message.description !== 'string') {
			reply({ success: false, error: 'description must be a string when provided' });
			return;
		}
		if (message.isPublic !== undefined && typeof message.isPublic !== 'boolean') {
			reply({ success: false, error: 'isPublic must be a boolean when provided' });
			return;
		}
		const description = message.description ?? '';
		const isPublic = message.isPublic ?? false;

		if (!this.callbacks.createGist) {
			reply({ success: false, error: 'Gist creation not configured' });
			return;
		}

		this.callbacks
			.createGist(sessionId, description, isPublic)
			.then((result) => {
				reply(result);
			})
			.catch((error: unknown) => {
				const msg = error instanceof Error ? error.message : String(error);
				reply({ success: false, error: `Failed to create gist: ${msg}` });
			});
	}

	/**
	 * Handle get_cue_subscriptions message - fetch Cue subscriptions
	 */
	private handleGetCueSubscriptions(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string | undefined;

		if (!this.callbacks.getCueSubscriptions) {
			this.sendError(client, 'Cue subscriptions not available');
			return;
		}

		this.callbacks
			.getCueSubscriptions(sessionId)
			.then((subscriptions) => {
				this.send(client, {
					type: 'cue_subscriptions',
					subscriptions,
					requestId: message.requestId,
					timestamp: Date.now(),
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to get Cue subscriptions: ${error.message}`);
			});
	}

	/**
	 * Handle toggle_cue_subscription message - enable/disable a subscription
	 */
	private handleToggleCueSubscription(client: WebClient, message: WebClientMessage): void {
		const subscriptionId = message.subscriptionId as string;
		const enabled = message.enabled as boolean;

		if (!subscriptionId) {
			this.sendError(client, 'Missing subscriptionId');
			return;
		}

		if (typeof enabled !== 'boolean') {
			this.sendError(client, 'Missing or invalid enabled flag');
			return;
		}

		if (!this.callbacks.toggleCueSubscription) {
			this.sendError(client, 'Cue toggle not available');
			return;
		}

		this.callbacks
			.toggleCueSubscription(subscriptionId, enabled)
			.then((success) => {
				this.send(client, {
					type: 'toggle_cue_subscription_result',
					success,
					subscriptionId,
					enabled,
					requestId: message.requestId,
					timestamp: Date.now(),
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to toggle Cue subscription: ${error.message}`);
			});
	}

	/**
	 * Handle get_cue_activity message - fetch Cue activity log
	 */
	private handleGetCueActivity(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string | undefined;
		const limit = (message.limit as number) ?? 50;

		if (!this.callbacks.getCueActivity) {
			this.sendError(client, 'Cue activity not available');
			return;
		}

		this.callbacks
			.getCueActivity(sessionId, limit)
			.then((entries) => {
				this.send(client, {
					type: 'cue_activity',
					entries,
					requestId: message.requestId,
					timestamp: Date.now(),
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to get Cue activity: ${error.message}`);
			});
	}

	/**
	 * Handle trigger_cue_subscription message - manually trigger a Cue subscription
	 */
	private handleTriggerCueSubscription(client: WebClient, message: WebClientMessage): void {
		const subscriptionName = message.subscriptionName;
		const prompt = message.prompt;

		if (typeof subscriptionName !== 'string' || subscriptionName.trim() === '') {
			this.sendError(client, 'Missing subscriptionName');
			return;
		}
		if (prompt !== undefined && typeof prompt !== 'string') {
			this.sendError(client, 'Invalid prompt: must be a string when provided');
			return;
		}

		if (!this.callbacks.triggerCueSubscription) {
			this.sendError(client, 'Cue trigger not available');
			return;
		}

		const rawSourceAgentId = message.sourceAgentId;
		if (rawSourceAgentId !== undefined && typeof rawSourceAgentId !== 'string') {
			this.sendError(client, 'Invalid sourceAgentId: must be a string when provided');
			return;
		}
		const sourceAgentId = rawSourceAgentId as string | undefined;

		this.callbacks
			.triggerCueSubscription(subscriptionName, prompt as string | undefined, sourceAgentId)
			.then((success) => {
				this.send(client, {
					type: 'trigger_cue_subscription_result',
					success,
					subscriptionName,
					requestId: message.requestId,
					timestamp: Date.now(),
				});
			})
			.catch((error) => {
				const err = error instanceof Error ? error : new Error(String(error));
				logger.error(`Failed to trigger Cue subscription: ${err.message}`, 'WebSocket');
				this.sendError(client, `Failed to trigger Cue subscription: ${err.message}`);
			});
	}

	/**
	 * Handle get_usage_dashboard message - fetch usage analytics data
	 */
	private handleGetUsageDashboard(client: WebClient, message: WebClientMessage): void {
		const timeRange = (message.timeRange as string) || 'week';
		const validRanges = new Set(['day', 'week', 'month', 'all']);

		if (!validRanges.has(timeRange)) {
			this.sendError(client, 'Invalid timeRange. Must be one of: day, week, month, all');
			return;
		}

		if (!this.callbacks.getUsageDashboard) {
			this.sendError(client, 'Usage dashboard not available');
			return;
		}

		this.callbacks
			.getUsageDashboard(timeRange as 'day' | 'week' | 'month' | 'all')
			.then((data) => {
				this.send(client, {
					type: 'usage_dashboard',
					data,
					requestId: message.requestId,
					timestamp: Date.now(),
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to get usage dashboard: ${error.message}`);
			});
	}

	/**
	 * Handle get_achievements message - fetch achievement data
	 */
	private handleGetAchievements(client: WebClient, message: WebClientMessage): void {
		if (!this.callbacks.getAchievements) {
			this.sendError(client, 'Achievements not available');
			return;
		}

		this.callbacks
			.getAchievements()
			.then((achievements) => {
				this.send(client, {
					type: 'achievements',
					achievements,
					requestId: message.requestId,
					timestamp: Date.now(),
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to get achievements: ${error.message}`);
			});
	}

	/**
	 * Handle generate_director_notes_synopsis - generate AI synopsis via batch-mode agent
	 */
	private handleGenerateDirectorNotesSynopsis(client: WebClient, message: WebClientMessage): void {
		if (!this.callbacks.generateDirectorNotesSynopsis) {
			this.send(client, {
				type: 'generate_director_notes_synopsis_result',
				success: false,
				error: "Director's Notes synopsis generation not available",
				requestId: message.requestId,
			});
			return;
		}

		const lookbackDays = (message.lookbackDays as number) || 7;
		const provider = (message.provider as string) || 'claude-code';

		this.callbacks
			.generateDirectorNotesSynopsis(lookbackDays, provider)
			.then((result) => {
				this.send(client, {
					type: 'generate_director_notes_synopsis_result',
					...result,
					requestId: message.requestId,
					timestamp: Date.now(),
				});
			})
			.catch((error) => {
				this.send(client, {
					type: 'generate_director_notes_synopsis_result',
					success: false,
					error: `Synopsis generation failed: ${error.message}`,
					requestId: message.requestId,
				});
			});
	}

	/**
	 * Handle terminal_write - write raw data to the terminal PTY
	 */
	private handleTerminalWrite(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId;
		const data = message.data as string | undefined;
		if (!sessionId || typeof data !== 'string') {
			this.send(client, {
				type: 'terminal_write_result',
				success: false,
				error: 'Missing sessionId or data',
			});
			return;
		}
		if (client.subscribedSessionId !== sessionId) {
			this.send(client, {
				type: 'terminal_write_result',
				success: false,
				error: 'Not subscribed to this session',
			});
			return;
		}
		if (!this.callbacks.writeToTerminal) {
			this.send(client, {
				type: 'terminal_write_result',
				success: false,
				error: 'writeToTerminal not available',
			});
			return;
		}
		const success = this.callbacks.writeToTerminal(sessionId, data);
		this.send(client, { type: 'terminal_write_result', success, sessionId });
	}

	/**
	 * Handle terminal_resize - resize the terminal PTY
	 */
	private handleTerminalResize(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId;
		const cols = message.cols as number | undefined;
		const rows = message.rows as number | undefined;
		if (!sessionId || typeof cols !== 'number' || typeof rows !== 'number') {
			this.send(client, {
				type: 'terminal_resize_result',
				success: false,
				error: 'Missing sessionId, cols, or rows',
			});
			return;
		}
		if (client.subscribedSessionId !== sessionId) {
			this.send(client, {
				type: 'terminal_resize_result',
				success: false,
				error: 'Not subscribed to this session',
			});
			return;
		}
		if (!this.callbacks.resizeTerminal) {
			this.send(client, {
				type: 'terminal_resize_result',
				success: false,
				error: 'resizeTerminal not available',
			});
			return;
		}
		const success = this.callbacks.resizeTerminal(sessionId, cols, rows);
		this.send(client, { type: 'terminal_resize_result', success, sessionId });
	}

	/**
	 * Handle notify_toast - show a toast notification in the desktop app.
	 */
	private handleNotifyToast(client: WebClient, message: WebClientMessage): void {
		const title = typeof message.title === 'string' ? message.title : '';
		const body = typeof message.message === 'string' ? message.message : '';
		const rawColor = typeof message.color === 'string' ? message.color : undefined;
		// Legacy field (kept for back-compat with older CLI scripts).
		const rawType = typeof message.toastType === 'string' ? message.toastType : undefined;
		const duration = typeof message.duration === 'number' ? message.duration : undefined;
		const dismissible = message.dismissible === true;
		const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
		const tabId = typeof message.tabId === 'string' ? message.tabId : undefined;
		const actionUrl = typeof message.actionUrl === 'string' ? message.actionUrl : undefined;
		const actionLabel = typeof message.actionLabel === 'string' ? message.actionLabel : undefined;
		const rawClickAction =
			typeof message.clickAction === 'object' && message.clickAction !== null
				? (message.clickAction as Record<string, unknown>)
				: undefined;

		const sendResult = (success: boolean, error?: string) => {
			this.send(client, {
				type: 'notify_toast_result',
				success,
				error,
				requestId: message.requestId,
			});
		};

		if (!title) {
			sendResult(false, 'Missing title');
			return;
		}

		// Resolve color: explicit `color` wins over deprecated `toastType`. Default `theme`.
		let color: NotifyToastColor;
		if (rawColor !== undefined) {
			if (!NOTIFY_TOAST_COLORS.includes(rawColor as NotifyToastColor)) {
				sendResult(
					false,
					`Invalid toast color: ${rawColor}. Must be one of: ${NOTIFY_TOAST_COLORS.join(', ')}`
				);
				return;
			}
			color = rawColor as NotifyToastColor;
		} else if (rawType !== undefined) {
			if (!NOTIFY_TOAST_KINDS.includes(rawType as NotifyToastKind)) {
				sendResult(false, `Invalid toast type: ${rawType}`);
				return;
			}
			color = VARIANT_TO_COLOR[rawType as NotifyCenterFlashVariant];
		} else {
			color = 'theme';
		}

		// Validate clickAction (data-driven click intent). Each kind has its
		// own required fields; bad shapes are rejected so the CLI surfaces a
		// clear error instead of producing a silent no-op toast.
		let clickAction: NotifyToastClickAction | undefined;
		if (rawClickAction !== undefined) {
			const kind = rawClickAction.kind;
			if (kind === 'jump-session') {
				const id = rawClickAction.sessionId;
				if (typeof id !== 'string' || id.length === 0) {
					sendResult(false, "clickAction kind 'jump-session' requires sessionId");
					return;
				}
				const tab = rawClickAction.tabId;
				clickAction = {
					kind: 'jump-session',
					sessionId: id,
					tabId: typeof tab === 'string' && tab.length > 0 ? tab : undefined,
				};
			} else if (kind === 'open-file') {
				const id = rawClickAction.sessionId;
				const path = rawClickAction.path;
				if (typeof id !== 'string' || id.length === 0) {
					sendResult(false, "clickAction kind 'open-file' requires sessionId");
					return;
				}
				if (typeof path !== 'string' || path.length === 0) {
					sendResult(false, "clickAction kind 'open-file' requires path");
					return;
				}
				clickAction = { kind: 'open-file', sessionId: id, path };
			} else if (kind === 'open-url') {
				const url = rawClickAction.url;
				if (typeof url !== 'string' || url.length === 0) {
					sendResult(false, "clickAction kind 'open-url' requires url");
					return;
				}
				clickAction = { kind: 'open-url', url };
			} else {
				sendResult(
					false,
					`Invalid clickAction kind: ${String(kind)}. Must be one of: jump-session, open-file, open-url`
				);
				return;
			}
		}

		// Duration validation: reject 0 (use --dismissible instead) and cap at 60 s.
		// Skipped entirely when `dismissible: true` (the toast is sticky).
		if (!dismissible && duration !== undefined) {
			if (!Number.isFinite(duration) || duration <= 0) {
				sendResult(
					false,
					'duration must be a positive number of seconds (use dismissible:true for sticky toasts)'
				);
				return;
			}
			if (duration > EXTERNAL_TOAST_MAX_DURATION_SECONDS) {
				sendResult(
					false,
					`duration cannot exceed ${EXTERNAL_TOAST_MAX_DURATION_SECONDS} seconds for externally-triggered toasts (use dismissible:true to make it sticky)`
				);
				return;
			}
		}

		if (!this.callbacks.notifyToast) {
			sendResult(false, 'Toast notifications not configured');
			return;
		}

		this.callbacks
			.notifyToast({
				title,
				message: body,
				color,
				dismissible,
				duration,
				sessionId,
				tabId,
				actionUrl,
				actionLabel,
				clickAction,
			})
			.then((success) => sendResult(success, success ? undefined : 'Failed to show toast'))
			.catch((error) => sendResult(false, `Failed to show toast: ${error.message}`));
	}

	/**
	 * Handle notify_center_flash - show a center-screen flash in the desktop app.
	 */
	private handleNotifyCenterFlash(client: WebClient, message: WebClientMessage): void {
		const body = typeof message.message === 'string' ? message.message : '';
		const detail = typeof message.detail === 'string' ? message.detail : undefined;
		const rawColor = typeof message.color === 'string' ? message.color : undefined;
		const rawVariant = typeof message.variant === 'string' ? message.variant : undefined;
		const duration = typeof message.duration === 'number' ? message.duration : undefined;

		const sendResult = (success: boolean, error?: string) => {
			this.send(client, {
				type: 'notify_center_flash_result',
				success,
				error,
				requestId: message.requestId,
			});
		};

		if (!body) {
			sendResult(false, 'Missing message');
			return;
		}

		// Resolve color: explicit `color` wins over deprecated `variant`. Default `theme`.
		let color: NotifyCenterFlashColor;
		if (rawColor !== undefined) {
			if (!NOTIFY_FLASH_COLORS.includes(rawColor as NotifyCenterFlashColor)) {
				sendResult(
					false,
					`Invalid flash color: ${rawColor}. Must be one of: ${NOTIFY_FLASH_COLORS.join(', ')}`
				);
				return;
			}
			color = rawColor as NotifyCenterFlashColor;
		} else if (rawVariant !== undefined) {
			if (!(rawVariant in VARIANT_TO_COLOR)) {
				sendResult(false, `Invalid flash variant: ${rawVariant}`);
				return;
			}
			color = VARIANT_TO_COLOR[rawVariant as NotifyCenterFlashVariant];
		} else {
			color = 'theme';
		}

		// External flashes must be (0, 5000 ms] — `0` (never auto-dismiss) is rejected so
		// external scripts can't stick a permanent overlay on the user. In-app callers
		// using `notifyCenterFlash()` directly are not capped.
		if (duration !== undefined) {
			if (!Number.isFinite(duration) || duration <= 0) {
				sendResult(false, 'duration must be a positive number of milliseconds');
				return;
			}
			if (duration > EXTERNAL_FLASH_MAX_DURATION_MS) {
				sendResult(
					false,
					`duration cannot exceed ${EXTERNAL_FLASH_MAX_DURATION_MS} ms for externally-triggered flashes`
				);
				return;
			}
		}

		if (!this.callbacks.notifyCenterFlash) {
			sendResult(false, 'Center flash not configured');
			return;
		}

		this.callbacks
			.notifyCenterFlash({ message: body, detail, color, duration })
			.then((success) => sendResult(success, success ? undefined : 'Failed to show flash'))
			.catch((error) => sendResult(false, `Failed to show flash: ${error.message}`));
	}

	/**
	 * Handle unknown message types - echo back for debugging
	 */
	private handleUnknown(client: WebClient, message: WebClientMessage): void {
		logger.debug(`Unknown message type: ${message.type}`, LOG_CONTEXT);
		this.send(client, { type: 'echo', originalType: message.type, data: message });
	}
}
