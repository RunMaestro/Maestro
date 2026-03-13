import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useModalStore } from '../../stores/modalStore';
import type {
	Theme,
	Session,
	GroupChatMessage,
	ModeratorConfig,
	Shortcut,
	KeyboardMasteryStats,
	AutoRunStats,
	MaestroUsageStats,
	RightPanelTab,
	SettingsTab,
	BatchRunConfig,
	AgentError,
	ToolType,
	LeaderboardRegistration,
	ThinkingMode,
} from '../../types';
import type { FileNode } from '../../types/fileTree';
import type { WizardStep } from '../Wizard/WizardContext';
import type { GroomingProgress, MergeResult } from '../../types/contextMerge';
import type { PRDetails } from '../CreatePRModal';
import type { FlatFileItem } from '../FileSearchModal';
import type { RecoveryAction } from '../AgentErrorModal';
import type { MergeOptions } from '../MergeSessionModal';
import type { SendToAgentOptions } from '../SendToAgentModal';

// Group components
import { AppInfoModals } from './AppInfoModals';
import { AppConfirmModals } from './AppConfirmModals';
import { AppSessionModals } from './AppSessionModals';
import { AppGroupModals } from './AppGroupModals';
import { AppWorktreeModals } from './AppWorktreeModals';
import { AppUtilityModals } from './AppUtilityModals';
import { AppGroupChatModals } from './AppGroupChatModals';
import { AppAgentModals } from './AppAgentModals';
import type { GroupChatErrorInfo } from './AppAgentModals';

/**
 * Combined props interface for the unified AppModals component.
 * This consolidates all modal group props into a single interface for simpler
 * usage in App.tsx.
 */
export interface AppModalsProps {
	// Common props (sessions/groups/groupChats/modal booleans self-sourced from stores — Tier 1B)
	theme: Theme;
	shortcuts: Record<string, Shortcut>;
	tabShortcuts: Record<string, Shortcut>;

	// --- AppInfoModals props ---
	onCloseShortcutsHelp: () => void;
	hasNoAgents: boolean;
	keyboardMasteryStats: KeyboardMasteryStats;
	onCloseAboutModal: () => void;
	autoRunStats: AutoRunStats;
	usageStats?: MaestroUsageStats | null;
	/** Global hands-on time in milliseconds (from settings) */
	handsOnTimeMs: number;
	onOpenLeaderboardRegistration: () => void;
	isLeaderboardRegistered: boolean;
	// leaderboardRegistration is provided via AppAgentModals props below
	onCloseUpdateCheckModal: () => void;
	onCloseProcessMonitor: () => void;
	onNavigateToSession: (sessionId: string, tabId?: string) => void;
	onNavigateToGroupChat: (groupChatId: string) => void;
	onCloseUsageDashboard: () => void;
	/** Default time range for the Usage Dashboard from settings */
	defaultStatsTimeRange?: 'day' | 'week' | 'month' | 'year' | 'all';
	/** Enable colorblind-friendly colors for dashboard charts */
	colorBlindMode?: boolean;

	// --- AppConfirmModals props ---
	confirmModalMessage: string;
	confirmModalOnConfirm: (() => void) | null;
	confirmModalTitle?: string;
	confirmModalDestructive?: boolean;
	onCloseConfirmModal: () => void;
	onConfirmQuit: () => void;
	onCancelQuit: () => void;
	/** Session IDs with active auto-runs (batch processing) */
	activeBatchSessionIds?: string[];

	// --- AppSessionModals props ---
	onCloseNewInstanceModal: () => void;
	onCreateSession: (
		agentId: string,
		workingDir: string,
		name: string,
		nudgeMessage?: string,
		customPath?: string,
		customArgs?: string,
		customEnvVars?: Record<string, string>,
		customModel?: string,
		customContextWindow?: number,
		customProviderPath?: string,
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
		}
	) => void;
	existingSessions: Session[];
	duplicatingSessionId?: string | null; // Session ID to duplicate from
	onCloseEditAgentModal: () => void;
	onSaveEditAgent: (
		sessionId: string,
		name: string,
		toolType?: ToolType,
		nudgeMessage?: string,
		customPath?: string,
		customArgs?: string,
		customEnvVars?: Record<string, string>,
		customModel?: string,
		customContextWindow?: number,
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
		}
	) => void;
	editAgentSession: Session | null;
	renameSessionValue: string;
	setRenameSessionValue: (value: string) => void;
	onCloseRenameSessionModal: () => void;
	renameSessionTargetId: string | null;
	onAfterRename?: () => void;
	renameTabId: string | null;
	renameTabInitialName: string;
	onCloseRenameTabModal: () => void;
	onRenameTab: (newName: string) => void;

	// --- AppGroupModals props ---
	createGroupModalOpen: boolean;
	onCloseCreateGroupModal: () => void;
	onGroupCreated?: (groupId: string) => void;
	renameGroupId: string | null;
	renameGroupValue: string;
	setRenameGroupValue: (value: string) => void;
	renameGroupEmoji: string;
	setRenameGroupEmoji: (emoji: string) => void;
	onCloseRenameGroupModal: () => void;

	// --- AppWorktreeModals props ---
	onCloseWorktreeConfigModal: () => void;
	onSaveWorktreeConfig: (config: { basePath: string; watchEnabled: boolean }) => void;
	onCreateWorktreeFromConfig: (branchName: string, basePath: string) => void;
	onDisableWorktreeConfig: () => void;
	createWorktreeSession: Session | null;
	onCloseCreateWorktreeModal: () => void;
	onCreateWorktree: (branchName: string) => Promise<void>;
	createPRSession: Session | null;
	onCloseCreatePRModal: () => void;
	onPRCreated: (prDetails: PRDetails) => void;
	deleteWorktreeSession: Session | null;
	onCloseDeleteWorktreeModal: () => void;
	onConfirmDeleteWorktree: () => void;
	onConfirmAndDeleteWorktreeOnDisk: () => Promise<void>;

	// --- AppUtilityModals props ---
	quickActionInitialMode: 'main' | 'move-to-group' | 'agents';
	setQuickActionOpen: (open: boolean) => void;
	setActiveSessionId: (id: string) => void;
	addNewSession: () => void;
	setRenameInstanceValue: (value: string) => void;
	setRenameInstanceModalOpen: (open: boolean) => void;
	setRenameGroupId: (id: string) => void;
	setRenameGroupValueForQuickActions: (value: string) => void;
	setRenameGroupEmojiForQuickActions: (emoji: string) => void;
	setRenameGroupModalOpenForQuickActions: (open: boolean) => void;
	setCreateGroupModalOpenForQuickActions: (open: boolean) => void;
	setLeftSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	toggleInputMode: () => void;
	deleteSession: (id: string) => void;
	setSettingsModalOpen: (open: boolean) => void;
	setSettingsTab: (tab: SettingsTab) => void;
	setShortcutsHelpOpen: (open: boolean) => void;
	setAboutModalOpen: (open: boolean) => void;
	setLogViewerOpen: (open: boolean) => void;
	setProcessMonitorOpen: (open: boolean) => void;
	setUsageDashboardOpen?: (open: boolean) => void;
	setActiveRightTab: (tab: RightPanelTab) => void;
	setAgentSessionsOpen: (open: boolean) => void;
	setActiveAgentSessionId: (id: string | null) => void;
	setGitDiffPreview: (diff: string | null) => void;
	setGitLogOpen: (open: boolean) => void;
	isAiMode: boolean;
	onQuickActionsRenameTab: () => void;
	onQuickActionsToggleReadOnlyMode: () => void;
	onQuickActionsToggleTabShowThinking: () => void;
	onQuickActionsOpenTabSwitcher: () => void;
	// Bulk tab close operations (for QuickActionsModal)
	onCloseAllTabs?: () => void;
	onCloseOtherTabs?: () => void;
	onCloseTabsLeft?: () => void;
	onCloseTabsRight?: () => void;
	setPlaygroundOpen?: (open: boolean) => void;
	onQuickActionsRefreshGitFileState: () => Promise<void>;
	onQuickActionsDebugReleaseQueuedItem: () => void;
	markdownEditMode: boolean;
	onQuickActionsToggleMarkdownEditMode: () => void;
	setUpdateCheckModalOpenForQuickActions?: (open: boolean) => void;
	openWizard: () => void;
	wizardGoToStep: (step: WizardStep) => void;
	setDebugWizardModalOpen?: (open: boolean) => void;
	setDebugPackageModalOpen?: (open: boolean) => void;
	startTour: () => void;
	setFuzzyFileSearchOpen: (open: boolean) => void;
	onEditAgent: (session: Session) => void;
	onNewGroupChat: () => void;
	onOpenGroupChat: (id: string) => void;
	onCloseGroupChat: () => void;
	onDeleteGroupChat: (id: string) => void;
	hasActiveSessionCapability: (
		capability:
			| 'supportsSessionStorage'
			| 'supportsSlashCommands'
			| 'supportsContextMerge'
			| 'supportsThinkingDisplay'
	) => boolean;
	onOpenMergeSession: () => void;
	onOpenSendToAgent: () => void;
	onQuickCreateWorktree: (session: Session) => void;
	onOpenCreatePR: (session: Session) => void;
	onSummarizeAndContinue: () => void;
	canSummarizeActiveTab: boolean;
	onToggleRemoteControl: () => Promise<void>;
	autoRunSelectedDocument: string | null;
	autoRunCompletedTaskCount: number;
	onAutoRunResetTasks: () => void;
	// Gist publishing
	isFilePreviewOpen: boolean;
	ghCliAvailable: boolean;
	onPublishGist?: () => void;
	// Document Graph - quick re-open last graph
	lastGraphFocusFile?: string;
	onOpenLastDocumentGraph?: () => void;
	lightboxImage: string | null;
	lightboxImages: string[];
	stagedImages: string[];
	onCloseLightbox: () => void;
	onNavigateLightbox: (img: string) => void;
	onDeleteLightboxImage?: (img: string) => void;
	gitDiffPreview: string | null;
	gitViewerCwd: string;
	onCloseGitDiff: () => void;
	onCloseGitLog: () => void;
	onCloseAutoRunSetup: () => void;
	onAutoRunFolderSelected: (folderPath: string) => void;
	onCloseBatchRunner: () => void;
	onStartBatchRun: (config: BatchRunConfig) => void | Promise<void>;
	onSaveBatchPrompt: (prompt: string) => void;
	showConfirmation: (message: string, onConfirm: () => void) => void;
	autoRunDocumentList: string[];
	autoRunDocumentTree?: Array<{
		name: string;
		type: 'file' | 'folder';
		path: string;
		children?: unknown[];
	}>;
	getDocumentTaskCount: (filename: string) => Promise<number>;
	onAutoRunRefresh: () => Promise<void>;
	onOpenMarketplace?: () => void;
	// Symphony
	onOpenSymphony?: () => void;
	// Director's Notes
	onOpenDirectorNotes?: () => void;
	// Maestro Cue
	onOpenMaestroCue?: () => void;
	onConfigureCue?: (session: Session) => void;
	// Auto-scroll
	autoScrollAiMode?: boolean;
	setAutoScrollAiMode?: (value: boolean) => void;
	onCloseTabSwitcher: () => void;
	onTabSelect: (tabId: string) => void;
	onFileTabSelect?: (tabId: string) => void;
	onTerminalTabSelect?: (tabId: string) => void;
	onNamedSessionSelect: (
		agentSessionId: string,
		projectPath: string,
		sessionName: string,
		starred?: boolean
	) => void;
	filteredFileTree: FileNode[];
	fileExplorerExpanded?: string[];
	onCloseFileSearch: () => void;
	onFileSearchSelect: (file: FlatFileItem) => void;
	onClosePromptComposer: () => void;
	promptComposerInitialValue: string;
	onPromptComposerSubmit: (value: string) => void;
	onPromptComposerSend: (value: string) => void;
	promptComposerSessionName?: string;
	promptComposerStagedImages: string[];
	setPromptComposerStagedImages?: React.Dispatch<React.SetStateAction<string[]>>;
	onPromptImageAttachBlocked?: () => void;
	onPromptOpenLightbox: (
		image: string,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	promptTabSaveToHistory: boolean;
	onPromptToggleTabSaveToHistory?: () => void;
	promptTabReadOnlyMode: boolean;
	onPromptToggleTabReadOnlyMode: () => void;
	promptTabShowThinking: ThinkingMode;
	onPromptToggleTabShowThinking?: () => void;
	promptSupportsThinking: boolean;
	promptEnterToSend: boolean;
	onPromptToggleEnterToSend: () => void;
	onCloseQueueBrowser: () => void;
	onRemoveQueueItem: (sessionId: string, itemId: string) => void;
	onSwitchQueueSession: (sessionId: string) => void;
	onReorderQueueItems: (sessionId: string, fromIndex: number, toIndex: number) => void;

	// --- AppGroupChatModals props ---
	onCloseNewGroupChatModal: () => void;
	onCreateGroupChat: (
		name: string,
		moderatorAgentId: string,
		moderatorConfig?: ModeratorConfig
	) => void;
	showDeleteGroupChatModal: string | null;
	onCloseDeleteGroupChatModal: () => void;
	onConfirmDeleteGroupChat: () => void;
	showRenameGroupChatModal: string | null;
	onCloseRenameGroupChatModal: () => void;
	onRenameGroupChatFromModal: (newName: string) => void;
	showEditGroupChatModal: string | null;
	onCloseEditGroupChatModal: () => void;
	onUpdateGroupChat: (
		id: string,
		name: string,
		moderatorAgentId: string,
		moderatorConfig?: ModeratorConfig
	) => void;
	groupChatMessages: GroupChatMessage[];
	onCloseGroupChatInfo: () => void;
	onOpenModeratorSession: (moderatorSessionId: string) => void;

	// --- AppAgentModals props ---
	onCloseLeaderboardRegistration: () => void;
	leaderboardRegistration: LeaderboardRegistration | null;
	onSaveLeaderboardRegistration: (registration: LeaderboardRegistration) => void;
	onLeaderboardOptOut: () => void;
	onSyncAutoRunStats?: (stats: {
		cumulativeTimeMs: number;
		totalRuns: number;
		currentBadgeLevel: number;
		longestRunMs: number;
		longestRunTimestamp: number;
	}) => void;
	errorSession: Session | null | undefined;
	/** The effective error to display — live or historical from chat log */
	effectiveAgentError: AgentError | null;
	recoveryActions: RecoveryAction[];
	onDismissAgentError: () => void;
	groupChatError: GroupChatErrorInfo | null;
	groupChatRecoveryActions: RecoveryAction[];
	onClearGroupChatError: () => void;
	onCloseMergeSession: () => void;
	onMerge: (
		targetSessionId: string,
		targetTabId: string | undefined,
		options: MergeOptions
	) => Promise<MergeResult>;
	transferState: 'idle' | 'grooming' | 'creating' | 'complete' | 'error';
	transferProgress: GroomingProgress | null;
	transferSourceAgent: ToolType | null;
	transferTargetAgent: ToolType | null;
	onCancelTransfer: () => void;
	onCompleteTransfer: () => void;
	onCloseSendToAgent: () => void;
	onSendToAgent: (targetSessionId: string, options: SendToAgentOptions) => Promise<MergeResult>;
}

/**
 * AppModals - Unified component that renders all modal groups
 *
 * This is the single entry point for all modals in App.tsx, consolidating:
 * - AppInfoModals: Info/display modals
 * - AppConfirmModals: Confirmation modals
 * - AppSessionModals: Session management modals
 * - AppGroupModals: Group management modals
 * - AppWorktreeModals: Worktree/PR modals
 * - AppUtilityModals: Utility and workflow modals
 * - AppGroupChatModals: Group Chat modals
 * - AppAgentModals: Agent error and transfer modals
 */
export const AppModals = memo(function AppModals(props: AppModalsProps) {
	// Self-source data from stores (Tier 1B)
	const sessions = useSessionStore((s) => s.sessions);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const groups = useSessionStore((s) => s.groups);
	const setSessions = useSessionStore((s) => s.setSessions);
	const setGroups = useSessionStore((s) => s.setGroups);
	const activeSession = useMemo(
		() => sessions.find((s) => s.id === activeSessionId) ?? null,
		[sessions, activeSessionId]
	);
	const groupChats = useGroupChatStore((s) => s.groupChats);
	const activeGroupChatId = useGroupChatStore((s) => s.activeGroupChatId);

	// Self-source modal boolean states from modalStore (Tier 1B)
	const {
		shortcutsHelpOpen,
		aboutModalOpen,
		updateCheckModalOpen,
		processMonitorOpen,
		usageDashboardOpen,
		confirmModalOpen,
		quitConfirmModalOpen,
		newInstanceModalOpen,
		editAgentModalOpen,
		renameSessionModalOpen,
		renameTabModalOpen,
		renameGroupModalOpen,
		worktreeConfigModalOpen,
		createWorktreeModalOpen,
		createPRModalOpen,
		deleteWorktreeModalOpen,
		quickActionOpen,
		tabSwitcherOpen,
		fuzzyFileSearchOpen,
		promptComposerOpen,
		queueBrowserOpen,
		autoRunSetupModalOpen,
		batchRunnerModalOpen,
		gitLogOpen,
		showNewGroupChatModal,
		showGroupChatInfo,
		leaderboardRegistrationOpen,
		mergeSessionModalOpen,
		sendToAgentModalOpen,
	} = useModalStore(
		useShallow((s) => ({
			shortcutsHelpOpen: s.modals.get('shortcutsHelp')?.open ?? false,
			aboutModalOpen: s.modals.get('about')?.open ?? false,
			updateCheckModalOpen: s.modals.get('updateCheck')?.open ?? false,
			processMonitorOpen: s.modals.get('processMonitor')?.open ?? false,
			usageDashboardOpen: s.modals.get('usageDashboard')?.open ?? false,
			confirmModalOpen: s.modals.get('confirm')?.open ?? false,
			quitConfirmModalOpen: s.modals.get('quitConfirm')?.open ?? false,
			newInstanceModalOpen: s.modals.get('newInstance')?.open ?? false,
			editAgentModalOpen: s.modals.get('editAgent')?.open ?? false,
			renameSessionModalOpen: s.modals.get('renameInstance')?.open ?? false,
			renameTabModalOpen: s.modals.get('renameTab')?.open ?? false,
			renameGroupModalOpen: s.modals.get('renameGroup')?.open ?? false,
			worktreeConfigModalOpen: s.modals.get('worktreeConfig')?.open ?? false,
			createWorktreeModalOpen: s.modals.get('createWorktree')?.open ?? false,
			createPRModalOpen: s.modals.get('createPR')?.open ?? false,
			deleteWorktreeModalOpen: s.modals.get('deleteWorktree')?.open ?? false,
			quickActionOpen: s.modals.get('quickAction')?.open ?? false,
			tabSwitcherOpen: s.modals.get('tabSwitcher')?.open ?? false,
			fuzzyFileSearchOpen: s.modals.get('fuzzyFileSearch')?.open ?? false,
			promptComposerOpen: s.modals.get('promptComposer')?.open ?? false,
			queueBrowserOpen: s.modals.get('queueBrowser')?.open ?? false,
			autoRunSetupModalOpen: s.modals.get('autoRunSetup')?.open ?? false,
			batchRunnerModalOpen: s.modals.get('batchRunner')?.open ?? false,
			gitLogOpen: s.modals.get('gitLog')?.open ?? false,
			showNewGroupChatModal: s.modals.get('newGroupChat')?.open ?? false,
			showGroupChatInfo: s.modals.get('groupChatInfo')?.open ?? false,
			leaderboardRegistrationOpen: s.modals.get('leaderboard')?.open ?? false,
			mergeSessionModalOpen: s.modals.get('mergeSession')?.open ?? false,
			sendToAgentModalOpen: s.modals.get('sendToAgent')?.open ?? false,
		}))
	);

	const {
		// Common props
		theme,
		shortcuts,
		tabShortcuts,
		// Info modals
		onCloseShortcutsHelp,
		hasNoAgents,
		keyboardMasteryStats,
		onCloseAboutModal,
		autoRunStats,
		usageStats,
		handsOnTimeMs,
		onOpenLeaderboardRegistration,
		isLeaderboardRegistered,
		// leaderboardRegistration is destructured below in Agent modals section
		onCloseUpdateCheckModal,
		onCloseProcessMonitor,
		onNavigateToSession,
		onNavigateToGroupChat,
		onCloseUsageDashboard,
		defaultStatsTimeRange,
		colorBlindMode,
		// Confirm modals
		confirmModalMessage,
		confirmModalOnConfirm,
		confirmModalTitle,
		confirmModalDestructive,
		onCloseConfirmModal,
		onConfirmQuit,
		onCancelQuit,
		activeBatchSessionIds,
		// Session modals
		onCloseNewInstanceModal,
		onCreateSession,
		existingSessions,
		duplicatingSessionId,
		onCloseEditAgentModal,
		onSaveEditAgent,
		editAgentSession,
		renameSessionValue,
		setRenameSessionValue,
		onCloseRenameSessionModal,
		renameSessionTargetId,
		onAfterRename,
		renameTabId,
		renameTabInitialName,
		onCloseRenameTabModal,
		onRenameTab,
		// Group modals
		createGroupModalOpen,
		onCloseCreateGroupModal,
		onGroupCreated,
		renameGroupId,
		renameGroupValue,
		setRenameGroupValue,
		renameGroupEmoji,
		setRenameGroupEmoji,
		onCloseRenameGroupModal,
		// Worktree modals
		onCloseWorktreeConfigModal,
		onSaveWorktreeConfig,
		onCreateWorktreeFromConfig,
		onDisableWorktreeConfig,
		createWorktreeSession,
		onCloseCreateWorktreeModal,
		onCreateWorktree,
		createPRSession,
		onCloseCreatePRModal,
		onPRCreated,
		deleteWorktreeSession,
		onCloseDeleteWorktreeModal,
		onConfirmDeleteWorktree,
		onConfirmAndDeleteWorktreeOnDisk,
		// Utility modals
		quickActionInitialMode,
		setQuickActionOpen,
		setActiveSessionId,
		addNewSession,
		setRenameInstanceValue,
		setRenameInstanceModalOpen,
		setRenameGroupId,
		setRenameGroupValueForQuickActions,
		setRenameGroupEmojiForQuickActions,
		setRenameGroupModalOpenForQuickActions,
		setCreateGroupModalOpenForQuickActions,
		setLeftSidebarOpen,
		setRightPanelOpen,
		toggleInputMode,
		deleteSession,
		setSettingsModalOpen,
		setSettingsTab,
		setShortcutsHelpOpen,
		setAboutModalOpen,
		setLogViewerOpen,
		setProcessMonitorOpen,
		setUsageDashboardOpen,
		setActiveRightTab,
		setAgentSessionsOpen,
		setActiveAgentSessionId,
		setGitDiffPreview,
		setGitLogOpen,
		isAiMode,
		onQuickActionsRenameTab,
		onQuickActionsToggleReadOnlyMode,
		onQuickActionsToggleTabShowThinking,
		onQuickActionsOpenTabSwitcher,
		// Bulk tab close operations
		onCloseAllTabs,
		onCloseOtherTabs,
		onCloseTabsLeft,
		onCloseTabsRight,
		setPlaygroundOpen,
		onQuickActionsRefreshGitFileState,
		onQuickActionsDebugReleaseQueuedItem,
		markdownEditMode,
		onQuickActionsToggleMarkdownEditMode,
		setUpdateCheckModalOpenForQuickActions,
		openWizard,
		wizardGoToStep,
		setDebugWizardModalOpen,
		setDebugPackageModalOpen,
		startTour,
		setFuzzyFileSearchOpen,
		onEditAgent,
		onNewGroupChat,
		onOpenGroupChat,
		onCloseGroupChat,
		onDeleteGroupChat,
		hasActiveSessionCapability,
		onOpenMergeSession,
		onOpenSendToAgent,
		onQuickCreateWorktree,
		onOpenCreatePR,
		onSummarizeAndContinue,
		canSummarizeActiveTab,
		onToggleRemoteControl,
		autoRunSelectedDocument,
		autoRunCompletedTaskCount,
		onAutoRunResetTasks,
		// Gist publishing
		isFilePreviewOpen,
		ghCliAvailable,
		onPublishGist,
		// Document Graph - quick re-open last graph
		lastGraphFocusFile,
		onOpenLastDocumentGraph,
		lightboxImage,
		lightboxImages,
		stagedImages,
		onCloseLightbox,
		onNavigateLightbox,
		onDeleteLightboxImage,
		gitDiffPreview,
		gitViewerCwd,
		onCloseGitDiff,
		onCloseGitLog,
		onCloseAutoRunSetup,
		onAutoRunFolderSelected,
		onCloseBatchRunner,
		onStartBatchRun,
		onSaveBatchPrompt,
		showConfirmation,
		autoRunDocumentList,
		autoRunDocumentTree,
		getDocumentTaskCount,
		onAutoRunRefresh,
		onOpenMarketplace,
		// Symphony
		onOpenSymphony,
		// Director's Notes
		onOpenDirectorNotes,
		// Maestro Cue
		onOpenMaestroCue,
		onConfigureCue,
		// Auto-scroll
		autoScrollAiMode,
		setAutoScrollAiMode,
		onCloseTabSwitcher,
		onTabSelect,
		onFileTabSelect,
		onTerminalTabSelect,
		onNamedSessionSelect,
		filteredFileTree,
		fileExplorerExpanded,
		onCloseFileSearch,
		onFileSearchSelect,
		onClosePromptComposer,
		promptComposerInitialValue,
		onPromptComposerSubmit,
		onPromptComposerSend,
		promptComposerSessionName,
		promptComposerStagedImages,
		setPromptComposerStagedImages,
		onPromptImageAttachBlocked,
		onPromptOpenLightbox,
		promptTabSaveToHistory,
		onPromptToggleTabSaveToHistory,
		promptTabReadOnlyMode,
		onPromptToggleTabReadOnlyMode,
		promptTabShowThinking,
		onPromptToggleTabShowThinking,
		promptSupportsThinking,
		promptEnterToSend,
		onPromptToggleEnterToSend,
		onCloseQueueBrowser,
		onRemoveQueueItem,
		onSwitchQueueSession,
		onReorderQueueItems,
		// Group Chat modals
		onCloseNewGroupChatModal,
		onCreateGroupChat,
		showDeleteGroupChatModal,
		onCloseDeleteGroupChatModal,
		onConfirmDeleteGroupChat,
		showRenameGroupChatModal,
		onCloseRenameGroupChatModal,
		onRenameGroupChatFromModal,
		showEditGroupChatModal,
		onCloseEditGroupChatModal,
		onUpdateGroupChat,
		groupChatMessages,
		onCloseGroupChatInfo,
		onOpenModeratorSession,
		// Agent modals
		onCloseLeaderboardRegistration,
		leaderboardRegistration,
		onSaveLeaderboardRegistration,
		onLeaderboardOptOut,
		onSyncAutoRunStats,
		errorSession,
		effectiveAgentError,
		recoveryActions,
		onDismissAgentError,
		groupChatError,
		groupChatRecoveryActions,
		onClearGroupChatError,
		onCloseMergeSession,
		onMerge,
		transferState,
		transferProgress,
		transferSourceAgent,
		transferTargetAgent,
		onCancelTransfer,
		onCompleteTransfer,
		onCloseSendToAgent,
		onSendToAgent,
	} = props;

	const sourceSession = useMemo(
		() => (duplicatingSessionId ? sessions.find((s) => s.id === duplicatingSessionId) : undefined),
		[duplicatingSessionId, sessions]
	);

	return (
		<>
			{/* Info/Display Modals */}
			<AppInfoModals
				theme={theme}
				shortcutsHelpOpen={shortcutsHelpOpen}
				onCloseShortcutsHelp={onCloseShortcutsHelp}
				shortcuts={shortcuts}
				tabShortcuts={tabShortcuts}
				hasNoAgents={hasNoAgents}
				keyboardMasteryStats={keyboardMasteryStats}
				aboutModalOpen={aboutModalOpen}
				onCloseAboutModal={onCloseAboutModal}
				autoRunStats={autoRunStats}
				usageStats={usageStats}
				handsOnTimeMs={handsOnTimeMs}
				onOpenLeaderboardRegistration={onOpenLeaderboardRegistration}
				isLeaderboardRegistered={isLeaderboardRegistered}
				leaderboardRegistration={leaderboardRegistration}
				updateCheckModalOpen={updateCheckModalOpen}
				onCloseUpdateCheckModal={onCloseUpdateCheckModal}
				processMonitorOpen={processMonitorOpen}
				onCloseProcessMonitor={onCloseProcessMonitor}
				sessions={sessions}
				groups={groups}
				groupChats={groupChats}
				onNavigateToSession={onNavigateToSession}
				onNavigateToGroupChat={onNavigateToGroupChat}
				usageDashboardOpen={usageDashboardOpen}
				onCloseUsageDashboard={onCloseUsageDashboard}
				defaultStatsTimeRange={defaultStatsTimeRange}
				colorBlindMode={colorBlindMode}
			/>

			{/* Confirmation Modals */}
			<AppConfirmModals
				theme={theme}
				sessions={sessions}
				confirmModalOpen={confirmModalOpen}
				confirmModalMessage={confirmModalMessage}
				confirmModalOnConfirm={confirmModalOnConfirm}
				confirmModalTitle={confirmModalTitle}
				confirmModalDestructive={confirmModalDestructive}
				onCloseConfirmModal={onCloseConfirmModal}
				quitConfirmModalOpen={quitConfirmModalOpen}
				onConfirmQuit={onConfirmQuit}
				onCancelQuit={onCancelQuit}
				activeBatchSessionIds={activeBatchSessionIds}
			/>

			{/* Session Management Modals */}
			<AppSessionModals
				theme={theme}
				sessions={sessions}
				activeSessionId={activeSessionId}
				activeSession={activeSession}
				newInstanceModalOpen={newInstanceModalOpen}
				onCloseNewInstanceModal={onCloseNewInstanceModal}
				onCreateSession={onCreateSession}
				existingSessions={existingSessions}
				sourceSession={sourceSession}
				editAgentModalOpen={editAgentModalOpen}
				onCloseEditAgentModal={onCloseEditAgentModal}
				onSaveEditAgent={onSaveEditAgent}
				editAgentSession={editAgentSession}
				renameSessionModalOpen={renameSessionModalOpen}
				renameSessionValue={renameSessionValue}
				setRenameSessionValue={setRenameSessionValue}
				onCloseRenameSessionModal={onCloseRenameSessionModal}
				setSessions={setSessions}
				renameSessionTargetId={renameSessionTargetId}
				onAfterRename={onAfterRename}
				renameTabModalOpen={renameTabModalOpen}
				renameTabId={renameTabId}
				renameTabInitialName={renameTabInitialName}
				onCloseRenameTabModal={onCloseRenameTabModal}
				onRenameTab={onRenameTab}
			/>

			{/* Group Management Modals */}
			<AppGroupModals
				theme={theme}
				groups={groups}
				setGroups={setGroups}
				createGroupModalOpen={createGroupModalOpen}
				onCloseCreateGroupModal={onCloseCreateGroupModal}
				onGroupCreated={onGroupCreated}
				renameGroupModalOpen={renameGroupModalOpen}
				renameGroupId={renameGroupId}
				renameGroupValue={renameGroupValue}
				setRenameGroupValue={setRenameGroupValue}
				renameGroupEmoji={renameGroupEmoji}
				setRenameGroupEmoji={setRenameGroupEmoji}
				onCloseRenameGroupModal={onCloseRenameGroupModal}
			/>

			{/* Worktree/PR Modals */}
			<AppWorktreeModals
				theme={theme}
				activeSession={activeSession}
				worktreeConfigModalOpen={worktreeConfigModalOpen}
				onCloseWorktreeConfigModal={onCloseWorktreeConfigModal}
				onSaveWorktreeConfig={onSaveWorktreeConfig}
				onCreateWorktreeFromConfig={onCreateWorktreeFromConfig}
				onDisableWorktreeConfig={onDisableWorktreeConfig}
				createWorktreeModalOpen={createWorktreeModalOpen}
				createWorktreeSession={createWorktreeSession}
				onCloseCreateWorktreeModal={onCloseCreateWorktreeModal}
				onCreateWorktree={onCreateWorktree}
				createPRModalOpen={createPRModalOpen}
				createPRSession={createPRSession}
				onCloseCreatePRModal={onCloseCreatePRModal}
				onPRCreated={onPRCreated}
				deleteWorktreeModalOpen={deleteWorktreeModalOpen}
				deleteWorktreeSession={deleteWorktreeSession}
				onCloseDeleteWorktreeModal={onCloseDeleteWorktreeModal}
				onConfirmDeleteWorktree={onConfirmDeleteWorktree}
				onConfirmAndDeleteWorktreeOnDisk={onConfirmAndDeleteWorktreeOnDisk}
			/>

			{/* Utility/Workflow Modals */}
			<AppUtilityModals
				theme={theme}
				sessions={sessions}
				setSessions={setSessions}
				activeSessionId={activeSessionId}
				activeSession={activeSession}
				groups={groups}
				setGroups={setGroups}
				shortcuts={shortcuts}
				tabShortcuts={tabShortcuts}
				quickActionOpen={quickActionOpen}
				quickActionInitialMode={quickActionInitialMode}
				setQuickActionOpen={setQuickActionOpen}
				setActiveSessionId={setActiveSessionId}
				addNewSession={addNewSession}
				setRenameInstanceValue={setRenameInstanceValue}
				setRenameInstanceModalOpen={setRenameInstanceModalOpen}
				setRenameGroupId={setRenameGroupId}
				setRenameGroupValue={setRenameGroupValueForQuickActions}
				setRenameGroupEmoji={setRenameGroupEmojiForQuickActions}
				setRenameGroupModalOpen={setRenameGroupModalOpenForQuickActions}
				setCreateGroupModalOpen={setCreateGroupModalOpenForQuickActions}
				setLeftSidebarOpen={setLeftSidebarOpen}
				setRightPanelOpen={setRightPanelOpen}
				toggleInputMode={toggleInputMode}
				deleteSession={deleteSession}
				setSettingsModalOpen={setSettingsModalOpen}
				setSettingsTab={setSettingsTab}
				setShortcutsHelpOpen={setShortcutsHelpOpen}
				setAboutModalOpen={setAboutModalOpen}
				setLogViewerOpen={setLogViewerOpen}
				setProcessMonitorOpen={setProcessMonitorOpen}
				setUsageDashboardOpen={setUsageDashboardOpen}
				setActiveRightTab={setActiveRightTab}
				setAgentSessionsOpen={setAgentSessionsOpen}
				setActiveAgentSessionId={setActiveAgentSessionId}
				setGitDiffPreview={setGitDiffPreview}
				setGitLogOpen={setGitLogOpen}
				isAiMode={isAiMode}
				onRenameTab={onQuickActionsRenameTab}
				onToggleReadOnlyMode={onQuickActionsToggleReadOnlyMode}
				onToggleTabShowThinking={onQuickActionsToggleTabShowThinking}
				onOpenTabSwitcher={onQuickActionsOpenTabSwitcher}
				onCloseAllTabs={onCloseAllTabs}
				onCloseOtherTabs={onCloseOtherTabs}
				onCloseTabsLeft={onCloseTabsLeft}
				onCloseTabsRight={onCloseTabsRight}
				setPlaygroundOpen={setPlaygroundOpen}
				onRefreshGitFileState={onQuickActionsRefreshGitFileState}
				onDebugReleaseQueuedItem={onQuickActionsDebugReleaseQueuedItem}
				markdownEditMode={markdownEditMode}
				onToggleMarkdownEditMode={onQuickActionsToggleMarkdownEditMode}
				setUpdateCheckModalOpen={setUpdateCheckModalOpenForQuickActions}
				openWizard={openWizard}
				wizardGoToStep={wizardGoToStep}
				setDebugWizardModalOpen={setDebugWizardModalOpen}
				setDebugPackageModalOpen={setDebugPackageModalOpen}
				startTour={startTour}
				setFuzzyFileSearchOpen={setFuzzyFileSearchOpen}
				onEditAgent={onEditAgent}
				groupChats={groupChats}
				onNewGroupChat={onNewGroupChat}
				onOpenGroupChat={onOpenGroupChat}
				onCloseGroupChat={onCloseGroupChat}
				onDeleteGroupChat={onDeleteGroupChat}
				activeGroupChatId={activeGroupChatId}
				hasActiveSessionCapability={hasActiveSessionCapability}
				onOpenMergeSession={onOpenMergeSession}
				onOpenSendToAgent={onOpenSendToAgent}
				onQuickCreateWorktree={onQuickCreateWorktree}
				onOpenCreatePR={onOpenCreatePR}
				onSummarizeAndContinue={onSummarizeAndContinue}
				canSummarizeActiveTab={canSummarizeActiveTab}
				onToggleRemoteControl={onToggleRemoteControl}
				autoRunSelectedDocument={autoRunSelectedDocument}
				autoRunCompletedTaskCount={autoRunCompletedTaskCount}
				onAutoRunResetTasks={onAutoRunResetTasks}
				isFilePreviewOpen={isFilePreviewOpen}
				ghCliAvailable={ghCliAvailable}
				onPublishGist={onPublishGist}
				lastGraphFocusFile={lastGraphFocusFile}
				onOpenLastDocumentGraph={onOpenLastDocumentGraph}
				onOpenSymphony={onOpenSymphony}
				onOpenDirectorNotes={onOpenDirectorNotes}
				onOpenMaestroCue={onOpenMaestroCue}
				onConfigureCue={onConfigureCue}
				autoScrollAiMode={autoScrollAiMode}
				setAutoScrollAiMode={setAutoScrollAiMode}
				lightboxImage={lightboxImage}
				lightboxImages={lightboxImages}
				stagedImages={stagedImages}
				onCloseLightbox={onCloseLightbox}
				onNavigateLightbox={onNavigateLightbox}
				onDeleteLightboxImage={onDeleteLightboxImage}
				gitDiffPreview={gitDiffPreview}
				gitViewerCwd={gitViewerCwd}
				onCloseGitDiff={onCloseGitDiff}
				gitLogOpen={gitLogOpen}
				onCloseGitLog={onCloseGitLog}
				autoRunSetupModalOpen={autoRunSetupModalOpen}
				onCloseAutoRunSetup={onCloseAutoRunSetup}
				onAutoRunFolderSelected={onAutoRunFolderSelected}
				batchRunnerModalOpen={batchRunnerModalOpen}
				onCloseBatchRunner={onCloseBatchRunner}
				onStartBatchRun={onStartBatchRun}
				onSaveBatchPrompt={onSaveBatchPrompt}
				showConfirmation={showConfirmation}
				autoRunDocumentList={autoRunDocumentList}
				autoRunDocumentTree={autoRunDocumentTree}
				getDocumentTaskCount={getDocumentTaskCount}
				onAutoRunRefresh={onAutoRunRefresh}
				onOpenMarketplace={onOpenMarketplace}
				tabSwitcherOpen={tabSwitcherOpen}
				onCloseTabSwitcher={onCloseTabSwitcher}
				onTabSelect={onTabSelect}
				onFileTabSelect={onFileTabSelect}
				onTerminalTabSelect={onTerminalTabSelect}
				onNamedSessionSelect={onNamedSessionSelect}
				colorBlindMode={colorBlindMode}
				fuzzyFileSearchOpen={fuzzyFileSearchOpen}
				filteredFileTree={filteredFileTree}
				fileExplorerExpanded={fileExplorerExpanded}
				onCloseFileSearch={onCloseFileSearch}
				onFileSearchSelect={onFileSearchSelect}
				promptComposerOpen={promptComposerOpen}
				onClosePromptComposer={onClosePromptComposer}
				promptComposerInitialValue={promptComposerInitialValue}
				onPromptComposerSubmit={onPromptComposerSubmit}
				onPromptComposerSend={onPromptComposerSend}
				promptComposerSessionName={promptComposerSessionName}
				promptComposerStagedImages={promptComposerStagedImages}
				setPromptComposerStagedImages={setPromptComposerStagedImages}
				onPromptImageAttachBlocked={onPromptImageAttachBlocked}
				onPromptOpenLightbox={onPromptOpenLightbox}
				promptTabSaveToHistory={promptTabSaveToHistory}
				onPromptToggleTabSaveToHistory={onPromptToggleTabSaveToHistory}
				promptTabReadOnlyMode={promptTabReadOnlyMode}
				onPromptToggleTabReadOnlyMode={onPromptToggleTabReadOnlyMode}
				promptTabShowThinking={promptTabShowThinking}
				onPromptToggleTabShowThinking={onPromptToggleTabShowThinking}
				promptSupportsThinking={promptSupportsThinking}
				promptEnterToSend={promptEnterToSend}
				onPromptToggleEnterToSend={onPromptToggleEnterToSend}
				queueBrowserOpen={queueBrowserOpen}
				onCloseQueueBrowser={onCloseQueueBrowser}
				onRemoveQueueItem={onRemoveQueueItem}
				onSwitchQueueSession={onSwitchQueueSession}
				onReorderQueueItems={onReorderQueueItems}
			/>

			{/* Group Chat Modals */}
			<AppGroupChatModals
				theme={theme}
				groupChats={groupChats}
				showNewGroupChatModal={showNewGroupChatModal}
				onCloseNewGroupChatModal={onCloseNewGroupChatModal}
				onCreateGroupChat={onCreateGroupChat}
				showDeleteGroupChatModal={showDeleteGroupChatModal}
				onCloseDeleteGroupChatModal={onCloseDeleteGroupChatModal}
				onConfirmDeleteGroupChat={onConfirmDeleteGroupChat}
				showRenameGroupChatModal={showRenameGroupChatModal}
				onCloseRenameGroupChatModal={onCloseRenameGroupChatModal}
				onRenameGroupChat={onRenameGroupChatFromModal}
				showEditGroupChatModal={showEditGroupChatModal}
				onCloseEditGroupChatModal={onCloseEditGroupChatModal}
				onUpdateGroupChat={onUpdateGroupChat}
				showGroupChatInfo={showGroupChatInfo}
				activeGroupChatId={activeGroupChatId}
				groupChatMessages={groupChatMessages}
				onCloseGroupChatInfo={onCloseGroupChatInfo}
				onOpenModeratorSession={onOpenModeratorSession}
			/>

			{/* Agent/Transfer Modals */}
			<AppAgentModals
				theme={theme}
				sessions={sessions}
				activeSession={activeSession}
				groupChats={groupChats}
				leaderboardRegistrationOpen={leaderboardRegistrationOpen}
				onCloseLeaderboardRegistration={onCloseLeaderboardRegistration}
				autoRunStats={autoRunStats}
				keyboardMasteryStats={keyboardMasteryStats}
				leaderboardRegistration={leaderboardRegistration}
				onSaveLeaderboardRegistration={onSaveLeaderboardRegistration}
				onLeaderboardOptOut={onLeaderboardOptOut}
				onSyncAutoRunStats={onSyncAutoRunStats}
				errorSession={errorSession}
				effectiveAgentError={effectiveAgentError}
				recoveryActions={recoveryActions}
				onDismissAgentError={onDismissAgentError}
				groupChatError={groupChatError}
				groupChatRecoveryActions={groupChatRecoveryActions}
				onClearGroupChatError={onClearGroupChatError}
				mergeSessionModalOpen={mergeSessionModalOpen}
				onCloseMergeSession={onCloseMergeSession}
				onMerge={onMerge}
				transferState={transferState}
				transferProgress={transferProgress}
				transferSourceAgent={transferSourceAgent}
				transferTargetAgent={transferTargetAgent}
				onCancelTransfer={onCancelTransfer}
				onCompleteTransfer={onCompleteTransfer}
				sendToAgentModalOpen={sendToAgentModalOpen}
				onCloseSendToAgent={onCloseSendToAgent}
				onSendToAgent={onSendToAgent}
			/>
		</>
	);
});
