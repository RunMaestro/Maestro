/**
 * useMainPanelProps Hook
 *
 * Extracts and memoizes all props for the MainPanel component.
 * This prevents React from re-evaluating 100+ props on every state change
 * in MaestroConsoleInner by only recomputing when actual dependencies change.
 *
 * Key optimization: Uses primitive values in dependency arrays (e.g., activeSession?.id
 * instead of activeSession) to minimize re-renders.
 */

import { useMemo } from 'react';
import type { MainPanelHandle } from '../../components/MainPanel';
import type {
	Session,
	Theme,
	Shortcut,
	FocusArea,
	BatchRunState,
	LogEntry,
	UsageStats,
	AITab,
} from '../../types';
import type { TabCompletionSuggestion, TabCompletionFilter } from '../input/useTabCompletion';
import type {
	SummarizeProgress,
	SummarizeResult,
	GroomingProgress,
	MergeResult,
} from '../../types/contextMerge';
import type { FileNode } from '../../types/fileTree';
import type { DocumentGenerationCallbacks } from '../../services/inlineWizardDocumentGeneration';

/**
 * Dependencies for computing MainPanel props.
 * Separated from the props interface to ensure clear inputs vs outputs.
 */
export interface UseMainPanelPropsDeps {
	// Core state (primitives for memoization)
	logViewerOpen: boolean;
	agentSessionsOpen: boolean;
	activeAgentSessionId: string | null;
	activeSession: Session | null;
	thinkingSessions: Session[];
	theme: Theme;
	fontFamily: string;
	isMobileLandscape: boolean;
	activeFocus: FocusArea;
	outputSearchOpen: boolean;
	outputSearchQuery: string;
	inputValue: string;
	enterToSendAI: boolean;
	enterToSendTerminal: boolean;
	stagedImages: string[];
	commandHistoryOpen: boolean;
	commandHistoryFilter: string;
	commandHistorySelectedIndex: number;
	slashCommandOpen: boolean;
	slashCommands: Array<{ command: string; description: string }>;
	selectedSlashCommandIndex: number;
	previewFile: { name: string; content: string; path: string } | null;
	filePreviewLoading: { name: string; path: string } | null;
	markdownEditMode: boolean;
	shortcuts: Record<string, Shortcut>;
	rightPanelOpen: boolean;
	maxOutputLines: number;
	gitDiffPreview: string | null;
	fileTreeFilterOpen: boolean;
	logLevel: string;
	logViewerSelectedLevels: string[];

	// Tab completion state
	tabCompletionOpen: boolean;
	tabCompletionSuggestions: TabCompletionSuggestion[];
	selectedTabCompletionIndex: number;
	tabCompletionFilter: TabCompletionFilter;

	// @ mention completion state
	atMentionOpen: boolean;
	atMentionFilter: string;
	atMentionStartIndex: number;
	atMentionSuggestions: Array<{
		value: string;
		type: 'file' | 'folder';
		displayText: string;
		fullPath: string;
	}>;
	selectedAtMentionIndex: number;

	// Batch run state (undefined matches component prop type)
	activeBatchRunState: BatchRunState | undefined;
	currentSessionBatchState: BatchRunState | undefined;

	// File tree
	fileTree: FileNode[];

	// File preview navigation
	canGoBack: boolean;
	canGoForward: boolean;
	backHistory: { name: string; content: string; path: string }[];
	forwardHistory: { name: string; content: string; path: string }[];
	filePreviewHistoryIndex: number;

	// Active tab for error handling
	activeTab: AITab | undefined;

	// Worktree
	isWorktreeChild: boolean;

	// Context management settings
	contextWarningsEnabled: boolean;
	contextWarningYellowThreshold: number;
	contextWarningRedThreshold: number;

	// Summarization progress
	summarizeProgress: SummarizeProgress | null;
	summarizeResult: SummarizeResult | null;
	summarizeStartTime: number;
	isSummarizing: boolean;

	// Merge progress
	mergeProgress: GroomingProgress | null;
	mergeStartTime: number;
	isMerging: boolean;
	mergeSourceName: string | undefined;
	mergeTargetName: string | undefined;

	// Gist publishing
	ghCliAvailable: boolean;
	hasGist: boolean;

	// Unread filter
	showUnreadOnly: boolean;

	// Audio feedback
	audioFeedbackCommand: string;

	// Setters (these are stable callbacks - should be memoized at definition site)
	setLogViewerSelectedLevels: (levels: string[]) => void;
	setGitDiffPreview: (preview: string | null) => void;
	setLogViewerOpen: (open: boolean) => void;
	setAgentSessionsOpen: (open: boolean) => void;
	setActiveAgentSessionId: (id: string | null) => void;
	setActiveFocus: (focus: FocusArea) => void;
	setOutputSearchOpen: (open: boolean) => void;
	setOutputSearchQuery: (query: string) => void;
	setInputValue: (value: string) => void;
	setEnterToSendAI: (value: boolean) => void;
	setEnterToSendTerminal: (value: boolean) => void;
	setStagedImages: React.Dispatch<React.SetStateAction<string[]>>;
	setCommandHistoryOpen: (open: boolean) => void;
	setCommandHistoryFilter: (filter: string) => void;
	setCommandHistorySelectedIndex: (index: number) => void;
	setSlashCommandOpen: (open: boolean) => void;
	setSelectedSlashCommandIndex: (index: number) => void;
	setTabCompletionOpen: (open: boolean) => void;
	setSelectedTabCompletionIndex: (index: number) => void;
	setTabCompletionFilter: (filter: TabCompletionFilter) => void;
	setAtMentionOpen: (open: boolean) => void;
	setAtMentionFilter: (filter: string) => void;
	setAtMentionStartIndex: (index: number) => void;
	setSelectedAtMentionIndex: (index: number) => void;
	setPreviewFile: (file: { name: string; content: string; path: string } | null) => void;
	setMarkdownEditMode: (mode: boolean) => void;
	setAboutModalOpen: (open: boolean) => void;
	setRightPanelOpen: (open: boolean) => void;
	setGitLogOpen: (open: boolean) => void;

	// Refs
	inputRef: React.RefObject<HTMLTextAreaElement>;
	logsEndRef: React.RefObject<HTMLDivElement>;
	terminalOutputRef: React.RefObject<HTMLDivElement>;
	fileTreeContainerRef: React.RefObject<HTMLDivElement>;
	fileTreeFilterInputRef: React.RefObject<HTMLInputElement>;

	// Handlers (should be memoized with useCallback at definition site)
	handleResumeSession: (
		agentSessionId: string,
		messages: LogEntry[],
		sessionName?: string,
		starred?: boolean,
		usageStats?: UsageStats
	) => void;
	handleNewAgentSession: () => void;
	toggleInputMode: () => void;
	processInput: () => void;
	handleInterrupt: () => void;
	handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	handleDrop: (e: React.DragEvent<HTMLElement>) => void;
	getContextColor: (usage: number, theme: Theme) => string;
	setActiveSessionId: (id: string) => void;
	handleStopBatchRun: (sessionId?: string) => void;
	showConfirmation: (message: string, onConfirm: () => void) => void;
	handleDeleteLog: (logId: string) => number | null;
	handleRemoveQueuedItem: (itemId: string) => void;
	handleOpenQueueBrowser: () => void;

	// Tab management handlers
	handleTabSelect: (tabId: string) => void;
	handleTabClose: (tabId: string) => void;
	handleNewTab: () => void;
	handleRequestTabRename: (tabId: string) => void;
	handleTabReorder: (fromIndex: number, toIndex: number) => void;
	handleUpdateTabByClaudeSessionId: (
		agentSessionId: string,
		updates: { name?: string | null; starred?: boolean }
	) => void;
	handleTabStar: (tabId: string, starred: boolean) => void;
	handleTabMarkUnread: (tabId: string) => void;
	handleToggleTabReadOnlyMode: () => void;
	handleToggleTabSaveToHistory: () => void;
	handleToggleTabShowThinking: () => void;
	toggleUnreadFilter: () => void;
	handleOpenTabSearch: () => void;
	handleCloseAllTabs: () => void;
	handleCloseOtherTabs: () => void;
	handleCloseTabsLeft: () => void;
	handleCloseTabsRight: () => void;
	handleScrollPositionChange: (scrollTop: number) => void;
	handleAtBottomChange: (isAtBottom: boolean) => void;
	handleMainPanelInputBlur: () => void;
	handleOpenPromptComposer: () => void;
	handleReplayMessage: (text: string, images?: string[]) => void;
	handleMainPanelFileClick: (relativePath: string) => void;
	handleNavigateBack: () => void;
	handleNavigateForward: () => void;
	handleNavigateToIndex: (index: number) => void;
	handleClearAgentErrorForMainPanel: () => void;
	handleShowAgentErrorModal: () => void;
	showSuccessFlash: (message: string) => void;
	handleOpenFuzzySearch: () => void;
	handleOpenWorktreeConfig: () => void;
	handleOpenCreatePR: () => void;
	handleSummarizeAndContinue: (tabId: string) => void;
	handleMergeWith: (tabId: string) => void;
	handleOpenSendToAgentModal: (tabId: string) => void;
	handleCopyContext: (tabId: string) => void;
	handleExportHtml: (tabId: string) => void;
	handlePublishTabGist: (tabId: string) => void;
	cancelTab: (tabId: string) => void;
	cancelMergeTab: (tabId: string) => void;
	recordShortcutUsage: (shortcutId: string) => { newLevel: number | null };
	onKeyboardMasteryLevelUp: (level: number) => void;
	handleSetLightboxImage: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;

	// Gist publishing
	setGistPublishModalOpen: (open: boolean) => void;

	// Document Graph
	setGraphFocusFilePath: (path: string) => void;
	setLastGraphFocusFilePath: (path: string) => void;
	setIsGraphViewOpen: (open: boolean) => void;

	// Wizard callbacks
	generateInlineWizardDocuments: (
		callbacks?: DocumentGenerationCallbacks,
		tabId?: string
	) => Promise<void>;
	retryInlineWizardMessage: () => void;
	clearInlineWizardError: () => void;
	endInlineWizard: () => void;
	handleAutoRunRefresh: () => void;

	// Complex wizard handlers (passed through from App.tsx)
	onWizardComplete?: () => void;
	onWizardLetsGo?: () => void;
	onWizardRetry?: () => void;
	onWizardClearError?: () => void;
	onToggleWizardShowThinking?: () => void;

	// Helper functions
	getActiveTab: (session: Session) => AITab | undefined;
}

/**
 * Hook to compute and memoize MainPanel props.
 *
 * @param deps - All dependencies needed to compute MainPanel props
 * @returns Memoized props object for MainPanel
 */
export function useMainPanelProps(deps: UseMainPanelPropsDeps) {
	return useMemo(
		() => ({
			// State props
			logViewerOpen: deps.logViewerOpen,
			agentSessionsOpen: deps.agentSessionsOpen,
			activeAgentSessionId: deps.activeAgentSessionId,
			activeSession: deps.activeSession,
			thinkingSessions: deps.thinkingSessions,
			theme: deps.theme,
			fontFamily: deps.fontFamily,
			isMobileLandscape: deps.isMobileLandscape,
			activeFocus: deps.activeFocus,
			outputSearchOpen: deps.outputSearchOpen,
			outputSearchQuery: deps.outputSearchQuery,
			inputValue: deps.inputValue,
			enterToSendAI: deps.enterToSendAI,
			enterToSendTerminal: deps.enterToSendTerminal,
			stagedImages: deps.stagedImages,
			commandHistoryOpen: deps.commandHistoryOpen,
			commandHistoryFilter: deps.commandHistoryFilter,
			commandHistorySelectedIndex: deps.commandHistorySelectedIndex,
			slashCommandOpen: deps.slashCommandOpen,
			slashCommands: deps.slashCommands,
			selectedSlashCommandIndex: deps.selectedSlashCommandIndex,
			previewFile: deps.previewFile,
			filePreviewLoading: deps.filePreviewLoading,
			markdownEditMode: deps.markdownEditMode,
			shortcuts: deps.shortcuts,
			rightPanelOpen: deps.rightPanelOpen,
			maxOutputLines: deps.maxOutputLines,
			gitDiffPreview: deps.gitDiffPreview,
			fileTreeFilterOpen: deps.fileTreeFilterOpen,
			logLevel: deps.logLevel,
			logViewerSelectedLevels: deps.logViewerSelectedLevels,
			setLogViewerSelectedLevels: deps.setLogViewerSelectedLevels,
			setGitDiffPreview: deps.setGitDiffPreview,
			setLogViewerOpen: deps.setLogViewerOpen,
			setAgentSessionsOpen: deps.setAgentSessionsOpen,
			setActiveAgentSessionId: deps.setActiveAgentSessionId,
			onResumeAgentSession: deps.handleResumeSession,
			onNewAgentSession: deps.handleNewAgentSession,
			setActiveFocus: deps.setActiveFocus,
			setOutputSearchOpen: deps.setOutputSearchOpen,
			setOutputSearchQuery: deps.setOutputSearchQuery,
			setInputValue: deps.setInputValue,
			setEnterToSendAI: deps.setEnterToSendAI,
			setEnterToSendTerminal: deps.setEnterToSendTerminal,
			setStagedImages: deps.setStagedImages,
			setLightboxImage: deps.handleSetLightboxImage,
			setCommandHistoryOpen: deps.setCommandHistoryOpen,
			setCommandHistoryFilter: deps.setCommandHistoryFilter,
			setCommandHistorySelectedIndex: deps.setCommandHistorySelectedIndex,
			setSlashCommandOpen: deps.setSlashCommandOpen,
			setSelectedSlashCommandIndex: deps.setSelectedSlashCommandIndex,
			tabCompletionOpen: deps.tabCompletionOpen,
			setTabCompletionOpen: deps.setTabCompletionOpen,
			tabCompletionSuggestions: deps.tabCompletionSuggestions,
			selectedTabCompletionIndex: deps.selectedTabCompletionIndex,
			setSelectedTabCompletionIndex: deps.setSelectedTabCompletionIndex,
			tabCompletionFilter: deps.tabCompletionFilter,
			setTabCompletionFilter: deps.setTabCompletionFilter,
			atMentionOpen: deps.atMentionOpen,
			setAtMentionOpen: deps.setAtMentionOpen,
			atMentionFilter: deps.atMentionFilter,
			setAtMentionFilter: deps.setAtMentionFilter,
			atMentionStartIndex: deps.atMentionStartIndex,
			setAtMentionStartIndex: deps.setAtMentionStartIndex,
			atMentionSuggestions: deps.atMentionSuggestions,
			selectedAtMentionIndex: deps.selectedAtMentionIndex,
			setSelectedAtMentionIndex: deps.setSelectedAtMentionIndex,
			setPreviewFile: deps.setPreviewFile,
			setMarkdownEditMode: deps.setMarkdownEditMode,
			setAboutModalOpen: deps.setAboutModalOpen,
			setRightPanelOpen: deps.setRightPanelOpen,
			setGitLogOpen: deps.setGitLogOpen,
			inputRef: deps.inputRef,
			logsEndRef: deps.logsEndRef,
			terminalOutputRef: deps.terminalOutputRef,
			fileTreeContainerRef: deps.fileTreeContainerRef,
			fileTreeFilterInputRef: deps.fileTreeFilterInputRef,
			toggleInputMode: deps.toggleInputMode,
			processInput: deps.processInput,
			handleInterrupt: deps.handleInterrupt,
			handleInputKeyDown: deps.handleInputKeyDown,
			handlePaste: deps.handlePaste,
			handleDrop: deps.handleDrop,
			getContextColor: deps.getContextColor,
			setActiveSessionId: deps.setActiveSessionId,
			batchRunState: deps.activeBatchRunState,
			currentSessionBatchState: deps.currentSessionBatchState,
			onStopBatchRun: deps.handleStopBatchRun,
			showConfirmation: deps.showConfirmation,
			onDeleteLog: deps.handleDeleteLog,
			onRemoveQueuedItem: deps.handleRemoveQueuedItem,
			onOpenQueueBrowser: deps.handleOpenQueueBrowser,
			audioFeedbackCommand: deps.audioFeedbackCommand,
			// Tab management handlers
			onTabSelect: deps.handleTabSelect,
			onTabClose: deps.handleTabClose,
			onNewTab: deps.handleNewTab,
			onRequestTabRename: deps.handleRequestTabRename,
			onTabReorder: deps.handleTabReorder,
			onUpdateTabByClaudeSessionId: deps.handleUpdateTabByClaudeSessionId,
			onTabStar: deps.handleTabStar,
			onTabMarkUnread: deps.handleTabMarkUnread,
			onToggleTabReadOnlyMode: deps.handleToggleTabReadOnlyMode,
			showUnreadOnly: deps.showUnreadOnly,
			onToggleUnreadFilter: deps.toggleUnreadFilter,
			onOpenTabSearch: deps.handleOpenTabSearch,
			onCloseAllTabs: deps.handleCloseAllTabs,
			onCloseOtherTabs: deps.handleCloseOtherTabs,
			onCloseTabsLeft: deps.handleCloseTabsLeft,
			onCloseTabsRight: deps.handleCloseTabsRight,
			onToggleTabSaveToHistory: deps.handleToggleTabSaveToHistory,
			onToggleTabShowThinking: deps.handleToggleTabShowThinking,
			onScrollPositionChange: deps.handleScrollPositionChange,
			onAtBottomChange: deps.handleAtBottomChange,
			onInputBlur: deps.handleMainPanelInputBlur,
			onOpenPromptComposer: deps.handleOpenPromptComposer,
			onReplayMessage: deps.handleReplayMessage,
			fileTree: deps.fileTree,
			onFileClick: deps.handleMainPanelFileClick,
			canGoBack: deps.canGoBack,
			canGoForward: deps.canGoForward,
			onNavigateBack: deps.handleNavigateBack,
			onNavigateForward: deps.handleNavigateForward,
			backHistory: deps.backHistory,
			forwardHistory: deps.forwardHistory,
			currentHistoryIndex: deps.filePreviewHistoryIndex,
			onNavigateToIndex: deps.handleNavigateToIndex,
			onClearAgentError: deps.activeTab?.agentError
				? deps.handleClearAgentErrorForMainPanel
				: undefined,
			onShowAgentErrorModal: deps.activeTab?.agentError
				? deps.handleShowAgentErrorModal
				: undefined,
			showFlashNotification: deps.showSuccessFlash,
			onOpenFuzzySearch: deps.handleOpenFuzzySearch,
			onOpenWorktreeConfig: deps.handleOpenWorktreeConfig,
			onOpenCreatePR: deps.handleOpenCreatePR,
			isWorktreeChild: deps.isWorktreeChild,
			onSummarizeAndContinue: deps.handleSummarizeAndContinue,
			onMergeWith: deps.handleMergeWith,
			onSendToAgent: deps.handleOpenSendToAgentModal,
			onCopyContext: deps.handleCopyContext,
			onExportHtml: deps.handleExportHtml,
			onPublishTabGist: deps.handlePublishTabGist,
			// Context warning sash settings
			contextWarningsEnabled: deps.contextWarningsEnabled,
			contextWarningYellowThreshold: deps.contextWarningYellowThreshold,
			contextWarningRedThreshold: deps.contextWarningRedThreshold,
			// Summarization progress props
			summarizeProgress: deps.summarizeProgress,
			summarizeResult: deps.summarizeResult,
			summarizeStartTime: deps.summarizeStartTime,
			isSummarizing: deps.isSummarizing,
			onCancelSummarize: deps.activeSession?.activeTabId
				? () => deps.cancelTab(deps.activeSession!.activeTabId!)
				: undefined,
			// Merge progress props
			mergeProgress: deps.mergeProgress,
			mergeResult: null as MergeResult | null,
			mergeStartTime: deps.mergeStartTime,
			isMerging: deps.isMerging,
			mergeSourceName: deps.mergeSourceName,
			mergeTargetName: deps.mergeTargetName,
			onCancelMerge: deps.activeSession?.activeTabId
				? () => deps.cancelMergeTab(deps.activeSession!.activeTabId!)
				: undefined,
			onShortcutUsed: (shortcutId: string) => {
				const result = deps.recordShortcutUsage(shortcutId);
				if (result.newLevel !== null) {
					deps.onKeyboardMasteryLevelUp(result.newLevel);
				}
			},
			ghCliAvailable: deps.ghCliAvailable,
			onPublishGist: () => deps.setGistPublishModalOpen(true),
			hasGist: deps.hasGist,
			onOpenInGraph: () => {
				if (deps.previewFile && deps.activeSession) {
					const graphRootPath = deps.activeSession.projectRoot || deps.activeSession.cwd || '';
					const relativePath = deps.previewFile.path.startsWith(graphRootPath + '/')
						? deps.previewFile.path.slice(graphRootPath.length + 1)
						: deps.previewFile.path.startsWith(graphRootPath)
							? deps.previewFile.path.slice(graphRootPath.length + 1)
							: deps.previewFile.name;
					deps.setGraphFocusFilePath(relativePath);
					deps.setLastGraphFocusFilePath(relativePath);
					deps.setIsGraphViewOpen(true);
				}
			},
			// Inline wizard callbacks handled inline to maintain closure access
			onExitWizard: deps.endInlineWizard,
			onWizardCancelGeneration: deps.endInlineWizard,
			// Complex wizard handlers (passed through from App.tsx)
			onWizardComplete: deps.onWizardComplete,
			onWizardLetsGo: deps.onWizardLetsGo,
			onWizardRetry: deps.onWizardRetry,
			onWizardClearError: deps.onWizardClearError,
			onToggleWizardShowThinking: deps.onToggleWizardShowThinking,
		}),
		[
			// Primitive dependencies for minimal re-computation
			deps.logViewerOpen,
			deps.agentSessionsOpen,
			deps.activeAgentSessionId,
			deps.activeSession?.id, // Use ID instead of full object
			deps.activeSession?.activeTabId,
			deps.activeSession?.inputMode,
			deps.activeSession?.projectRoot,
			deps.activeSession?.cwd,
			deps.thinkingSessions,
			deps.theme,
			deps.fontFamily,
			deps.isMobileLandscape,
			deps.activeFocus,
			deps.outputSearchOpen,
			deps.outputSearchQuery,
			deps.inputValue,
			deps.enterToSendAI,
			deps.enterToSendTerminal,
			deps.stagedImages,
			deps.commandHistoryOpen,
			deps.commandHistoryFilter,
			deps.commandHistorySelectedIndex,
			deps.slashCommandOpen,
			deps.slashCommands,
			deps.selectedSlashCommandIndex,
			deps.previewFile,
			deps.filePreviewLoading,
			deps.markdownEditMode,
			deps.shortcuts,
			deps.rightPanelOpen,
			deps.maxOutputLines,
			deps.gitDiffPreview,
			deps.fileTreeFilterOpen,
			deps.logLevel,
			deps.logViewerSelectedLevels,
			deps.tabCompletionOpen,
			deps.tabCompletionSuggestions,
			deps.selectedTabCompletionIndex,
			deps.tabCompletionFilter,
			deps.atMentionOpen,
			deps.atMentionFilter,
			deps.atMentionStartIndex,
			deps.atMentionSuggestions,
			deps.selectedAtMentionIndex,
			deps.activeBatchRunState,
			deps.currentSessionBatchState,
			deps.fileTree,
			deps.canGoBack,
			deps.canGoForward,
			deps.backHistory,
			deps.forwardHistory,
			deps.filePreviewHistoryIndex,
			deps.activeTab?.agentError,
			deps.isWorktreeChild,
			deps.contextWarningsEnabled,
			deps.contextWarningYellowThreshold,
			deps.contextWarningRedThreshold,
			deps.summarizeProgress,
			deps.summarizeResult,
			deps.summarizeStartTime,
			deps.isSummarizing,
			deps.mergeProgress,
			deps.mergeStartTime,
			deps.isMerging,
			deps.mergeSourceName,
			deps.mergeTargetName,
			deps.ghCliAvailable,
			deps.hasGist,
			deps.showUnreadOnly,
			deps.audioFeedbackCommand,
			// Stable callbacks (shouldn't cause re-renders, but included for completeness)
			deps.setLogViewerSelectedLevels,
			deps.setGitDiffPreview,
			deps.setLogViewerOpen,
			deps.setAgentSessionsOpen,
			deps.setActiveAgentSessionId,
			deps.handleResumeSession,
			deps.handleNewAgentSession,
			deps.setActiveFocus,
			deps.setOutputSearchOpen,
			deps.setOutputSearchQuery,
			deps.setInputValue,
			deps.setEnterToSendAI,
			deps.setEnterToSendTerminal,
			deps.setStagedImages,
			deps.handleSetLightboxImage,
			deps.setCommandHistoryOpen,
			deps.setCommandHistoryFilter,
			deps.setCommandHistorySelectedIndex,
			deps.setSlashCommandOpen,
			deps.setSelectedSlashCommandIndex,
			deps.setTabCompletionOpen,
			deps.setSelectedTabCompletionIndex,
			deps.setTabCompletionFilter,
			deps.setAtMentionOpen,
			deps.setAtMentionFilter,
			deps.setAtMentionStartIndex,
			deps.setSelectedAtMentionIndex,
			deps.setPreviewFile,
			deps.setMarkdownEditMode,
			deps.setAboutModalOpen,
			deps.setRightPanelOpen,
			deps.setGitLogOpen,
			deps.toggleInputMode,
			deps.processInput,
			deps.handleInterrupt,
			deps.handleInputKeyDown,
			deps.handlePaste,
			deps.handleDrop,
			deps.getContextColor,
			deps.setActiveSessionId,
			deps.handleStopBatchRun,
			deps.showConfirmation,
			deps.handleDeleteLog,
			deps.handleRemoveQueuedItem,
			deps.handleOpenQueueBrowser,
			deps.handleTabSelect,
			deps.handleTabClose,
			deps.handleNewTab,
			deps.handleRequestTabRename,
			deps.handleTabReorder,
			deps.handleUpdateTabByClaudeSessionId,
			deps.handleTabStar,
			deps.handleTabMarkUnread,
			deps.handleToggleTabReadOnlyMode,
			deps.handleToggleTabSaveToHistory,
			deps.handleToggleTabShowThinking,
			deps.toggleUnreadFilter,
			deps.handleOpenTabSearch,
			deps.handleCloseAllTabs,
			deps.handleCloseOtherTabs,
			deps.handleCloseTabsLeft,
			deps.handleCloseTabsRight,
			deps.handleScrollPositionChange,
			deps.handleAtBottomChange,
			deps.handleMainPanelInputBlur,
			deps.handleOpenPromptComposer,
			deps.handleReplayMessage,
			deps.handleMainPanelFileClick,
			deps.handleNavigateBack,
			deps.handleNavigateForward,
			deps.handleNavigateToIndex,
			deps.handleClearAgentErrorForMainPanel,
			deps.handleShowAgentErrorModal,
			deps.showSuccessFlash,
			deps.handleOpenFuzzySearch,
			deps.handleOpenWorktreeConfig,
			deps.handleOpenCreatePR,
			deps.handleSummarizeAndContinue,
			deps.handleMergeWith,
			deps.handleOpenSendToAgentModal,
			deps.handleCopyContext,
			deps.handleExportHtml,
			deps.handlePublishTabGist,
			deps.cancelTab,
			deps.cancelMergeTab,
			deps.recordShortcutUsage,
			deps.onKeyboardMasteryLevelUp,
			deps.setGistPublishModalOpen,
			deps.setGraphFocusFilePath,
			deps.setLastGraphFocusFilePath,
			deps.setIsGraphViewOpen,
			deps.endInlineWizard,
			// Complex wizard handlers
			deps.onWizardComplete,
			deps.onWizardLetsGo,
			deps.onWizardRetry,
			deps.onWizardClearError,
			deps.onToggleWizardShowThinking,
			// Refs (stable, but included for completeness)
			deps.inputRef,
			deps.logsEndRef,
			deps.terminalOutputRef,
			deps.fileTreeContainerRef,
			deps.fileTreeFilterInputRef,
		]
	);
}
