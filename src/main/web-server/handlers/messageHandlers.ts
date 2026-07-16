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
 * - list_desktop_sessions: Enumerate open AI tabs across all agents (CLI: `session list`)
 * - get_session_history: Return tab conversation history with --since/--tail filters (CLI: `session show`)
 */

import path from 'path';
import fs from 'fs/promises';
import { app } from 'electron';
import { WebSocket } from 'ws';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { getCommitHash } from '../../utils/build-info';
import {
	startProfiling,
	stopProfiling,
	getProfilingStatus,
	finalizeCapture,
} from '../../profiling';
import { getStatsDB } from '../../stats/singleton';
import { runReadonlyStatsQuery } from '../../stats/readonly-query';
import type { StatsTimeRange } from '../../../shared/stats-types';
import type {
	AutoRunDocument,
	AutoRunState,
	WebSettings,
	SettingValue,
	GroupData,
	GitStatusResult,
	GitDiffResult,
	GitBranchesResult,
	ListWorktreesResult,
	GroupChatState,
	CueSubscriptionInfo,
	CueActivityEntry,
	UsageDashboardData,
	AchievementData,
	CreateSessionConfig,
	DirectorNotesSynopsisResult,
	WebPlaybook,
	WebPlaybookDocument,
	NotifyToastClickAction,
	NotifyToastParams,
	NotifyCenterFlashParams,
	MarketplaceManifestResult,
	MarketplaceImportResult,
	DesktopSessionEntry,
	SessionHistoryResult,
	GetSessionHistoryOptions,
} from '../types';

/**
 * Hard upper bound on flash duration for **externally-triggered** flashes
 * (CLI / web). The renderer-side `notifyCenterFlash` itself is uncapped so
 * internal in-app callers can still use longer durations if ever needed -
 * the cap lives at the IPC boundary so external scripts can't stick a
 * permanent overlay on the user.
 */
const EXTERNAL_FLASH_MAX_DURATION_MS = 5000;

/**
 * Hard upper bound on toast duration (seconds) for externally-triggered
 * toasts. Toasts are corner notifications so the cap is more generous than
 * Center Flash, but `0` (never auto-dismiss) is rejected - external scripts
 * that want a sticky toast must opt in explicitly via `dismissible: true`.
 */
const EXTERNAL_TOAST_MAX_DURATION_SECONDS = 60;
import {
	isNotificationTimeoutWithinLimit,
	NOTIFICATION_COLORS,
	NOTIFICATION_VARIANT_COLORS,
	parseNotificationTimeout,
	resolveNotificationColor,
} from '../../../shared/notification';
import { AGENT_IDS } from '../../../shared/agentIds';
import {
	getActivePluginManager,
	isPluginsFeatureEnabled,
} from '../../plugins/plugin-manager-singleton';
import { evaluatePluginDispatch } from '../../../shared/plugins/plugin-dispatch-gate';
import {
	CADENZA_OPS,
	CADENZA_VIEW_TYPES,
	CADENZA_COLORS,
	type CadenzaPayload,
	type CadenzaOp,
	type CadenzaViewType,
	type CadenzaColor,
} from '../../../shared/cadenza-types';
import {
	MOVEMENT_OPS,
	MOVEMENT_VIEW_TYPES,
	type MovementOp,
	type MovementPayload,
	type MovementStateSnapshot,
	type MovementViewType,
} from '../../../shared/movement-types';
import type {
	ConcertoDesignerAction,
	ConcertoDesignerActionResult,
	MovementDesignerInspection,
} from '../../../shared/concerto-html';

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
	background?: boolean;
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
		images?: string[],
		background?: boolean
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
	openFileTab: (sessionId: string, filePath: string, switchToAgent: boolean) => Promise<boolean>;
	refreshFileTree: (sessionId: string) => Promise<boolean>;
	openBrowserTab: (sessionId: string, url: string) => Promise<boolean>;
	openTerminalTab: (
		sessionId: string,
		config: { cwd?: string; shell?: string; name?: string | null }
	) => Promise<boolean>;
	newAITabWithPrompt: (
		sessionId: string,
		prompt: string,
		background?: boolean
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
				baseBranch: string;
				createPROnCompletion: boolean;
				prTargetBranch: string;
			};
		}
	) => Promise<{ success: boolean; playbookId?: string; error?: string }>;
	setSessionAutoRunFolder: (
		sessionId: string,
		folderPath: string
	) => Promise<{ success: boolean; error?: string }>;
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
	resetAutoRunDocTasks: (sessionId: string, filename: string) => Promise<boolean>;
	resumeAutoRunError: (sessionId: string) => Promise<boolean>;
	skipAutoRunDocument: (sessionId: string) => Promise<boolean>;
	abortAutoRunError: (sessionId: string) => Promise<boolean>;
	listPlaybooks: (sessionId: string) => Promise<WebPlaybook[]>;
	createPlaybook: (
		sessionId: string,
		playbook: {
			name: string;
			documents: WebPlaybookDocument[];
			loopEnabled: boolean;
			maxLoops?: number | null;
			prompt: string;
		}
	) => Promise<WebPlaybook | null>;
	updatePlaybook: (
		sessionId: string,
		playbookId: string,
		updates: Partial<{
			name: string;
			documents: WebPlaybookDocument[];
			loopEnabled: boolean;
			maxLoops?: number | null;
			prompt: string;
		}>
	) => Promise<WebPlaybook | null>;
	deletePlaybook: (sessionId: string, playbookId: string) => Promise<boolean>;
	getSettings: () => WebSettings;
	setSetting: (key: string, value: SettingValue) => Promise<boolean>;
	getGroups: () => GroupData[];
	createGroup: (
		name: string,
		emoji?: string,
		parentGroupId?: string
	) => Promise<{ id: string } | null>;
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
	createWorktreeSession: (
		parentSessionId: string,
		config: {
			branchName: string;
			baseBranch?: string;
		}
	) => Promise<{ success: boolean; sessionId?: string; error?: string }>;
	deleteSession: (sessionId: string) => Promise<boolean>;
	renameSession: (sessionId: string, newName: string) => Promise<boolean>;
	updateSessionCwd: (
		sessionId: string,
		newCwd: string
	) => Promise<{ success: boolean; error?: string }>;
	updateSessionSsh: (
		sessionId: string,
		sshPatch: Record<string, unknown>
	) => Promise<{ success: boolean; error?: string }>;
	updateSessionConfig: (
		sessionId: string,
		configPatch: Record<string, unknown>
	) => Promise<{ success: boolean; error?: string }>;
	getGitStatus: (sessionId: string) => Promise<GitStatusResult>;
	getGitDiff: (sessionId: string, filePath?: string) => Promise<GitDiffResult>;
	getGitBranchesForSession: (sessionId: string) => Promise<GitBranchesResult>;
	listWorktreesForSession: (sessionId: string) => Promise<ListWorktreesResult>;
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
	listCuePipelines: () => Promise<{ pipelines: unknown[] }>;
	getCuePipeline: (identifier: string) => Promise<unknown | null>;
	setCuePipeline: (
		identifier: string,
		pipeline: unknown,
		policy: 'add' | 'replace'
	) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
	removeCuePipeline: (
		identifier: string
	) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
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
	cadenzaView: (params: CadenzaPayload) => Promise<boolean>;
	movementView: (params: MovementPayload) => Promise<boolean>;
	getMovementState: () => Promise<MovementStateSnapshot | null>;
	getMovementDesignerInspection: (id: string) => Promise<MovementDesignerInspection | null>;
	interactMovementDesigner: (
		id: string,
		action: ConcertoDesignerAction
	) => Promise<ConcertoDesignerActionResult>;
	notifyCenterFlash: (params: NotifyCenterFlashParams) => Promise<boolean>;
	getMarketplaceManifest: (options?: {
		refresh?: boolean;
	}) => Promise<MarketplaceManifestResult | null>;
	getMarketplaceDocument: (
		playbookPath: string,
		filename: string
	) => Promise<{ content: string } | null>;
	getMarketplaceReadme: (playbookPath: string) => Promise<{ content: string | null } | null>;
	importMarketplacePlaybook: (
		sessionId: string,
		playbookId: string,
		targetFolderName: string
	) => Promise<MarketplaceImportResult>;
	/** External-pickup primitive used by `maestro-cli session list`. Surfaces every
	 *  open AI tab across all desktop agents so consumers (Maestro-Discord, Cue)
	 *  can address tabs by id without owning a persistent channel. */
	listDesktopSessions: () => DesktopSessionEntry[];
	/** Read-only conversation history fetch used by `maestro-cli session show
	 *  <tabId>`. Filters (`sinceMs`, `tail`) live alongside the read so we don't
	 *  ship the full transcript over the wire on every poll. */
	getSessionHistory: (
		tabId: string,
		options?: GetSessionHistoryOptions
	) => SessionHistoryResult | null;
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
	 * Report a handler exception to Sentry and send an error response. Use in
	 * `.catch(...)` blocks where we'd otherwise silently swallow the cause -
	 * lets us keep the user-facing message tight while preserving production
	 * diagnostics.
	 */
	private reportHandlerError(
		client: WebClient,
		error: unknown,
		handler: string,
		extra: Record<string, unknown>,
		userMessagePrefix: string
	): void {
		const err = error instanceof Error ? error : new Error(String(error));
		captureException(err, { extra: { area: 'web-server', handler, ...extra } });
		this.sendError(client, `${userMessagePrefix}: ${err.message}`);
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

			case 'get_app_info':
				this.handleGetAppInfo(client, message);
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

			case 'create_worktree_session':
				this.handleCreateWorktreeSession(client, message);
				break;

			case 'set_auto_run_folder':
				this.handleSetAutoRunFolder(client, message);
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

			case 'reset_auto_run_doc_tasks':
				this.handleResetAutoRunDocTasks(client, message);
				break;

			case 'resume_auto_run_error':
				this.handleResumeAutoRunError(client, message);
				break;

			case 'skip_auto_run_document':
				this.handleSkipAutoRunDocument(client, message);
				break;

			case 'abort_auto_run_error':
				this.handleAbortAutoRunError(client, message);
				break;

			case 'list_playbooks':
				this.handleListPlaybooks(client, message);
				break;

			case 'create_playbook':
				this.handleCreatePlaybook(client, message);
				break;

			case 'update_playbook':
				this.handleUpdatePlaybook(client, message);
				break;

			case 'delete_playbook':
				this.handleDeletePlaybook(client, message);
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

			case 'update_session_cwd':
				this.handleUpdateSessionCwd(client, message);
				break;

			case 'update_session_ssh':
				this.handleUpdateSessionSsh(client, message);
				break;

			case 'update_session_config':
				this.handleUpdateSessionConfig(client, message);
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

			case 'get_git_branches':
				this.handleGetGitBranches(client, message);
				break;

			case 'list_worktrees':
				this.handleListWorktrees(client, message);
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

			case 'cue_pipeline_list':
				this.handleCuePipelineList(client, message);
				break;

			case 'cue_pipeline_get':
				this.handleCuePipelineGet(client, message);
				break;

			case 'cue_pipeline_set':
				this.handleCuePipelineSet(client, message);
				break;

			case 'cue_pipeline_remove':
				this.handleCuePipelineRemove(client, message);
				break;

			case 'get_usage_dashboard':
				this.handleGetUsageDashboard(client, message);
				break;

			case 'get_achievements':
				this.handleGetAchievements(client, message);
				break;

			case 'get_stats_aggregation':
				this.handleGetStatsAggregation(client, message);
				break;

			case 'stats_query':
				this.handleStatsQuery(client, message);
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

			case 'movement':
				this.handleMovement(client, message);
				break;
			case 'get_movement_state':
				this.handleGetMovementState(client, message);
				break;
			case 'get_movement_designer_inspection':
				this.handleGetMovementDesignerInspection(client, message);
				break;
			case 'interact_movement_designer':
				this.handleInteractMovementDesigner(client, message);
				break;
			case 'cadenza':
				this.handleCadenza(client, message);
				break;

			case 'notify_center_flash':
				this.handleNotifyCenterFlash(client, message);
				break;

			case 'profiling_start':
				void this.handleProfilingStart(client, message);
				break;

			case 'profiling_stop':
				void this.handleProfilingStop(client, message);
				break;

			case 'profiling_status':
				this.handleProfilingStatus(client, message);
				break;

			case 'marketplace_get_manifest':
				this.handleMarketplaceGetManifest(client, message);
				break;

			case 'marketplace_get_document':
				this.handleMarketplaceGetDocument(client, message);
				break;

			case 'marketplace_get_readme':
				this.handleMarketplaceGetReadme(client, message);
				break;

			case 'marketplace_import_playbook':
				this.handleMarketplaceImportPlaybook(client, message);
				break;

			case 'list_desktop_sessions':
				this.handleListDesktopSessions(client, message);
				break;

			case 'plugins_list_tools':
				this.handlePluginsListTools(client, message);
				break;

			case 'plugins_call_tool':
				void this.handlePluginsCallTool(client, message);
				break;

			case 'get_session_history':
				this.handleGetSessionHistory(client, message);
				break;

			case 'bridge.invoke':
				void this.handleBridgeInvoke(client, message);
				break;

			default:
				this.handleUnknown(client, message);
		}
	}

	/**
	 * Generic IPC bridge - dispatch a bridge.invoke message to the matching
	 * ipcMain handler and return the result/error as a bridge.response. This
	 * backs the web-desktop bundle, the default browser interface.
	 */
	private async handleBridgeInvoke(client: WebClient, message: WebClientMessage): Promise<void> {
		const { handleBridgeInvoke } = await import('./bridgeHandlers');
		await handleBridgeInvoke(
			client,
			message as unknown as Parameters<typeof handleBridgeInvoke>[1],
			(c, payload) => c.socket.send(JSON.stringify(payload))
		);
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
		// background=true suppresses the desktop's focus side effect (switching
		// to the target agent/tab). `maestro-cli dispatch` sets this by default;
		// passing `--focus` clears it to bring the target to the foreground.
		const background = message.background === true;
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
		// the IPC send and IPC receive - callers chaining `dispatch --session
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
				.executeCommand(
					sessionId,
					effectiveCommand,
					clientInputMode,
					requestedTabId,
					force,
					images,
					background
				)
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
							// PTY failed to spawn - report failure so the client can roll back
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
	/**
	 * Handle get_app_info message - report the running desktop app's version and the
	 * git commit hash it was built from (for `maestro-cli version`). commitHash is ''
	 * when the build couldn't determine it (see utils/build-info.ts).
	 */
	private handleGetAppInfo(client: WebClient, message: WebClientMessage): void {
		this.send(client, {
			type: 'app_info',
			requestId: message.requestId,
			version: app.getVersion(),
			commitHash: getCommitHash(),
			platform: process.platform,
		});
	}

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
			// Permission denied or other errors - return empty
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
			Array<{ filename: string; resetOnCompletion?: boolean }> | undefined;
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

		// Validate optional worktree config - desktop app uses this to create a
		// git worktree, checkout the branch, and optionally open a PR on completion.
		let worktree:
			| {
					enabled: boolean;
					path: string;
					branchName: string;
					baseBranch: string;
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
			if (w.baseBranch !== undefined && typeof w.baseBranch !== 'string') {
				this.sendError(client, 'worktree.baseBranch must be a string');
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
				baseBranch: (w.baseBranch as string | undefined) ?? '',
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
	 * Handle set_auto_run_folder message - update the Auto Run folder for an
	 * existing session. Mirrors desktop's `dialog.selectFolder` flow: the renderer
	 * lists docs from the new path, persists the choice to session storage, and
	 * broadcasts the updated session.
	 */
	private handleSetAutoRunFolder(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const folderPath = message.folderPath as string;
		// Avoid logging the raw folder path: it can contain user/home/project
		// identifiers that count as PII in production logs. The basename is
		// usually enough for debugging without leaking the full path.
		const folderPathHint = typeof folderPath === 'string' ? path.basename(folderPath) : '<invalid>';
		logger.info(
			`[Web] Received set_auto_run_folder message: session=${sessionId}, folderBasename=${folderPathHint}, folderPathLength=${folderPath?.length ?? 0}`,
			LOG_CONTEXT
		);

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (typeof folderPath !== 'string' || folderPath.trim() === '') {
			this.sendError(client, 'Missing or invalid folderPath');
			return;
		}

		if (!this.callbacks.setSessionAutoRunFolder) {
			this.sendError(client, 'Auto Run folder updates not configured');
			return;
		}

		this.callbacks
			.setSessionAutoRunFolder(sessionId, folderPath)
			.then((result) => {
				this.send(client, {
					type: 'set_auto_run_folder_result',
					success: result.success,
					error: result.error,
					sessionId,
					folderPath,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				const err = error instanceof Error ? error : new Error(String(error));
				captureException(err, {
					extra: {
						area: 'web-server',
						handler: 'set_auto_run_folder',
						sessionId,
						requestId: message.requestId,
					},
				});
				this.sendError(client, `Failed to set Auto Run folder: ${err.message}`);
			});
	}

	/**
	 * Handle open_file_tab message - open a file in a preview tab
	 */
	private handleOpenFileTab(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const filePath = message.filePath as string;
		// `switchToAgent` defaults to true so older clients keep the existing UX.
		const switchToAgent = message.switchToAgent !== false;
		logger.info(
			`[Web] Received open_file_tab message: session=${sessionId}, filePath=${filePath}, switchToAgent=${switchToAgent}`,
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

		const sessions = this.callbacks.getSessions?.();
		const session = sessions?.find((s) => s.id === sessionId);
		if (!session?.cwd) {
			sendErrorResult('Session not found or has no working directory');
			return;
		}
		// Relative paths resolve against the agent's working directory; absolute
		// paths are honored as-is. Opening files outside the worktree is
		// intentionally allowed - a paired client already has shell-level access
		// (execute_command), so confining preview tabs to the worktree gated
		// nothing the connection token doesn't already gate.
		const sessionRoot = path.resolve(session.cwd);
		const resolved = path.resolve(sessionRoot, filePath);

		if (!this.callbacks.openFileTab) {
			sendErrorResult('File tab opening not configured');
			return;
		}

		this.callbacks
			.openFileTab(sessionId, resolved, switchToAgent)
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
		// URLs can embed bearer tokens or session IDs - log length only.
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
		// cwd/shell/name can leak local usernames or project names - log
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
		// (same rule as open_file_tab - prevents spawning a shell outside scope).
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
		// background=true creates the tab without switching to/focusing it.
		// `maestro-cli dispatch --new-tab` sets this by default; `--focus` clears it.
		const background = message.background === true;
		// Prompts can contain user-authored content with secrets or PII -
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
			.newAITabWithPrompt(sessionId, prompt, background)
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
	 * Validate that a filename is safe for Auto Run read/save operations.
	 *
	 * Allows relative forward-slash subpaths (e.g. `loop/step-1`) so documents
	 * in subfolders can be opened and saved, but rejects:
	 *   - `..` traversal segments
	 *   - backslash separators (we only persist POSIX)
	 *   - absolute POSIX paths (leading `/`)
	 *   - absolute Windows paths (drive-letter prefix)
	 */
	private isValidFilename(filename: string): boolean {
		return (
			typeof filename === 'string' &&
			filename.length > 0 &&
			!filename.includes('..') &&
			!filename.includes('\\') &&
			!filename.startsWith('/') &&
			!/^[A-Za-z]:[\\/]/.test(filename)
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
				'Invalid filename: must not contain `..` traversal segments, backslashes, or absolute paths (POSIX `/` or Windows drive-letter). Forward-slash subpaths are allowed.'
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
				'Invalid filename: must not contain `..` traversal segments, backslashes, or absolute paths (POSIX `/` or Windows drive-letter). Forward-slash subpaths are allowed.'
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
	 * Handle reset_auto_run_doc_tasks message - revert all completed `[x]`
	 * checkboxes back to `[ ]` for a single document. Mirrors the desktop's
	 * "Reset Tasks" action so a playbook can be re-run from scratch.
	 */
	private handleResetAutoRunDocTasks(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const filename = message.filename as string;
		logger.info(
			`[Web] Received reset_auto_run_doc_tasks message: session=${sessionId}, filename=${filename}`,
			LOG_CONTEXT
		);

		if (!sessionId || !filename) {
			this.sendError(client, 'Missing sessionId or filename');
			return;
		}

		// Allow relative subdirectory paths (forward slashes) but reject traversal and
		// absolute paths (POSIX `/foo.md` and Windows `C:/foo.md` / `C:\foo.md`) so the
		// target always resolves under the Auto Run root.
		if (
			typeof filename !== 'string' ||
			filename.length === 0 ||
			filename.includes('..') ||
			filename.includes('\\') ||
			filename.startsWith('/') ||
			/^[A-Za-z]:[\\/]/.test(filename)
		) {
			this.sendError(client, 'Invalid filename');
			return;
		}

		if (!this.callbacks.resetAutoRunDocTasks) {
			this.sendError(client, 'Auto-run task reset not configured');
			return;
		}

		this.callbacks
			.resetAutoRunDocTasks(sessionId, filename)
			.then((success) => {
				this.send(client, {
					type: 'reset_auto_run_doc_tasks_result',
					success,
					sessionId,
					filename,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.reportHandlerError(
					client,
					error,
					'reset_auto_run_doc_tasks',
					{ sessionId, filename, requestId: message.requestId },
					'Failed to reset auto-run doc tasks'
				);
			});
	}

	/**
	 * Handle resume_auto_run_error message - clear the error pause and continue.
	 */
	private handleResumeAutoRunError(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}
		if (!this.callbacks.resumeAutoRunError) {
			this.sendError(client, 'Auto-run resume not configured');
			return;
		}
		this.callbacks
			.resumeAutoRunError(sessionId)
			.then((success) => {
				this.send(client, {
					type: 'resume_auto_run_error_result',
					success,
					sessionId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.reportHandlerError(
					client,
					error,
					'resume_auto_run_error',
					{ sessionId, requestId: message.requestId },
					'Failed to resume auto-run'
				);
			});
	}

	/**
	 * Handle skip_auto_run_document message - skip the failing document and
	 * continue with the next one in the queue.
	 */
	private handleSkipAutoRunDocument(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}
		if (!this.callbacks.skipAutoRunDocument) {
			this.sendError(client, 'Auto-run skip not configured');
			return;
		}
		this.callbacks
			.skipAutoRunDocument(sessionId)
			.then((success) => {
				this.send(client, {
					type: 'skip_auto_run_document_result',
					success,
					sessionId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.reportHandlerError(
					client,
					error,
					'skip_auto_run_document',
					{ sessionId, requestId: message.requestId },
					'Failed to skip auto-run document'
				);
			});
	}

	/**
	 * Handle abort_auto_run_error message - fully stop the run after an error.
	 */
	private handleAbortAutoRunError(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}
		if (!this.callbacks.abortAutoRunError) {
			this.sendError(client, 'Auto-run abort not configured');
			return;
		}
		this.callbacks
			.abortAutoRunError(sessionId)
			.then((success) => {
				this.send(client, {
					type: 'abort_auto_run_error_result',
					success,
					sessionId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.reportHandlerError(
					client,
					error,
					'abort_auto_run_error',
					{ sessionId, requestId: message.requestId },
					'Failed to abort auto-run'
				);
			});
	}

	/**
	 * Handle list_playbooks message - return the saved playbooks for a session.
	 */
	private handleListPlaybooks(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}
		if (!this.callbacks.listPlaybooks) {
			this.sendError(client, 'Playbook listing not configured');
			return;
		}
		this.callbacks
			.listPlaybooks(sessionId)
			.then((playbooks) => {
				this.send(client, {
					type: 'playbooks_list',
					sessionId,
					playbooks,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.reportHandlerError(
					client,
					error,
					'list_playbooks',
					{ sessionId, requestId: message.requestId },
					'Failed to list playbooks'
				);
			});
	}

	/**
	 * Handle create_playbook message - persist a new playbook with the given config.
	 */
	private handleCreatePlaybook(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const playbook = message.playbook as
			| {
					name?: unknown;
					documents?: unknown;
					loopEnabled?: unknown;
					maxLoops?: unknown;
					prompt?: unknown;
			  }
			| undefined;

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}
		if (!playbook || typeof playbook !== 'object') {
			this.sendError(client, 'Missing playbook payload');
			return;
		}
		if (typeof playbook.name !== 'string' || playbook.name.trim() === '') {
			this.sendError(client, 'Playbook name must be a non-empty string');
			return;
		}
		const documents = this.parsePlaybookDocuments(playbook.documents);
		if (documents === null) {
			this.sendError(client, 'Invalid playbook documents');
			return;
		}
		if (playbook.loopEnabled !== undefined && typeof playbook.loopEnabled !== 'boolean') {
			this.sendError(client, 'loopEnabled must be a boolean');
			return;
		}
		if (
			playbook.maxLoops !== undefined &&
			playbook.maxLoops !== null &&
			(typeof playbook.maxLoops !== 'number' ||
				!Number.isFinite(playbook.maxLoops) ||
				playbook.maxLoops < 0)
		) {
			this.sendError(client, 'maxLoops must be a finite non-negative number');
			return;
		}
		if (playbook.prompt !== undefined && typeof playbook.prompt !== 'string') {
			this.sendError(client, 'prompt must be a string');
			return;
		}

		if (!this.callbacks.createPlaybook) {
			this.sendError(client, 'Playbook creation not configured');
			return;
		}

		this.callbacks
			.createPlaybook(sessionId, {
				name: playbook.name.trim(),
				documents,
				loopEnabled: Boolean(playbook.loopEnabled),
				maxLoops: (playbook.maxLoops as number | null | undefined) ?? null,
				prompt: typeof playbook.prompt === 'string' ? playbook.prompt : '',
			})
			.then((created) => {
				this.send(client, {
					type: 'create_playbook_result',
					success: created !== null,
					sessionId,
					playbook: created,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.reportHandlerError(
					client,
					error,
					'create_playbook',
					{ sessionId, requestId: message.requestId },
					'Failed to create playbook'
				);
			});
	}

	/**
	 * Handle update_playbook message - apply partial updates to an existing playbook.
	 */
	private handleUpdatePlaybook(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const playbookId = message.playbookId as string;
		const updates = message.updates as
			| {
					name?: unknown;
					documents?: unknown;
					loopEnabled?: unknown;
					maxLoops?: unknown;
					prompt?: unknown;
			  }
			| undefined;

		if (!sessionId || !playbookId) {
			this.sendError(client, 'Missing sessionId or playbookId');
			return;
		}
		if (!updates || typeof updates !== 'object') {
			this.sendError(client, 'Missing updates payload');
			return;
		}

		const sanitized: Partial<{
			name: string;
			documents: WebPlaybookDocument[];
			loopEnabled: boolean;
			maxLoops: number | null;
			prompt: string;
		}> = {};

		if (updates.name !== undefined) {
			if (typeof updates.name !== 'string' || updates.name.trim() === '') {
				this.sendError(client, 'Playbook name must be a non-empty string');
				return;
			}
			sanitized.name = updates.name.trim();
		}
		if (updates.documents !== undefined) {
			const docs = this.parsePlaybookDocuments(updates.documents);
			if (docs === null) {
				this.sendError(client, 'Invalid playbook documents');
				return;
			}
			sanitized.documents = docs;
		}
		if (updates.loopEnabled !== undefined) {
			if (typeof updates.loopEnabled !== 'boolean') {
				this.sendError(client, 'loopEnabled must be a boolean');
				return;
			}
			sanitized.loopEnabled = updates.loopEnabled;
		}
		if (updates.maxLoops !== undefined) {
			if (
				updates.maxLoops !== null &&
				(typeof updates.maxLoops !== 'number' ||
					!Number.isFinite(updates.maxLoops) ||
					updates.maxLoops < 0)
			) {
				this.sendError(client, 'maxLoops must be a finite non-negative number');
				return;
			}
			sanitized.maxLoops = updates.maxLoops as number | null;
		}
		if (updates.prompt !== undefined) {
			if (typeof updates.prompt !== 'string') {
				this.sendError(client, 'prompt must be a string');
				return;
			}
			sanitized.prompt = updates.prompt;
		}

		if (!this.callbacks.updatePlaybook) {
			this.sendError(client, 'Playbook updates not configured');
			return;
		}

		this.callbacks
			.updatePlaybook(sessionId, playbookId, sanitized)
			.then((updated) => {
				this.send(client, {
					type: 'update_playbook_result',
					success: updated !== null,
					sessionId,
					playbook: updated,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.reportHandlerError(
					client,
					error,
					'update_playbook',
					{ sessionId, playbookId, requestId: message.requestId },
					'Failed to update playbook'
				);
			});
	}

	/**
	 * Handle delete_playbook message - remove a playbook.
	 */
	private handleDeletePlaybook(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const playbookId = message.playbookId as string;
		if (!sessionId || !playbookId) {
			this.sendError(client, 'Missing sessionId or playbookId');
			return;
		}
		if (!this.callbacks.deletePlaybook) {
			this.sendError(client, 'Playbook deletion not configured');
			return;
		}
		this.callbacks
			.deletePlaybook(sessionId, playbookId)
			.then((success) => {
				this.send(client, {
					type: 'delete_playbook_result',
					success,
					sessionId,
					playbookId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.reportHandlerError(
					client,
					error,
					'delete_playbook',
					{ sessionId, playbookId, requestId: message.requestId },
					'Failed to delete playbook'
				);
			});
	}

	/**
	 * Validate and normalize the `documents` field of a playbook payload.
	 * Returns the parsed array on success, or null on any validation failure.
	 *
	 * Filenames may contain forward-slash subdirectories (e.g. `loop/step-1`)
	 * but must not:
	 *   - contain `..` path-traversal segments
	 *   - contain backslashes (we only persist POSIX separators)
	 *   - be absolute (POSIX `/foo` or Windows drive-letter `C:/foo`)
	 *
	 * `resetOnCompletion` is validated strictly as a boolean when present;
	 * any other type is rejected rather than coerced, so a stray truthy
	 * value from a buggy client can't silently flip the flag on.
	 */
	private parsePlaybookDocuments(input: unknown): WebPlaybookDocument[] | null {
		if (!Array.isArray(input)) return null;
		const out: WebPlaybookDocument[] = [];
		for (const entry of input) {
			if (!entry || typeof entry !== 'object') return null;
			const e = entry as { filename?: unknown; resetOnCompletion?: unknown };
			if (typeof e.filename !== 'string' || e.filename.trim() === '') return null;
			if (e.filename.includes('..') || e.filename.includes('\\')) return null;
			if (e.filename.startsWith('/')) return null;
			if (/^[A-Za-z]:[\\/]/.test(e.filename)) return null;
			let resetOnCompletion = false;
			if (e.resetOnCompletion !== undefined) {
				if (typeof e.resetOnCompletion !== 'boolean') return null;
				resetOnCompletion = e.resetOnCompletion;
			}
			out.push({
				filename: e.filename,
				resetOnCompletion,
			});
		}
		return out;
	}

	/**
	 * Allowlist of setting keys modifiable from the web interface.
	 */
	private static readonly ALLOWED_SETTING_KEYS = new Set([
		'activeThemeId',
		'customThemeColors',
		'customThemeBaseId',
		'fontSize',
		'enterToSendAI',
		'defaultSaveToHistory',
		'defaultShowThinking',
		'notificationsEnabled',
		'audioFeedbackEnabled',
		'colorBlindMode',
		'conductorProfile',
		'maxOutputLines',
		'encoreFeatures',
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
	 * Known agent types for validation - derived from the canonical AGENT_IDS list.
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
	 * Handle create_worktree_session message - create a new agent in a git
	 * worktree branched off an existing parent agent, without an Auto Run
	 * playbook. The desktop creates the worktree, builds a child session linked
	 * to the parent, and returns the new agent's session id.
	 */
	private handleCreateWorktreeSession(client: WebClient, message: WebClientMessage): void {
		const parentSessionId = message.parentSessionId as string;
		const branchName = message.branchName as string;

		if (!parentSessionId || typeof parentSessionId !== 'string') {
			this.sendError(client, 'Missing or invalid parentSessionId');
			return;
		}

		if (!branchName || typeof branchName !== 'string' || branchName.trim() === '') {
			this.sendError(client, 'Missing or invalid branchName');
			return;
		}

		if (message.baseBranch !== undefined && typeof message.baseBranch !== 'string') {
			this.sendError(client, 'baseBranch must be a string');
			return;
		}

		if (!this.callbacks.createWorktreeSession) {
			this.sendError(client, 'Worktree session creation not configured');
			return;
		}

		const config = {
			branchName: branchName.trim(),
			baseBranch: (message.baseBranch as string | undefined)?.trim() || undefined,
		};

		this.callbacks
			.createWorktreeSession(parentSessionId, config)
			.then((result) => {
				this.send(client, {
					type: 'create_worktree_session_result',
					success: result.success,
					sessionId: result.sessionId,
					error: result.error,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to create worktree session: ${error.message}`);
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
	 * Handle update_session_cwd message - update an agent's working directory.
	 * The desktop's `projectRoot` (used for provider session storage) is left
	 * untouched so historical conversations stay addressable; only the UI-facing
	 * `cwd`/`fullPath` move. Renderer-side validation rejects updates while an
	 * agent process is alive - the PTY's cwd is fixed at spawn time.
	 */
	private handleUpdateSessionCwd(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const newCwd = message.newCwd as string;

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!newCwd || typeof newCwd !== 'string' || newCwd.trim() === '') {
			this.sendError(client, 'Missing or empty newCwd');
			return;
		}

		if (!this.callbacks.updateSessionCwd) {
			this.sendError(client, 'Session cwd updates not configured');
			return;
		}

		this.callbacks
			.updateSessionCwd(sessionId, newCwd)
			.then((result) => {
				this.send(client, {
					type: 'update_session_cwd_result',
					success: result.success,
					error: result.error,
					sessionId,
					newCwd,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to update session cwd: ${error.message}`);
			});
	}

	/**
	 * Handle update_session_ssh message - update an agent's SSH execution config
	 * (remote selection, working-dir override, history-sync flags). Only the
	 * fields present in `sshPatch` are merged onto the existing config. Like
	 * cwd updates, the renderer refuses while the agent process is alive because
	 * the spawn target is fixed at launch time.
	 */
	private handleUpdateSessionSsh(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const sshPatch = message.sshPatch as Record<string, unknown> | undefined;

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!sshPatch || typeof sshPatch !== 'object') {
			this.sendError(client, 'Missing or invalid sshPatch');
			return;
		}

		if (!this.callbacks.updateSessionSsh) {
			this.sendError(client, 'Session SSH updates not configured');
			return;
		}

		this.callbacks
			.updateSessionSsh(sessionId, sshPatch)
			.then((result) => {
				this.send(client, {
					type: 'update_session_ssh_result',
					success: result.success,
					error: result.error,
					sessionId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to update session SSH config: ${error.message}`);
			});
	}

	/**
	 * Handle update_session_config message - update an agent's editable
	 * per-session config (nudge / new-session message, custom path / args / env
	 * vars, model, effort, context window, Claude token-source tri-state). Only
	 * the keys present in `configPatch` are applied; a key with value `null`
	 * clears that field. These are spawn-time settings (they take effect on the
	 * next launch), so unlike cwd/SSH the renderer applies them even while the
	 * agent process is alive.
	 */
	private handleUpdateSessionConfig(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;
		const configPatch = message.configPatch as Record<string, unknown> | undefined;

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!configPatch || typeof configPatch !== 'object') {
			this.sendError(client, 'Missing or invalid configPatch');
			return;
		}

		if (!this.callbacks.updateSessionConfig) {
			this.sendError(client, 'Session config updates not configured');
			return;
		}

		this.callbacks
			.updateSessionConfig(sessionId, configPatch)
			.then((result) => {
				this.send(client, {
					type: 'update_session_config_result',
					success: result.success,
					error: result.error,
					sessionId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.sendError(client, `Failed to update session config: ${error.message}`);
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
		const requestedParentGroupId = message.parentGroupId;

		if (
			requestedParentGroupId !== undefined &&
			(typeof requestedParentGroupId !== 'string' || !requestedParentGroupId.trim())
		) {
			this.sendError(client, 'Invalid parentGroupId');
			return;
		}

		const parentGroupId = requestedParentGroupId?.trim();

		if (!name || typeof name !== 'string') {
			this.sendError(client, 'Missing or invalid group name');
			return;
		}

		if (!this.callbacks.createGroup) {
			this.sendError(client, 'Group creation not configured');
			return;
		}

		this.callbacks
			.createGroup(name, emoji, parentGroupId)
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
	 * Handle get_git_branches message - list local + remote branches for a session's
	 * cwd, used by the mobile Run-in-Worktree base-branch picker.
	 */
	private handleGetGitBranches(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!this.callbacks.getGitBranchesForSession) {
			this.sendError(client, 'Git branches not configured');
			return;
		}

		this.callbacks
			.getGitBranchesForSession(sessionId)
			.then((result) => {
				this.send(client, {
					type: 'git_branches',
					sessionId,
					branches: result.branches,
					currentBranch: result.currentBranch,
					requestId: message.requestId,
				});
			})
			.catch((error: unknown) => {
				this.reportHandlerError(
					client,
					error,
					'get_git_branches',
					{ sessionId, requestId: message.requestId },
					'Failed to get git branches'
				);
			});
	}

	/**
	 * Handle list_worktrees message - list existing worktrees for a session's cwd,
	 * used by mobile Run-in-Worktree to offer "use existing" alongside "create new".
	 */
	private handleListWorktrees(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId as string;

		if (!sessionId) {
			this.sendError(client, 'Missing sessionId');
			return;
		}

		if (!this.callbacks.listWorktreesForSession) {
			this.sendError(client, 'List worktrees not configured');
			return;
		}

		this.callbacks
			.listWorktreesForSession(sessionId)
			.then((result) => {
				this.send(client, {
					type: 'worktrees_list',
					sessionId,
					worktrees: result.worktrees,
					requestId: message.requestId,
				});
			})
			.catch((error: unknown) => {
				this.reportHandlerError(
					client,
					error,
					'list_worktrees',
					{ sessionId, requestId: message.requestId },
					'Failed to list worktrees'
				);
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

		// Strict validation - avoid truthy coercion so a string like "false"
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
	 * Handle cue_pipeline_list - return all named pipeline entries from
	 * the on-disk cue-pipeline-layout.json. Pipelines are returned as
	 * opaque JSON objects so the CLI doesn't need to share the editor's
	 * full type tree to round-trip them.
	 */
	private handleCuePipelineList(client: WebClient, message: WebClientMessage): void {
		if (!this.callbacks.listCuePipelines) {
			this.sendError(client, 'Cue pipeline list not available');
			return;
		}
		this.callbacks
			.listCuePipelines()
			.then(({ pipelines }) => {
				this.send(client, {
					type: 'cue_pipeline_list_result',
					pipelines,
					requestId: message.requestId,
					timestamp: Date.now(),
				});
			})
			.catch((error) => {
				const err = error instanceof Error ? error : new Error(String(error));
				logger.error(`Failed to list Cue pipelines: ${err.message}`, 'WebSocket');
				this.sendError(client, `Failed to list Cue pipelines: ${err.message}`);
			});
	}

	/**
	 * Handle cue_pipeline_get - fetch a single pipeline entry by name or
	 * id. Missing entries respond with `pipeline: null` rather than an
	 * error so scripts can treat "not found" as a normal value.
	 */
	private handleCuePipelineGet(client: WebClient, message: WebClientMessage): void {
		const identifier = message.identifier;
		if (typeof identifier !== 'string' || identifier.length === 0) {
			this.sendError(client, 'Missing identifier (pipeline name or id)');
			return;
		}
		if (!this.callbacks.getCuePipeline) {
			this.sendError(client, 'Cue pipeline get not available');
			return;
		}

		this.callbacks
			.getCuePipeline(identifier)
			.then((pipeline) => {
				this.send(client, {
					type: 'cue_pipeline_get_result',
					pipeline,
					requestId: message.requestId,
					timestamp: Date.now(),
				});
			})
			.catch((error) => {
				const err = error instanceof Error ? error : new Error(String(error));
				logger.error(`Failed to get Cue pipeline: ${err.message}`, 'WebSocket');
				this.sendError(client, `Failed to get Cue pipeline: ${err.message}`);
			});
	}

	/**
	 * Handle cue_pipeline_set - add or replace a pipeline entry. The
	 * callback returns a structured result so the CLI can map error codes
	 * (already_exists / not_found / invalid_input / …) to non-zero exit
	 * codes without parsing free-form messages.
	 */
	private handleCuePipelineSet(client: WebClient, message: WebClientMessage): void {
		const identifier = message.identifier;
		const pipeline = message.pipeline;
		const policyRaw = message.policy;
		if (typeof identifier !== 'string' || identifier.length === 0) {
			this.sendError(client, 'Missing identifier (pipeline name or id)');
			return;
		}
		if (policyRaw !== 'add' && policyRaw !== 'replace') {
			this.sendError(client, 'Invalid policy: must be "add" or "replace"');
			return;
		}
		if (pipeline === undefined || pipeline === null) {
			this.sendError(client, 'Missing pipeline payload');
			return;
		}
		if (!this.callbacks.setCuePipeline) {
			this.sendError(client, 'Cue pipeline set not available');
			return;
		}

		this.callbacks
			.setCuePipeline(identifier, pipeline, policyRaw)
			.then((result) => {
				this.send(client, {
					type: 'cue_pipeline_set_result',
					result,
					requestId: message.requestId,
					timestamp: Date.now(),
				});
			})
			.catch((error) => {
				const err = error instanceof Error ? error : new Error(String(error));
				logger.error(`Failed to set Cue pipeline: ${err.message}`, 'WebSocket');
				this.sendError(client, `Failed to set Cue pipeline: ${err.message}`);
			});
	}

	/**
	 * Handle cue_pipeline_remove - delete a pipeline entry by name or id.
	 */
	private handleCuePipelineRemove(client: WebClient, message: WebClientMessage): void {
		const identifier = message.identifier;
		if (typeof identifier !== 'string' || identifier.length === 0) {
			this.sendError(client, 'Missing identifier (pipeline name or id)');
			return;
		}
		if (!this.callbacks.removeCuePipeline) {
			this.sendError(client, 'Cue pipeline remove not available');
			return;
		}

		this.callbacks
			.removeCuePipeline(identifier)
			.then((result) => {
				this.send(client, {
					type: 'cue_pipeline_remove_result',
					result,
					requestId: message.requestId,
					timestamp: Date.now(),
				});
			})
			.catch((error) => {
				const err = error instanceof Error ? error : new Error(String(error));
				logger.error(`Failed to remove Cue pipeline: ${err.message}`, 'WebSocket');
				this.sendError(client, `Failed to remove Cue pipeline: ${err.message}`);
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
	 * Handle get_stats_aggregation message - return the Usage Dashboard's
	 * aggregated stats (query counts, durations, per-agent/day/hour breakdowns)
	 * for a time range. Reads the main-process stats singleton directly.
	 */
	private handleGetStatsAggregation(client: WebClient, message: WebClientMessage): void {
		const range = (message.range as string) || 'week';
		const validRanges = new Set(['day', 'week', 'month', 'quarter', 'year', 'all']);

		if (!validRanges.has(range)) {
			this.sendError(client, 'Invalid range. Must be one of: day, week, month, quarter, year, all');
			return;
		}

		try {
			const data = getStatsDB().getAggregatedStats(range as StatsTimeRange);
			this.send(client, {
				type: 'stats_aggregation',
				data,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		} catch (error) {
			this.sendError(
				client,
				`Failed to get stats aggregation: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * Handle stats_query message - run a single read-only SQL statement against
	 * the stats database and return the rows. Read-only enforcement lives in
	 * runReadonlyStatsQuery (dedicated readonly connection + single-statement +
	 * stmt.readonly assertion).
	 */
	private handleStatsQuery(client: WebClient, message: WebClientMessage): void {
		const sql = message.sql as string | undefined;
		const params = Array.isArray(message.params) ? (message.params as unknown[]) : [];

		if (!sql || typeof sql !== 'string') {
			this.sendError(client, 'Missing required "sql" string for stats_query');
			return;
		}

		try {
			const result = runReadonlyStatsQuery(sql, params);
			this.send(client, {
				type: 'stats_query_result',
				columns: result.columns,
				rows: result.rows,
				rowCount: result.rowCount,
				truncated: result.truncated,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		} catch (error) {
			this.sendError(
				client,
				`Stats query failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
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
		const sourceAgent =
			typeof message.sourceAgent === 'string' && message.sourceAgent.length > 0
				? message.sourceAgent
				: undefined;
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

		const colorResolution = resolveNotificationColor(
			rawColor,
			rawType,
			NOTIFICATION_VARIANT_COLORS
		);
		if (!colorResolution.ok) {
			if (colorResolution.source === 'color') {
				sendResult(
					false,
					`Invalid toast color: ${rawColor}. Must be one of: ${NOTIFICATION_COLORS.join(', ')}`
				);
			} else {
				sendResult(false, `Invalid toast type: ${rawType}`);
			}
			return;
		}
		const color = colorResolution.color;

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
			if (parseNotificationTimeout(duration) === null) {
				sendResult(
					false,
					'duration must be a positive number of seconds (use dismissible:true for sticky toasts)'
				);
				return;
			}
			if (!isNotificationTimeoutWithinLimit(duration, EXTERNAL_TOAST_MAX_DURATION_SECONDS)) {
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
				sourceAgent,
				tabId,
				actionUrl,
				actionLabel,
				clickAction,
			})
			.then((success) => sendResult(success, success ? undefined : 'Failed to show toast'))
			.catch((error) => sendResult(false, `Failed to show toast: ${error.message}`));
	}

	/**
	 * Handle movement - add/update/move/remove/clear an item on the agent-driven
	 * movement. Validates op + id, then hands a typed payload to the renderer via
	 * the movementView callback (the `remote:movement` channel).
	 */
	private handleMovement(client: WebClient, message: WebClientMessage): void {
		const op = typeof message.op === 'string' ? (message.op as MovementOp) : undefined;
		const rawId = typeof message.id === 'string' ? message.id : '';
		const id = rawId.trim();

		const sendResult = (success: boolean, error?: string) => {
			this.send(client, { type: 'movement_result', success, error, requestId: message.requestId });
		};

		if (!op || !MOVEMENT_OPS.includes(op)) {
			sendResult(false, `Invalid or missing op. Must be one of: ${MOVEMENT_OPS.join(', ')}`);
			return;
		}
		if (op !== 'clear' && !id) {
			sendResult(false, `Missing movement item id for op '${op}'`);
			return;
		}
		if (op !== 'clear' && rawId !== id) {
			sendResult(false, 'Movement item id must not contain surrounding whitespace');
			return;
		}

		let viewType: MovementViewType | undefined;
		const rawViewType = typeof message.viewType === 'string' ? message.viewType : undefined;
		if (rawViewType !== undefined) {
			if (!MOVEMENT_VIEW_TYPES.includes(rawViewType as MovementViewType)) {
				sendResult(
					false,
					`Invalid viewType: ${rawViewType}. Must be one of: ${MOVEMENT_VIEW_TYPES.join(', ')}`
				);
				return;
			}
			viewType = rawViewType as MovementViewType;
		}
		const body = typeof message.body === 'string' ? message.body : undefined;
		if ((op === 'add' || op === 'update') && viewType === 'html' && body === undefined) {
			sendResult(false, `Movement ${op} requires HTML content when viewType is 'html'`);
			return;
		}

		// Finite-only: JSON can smuggle Infinity (1e400) or NaN through `typeof
		// v === 'number'`, which would become invalid CSS geometry downstream.
		const num = (v: unknown): number | undefined =>
			typeof v === 'number' && Number.isFinite(v) ? v : undefined;
		const badGeometry = (['x', 'y', 'width', 'height'] as const).find(
			(k) => message[k] !== undefined && num(message[k]) === undefined
		);
		if (badGeometry) {
			sendResult(false, `Invalid ${badGeometry}: must be a finite number`);
			return;
		}
		const payload: MovementPayload = {
			op,
			id: id || undefined,
			viewType,
			x: num(message.x),
			y: num(message.y),
			width: num(message.width),
			height: num(message.height),
			title: typeof message.title === 'string' ? message.title : undefined,
			body,
		};

		if (!this.callbacks.movementView) {
			sendResult(false, 'Movement not configured');
			return;
		}
		this.callbacks
			.movementView(payload)
			.then((success) => sendResult(success, success ? undefined : 'Failed to update movement'))
			.catch((error) => sendResult(false, `Failed to update movement: ${error.message}`));
	}

	/**
	 * Handle get_movement_state - return the current movement snapshot (items + size)
	 * so an agent can compose around what's already placed.
	 */
	private handleGetMovementState(client: WebClient, message: WebClientMessage): void {
		const sendResult = (snapshot: MovementStateSnapshot | null, error?: string) => {
			this.send(client, {
				type: 'movement_state_result',
				success: !error,
				snapshot,
				error,
				requestId: message.requestId,
			});
		};
		if (!this.callbacks.getMovementState) {
			sendResult(null, 'Movement not configured');
			return;
		}
		this.callbacks
			.getMovementState()
			// A null snapshot means the read did NOT happen (flag off, renderer gone,
			// or timeout) - report failure so callers can retry instead of composing
			// against a false empty 0x0 layout.
			.then((snapshot) =>
				snapshot
					? sendResult(snapshot)
					: sendResult(null, 'Movement state unavailable (Concerto off or renderer not responding)')
			)
			.catch((error) => sendResult(null, `Failed to read movement state: ${error.message}`));
	}

	/** Capture a live HTML Movement and return its diagnostics to the CLI. */
	private handleGetMovementDesignerInspection(client: WebClient, message: WebClientMessage): void {
		const rawId = typeof message.id === 'string' ? message.id : '';
		const id = rawId.trim();
		const sendResult = (inspection: MovementDesignerInspection | null, error?: string) => {
			this.send(client, {
				type: 'movement_designer_inspection_result',
				success: !error,
				inspection,
				error,
				requestId: message.requestId,
			});
		};
		if (!id) {
			sendResult(null, 'Missing movement item id');
			return;
		}
		if (rawId !== id) {
			sendResult(null, 'Movement item id must not contain surrounding whitespace');
			return;
		}
		if (!this.callbacks.getMovementDesignerInspection) {
			sendResult(null, 'Movement designer inspection is not configured');
			return;
		}
		this.callbacks
			.getMovementDesignerInspection(id)
			.then((inspection) =>
				inspection
					? sendResult(inspection)
					: sendResult(null, `HTML Movement '${id}' is not visible or did not load`)
			)
			.catch((error) => sendResult(null, `Failed to inspect Movement: ${error.message}`));
	}

	/** Perform a click or text entry inside the sandboxed HTML Movement. */
	private handleInteractMovementDesigner(client: WebClient, message: WebClientMessage): void {
		const rawId = typeof message.id === 'string' ? message.id : '';
		const id = rawId.trim();
		const rawAction = message.action as Record<string, unknown> | undefined;
		const selector = typeof rawAction?.selector === 'string' ? rawAction.selector.trim() : '';
		const kind = rawAction?.kind;
		const sendResult = (result: ConcertoDesignerActionResult) => {
			this.send(client, {
				type: 'movement_designer_interaction_result',
				success: result.ok,
				result,
				error: result.ok ? undefined : result.message,
				requestId: message.requestId,
			});
		};
		if (!id || !selector || (kind !== 'click' && kind !== 'type')) {
			sendResult({
				ok: false,
				action: kind === 'type' ? 'type' : 'click',
				selector,
				message: 'Interaction requires an id, a CSS selector, and click or type action',
			});
			return;
		}
		if (rawId !== id) {
			sendResult({
				ok: false,
				action: kind,
				selector,
				message: 'Movement item id must not contain surrounding whitespace',
			});
			return;
		}
		if (selector.length > 2048) {
			sendResult({
				ok: false,
				action: kind,
				selector,
				message: 'CSS selector is too long',
			});
			return;
		}
		const value = typeof rawAction?.value === 'string' ? rawAction.value : '';
		if (kind === 'type' && value.length > 100_000) {
			sendResult({ ok: false, action: kind, selector, message: 'Input value is too long' });
			return;
		}
		const action: ConcertoDesignerAction =
			kind === 'click' ? { kind, selector } : { kind, selector, value };
		if (!this.callbacks.interactMovementDesigner) {
			sendResult({
				ok: false,
				action: action.kind,
				selector,
				message: 'Movement designer interaction is not configured',
			});
			return;
		}
		this.callbacks
			.interactMovementDesigner(id, action)
			.then(sendResult)
			.catch((error) =>
				sendResult({
					ok: false,
					action: action.kind,
					selector,
					message: `Failed to interact with Movement: ${error.message}`,
				})
			);
	}

	/**
	 * Handle cadenza - open/update/close a small agent-driven cadenza view.
	 * Validates the op/id/viewType/color, then hands a typed payload to the
	 * renderer via the cadenzaView callback (the `remote:cadenza` channel).
	 */
	private handleCadenza(client: WebClient, message: WebClientMessage): void {
		const op = typeof message.op === 'string' ? (message.op as CadenzaOp) : undefined;
		const id = typeof message.id === 'string' ? message.id : '';

		const sendResult = (success: boolean, error?: string) => {
			this.send(client, {
				type: 'cadenza_result',
				success,
				error,
				requestId: message.requestId,
			});
		};

		if (!op || !CADENZA_OPS.includes(op)) {
			sendResult(false, `Invalid or missing op. Must be one of: ${CADENZA_OPS.join(', ')}`);
			return;
		}
		if (!id) {
			sendResult(false, 'Missing cadenza id');
			return;
		}

		let viewType: CadenzaViewType | undefined;
		const rawViewType = typeof message.viewType === 'string' ? message.viewType : undefined;
		if (rawViewType !== undefined) {
			if (!CADENZA_VIEW_TYPES.includes(rawViewType as CadenzaViewType)) {
				sendResult(
					false,
					`Invalid viewType: ${rawViewType}. Must be one of: ${CADENZA_VIEW_TYPES.join(', ')}`
				);
				return;
			}
			viewType = rawViewType as CadenzaViewType;
		}
		if (op === 'open' && !viewType) {
			sendResult(false, `op 'open' requires a viewType (${CADENZA_VIEW_TYPES.join(' | ')})`);
			return;
		}

		let color: CadenzaColor | undefined;
		const rawColor = typeof message.color === 'string' ? message.color : undefined;
		if (rawColor !== undefined) {
			if (!CADENZA_COLORS.includes(rawColor as CadenzaColor)) {
				sendResult(
					false,
					`Invalid color: ${rawColor}. Must be one of: ${CADENZA_COLORS.join(', ')}`
				);
				return;
			}
			color = rawColor as CadenzaColor;
		}

		// Decision buttons: keep only well-formed { label, value } string pairs.
		const options = Array.isArray(message.options)
			? (message.options as unknown[]).filter(
					(o): o is { label: string; value: string } =>
						!!o &&
						typeof o === 'object' &&
						typeof (o as { label?: unknown }).label === 'string' &&
						typeof (o as { value?: unknown }).value === 'string'
				)
			: undefined;

		const payload: CadenzaPayload = {
			op,
			id,
			viewType,
			title: typeof message.title === 'string' ? message.title : undefined,
			body: typeof message.body === 'string' ? message.body : undefined,
			path: typeof message.path === 'string' ? message.path : undefined,
			options: options && options.length > 0 ? options : undefined,
			color,
			sessionId: typeof message.sessionId === 'string' ? message.sessionId : undefined,
		};

		if (!this.callbacks.cadenzaView) {
			sendResult(false, 'Cadenza views not configured');
			return;
		}

		this.callbacks
			.cadenzaView(payload)
			.then((success) => sendResult(success, success ? undefined : 'Failed to update cadenza view'))
			.catch((error) => sendResult(false, `Failed to update cadenza view: ${error.message}`));
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

		const colorResolution = resolveNotificationColor(
			rawColor,
			rawVariant,
			NOTIFICATION_VARIANT_COLORS
		);
		if (!colorResolution.ok) {
			if (colorResolution.source === 'color') {
				sendResult(
					false,
					`Invalid flash color: ${rawColor}. Must be one of: ${NOTIFICATION_COLORS.join(', ')}`
				);
			} else {
				sendResult(false, `Invalid flash variant: ${rawVariant}`);
			}
			return;
		}
		const color = colorResolution.color;

		// External flashes must be (0, 5000 ms] - `0` (never auto-dismiss) is rejected so
		// external scripts can't stick a permanent overlay on the user. In-app callers
		// using `notifyCenterFlash()` directly are not capped.
		if (duration !== undefined) {
			if (parseNotificationTimeout(duration) === null) {
				sendResult(false, 'duration must be a positive number of milliseconds');
				return;
			}
			if (!isNotificationTimeoutWithinLimit(duration, EXTERNAL_FLASH_MAX_DURATION_MS)) {
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
	 * Handle profiling_start - begin a Chromium contentTracing capture.
	 *
	 * contentTracing is an Electron main-process API, so the CLI (a plain bundle
	 * with no Electron) cannot drive it directly - it routes through here. Mirrors
	 * the desktop debug:startProfiling handler but with no renderer/dialog coupling
	 * so it works headlessly for external instrumentation loops.
	 */
	private async handleProfilingStart(client: WebClient, message: WebClientMessage): Promise<void> {
		try {
			const status = await startProfiling();
			this.send(client, {
				type: 'profiling_start_result',
				success: true,
				active: status.active,
				startedAt: status.startedAt,
				categories: status.categories,
				requestId: message.requestId,
			});
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			this.send(client, {
				type: 'profiling_start_result',
				success: false,
				error: `Failed to start profiling: ${errMsg}`,
				requestId: message.requestId,
			});
		}
	}

	/**
	 * Handle profiling_status - report whether a capture is in flight.
	 */
	private handleProfilingStatus(client: WebClient, message: WebClientMessage): void {
		const status = getProfilingStatus();
		this.send(client, {
			type: 'profiling_status_result',
			success: true,
			active: status.active,
			startedAt: status.startedAt,
			elapsedMs: status.elapsedMs,
			categories: status.categories,
			requestId: message.requestId,
		});
	}

	/**
	 * Handle profiling_stop - stop the capture and write the bundle to `outputPath`.
	 *
	 * Unlike the desktop flow (which prompts for a save location), the CLI supplies
	 * an absolute output path so external scripts can capture -> analyze -> loop
	 * unattended. The trace is flushed to a temp file first (ending the recording
	 * overhead immediately), then compressed into the .zip bundle at `outputPath`.
	 */
	private async handleProfilingStop(client: WebClient, message: WebClientMessage): Promise<void> {
		const sendResult = (success: boolean, extra?: Record<string, unknown>) => {
			this.send(client, {
				type: 'profiling_stop_result',
				success,
				...extra,
				requestId: message.requestId,
			});
		};

		const outputPath = typeof message.outputPath === 'string' ? message.outputPath : '';
		if (!outputPath) {
			sendResult(false, { error: 'Missing outputPath' });
			return;
		}
		// The CLI resolves to an absolute path (it knows the user's cwd); the app's
		// cwd is unrelated, so reject relative paths rather than guess.
		if (!path.isAbsolute(outputPath)) {
			sendResult(false, { error: `outputPath must be absolute, got: ${outputPath}` });
			return;
		}

		if (!getProfilingStatus().active) {
			sendResult(false, { error: 'No active profiling recording to stop' });
			return;
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const tracePath = path.join(app.getPath('temp'), `maestro-trace-${timestamp}.json`);

		try {
			const { durationMs, categories } = await stopProfiling(tracePath);
			// Ensure the destination directory exists so callers can point at a fresh
			// output dir per loop iteration without pre-creating it.
			await fs.mkdir(path.dirname(outputPath), { recursive: true });
			const finalized = await finalizeCapture(tracePath, outputPath, durationMs, categories);
			logger.info(`[Profiling] CLI capture saved: ${finalized.path} (${durationMs}ms trace)`);
			sendResult(true, {
				path: finalized.path,
				bundleSizeBytes: finalized.bundleSizeBytes,
				traceSizeBytes: finalized.traceSizeBytes,
				durationMs,
			});
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			sendResult(false, { error: `Failed to save profile: ${errMsg}` });
		} finally {
			await fs.rm(tracePath, { force: true }).catch(() => {});
		}
	}

	/**
	 * Handle marketplace_get_manifest - return merged official + local catalog.
	 */
	private handleMarketplaceGetManifest(client: WebClient, message: WebClientMessage): void {
		const refresh = message.refresh === true;

		if (!this.callbacks.getMarketplaceManifest) {
			this.send(client, {
				type: 'marketplace_get_manifest_result',
				success: false,
				error: 'Marketplace not configured',
				requestId: message.requestId,
			});
			return;
		}

		this.callbacks
			.getMarketplaceManifest({ refresh })
			.then((result) => {
				if (!result) {
					this.send(client, {
						type: 'marketplace_get_manifest_result',
						success: false,
						error: 'No manifest available',
						requestId: message.requestId,
					});
					return;
				}
				this.send(client, {
					type: 'marketplace_get_manifest_result',
					success: true,
					manifest: result.manifest,
					fromCache: result.fromCache,
					cacheAge: result.cacheAge,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.reportMarketplaceHandlerError(
					client,
					error,
					'marketplace_get_manifest_result',
					'marketplace_get_manifest',
					message,
					'Failed to load marketplace'
				);
			});
	}

	/**
	 * Reject a `playbookPath` that points at the local filesystem (absolute
	 * path or `~`-prefixed) or contains traversal segments / backslashes.
	 * Web clients can browse the official + local catalog by id, but they
	 * must never be able to coerce the server into reading arbitrary files
	 * via the marketplace fetch helpers. Defense-in-depth: downstream
	 * resolvers also validate, but rejecting at the entry point keeps
	 * future code changes from re-opening the bypass.
	 */
	private isUntrustedLocalPath(playbookPath: string): boolean {
		if (
			playbookPath.startsWith('/') ||
			playbookPath.startsWith('\\') ||
			playbookPath.startsWith('~/') ||
			playbookPath.startsWith('~\\') ||
			/^[a-zA-Z]:[\\/]/.test(playbookPath)
		) {
			return true;
		}
		// Reject any backslash anywhere - official/local manifest paths use
		// forward slashes, so a backslash is either a Windows-style absolute
		// fragment or a deliberate normalization-bypass attempt.
		if (playbookPath.includes('\\')) {
			return true;
		}
		// Reject `.` / `..` segments. `path.resolve()` collapses these later
		// but checking up front prevents a relative-traversal payload from
		// reaching downstream code at all.
		const segments = playbookPath.split('/');
		for (const segment of segments) {
			if (segment === '.' || segment === '..') {
				return true;
			}
		}
		return false;
	}

	/**
	 * Send a typed `marketplace_*_result` failure rather than a generic
	 * `error` frame. Clients that wait on the typed result type would
	 * otherwise miss the failure and time out (coderabbit feedback).
	 */
	private sendMarketplaceFailure(
		client: WebClient,
		type:
			| 'marketplace_get_manifest_result'
			| 'marketplace_get_document_result'
			| 'marketplace_get_readme_result'
			| 'marketplace_import_playbook_result',
		error: string,
		message: WebClientMessage,
		extra?: Record<string, unknown>
	): void {
		this.send(client, {
			type,
			success: false,
			error,
			requestId: message.requestId,
			...extra,
		});
	}

	/**
	 * Report an unexpected marketplace-handler exception to Sentry, then
	 * send a typed failure to the client. Mirrors `reportHandlerError` but
	 * preserves the `marketplace_*_result` typing the mobile client waits
	 * on. Without the Sentry capture step, transient production faults in
	 * the marketplace flow stay invisible because the client only sees the
	 * typed failure.
	 */
	private reportMarketplaceHandlerError(
		client: WebClient,
		error: unknown,
		type:
			| 'marketplace_get_manifest_result'
			| 'marketplace_get_document_result'
			| 'marketplace_get_readme_result'
			| 'marketplace_import_playbook_result',
		handler: string,
		message: WebClientMessage,
		userMessagePrefix: string,
		extra?: Record<string, unknown>
	): void {
		const err = error instanceof Error ? error : new Error(String(error));
		captureException(err, { extra: { area: 'web-server', handler, ...extra } });
		this.sendMarketplaceFailure(
			client,
			type,
			`${userMessagePrefix}: ${err.message}`,
			message,
			extra
		);
	}

	/**
	 * Handle marketplace_get_document - fetch a single document's content.
	 */
	private handleMarketplaceGetDocument(client: WebClient, message: WebClientMessage): void {
		const playbookPath = message.playbookPath;
		const filename = message.filename;

		if (typeof playbookPath !== 'string' || playbookPath.trim() === '') {
			this.sendMarketplaceFailure(
				client,
				'marketplace_get_document_result',
				'Missing or invalid playbookPath',
				message
			);
			return;
		}
		if (this.isUntrustedLocalPath(playbookPath)) {
			this.sendMarketplaceFailure(
				client,
				'marketplace_get_document_result',
				'Local filesystem paths are not allowed from web clients',
				message
			);
			return;
		}
		if (typeof filename !== 'string' || filename.trim() === '') {
			this.sendMarketplaceFailure(
				client,
				'marketplace_get_document_result',
				'Missing or invalid filename',
				message
			);
			return;
		}
		if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
			this.sendMarketplaceFailure(
				client,
				'marketplace_get_document_result',
				'Invalid filename',
				message
			);
			return;
		}

		if (!this.callbacks.getMarketplaceDocument) {
			this.sendMarketplaceFailure(
				client,
				'marketplace_get_document_result',
				'Marketplace not configured',
				message
			);
			return;
		}

		this.callbacks
			.getMarketplaceDocument(playbookPath, filename)
			.then((result) => {
				if (!result) {
					this.sendMarketplaceFailure(
						client,
						'marketplace_get_document_result',
						'Marketplace not configured',
						message
					);
					return;
				}
				this.send(client, {
					type: 'marketplace_get_document_result',
					success: true,
					content: result.content,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.reportMarketplaceHandlerError(
					client,
					error,
					'marketplace_get_document_result',
					'marketplace_get_document',
					message,
					'Failed to fetch document',
					{ playbookPath, filename }
				);
			});
	}

	/**
	 * Handle marketplace_get_readme - fetch a playbook's README.
	 */
	private handleMarketplaceGetReadme(client: WebClient, message: WebClientMessage): void {
		const playbookPath = message.playbookPath;
		if (typeof playbookPath !== 'string' || playbookPath.trim() === '') {
			this.sendMarketplaceFailure(
				client,
				'marketplace_get_readme_result',
				'Missing or invalid playbookPath',
				message
			);
			return;
		}
		if (this.isUntrustedLocalPath(playbookPath)) {
			this.sendMarketplaceFailure(
				client,
				'marketplace_get_readme_result',
				'Local filesystem paths are not allowed from web clients',
				message
			);
			return;
		}

		if (!this.callbacks.getMarketplaceReadme) {
			this.sendMarketplaceFailure(
				client,
				'marketplace_get_readme_result',
				'Marketplace not configured',
				message
			);
			return;
		}

		this.callbacks
			.getMarketplaceReadme(playbookPath)
			.then((result) => {
				if (!result) {
					this.sendMarketplaceFailure(
						client,
						'marketplace_get_readme_result',
						'Marketplace not configured',
						message
					);
					return;
				}
				this.send(client, {
					type: 'marketplace_get_readme_result',
					success: true,
					content: result.content,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.reportMarketplaceHandlerError(
					client,
					error,
					'marketplace_get_readme_result',
					'marketplace_get_readme',
					message,
					'Failed to fetch README',
					{ playbookPath }
				);
			});
	}

	/**
	 * Handle marketplace_import_playbook - import a playbook into the
	 * session's Auto Run folder. The server resolves both the folder path
	 * and SSH config from the session, so the mobile client doesn't need
	 * to send them - and can't lie about them.
	 */
	private handleMarketplaceImportPlaybook(client: WebClient, message: WebClientMessage): void {
		const sessionId = message.sessionId;
		const playbookId = message.playbookId;
		const targetFolderName = message.targetFolderName;

		if (typeof sessionId !== 'string' || sessionId.trim() === '') {
			this.sendMarketplaceFailure(
				client,
				'marketplace_import_playbook_result',
				'Missing sessionId',
				message
			);
			return;
		}
		if (typeof playbookId !== 'string' || playbookId.trim() === '') {
			this.sendMarketplaceFailure(
				client,
				'marketplace_import_playbook_result',
				'Missing playbookId',
				message,
				{ sessionId }
			);
			return;
		}
		if (typeof targetFolderName !== 'string' || targetFolderName.trim() === '') {
			this.sendMarketplaceFailure(
				client,
				'marketplace_import_playbook_result',
				'Missing targetFolderName',
				message,
				{ sessionId }
			);
			return;
		}
		// Reject path separators and traversal so the import folder cannot
		// escape the session's Auto Run root. The service-layer guard
		// (assertSafeTargetFolderName) is the source of truth, but
		// short-circuiting here returns a cleaner WebSocket error code.
		const trimmedFolder = targetFolderName.trim();
		if (
			trimmedFolder.includes('..') ||
			trimmedFolder.includes('/') ||
			trimmedFolder.includes('\\') ||
			trimmedFolder.startsWith('~') ||
			/^[a-zA-Z]:[\\/]/.test(trimmedFolder)
		) {
			this.sendMarketplaceFailure(
				client,
				'marketplace_import_playbook_result',
				'targetFolderName must be a single folder name without separators',
				message,
				{ sessionId }
			);
			return;
		}

		if (!this.callbacks.importMarketplacePlaybook) {
			this.sendMarketplaceFailure(
				client,
				'marketplace_import_playbook_result',
				'Marketplace import not configured',
				message,
				{ sessionId }
			);
			return;
		}

		this.callbacks
			.importMarketplacePlaybook(sessionId, playbookId, trimmedFolder)
			.then((result) => {
				this.send(client, {
					type: 'marketplace_import_playbook_result',
					success: result.success,
					error: result.error,
					playbook: result.playbook,
					importedDocs: result.importedDocs,
					importedAssets: result.importedAssets,
					sessionId,
					requestId: message.requestId,
				});
			})
			.catch((error) => {
				this.reportMarketplaceHandlerError(
					client,
					error,
					'marketplace_import_playbook_result',
					'marketplace_import_playbook',
					message,
					'Import failed',
					{ sessionId, playbookId, targetFolderName: trimmedFolder }
				);
			});
	}

	/**
	 * Handle list_desktop_sessions message - enumerate every open AI tab across
	 * desktop agents. Stateless read backed by the persisted session store; no
	 * subscription side-effects so external pollers (Maestro-Discord, Cue) can
	 * call this every few seconds without leaking state into the desktop.
	 */
	private handleListDesktopSessions(client: WebClient, message: WebClientMessage): void {
		const sessions = this.callbacks.listDesktopSessions ? this.callbacks.listDesktopSessions() : [];
		this.send(client, {
			type: 'desktop_sessions_list',
			success: true,
			sessions,
			requestId: message.requestId,
		});
	}

	/**
	 * Handle plugins_list_tools - project the registered plugin `tools`
	 * contributions into MCP tool defs for the `maestro-cli mcp serve` bridge.
	 * Returns an MCP-safe `name` (namespaced id, `/`->`__`) plus the real
	 * `toolId` so the bridge can reverse-map on call. Empty when the plugins flag
	 * is off or no manager is wired.
	 */
	private handlePluginsListTools(client: WebClient, message: WebClientMessage): void {
		const manager = getActivePluginManager();
		let tools: Array<{
			name: string;
			toolId: string;
			description: string;
			inputSchema: Record<string, unknown>;
		}> = [];
		if (manager && isPluginsFeatureEnabled()) {
			try {
				tools = manager.getContributions().tools.map((t) => ({
					name: t.id.replace(/\//g, '__').replace(/[^a-zA-Z0-9_-]/g, '_'),
					toolId: t.id,
					description: t.description,
					inputSchema:
						t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
							? t.inputSchema
							: { type: 'object' },
				}));
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				logger.warn(`[Web] plugins_list_tools failed: ${reason}`, LOG_CONTEXT);
			}
		}
		this.send(client, {
			type: 'plugins_list_tools_result',
			success: true,
			tools,
			requestId: message.requestId,
		});
	}

	/**
	 * Handle plugins_call_tool - risk-gate a model-initiated plugin tool call,
	 * then invoke it via the broker. The toolId MUST be a declared `tools`
	 * contribution (never an arbitrary command handler), and risk is rated on the
	 * model's ARGUMENTS via the shared Pianola gate - a HIGH verdict is surfaced
	 * and NEVER executed. Tool failures: `{ ok:false, error }`; blocks: `{ blocked:true }`.
	 */
	private async handlePluginsCallTool(client: WebClient, message: WebClientMessage): Promise<void> {
		const respond = (extra: Record<string, unknown>): void =>
			this.send(client, {
				type: 'plugins_call_tool_result',
				requestId: message.requestId,
				...extra,
			});
		const toolId = typeof message.toolId === 'string' ? message.toolId : '';
		if (!toolId) {
			respond({ ok: false, error: 'Missing toolId' });
			return;
		}
		const manager = getActivePluginManager();
		if (!manager || !isPluginsFeatureEnabled()) {
			respond({ ok: false, error: 'PluginsDisabled' });
			return;
		}
		const declaredTool = manager.getContributions().tools.find((t) => t.id === toolId);
		if (!declaredTool) {
			// Only DECLARED `tools` are model-callable; never let a tools/call name
			// resolve to an arbitrary command handler in the sandbox's shared map.
			respond({ ok: false, error: `Unknown tool: ${toolId}` });
			return;
		}
		const args = 'args' in message ? message.args : undefined;
		let argText = '';
		try {
			argText = JSON.stringify(args ?? {});
		} catch {
			argText = '';
		}
		// Rate risk on the declared tool's human name + description + the model's
		// args: catches a destructive tool by identity AND destructive args, without
		// the slug noise of the raw toolId. Follow-up: per-tool risk metadata + a
		// user-approval path for HIGH instead of a hard block.
		const riskText = `${declaredTool.name} ${declaredTool.description} ${argText}`;
		const verdict = evaluatePluginDispatch(riskText);
		if (!verdict.eligible) {
			respond({ ok: false, blocked: true, risk: verdict.risk, reason: verdict.reason });
			return;
		}
		try {
			const result = await manager.invokeTool(toolId, args);
			respond({ ok: true, result });
		} catch (error) {
			respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Handle get_session_history message - return the conversation log for a
	 * tab, optionally filtered by `sinceMs` (poll cursor) and/or `tail` (cap).
	 * Errors are returned in the same response type rather than as a generic
	 * `error` so the CLI's request/response pairing stays deterministic.
	 */
	private handleGetSessionHistory(client: WebClient, message: WebClientMessage): void {
		const tabId = typeof message.tabId === 'string' ? message.tabId : undefined;
		if (!tabId) {
			this.send(client, {
				type: 'session_history_result',
				success: false,
				error: 'Missing tabId',
				code: 'MISSING_TAB_ID',
				requestId: message.requestId,
			});
			return;
		}

		if (!this.callbacks.getSessionHistory) {
			this.send(client, {
				type: 'session_history_result',
				success: false,
				error: 'Session history not configured',
				code: 'NOT_CONFIGURED',
				requestId: message.requestId,
			});
			return;
		}

		const sinceMs =
			typeof message.sinceMs === 'number' && Number.isFinite(message.sinceMs)
				? message.sinceMs
				: undefined;
		const tail =
			typeof message.tail === 'number' && Number.isFinite(message.tail) && message.tail >= 0
				? Math.floor(message.tail)
				: undefined;

		const result = this.callbacks.getSessionHistory(tabId, { sinceMs, tail });
		if (!result) {
			this.send(client, {
				type: 'session_history_result',
				success: false,
				error: `Tab not found: ${tabId}`,
				code: 'TAB_NOT_FOUND',
				requestId: message.requestId,
			});
			return;
		}

		this.send(client, {
			type: 'session_history_result',
			success: true,
			tabId: result.tabId,
			sessionId: result.sessionId,
			agentId: result.agentId,
			agentSessionId: result.agentSessionId,
			projectPath: result.projectPath,
			messages: result.messages,
			requestId: message.requestId,
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
