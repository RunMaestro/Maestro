import type { AITab, Theme, UnifiedTab } from '../../types';
import type { ReactNode } from 'react';
import type { CopyContextOptions } from '../../hooks/tabs/useTabExportHandlers';

export interface TabBarProps {
	tabs: AITab[];
	activeTabId: string;
	theme: Theme;
	/** The Maestro session/agent ID that owns these tabs */
	sessionId?: string;
	/** Session-level agentSessionId fallback for tab title display (used until tab.agentSessionId is wired up) */
	sessionAgentSessionId?: string | null;
	onTabSelect: (tabId: string) => void;
	onTabClose: (tabId: string) => void;
	onNewTab: () => void;
	onNewFileTab?: () => void;
	onNewBrowserTab?: () => void;
	/** Handler to create a new terminal tab (shown in the + button popover) */
	onNewTerminalTab?: () => void;
	onRequestRename?: (tabId: string) => void;
	onTabReorder?: (fromIndex: number, toIndex: number) => void;
	/** Handler to reorder tabs in unified tab order (AI + file tabs) */
	onUnifiedTabReorder?: (fromIndex: number, toIndex: number) => void;
	onTabStar?: (tabId: string, starred: boolean) => void;
	onTabMarkUnread?: (tabId: string) => void;
	/** Handler to open merge session modal with this tab as source */
	onMergeWith?: (tabId: string) => void;
	/** Handler to open send to agent modal with this tab as source */
	onSendToAgent?: (tabId: string) => void;
	/** Handler to summarize and continue in a new tab */
	onSummarizeAndContinue?: (tabId: string) => void;
	/** Handler to copy conversation context to clipboard */
	onCopyContext?: (tabId: string, options?: CopyContextOptions) => void;
	/** Handler to export tab as HTML */
	onExportHtml?: (tabId: string) => void;
	/** Handler to publish tab context as GitHub Gist */
	onPublishGist?: (tabId: string) => void;
	/** Whether GitHub CLI is available for gist publishing */
	ghCliAvailable?: boolean;
	showUnreadOnly?: boolean;
	onToggleUnreadFilter?: () => void;
	onOpenTabSearch?: () => void;
	/** Handler to open message search (Cmd+F) */
	onOpenOutputSearch?: () => void;
	/** Handler to close all tabs */
	onCloseAllTabs?: () => void;
	/** Handler to close all tabs except the pivot (clicked) tab, or the active tab when no id is given */
	onCloseOtherTabs?: (pivotTabId?: string) => void;
	/** Handler to close tabs to the left of the pivot (clicked) tab, or the active tab when no id is given */
	onCloseTabsLeft?: (pivotTabId?: string) => void;
	/** Handler to close tabs to the right of the pivot (clicked) tab, or the active tab when no id is given */
	onCloseTabsRight?: (pivotTabId?: string) => void;

	// === Unified Tab System Props (Phase 3) ===
	/** Merged ordered list of AI and file preview tabs for unified rendering */
	unifiedTabs?: UnifiedTab[];
	/** Currently active file tab ID (null if an AI tab is active) */
	activeFileTabId?: string | null;
	/** Handler to select a file preview tab */
	onFileTabSelect?: (tabId: string) => void;
	/** Handler to close a file preview tab */
	onFileTabClose?: (tabId: string) => void;
	/** Currently active browser tab ID (null if no browser tab is active) */
	activeBrowserTabId?: string | null;
	/** Handler to select a browser tab */
	onBrowserTabSelect?: (tabId: string) => void;
	/** Handler to close a browser tab */
	onBrowserTabClose?: (tabId: string) => void;
	/** Handler to open the rename dialog for a browser tab */
	onBrowserTabRename?: (tabId: string) => void;
	/** Handler to clear a browser tab's user-assigned name */
	onBrowserTabResetName?: (tabId: string) => void;

	// === Terminal Tab Props (Phase 8) ===
	/** Currently active terminal tab ID (null if no terminal tab is active) */
	activeTerminalTabId?: string | null;
	/** Current input mode — used to determine which tab type shows as active */
	inputMode?: 'ai' | 'terminal';
	/** Handler to select a terminal tab */
	onTerminalTabSelect?: (tabId: string) => void;
	/** Handler to close a terminal tab */
	onTerminalTabClose?: (tabId: string) => void;
	/** Handler to rename a terminal tab */
	onTerminalTabRename?: (tabId: string) => void;
	/** Handler to copy a terminal tab's full buffer to clipboard */
	onCopyTerminalBuffer?: (tabId: string) => void;
	/** Handler to publish a terminal tab's buffer as a GitHub Gist */
	onPublishTerminalBufferGist?: (tabId: string) => void;
	/** Handler to send a terminal tab's buffer to another agent */
	onSendTerminalBufferToAgent?: (tabId: string) => void;
	/** Handler to open the startup-command modal for a terminal tab */
	onTerminalTabConfigureStartupCommand?: (tabId: string) => void;
	/** Handler to copy the rendered text of a browser tab to the clipboard */
	onCopyBrowserContent?: (tabId: string) => void;
	/** Handler to send the rendered text of a browser tab to another agent */
	onSendBrowserContentToAgent?: (tabId: string) => void;

	// === Accessibility ===
	/** Whether colorblind-friendly colors should be used for extension badges */
	colorBlindMode?: boolean;

	/** True when the owning agent is running on an SSH remote — hides local-only OS actions in tab menus */
	sshRemote?: boolean;

	// === Optional pinned slot (used by Pianola's manager surface) ===
	/** Pinned content rendered inside the sticky-left group, before the tab
	 * strip — stays visible while tabs overflow/scroll (e.g. Pianola's
	 * Dashboard view button). */
	leadingSlot?: ReactNode;
}
