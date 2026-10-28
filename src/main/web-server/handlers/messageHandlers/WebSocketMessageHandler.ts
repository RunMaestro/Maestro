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
 * - interrupt_turn: Stop an agent's running turn, or one tab's (CLI: `interrupt`)
 * - select_session: Select/switch to a session in desktop
 * - get_sessions: Request updated sessions list
 * - select_tab: Select a tab within a session
 * - new_tab: Create a new tab within a session
 * - close_tab: Close a tab within a session
 * - rename_tab: Rename a tab within a session
 * - open_file_tab: Open a file in a preview tab
 * - open_document_graph: Render the Document Graph over a file set or directory
 * - refresh_file_tree: Refresh the file tree for a session
 * - get_file_tree: Read directory tree from filesystem for web file explorer
 * - get_settings: Fetch current web settings
 * - set_setting: Modify a single setting (allowlisted keys only)
 * - acappella_signal: WebRTC signaling for a paired A Cappella voice device
 * - voice_wake_enrollment: record, train and manage a user's own wake phrase
 * - voice_control: the Voice HUD's and the Voice settings' actions, for maestro-cli
 * - list_desktop_sessions: Enumerate open AI tabs across all agents (CLI: `session list`)
 * - get_session_history: Return tab conversation history with --since/--tail filters (CLI: `session show`)
 * - computer_history_command: Computer History writes, CLI clients only (CLI: `computer-history`)
 * - throughput_gauge_command: Show, hide, configure, or read the Throughput Gauge (CLI: `throughput-gauge`)
 * - live_command: Read or switch Live mode and Remote Control, CLI clients only (CLI: `live`)
 *
 * Auto Run message types (refresh_auto_run_docs, configure_auto_run, get_auto_run_docs,
 * get_auto_run_state, get_auto_run_document, save_auto_run_document, stop_auto_run, etc.)
 * are handled by ./autoRun.
 */

import { app } from 'electron';
import { logger } from '../../../utils/logger';
import { captureException } from '../../../utils/sentry';
import { getCommitHash } from '../../../utils/build-info';
import { LOG_CONTEXT } from './shared';
import { sendBounded } from '../../services/socket-send';
import type {
	WebClientMessage,
	WebClient,
	MessageHandlerCallbacks,
	MessageHandlerContext,
} from './types';
import {
	handleSendCommand,
	handleSwitchMode,
	handleSelectSession,
	handleCrossAgentAsk,
	handleInterruptTurn,
} from './commands';
import { ACAPPELLA_SIGNAL_MESSAGE, handleACappellaSignal } from './acappellaSignal';
import { VOICE_WAKE_ENROLLMENT_MESSAGE, handleVoiceWakeEnrollment } from './voiceWake';
import { VOICE_CONTROL_MESSAGE, handleVoiceControl } from './voiceControl';
import {
	handleGetSessions,
	handleCreateSession,
	handleCreateWorktreeSession,
	handleDeleteSession,
	handleRenameSession,
	handleUpdateSessionCwd,
	handleUpdateSessionSsh,
	handleUpdateSessionConfig,
	handleProviderTranslation,
	handleListDesktopSessions,
	handleGetSessionHistory,
} from './sessions';
import { handleRefreshFileTree, handleGetFileTree } from './fileTree';
import {
	handleNotifyToast,
	handleNotifyCenterFlash,
	handleNotificationInbox,
} from './notifications';
import { handleCadenza } from './cadenza';
import {
	handleMovement,
	handleGetMovementState,
	handleGetMovementDesignerInspection,
	handleInteractMovementDesigner,
} from './movement';
import { handleProfilingStart, handleProfilingStatus, handleProfilingStop } from './profiling';
import { handleQuickChat } from './quickChat';
import {
	handleSupportPackageCreate,
	handleFeedbackCheckAuth,
	handleFeedbackGhLoginCommand,
	handleFeedbackAccounts,
	handleFeedbackDiagnose,
	handleFeedbackSearch,
	handleFeedbackSubmit,
	handleFeedbackSubscribe,
} from './feedback';
import {
	handleMarketplaceGetManifest,
	handleMarketplaceGetDocument,
	handleMarketplaceGetReadme,
	handleMarketplaceImportPlaybook,
} from './marketplace';
import { handlePluginsListTools, handlePluginsCallTool, handlePluginsSendAgent } from './plugins';
import {
	handleLocalModelsCancel,
	handleLocalModelsDownload,
	handleLocalModelsEndpointModels,
	handleLocalModelsEndpointsDetect,
	handleLocalModelsEndpointTest,
	handleLocalModelsGitDraft,
	handleLocalModelsTranscribe,
	handleLocalModelsList,
	handleLocalModelsHfAdd,
	handleLocalModelsHfRemove,
	handleLocalModelsPause,
	handleLocalModelsRuntimeInstall,
	handleLocalModelsRuntimesList,
	handleLocalModelsRemove,
	handleLocalModelsRunOnTest,
	handleLocalModelsTierOptions,
	handleLocalModelsRunTask,
	handleLocalModelsSemanticIndexStatus,
	handleLocalModelsProxyStatus,
	handleLocalModelsProxyBlock,
	handleLocalModelsServerEnsure,
	handleLocalModelsServerKey,
	handleLocalModelsServerSet,
	handleLocalModelsServerStart,
	handleLocalModelsServerStatus,
	handleLocalModelsServerStop,
	handleLocalModelsSearch,
	handleLocalModelsTabCleanup,
	handleSystemOneAccess,
	handleModelRouteTurn,
	handleModelRouteCorrect,
	handleSystemOneAgentRequest,
	handleSystemOneKeyClear,
	handleSystemOneKeySet,
	handleSystemOneLedger,
	handleSystemOneSet,
	handleSystemOneStatus,
	handleSystemOneTest,
	handleSystemOneUsage,
	handleLocalModelsTaskReadiness,
	handleLocalModelsVerify,
	handleNotifySpeak,
} from './localModels';
import {
	handleRefreshAutoRunDocs,
	handleConfigureAutoRun,
	handleLaunchGoalRun,
	handleSetAutoRunFolder,
	handleGetAutoRunDocs,
	handleGetAutoRunState,
	handleGetAutoRunDocument,
	handleSaveAutoRunDocument,
	handleStopAutoRun,
	handleResetAutoRunDocTasks,
	handleResumeAutoRunError,
	handleSkipAutoRunDocument,
	handleAbortAutoRunError,
} from './autoRun';
import { handleSnoozeCommand } from './snooze';
import { handleClosedTabCommand } from './closedTabs';
import { handleComputerHistoryCommand } from './computerHistory';
import { handleLiveCommand } from './live';
import { handleMaestroRunCommand } from './maestroRun';
import { handleDataviewCommand } from './dataview';
import { handleAutoRunSteeringCommand } from './autoRunSteering';
import { handleWindowCommand } from './windows';
import { handleThroughputGaugeCommand } from './throughputGauge';
import {
	handleSelectTab,
	handleTabProvider,
	handleNewTab,
	handleCloseTab,
	handleRenameTab,
	handleStarTab,
	handleReorderTab,
	handleToggleBookmark,
	handleOpenFileTab,
	handleOpenDocumentGraph,
	handleOpenBrowserTab,
	handleOpenModal,
	handleWriteTerminalTab,
	handleReadTerminalTab,
	handleListTerminalTabs,
	handleCloseBrowserTab,
	handleOpenTerminalTab,
	handleNewAITabWithPrompt,
} from './tabs';
import { handleGetSettings, handleSetSetting } from './settings';
import { handleTerminalWrite, handleTerminalResize } from './terminal';
import {
	handleGetGitStatus,
	handleGetGitDiff,
	handleGetGitBranches,
	handleListWorktrees,
} from './git';
import {
	handleGetGroups,
	handleCreateGroup,
	handleRenameGroup,
	handleUpdateGroup,
	handleUpdateGroupSettings,
	handleDeleteGroup,
	handleMoveSessionToGroup,
} from './groups';
import {
	handleGetGroupChats,
	handleStartGroupChat,
	handleGetGroupChatState,
	handleSendGroupChatMessage,
	handleSteerGroupChat,
	handleStopGroupChat,
	handleArchiveGroupChat,
} from './groupChat';
import {
	handleMergeContext,
	handleTransferContext,
	handleSummarizeContext,
	handleCreateGist,
} from './contextOps';
import {
	handleGetCueSubscriptions,
	handleToggleCueSubscription,
	handleSetCueSubscriptionGate,
	handleSetCueSubscriptionInjectionScreen,
	handleGetCueActivity,
	handleTriggerCueSubscription,
	handleCuePipelineList,
	handleCuePipelineGet,
	handleCuePipelineSet,
	handleCuePipelineRemove,
	handleCueBundleExport,
	handleCueBundleImport,
} from './cue';
import {
	handleEnqueueCommand,
	handleListQueue,
	handleRemoveQueueItem,
	handleSteerQueueItem,
	handleSetQueueItemPaused,
	handleMergeQueueItem,
} from './queue';
import {
	handleListPlaybooks,
	handleCreatePlaybook,
	handleUpdatePlaybook,
	handleDeletePlaybook,
} from './playbooks';
import {
	handleGetUsageDashboard,
	handleGetStatsAggregation,
	handleGetModelUsage,
	handleGetTokenUsage,
	handleGetStatsIndexing,
	handleStatsQuery,
	handleGetAchievements,
	handleGenerateDirectorNotesSynopsis,
} from './stats';

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
	 * Helper to send a JSON message to a client with timestamp. `onSent` runs
	 * once the frame is handed to the socket, for a handler whose next step
	 * closes that socket (a Live switch replaces the server).
	 */
	private send(client: WebClient, data: Record<string, unknown>, onSent?: () => void): void {
		if (client.isAuthorized?.() === false) return;
		const frame = JSON.stringify({ ...data, timestamp: Date.now() });
		if (!onSent) {
			sendBounded(client.socket, frame);
			return;
		}
		client.socket.send(frame, (error?: Error) => {
			if (error) {
				logger.warn(`[Web] Reply to ${client.id} failed: ${error.message}`, LOG_CONTEXT);
				return;
			}
			onSent();
		});
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
	 * Bundles callbacks and the response-sending helpers for domain handler
	 * modules extracted out of this class (e.g. `./autoRun`).
	 */
	private get ctx(): MessageHandlerContext {
		return {
			callbacks: this.callbacks,
			send: this.send.bind(this),
			sendError: this.sendError.bind(this),
			reportHandlerError: this.reportHandlerError.bind(this),
		};
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
				handleSendCommand(this.ctx, client, message);
				break;

			case 'cross_agent_ask':
				handleCrossAgentAsk(this.ctx, client, message);
				break;

			case 'switch_mode':
				handleSwitchMode(this.ctx, client, message);
				break;

			case 'interrupt_turn':
				handleInterruptTurn(this.ctx, client, message);
				break;

			case 'select_session':
				handleSelectSession(this.ctx, client, message);
				break;

			case 'get_sessions':
				handleGetSessions(this.ctx, client);
				break;

			case 'get_app_info':
				this.handleGetAppInfo(client, message);
				break;

			case 'select_tab':
				handleSelectTab(this.ctx, client, message);
				break;

			case 'new_tab':
				handleNewTab(this.ctx, client, message);
				break;

			case 'close_tab':
				handleCloseTab(this.ctx, client, message);
				break;

			case 'rename_tab':
				handleRenameTab(this.ctx, client, message);
				break;

			case 'star_tab':
				handleStarTab(this.ctx, client, message);
				break;

			case 'snooze_command':
				handleSnoozeCommand(this.ctx, client, message);
				break;

			case 'closed_tab_command':
				handleClosedTabCommand(this.ctx, client, message);
				break;

			case 'computer_history_command':
				void handleComputerHistoryCommand(this.ctx, client, message);
				break;

			case 'live_command':
				handleLiveCommand(this.ctx, client, message);
				break;

			case 'maestro_run_command':
				void handleMaestroRunCommand(this.ctx, client, message);
				break;

			case 'dataview_command':
				void handleDataviewCommand(this.ctx, client, message);
				break;

			case 'auto_run_steering_command':
				handleAutoRunSteeringCommand(this.ctx, client, message);
				break;

			case 'window_command':
				handleWindowCommand(this.ctx, client, message);
				break;

			case 'throughput_gauge_command':
				handleThroughputGaugeCommand(this.ctx, client, message);
				break;

			case 'reorder_tab':
				handleReorderTab(this.ctx, client, message);
				break;

			case 'toggle_bookmark':
				handleToggleBookmark(this.ctx, client, message);
				break;

			case 'open_file_tab':
				handleOpenFileTab(this.ctx, client, message);
				break;

			case 'open_document_graph':
				handleOpenDocumentGraph(this.ctx, client, message);
				break;

			case 'write_terminal_tab':
				void handleWriteTerminalTab(this.ctx, client, message);
				break;

			case 'list_terminal_tabs':
				void handleListTerminalTabs(this.ctx, client, message);
				break;

			case 'read_terminal_tab':
				void handleReadTerminalTab(this.ctx, client, message);
				break;

			case 'open_modal':
				handleOpenModal(this.ctx, client, message);
				break;

			case 'open_browser_tab':
				handleOpenBrowserTab(this.ctx, client, message);
				break;

			case 'close_browser_tab':
				handleCloseBrowserTab(this.ctx, client, message);
				break;

			case 'open_terminal_tab':
				handleOpenTerminalTab(this.ctx, client, message);
				break;

			case 'new_ai_tab_with_prompt':
				handleNewAITabWithPrompt(this.ctx, client, message);
				break;

			case 'enqueue_command':
				handleEnqueueCommand(this.ctx, client, message);
				break;

			case 'list_queue':
				handleListQueue(this.ctx, client, message);
				break;

			case 'remove_queue_item':
				handleRemoveQueueItem(this.ctx, client, message);
				break;

			case 'steer_queue_item':
				handleSteerQueueItem(this.ctx, client, message);
				break;

			case 'set_queue_item_paused':
				handleSetQueueItemPaused(this.ctx, client, message);
				break;

			case 'merge_queue_item':
				handleMergeQueueItem(this.ctx, client, message);
				break;

			case 'refresh_file_tree':
				handleRefreshFileTree(this.ctx, client, message);
				break;

			case 'get_file_tree':
				handleGetFileTree(this.ctx, client, message);
				break;

			case 'refresh_auto_run_docs':
				handleRefreshAutoRunDocs(this.ctx, client, message);
				break;

			case 'configure_auto_run':
				handleConfigureAutoRun(this.ctx, client, message);
				break;

			case 'launch_goal_run':
				handleLaunchGoalRun(this.ctx, client, message);
				break;

			case 'create_worktree_session':
				handleCreateWorktreeSession(this.ctx, client, message);
				break;

			case 'set_auto_run_folder':
				handleSetAutoRunFolder(this.ctx, client, message);
				break;

			case 'get_auto_run_docs':
				handleGetAutoRunDocs(this.ctx, client, message);
				break;

			case 'get_auto_run_state':
				handleGetAutoRunState(this.ctx, client, message);
				break;

			case 'get_auto_run_document':
				handleGetAutoRunDocument(this.ctx, client, message);
				break;

			case 'save_auto_run_document':
				handleSaveAutoRunDocument(this.ctx, client, message);
				break;

			case 'stop_auto_run':
				handleStopAutoRun(this.ctx, client, message);
				break;

			case 'reset_auto_run_doc_tasks':
				handleResetAutoRunDocTasks(this.ctx, client, message);
				break;

			case 'resume_auto_run_error':
				handleResumeAutoRunError(this.ctx, client, message);
				break;

			case 'skip_auto_run_document':
				handleSkipAutoRunDocument(this.ctx, client, message);
				break;

			case 'abort_auto_run_error':
				handleAbortAutoRunError(this.ctx, client, message);
				break;

			case 'list_playbooks':
				handleListPlaybooks(this.ctx, client, message);
				break;

			case 'create_playbook':
				handleCreatePlaybook(this.ctx, client, message);
				break;

			case 'update_playbook':
				handleUpdatePlaybook(this.ctx, client, message);
				break;

			case 'delete_playbook':
				handleDeletePlaybook(this.ctx, client, message);
				break;

			case 'get_settings':
				handleGetSettings(this.ctx, client, message);
				break;

			case 'set_setting':
				handleSetSetting(this.ctx, client, message);
				break;

			case 'create_session':
				handleCreateSession(this.ctx, client, message);
				break;

			case 'delete_session':
				handleDeleteSession(this.ctx, client, message);
				break;

			case 'rename_session':
				handleRenameSession(this.ctx, client, message);
				break;

			case 'update_session_cwd':
				handleUpdateSessionCwd(this.ctx, client, message);
				break;

			case 'update_session_ssh':
				handleUpdateSessionSsh(this.ctx, client, message);
				break;

			case 'update_session_config':
				handleUpdateSessionConfig(this.ctx, client, message);
				break;

			case 'provider_translation':
				handleProviderTranslation(this.ctx, client, message);
				break;

			case 'tab_provider':
				void handleTabProvider(this.ctx, client, message);
				break;

			case 'get_groups':
				handleGetGroups(this.ctx, client, message);
				break;

			case 'create_group':
				handleCreateGroup(this.ctx, client, message);
				break;

			case 'rename_group':
				handleRenameGroup(this.ctx, client, message);
				break;

			case 'update_group':
				handleUpdateGroup(this.ctx, client, message);
				break;

			case 'update_group_settings':
				handleUpdateGroupSettings(this.ctx, client, message);
				break;

			case 'delete_group':
				handleDeleteGroup(this.ctx, client, message);
				break;

			case 'move_session_to_group':
				handleMoveSessionToGroup(this.ctx, client, message);
				break;

			case 'get_git_status':
				handleGetGitStatus(this.ctx, client, message);
				break;

			case 'get_git_diff':
				handleGetGitDiff(this.ctx, client, message);
				break;

			case 'get_git_branches':
				handleGetGitBranches(this.ctx, client, message);
				break;

			case 'list_worktrees':
				handleListWorktrees(this.ctx, client, message);
				break;

			case 'get_group_chats':
				handleGetGroupChats(this.ctx, client, message);
				break;

			case 'start_group_chat':
				handleStartGroupChat(this.ctx, client, message);
				break;

			case 'get_group_chat_state':
				handleGetGroupChatState(this.ctx, client, message);
				break;

			case 'send_group_chat_message':
				handleSendGroupChatMessage(this.ctx, client, message);
				break;

			case 'steer_group_chat':
				handleSteerGroupChat(this.ctx, client, message);
				break;

			case 'stop_group_chat':
				handleStopGroupChat(this.ctx, client, message);
				break;

			case 'archive_group_chat':
				handleArchiveGroupChat(this.ctx, client, message);
				break;

			case 'merge_context':
				handleMergeContext(this.ctx, client, message);
				break;

			case 'transfer_context':
				handleTransferContext(this.ctx, client, message);
				break;

			case 'summarize_context':
				handleSummarizeContext(this.ctx, client, message);
				break;

			case 'create_gist':
				handleCreateGist(this.ctx, client, message);
				break;

			case 'get_cue_subscriptions':
				handleGetCueSubscriptions(this.ctx, client, message);
				break;

			case 'toggle_cue_subscription':
				handleToggleCueSubscription(this.ctx, client, message);
				break;

			case 'set_cue_subscription_gate':
				handleSetCueSubscriptionGate(this.ctx, client, message);
				break;

			case 'set_cue_subscription_injection_screen':
				handleSetCueSubscriptionInjectionScreen(this.ctx, client, message);
				break;

			case 'get_cue_activity':
				handleGetCueActivity(this.ctx, client, message);
				break;

			case 'trigger_cue_subscription':
				handleTriggerCueSubscription(this.ctx, client, message);
				break;

			case 'cue_pipeline_list':
				handleCuePipelineList(this.ctx, client, message);
				break;

			case 'cue_pipeline_get':
				handleCuePipelineGet(this.ctx, client, message);
				break;

			case 'cue_pipeline_set':
				handleCuePipelineSet(this.ctx, client, message);
				break;

			case 'cue_pipeline_remove':
				handleCuePipelineRemove(this.ctx, client, message);
				break;

			case 'cue_bundle_export':
				handleCueBundleExport(this.ctx, client, message);
				break;

			case 'cue_bundle_import':
				handleCueBundleImport(this.ctx, client, message);
				break;

			case 'get_usage_dashboard':
				handleGetUsageDashboard(this.ctx, client, message);
				break;

			case 'get_achievements':
				handleGetAchievements(this.ctx, client, message);
				break;

			case 'get_stats_aggregation':
				handleGetStatsAggregation(this.ctx, client, message);
				break;

			case 'get_model_usage':
				void handleGetModelUsage(this.ctx, client, message);
				break;

			case 'get_token_usage':
				handleGetTokenUsage(this.ctx, client, message);
				break;

			case 'get_stats_indexing':
				handleGetStatsIndexing(this.ctx, client, message);
				break;

			case 'stats_query':
				handleStatsQuery(this.ctx, client, message);
				break;

			case 'generate_director_notes_synopsis':
				handleGenerateDirectorNotesSynopsis(this.ctx, client, message);
				break;

			case 'terminal_write':
				handleTerminalWrite(this.ctx, client, message);
				break;

			case 'terminal_resize':
				handleTerminalResize(this.ctx, client, message);
				break;

			case 'notification_inbox':
				void handleNotificationInbox(this.ctx, client, message);
				break;

			case 'notify_toast':
				handleNotifyToast(this.ctx, client, message);
				break;

			case 'movement':
				handleMovement(this.ctx, client, message);
				break;
			case 'get_movement_state':
				handleGetMovementState(this.ctx, client, message);
				break;
			case 'get_movement_designer_inspection':
				handleGetMovementDesignerInspection(this.ctx, client, message);
				break;
			case 'interact_movement_designer':
				handleInteractMovementDesigner(this.ctx, client, message);
				break;
			case 'cadenza':
				handleCadenza(this.ctx, client, message);
				break;

			case 'notify_center_flash':
				handleNotifyCenterFlash(this.ctx, client, message);
				break;

			case 'profiling_start':
				void handleProfilingStart(this.ctx, client, message);
				break;

			case 'profiling_stop':
				void handleProfilingStop(this.ctx, client, message);
				break;

			case 'profiling_status':
				handleProfilingStatus(this.ctx, client, message);
				break;

			case 'quick_chat':
				handleQuickChat(this.ctx, client, message);
				break;

			case 'support_package_create':
				void handleSupportPackageCreate(this.ctx, client, message);
				break;

			case 'feedback_check_auth':
				void handleFeedbackCheckAuth(this.ctx, client, message);
				break;

			case 'feedback_search':
				void handleFeedbackSearch(this.ctx, client, message);
				break;

			case 'feedback_gh_login_command':
				void handleFeedbackGhLoginCommand(this.ctx, client, message);
				break;

			case 'feedback_submit':
				void handleFeedbackSubmit(this.ctx, client, message);
				break;

			case 'feedback_subscribe':
				void handleFeedbackSubscribe(this.ctx, client, message);
				break;

			case 'feedback_accounts':
				void handleFeedbackAccounts(this.ctx, client, message);
				break;

			case 'feedback_diagnose':
				void handleFeedbackDiagnose(this.ctx, client, message);
				break;

			case 'local_models_list':
				void handleLocalModelsList(this.ctx, client, message);
				break;

			case 'local_models_download':
				void handleLocalModelsDownload(this.ctx, client, message);
				break;

			case 'local_models_runtimes_list':
				void handleLocalModelsRuntimesList(this.ctx, client, message);
				break;

			case 'local_models_runtime_install':
				void handleLocalModelsRuntimeInstall(this.ctx, client, message);
				break;

			case 'local_models_pause':
				void handleLocalModelsPause(this.ctx, client, message);
				break;

			case 'local_models_cancel':
				void handleLocalModelsCancel(this.ctx, client, message);
				break;

			case 'local_models_verify':
				void handleLocalModelsVerify(this.ctx, client, message);
				break;

			case 'local_models_remove':
				void handleLocalModelsRemove(this.ctx, client, message);
				break;

			case 'local_models_hf_add':
				void handleLocalModelsHfAdd(this.ctx, client, message);
				break;

			case 'local_models_hf_remove':
				void handleLocalModelsHfRemove(this.ctx, client, message);
				break;

			case 'local_models_endpoints_detect':
				void handleLocalModelsEndpointsDetect(this.ctx, client, message);
				break;

			case 'local_models_endpoint_models':
				void handleLocalModelsEndpointModels(this.ctx, client, message);
				break;

			case 'local_models_endpoint_test':
				void handleLocalModelsEndpointTest(this.ctx, client, message);
				break;

			case 'local_models_run_task':
				void handleLocalModelsRunTask(this.ctx, client, message);
				break;

			case 'local_models_task_readiness':
				void handleLocalModelsTaskReadiness(this.ctx, client, message);
				break;

			case 'local_models_git_draft':
				void handleLocalModelsGitDraft(this.ctx, client, message);
				break;

			case 'local_models_transcribe':
				void handleLocalModelsTranscribe(this.ctx, client, message);
				break;

			case 'notify_speak':
				void handleNotifySpeak(this.ctx, client, message);
				break;

			case VOICE_WAKE_ENROLLMENT_MESSAGE:
				void handleVoiceWakeEnrollment(this.ctx, client, message);
				break;

			case VOICE_CONTROL_MESSAGE:
				void handleVoiceControl(this.ctx, client, message);
				break;

			case 'local_models_semantic_index_status':
				void handleLocalModelsSemanticIndexStatus(this.ctx, client, message);
				break;

			case 'local_models_proxy_status':
				void handleLocalModelsProxyStatus(this.ctx, client, message);
				break;

			case 'local_models_proxy_block':
				void handleLocalModelsProxyBlock(this.ctx, client, message);
				break;

			case 'local_models_server_status':
				void handleLocalModelsServerStatus(this.ctx, client, message);
				break;

			case 'local_models_server_start':
				void handleLocalModelsServerStart(this.ctx, client, message);
				break;

			case 'local_models_server_stop':
				void handleLocalModelsServerStop(this.ctx, client, message);
				break;

			case 'local_models_server_set':
				void handleLocalModelsServerSet(this.ctx, client, message);
				break;

			case 'local_models_server_key':
				void handleLocalModelsServerKey(this.ctx, client, message);
				break;

			case 'local_models_server_ensure':
				void handleLocalModelsServerEnsure(this.ctx, client, message);
				break;

			case 'local_models_run_on_test':
				void handleLocalModelsRunOnTest(this.ctx, client, message);
				break;

			case 'local_models_tier_options':
				void handleLocalModelsTierOptions(this.ctx, client, message);
				break;

			case 'system_one_status':
				void handleSystemOneStatus(this.ctx, client, message);
				break;

			case 'system_one_set':
				void handleSystemOneSet(this.ctx, client, message);
				break;

			case 'system_one_key_set':
				void handleSystemOneKeySet(this.ctx, client, message);
				break;

			case 'system_one_key_clear':
				void handleSystemOneKeyClear(this.ctx, client, message);
				break;

			case 'system_one_test':
				void handleSystemOneTest(this.ctx, client, message);
				break;

			case 'system_one_ledger':
				void handleSystemOneLedger(this.ctx, client, message);
				break;

			case 'system_one_agent_request':
				void handleSystemOneAgentRequest(this.ctx, client, message);
				break;

			case 'system_one_usage':
				void handleSystemOneUsage(this.ctx, client, message);
				break;

			case 'system_one_access':
				void handleSystemOneAccess(this.ctx, client, message);
				break;

			case 'model_route_turn':
				void handleModelRouteTurn(this.ctx, client, message);
				break;

			case 'model_route_correct':
				void handleModelRouteCorrect(this.ctx, client, message);
				break;

			case 'local_models_search':
				void handleLocalModelsSearch(this.ctx, client, message);
				break;

			case 'local_models_tab_cleanup':
				void handleLocalModelsTabCleanup(this.ctx, client, message);
				break;

			case 'marketplace_get_manifest':
				handleMarketplaceGetManifest(this.ctx, client, message);
				break;

			case 'marketplace_get_document':
				handleMarketplaceGetDocument(this.ctx, client, message);
				break;

			case 'marketplace_get_readme':
				handleMarketplaceGetReadme(this.ctx, client, message);
				break;

			case 'marketplace_import_playbook':
				handleMarketplaceImportPlaybook(this.ctx, client, message);
				break;

			case 'list_desktop_sessions':
				handleListDesktopSessions(this.ctx, client, message);
				break;

			case 'plugins_list_tools':
				handlePluginsListTools(this.ctx, client, message);
				break;

			case 'plugins_send_agent':
				void handlePluginsSendAgent(this.ctx, client, message);
				break;

			case 'plugins_call_tool':
				void handlePluginsCallTool(this.ctx, client, message);
				break;

			case 'get_session_history':
				handleGetSessionHistory(this.ctx, client, message);
				break;

			case ACAPPELLA_SIGNAL_MESSAGE:
				handleACappellaSignal(this.ctx, client, message);
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
		const { handleBridgeInvoke } = await import('../bridgeHandlers');
		await handleBridgeInvoke(
			client,
			message as unknown as Parameters<typeof handleBridgeInvoke>[1],
			(c, payload) => {
				sendBounded(c.socket, JSON.stringify(payload));
			}
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

	/**
	 * Handle unknown message types - echo back for debugging
	 */
	private handleUnknown(client: WebClient, message: WebClientMessage): void {
		logger.debug(`Unknown message type: ${message.type}`, LOG_CONTEXT);
		this.send(client, { type: 'echo', originalType: message.type, data: message });
	}
}
