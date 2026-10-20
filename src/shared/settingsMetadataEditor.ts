/**
 * Editor / UI behavior settings metadata (spell check, input behavior, chat display).
 *
 * Part of the settingsMetadata.ts domain-file split, mirroring the settingsStore.ts
 * slice decomposition (see settingsAnnotatorSlice.ts for that pattern).
 */

import type { SettingMetadata } from './settingsMetadata';

export const EDITOR_SETTINGS_METADATA: Record<string, SettingMetadata> = {
	spellCheck: {
		description: 'Enable spell checking in input areas (prompt input, group chat, file editor).',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	conductorProfile: {
		description: 'Custom persona/instructions for the conductor (system prompt context).',
		type: 'string',
		default: '',
		category: 'editor',
	},
	globalShowHotkey: {
		description:
			'System-wide hotkey to summon (show + focus) the Maestro window from any app. Empty array disables it. Stored as a key array (e.g. ["Meta","Shift","M"]); Meta maps to Cmd on macOS / Win on Windows.',
		type: 'array',
		default: [],
		category: 'accessibility',
	},
	enterToSendAI: {
		description:
			'When true, pressing Enter sends messages in AI mode. When false, Ctrl+Enter sends.',
		type: 'boolean',
		default: true,
		category: 'editor',
	},
	enterToSendAIExpanded: {
		description:
			'When true, pressing Enter sends messages in the expanded Prompt Composer. When false, Ctrl+Enter sends.',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	sendButtonMenu: {
		description:
			'When true (default), clicking Send while the agent is working opens a menu to Queue, Force Send, Steer, or Queue Held. When false, a click always sends at once, the same as Enter.',
		type: 'boolean',
		default: true,
		category: 'editor',
	},
	crossAgentMentionsWritable: {
		description:
			'When true, an @-mention is a delegation: the mentioned agent may modify files. When false (default), it is a consult and runs read-only.',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	crossAgentHandoffsWritable: {
		description:
			'When true (default), a hand-off ("then send what you find to @agent") may modify files in the receiving agent\'s workspace. When false, hand-offs run read-only like consults.',
		type: 'boolean',
		default: true,
		category: 'editor',
	},
	defaultSaveToHistory: {
		description: 'Whether completed tasks are saved to history by default.',
		type: 'boolean',
		default: true,
		category: 'editor',
	},
	synopsisDebounceSeconds: {
		description:
			'Seconds of idle time to wait after a task completes before generating its History synopsis. Rapid back-to-back completions are coalesced into one synopsis. 0 generates a synopsis immediately after each completion.',
		type: 'number',
		default: 0,
		category: 'editor',
	},
	defaultShowThinking: {
		description: 'Show model thinking/reasoning in responses. Values: off, on, sticky.',
		type: 'string',
		default: 'off',
		category: 'editor',
	},
	showToolCalls: {
		description:
			'Show tool-call activity (tool badges and their input/output) in AI responses. When false, tool calls are hidden from the transcript.',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	leftSidebarWidth: {
		description: 'Width of the left sidebar (agent list) in pixels. Range: 256-600.',
		type: 'number',
		default: 256,
		category: 'editor',
	},
	rightPanelWidth: {
		description: 'Width of the right panel (files/history) in pixels.',
		type: 'number',
		default: 384,
		category: 'editor',
	},
	modalSizes: {
		description:
			'Per-modal remembered sizes in pixels, keyed by modal identifier. Values are clamped to the current viewport when used.',
		type: 'object',
		default: {},
		category: 'editor',
	},
	concertoStageFloating: {
		description:
			'Whether the Concerto stage is popped out into a floating window (true) or shown as a centered dialog (false).',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	concertoStagePosition: {
		description:
			'Top-left corner of the popped-out Concerto stage in pixels, as {x, y}. Clamped to the current viewport when used.',
		type: 'object',
		default: null,
		category: 'editor',
	},
	markdownEditMode: {
		description: 'Show raw markdown source instead of rendered markdown in chat.',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	chatRawTextMode: {
		description: 'Display chat as raw text without markdown rendering.',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	groupChatAutoScroll: {
		description: 'Automatically scroll group chats to the newest message when new messages arrive.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	bionifyReadingMode: {
		description:
			'Apply Bionify reading emphasis to opted-in long-form reading surfaces like File Preview and Auto Run.',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	bionifyIntensity: {
		description:
			'Visual strength of Bionify emphasis. Higher values increase emphasis weight and lower the opacity of trailing characters.',
		type: 'number',
		default: 1,
		category: 'editor',
	},
	bionifyAlgorithm: {
		description:
			'Algorithm string controlling highlighted characters per word length. Format: "+|- len1 len2 len3 len4 fraction".',
		type: 'string',
		default: '- 0 1 1 2 0.4',
		category: 'editor',
	},
	showHiddenFiles: {
		description: 'Show dotfiles and hidden files in the file explorer.',
		type: 'boolean',
		default: true,
		category: 'editor',
	},
	terminalWidth: {
		description: 'Terminal column width for command output formatting.',
		type: 'number',
		default: 100,
		category: 'editor',
	},
	automaticTabNamingEnabled: {
		description: 'Automatically name tabs based on the first message or task.',
		type: 'boolean',
		default: true,
		category: 'editor',
	},
	shortenLongTabNames: {
		description:
			'Cut an auto-generated tab name longer than 40 characters at a word boundary. Off keeps the full name (up to 80 characters).',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	newTabPlacement: {
		description:
			'Where new AI tabs are inserted in the tab bar. "end" appends to the rightmost spot; "after-current" inserts directly to the right of the active tab.',
		type: 'string',
		default: 'end',
		category: 'editor',
	},
	newBrowserTabPlacement: {
		description:
			'Where new browser tabs are inserted in the tab bar. "end" appends to the rightmost spot; "after-current" inserts directly to the right of the active tab.',
		type: 'string',
		default: 'after-current',
		category: 'editor',
	},
	newTerminalPlacement: {
		description:
			'Where new terminal tabs are inserted in the tab bar. "end" appends to the rightmost spot; "after-current" inserts directly to the right of the active tab.',
		type: 'string',
		default: 'after-current',
		category: 'editor',
	},
	openedFilePlacement: {
		description:
			'Where opened file preview tabs are inserted in the tab bar. "end" appends to the rightmost spot; "after-current" inserts directly to the right of the active tab.',
		type: 'string',
		default: 'after-current',
		category: 'editor',
	},
	keyboardMode: {
		description:
			'Which keyboard binding set is live: "default" for Maestro\'s own chords, "vim" for the Vim-flavored set. Exactly one mode is active at a time, and each mode keeps its own customizations.',
		type: 'string',
		default: 'default',
		category: 'editor',
	},
	vimInsertEscapeSequence: {
		description:
			'The characters that leave a text field in Vim mode, typed in quick succession within one second: "jk" by default. The leading characters are retracted from the field and it is blurred, which returns the keyboard to normal mode. Empty switches the behavior off, as does any value shorter than two characters or containing whitespace. Read only while keyboardMode is "vim", and never applied inside a CodeMirror editor or a terminal.',
		type: 'string',
		default: 'jk',
		category: 'editor',
	},
	shortcuts: {
		description: 'Custom keyboard shortcut bindings. Object mapping shortcut IDs to key combos.',
		type: 'object',
		default: {},
		category: 'editor',
	},
	tabShortcuts: {
		description: 'Keyboard shortcuts for tab switching (Cmd/Ctrl+1 through Cmd/Ctrl+9).',
		type: 'object',
		default: {},
		category: 'editor',
	},
	vimShortcuts: {
		description:
			'Vim-mode shortcut overrides. Object mapping shortcut IDs to key combos, and SPARSE: an ID appears only when Vim mode binds it differently from default mode, and every other action keeps its default chord. Only read while keyboardMode is "vim", and never written while it is "default".',
		type: 'object',
		default: {},
		category: 'editor',
	},
	vimTabShortcuts: {
		description:
			'Vim-mode overrides for the tab shortcuts. Same sparse shape and the same rules as vimShortcuts.',
		type: 'object',
		default: {},
		category: 'editor',
	},
	customAICommands: {
		description: 'User-defined slash commands available in AI chat (e.g., /commit).',
		type: 'array',
		default: [],
		category: 'editor',
	},
};
