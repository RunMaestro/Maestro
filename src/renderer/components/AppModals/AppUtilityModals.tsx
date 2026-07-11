import { lazy, Suspense, memo } from 'react';
import type React from 'react';
import type {
	Theme,
	Session,
	Group,
	GroupChat,
	Shortcut,
	RightPanelTab,
	SettingsTab,
	BatchRunConfig,
	ThinkingMode,
} from '../../types';
import type { FileNode } from '../../types/fileTree';
import type { MainPanelHandle } from '../MainPanel/types';
import type { WizardStep } from '../Wizard/WizardContext';
import type { FlatFileItem } from '../FileSearchModal';

// Modal store (for reading per-modal data passed by callers)
import { useModalStore, selectModalData } from '../../stores/modalStore';

// Utility Modal Components
import { QuickActionsModal } from '../QuickActionsModal';
import { TabSwitcherModal } from '../TabSwitcherModal';
import { FileSearchModal } from '../FileSearchModal';
import { PromptComposerModal } from '../PromptComposerModal';
import { ExecutionQueueBrowser } from '../ExecutionQueueBrowser';
import { BatchRunnerModal } from '../BatchRunnerModal';
import { AutoRunSetupModal } from '../AutoRun/AutoRunSetupModal';
import { LightboxModal } from '../LightboxModal';

// Lazy-loaded heavy modals (rarely used, loaded on-demand)
const GitDiffViewer = lazy(() =>
	import('../GitDiffViewer').then((m) => ({ default: m.GitDiffViewer }))
);
const GitLogViewer = lazy(() =>
	import('../GitLogViewer').then((m) => ({ default: m.GitLogViewer }))
);

/**
 * Props for the AppUtilityModals component
 *
 * NOTE: This is a large props interface because it wraps 10 different modals,
 * each with their own prop requirements. The complexity is intentional to
 * consolidate all utility modals in one place.
 */
export interface AppUtilityModalsProps {
	theme: Theme;
	sessions: Session[];
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	activeSessionId: string;
	activeSession: Session | null;
	groups: Group[];
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	shortcuts: Record<string, Shortcut>;
	tabShortcuts: Record<string, Shortcut>;

	// QuickActionsModal
	quickActionOpen: boolean;
	quickActionInitialMode: 'main' | 'move-to-group' | 'agents';
	setQuickActionOpen: (open: boolean) => void;
	setActiveSessionId: (id: string) => void;
	addNewSession: () => void;
	setRenameInstanceValue: (value: string) => void;
	setRenameInstanceModalOpen: (open: boolean) => void;
	setRenameGroupId: (id: string) => void;
	setRenameGroupValue: (value: string) => void;
	setRenameGroupEmoji: (emoji: string) => void;
	setRenameGroupIcon: (icon: string | undefined) => void;
	setRenameGroupColor: (color: string | undefined) => void;
	setRenameGroupModalOpen: (open: boolean) => void;
	setCreateGroupModalOpen: (open: boolean) => void;
	setLeftSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	toggleInputMode: () => void;
	deleteSession: (id: string) => void;
	setSettingsModalOpen: (open: boolean) => void;
	setSettingsTab: (tab: SettingsTab) => void;
	setShortcutsHelpOpen: (open: boolean) => void;
	setAboutModalOpen: (open: boolean) => void;
	setFeedbackModalOpen: (open: boolean) => void;
	setLogViewerOpen: (open: boolean) => void;
	setProcessMonitorOpen: (open: boolean) => void;
	setUsageDashboardOpen?: (open: boolean) => void;
	setAgentRunDashboardOpen?: (open: boolean) => void;
	setActiveRightTab: (tab: RightPanelTab) => void;
	setAgentSessionsOpen: (open: boolean) => void;
	setMemoryViewerOpen?: (open: boolean) => void;
	setActiveAgentSessionId: (id: string | null) => void;
	setGitDiffPreview: (diff: string | null) => void;
	setGitLogOpen: (open: boolean) => void;
	isAiMode: boolean;
	onRenameTab: () => void;
	onToggleReadOnlyMode: () => void;
	onToggleTabShowThinking: () => void;
	onToggleTabEnterToSend: () => void;
	onOpenTabSwitcher: () => void;
	// Bulk tab close operations
	onCloseAllTabs?: () => void;
	onCloseOtherTabs?: (pivotTabId?: string) => void;
	onCloseTabsLeft?: (pivotTabId?: string) => void;
	onCloseTabsRight?: (pivotTabId?: string) => void;
	setPlaygroundOpen?: (open: boolean) => void;
	onRefreshGitFileState: () => Promise<void>;
	onDebugReleaseQueuedItem: () => void;
	markdownEditMode: boolean;
	onToggleMarkdownEditMode: () => void;
	setUpdateCheckModalOpen?: (open: boolean) => void;
	openWizard: () => void;
	wizardGoToStep: (step: WizardStep) => void;
	setDebugPackageModalOpen?: (open: boolean) => void;
	setDebugApplicationStatsOpen?: (open: boolean) => void;
	startTour: () => void;
	setFuzzyFileSearchOpen: (open: boolean) => void;
	onEditAgent: (session: Session) => void;
	groupChats: GroupChat[];
	onNewGroupChat: () => void;
	onOpenGroupChat: (id: string) => void;
	onCloseGroupChat: () => void;
	onDeleteGroupChat: (id: string) => void;
	activeGroupChatId: string | null;
	hasActiveSessionCapability: (
		capability:
			| 'supportsSessionStorage'
			| 'supportsSlashCommands'
			| 'supportsContextMerge'
			| 'supportsThinkingDisplay'
			| 'supportsProjectMemory'
	) => boolean;
	onOpenMergeSession: () => void;
	onOpenSendToAgent: () => void;
	onQuickCreateWorktree: (session: Session) => void;
	onOpenCreatePR: (session: Session) => void;
	onSummarizeAndContinue: () => void;
	/** Send a plugin command-macro's templated prompt to the active agent. */
	onRunPromptMacro?: (prompt: string) => void;
	canSummarizeActiveTab: boolean;
	onToggleRemoteControl: () => Promise<void>;
	autoRunSelectedDocument: string | null;
	autoRunCompletedTaskCount: number;
	onAutoRunResetTasks: () => void;
	onToggleAutoRunExpanded?: () => void;
	onClearActiveTerminal?: () => void;

	// Tab-level actions (for QuickActionsModal)
	onCloseCurrentTab?: () => void;
	onMoveTabToFirst?: () => void;
	onMoveTabToLast?: () => void;
	onFocusActiveTab?: () => void;
	onCopyTabContext?: (tabId: string) => void;
	onExportTabHtml?: (tabId: string) => void;
	onPublishTabGist?: (tabId: string) => void;
	mainPanelRef?: React.RefObject<MainPanelHandle | null>;

	// Gist publishing (for QuickActionsModal)
	isFilePreviewOpen: boolean;
	ghCliAvailable: boolean;
	onPublishGist?: () => void;

	// Document Graph - quick re-open last graph
	lastGraphFocusFile?: string;
	onOpenLastDocumentGraph?: () => void;
	// Document Graph - view the active markdown file
	currentGraphFile?: string;
	onOpenCurrentFileInGraph?: () => void;

	// Symphony
	onOpenSymphony?: () => void;

	// Director's Notes
	onOpenDirectorNotes?: () => void;

	// Maestro Cue
	onOpenMaestroCue?: () => void;
	// Board (task DAG kanban; depends on Maestro Cue)
	onOpenBoard?: () => void;
	// Pianola
	onOpenPianola?: () => void;
	onConfigureCue?: (session: Session) => void;

	// LightboxModal
	lightboxImage: string | null;
	lightboxImages: string[];
	stagedImages: string[];
	onCloseLightbox: () => void;
	onNavigateLightbox: (img: string) => void;
	onDeleteLightboxImage?: (img: string) => void;
	onUpdateLightboxImage?: (oldImg: string, newDataUrl: string) => void;

	// GitDiffViewer
	gitDiffPreview: string | null;
	gitViewerCwd: string;
	onCloseGitDiff: () => void;

	// GitLogViewer
	gitLogOpen: boolean;
	onCloseGitLog: () => void;

	// Shared by both git viewers: open a clicked file path as a preview tab.
	onOpenGitFile?: (absolutePath: string, fileName: string) => void;

	// AutoRunSetupModal
	autoRunSetupModalOpen: boolean;
	onCloseAutoRunSetup: () => void;
	onAutoRunFolderSelected: (folderPath: string) => void;

	// BatchRunnerModal
	batchRunnerModalOpen: boolean;
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

	// TabSwitcherModal
	tabSwitcherOpen: boolean;
	onCloseTabSwitcher: () => void;
	onTabSelect: (tabId: string) => void;
	onFileTabSelect?: (tabId: string) => void;
	onTerminalTabSelect?: (tabId: string) => void;
	onBrowserTabSelect?: (tabId: string) => void;
	onNamedSessionSelect: (
		agentSessionId: string,
		projectPath: string,
		sessionName: string,
		starred?: boolean
	) => void;
	/** Whether colorblind-friendly colors should be used for extension badges */
	colorBlindMode?: boolean;

	// FileSearchModal
	fuzzyFileSearchOpen: boolean;
	filteredFileTree: FileNode[];
	fileExplorerExpanded?: string[];
	onCloseFileSearch: () => void;
	onFileSearchSelect: (file: FlatFileItem) => void;

	// PromptComposerModal
	promptComposerOpen: boolean;
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
	promptComposerAgentId?: string;
	promptTabShowThinking: ThinkingMode;
	onPromptToggleTabShowThinking?: () => void;
	promptSupportsThinking: boolean;
	promptEnterToSend: boolean;
	onPromptToggleEnterToSend: () => void;

	// ExecutionQueueBrowser
	queueBrowserOpen: boolean;
	onOpenQueueBrowser: () => void;
	onCloseQueueBrowser: () => void;
	onRemoveQueueItem: (sessionId: string, itemId: string) => void;
	onSwitchQueueSession: (sessionId: string, tabId?: string) => void;
	onReorderQueueItems: (sessionId: string, fromIndex: number, toIndex: number) => void;
	onTogglePauseQueueItem: (sessionId: string, itemId: string) => void;
	onEditQueueItem: (
		sessionId: string,
		itemId: string,
		patch: { text: string; images: string[] }
	) => void;
	// New tab creation (for QuickActionsModal)
	onQuickActionsNewTab?: () => void;
	onQuickActionsNewFileTab?: () => void;
	onQuickActionsNewBrowserTab?: () => void;
	onQuickActionsNewTerminalTab?: () => void;
	// Next unread / draft tab navigation (shared with Alt+Cmd+Down)
	onGoToNextUnread?: () => void;
	// Session/tab history navigation (shared with Cmd+Shift+, / Cmd+Shift+.)
	onNavBack?: () => void;
	onNavForward?: () => void;
}

/**
 * AppUtilityModals - Renders utility and workflow modals
 *
 * Contains:
 * - QuickActionsModal: Command palette (Cmd+K)
 * - TabSwitcherModal: Switch between conversation tabs
 * - FileSearchModal: Fuzzy file search
 * - PromptComposerModal: Full-screen prompt editor
 * - ExecutionQueueBrowser: View and manage execution queue
 * - BatchRunnerModal: Configure batch/Auto Run execution
 * - AutoRunSetupModal: Set up Auto Run folder
 * - LightboxModal: Image lightbox/carousel
 * - GitDiffViewer: View git diffs
 * - GitLogViewer: View git log
 */
export const AppUtilityModals = memo(function AppUtilityModals({
	theme,
	sessions,
	setSessions,
	activeSessionId,
	activeSession,
	groups,
	setGroups,
	shortcuts,
	tabShortcuts,
	// QuickActionsModal
	quickActionOpen,
	quickActionInitialMode,
	setQuickActionOpen,
	setActiveSessionId,
	addNewSession,
	setRenameInstanceValue,
	setRenameInstanceModalOpen,
	setRenameGroupId,
	setRenameGroupValue,
	setRenameGroupEmoji,
	setRenameGroupIcon,
	setRenameGroupColor,
	setRenameGroupModalOpen,
	setCreateGroupModalOpen,
	setLeftSidebarOpen,
	setRightPanelOpen,
	toggleInputMode,
	deleteSession,
	setSettingsModalOpen,
	setSettingsTab,
	setShortcutsHelpOpen,
	setAboutModalOpen,
	setFeedbackModalOpen,
	setLogViewerOpen,
	setProcessMonitorOpen,
	setUsageDashboardOpen,
	setAgentRunDashboardOpen,
	setActiveRightTab,
	setAgentSessionsOpen,
	setMemoryViewerOpen,
	setActiveAgentSessionId,
	setGitDiffPreview,
	setGitLogOpen,
	isAiMode,
	onRenameTab,
	onToggleReadOnlyMode,
	onToggleTabShowThinking,
	onToggleTabEnterToSend,
	onOpenTabSwitcher,
	// Bulk tab close operations
	onCloseAllTabs,
	onCloseOtherTabs,
	onCloseTabsLeft,
	onCloseTabsRight,
	setPlaygroundOpen,
	onRefreshGitFileState,
	onDebugReleaseQueuedItem,
	markdownEditMode,
	onToggleMarkdownEditMode,
	setUpdateCheckModalOpen,
	openWizard,
	wizardGoToStep,
	setDebugPackageModalOpen,
	setDebugApplicationStatsOpen,
	startTour,
	setFuzzyFileSearchOpen,
	onEditAgent,
	groupChats,
	onNewGroupChat,
	onOpenGroupChat,
	onCloseGroupChat,
	onDeleteGroupChat,
	activeGroupChatId,
	hasActiveSessionCapability,
	onOpenMergeSession,
	onOpenSendToAgent,
	onQuickCreateWorktree,
	onOpenCreatePR,
	onSummarizeAndContinue,
	onRunPromptMacro,
	canSummarizeActiveTab,
	onToggleRemoteControl,
	autoRunSelectedDocument,
	autoRunCompletedTaskCount,
	onAutoRunResetTasks,
	onToggleAutoRunExpanded,
	onClearActiveTerminal,
	// Tab-level actions
	onCloseCurrentTab,
	onMoveTabToFirst,
	onMoveTabToLast,
	onFocusActiveTab,
	onCopyTabContext,
	onExportTabHtml,
	onPublishTabGist,
	mainPanelRef,
	// Gist publishing
	isFilePreviewOpen,
	ghCliAvailable,
	onPublishGist,
	// Document Graph - quick re-open last graph
	lastGraphFocusFile,
	onOpenLastDocumentGraph,
	// Document Graph - view the active markdown file
	currentGraphFile,
	onOpenCurrentFileInGraph,
	// Symphony
	onOpenSymphony,
	// Director's Notes
	onOpenDirectorNotes,
	// Maestro Cue
	onOpenMaestroCue,
	// Board (task DAG kanban; depends on Maestro Cue)
	onOpenBoard,
	// Pianola
	onOpenPianola,
	onConfigureCue,
	// LightboxModal
	lightboxImage,
	lightboxImages,
	stagedImages,
	onCloseLightbox,
	onNavigateLightbox,
	onUpdateLightboxImage,
	onDeleteLightboxImage,
	// GitDiffViewer
	gitDiffPreview,
	gitViewerCwd,
	onCloseGitDiff,
	// GitLogViewer
	gitLogOpen,
	onCloseGitLog,
	onOpenGitFile,
	// AutoRunSetupModal
	autoRunSetupModalOpen,
	onCloseAutoRunSetup,
	onAutoRunFolderSelected,
	// BatchRunnerModal
	batchRunnerModalOpen,
	onCloseBatchRunner,
	onStartBatchRun,
	onSaveBatchPrompt,
	showConfirmation,
	autoRunDocumentList,
	autoRunDocumentTree,
	getDocumentTaskCount,
	onAutoRunRefresh,
	onOpenMarketplace,
	// TabSwitcherModal
	tabSwitcherOpen,
	onCloseTabSwitcher,
	onTabSelect,
	onFileTabSelect,
	onTerminalTabSelect,
	onBrowserTabSelect,
	onNamedSessionSelect,
	colorBlindMode,
	// FileSearchModal
	fuzzyFileSearchOpen,
	filteredFileTree,
	fileExplorerExpanded,
	onCloseFileSearch,
	onFileSearchSelect,
	// PromptComposerModal
	promptComposerOpen,
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
	promptComposerAgentId,
	promptTabShowThinking,
	onPromptToggleTabShowThinking,
	promptSupportsThinking,
	promptEnterToSend,
	onPromptToggleEnterToSend,
	// ExecutionQueueBrowser
	queueBrowserOpen,
	onOpenQueueBrowser,
	onCloseQueueBrowser,
	onRemoveQueueItem,
	onSwitchQueueSession,
	onReorderQueueItems,
	onTogglePauseQueueItem,
	onEditQueueItem,
	// New tab creation (for QuickActionsModal)
	onQuickActionsNewTab,
	onQuickActionsNewFileTab,
	onQuickActionsNewBrowserTab,
	onQuickActionsNewTerminalTab,
	onGoToNextUnread,
	onNavBack,
	onNavForward,
}: AppUtilityModalsProps) {
	// Read per-modal data from the modal store for modals that support it.
	// `presetDocuments` is set by the inline wizard's "Start Auto Run" button so
	// the BatchRunnerModal opens with all freshly generated docs pre-selected.
	const batchRunnerData = useModalStore(selectModalData('batchRunner'));
	const batchRunnerPresetDocuments = batchRunnerData?.presetDocuments;

	return (
		<>
			{/* --- QUICK ACTIONS MODAL (Cmd+K) --- */}
			{quickActionOpen && (
				<QuickActionsModal
					theme={theme}
					sessions={sessions}
					setSessions={setSessions}
					activeSessionId={activeSessionId}
					groups={groups}
					setGroups={setGroups}
					shortcuts={shortcuts}
					initialMode={quickActionInitialMode}
					setQuickActionOpen={setQuickActionOpen}
					setActiveSessionId={setActiveSessionId}
					addNewSession={addNewSession}
					setRenameInstanceValue={setRenameInstanceValue}
					setRenameInstanceModalOpen={setRenameInstanceModalOpen}
					setRenameGroupId={setRenameGroupId}
					setRenameGroupValue={setRenameGroupValue}
					setRenameGroupEmoji={setRenameGroupEmoji}
					setRenameGroupIcon={setRenameGroupIcon}
					setRenameGroupColor={setRenameGroupColor}
					setRenameGroupModalOpen={setRenameGroupModalOpen}
					setCreateGroupModalOpen={setCreateGroupModalOpen}
					setLeftSidebarOpen={setLeftSidebarOpen}
					setRightPanelOpen={setRightPanelOpen}
					toggleInputMode={toggleInputMode}
					deleteSession={deleteSession}
					setSettingsModalOpen={setSettingsModalOpen}
					setSettingsTab={setSettingsTab}
					setShortcutsHelpOpen={setShortcutsHelpOpen}
					setAboutModalOpen={setAboutModalOpen}
					setFeedbackModalOpen={setFeedbackModalOpen}
					setLogViewerOpen={setLogViewerOpen}
					setProcessMonitorOpen={setProcessMonitorOpen}
					setUsageDashboardOpen={setUsageDashboardOpen}
					setAgentRunDashboardOpen={setAgentRunDashboardOpen}
					setActiveRightTab={setActiveRightTab}
					setAgentSessionsOpen={setAgentSessionsOpen}
					setMemoryViewerOpen={setMemoryViewerOpen}
					setActiveAgentSessionId={setActiveAgentSessionId}
					setGitDiffPreview={setGitDiffPreview}
					setGitLogOpen={setGitLogOpen}
					isAiMode={isAiMode}
					tabShortcuts={tabShortcuts}
					onRenameTab={onRenameTab}
					onToggleReadOnlyMode={onToggleReadOnlyMode}
					onToggleTabShowThinking={onToggleTabShowThinking}
					onToggleTabEnterToSend={onToggleTabEnterToSend}
					onOpenTabSwitcher={onOpenTabSwitcher}
					onCloseAllTabs={onCloseAllTabs}
					onCloseOtherTabs={onCloseOtherTabs}
					onCloseTabsLeft={onCloseTabsLeft}
					onCloseTabsRight={onCloseTabsRight}
					setPlaygroundOpen={setPlaygroundOpen}
					onRefreshGitFileState={onRefreshGitFileState}
					onDebugReleaseQueuedItem={onDebugReleaseQueuedItem}
					markdownEditMode={markdownEditMode}
					onToggleMarkdownEditMode={onToggleMarkdownEditMode}
					setUpdateCheckModalOpen={setUpdateCheckModalOpen}
					openWizard={openWizard}
					wizardGoToStep={wizardGoToStep}
					setDebugPackageModalOpen={setDebugPackageModalOpen}
					setDebugApplicationStatsOpen={setDebugApplicationStatsOpen}
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
					onRunPromptMacro={onRunPromptMacro}
					canSummarizeActiveTab={canSummarizeActiveTab}
					onToggleRemoteControl={onToggleRemoteControl}
					autoRunSelectedDocument={autoRunSelectedDocument}
					autoRunCompletedTaskCount={autoRunCompletedTaskCount}
					onAutoRunResetTasks={onAutoRunResetTasks}
					onToggleAutoRunExpanded={onToggleAutoRunExpanded}
					onClearActiveTerminal={onClearActiveTerminal}
					onCloseCurrentTab={onCloseCurrentTab}
					onMoveTabToFirst={onMoveTabToFirst}
					onMoveTabToLast={onMoveTabToLast}
					onFocusActiveTab={onFocusActiveTab}
					onCopyTabContext={onCopyTabContext}
					onExportTabHtml={onExportTabHtml}
					onPublishTabGist={onPublishTabGist}
					mainPanelRef={mainPanelRef}
					isFilePreviewOpen={isFilePreviewOpen}
					ghCliAvailable={ghCliAvailable}
					onPublishGist={onPublishGist}
					onOpenPlaybookExchange={onOpenMarketplace}
					lastGraphFocusFile={lastGraphFocusFile}
					onOpenLastDocumentGraph={onOpenLastDocumentGraph}
					currentGraphFile={currentGraphFile}
					onOpenCurrentFileInGraph={onOpenCurrentFileInGraph}
					onOpenSymphony={onOpenSymphony}
					onOpenDirectorNotes={onOpenDirectorNotes}
					onOpenMaestroCue={onOpenMaestroCue}
					onOpenBoard={onOpenBoard}
					onOpenPianola={onOpenPianola}
					onConfigureCue={onConfigureCue}
					onOpenQueueBrowser={onOpenQueueBrowser}
					onNewTab={onQuickActionsNewTab}
					onNewFileTab={onQuickActionsNewFileTab}
					onNewBrowserTab={onQuickActionsNewBrowserTab}
					onNewTerminalTab={onQuickActionsNewTerminalTab}
					onGoToNextUnread={onGoToNextUnread}
					onNavBack={onNavBack}
					onNavForward={onNavForward}
				/>
			)}

			{/* --- LIGHTBOX MODAL --- */}
			{lightboxImage && (
				<LightboxModal
					image={lightboxImage}
					stagedImages={lightboxImages.length > 0 ? lightboxImages : stagedImages}
					onClose={onCloseLightbox}
					onNavigate={onNavigateLightbox}
					onDelete={onDeleteLightboxImage}
					onUpdateImage={onUpdateLightboxImage}
					theme={theme}
				/>
			)}

			{/* --- GIT DIFF VIEWER (lazy-loaded) --- */}
			{gitDiffPreview && activeSession && (
				<Suspense fallback={null}>
					<GitDiffViewer
						diffText={gitDiffPreview}
						cwd={gitViewerCwd}
						theme={theme}
						onClose={onCloseGitDiff}
						onOpenFile={onOpenGitFile}
					/>
				</Suspense>
			)}

			{/* --- GIT LOG VIEWER (lazy-loaded) --- */}
			{gitLogOpen && activeSession && (
				<Suspense fallback={null}>
					<GitLogViewer
						cwd={gitViewerCwd}
						theme={theme}
						onClose={onCloseGitLog}
						onOpenFile={onOpenGitFile}
						sshRemoteId={
							activeSession?.sshRemoteId ||
							(activeSession?.sessionSshRemoteConfig?.enabled
								? activeSession.sessionSshRemoteConfig.remoteId
								: undefined) ||
							undefined
						}
					/>
				</Suspense>
			)}

			{/* --- AUTO RUN SETUP MODAL --- */}
			{autoRunSetupModalOpen && (
				<AutoRunSetupModal
					theme={theme}
					onClose={onCloseAutoRunSetup}
					onFolderSelected={onAutoRunFolderSelected}
					currentFolder={activeSession?.autoRunFolderPath}
					sessionName={activeSession?.name}
					sshRemoteId={
						activeSession?.sshRemoteId ||
						(activeSession?.sessionSshRemoteConfig?.enabled
							? activeSession.sessionSshRemoteConfig.remoteId
							: undefined) ||
						undefined
					}
					sshRemoteHost={activeSession?.sshRemote?.host}
				/>
			)}

			{/* --- BATCH RUNNER MODAL --- */}
			{batchRunnerModalOpen && activeSession && activeSession.autoRunFolderPath && (
				<BatchRunnerModal
					theme={theme}
					onClose={onCloseBatchRunner}
					onGo={onStartBatchRun}
					onSave={onSaveBatchPrompt}
					initialPrompt={activeSession.batchRunnerPrompt || ''}
					lastModifiedAt={activeSession.batchRunnerPromptModifiedAt}
					showConfirmation={showConfirmation}
					folderPath={activeSession.autoRunFolderPath}
					presetDocuments={batchRunnerPresetDocuments}
					allDocuments={autoRunDocumentList}
					documentTree={autoRunDocumentTree}
					getDocumentTaskCount={getDocumentTaskCount}
					onRefreshDocuments={onAutoRunRefresh}
					sessionId={activeSession.id}
					onOpenMarketplace={onOpenMarketplace}
				/>
			)}

			{/* --- TAB SWITCHER MODAL --- */}
			{tabSwitcherOpen && activeSession?.aiTabs && (
				<TabSwitcherModal
					theme={theme}
					tabs={activeSession.aiTabs}
					fileTabs={activeSession.filePreviewTabs}
					terminalTabs={activeSession.terminalTabs}
					browserTabs={activeSession.browserTabs}
					activeTabId={activeSession.activeTabId}
					activeFileTabId={activeSession.activeFileTabId}
					activeTerminalTabId={activeSession.activeTerminalTabId}
					activeBrowserTabId={activeSession.activeBrowserTabId}
					projectRoot={activeSession.projectRoot}
					agentId={activeSession.toolType}
					shortcut={tabShortcuts.tabSwitcher}
					onTabSelect={onTabSelect}
					onFileTabSelect={onFileTabSelect}
					onTerminalTabSelect={onTerminalTabSelect}
					onBrowserTabSelect={onBrowserTabSelect}
					onNamedSessionSelect={onNamedSessionSelect}
					onClose={onCloseTabSwitcher}
					colorBlindMode={colorBlindMode}
				/>
			)}

			{/* --- FUZZY FILE SEARCH MODAL --- */}
			{fuzzyFileSearchOpen && activeSession && (
				<FileSearchModal
					theme={theme}
					fileTree={filteredFileTree}
					expandedFolders={fileExplorerExpanded}
					shortcut={shortcuts.fuzzyFileSearch}
					onFileSelect={onFileSearchSelect}
					onClose={onCloseFileSearch}
				/>
			)}

			{/* --- PROMPT COMPOSER MODAL --- */}
			{promptComposerOpen && (
				<PromptComposerModal
					isOpen={promptComposerOpen}
					onClose={onClosePromptComposer}
					theme={theme}
					initialValue={promptComposerInitialValue}
					onSubmit={onPromptComposerSubmit}
					onSend={onPromptComposerSend}
					sessionName={promptComposerSessionName}
					stagedImages={promptComposerStagedImages}
					setStagedImages={setPromptComposerStagedImages}
					onImageAttachBlocked={onPromptImageAttachBlocked}
					onOpenLightbox={onPromptOpenLightbox}
					tabSaveToHistory={promptTabSaveToHistory}
					onToggleTabSaveToHistory={onPromptToggleTabSaveToHistory}
					tabReadOnlyMode={promptTabReadOnlyMode}
					onToggleTabReadOnlyMode={onPromptToggleTabReadOnlyMode}
					agentId={promptComposerAgentId}
					tabShowThinking={promptTabShowThinking}
					onToggleTabShowThinking={onPromptToggleTabShowThinking}
					supportsThinking={promptSupportsThinking}
					enterToSend={promptEnterToSend}
					onToggleEnterToSend={onPromptToggleEnterToSend}
					activeSession={activeGroupChatId ? undefined : activeSession}
					sessions={activeGroupChatId ? sessions : undefined}
					groups={activeGroupChatId ? groups : undefined}
				/>
			)}

			{/* --- EXECUTION QUEUE BROWSER --- */}
			{queueBrowserOpen && (
				<ExecutionQueueBrowser
					isOpen={queueBrowserOpen}
					onClose={onCloseQueueBrowser}
					sessions={sessions}
					activeSessionId={activeSessionId}
					theme={theme}
					onRemoveItem={onRemoveQueueItem}
					onSwitchSession={onSwitchQueueSession}
					onReorderItems={onReorderQueueItems}
					onToggleItemPause={onTogglePauseQueueItem}
					onEditItem={onEditQueueItem}
				/>
			)}
		</>
	);
});
