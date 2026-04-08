import { lazy, Suspense, memo } from 'react';
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
import type { WizardStep } from '../Wizard/WizardContext';
import type { FlatFileItem } from '../FileSearchModal';

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
	setActiveRightTab: (tab: RightPanelTab) => void;
	setAgentSessionsOpen: (open: boolean) => void;
	setActiveAgentSessionId: (id: string | null) => void;
	setGitDiffPreview: (diff: string | null) => void;
	setGitLogOpen: (open: boolean) => void;
	isAiMode: boolean;
	onRenameTab: () => void;
	onToggleReadOnlyMode: () => void;
	onToggleTabShowThinking: () => void;
	onOpenTabSwitcher: () => void;
	// Bulk tab close operations
	onCloseAllTabs?: () => void;
	onCloseOtherTabs?: () => void;
	onCloseTabsLeft?: () => void;
	onCloseTabsRight?: () => void;
	setPlaygroundOpen?: (open: boolean) => void;
	onRefreshGitFileState: () => Promise<void>;
	onDebugReleaseQueuedItem: () => void;
	markdownEditMode: boolean;
	onToggleMarkdownEditMode: () => void;
	setUpdateCheckModalOpen?: (open: boolean) => void;
	openWizard: () => void;
	wizardGoToStep: (step: WizardStep) => void;
	setDebugWizardModalOpen?: (open: boolean) => void;
	setDebugPackageModalOpen?: (open: boolean) => void;
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
	onClearActiveTerminal?: () => void;

	// Tab-level actions (for QuickActionsModal)
	onCloseCurrentTab?: () => void;
	onMoveTabToFirst?: () => void;
	onMoveTabToLast?: () => void;
	onCopyTabContext?: (tabId: string) => void;
	onExportTabHtml?: (tabId: string) => void;
	onPublishTabGist?: (tabId: string) => void;

	// Gist publishing (for QuickActionsModal)
	isFilePreviewOpen: boolean;
	ghCliAvailable: boolean;
	onPublishGist?: () => void;

	// Document Graph - quick re-open last graph
	lastGraphFocusFile?: string;
	onOpenLastDocumentGraph?: () => void;

	// Symphony
	onOpenSymphony?: () => void;

	// Director's Notes
	onOpenDirectorNotes?: () => void;

	// Maestro Cue
	onOpenMaestroCue?: () => void;
	onConfigureCue?: (session: Session) => void;

	// LightboxModal
	lightboxImage: string | null;
	lightboxImages: string[];
	stagedImages: string[];
	onCloseLightbox: () => void;
	onNavigateLightbox: (img: string) => void;
	onDeleteLightboxImage?: (img: string) => void;

	// GitDiffViewer
	gitDiffPreview: string | null;
	gitViewerCwd: string;
	onCloseGitDiff: () => void;

	// GitLogViewer
	gitLogOpen: boolean;
	onCloseGitLog: () => void;

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
	onCloseQueueBrowser: () => void;
	onRemoveQueueItem: (sessionId: string, itemId: string) => void;
	onSwitchQueueSession: (sessionId: string, tabId?: string) => void;
	onReorderQueueItems: (sessionId: string, fromIndex: number, toIndex: number) => void;
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
	setActiveRightTab,
	setAgentSessionsOpen,
	setActiveAgentSessionId,
	setGitDiffPreview,
	setGitLogOpen,
	isAiMode,
	onRenameTab,
	onToggleReadOnlyMode,
	onToggleTabShowThinking,
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
	setDebugWizardModalOpen,
	setDebugPackageModalOpen,
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
	canSummarizeActiveTab,
	onToggleRemoteControl,
	autoRunSelectedDocument,
	autoRunCompletedTaskCount,
	onAutoRunResetTasks,
	onClearActiveTerminal,
	// Tab-level actions
	onCloseCurrentTab,
	onMoveTabToFirst,
	onMoveTabToLast,
	onCopyTabContext,
	onExportTabHtml,
	onPublishTabGist,
	// Gist publishing
	isFilePreviewOpen,
	ghCliAvailable,
	onPublishGist,
	// Document Graph - quick re-open last graph
	lastGraphFocusFile,
	onOpenLastDocumentGraph,
	// Symphony
	onOpenSymphony,
	// Director's Notes
	onOpenDirectorNotes,
	// Maestro Cue
	onOpenMaestroCue,
	onConfigureCue,
	// LightboxModal
	lightboxImage,
	lightboxImages,
	stagedImages,
	onCloseLightbox,
	onNavigateLightbox,
	onDeleteLightboxImage,
	// GitDiffViewer
	gitDiffPreview,
	gitViewerCwd,
	onCloseGitDiff,
	// GitLogViewer
	gitLogOpen,
	onCloseGitLog,
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
	onCloseQueueBrowser,
	onRemoveQueueItem,
	onSwitchQueueSession,
	onReorderQueueItems,
}: AppUtilityModalsProps) {
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
					setActiveRightTab={setActiveRightTab}
					setAgentSessionsOpen={setAgentSessionsOpen}
					setActiveAgentSessionId={setActiveAgentSessionId}
					setGitDiffPreview={setGitDiffPreview}
					setGitLogOpen={setGitLogOpen}
					isAiMode={isAiMode}
					tabShortcuts={tabShortcuts}
					onRenameTab={onRenameTab}
					onToggleReadOnlyMode={onToggleReadOnlyMode}
					onToggleTabShowThinking={onToggleTabShowThinking}
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
					onClearActiveTerminal={onClearActiveTerminal}
					onCloseCurrentTab={onCloseCurrentTab}
					onMoveTabToFirst={onMoveTabToFirst}
					onMoveTabToLast={onMoveTabToLast}
					onCopyTabContext={onCopyTabContext}
					onExportTabHtml={onExportTabHtml}
					onPublishTabGist={onPublishTabGist}
					isFilePreviewOpen={isFilePreviewOpen}
					ghCliAvailable={ghCliAvailable}
					onPublishGist={onPublishGist}
					onOpenPlaybookExchange={onOpenMarketplace}
					lastGraphFocusFile={lastGraphFocusFile}
					onOpenLastDocumentGraph={onOpenLastDocumentGraph}
					onOpenSymphony={onOpenSymphony}
					onOpenDirectorNotes={onOpenDirectorNotes}
					onOpenMaestroCue={onOpenMaestroCue}
					onConfigureCue={onConfigureCue}
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
					currentDocument={activeSession.autoRunSelectedFile || ''}
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
					activeTabId={activeSession.activeTabId}
					activeFileTabId={activeSession.activeFileTabId}
					activeTerminalTabId={activeSession.activeTerminalTabId}
					projectRoot={activeSession.projectRoot}
					agentId={activeSession.toolType}
					shortcut={tabShortcuts.tabSwitcher}
					onTabSelect={onTabSelect}
					onFileTabSelect={onFileTabSelect}
					onTerminalTabSelect={onTerminalTabSelect}
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
				/>
			)}
		</>
	);
});
