import type { AITab, FilePreviewHistoryEntry, FilePreviewTab, UnifiedTab } from '../../../types';
import type { BrowserTab } from '../../../../shared/browserPage';
import type { MediaOpenMode } from '../../../../shared/mediaTypes';

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

// Lives in shared/ because the CLI and the web server name it too.
export type { MediaOpenMode };

export interface FilePreviewTabHandlersReturn {
	handleOpenFileTab: (
		file: FileTabOpenParams,
		options?: {
			openInNewTab?: boolean;
			targetSessionId?: string;
			mediaMode?: MediaOpenMode;
			/** false = create the tab without showing it (background placement). */
			activate?: boolean;
		}
	) => void;
	handleSelectFileTab: (tabId: string) => Promise<void>;
	handleCloseFileTab: (tabId: string) => void;
	handleFileTabEditModeChange: (tabId: string, editMode: boolean) => void;
	handleFileTabEditContentChange: (
		tabId: string,
		editContent: string | undefined,
		savedContent?: string,
		savedMtime?: number
	) => void;
	handleFileTabScrollPositionChange: (tabId: string, scrollTop: number) => void;
	handleFileTabSearchQueryChange: (tabId: string, searchQuery: string) => void;
	handleReloadFileTab: (tabId: string) => Promise<void>;
	// `tabId` defaults to the active file tab. A tiled file pane passes its own id:
	// focusing a file pane does not set `activeFileTabId`, so the default would
	// navigate whichever other file tab happens to be active.
	handleFileTabNavigateBack: (tabId?: string) => Promise<void>;
	handleFileTabNavigateForward: (tabId?: string) => Promise<void>;
	handleFileTabNavigateToIndex: (index: number, tabId?: string) => Promise<void>;
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
	handleUnifiedTabReorder: (sourceTabId: string, targetTabId: string) => void;
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
