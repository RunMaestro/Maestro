import type React from 'react';
import type {
	Theme,
	BatchRunState,
	UnifiedTab,
	FilePreviewTab,
	BrowserTab,
	AgentError,
	QueuedItem,
} from '../../types';
import type { CopyContextOptions } from '../../hooks/tabs/useTabExportHandlers';

export interface SlashCommand {
	command: string;
	description: string;
}

/**
 * Handle for MainPanel component to expose methods to parent.
 */
export interface MainPanelHandle {
	/** Refresh git info (branch, ahead/behind, uncommitted changes) */
	refreshGitInfo: () => Promise<void>;
	/** Focus the file preview container (if open) */
	focusFilePreview: () => void;
	/** Clear the active terminal (xterm.js clear) */
	clearActiveTerminal: () => void;
	/** Focus the active terminal xterm.js instance */
	focusActiveTerminal: () => void;
	/** Open the terminal search overlay */
	openTerminalSearch: () => void;
	/** Focus the browser address bar in the active browser tab */
	focusBrowserAddressBar: () => void;
	/** Open the in-page find bar in the active browser tab */
	openBrowserFind: () => void;
	/** Navigate back in the active browser tab's history */
	browserBack: () => void;
	/** Navigate forward in the active browser tab's history */
	browserForward: () => void;
	/** Scroll the active tab header into view and focus it */
	focusActiveTab: () => void;
	/** Reload the active browser tab (or stop loading if in progress) */
	reloadBrowserTab: () => void;
	/** Copy the active terminal tab's buffer (scrollback) to the clipboard */
	copyActiveTerminalBuffer: () => void;
	/** Send the active terminal tab's buffer to another agent */
	sendActiveTerminalBufferToAgent: () => void;
	/** Publish the active terminal tab's buffer as a GitHub Gist */
	publishActiveTerminalBufferGist: () => void;
	/** Copy the active browser tab's rendered page content to the clipboard */
	copyActiveBrowserContent: () => void;
	/** Send the active browser tab's rendered page content to another agent */
	sendActiveBrowserContentToAgent: () => void;
}

export interface MainPanelProps {
	// State
	logViewerOpen: boolean;
	agentSessionsOpen: boolean;
	memoryViewerOpen: boolean;
	activeAgentSessionId: string | null;
	theme: Theme;
	isMobileLandscape?: boolean;
	stagedImages: string[];
	commandHistoryOpen: boolean;
	commandHistoryFilter: string;
	commandHistorySelectedIndex: number;
	slashCommandOpen: boolean;
	slashCommands: SlashCommand[];
	selectedSlashCommandIndex: number;
	// Tab completion props
	tabCompletionOpen?: boolean;
	tabCompletionSuggestions?: import('../../hooks').TabCompletionSuggestion[];
	selectedTabCompletionIndex?: number;
	tabCompletionFilter?: import('../../hooks').TabCompletionFilter;
	// @ mention completion props (AI mode) - unified picker (files/dirs/agents/groups)
	atMentionOpen?: boolean;
	atMentionFilter?: string;
	atMentionStartIndex?: number;
	atMentionItems?: import('../../hooks/input/useMentionPicker').MentionPickerItem[];
	atMentionCounts?: Record<import('../../hooks/input/useMentionPicker').MentionCategory, number>;
	atMentionCategory?: import('../../hooks/input/useMentionPicker').MentionCategory;
	selectedAtMentionIndex?: number;

	// Setters
	setGitDiffPreview: (preview: string | null) => void;
	setLogViewerOpen: (open: boolean) => void;
	setAgentSessionsOpen: (open: boolean) => void;
	setMemoryViewerOpen: (open: boolean) => void;
	setActiveAgentSessionId: (id: string | null) => void;
	onResumeAgentSession: (
		agentSessionId: string,
		messages: import('../../types').LogEntry[],
		sessionName?: string,
		starred?: boolean,
		usageStats?: import('../../types').UsageStats
	) => void;
	onNewAgentSession: () => void;
	setInputValue: (value: string) => void;
	setStagedImages: React.Dispatch<React.SetStateAction<string[]>>;
	setLightboxImage: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	setCommandHistoryOpen: (open: boolean) => void;
	setCommandHistoryFilter: (filter: string) => void;
	setCommandHistorySelectedIndex: (index: number) => void;
	setSlashCommandOpen: (open: boolean) => void;
	setSelectedSlashCommandIndex: (index: number) => void;
	// Tab completion setters
	setTabCompletionOpen?: (open: boolean) => void;
	setSelectedTabCompletionIndex?: (index: number) => void;
	setTabCompletionFilter?: (filter: import('../../hooks').TabCompletionFilter) => void;
	// @ mention completion setters
	setAtMentionOpen?: (open: boolean) => void;
	setAtMentionFilter?: (filter: string) => void;
	setAtMentionStartIndex?: (index: number) => void;
	setSelectedAtMentionIndex?: (index: number) => void;
	setAtMentionCategory?: (
		category: import('../../hooks/input/useMentionPicker').MentionCategory
	) => void;
	setGitLogOpen: (open: boolean) => void;

	// Refs
	inputRef: React.RefObject<HTMLTextAreaElement>;
	logsEndRef: React.RefObject<HTMLDivElement>;
	terminalOutputRef: React.RefObject<HTMLDivElement>;

	// Functions
	toggleInputMode: () => void;
	processInput: () => void;
	handleInterrupt: () => void;
	handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	handleDrop: (e: React.DragEvent<HTMLElement>) => void;
	getContextColor: (usage: number, theme: Theme) => string;
	setActiveSessionId: (id: string) => void;
	onDeleteLog?: (logId: string) => number | null;
	onRemoveQueuedItem?: (itemId: string) => void;
	onTogglePauseQueuedItem?: (itemId: string) => void;
	onEditQueuedItem?: (itemId: string, patch: { text: string; images: string[] }) => void;
	onReorderQueuedItem?: (fromIndex: number, toIndex: number, tabId?: string) => void;
	onForceSendQueuedItem?: (itemId: string) => void;
	forcedParallelEnabled?: boolean;
	getForceSendContext?: (
		item: QueuedItem
	) => { targetTabBusy: boolean; otherBusyTabs: { id: string; displayName: string }[] } | null;
	onOpenQueueBrowser?: () => void;

	// Auto mode props
	currentSessionBatchState?: BatchRunState | null; // For current session only (input highlighting)
	onStopBatchRun?: (sessionId?: string) => void;

	// Tab management for AI sessions
	onTabSelect?: (tabId: string) => void;
	onTabClose?: (tabId: string) => void;
	onNewTab?: () => void;
	onRequestTabRename?: (tabId: string) => void;
	onTabReorder?: (fromIndex: number, toIndex: number) => void;
	onUnifiedTabReorder?: (fromIndex: number, toIndex: number) => void;
	onTabStar?: (tabId: string, starred: boolean) => void;
	onTabMarkUnread?: (tabId: string) => void;
	onUpdateTabByClaudeSessionId?: (
		agentSessionId: string,
		updates: { name?: string | null; starred?: boolean }
	) => void;
	onToggleTabReadOnlyMode?: () => void;
	onToggleTabSaveToHistory?: () => void;
	onToggleTabShowThinking?: () => void;
	onToggleTabShowTools?: () => void;
	onToggleTabEnterToSend?: () => void;
	onToggleUnreadFilter?: () => void;
	onOpenTabSearch?: () => void;
	/** Handler to open output/message search (Cmd+F) */
	onOpenOutputSearch?: () => void;
	// Bulk tab close operations
	onCloseAllTabs?: () => void;
	onCloseOtherTabs?: (pivotTabId?: string) => void;
	onCloseTabsLeft?: (pivotTabId?: string) => void;
	onCloseTabsRight?: (pivotTabId?: string) => void;

	// Unified tab system (Phase 4) - file preview tabs integrated with AI tabs
	unifiedTabs?: UnifiedTab[];
	activeFileTabId?: string | null;
	activeFileTab?: FilePreviewTab | null;
	activeBrowserTabId?: string | null;
	activeBrowserTab?: BrowserTab | null;
	onFileTabSelect?: (tabId: string) => void;
	onFileTabClose?: (tabId: string) => void;
	onFileTabRename?: (tabId: string) => void;
	onNewFileTab?: () => void;
	onNewBrowserTab?: (options?: { ephemeral?: boolean }) => void;
	onBrowserTabSelect?: (tabId: string) => void;
	onBrowserTabClose?: (tabId: string) => void;
	onBrowserTabRename?: (tabId: string) => void;
	onBrowserTabResetName?: (tabId: string) => void;
	onBrowserTabUpdate?: (sessionId: string, tabId: string, updates: Partial<BrowserTab>) => void;

	// Terminal tab callbacks (Phase 8)
	onNewTerminalTab?: () => void;
	onTerminalTabSelect?: (tabId: string) => void;
	onTerminalTabClose?: (tabId: string) => void;
	onTerminalTabRename?: (tabId: string) => void;
	/** Handler to open the startup-command modal for a terminal tab */
	onTerminalTabConfigureStartupCommand?: (tabId: string) => void;
	onOpenFileTab?: (filePath: string) => void;
	/** Handler to update file tab editMode when toggled in FilePreview */
	onFileTabEditModeChange?: (tabId: string, editMode: boolean) => void;
	/** Handler to update file tab editContent when changed in FilePreview */
	onFileTabEditContentChange?: (
		tabId: string,
		editContent: string | undefined,
		savedContent?: string
	) => void;
	/** Handler to update file tab scrollTop when scrolling in FilePreview */
	onFileTabScrollPositionChange?: (tabId: string, scrollTop: number) => void;
	/** Handler to update file tab searchQuery when searching in FilePreview */
	onFileTabSearchQueryChange?: (tabId: string, searchQuery: string) => void;
	/** Handler to reload file tab content from disk */
	onReloadFileTab?: (tabId: string) => void;

	// Scroll position persistence
	onScrollPositionChange?: (scrollTop: number) => void;
	// Scroll bottom state change handler (for hasUnread logic)
	onAtBottomChange?: (isAtBottom: boolean) => void;
	// Input blur handler for persisting AI input state
	onInputBlur?: () => void;
	/** Capture composer owner on focus so blur can pin the write target */
	onComposerFocus?: () => void;
	// Prompt composer modal
	onOpenPromptComposer?: () => void;
	// Replay a user message (AI mode)
	onReplayMessage?: (text: string, images?: string[]) => void;
	onForkConversation?: (logId: string) => void;
	// In-place recovery from session_not_found errors. Triggered by the
	// SessionRecoveryCard inside system log entries that carry a
	// `recoveryAction` payload.
	onSessionRecover?: (opts: {
		sessionId: string;
		tabId: string;
		lastUserPrompt: string;
		groomContext: boolean;
	}) => void;
	isRecoveringSession?: boolean;
	sessionRecoveryError?: string | null;
	// File tree for linking file references in AI responses
	fileTree?: import('../../types/fileTree').FileNode[];
	// Callback when a file link is clicked in AI response
	// options.openInNewTab: true = open in new tab adjacent to current, false = replace current tab content
	onFileClick?: (relativePath: string, options?: { openInNewTab?: boolean }) => void;
	// File tree refresh callback (used when saving chat content to disk)
	refreshFileTree?: (
		sessionId: string
	) => Promise<import('../../utils/fileExplorer').FileTreeChanges | undefined>;
	// Callback to open a saved file in a tab
	onOpenSavedFileInTab?: (file: {
		path: string;
		name: string;
		content: string;
		sshRemoteId?: string;
	}) => void;
	// File preview navigation
	canGoBack?: boolean;
	canGoForward?: boolean;
	onNavigateBack?: () => void;
	onNavigateForward?: () => void;
	backHistory?: { name: string; path: string; scrollTop?: number }[];
	forwardHistory?: { name: string; path: string; scrollTop?: number }[];
	currentHistoryIndex?: number;
	onNavigateToIndex?: (index: number) => void;
	onClearFilePreviewHistory?: () => void;

	// Agent error handling
	onClearAgentError?: () => void;
	onShowAgentErrorModal?: (error?: AgentError) => void;
	// Flash notification callback
	showFlashNotification?: (message: string) => void;
	// Fuzzy file search callback (for FilePreview in preview mode)
	onOpenFuzzySearch?: () => void;

	// Worktree configuration
	onOpenWorktreeConfig?: () => void;
	onOpenCreatePR?: () => void;
	/** True if this session is a worktree child (has parentSessionId) */
	isWorktreeChild?: boolean;

	// Context management
	onSummarizeAndContinue?: (tabId: string) => void;
	onMergeWith?: (tabId: string) => void;
	onSendToAgent?: (tabId: string) => void;
	onCopyContext?: (tabId: string, options?: CopyContextOptions) => void;
	onExportHtml?: (tabId: string) => void;
	onPublishTabGist?: (tabId: string) => void;
	/** Copy arbitrary text to the clipboard (wired by MainPanel for terminal buffer actions). */
	onCopyText?: (text: string, subject?: string) => void;
	/** Queue arbitrary text for the Gist modal (wired by MainPanel for terminal buffer actions). */
	onPublishTextAsGist?: (text: string, filenameStem: string) => void;
	/** Queue arbitrary text for Send to Agent (wired by MainPanel for terminal buffer actions). */
	onSendTextToAgent?: (text: string, sourceName: string) => void;

	// Summarization progress props (non-blocking, per-tab)
	summarizeProgress?: import('../../types/contextMerge').SummarizeProgress | null;
	summarizeResult?: import('../../types/contextMerge').SummarizeResult | null;
	summarizeStartTime?: number;
	isSummarizing?: boolean;
	onCancelSummarize?: () => void;

	// Merge progress props (non-blocking, per-tab)
	mergeProgress?: import('../../types/contextMerge').GroomingProgress | null;
	mergeResult?: import('../../types/contextMerge').MergeResult | null;
	mergeStartTime?: number;
	isMerging?: boolean;
	mergeSourceName?: string;
	mergeTargetName?: string;
	onCancelMerge?: () => void;

	// Keyboard mastery tracking
	onShortcutUsed?: (shortcutId: string) => void;

	// Gist publishing
	ghCliAvailable?: boolean;
	onPublishGist?: () => void;
	/** Whether the current preview file has been published as a gist */
	hasGist?: boolean;
	/** Publish a single AI message as a GitHub Gist */
	onPublishMessageGist?: (text: string, messageId?: string) => void;

	// Document Graph
	onOpenInGraph?: () => void;

	/** Open the currently previewed file in a new Maestro browser tab. */
	onOpenInBrowser?: () => void;

	// Wizard document generation callbacks
	/** Called when wizard document generation completes and user clicks Done */
	onWizardComplete?: () => void;
	/** Called when user wants to complete the wizard AND immediately start the Batch Runner for the generated docs */
	onWizardCompleteAndStartAutoRun?: () => void;
	/** Called when user selects a different document in the wizard */
	onWizardDocumentSelect?: (index: number) => void;
	/** Called when user edits document content in the wizard */
	onWizardContentChange?: (content: string, docIndex: number) => void;
	/** Called when user clicks "Let's Go" in wizard to start document generation */
	onWizardLetsGo?: () => void;
	/** Called when user clicks "Retry" in wizard after an error */
	onWizardRetry?: () => void;
	/** Called when user dismisses an error in the wizard */
	onWizardClearError?: () => void;
	/** Called when user exits inline wizard mode (Escape or clicks pill) */
	onExitWizard?: () => void;
	/** Toggle showing wizard thinking instead of filler phrases */
	onToggleWizardShowThinking?: () => void;
	/** Called when user cancels document generation */
	onWizardCancelGeneration?: () => void;
}
