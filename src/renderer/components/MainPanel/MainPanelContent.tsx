import React from 'react';
import { Loader2 } from 'lucide-react';
import { TerminalOutput } from '../TerminalOutput';
import {
	TerminalView,
	createTabStateChangeHandler,
	createTabPidChangeHandler,
} from '../TerminalView';
import { InputArea } from '../InputArea';
import { FilePreview, type FilePreviewHandle } from '../FilePreview';
import { WizardConversationView, DocumentGenerationView } from '../InlineWizard';
import { BrowserTabView } from './BrowserTabView';
import { useUIStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type {
	Session,
	Theme,
	AITab,
	BatchRunState,
	BrowserTab,
	FilePreviewTab,
	ThinkingItem,
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

export interface MainPanelContentProps {
	// Core state (guaranteed by parent guard)
	activeSession: Session;
	activeTab: AITab | null;
	theme: Theme;

	// File preview props (from useFilePreviewHandlers)
	filePreviewLoading?: { name: string; path: string } | null;
	activeFileTabId?: string | null;
	activeFileTab?: FilePreviewTab | null;
	activeBrowserTabId?: string | null;
	activeBrowserTab?: BrowserTab | null;
	memoizedFilePreviewFile: { name: string; path: string; content: string } | null;
	filePreviewCwd: string;
	filePreviewSshRemoteId: string | undefined;
	filePreviewContainerRef: React.RefObject<HTMLDivElement>;
	filePreviewRef: React.RefObject<FilePreviewHandle>;
	handleFilePreviewClose: () => void;
	handleFilePreviewEditModeChange: (editMode: boolean) => void;
	handleFilePreviewSave: (path: string, content: string) => Promise<void>;
	handleFilePreviewEditContentChange: (content: string) => void;
	handleFilePreviewScrollPositionChange: (scrollTop: number) => void;
	handleFilePreviewSearchQueryChange: (searchQuery: string) => void;
	handleFilePreviewReload: () => void;
	handleBrowserTabUpdate?: (sessionId: string, tabId: string, updates: Partial<BrowserTab>) => void;

	// Terminal mounting props
	terminalViewRefs: React.MutableRefObject<
		Map<string, { clearActiveTerminal: () => void; focusActiveTerminal: () => void }>
	>;
	mountedTerminalSessionIds: string[];
	mountedTerminalSessionsRef: React.MutableRefObject<Map<string, Session>>;
	terminalSearchOpen: boolean;
	setTerminalSearchOpen: (open: boolean) => void;

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

	// hasCapability function
	hasCapability: (
		cap: keyof import('../../hooks/agent/useAgentCapabilities').AgentCapabilities
	) => boolean;

	// Pass-through props from MainPanelProps
	// (grouped to avoid enumerating every single prop)
	inputValue: string;
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
	onPublishMessageGist?: (text: string) => void;
	onToggleTabReadOnlyMode?: () => void;
	onToggleTabSaveToHistory?: () => void;
	onToggleTabShowThinking?: () => void;

	// Wizard callbacks
	onWizardComplete?: () => void;
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
		filePreviewLoading,
		activeFileTabId,
		activeFileTab,
		activeBrowserTabId,
		activeBrowserTab,
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
		terminalViewRefs,
		mountedTerminalSessionIds,
		mountedTerminalSessionsRef,
		terminalSearchOpen,
		setTerminalSearchOpen,
		isMobileLandscape,
		activeTabContextUsage,
		contextWarningsEnabled,
		contextWarningYellowThreshold,
		contextWarningRedThreshold,
		handleInputFocus,
		handleSessionClick,
		isCurrentSessionAutoMode,
		currentSessionBatchState,
		hasCapability,
		inputValue,
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
		onPublishMessageGist,
		onToggleTabReadOnlyMode,
		onToggleTabSaveToHistory,
		onToggleTabShowThinking,
		onWizardComplete,
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
	const outputSearchOpen = useUIStore((s) => s.outputSearchOpen);
	const outputSearchQuery = useUIStore((s) => s.outputSearchQuery);

	return (
		/* Content area: Show FilePreview when file tab is active, otherwise show terminal output */
		/* Content wrapper: always-rendered relative container so terminal overlay covers
		     only the content area. Terminal sessions are mounted here regardless of whether
		     file preview, AI output, or terminal is active. */
		<div className="flex-1 min-h-0 overflow-hidden relative flex flex-col">
			{/* Skip rendering when loading remote file - loading state takes over entire main area */}
			{activeSession.inputMode === 'ai' && activeBrowserTabId && activeBrowserTab ? (
				<BrowserTabView
					tab={activeBrowserTab}
					theme={theme}
					onUpdateTab={(tabId, updates) =>
						handleBrowserTabUpdate?.(activeSession.id, tabId, updates)
					}
				/>
			) : activeSession.inputMode === 'ai' &&
			  ((filePreviewLoading && !activeFileTabId) || activeFileTab?.isLoading) ? (
				<div
					className="flex-1 flex items-center justify-center"
					style={{ backgroundColor: theme.colors.bgMain }}
				>
					<div className="flex flex-col items-center gap-3">
						<Loader2 className="w-8 h-8 animate-spin" style={{ color: theme.colors.accent }} />
						<div className="text-center">
							<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Loading{' '}
								{activeFileTab
									? `${activeFileTab.name}${activeFileTab.extension}`
									: filePreviewLoading?.name}
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
					/>
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
								setOutputSearchOpen={useUIStore.getState().setOutputSearchOpen}
								setOutputSearchQuery={useUIStore.getState().setOutputSearchQuery}
								setActiveFocus={useUIStore.getState().setActiveFocus}
								setLightboxImage={setLightboxImage}
								inputRef={inputRef}
								logsEndRef={logsEndRef}
								maxOutputLines={maxOutputLines}
								onDeleteLog={onDeleteLog}
								onRemoveQueuedItem={onRemoveQueuedItem}
								onInterrupt={handleInterrupt}
								onScrollPositionChange={onScrollPositionChange}
								onAtBottomChange={onAtBottomChange}
								initialScrollTop={activeTab?.scrollTop}
								markdownEditMode={chatRawTextMode}
								setMarkdownEditMode={useSettingsStore.getState().setChatRawTextMode}
								onReplayMessage={onReplayMessage}
								onForkConversation={onForkConversation}
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

					{/* Input Area (hidden in mobile landscape, during wizard doc generation, and in terminal mode — xterm.js handles its own input) */}
					{!isMobileLandscape &&
						!activeTab?.wizardState?.isGeneratingDocs &&
						!activeBrowserTabId &&
						activeSession.inputMode !== 'terminal' && (
							<div data-tour="input-area">
								<InputArea
									session={activeSession}
									theme={theme}
									inputValue={inputValue}
									setInputValue={setInputValue}
									enterToSend={enterToSendAI}
									setEnterToSend={useSettingsStore.getState().setEnterToSendAI}
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
									autoRunState={currentSessionBatchState || undefined}
									onStopAutoRun={() => onStopBatchRun?.(activeSession.id)}
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
						/>
					</div>
				);
			})}
		</div>
	);
});
