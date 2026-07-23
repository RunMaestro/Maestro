import type {
	AITab,
	BrowserTab,
	FilePreviewHistoryEntry,
	FilePreviewTab,
	UnifiedTab,
} from '../../../types';

export interface CloseCurrentTabResult {
	type: 'file' | 'browser' | 'ai' | 'terminal' | 'prevented' | 'none';
	tabId?: string;
	isWizardTab?: boolean;
	hasWizardUserInteraction?: boolean;
	hasDraft?: boolean;
}

export interface FileTabOpenParams {
	path: string;
	name: string;
	content: string;
	sshRemoteId?: string;
	lastModified?: number;
	isLoading?: boolean;
	loadRequestId?: string;
	pendingScrollToLine?: number;
}

export interface TabDerivedState {
	activeTab: AITab | undefined;
	unifiedTabs: UnifiedTab[];
	activeFileTab: FilePreviewTab | null;
	activeBrowserTab: BrowserTab | null;
	isResumingSession: boolean;
	fileTabBackHistory: FilePreviewHistoryEntry[];
	fileTabForwardHistory: FilePreviewHistoryEntry[];
	fileTabCanGoBack: boolean;
	fileTabCanGoForward: boolean;
	activeFileTabNavIndex: number;
}

export interface AITabHandlersReturn {
	performTabClose: (tabId: string) => void;
	handleNewAgentSession: () => void;
	handleTabSelect: (tabId: string) => void;
	handleTabClose: (tabId: string) => void;
	handleNewTab: () => void;
	handleTabReorder: (fromIndex: number, toIndex: number) => void;
	handleCloseAllTabs: () => void;
	handleRequestTabRename: (tabId: string) => void;
	handleUpdateTabByClaudeSessionId: (
		agentSessionId: string,
		updates: { name?: string | null; starred?: boolean }
	) => void;
	handleTabStar: (tabId: string, starred: boolean) => void;
	handleTabMarkUnread: (tabId: string) => void;
	handleToggleTabReadOnlyMode: () => void;
	handleToggleTabSaveToHistory: () => void;
	handleToggleTabShowThinking: () => void;
	handleToggleTabEnterToSend: () => void;
}

export interface FilePreviewTabHandlersReturn {
	handleOpenFileTab: (
		file: FileTabOpenParams,
		options?: { openInNewTab?: boolean; targetSessionId?: string }
	) => void;
	handleSelectFileTab: (tabId: string) => Promise<void>;
	handleCloseFileTab: (tabId: string) => void;
	handleFileTabEditModeChange: (tabId: string, editMode: boolean) => void;
	handleFileTabEditContentChange: (
		tabId: string,
		editContent: string | undefined,
		savedContent?: string
	) => void;
	handleFileTabScrollPositionChange: (tabId: string, scrollTop: number) => void;
	handleFileTabSearchQueryChange: (tabId: string, searchQuery: string) => void;
	handleReloadFileTab: (tabId: string) => Promise<void>;
	handleFileTabNavigateBack: () => Promise<void>;
	handleFileTabNavigateForward: () => Promise<void>;
	handleFileTabNavigateToIndex: (index: number) => Promise<void>;
	handleClearFilePreviewHistory: () => void;
	handleNewFileTab: () => void;
}

export interface BrowserTabHandlersReturn {
	handleNewBrowserTab: (options?: { ephemeral?: boolean }) => void;
	handleOpenBrowserTabAt: (url: string, options?: { title?: string }) => void;
	handleSelectBrowserTab: (tabId: string) => void;
	handleCloseBrowserTab: (tabId: string) => void;
	handleUpdateBrowserTab: (sessionId: string, tabId: string, updates: Partial<BrowserTab>) => void;
}

export interface UnifiedTabHandlersReturn {
	handleUnifiedTabReorder: (fromIndex: number, toIndex: number) => void;
	handleCloseOtherTabs: (pivotTabId?: string) => void;
	handleCloseTabsLeft: (pivotTabId?: string) => void;
	handleCloseTabsRight: (pivotTabId?: string) => void;
	handleCloseCurrentTab: () => CloseCurrentTabResult;
}

export interface ScrollLogHandlersReturn {
	handleScrollPositionChange: (scrollTop: number) => void;
	handleAtBottomChange: (isAtBottom: boolean) => void;
	handleDeleteLog: (logId: string) => number | null;
}

export interface TabHandlersReturn
	extends
		AITabHandlersReturn,
		FilePreviewTabHandlersReturn,
		BrowserTabHandlersReturn,
		UnifiedTabHandlersReturn,
		ScrollLogHandlersReturn {}

export interface TerminalTabHandlersReturn {
	handleOpenTerminalTab: (options?: { shell?: string; cwd?: string; name?: string | null }) => void;
	handleCloseTerminalTab: (tabId: string) => void;
	handleSelectTerminalTab: (tabId: string) => void;
	handleRenameTerminalTab: (tabId: string, name: string) => void;
}
