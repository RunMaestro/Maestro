import type { Shortcut } from '../types';

export const DEFAULT_SHORTCUTS: Record<string, Shortcut> = {
	toggleSidebar: {
		id: 'toggleSidebar',
		label: 'Toggle Left Panel',
		keys: ['Alt', 'Meta', 'ArrowLeft'],
	},
	toggleRightPanel: {
		id: 'toggleRightPanel',
		label: 'Toggle Right Panel',
		keys: ['Alt', 'Meta', 'ArrowRight'],
	},
	cyclePrev: { id: 'cyclePrev', label: 'Previous Agent', keys: ['Meta', '['] },
	cycleNext: { id: 'cycleNext', label: 'Next Agent', keys: ['Meta', ']'] },
	navBack: { id: 'navBack', label: 'Navigate Back', keys: ['Meta', 'Shift', ','] },
	navForward: { id: 'navForward', label: 'Navigate Forward', keys: ['Meta', 'Shift', '.'] },
	newInstance: { id: 'newInstance', label: 'New Agent', keys: ['Meta', 'n'] },
	newGroupChat: { id: 'newGroupChat', label: 'New Group Chat', keys: ['Alt', 'Meta', 'c'] },
	killInstance: { id: 'killInstance', label: 'Remove', keys: ['Meta', 'Shift', 'Backspace'] },
	moveToGroup: { id: 'moveToGroup', label: 'Move Session to Group', keys: ['Meta', 'Shift', 'm'] },
	toggleMode: { id: 'toggleMode', label: 'Switch AI/Shell Mode', keys: ['Meta', 'j'] },
	quickAction: { id: 'quickAction', label: 'Quick Actions', keys: ['Meta', 'k'] },
	help: { id: 'help', label: 'Show Shortcuts', keys: ['Meta', '/'] },
	settings: { id: 'settings', label: 'Open Settings', keys: ['Meta', ','] },
	agentSettings: { id: 'agentSettings', label: 'Open Agent Settings', keys: ['Alt', 'Meta', ','] },
	goToFiles: { id: 'goToFiles', label: 'Go to Files Tab', keys: ['Meta', 'Shift', 'f'] },
	goToHistory: { id: 'goToHistory', label: 'Go to History Tab', keys: ['Meta', 'Shift', 'h'] },
	goToAutoRun: { id: 'goToAutoRun', label: 'Go to Auto Run Tab', keys: ['Meta', 'Shift', '1'] },
	copyFilePath: { id: 'copyFilePath', label: 'Copy File Path (in Preview)', keys: ['Meta', 'p'] },
	toggleMarkdownMode: {
		id: 'toggleMarkdownMode',
		label: 'Toggle Edit/Preview',
		keys: ['Meta', 'e'],
	},
	toggleAutoRunExpanded: {
		id: 'toggleAutoRunExpanded',
		label: 'Toggle Auto Run Expanded',
		keys: ['Meta', 'Shift', 'e'],
	},
	focusInput: { id: 'focusInput', label: 'Toggle Input/Output Focus', keys: ['Meta', '.'] },
	focusSidebar: { id: 'focusSidebar', label: 'Focus Left Panel', keys: ['Meta', 'Shift', 'a'] },
	viewGitDiff: { id: 'viewGitDiff', label: 'View Git Diff', keys: ['Meta', 'Shift', 'd'] },
	viewGitLog: { id: 'viewGitLog', label: 'View Git Log', keys: ['Meta', 'Shift', 'g'] },
	agentSessions: {
		id: 'agentSessions',
		label: 'View Agent Sessions',
		keys: ['Meta', 'Shift', 'l'],
	},
	systemLogs: { id: 'systemLogs', label: 'System Log Viewer', keys: ['Alt', 'Meta', 'l'] },
	processMonitor: {
		id: 'processMonitor',
		label: 'System Process Monitor',
		keys: ['Alt', 'Meta', 'p'],
	},
	usageDashboard: { id: 'usageDashboard', label: 'Usage Dashboard', keys: ['Alt', 'Meta', 'u'] },
	jumpToBottom: { id: 'jumpToBottom', label: 'Jump to Bottom', keys: ['Meta', 'Shift', 'j'] },
	prevTab: { id: 'prevTab', label: 'Previous Tab', keys: ['Meta', 'Shift', '['] },
	nextTab: { id: 'nextTab', label: 'Next Tab', keys: ['Meta', 'Shift', ']'] },
	openImageCarousel: { id: 'openImageCarousel', label: 'Open Image Carousel', keys: ['Meta', 'y'] },
	toggleTabStar: { id: 'toggleTabStar', label: 'Toggle Tab Star', keys: ['Meta', 'Shift', 's'] },
	openPromptComposer: {
		id: 'openPromptComposer',
		label: 'Open Prompt Composer',
		keys: ['Meta', 'Shift', 'p'],
	},
	openWizard: { id: 'openWizard', label: 'New Agent Wizard', keys: ['Meta', 'Shift', 'n'] },
	fuzzyFileSearch: { id: 'fuzzyFileSearch', label: 'Fuzzy File Search', keys: ['Meta', 'g'] },
	toggleBookmark: { id: 'toggleBookmark', label: 'Toggle Bookmark', keys: ['Meta', 'Shift', 'b'] },
};

// Non-editable shortcuts (displayed in help but not configurable)
export const FIXED_SHORTCUTS: Record<string, Shortcut> = {
	jumpToSession: {
		id: 'jumpToSession',
		label: 'Jump to Session (1-9, 0=10th)',
		keys: ['Alt', 'Meta', '1-0'],
	},
	filterFiles: { id: 'filterFiles', label: 'Filter Files (in Files tab)', keys: ['Meta', 'f'] },
	filterSessions: {
		id: 'filterSessions',
		label: 'Filter Sessions (in Left Panel)',
		keys: ['Meta', 'f'],
	},
	filterHistory: {
		id: 'filterHistory',
		label: 'Filter History (in History tab)',
		keys: ['Meta', 'f'],
	},
	searchLogs: { id: 'searchLogs', label: 'Search System Logs', keys: ['Meta', 'f'] },
	searchOutput: {
		id: 'searchOutput',
		label: 'Search Output (in Main Window)',
		keys: ['Meta', 'f'],
	},
	filePreviewBack: {
		id: 'filePreviewBack',
		label: 'File Preview: Go Back',
		keys: ['Meta', 'ArrowLeft'],
	},
	filePreviewForward: {
		id: 'filePreviewForward',
		label: 'File Preview: Go Forward',
		keys: ['Meta', 'ArrowRight'],
	},
};

// Tab navigation shortcuts (AI mode only)
export const TAB_SHORTCUTS: Record<string, Shortcut> = {
	tabSwitcher: { id: 'tabSwitcher', label: 'Tab Switcher', keys: ['Alt', 'Meta', 't'] },
	newTab: { id: 'newTab', label: 'New Tab', keys: ['Meta', 't'] },
	closeTab: { id: 'closeTab', label: 'Close Tab', keys: ['Meta', 'w'] },
	closeAllTabs: { id: 'closeAllTabs', label: 'Close All Tabs', keys: ['Meta', 'Shift', 'w'] },
	closeOtherTabs: { id: 'closeOtherTabs', label: 'Close Other Tabs', keys: ['Alt', 'Meta', 'w'] },
	closeTabsLeft: {
		id: 'closeTabsLeft',
		label: 'Close Tabs to Left',
		keys: ['Meta', 'Shift', 'Alt', '['],
	},
	closeTabsRight: {
		id: 'closeTabsRight',
		label: 'Close Tabs to Right',
		keys: ['Meta', 'Shift', 'Alt', ']'],
	},
	reopenClosedTab: {
		id: 'reopenClosedTab',
		label: 'Reopen Closed Tab',
		keys: ['Meta', 'Shift', 't'],
	},
	renameTab: { id: 'renameTab', label: 'Rename Tab', keys: ['Meta', 'Shift', 'r'] },
	toggleReadOnlyMode: {
		id: 'toggleReadOnlyMode',
		label: 'Toggle Read-Only Mode',
		keys: ['Meta', 'r'],
	},
	toggleSaveToHistory: {
		id: 'toggleSaveToHistory',
		label: 'Toggle Save to History',
		keys: ['Meta', 's'],
	},
	toggleShowThinking: {
		id: 'toggleShowThinking',
		label: 'Toggle Show Thinking',
		keys: ['Meta', 'Shift', 'k'],
	},
	filterUnreadTabs: { id: 'filterUnreadTabs', label: 'Filter Unread Tabs', keys: ['Meta', 'u'] },
	toggleTabUnread: {
		id: 'toggleTabUnread',
		label: 'Toggle Tab Unread',
		keys: ['Meta', 'Shift', 'u'],
	},
	goToTab1: { id: 'goToTab1', label: 'Go to Tab 1', keys: ['Meta', '1'] },
	goToTab2: { id: 'goToTab2', label: 'Go to Tab 2', keys: ['Meta', '2'] },
	goToTab3: { id: 'goToTab3', label: 'Go to Tab 3', keys: ['Meta', '3'] },
	goToTab4: { id: 'goToTab4', label: 'Go to Tab 4', keys: ['Meta', '4'] },
	goToTab5: { id: 'goToTab5', label: 'Go to Tab 5', keys: ['Meta', '5'] },
	goToTab6: { id: 'goToTab6', label: 'Go to Tab 6', keys: ['Meta', '6'] },
	goToTab7: { id: 'goToTab7', label: 'Go to Tab 7', keys: ['Meta', '7'] },
	goToTab8: { id: 'goToTab8', label: 'Go to Tab 8', keys: ['Meta', '8'] },
	goToTab9: { id: 'goToTab9', label: 'Go to Tab 9', keys: ['Meta', '9'] },
	goToLastTab: { id: 'goToLastTab', label: 'Go to Last Tab', keys: ['Meta', '0'] },
};
