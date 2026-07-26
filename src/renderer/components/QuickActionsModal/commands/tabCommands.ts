import type { Session } from '../../../types';
import type { ActiveTabInfo, QuickAction } from '../types';
import { formatMetaKey } from '../../../utils/shortcutFormatter';

interface BuildNewTabCommandsArgs {
	activeSession: Session | undefined;
	onNewTab?: () => void;
	onNewFileTab?: () => void;
	onNewBrowserTab?: () => void;
	onNewTerminalTab?: () => void;
	setQuickActionOpen: (open: boolean) => void;
	newTabShortcut?: QuickAction['shortcut'];
	newFileTabShortcut?: QuickAction['shortcut'];
	newBrowserTabShortcut?: QuickAction['shortcut'];
}

interface BuildTabCommandsArgs {
	activeSession: Session | undefined;
	isAiMode?: boolean;
	activeTabInfo: ActiveTabInfo;
	enterToSendAI: boolean;
	markdownEditMode?: boolean;
	onOpenTabSwitcher?: () => void;
	onRenameTab?: () => void;
	onToggleReadOnlyMode?: () => void;
	onToggleTabShowThinking?: () => void;
	onToggleTabEnterToSend?: () => void;
	onToggleMarkdownEditMode?: () => void;
	onFocusActiveTab?: () => void;
	onCloseAllTabs?: () => void;
	onCloseOtherTabs?: () => void;
	onCloseTabsLeft?: () => void;
	onCloseTabsRight?: () => void;
	onCloseCurrentTab?: () => void;
	onMoveTabToFirst?: () => void;
	onMoveTabToLast?: () => void;
	onClearActiveTerminal?: () => void;
	setQuickActionOpen: (open: boolean) => void;
	shortcuts: {
		toggleMode?: QuickAction['shortcut'];
		toggleMarkdownMode?: QuickAction['shortcut'];
		focusActiveTab?: QuickAction['shortcut'];
		clearTerminal?: QuickAction['shortcut'];
	};
	tabShortcuts?: Record<string, QuickAction['shortcut']>;
	toggleInputMode: () => void;
}

export function buildNewTabCommands({
	activeSession,
	onNewTab,
	onNewFileTab,
	onNewBrowserTab,
	onNewTerminalTab,
	setQuickActionOpen,
	newTabShortcut,
	newFileTabShortcut,
	newBrowserTabShortcut,
}: BuildNewTabCommandsArgs): QuickAction[] {
	if (!activeSession) return [];
	const commands: QuickAction[] = [];

	if (onNewTab) {
		commands.push({
			id: 'newAiChat',
			label: 'New AI Chat',
			subtext: 'Open a new AI chat tab in the active agent',
			shortcut: newTabShortcut,
			action: () => {
				onNewTab();
				setQuickActionOpen(false);
			},
		});
	}

	if (onNewFileTab) {
		commands.push({
			id: 'newFileTab',
			label: 'New File',
			subtext: 'Open a new file tab in the active agent',
			shortcut: newFileTabShortcut,
			action: () => {
				onNewFileTab();
				setQuickActionOpen(false);
			},
		});
	}

	if (onNewBrowserTab) {
		commands.push({
			id: 'newBrowserTab',
			label: 'New Browser',
			subtext: 'Open a new browser tab in the active agent',
			shortcut: newBrowserTabShortcut,
			action: () => {
				onNewBrowserTab();
				setQuickActionOpen(false);
			},
		});
	}

	if (onNewTerminalTab) {
		commands.push({
			id: 'newTerminalTab',
			label: 'New Terminal',
			subtext: 'Open a new terminal tab in the active agent',
			action: () => {
				onNewTerminalTab();
				setQuickActionOpen(false);
			},
		});
	}

	return commands;
}

export function buildTabCommands({
	activeSession,
	isAiMode,
	activeTabInfo,
	enterToSendAI,
	markdownEditMode,
	onOpenTabSwitcher,
	onRenameTab,
	onToggleReadOnlyMode,
	onToggleTabShowThinking,
	onToggleTabEnterToSend,
	onToggleMarkdownEditMode,
	onFocusActiveTab,
	onCloseAllTabs,
	onCloseOtherTabs,
	onCloseTabsLeft,
	onCloseTabsRight,
	onCloseCurrentTab,
	onMoveTabToFirst,
	onMoveTabToLast,
	onClearActiveTerminal,
	setQuickActionOpen,
	shortcuts,
	tabShortcuts,
	toggleInputMode,
}: BuildTabCommandsArgs): QuickAction[] {
	const commands: QuickAction[] = [];
	const { isTerminalMode, hasActiveTab, activeUnifiedIndex, unifiedTabCount } = activeTabInfo;

	if (activeSession) {
		commands.push({
			id: 'switchMode',
			label: 'Switch AI/Shell Mode',
			shortcut: shortcuts.toggleMode,
			action: toggleInputMode,
		});
	}

	if (onOpenTabSwitcher && activeSession?.aiTabs) {
		commands.push({
			id: 'tabSwitcher',
			label: 'Tab Switcher',
			subtext: 'Search open tabs across this agent',
			shortcut: tabShortcuts?.tabSwitcher,
			action: () => {
				onOpenTabSwitcher();
				setQuickActionOpen(false);
			},
		});
	}

	if (hasActiveTab && onRenameTab) {
		commands.push({
			id: 'renameTab',
			label: 'Rename Tab',
			shortcut: tabShortcuts?.renameTab,
			action: () => {
				onRenameTab();
				setQuickActionOpen(false);
			},
		});
	}

	if (isAiMode && onToggleReadOnlyMode) {
		commands.push({
			id: 'toggleReadOnly',
			label: 'Toggle Read-Only Mode',
			shortcut: tabShortcuts?.toggleReadOnlyMode,
			action: () => {
				onToggleReadOnlyMode();
				setQuickActionOpen(false);
			},
		});
	}

	if (isAiMode && onToggleTabShowThinking) {
		commands.push({
			id: 'toggleShowThinking',
			label: 'Toggle Show Thinking',
			shortcut: tabShortcuts?.toggleShowThinking,
			action: () => {
				onToggleTabShowThinking();
				setQuickActionOpen(false);
			},
		});
	}

	if (isAiMode && onToggleTabEnterToSend) {
		const activeTab = activeSession?.aiTabs.find((tab) => tab.id === activeSession.activeTabId);
		const effective = activeTab?.enterToSend ?? enterToSendAI;
		commands.push({
			id: 'toggleEnterToSend',
			label: 'Toggle Enter to Send',
			subtext: effective
				? `Currently: Enter sends · click to switch this tab to ${formatMetaKey()}+Enter`
				: `Currently: ${formatMetaKey()}+Enter sends · click to switch this tab to Enter`,
			action: () => {
				onToggleTabEnterToSend();
				setQuickActionOpen(false);
			},
		});
	}

	if (isAiMode && onToggleMarkdownEditMode) {
		commands.push({
			id: 'toggleMarkdown',
			label: 'Toggle Edit/Preview',
			shortcut: shortcuts.toggleMarkdownMode,
			subtext: markdownEditMode ? 'Currently in edit mode' : 'Currently in preview mode',
			action: () => {
				onToggleMarkdownEditMode();
				setQuickActionOpen(false);
			},
		});
	}

	if (hasActiveTab && onFocusActiveTab) {
		commands.push({
			id: 'focusActiveTab',
			label: 'Focus Active Tab',
			shortcut: shortcuts.focusActiveTab,
			subtext: 'Bring the current tab header into focus',
			action: () => {
				onFocusActiveTab();
				setQuickActionOpen(false);
			},
		});
	}

	if (isAiMode && activeSession?.aiTabs && activeSession.aiTabs.length > 0 && onCloseAllTabs) {
		commands.push({
			id: 'closeAllTabs',
			label: 'Close All Tabs',
			shortcut: tabShortcuts?.closeAllTabs,
			subtext: `Close all ${activeSession.aiTabs.length} tabs (creates new tab)`,
			action: () => {
				onCloseAllTabs();
				setQuickActionOpen(false);
			},
		});
	}

	if (hasActiveTab && unifiedTabCount > 1 && onCloseOtherTabs) {
		commands.push({
			id: 'closeOtherTabs',
			label: 'Close Other Tabs',
			shortcut: tabShortcuts?.closeOtherTabs,
			subtext: `Keep only current tab, close ${unifiedTabCount - 1} others`,
			action: () => {
				onCloseOtherTabs();
				setQuickActionOpen(false);
			},
		});
	}

	if (hasActiveTab && activeUnifiedIndex > 0 && onCloseTabsLeft) {
		commands.push({
			id: 'closeTabsLeft',
			label: 'Close Tabs to Left',
			shortcut: tabShortcuts?.closeTabsLeft,
			action: () => {
				onCloseTabsLeft();
				setQuickActionOpen(false);
			},
		});
	}

	if (
		hasActiveTab &&
		activeUnifiedIndex >= 0 &&
		activeUnifiedIndex < unifiedTabCount - 1 &&
		onCloseTabsRight
	) {
		commands.push({
			id: 'closeTabsRight',
			label: 'Close Tabs to Right',
			shortcut: tabShortcuts?.closeTabsRight,
			action: () => {
				onCloseTabsRight();
				setQuickActionOpen(false);
			},
		});
	}

	if (hasActiveTab && unifiedTabCount > 1 && onCloseCurrentTab) {
		commands.push({
			id: 'closeCurrentTab',
			label: 'Close Tab',
			shortcut: tabShortcuts?.closeTab,
			action: () => {
				onCloseCurrentTab();
				setQuickActionOpen(false);
			},
		});
	}

	if (hasActiveTab && activeUnifiedIndex > 0 && onMoveTabToFirst) {
		commands.push({
			id: 'moveTabToFirst',
			label: 'Move to First Position',
			shortcut: tabShortcuts?.moveTabToStart,
			action: () => {
				onMoveTabToFirst();
				setQuickActionOpen(false);
			},
		});
	}

	if (
		hasActiveTab &&
		activeUnifiedIndex >= 0 &&
		activeUnifiedIndex < unifiedTabCount - 1 &&
		onMoveTabToLast
	) {
		commands.push({
			id: 'moveTabToLast',
			label: 'Move to Last Position',
			shortcut: tabShortcuts?.moveTabToEnd,
			action: () => {
				onMoveTabToLast();
				setQuickActionOpen(false);
			},
		});
	}

	if (activeSession && isTerminalMode && onClearActiveTerminal) {
		commands.push({
			id: 'clearTerminal',
			label: 'Clear Terminal History',
			shortcut: shortcuts.clearTerminal,
			action: () => {
				onClearActiveTerminal();
				setQuickActionOpen(false);
			},
		});
	}

	return commands;
}
