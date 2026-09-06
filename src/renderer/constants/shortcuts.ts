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
	// Id kept as `toggleMode` on purpose. It stopped toggling in afad8e7be (March
	// 2026) and now opens a terminal tab, but the id is what persisted custom
	// bindings key off - renaming it would orphan every saved override and
	// silently drop the user back to the default, which is a worse bug than a
	// stale name. Only the label moves.
	toggleMode: { id: 'toggleMode', label: 'New Terminal Tab', keys: ['Meta', 'j'] },
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
	refreshGitFileState: {
		id: 'refreshGitFileState',
		label: 'Refresh Files, Git, History',
		keys: ['Alt', 'Meta', 'r'],
	},
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
	// Back on Cmd+Shift+J, the chord this action ORIGINALLY shipped with
	// (b37423abf) and the one most installs never actually left - the Opt+J-era
	// migration missed them, so they kept it through both the Opt+J and
	// Opt+Cmd+Down eras. What made Cmd+Shift+J look unavailable was the tiling
	// family briefly claiming it; that family now lives on Ctrl+Cmd with the rest
	// of the pane commands, so the J key is free again. A bare Opt+letter is still
	// off the table here: it types a character while the composer has focus.
	jumpToBottom: { id: 'jumpToBottom', label: 'Jump to Bottom', keys: ['Meta', 'Shift', 'j'] },
	prevTab: { id: 'prevTab', label: 'Previous Tab', keys: ['Meta', 'Shift', '['] },
	nextTab: { id: 'nextTab', label: 'Next Tab', keys: ['Meta', 'Shift', ']'] },
	openImageCarousel: { id: 'openImageCarousel', label: 'Open Image Carousel', keys: ['Meta', 'y'] },
	openImageOrganizer: {
		id: 'openImageOrganizer',
		label: 'Open Image Organizer',
		keys: ['Meta', 'Shift', 'y'],
	},
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
	openSymphony: { id: 'openSymphony', label: 'Maestro Symphony', keys: ['Meta', 'Alt', 'y'] },
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
		// NOT Cmd+Shift+Down: that chord is in RESERVED_SHORTCUT_COMBOS (macOS
		// select-to-bottom inside a text field), so the new load-time guard strips
		// it and the action would arrive unbound. Alt+Meta+ArrowDown is free.
		keys: ['Alt', 'Meta', 'ArrowDown'],
	},
	// Ships unbound. Opt+U and Cmd+U already drive the two filters separately,
	// so claiming a third chord by default would spend a key for a convenience
	// most users reach from the palette. Listing it here is what makes it
	// bindable in Settings -> Shortcuts.
	toggleUnreadFilters: {
		id: 'toggleUnreadFilters',
		label: 'Unread Only (Agents + Tabs)',
		keys: [],
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
	// The "tile a NEW tab" family. All four live on Ctrl+Cmd, alongside the pane
	// commands above, because that is literally what they do: Ctrl+Cmd+D splits
	// the current view, and each of these splits it AND puts a new tab of one kind
	// in the bottom half. The letter is the same mnemonic the plain "new tab"
	// chord uses (Cmd+J terminal, Cmd+B browser), so the tiled twin is the same
	// letter one modifier over.
	//
	// Ctrl+Cmd is the only modifier pair Maestro can express for a family like
	// this. `eventMatchesShortcutKeys` folds Meta and Ctrl into ONE modifier so a
	// single table serves macOS and Windows, which means Ctrl+Opt is not a
	// distinct chord there - on Windows it IS Cmd+Opt, where these letters already
	// carry Tab Switcher, Jump to Nearest Terminal and Search All Tabs. These are
	// matched by isPaneShortcut, which requires BOTH physical modifiers, so they
	// never fire on the plain-Cmd equivalents.
	//
	// The terminal one previously shipped on Cmd+Shift+J, reasoned as "one
	// modifier away from Cmd+J". That reasoning held against the defaults table
	// and not against real installs: Cmd+Shift+J was jumpToBottom's ORIGINAL
	// default (b37423abf), and the migration that later moved it only covered the
	// Opt+J era, so every install predating that still held Cmd+Shift+J for Jump
	// to Bottom and got two live actions on one key. Jump to Bottom now owns that
	// chord outright and the whole tiling family sits here instead.
	tileTerminalBelow: {
		id: 'tileTerminalBelow',
		label: 'Tile New Terminal Below',
		keys: ['Control', 'Meta', 'j'],
		windowScoped: true,
	},
	tileAiBelow: {
		id: 'tileAiBelow',
		label: 'Tile New AI Chat Below',
		keys: ['Control', 'Meta', 't'],
		windowScoped: true,
	},
	tileBrowserBelow: {
		id: 'tileBrowserBelow',
		label: 'Tile New Browser Below',
		keys: ['Control', 'Meta', 'b'],
		windowScoped: true,
	},
	tileFileBelow: {
		id: 'tileFileBelow',
		label: 'Tile New File Below',
		keys: ['Control', 'Meta', 'f'],
		windowScoped: true,
	},

	// Registered unassigned: the snoozed-tab list is reachable by click today and
	// there is no spare chord near Opt+Cmd+S worth spending by default. Listing
	// it here is what makes it appear in Settings -> Shortcuts so a user can bind
	// it, which is the whole point of allowing an empty `keys`.
	showSnoozeList: { id: 'showSnoozeList', label: 'Show Snoozed Tabs', keys: [] },

	// Media player. All four ship unbound: the player is a floating widget most
	// users reach by opening a file, so claiming four default chords for it would
	// spend keys nobody asked for. Listing them is what puts them in
	// Settings -> Shortcuts for anyone who lives in the queue.
	openMediaPlayer: { id: 'openMediaPlayer', label: 'Open Media Player', keys: [] },
	mediaPlayPause: { id: 'mediaPlayPause', label: 'Media: Play / Pause', keys: [] },
	mediaNext: { id: 'mediaNext', label: 'Media: Next Track', keys: [] },
	mediaPrev: { id: 'mediaPrev', label: 'Media: Previous Track', keys: [] },

	// Palette-only actions that had no keyboard route at all. Same reasoning:
	// registered so they can be bound, unbound so nothing is claimed by default.
	openLeaderboard: { id: 'openLeaderboard', label: 'Open Leaderboard', keys: [] },
	clearAllNotifications: {
		id: 'clearAllNotifications',
		label: 'Clear All Notifications',
		keys: [],
	},
	openThemeSettings: { id: 'openThemeSettings', label: 'Open Theme Settings', keys: [] },
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
	renameAgentSession: {
		id: 'renameAgentSession',
		label: 'Rename Session (in Sessions Browser)',
		keys: ['Meta', 'e'],
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
