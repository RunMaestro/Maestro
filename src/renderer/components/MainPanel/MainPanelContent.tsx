import React from 'react';

import { Spinner } from '../ui/Spinner';
import { TerminalOutput } from '../TerminalOutput';
import {
	TerminalView,
	createTabStateChangeHandler,
	createTabPidChangeHandler,
} from '../TerminalView';
import { InputArea } from '../InputArea';
import type { FilePreviewHandle } from '../FilePreview';
import { WizardConversationView, DocumentGenerationView } from '../InlineWizard';
import { BrowserTabView, type BrowserTabViewHandle } from './BrowserTabView';
import { useBrowserTabMounting } from '../../hooks/browser/useBrowserTabMounting';
import { useUIStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTabStore } from '../../stores/tabStore';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { outputSearchKeyFor } from '../../utils/outputSearch';
import type {
	Session,
	Theme,
	AITab,
	BatchRunState,
	BrowserTab,
	FilePreviewTab,
	ThinkingItem,
	QueuedItem,
} from '../../types';
import type { SlashCommand } from './types';
import type { TabCompletionSuggestion, TabCompletionFilter } from '../../hooks';
import type { FileNode } from '../../types/fileTree';
import type {
	SummarizeProgress,
	SummarizeResult,
	GroomingProgress,
	MergeResult,
} from '../../types/contextMerge';

// Lazy-loaded: FilePreview is the single aggregation point that pulls mermaid,
// react-syntax-highlighter, and the full react-markdown/remark/rehype stack into
// the bundle. None of it is needed until the user actually opens a file-preview
// tab (never on a fresh launch landing on an AI tab), so we code-split it behind
// first open to cut cold-start cost and idle memory. React.lazy preserves ref
// forwarding through FilePreview's memo()+forwardRef wrapper, so filePreviewRef
// keeps working once the chunk has mounted.
const FilePreview = React.lazy(() =>
	import('../FilePreview').then((m) => ({ default: m.FilePreview }))
);

export interface MainPanelContentProps {
	// Core state (guaranteed by parent guard)
	activeSession: Session;
	activeTab: AITab | null;
	theme: Theme;

	// File preview props (from useFilePreviewHandlers)
	activeFileTabId?: string | null;
	activeFileTab?: FilePreviewTab | null;
	activeBrowserTabId?: string | null;
	memoizedFilePreviewFile: { name: string; path: string; content: string } | null;
	filePreviewCwd: string;
	filePreviewSshRemoteId: string | undefined;
	filePreviewContainerRef: React.RefObject<HTMLDivElement>;
	filePreviewRef: React.RefObject<FilePreviewHandle>;
	handleFilePreviewClose: () => void;
	handleFilePreviewEditModeChange: (editMode: boolean) => void;
	handleFilePreviewSave: (path: string, content: string) => Promise<boolean | void>;
	handleFilePreviewEditContentChange: (content: string) => void;
	handleFilePreviewScrollPositionChange: (scrollTop: number) => void;
	handleFilePreviewSearchQueryChange: (searchQuery: string) => void;
	handleFilePreviewReload: () => void;
	handleBrowserTabUpdate?: (sessionId: string, tabId: string, updates: Partial<BrowserTab>) => void;
	/** Ref registry for the currently-mounted BrowserTabView — used to extract the active tab's content */
	browserViewRef?: React.MutableRefObject<import('./BrowserTabView').BrowserTabViewHandle | null>;

	// Terminal mounting props
	terminalViewRefs: React.MutableRefObject<
		Map<string, { clearActiveTerminal: () => void; focusActiveTerminal: () => void }>
	>;
	mountedTerminalSessionIds: string[];
	mountedTerminalSessionsRef: React.MutableRefObject<Map<string, Session>>;
	terminalSearchOpen: boolean;
	setTerminalSearchOpen: (open: boolean) => void;
	/** Copy a highlighted terminal selection to the clipboard (right-click menu handler). */
	onTerminalCopySelection?: (text: string) => void;
	/** Send a highlighted terminal selection to another agent (right-click menu handler). */
	onTerminalSendSelectionToAgent?: (tabId: string, text: string) => void;

	// Layout
	isMobileLandscape: boolean;

	// Context warnings
	activeTabContextUsage: number;
	contextWarningsEnabled: boolean;
	contextWarningYellowThreshold: number;
	contextWarningRedThreshold: number;

	// Callbacks
	handleInputFocus: () => void;
	handleSessionClick: (sessionId: string, tabId?: string) => void;

	// Auto mode
	isCurrentSessionAutoMode: boolean;
	currentSessionBatchState?: BatchRunState | null;
	displayBatchRunState?: BatchRunState | null;
	displayBatchRunSessionId?: string;

	// hasCapability function
	hasCapability: (
		cap: keyof import('../../hooks/agent/useAgentCapabilities').AgentCapabilities
	) => boolean;

	// Pass-through props from MainPanelProps
	// (grouped to avoid enumerating every single prop)
	setInputValue: (value: string) => void;
	stagedImages: string[];
	setStagedImages: React.Dispatch<React.SetStateAction<string[]>>;
	setLightboxImage: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	commandHistoryOpen: boolean;
	setCommandHistoryOpen: (open: boolean) => void;
	commandHistoryFilter: string;
	setCommandHistoryFilter: (filter: string) => void;
	commandHistorySelectedIndex: number;
	setCommandHistorySelectedIndex: (index: number) => void;
	slashCommandOpen: boolean;
	setSlashCommandOpen: (open: boolean) => void;
	slashCommands: SlashCommand[];
	selectedSlashCommandIndex: number;
	setSelectedSlashCommandIndex: (index: number) => void;
	tabCompletionOpen?: boolean;
	setTabCompletionOpen?: (open: boolean) => void;
	tabCompletionSuggestions?: TabCompletionSuggestion[];
	selectedTabCompletionIndex?: number;
	setSelectedTabCompletionIndex?: (index: number) => void;
	tabCompletionFilter?: TabCompletionFilter;
	setTabCompletionFilter?: (filter: import('../../hooks').TabCompletionFilter) => void;
	atMentionOpen?: boolean;
	setAtMentionOpen?: (open: boolean) => void;
	atMentionFilter?: string;
	setAtMentionFilter?: (filter: string) => void;
	atMentionStartIndex?: number;
	setAtMentionStartIndex?: (index: number) => void;
	atMentionSuggestions?: Array<{
		value: string;
		type: 'file' | 'folder';
		displayText: string;
		fullPath: string;
	}>;
	selectedAtMentionIndex?: number;
	setSelectedAtMentionIndex?: (index: number) => void;
	inputRef: React.RefObject<HTMLTextAreaElement>;
	logsEndRef: React.RefObject<HTMLDivElement>;
	terminalOutputRef: React.RefObject<HTMLDivElement>;
	toggleInputMode: () => void;
	processInput: () => void;
	handleInterrupt: () => void;
	handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	handleDrop: (e: React.DragEvent<HTMLElement>) => void;
	thinkingItems: ThinkingItem[];
	onStopBatchRun?: (sessionId?: string) => void;
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
	showFlashNotification?: (message: string) => void;

	// Summarization progress props
	summarizeProgress?: SummarizeProgress | null;
	summarizeResult?: SummarizeResult | null;
	summarizeStartTime?: number;
	isSummarizing?: boolean;
	onCancelSummarize?: () => void;
	onSummarizeAndContinue?: (tabId: string) => void;

	// Merge progress props
	mergeProgress?: GroomingProgress | null;
	mergeResult?: MergeResult | null;
	mergeStartTime?: number;
	isMerging?: boolean;
	mergeSourceName?: string;
	mergeTargetName?: string;
	onCancelMerge?: () => void;

	// Inline wizard exit handler
	onExitWizard?: () => void;

	// Props forwarded to child components (from MainPanelProps)
	onDeleteLog?: (logId: string) => number | null;
	onScrollPositionChange?: (scrollTop: number) => void;
	onAtBottomChange?: (isAtBottom: boolean) => void;
	onInputBlur?: () => void;
	onOpenPromptComposer?: () => void;
	onReplayMessage?: (text: string, images?: string[]) => void;
	onForkConversation?: (logId: string) => void;
	onSessionRecover?: (opts: {
		sessionId: string;
		tabId: string;
		lastUserPrompt: string;
		groomContext: boolean;
	}) => void;
	isRecoveringSession?: boolean;
	sessionRecoveryError?: string | null;
	fileTree?: FileNode[];
	onFileClick?: (relativePath: string, options?: { openInNewTab?: boolean }) => void;
	refreshFileTree?: (
		sessionId: string
	) => Promise<import('../../utils/fileExplorer').FileTreeChanges | undefined>;
	onOpenSavedFileInTab?: (file: {
		path: string;
		name: string;
		content: string;
		sshRemoteId?: string;
	}) => void;
	onShowAgentErrorModal?: (error?: import('../../types').AgentError) => void;
	canGoBack?: boolean;
	canGoForward?: boolean;
	onNavigateBack?: () => void;
	onNavigateForward?: () => void;
	backHistory?: { name: string; path: string; scrollTop?: number }[];
	forwardHistory?: { name: string; path: string; scrollTop?: number }[];
	currentHistoryIndex?: number;
	onNavigateToIndex?: (index: number) => void;
	onOpenFuzzySearch?: () => void;
	onShortcutUsed?: (shortcutId: string) => void;
	ghCliAvailable?: boolean;
	onPublishGist?: () => void;
	hasGist?: boolean;
	onOpenInGraph?: () => void;
	/** Open the currently previewed file in a new Maestro browser tab. */
	onOpenInBrowser?: () => void;
	onPublishMessageGist?: (text: string, messageId?: string) => void;
	onToggleTabReadOnlyMode?: () => void;
	onToggleTabSaveToHistory?: () => void;
	onToggleTabShowThinking?: () => void;
	onToggleTabEnterToSend?: () => void;

	// Wizard callbacks
	onWizardComplete?: () => void;
	onWizardCompleteAndStartAutoRun?: () => void;
	onWizardDocumentSelect?: (index: number) => void;
	onWizardContentChange?: (content: string, docIndex: number) => void;
	onWizardLetsGo?: () => void;
	onWizardRetry?: () => void;
	onWizardClearError?: () => void;
	onToggleWizardShowThinking?: () => void;
	onWizardCancelGeneration?: () => void;

	// Model/Effort quick-change pills
	currentModel?: string;
	currentEffort?: string;
	availableModels?: string[];
	availableEfforts?: string[];
	onModelChange?: (model: string) => void;
	onEffortChange?: (effort: string) => void;
}

export const MainPanelContent = React.memo(function MainPanelContent(props: MainPanelContentProps) {
	const {
		activeSession,
		activeTab,
		theme,
		activeFileTabId,
		activeFileTab,
		activeBrowserTabId,
		memoizedFilePreviewFile,
		filePreviewCwd,
		filePreviewSshRemoteId,
		filePreviewContainerRef,
		filePreviewRef,
		handleFilePreviewClose,
		handleFilePreviewEditModeChange,
		handleFilePreviewSave,
		handleFilePreviewEditContentChange,
		handleFilePreviewScrollPositionChange,
		handleFilePreviewSearchQueryChange,
		handleFilePreviewReload,
		handleBrowserTabUpdate,
		browserViewRef,
		terminalViewRefs,
		mountedTerminalSessionIds,
		mountedTerminalSessionsRef,
		terminalSearchOpen,
		setTerminalSearchOpen,
		onTerminalCopySelection,
		onTerminalSendSelectionToAgent,
		isMobileLandscape,
		activeTabContextUsage,
		contextWarningsEnabled,
		contextWarningYellowThreshold,
		contextWarningRedThreshold,
		handleInputFocus,
		handleSessionClick,
		isCurrentSessionAutoMode,
		currentSessionBatchState,
		displayBatchRunState,
		displayBatchRunSessionId,
		hasCapability,
		setInputValue,
		stagedImages,
		setStagedImages,
		setLightboxImage,
		commandHistoryOpen,
		setCommandHistoryOpen,
		commandHistoryFilter,
		setCommandHistoryFilter,
		commandHistorySelectedIndex,
		setCommandHistorySelectedIndex,
		slashCommandOpen,
		setSlashCommandOpen,
		slashCommands,
		selectedSlashCommandIndex,
		setSelectedSlashCommandIndex,
		tabCompletionOpen,
		setTabCompletionOpen,
		tabCompletionSuggestions,
		selectedTabCompletionIndex,
		setSelectedTabCompletionIndex,
		tabCompletionFilter,
		setTabCompletionFilter,
		atMentionOpen,
		setAtMentionOpen,
		atMentionFilter,
		setAtMentionFilter,
		atMentionStartIndex,
		setAtMentionStartIndex,
		atMentionSuggestions,
		selectedAtMentionIndex,
		setSelectedAtMentionIndex,
		inputRef,
		logsEndRef,
		terminalOutputRef,
		toggleInputMode,
		processInput,
		handleInterrupt,
		handleInputKeyDown,
		handlePaste,
		handleDrop,
		thinkingItems,
		onStopBatchRun,
		onRemoveQueuedItem,
		onTogglePauseQueuedItem,
		onEditQueuedItem,
		onReorderQueuedItem,
		onForceSendQueuedItem,
		forcedParallelEnabled,
		getForceSendContext,
		onOpenQueueBrowser,
		showFlashNotification,
		summarizeProgress,
		summarizeResult,
		summarizeStartTime = 0,
		isSummarizing = false,
		onCancelSummarize,
		onSummarizeAndContinue,
		mergeProgress,
		mergeResult,
		mergeStartTime = 0,
		isMerging = false,
		mergeSourceName,
		mergeTargetName,
		onCancelMerge,
		onExitWizard,
		onDeleteLog,
		onScrollPositionChange,
		onAtBottomChange,
		onInputBlur,
		onOpenPromptComposer,
		onReplayMessage,
		onForkConversation,
		onSessionRecover,
		isRecoveringSession,
		sessionRecoveryError,
		fileTree,
		onFileClick,
		refreshFileTree,
		onOpenSavedFileInTab,
		onShowAgentErrorModal,
		canGoBack,
		canGoForward,
		onNavigateBack,
		onNavigateForward,
		backHistory,
		forwardHistory,
		currentHistoryIndex,
		onNavigateToIndex,
		onOpenFuzzySearch,
		onShortcutUsed,
		ghCliAvailable,
		onPublishGist,
		hasGist,
		onOpenInGraph,
		onOpenInBrowser,
		onPublishMessageGist,
		onToggleTabReadOnlyMode,
		onToggleTabSaveToHistory,
		onToggleTabShowThinking,
		onToggleTabEnterToSend,
		onWizardComplete,
		onWizardCompleteAndStartAutoRun,
		onWizardDocumentSelect,
		onWizardContentChange,
		onWizardLetsGo,
		onWizardRetry,
		onWizardClearError,
		onToggleWizardShowThinking,
		onWizardCancelGeneration,
		// Model/Effort quick-change pills
		currentModel,
		currentEffort,
		availableModels,
		availableEfforts,
		onModelChange,
		onEffortChange,
	} = props;

	// Self-sourced from settingsStore
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	const defaultShell = useSettingsStore((s) => s.defaultShell);
	const fontSize = useSettingsStore((s) => s.fontSize);
	const enterToSendAI = useSettingsStore((s) => s.enterToSendAI);
	const chatRawTextMode = useSettingsStore((s) => s.chatRawTextMode);
	const userMessageAlignment = useSettingsStore((s) => s.userMessageAlignment);
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const maxOutputLines = useSettingsStore((s) => s.maxOutputLines);
	// Self-sourced from uiStore
	const activeFocus = useUIStore((s) => s.activeFocus);
	// Output ("Find") search is scoped per agent+AI-tab. Read this window's slot
	// by its key so the Find bar doesn't follow the user to other agents/tabs.
	const outputSearchKey = outputSearchKeyFor(activeSession.id, activeSession.activeTabId);
	const outputSearchSlot = useUIStore((s) => s.outputSearchByKey?.[outputSearchKey]);
	const outputSearchOpen = outputSearchSlot?.open ?? false;
	const outputSearchQuery = outputSearchSlot?.query ?? '';
	const outputSearchRegex = outputSearchSlot?.regex ?? false;
	const setOutputSearchOpen = React.useCallback(
		(v: boolean | ((prev: boolean) => boolean)) =>
			useUIStore.getState().setOutputSearchOpen(outputSearchKey, v),
		[outputSearchKey]
	);
	const setOutputSearchQuery = React.useCallback(
		(v: string | ((prev: string) => string)) =>
			useUIStore.getState().setOutputSearchQuery(outputSearchKey, v),
		[outputSearchKey]
	);
	const setOutputSearchRegex = React.useCallback(
		(v: boolean | ((prev: boolean) => boolean)) =>
			useUIStore.getState().setOutputSearchRegex(outputSearchKey, v),
		[outputSearchKey]
	);

	// Browser tab keep-alive: which of this agent's browser tabs stay mounted.
	// Under the default 'off' policy this is just the active browser tab (mount-only-active,
	// original behavior); 'recent'/'all' keep extra webviews mounted but hidden so their
	// page state survives switching away. All mounted tabs render through the persistent
	// overlay block below (mirroring the terminal keep-alive overlay).
	const mountedBrowserTabIds = useBrowserTabMounting(activeSession);
	// Number of open modal/overlay layers. When any layer is open over a browser
	// tab (e.g. the Tab Switcher), the guest <webview> must release Chromium input
	// focus so keyboard navigation lands in the modal instead of the page. Driving
	// isActive off this re-blurs the webview the moment a layer opens.
	const { layerCount } = useLayerStack();
	// Per-tab BrowserTabView handles. The single browserViewRef passed from MainPanel must
	// point at the active (visible) tab's handle so resolveBrowserContent reads that webview.
	const browserViewRefs = React.useRef<Map<string, BrowserTabViewHandle>>(new Map());
	React.useEffect(() => {
		if (!browserViewRef) return;
		const activeId = activeSession.activeBrowserTabId;
		browserViewRef.current =
			activeSession.inputMode === 'ai' && activeId
				? (browserViewRefs.current.get(activeId) ?? null)
				: null;
	}, [
		browserViewRef,
		activeSession.inputMode,
		activeSession.activeBrowserTabId,
		mountedBrowserTabIds,
	]);

	return (
		/* Content area: Show FilePreview when file tab is active, otherwise show terminal output */
		/* Content wrapper: always-rendered relative container so terminal overlay covers
		     only the content area. Terminal sessions are mounted here regardless of whether
		     file preview, AI output, or terminal is active. */
		<div className="flex-1 min-h-0 overflow-hidden relative flex flex-col">
			{/* Browser tabs render through the persistent keep-alive overlay block below (not
			    inline) so their <webview> never remounts when switching tabs. Skip rendering
			    inline content when loading a remote file - loading state takes over the area. */}
			{activeSession.inputMode === 'ai' && activeFileTab?.isLoading ? (
				<div
					className="flex-1 flex items-center justify-center"
					style={{ backgroundColor: theme.colors.bgMain }}
				>
					<div className="flex flex-col items-center gap-3">
						<Spinner size={32} color={theme.colors.accent} />
						<div className="text-center">
							<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Loading {activeFileTab.name}
								{activeFileTab.extension}
							</div>
							<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
								Fetching from remote server...
							</div>
						</div>
					</div>
				</div>
			) : activeSession.inputMode === 'ai' &&
			  activeFileTabId &&
			  activeFileTab &&
			  memoizedFilePreviewFile ? (
				// New file tab system - FilePreview rendered as tab content (no close button, tab handles closing)
				// Note: All props are memoized to prevent unnecessary re-renders that cause image flickering
				<div
					ref={filePreviewContainerRef}
					tabIndex={-1}
					className="flex-1 overflow-hidden outline-none"
				>
					<React.Suspense fallback={null}>
						<FilePreview
							ref={filePreviewRef}
							file={memoizedFilePreviewFile}
							onClose={handleFilePreviewClose}
							isTabMode={true}
							theme={theme}
							markdownEditMode={activeFileTab.editMode}
							setMarkdownEditMode={handleFilePreviewEditModeChange}
							onSave={handleFilePreviewSave}
							shortcuts={shortcuts}
							fileTree={fileTree}
							cwd={filePreviewCwd}
							onFileClick={onFileClick}
							// Per-tab navigation history for breadcrumb navigation
							canGoBack={canGoBack}
							canGoForward={canGoForward}
							onNavigateBack={onNavigateBack}
							onNavigateForward={onNavigateForward}
							backHistory={backHistory}
							forwardHistory={forwardHistory}
							currentHistoryIndex={currentHistoryIndex}
							onNavigateToIndex={onNavigateToIndex}
							onOpenFuzzySearch={onOpenFuzzySearch}
							onShortcutUsed={onShortcutUsed}
							ghCliAvailable={ghCliAvailable}
							onPublishGist={onPublishGist}
							hasGist={hasGist}
							onOpenInGraph={onOpenInGraph}
							onOpenInBrowser={onOpenInBrowser}
							sshRemoteId={filePreviewSshRemoteId}
							// Pass external edit content for persistence across tab switches
							externalEditContent={activeFileTab.editContent}
							onEditContentChange={handleFilePreviewEditContentChange}
							// Pass scroll position props for persistence across tab switches
							initialScrollTop={activeFileTab.scrollTop}
							onScrollPositionChange={handleFilePreviewScrollPositionChange}
							// Pass search query props for persistence across tab switches
							initialSearchQuery={activeFileTab.searchQuery}
							onSearchQueryChange={handleFilePreviewSearchQueryChange}
							// File change detection
							lastModified={activeFileTab.lastModified}
							onReloadFile={handleFilePreviewReload}
							// Phase 2: per-tab preview tier override.
							previewTierOverride={activeFileTab.previewTierOverride}
							onPreviewTierChange={(tier) =>
								useTabStore.getState().setFileTabPreviewTier(activeFileTabId, tier)
							}
							// HTML render mode (per-tab, persists across tab switches).
							htmlRenderMode={activeFileTab.htmlRenderMode}
							onHtmlRenderModeChange={(value) =>
								useTabStore.getState().setFileTabHtmlRenderMode(activeFileTabId, value)
							}
							// Transient deep-link scroll target. FilePreview clears this
							// via onPendingScrollToLineConsumed once the editor has
							// jumped, so subsequent re-renders don't re-scroll.
							pendingScrollToLine={activeFileTab.pendingScrollToLine}
							onPendingScrollToLineConsumed={() =>
								useTabStore.getState().clearFileTabPendingScrollToLine(activeFileTabId)
							}
						/>
					</React.Suspense>
				</div>
			) : (
				<>
					{/* Logs Area - Show DocumentGenerationView while generating OR when docs exist (waiting for user to click Exit Wizard), WizardConversationView when wizard is active, otherwise show TerminalOutput */}
					{/* Note: wizardState is per-tab (stored on activeTab), not per-session */}
					{/* User clicks "Exit Wizard" button in DocumentGenerationView which calls onWizardComplete to convert tab to normal session */}
					<div className="flex-1 overflow-hidden flex flex-col relative" data-tour="main-terminal">
						{activeSession.inputMode === 'ai' &&
						(activeTab?.wizardState?.isGeneratingDocs ||
							(activeTab?.wizardState?.generatedDocuments?.length ?? 0) > 0) ? (
							<DocumentGenerationView
								key={`wizard-gen-${activeSession.id}-${activeSession.activeTabId}`}
								theme={theme}
								documents={activeTab?.wizardState?.generatedDocuments ?? []}
								currentDocumentIndex={activeTab?.wizardState?.currentDocumentIndex ?? 0}
								isGenerating={activeTab?.wizardState?.isGeneratingDocs ?? false}
								streamingContent={activeTab?.wizardState?.streamingContent}
								onComplete={onWizardComplete || (() => {})}
								onCompleteAndStartAutoRun={onWizardCompleteAndStartAutoRun}
								onDocumentSelect={onWizardDocumentSelect || (() => {})}
								folderPath={
									activeTab?.wizardState?.subfolderPath ?? activeTab?.wizardState?.autoRunFolderPath
								}
								onContentChange={onWizardContentChange}
								progressMessage={activeTab?.wizardState?.progressMessage}
								currentGeneratingIndex={activeTab?.wizardState?.currentGeneratingIndex}
								totalDocuments={activeTab?.wizardState?.totalDocuments}
								onCancel={onWizardCancelGeneration}
								subfolderName={activeTab?.wizardState?.subfolderName}
								startedAt={activeTab?.wizardState?.docGenerationStartedAt}
							/>
						) : activeSession.inputMode === 'ai' && activeTab?.wizardState?.isActive ? (
							<WizardConversationView
								key={`wizard-${activeSession.id}-${activeSession.activeTabId}`}
								theme={theme}
								conversationHistory={activeTab.wizardState.conversationHistory}
								isLoading={activeTab.wizardState.isWaiting ?? false}
								agentName={activeSession.name}
								confidence={activeTab.wizardState.confidence}
								ready={activeTab.wizardState.ready}
								onLetsGo={onWizardLetsGo}
								error={activeTab.wizardState.error}
								onRetry={onWizardRetry}
								onClearError={onWizardClearError}
								showThinking={activeTab.wizardState.showWizardThinking ?? false}
								thinkingContent={activeTab.wizardState.thinkingContent ?? ''}
								toolExecutions={activeTab.wizardState.toolExecutions ?? []}
								hasStartedGenerating={
									activeTab.wizardState.isGeneratingDocs ||
									(activeTab.wizardState.generatedDocuments?.length ?? 0) > 0
								}
								setLightboxImage={setLightboxImage}
							/>
						) : (
							<TerminalOutput
								key={`${activeSession.id}-${activeSession.activeTabId}`}
								ref={terminalOutputRef}
								session={activeSession}
								theme={theme}
								fontFamily={fontFamily}
								activeFocus={activeFocus}
								outputSearchOpen={outputSearchOpen}
								outputSearchQuery={outputSearchQuery}
								outputSearchRegex={outputSearchRegex}
								setOutputSearchOpen={setOutputSearchOpen}
								setOutputSearchQuery={setOutputSearchQuery}
								setOutputSearchRegex={setOutputSearchRegex}
								setActiveFocus={useUIStore.getState().setActiveFocus}
								setLightboxImage={setLightboxImage}
								inputRef={inputRef}
								logsEndRef={logsEndRef}
								maxOutputLines={maxOutputLines}
								onDeleteLog={onDeleteLog}
								onRemoveQueuedItem={onRemoveQueuedItem}
								onTogglePauseQueuedItem={onTogglePauseQueuedItem}
								onEditQueuedItem={onEditQueuedItem}
								onReorderQueuedItem={onReorderQueuedItem}
								onForceSendQueuedItem={onForceSendQueuedItem}
								forcedParallelEnabled={forcedParallelEnabled}
								getForceSendContext={getForceSendContext}
								onInterrupt={handleInterrupt}
								onScrollPositionChange={onScrollPositionChange}
								onAtBottomChange={onAtBottomChange}
								initialScrollTop={activeTab?.scrollTop}
								markdownEditMode={chatRawTextMode}
								setMarkdownEditMode={useSettingsStore.getState().setChatRawTextMode}
								onReplayMessage={onReplayMessage}
								onForkConversation={onForkConversation}
								onSessionRecover={onSessionRecover}
								isRecoveringSession={isRecoveringSession}
								sessionRecoveryError={sessionRecoveryError}
								fileTree={fileTree}
								cwd={
									activeSession.cwd?.startsWith(activeSession.fullPath)
										? activeSession.cwd.slice(activeSession.fullPath.length + 1)
										: ''
								}
								projectRoot={activeSession.fullPath}
								onFileClick={onFileClick}
								onShowErrorDetails={onShowAgentErrorModal}
								onFileSaved={
									refreshFileTree ? () => refreshFileTree?.(activeSession.id) : undefined
								}
								userMessageAlignment={userMessageAlignment}
								onOpenInTab={onOpenSavedFileInTab}
								ghCliAvailable={ghCliAvailable}
								onPublishMessageGist={onPublishMessageGist}
							/>
						)}
					</div>

					{/* Agent Resilience: the live auto-retry status now renders inline in
					    the transcript as a collapsed RetryStatusCard (see TerminalOutput),
					    so no separate countdown banner sits above the composer. */}

					{/* Input Area (hidden in mobile landscape, during wizard doc generation, and in terminal mode — xterm.js handles its own input) */}
					{!isMobileLandscape &&
						!activeTab?.wizardState?.isGeneratingDocs &&
						!activeBrowserTabId &&
						activeSession.inputMode !== 'terminal' && (
							<div data-tour="input-area">
								<InputArea
									session={activeSession}
									theme={theme}
									setInputValue={setInputValue}
									enterToSend={activeTab?.enterToSend ?? enterToSendAI}
									setEnterToSend={
										onToggleTabEnterToSend
											? () => onToggleTabEnterToSend()
											: useSettingsStore.getState().setEnterToSendAI
									}
									stagedImages={stagedImages}
									setStagedImages={setStagedImages}
									setLightboxImage={setLightboxImage}
									commandHistoryOpen={commandHistoryOpen}
									setCommandHistoryOpen={setCommandHistoryOpen}
									commandHistoryFilter={commandHistoryFilter}
									setCommandHistoryFilter={setCommandHistoryFilter}
									commandHistorySelectedIndex={commandHistorySelectedIndex}
									setCommandHistorySelectedIndex={setCommandHistorySelectedIndex}
									slashCommandOpen={slashCommandOpen}
									setSlashCommandOpen={setSlashCommandOpen}
									slashCommands={slashCommands}
									selectedSlashCommandIndex={selectedSlashCommandIndex}
									setSelectedSlashCommandIndex={setSelectedSlashCommandIndex}
									tabCompletionOpen={tabCompletionOpen}
									setTabCompletionOpen={setTabCompletionOpen}
									tabCompletionSuggestions={tabCompletionSuggestions}
									selectedTabCompletionIndex={selectedTabCompletionIndex}
									setSelectedTabCompletionIndex={setSelectedTabCompletionIndex}
									tabCompletionFilter={tabCompletionFilter}
									setTabCompletionFilter={setTabCompletionFilter}
									atMentionOpen={atMentionOpen}
									setAtMentionOpen={setAtMentionOpen}
									atMentionFilter={atMentionFilter}
									setAtMentionFilter={setAtMentionFilter}
									atMentionStartIndex={atMentionStartIndex}
									setAtMentionStartIndex={setAtMentionStartIndex}
									atMentionSuggestions={atMentionSuggestions}
									selectedAtMentionIndex={selectedAtMentionIndex}
									setSelectedAtMentionIndex={setSelectedAtMentionIndex}
									inputRef={inputRef}
									handleInputKeyDown={handleInputKeyDown}
									handlePaste={handlePaste}
									handleDrop={handleDrop}
									toggleInputMode={toggleInputMode}
									processInput={processInput}
									handleInterrupt={handleInterrupt}
									onInputFocus={handleInputFocus}
									onInputBlur={onInputBlur}
									isAutoModeActive={isCurrentSessionAutoMode}
									thinkingItems={thinkingItems}
									onSessionClick={handleSessionClick}
									autoRunState={displayBatchRunState || undefined}
									onStopAutoRun={() =>
										onStopBatchRun?.(displayBatchRunSessionId ?? activeSession.id)
									}
									onOpenQueueBrowser={onOpenQueueBrowser}
									tabReadOnlyMode={activeTab?.readOnlyMode ?? false}
									onToggleTabReadOnlyMode={onToggleTabReadOnlyMode}
									tabSaveToHistory={activeTab?.saveToHistory ?? false}
									onToggleTabSaveToHistory={onToggleTabSaveToHistory}
									tabShowThinking={activeTab?.showThinking ?? 'off'}
									onToggleTabShowThinking={onToggleTabShowThinking}
									supportsThinking={hasCapability('supportsThinkingDisplay')}
									onOpenPromptComposer={onOpenPromptComposer}
									shortcuts={shortcuts}
									showFlashNotification={showFlashNotification}
									// Context warning sash props (Phase 6) - use tab-level context usage
									contextUsage={activeTabContextUsage}
									contextWarningsEnabled={contextWarningsEnabled}
									contextWarningYellowThreshold={contextWarningYellowThreshold}
									contextWarningRedThreshold={contextWarningRedThreshold}
									onSummarizeAndContinue={
										onSummarizeAndContinue
											? () => onSummarizeAndContinue(activeSession.activeTabId)
											: undefined
									}
									// Summarization progress props
									summarizeProgress={summarizeProgress}
									summarizeResult={summarizeResult}
									summarizeStartTime={summarizeStartTime}
									isSummarizing={isSummarizing}
									onCancelSummarize={onCancelSummarize}
									// Merge progress props
									mergeProgress={mergeProgress}
									mergeResult={mergeResult}
									mergeStartTime={mergeStartTime}
									isMerging={isMerging}
									mergeSourceName={mergeSourceName}
									mergeTargetName={mergeTargetName}
									onCancelMerge={onCancelMerge}
									// Inline wizard mode
									onExitWizard={onExitWizard}
									wizardShowThinking={activeTab?.wizardState?.showWizardThinking ?? false}
									onToggleWizardShowThinking={onToggleWizardShowThinking}
									// Model/Effort quick-change pills
									currentModel={currentModel}
									currentEffort={currentEffort}
									availableModels={availableModels}
									availableEfforts={availableEfforts}
									onModelChange={onModelChange}
									onEffortChange={onEffortChange}
								/>
							</div>
						)}
				</>
			)}
			{/* TerminalView is kept alive for every session that has terminal tabs so that
		     switching between sessions (or to AI mode) does not destroy the xterm.js
		     scrollback buffer. visibility:hidden (not display:none) keeps the canvas
		     at non-zero dimensions so the WebGL context is never lost or cleared. */}
			{mountedTerminalSessionIds.map((sessionId) => {
				const isCurrentSession = sessionId === activeSession.id;
				const session = isCurrentSession
					? activeSession
					: mountedTerminalSessionsRef.current.get(sessionId);
				if (!session) return null;
				const isTerminalVisible = isCurrentSession && session.inputMode === 'terminal';
				return (
					<div
						key={sessionId}
						className={`absolute inset-0 flex flex-col${isTerminalVisible ? '' : ' terminal-hidden'}`}
						style={{
							visibility: isTerminalVisible ? 'visible' : 'hidden',
							pointerEvents: isTerminalVisible ? 'auto' : 'none',
							zIndex: isTerminalVisible ? 1 : -1,
						}}
					>
						<TerminalView
							ref={(handle) => {
								if (handle) terminalViewRefs.current.set(sessionId, handle);
								else terminalViewRefs.current.delete(sessionId);
							}}
							session={session}
							theme={theme}
							fontFamily={fontFamily}
							fontSize={Math.round(fontSize * 0.85)}
							defaultShell={defaultShell}
							onTabStateChange={createTabStateChangeHandler(sessionId)}
							onTabPidChange={createTabPidChangeHandler(sessionId)}
							searchOpen={isCurrentSession ? terminalSearchOpen : false}
							onSearchClose={isCurrentSession ? () => setTerminalSearchOpen(false) : undefined}
							isVisible={isTerminalVisible}
							onCopySelection={onTerminalCopySelection}
							onSendSelectionToAgent={onTerminalSendSelectionToAgent}
						/>
					</div>
				);
			})}
			{/* Browser tabs are kept alive as persistent overlays so their <webview> guest
			    contents survive switching tabs. Which tabs stay mounted is decided by
			    useBrowserTabMounting (the browserTabKeepAlive setting); under 'off' only the
			    active tab is mounted, reproducing the original unload-on-switch behavior.
			    visibility:hidden (not unmount) preserves the guest's JS heap and DOM. */}
			{mountedBrowserTabIds.map((tabId) => {
				const browserTab = activeSession.browserTabs?.find((t) => t.id === tabId);
				if (!browserTab) return null;
				const isBrowserVisible =
					activeSession.inputMode === 'ai' && activeSession.activeBrowserTabId === tabId;
				// Hold keyboard focus only when no modal/overlay is layered above the
				// page. The tab stays visually rendered (visibility/zIndex below are
				// driven by isBrowserVisible), but the webview yields input focus to an
				// open layer so its keyboard navigation works (e.g. the Tab Switcher).
				const isBrowserFocusActive = isBrowserVisible && layerCount === 0;
				return (
					<div
						key={tabId}
						className="absolute inset-0 flex flex-col"
						style={{
							visibility: isBrowserVisible ? 'visible' : 'hidden',
							pointerEvents: isBrowserVisible ? 'auto' : 'none',
							zIndex: isBrowserVisible ? 2 : -1,
						}}
					>
						<BrowserTabView
							ref={(handle) => {
								if (handle) browserViewRefs.current.set(tabId, handle);
								else browserViewRefs.current.delete(tabId);
							}}
							tab={browserTab}
							theme={theme}
							isActive={isBrowserFocusActive}
							onUpdateTab={(tid, updates) =>
								handleBrowserTabUpdate?.(activeSession.id, tid, updates)
							}
						/>
					</div>
				);
			})}
		</div>
	);
});
