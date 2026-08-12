/**
 * Shared types for WebSocket message handlers.
 *
 * Extracted from messageHandlers.ts.
 */

import { WebSocket } from 'ws';
import type {
	AutoRunDocument,
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
	NotifyToastParams,
	NotifyCenterFlashParams,
	MarketplaceManifestResult,
	MarketplaceImportResult,
	DesktopSessionEntry,
	SessionHistoryResult,
	GetSessionHistoryOptions,
	EnqueueCommandResult,
} from '../../types';
import type { CadenzaPayload } from '../../../../shared/cadenza-types';
import type { MovementPayload, MovementStateSnapshot } from '../../../../shared/movement-types';
import type {
	ConcertoDesignerAction,
	ConcertoDesignerActionResult,
	MovementDesignerInspection,
} from '../../../../shared/concerto-html';

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
	enqueueCommand: (
		sessionId: string,
		command: string,
		inputMode?: 'ai' | 'terminal',
		tabId?: string,
		images?: string[],
		background?: boolean
	) => Promise<EnqueueCommandResult>;
	listQueue: (sessionId?: string) => Promise<{
		success: boolean;
		queues: unknown[];
		error?: string;
	}>;
	removeQueueItem: (
		sessionId: string,
		itemId: string
	) => Promise<{ success: boolean; removed: boolean; error?: string }>;
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
			/**
			 * Per-run model/effort override (CLI `--model` / `--effort`). Wins over the
			 * session's configured model for this run's spawns only; never written back
			 * to the session. Absent means "use the agent default".
			 */
			model?: string;
			effort?: string;
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
 * Bundles the callback registry plus the response-sending helpers that every
 * domain handler function needs. Constructed once per incoming message by
 * `WebSocketMessageHandler` and passed to the extracted domain handlers
 * (e.g. `./autoRun`) so they don't need `this` access into the class.
 */
export interface MessageHandlerContext {
	callbacks: Partial<MessageHandlerCallbacks>;
	send: (client: WebClient, data: Record<string, unknown>) => void;
	sendError: (client: WebClient, message: string, extra?: Record<string, unknown>) => void;
	reportHandlerError: (
		client: WebClient,
		error: unknown,
		handler: string,
		extra: Record<string, unknown>,
		userMessagePrefix: string
	) => void;
}
