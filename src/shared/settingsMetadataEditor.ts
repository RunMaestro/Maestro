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
	crossAgentMentionsWritable: {
		description:
			'When true, agents consulted via @-mention may modify files. When false (default), consults run read-only.',
		type: 'boolean',
		default: false,
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
		default: true,
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
	customAICommands: {
		description: 'User-defined slash commands available in AI chat (e.g., /commit).',
		type: 'array',
		default: [],
		category: 'editor',
	},
};
