// Import from the shared type module rather than `../types`: the CLI reads
// these defaults (to print a surface's hotkey in `maestro-cli open`), and
// `../types` drags renderer-only, DOM-dependent modules into that build.
import type { Shortcut } from '../../shared/shortcut-types';

export const DEFAULT_SHORTCUTS = {
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
	cyclePrev: { id: 'cyclePrev', label: 'Previous Agent', keys: ['Meta', '['], windowScoped: true },
	cycleNext: { id: 'cycleNext', label: 'Next Agent', keys: ['Meta', ']'], windowScoped: true },
	navBack: { id: 'navBack', label: 'Navigate Back', keys: ['Meta', 'Shift', ','] },
	navForward: { id: 'navForward', label: 'Navigate Forward', keys: ['Meta', 'Shift', '.'] },
	newInstance: { id: 'newInstance', label: 'New Agent', keys: ['Meta', 'n'] },
	// G for Group chat. Moved off Opt+Cmd+C so Concerto - a far more frequently
	// toggled surface - can have the mnemonic C. Migrated in settingsShortcutsSlice.
	newGroupChat: { id: 'newGroupChat', label: 'New Group Chat', keys: ['Alt', 'Meta', 'g'] },
	killInstance: { id: 'killInstance', label: 'Remove', keys: ['Meta', 'Shift', 'Backspace'] },
	moveToGroup: { id: 'moveToGroup', label: 'Move Session to Group', keys: ['Alt', 'Meta', 'm'] },
	openMemoryViewer: {
		id: 'openMemoryViewer',
		label: 'Open Memory Viewer',
		keys: ['Meta', 'Shift', 'm'],
	},
	toggleMode: { id: 'toggleMode', label: 'Switch AI/Shell Mode', keys: ['Meta', 'j'] },
	quickAction: {
		id: 'quickAction',
		label: 'Quick Actions',
		keys: ['Meta', 'k'],
		windowScoped: true,
	},
	agentSwitcher: {
		id: 'agentSwitcher',
		label: 'Switch Agent',
		keys: ['Meta', 'o'],
		windowScoped: true,
	},
	help: { id: 'help', label: 'Show Shortcuts', keys: ['Meta', '/'] },
	settings: { id: 'settings', label: 'Open Settings', keys: ['Meta', ','] },
	agentSettings: { id: 'agentSettings', label: 'Open Agent Settings', keys: ['Alt', 'Meta', ','] },
	goToFiles: { id: 'goToFiles', label: 'Go to Files Tab', keys: ['Meta', 'Shift', 'f'] },
	goToHistory: { id: 'goToHistory', label: 'Go to History Tab', keys: ['Meta', 'Shift', 'h'] },
	goToAutoRun: { id: 'goToAutoRun', label: 'Go to Auto Run Tab', keys: ['Meta', 'Shift', '1'] },
	copyFilePath: { id: 'copyFilePath', label: 'Copy File Path (in Preview)', keys: ['Meta', 'p'] },
	toggleFilePreviewToc: {
		id: 'toggleFilePreviewToc',
		label: 'Toggle Table of Contents (Markdown Preview)',
		keys: ['Meta', '\\'],
	},
	toggleMarkdownMode: {
		id: 'toggleMarkdownMode',
		label: 'Toggle Edit/Preview',
		keys: ['Meta', 'e'],
	},
	toggleAutoRunExpanded: {
		id: 'toggleAutoRunExpanded',
		label: 'Auto Run Expanded Preview',
		keys: ['Meta', 'Shift', '3'],
	},
	openBatchRunner: {
		id: 'openBatchRunner',
		label: 'Run Auto Run',
		keys: ['Meta', 'Shift', '2'],
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
	executionQueue: {
		id: 'executionQueue',
		label: 'View Execution Queue',
		keys: ['Meta', 'Shift', 'x'],
	},
	editLastQueuedMessage: {
		id: 'editLastQueuedMessage',
		label: 'Edit Last Queued Message',
		keys: ['Meta', 'Shift', 'e'],
	},
	// Opt+Cmd+Down, not Opt+J: the J key is crowded (Cmd+J switches AI/Shell mode,
	// Cmd+Shift+J tiles a new terminal, Opt+Cmd+J jumps to the nearest terminal),
	// and a bare Opt+letter types a character while the composer has focus.
	jumpToBottom: { id: 'jumpToBottom', label: 'Jump to Bottom', keys: ['Alt', 'Meta', 'ArrowDown'] },
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
	openModelEffort: {
		id: 'openModelEffort',
		label: 'Change Tabs Model and Effort',
		keys: ['Alt', 'Meta', '.'],
	},
	fuzzyFileSearch: { id: 'fuzzyFileSearch', label: 'Fuzzy File Search', keys: ['Meta', 'g'] },
	toggleBookmark: { id: 'toggleBookmark', label: 'Toggle Bookmark', keys: ['Meta', 'Shift', 'b'] },
	openSymphony: { id: 'openSymphony', label: 'Maestro Symphony', keys: ['Meta', 'Shift', 'y'] },
	directorNotes: {
		id: 'directorNotes',
		label: "Director's Notes",
		keys: ['Meta', 'Shift', 'o'],
	},
	openCue: {
		id: 'openCue',
		label: 'Maestro Cue',
		keys: ['Alt', 'q'],
	},
	// Opt+Cmd, not a bare Opt: on macOS a plain Opt+letter is a TEXT-ENTRY combo
	// (Opt+C types "ç", Opt+U starts a dead-key umlaut), so it lands as a
	// character whenever the composer has focus - which is Maestro's usual state.
	// Adding Cmd suppresses the character, and it matches the Opt+Cmd family the
	// other feature surfaces already use (Usage Dashboard, System Logs).
	// C for Concerto; newGroupChat gave up this combo for it and moved to Opt+Cmd+G.
	toggleConcerto: {
		id: 'toggleConcerto',
		label: 'Show/Hide Concerto Stage',
		keys: ['Alt', 'Meta', 'c'],
	},
	// Shift+ the stage key: the same surface family, the broader "put it all
	// away" action.
	toggleCadenzas: {
		id: 'toggleCadenzas',
		label: 'Show/Hide All Cadenzas',
		keys: ['Alt', 'Meta', 'Shift', 'c'],
	},
	filterUnreadAgents: {
		id: 'filterUnreadAgents',
		label: 'Filter Unread Agents',
		keys: ['Alt', 'u'],
	},
	nextUnreadTab: {
		id: 'nextUnreadTab',
		label: 'Next Unread / Draft Tab',
		keys: ['Meta', 'Shift', 'ArrowDown'],
	},
	jumpToTerminal: {
		id: 'jumpToTerminal',
		label: 'Jump to Nearest Terminal',
		keys: ['Alt', 'Meta', 'j'],
	},
	fontSizeReset: {
		id: 'fontSizeReset',
		label: 'Reset Font Size',
		keys: ['Meta', 'Shift', '0'],
	},
	forcedParallelSend: {
		id: 'forcedParallelSend',
		label: 'Forced Parallel Send',
		keys: ['Meta', 'Shift', 'Enter'],
	},
	clearTerminal: {
		id: 'clearTerminal',
		label: 'Clear Terminal',
		keys: ['Meta', 'Shift', 'k'],
	},
	focusActiveTab: {
		id: 'focusActiveTab',
		label: 'Focus Active Tab',
		keys: ['Alt', 'Meta', 'ArrowUp'],
	},
	searchAllTabs: {
		id: 'searchAllTabs',
		label: 'Search Messages (All Agent Tabs)',
		keys: ['Alt', 'Meta', 'f'],
	},
	editClipboardImage: {
		id: 'editClipboardImage',
		label: 'Edit Image from Clipboard',
		keys: ['Alt', 'Meta', 'e'],
	},

	// Tab tiling (split panes) - the whole family lives on Ctrl+Cmd, the one
	// modifier combo unused by every other shortcut (Alt+Cmd+Arrow* is already the
	// sidebar/panel toggles). All are window-scoped: they act only on the active
	// window's active tab group. Matched by isPaneShortcut (which requires BOTH
	// Ctrl and Cmd), not the general isShortcut, so they never collide with the
	// plain-Cmd equivalents (Cmd+W close tab, Cmd+= font size, etc.).
	paneFocusLeft: {
		id: 'paneFocusLeft',
		label: 'Focus Pane Left',
		keys: ['Control', 'Meta', 'ArrowLeft'],
		windowScoped: true,
	},
	paneFocusRight: {
		id: 'paneFocusRight',
		label: 'Focus Pane Right',
		keys: ['Control', 'Meta', 'ArrowRight'],
		windowScoped: true,
	},
	paneFocusUp: {
		id: 'paneFocusUp',
		label: 'Focus Pane Up',
		keys: ['Control', 'Meta', 'ArrowUp'],
		windowScoped: true,
	},
	paneFocusDown: {
		id: 'paneFocusDown',
		label: 'Focus Pane Down',
		keys: ['Control', 'Meta', 'ArrowDown'],
		windowScoped: true,
	},
	paneSplitRow: {
		id: 'paneSplitRow',
		label: 'Split Pane (Side by Side)',
		keys: ['Control', 'Meta', 'd'],
		windowScoped: true,
	},
	paneSplitColumn: {
		id: 'paneSplitColumn',
		label: 'Split Pane (Stacked)',
		keys: ['Control', 'Meta', 'Shift', 'd'],
		windowScoped: true,
	},
	paneClose: {
		id: 'paneClose',
		label: 'Close Focused Pane',
		keys: ['Control', 'Meta', 'w'],
		windowScoped: true,
	},
	paneZoom: {
		id: 'paneZoom',
		label: 'Maximize / Restore Pane',
		keys: ['Control', 'Meta', 'z'],
		windowScoped: true,
	},
	paneRebalance: {
		id: 'paneRebalance',
		label: 'Rebalance Panes',
		keys: ['Control', 'Meta', '='],
		windowScoped: true,
	},
	// Cycle focus through the active group's panes in document order (prev/next with
	// wrap). Unlike the rest of the family these live on Alt+[ / Alt+] (matched by the
	// general isShortcut via its Alt+bracket e.code fallback, not isPaneShortcut) to
	// mirror the plain Cmd+[ / Cmd+] "cycle agent" and Cmd+Shift+[ / ] "cycle tab" pair.
	paneCyclePrev: {
		id: 'paneCyclePrev',
		label: 'Focus Previous Pane',
		keys: ['Alt', '['],
		windowScoped: true,
	},
	paneCycleNext: {
		id: 'paneCycleNext',
		label: 'Focus Next Pane',
		keys: ['Alt', ']'],
		windowScoped: true,
	},
	// The "tile a NEW tab" family. Only the terminal ships with a binding: it sits
	// on Cmd+Shift+J, one modifier away from Cmd+J (open a new terminal tab),
	// because a terminal beside your work is the common case. The other three are
	// registered UNBOUND (`keys: []`) rather than left out - that keeps them in
	// Settings -> Shortcuts where a user can record their own binding, without
	// Maestro claiming three more default chords nobody asked for. An empty `keys`
	// never matches an event (see isShortcut) and renders as "Not set".
	tileTerminalBelow: {
		id: 'tileTerminalBelow',
		label: 'Tile New Terminal Below',
		keys: ['Meta', 'Shift', 'j'],
		windowScoped: true,
	},
	tileAiBelow: {
		id: 'tileAiBelow',
		label: 'Tile New AI Chat Below',
		keys: [],
		windowScoped: true,
	},
	tileBrowserBelow: {
		id: 'tileBrowserBelow',
		label: 'Tile New Browser Below',
		keys: [],
		windowScoped: true,
	},
	tileFileBelow: {
		id: 'tileFileBelow',
		label: 'Tile New File Below',
		keys: [],
		windowScoped: true,
	},
} satisfies Record<string, Shortcut>;

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
	historyJumpToSession: {
		id: 'historyJumpToSession',
		label: 'Jump to Entry Session (in History tab)',
		keys: ['Meta', 'Enter'],
	},
	searchLogs: { id: 'searchLogs', label: 'Search System Logs', keys: ['Meta', 'f'] },
	searchOutput: {
		id: 'searchOutput',
		label: 'Search Output (in Main Window)',
		keys: ['Meta', 'f'],
	},
	searchDirectorNotes: {
		id: 'searchDirectorNotes',
		label: "Search Director's Notes",
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
	fontSizeIncrease: {
		id: 'fontSizeIncrease',
		label: 'Increase Font Size',
		keys: ['Meta', '='],
	},
	fontSizeDecrease: {
		id: 'fontSizeDecrease',
		label: 'Decrease Font Size',
		keys: ['Meta', '-'],
	},
};

// Tab navigation shortcuts (AI mode only)
export const TAB_SHORTCUTS = {
	tabSwitcher: { id: 'tabSwitcher', label: 'Tab Switcher', keys: ['Alt', 'Meta', 't'] },
	newTab: { id: 'newTab', label: 'New Tab', keys: ['Meta', 't'] },
	newBrowserTab: { id: 'newBrowserTab', label: 'New Browser', keys: ['Meta', 'b'] },
	newFileTab: { id: 'newFileTab', label: 'New File', keys: ['Alt', 'n'] },
	focusBrowserAddress: {
		id: 'focusBrowserAddress',
		label: 'Focus Browser Address Bar',
		keys: ['Meta', 'l'],
	},
	closeTab: { id: 'closeTab', label: 'Close Tab', keys: ['Meta', 'w'] },
	closeAllTabs: { id: 'closeAllTabs', label: 'Close All Tabs', keys: ['Meta', 'Shift', 'w'] },
	closeOtherTabs: { id: 'closeOtherTabs', label: 'Close Other Tabs', keys: ['Alt', 'Meta', 'w'] },
	snoozeTab: { id: 'snoozeTab', label: 'Snooze Tab', keys: ['Alt', 'Meta', 's'] },
	// Registered unassigned: the snoozed-tab list is reachable by click today and
	// there is no spare chord near Opt+Cmd+S worth spending by default. Listing
	// it here is what makes it appear in Settings -> Shortcuts so a user can bind
	// it, which is the whole point of allowing an empty `keys`.
	showSnoozeList: { id: 'showSnoozeList', label: 'Show Snoozed Tabs', keys: [] },
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
	moveTabToStart: {
		id: 'moveTabToStart',
		label: 'Move Tab to First',
		keys: ['Meta', 'Alt', '['],
	},
	moveTabToEnd: {
		id: 'moveTabToEnd',
		label: 'Move Tab to Last',
		keys: ['Meta', 'Alt', ']'],
	},
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
} satisfies Record<string, Shortcut>;

/**
 * Every valid shortcut id. Lookups keyed by these unions are compile-checked, so a
 * typo (or a stale name after a rename) surfaces as a type error instead of a
 * silently-undefined shortcut that renders no key hint in the UI.
 */
export type ShortcutId = keyof typeof DEFAULT_SHORTCUTS;
export type TabShortcutId = keyof typeof TAB_SHORTCUTS;
