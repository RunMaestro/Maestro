/**
 * Settings Metadata
 *
 * Centralized metadata for all Maestro settings, used by both
 * the CLI (settings commands) and the main process (defaults).
 *
 * Each entry provides:
 *  - description: human-readable explanation for LLM context and CLI --verbose output
 *  - type: the expected JS type or union (for display/validation)
 *  - default: the default value (or a function returning one for platform-dependent defaults)
 *  - sensitive: true for keys that should be masked in list output
 *  - category: logical grouping for organized display
 */

import path from 'path';
import { isWindows } from './platformDetection';

// ============================================================================
// Types
// ============================================================================

export type SettingType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export interface SettingMetadata {
	description: string;
	type: SettingType;
	default: unknown;
	sensitive?: boolean;
	category: SettingCategory;
}

export type SettingCategory =
	| 'appearance'
	| 'editor'
	| 'shell'
	| 'notifications'
	| 'updates'
	| 'logging'
	| 'web'
	| 'ssh'
	| 'stats'
	| 'accessibility'
	| 'document-graph'
	| 'context'
	| 'file-indexing'
	| 'integrations'
	| 'onboarding'
	| 'advanced'
	| 'internal';

// ============================================================================
// Platform-dependent defaults
// ============================================================================

function getDefaultShell(): string {
	if (isWindows()) {
		return 'powershell';
	}
	const shellPath = process.env.SHELL;
	if (shellPath) {
		const shellName = path.basename(shellPath);
		if (['bash', 'zsh', 'fish', 'sh', 'tcsh'].includes(shellName)) {
			return shellName;
		}
	}
	return 'bash';
}

// ============================================================================
// Settings Registry
// ============================================================================

export const SETTINGS_METADATA: Record<string, SettingMetadata> = {
	// --- Appearance ---
	activeThemeId: {
		description:
			'Color theme for the UI. Built-in themes include dracula, monokai, solarized-dark, nord, and others.',
		type: 'string',
		default: 'dracula',
		category: 'appearance',
	},
	customThemeColors: {
		description: 'Custom color overrides when using a user-defined theme.',
		type: 'object',
		default: {},
		category: 'appearance',
	},
	customThemeBaseId: {
		description: 'Base theme ID to extend when creating a custom theme.',
		type: 'string',
		default: 'dracula',
		category: 'appearance',
	},
	fontSize: {
		description: 'Base font size in pixels. Affects all UI text via rem scaling.',
		type: 'number',
		default: 14,
		category: 'appearance',
	},
	fontFamily: {
		description: 'Font family for the UI. Accepts any CSS font-family string.',
		type: 'string',
		default: 'Roboto Mono, Menlo, "Courier New", monospace',
		category: 'appearance',
	},
	customFonts: {
		description: 'List of user-installed custom font names available in the font picker.',
		type: 'array',
		default: [],
		category: 'appearance',
	},
	colorBlindMode: {
		description: 'Enable colorblind-friendly palettes for status indicators and charts.',
		type: 'boolean',
		default: false,
		category: 'accessibility',
	},
	userMessageAlignment: {
		description: 'Alignment of user messages in the AI chat view.',
		type: 'string',
		default: 'right',
		category: 'appearance',
	},
	useNativeTitleBar: {
		description: 'Use the OS-native title bar instead of the custom frameless title bar.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	autoHideMenuBar: {
		description: 'Auto-hide the menu bar (press Alt to show). Only applies on Windows/Linux.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	showAgentName: {
		description: 'Show the agent name in the main header.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showSessionIdPill: {
		description:
			'Show the provider session ID pill (short hash, e.g. "B778BF42") in the main header.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	showSessionCostPill: {
		description: 'Show the per-session running cost pill (e.g. "$21.33") in the main header.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showWorktreePill: {
		description: 'Show the WORKTREE badge next to worktree child agents in the left panel.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	showWorktreeBranchName: {
		description: 'Show the branch name beneath worktree child agents in the left panel.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	showStarredSessionsSection: {
		description:
			'Show a "Starred Sessions" section at the top of the left side bar listing every starred AI tab across all agents.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showLeftPanelGroupMemberCount: {
		description:
			'Show a member count in parentheses after each group name in the left side bar (e.g. "UNGROUPED AGENTS (24)").',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	leftPanelCollapsedPillsPerRow: {
		description:
			'Maximum number of collapsed-group activity pills per row in the left side bar before wrapping to a new row. Range: 5-50.',
		type: 'number',
		default: 20,
		category: 'appearance',
	},
	showLeftPanelLocationPills: {
		description:
			'Show the REMOTE / LOCAL / GIT location pills next to agents in the left side bar.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showLeftPanelGitIndicator: {
		description:
			'Show the git change indicator (branch icon + dirty file count) next to agents in the left side bar.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showLeftPanelCueIndicator: {
		description:
			'Show the Maestro Cue activity indicator (lightning bolt) next to agents with active Cue subscriptions in the left side bar. Hidden when the Maestro Cue Encore Feature is disabled.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showLeftPanelStartupCommandIndicator: {
		description:
			'Show the terminal prompt glyph (>_) next to agents that have at least one terminal tab with a saved startup command.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showGroupLabelInBookmarks: {
		description:
			'Show the group badge (e.g. "CCS") next to bookmarked agents in the left side bar. Turn off to hide the group pill entirely.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	showFullGroupLabelInBookmarks: {
		description:
			'Show the full group name (e.g. "[2] CASE/CONTENT-SYSTEM") instead of the abbreviated badge (e.g. "CCS") next to bookmarked agents in the left side bar. Long names are truncated with the complete value available on hover.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	fileEditWordWrap: {
		description:
			'Wrap long lines in the file editor at whitespace boundaries instead of scrolling horizontally.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	fileEditShowLineNumbers: {
		description: 'Show the line-number gutter in the file editor.',
		type: 'boolean',
		default: true,
		category: 'appearance',
	},
	filePreviewToolbarVisibility: {
		description:
			'Per-button visibility map for the file preview / edit toolbar. Keys: save, wordWrap, remoteImages, htmlRender, previewTier, editToggle, copyContent, publishGist, documentGraph, openInBrowser, openInDefault, copyPath.',
		type: 'object',
		default: {
			save: true,
			wordWrap: true,
			remoteImages: true,
			htmlRender: true,
			previewTier: true,
			editToggle: true,
			copyContent: true,
			publishGist: true,
			documentGraph: true,
			openInBrowser: true,
			openInDefault: true,
			copyPath: true,
		},
		category: 'appearance',
	},
	fileExplorerIconTheme: {
		description: 'Icon theme for the file explorer sidebar. Options: default, material, or none.',
		type: 'string',
		default: 'default',
		category: 'appearance',
	},
	toastWidth: {
		description:
			'Width of toast notifications. Options: small, medium, large, dynamic (default, matches the Right Bar width).',
		type: 'string',
		default: 'dynamic',
		category: 'appearance',
	},
	disableConfetti: {
		description: 'Disable confetti animations for badge unlocks and achievements.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},
	annotatorPenColor: {
		description:
			'Default pen color (hex string) for the image annotator. Seeds from theme accent on first run; user-selected color persists thereafter.',
		type: 'string',
		default: '#9146FF',
		category: 'appearance',
	},
	annotatorPenSize: {
		description: 'Default pen size (in pixels) for the image annotator stroke.',
		type: 'number',
		default: 10,
		category: 'appearance',
	},
	annotatorThinning: {
		description:
			'Image annotator stroke thinning (0–1). Controls how much pressure affects stroke width.',
		type: 'number',
		default: 0.5,
		category: 'appearance',
	},
	annotatorSmoothing: {
		description: 'Image annotator stroke smoothing (0–1). Higher values produce smoother curves.',
		type: 'number',
		default: 0.5,
		category: 'appearance',
	},
	annotatorStreamline: {
		description:
			'Image annotator stroke streamline (0–1). Higher values dampen pointer jitter for steadier lines.',
		type: 'number',
		default: 0.5,
		category: 'appearance',
	},
	annotatorTaperStart: {
		description: 'Image annotator taper distance at the start of a stroke (in pixels).',
		type: 'number',
		default: 0,
		category: 'appearance',
	},
	annotatorTaperEnd: {
		description: 'Image annotator taper distance at the end of a stroke (in pixels).',
		type: 'number',
		default: 0,
		category: 'appearance',
	},
	annotatorTextColor: {
		description: 'Default text color (hex string) for image annotator text labels.',
		type: 'string',
		default: '#9146FF',
		category: 'appearance',
	},
	annotatorTextSize: {
		description: 'Default text size (in pixels) for image annotator text labels.',
		type: 'number',
		default: 24,
		category: 'appearance',
	},
	annotatorTextFont: {
		description: 'Default font family for image annotator text labels (CSS font-family string).',
		type: 'string',
		default: 'sans-serif',
		category: 'appearance',
	},
	annotatorTextBgColor: {
		description:
			'Default background color (hex string) behind image annotator text labels. Empty string means no background.',
		type: 'string',
		default: '',
		category: 'appearance',
	},

	// --- Editor / UI Behavior ---
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

	// --- LLM / Provider ---
	llmProvider: {
		description: 'LLM provider for built-in AI features. E.g., openrouter, anthropic, openai.',
		type: 'string',
		default: 'openrouter',
		category: 'advanced',
	},
	modelSlug: {
		description: 'Model identifier for the selected LLM provider.',
		type: 'string',
		default: 'anthropic/claude-3.5-sonnet',
		category: 'advanced',
	},
	apiKey: {
		description: 'API key for the selected LLM provider.',
		type: 'string',
		default: '',
		sensitive: true,
		category: 'advanced',
	},
	allowConcurrentSend: {
		description:
			'Allow `maestro-cli send --live --force` to dispatch prompts to an agent whose active tab is already busy. Enables concurrent writes to a single agent; off by default because it can interleave responses.',
		type: 'boolean',
		default: false,
		category: 'advanced',
	},

	// --- Shell ---
	defaultShell: {
		description:
			'Default shell for terminal sessions. Auto-detected from $SHELL on Unix, PowerShell on Windows.',
		type: 'string',
		default: getDefaultShell(),
		category: 'shell',
	},
	customShellPath: {
		description: 'Custom path to shell binary. Overrides defaultShell when set.',
		type: 'string',
		default: '',
		category: 'shell',
	},
	shellArgs: {
		description: 'Additional arguments passed to the shell on startup.',
		type: 'string',
		default: '',
		category: 'shell',
	},
	shellEnvVars: {
		description:
			'Extra environment variables injected into shell sessions. Object mapping names to values.',
		type: 'object',
		default: {},
		category: 'shell',
	},
	ghPath: {
		description: 'Custom path to the GitHub CLI (gh) binary.',
		type: 'string',
		default: '',
		category: 'shell',
	},

	// --- Logging ---
	logLevel: {
		description: 'Minimum log level for the system log viewer. Values: debug, info, warn, error.',
		type: 'string',
		default: 'info',
		category: 'logging',
	},
	maxLogBuffer: {
		description: 'Maximum number of log entries kept in memory for the log viewer.',
		type: 'number',
		default: 5000,
		category: 'logging',
	},
	maxOutputLines: {
		description: 'Maximum lines of agent output displayed per message before truncation.',
		type: 'number',
		default: Infinity,
		category: 'logging',
	},
	logViewerSelectedLevels: {
		description: 'Which log levels are visible in the log viewer filter.',
		type: 'array',
		default: ['debug', 'info', 'warn', 'error', 'toast'],
		category: 'logging',
	},

	// --- Notifications ---
	osNotificationsEnabled: {
		description: 'Show OS-level notifications when tasks complete or errors occur.',
		type: 'boolean',
		default: true,
		category: 'notifications',
	},
	audioFeedbackEnabled: {
		description: 'Play audio feedback when tasks complete.',
		type: 'boolean',
		default: false,
		category: 'notifications',
	},
	audioFeedbackCommand: {
		description:
			'Shell command run when a task completes; the summary is piped to stdin. Runs in a shell (pipes/chains work). Maestro context is exposed via env vars: MAESTRO_NOTIFY_AGENT, MAESTRO_NOTIFY_TAB, MAESTRO_NOTIFY_GROUP, MAESTRO_NOTIFY_TASK. Examples: say on macOS, espeak on Linux.',
		type: 'string',
		default: 'say',
		category: 'notifications',
	},
	toastDuration: {
		description: 'How long toast notifications remain visible, in seconds.',
		type: 'number',
		default: 20,
		category: 'notifications',
	},
	idleNotificationEnabled: {
		description:
			'Run a custom command when all agents and Auto Runs finish and Maestro becomes idle.',
		type: 'boolean',
		default: false,
		category: 'notifications',
	},
	idleNotificationCommand: {
		description:
			'Shell command to execute when Maestro becomes idle (no agents or Auto Runs running).',
		type: 'string',
		default: 'say Maestro is idle',
		category: 'notifications',
	},

	// --- Updates & Crash Reporting ---
	checkForUpdatesOnStartup: {
		description:
			'Automatically check for Maestro updates on launch and once per day while running.',
		type: 'boolean',
		default: true,
		category: 'updates',
	},
	autoResumeOnLimit: {
		description:
			'Automatically resume agents that paused on a token, API, or credit limit once the provider window reopens.',
		type: 'boolean',
		default: true,
		category: 'advanced',
	},
	autoResumeCheckIntervalHours: {
		description: 'How often to probe for credit/limit availability before resuming paused agents.',
		type: 'number',
		default: 2,
		category: 'advanced',
	},
	autoResumeGiveUpDays: {
		description:
			'Stop auto-resuming a paused agent after this many days of repeated limits. Probing is cheap, so this is intentionally long.',
		type: 'number',
		default: 7,
		category: 'advanced',
	},
	enableBetaUpdates: {
		description: 'Opt in to beta release channel for early access to new features.',
		type: 'boolean',
		default: false,
		category: 'updates',
	},
	crashReportingEnabled: {
		description: 'Send anonymous crash reports to help improve Maestro (via Sentry).',
		type: 'boolean',
		default: true,
		category: 'updates',
	},

	// --- Web Interface ---
	webAuthEnabled: {
		description: 'Require authentication token for the web/mobile interface.',
		type: 'boolean',
		default: false,
		category: 'web',
	},
	webAuthToken: {
		description: 'Authentication token for the web/mobile interface.',
		type: 'string',
		default: null,
		sensitive: true,
		category: 'web',
	},
	persistentWebLink: {
		description: 'Reuse the same web link token across app restarts.',
		type: 'boolean',
		default: false,
		category: 'web',
	},
	webInterfaceUseCustomPort: {
		description: 'Use a custom port for the web interface instead of auto-assigned.',
		type: 'boolean',
		default: false,
		category: 'web',
	},
	webInterfaceCustomPort: {
		description: 'Custom port number for the web interface when webInterfaceUseCustomPort is true.',
		type: 'number',
		default: 8080,
		category: 'web',
	},

	// --- SSH ---
	sshRemotes: {
		description: 'Configured SSH remote hosts for remote agent execution.',
		type: 'array',
		default: [],
		category: 'ssh',
	},
	defaultSshRemoteId: {
		description: 'ID of the default SSH remote to use for new agents.',
		type: 'string',
		default: null,
		category: 'ssh',
	},
	sshRemoteIgnorePatterns: {
		description: 'Glob patterns to exclude from file indexing on SSH remotes.',
		type: 'array',
		default: ['.git', '.*cache*'],
		category: 'ssh',
	},
	sshRemoteHonorGitignore: {
		description: 'Honor .gitignore files when indexing files on SSH remotes.',
		type: 'boolean',
		default: false,
		category: 'ssh',
	},

	// --- File Indexing ---
	localIgnorePatterns: {
		description: 'Glob patterns to exclude from local file indexing.',
		type: 'array',
		default: ['.git', 'node_modules', '__pycache__'],
		category: 'file-indexing',
	},
	localHonorGitignore: {
		description: 'Honor .gitignore files when indexing local files.',
		type: 'boolean',
		default: true,
		category: 'file-indexing',
	},
	fileTabAutoRefreshEnabled: {
		description: 'Automatically refresh file preview tabs when the underlying file changes.',
		type: 'boolean',
		default: false,
		category: 'file-indexing',
	},

	// --- Auto Run ---
	autoRunDisabled: {
		description:
			'Globally disable Auto Run. When true, prevents all Auto Run operations from starting.',
		type: 'boolean',
		default: false,
		category: 'advanced',
	},
	dotfilesToggleHidden: {
		description:
			'Hide the ".files" (show/hide dotfiles) button in the file explorer toolbar. Intended for corporate/managed installs where dotfiles should remain hidden.',
		type: 'boolean',
		default: false,
		category: 'advanced',
	},
	autoRunInactivityTimeoutMin: {
		description:
			'Minutes of no agent output before the Auto Run watchdog considers a task stalled and force-kills it. Set to 0 to disable the watchdog (unlimited).',
		type: 'number',
		default: 240,
		category: 'advanced',
	},
	autoRunMaxTaskDurationMin: {
		description:
			'Maximum total minutes a single Auto Run task may run before it is force-killed, regardless of output. Catches a stuck-but-chatty agent that keeps emitting output yet never finishes, which would otherwise hang the whole multi-document run. Set to 0 to disable (unlimited).',
		type: 'number',
		default: 480,
		category: 'advanced',
	},

	// --- Built-in AI Command Bundles ---
	speckitEnabled: {
		description:
			'Show bundled Spec Kit slash commands in the AI command autocomplete. Disable to remove them from the slash command picker.',
		type: 'boolean',
		default: true,
		category: 'integrations',
	},
	openspecEnabled: {
		description:
			'Show bundled OpenSpec slash commands in the AI command autocomplete. Disable to remove them from the slash command picker.',
		type: 'boolean',
		default: true,
		category: 'integrations',
	},
	bmadEnabled: {
		description:
			'Show bundled BMAD slash commands in the AI command autocomplete. Disable to remove them from the slash command picker.',
		type: 'boolean',
		default: true,
		category: 'integrations',
	},

	// --- Stats & Tracking ---
	statsCollectionEnabled: {
		description: 'Enable collection of usage statistics shown in the Usage Dashboard.',
		type: 'boolean',
		default: true,
		category: 'stats',
	},
	defaultStatsTimeRange: {
		description: 'Default time range for the Usage Dashboard. Values: day, week, month, year, all.',
		type: 'string',
		default: 'week',
		category: 'stats',
	},
	totalActiveTimeMs: {
		description: 'Cumulative active usage time in milliseconds (auto-tracked).',
		type: 'number',
		default: 0,
		category: 'internal',
	},
	autoRunStats: {
		description: 'Auto Run gamification stats: cumulative time, longest run, badge levels.',
		type: 'object',
		default: {},
		category: 'internal',
	},
	usageStats: {
		description: 'Peak usage stats: max agents, max simultaneous queries, etc.',
		type: 'object',
		default: {},
		category: 'internal',
	},
	onboardingStats: {
		description: 'Onboarding wizard and tour completion analytics.',
		type: 'object',
		default: {},
		category: 'internal',
	},
	keyboardMasteryStats: {
		description: 'Keyboard shortcut mastery gamification progress.',
		type: 'object',
		default: {},
		category: 'internal',
	},
	leaderboardRegistration: {
		description: 'Leaderboard registration info (username, avatar).',
		type: 'object',
		default: null,
		category: 'internal',
	},

	// --- Context Management ---
	contextManagementSettings: {
		description: 'Context grooming settings: auto-groom, max tokens, warning thresholds.',
		type: 'object',
		default: {},
		category: 'context',
	},

	// --- Document Graph ---
	documentGraphShowExternalLinks: {
		description: 'Show external link nodes in the document graph visualization.',
		type: 'boolean',
		default: false,
		category: 'document-graph',
	},
	documentGraphMaxNodes: {
		description: 'Maximum number of nodes displayed in the document graph. Range: 50-1000.',
		type: 'number',
		default: 50,
		category: 'document-graph',
	},
	documentGraphPreviewCharLimit: {
		description: 'Character limit for node preview text in the document graph. Range: 50-500.',
		type: 'number',
		default: 100,
		category: 'document-graph',
	},
	documentGraphLayoutType: {
		description:
			'Layout algorithm for the document graph. Values: mindmap, radial, hierarchical, force.',
		type: 'string',
		default: 'hierarchical',
		category: 'document-graph',
	},

	// --- Accessibility & Performance ---
	preventSleepEnabled: {
		description: 'Prevent the system from sleeping while Maestro is running.',
		type: 'boolean',
		default: false,
		category: 'accessibility',
	},
	disableGpuAcceleration: {
		description: 'Disable GPU hardware acceleration. May fix rendering issues on some systems.',
		type: 'boolean',
		default: false,
		category: 'accessibility',
	},

	// --- Onboarding ---
	tourCompleted: {
		description: 'Whether the user has completed the onboarding tour.',
		type: 'boolean',
		default: false,
		category: 'onboarding',
	},
	firstAutoRunCompleted: {
		description: 'Whether the user has completed their first Auto Run.',
		type: 'boolean',
		default: false,
		category: 'onboarding',
	},
	ungroupedCollapsed: {
		description: 'Whether the "Ungrouped" section in the left bar is collapsed.',
		type: 'boolean',
		default: false,
		category: 'onboarding',
	},
	groupChatsExpanded: {
		description: 'Whether the "Group Chats" section in the left bar is expanded.',
		type: 'boolean',
		default: true,
		category: 'onboarding',
	},
	groupChatSortAlphabetical: {
		description:
			'Sort group chats alphabetically (true) instead of by most recent activity (false).',
		type: 'boolean',
		default: false,
		category: 'onboarding',
	},
	starredSessionsCollapsed: {
		description: 'Whether the "Starred Sessions" section in the left bar is collapsed.',
		type: 'boolean',
		default: false,
		category: 'onboarding',
	},
	bookmarksCollapsed: {
		description: 'Whether the "Bookmarks" section in the left bar is collapsed.',
		type: 'boolean',
		default: false,
		category: 'onboarding',
	},

	// --- Integrations ---
	wakatimeEnabled: {
		description: 'Enable WakaTime integration for coding activity tracking.',
		type: 'boolean',
		default: false,
		category: 'integrations',
	},
	wakatimeApiKey: {
		description: 'WakaTime API key for activity tracking.',
		type: 'string',
		default: '',
		sensitive: true,
		category: 'integrations',
	},
	wakatimeDetailedTracking: {
		description: 'Send detailed file-level events to WakaTime (not just heartbeats).',
		type: 'boolean',
		default: false,
		category: 'integrations',
	},

	// --- Browser ---
	useSystemBrowser: {
		description:
			'Controls the default browser for clicking links. Ctrl+click shows a context menu to choose the browser.',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	browserHomeUrl: {
		description: 'The default URL loaded when opening a new browser tab.',
		type: 'string',
		default: 'https://runmaestro.ai/#leaderboard',
		category: 'editor',
	},
	htmlDoubleClickOpensInBrowser: {
		description:
			'When enabled, double-clicking an HTML file in the file explorer opens it in the Maestro browser instead of the file preview.',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	browserTabKeepAlive: {
		description:
			"How background browser tabs are handled when inactive. 'off' unloads them (lowest memory, page reloads on return); 'recent' keeps the N most-recently-used tabs alive; 'all' keeps every browser tab in the agent alive.",
		type: 'string',
		default: 'off',
		category: 'editor',
	},
	browserTabKeepAliveLimit: {
		description: "How many recent browser tabs to keep alive when browserTabKeepAlive is 'recent'.",
		type: 'number',
		default: 10,
		category: 'editor',
	},

	// --- Encore Features (experimental) ---
	encoreFeatures: {
		description: 'Feature flags for experimental/encore features. Object with boolean flags.',
		type: 'object',
		default: {
			directorNotes: false,
			usageStats: true,
			symphony: true,
			maestroCue: false,
			pianola: false,
			plugins: false,
			coworking: false,
			opencodeServer: false,
			concerto: false,
			groupsPlus: false,
			ttsr: false,
		},
		category: 'advanced',
	},
	directorNotesSettings: {
		description: "Director's Notes settings: provider, lookback window, default reading mode.",
		type: 'object',
		default: { provider: 'claude-code', defaultLookbackDays: 7, defaultMode: 'rich' },
		category: 'advanced',
	},
	ttsrEnabled: {
		description:
			'Time-Traveling Stream Rules: watch agent output streams and interrupt turns that match a rule. AND-gated with the ttsr Encore feature flag.',
		type: 'boolean',
		default: false,
		category: 'advanced',
	},
	ttsrDisabledRules: {
		description:
			'TTSR rule names disabled globally. Rules listed here are loaded but never matched.',
		type: 'array',
		default: [],
		category: 'advanced',
	},
	ttsrContextMode: {
		description:
			"How an interrupted turn is torn down: 'keep' (SIGINT, let the provider commit the partial turn) or 'discard' (hard kill, best-effort pre-commit). Validated in the TTSR normalizer.",
		type: 'string',
		default: 'keep',
		category: 'advanced',
	},
	ttsrBuiltinRules: {
		description:
			'Per-rule enable map for TTSR built-in starter rules, keyed by rule name. Missing rules default to disabled.',
		type: 'object',
		default: {},
		category: 'advanced',
	},
	coworkingBrowserInteraction: {
		description:
			'Agent ids (ToolType values) for which Coworking browser interaction tools are allowed. Empty array means all off.',
		type: 'array',
		default: [],
		category: 'advanced',
	},
	coworkingBrowserInteractionConfirm: {
		description:
			'Per-agent policy (off | dangerous | all) for requiring per-call user approval of Coworking browser interaction ops. Missing agents default to "dangerous" (confirm navigate and eval).',
		type: 'object',
		default: {},
		category: 'advanced',
	},
	coworkingBackgroundBrowsers: {
		description:
			'Opt-in: keep hidden background <webview>s alive so a Coworking agent can read and drive its own browser tabs while you are focused on a different agent. Each is a full renderer process.',
		type: 'boolean',
		default: false,
		category: 'advanced',
	},
	coworkingBackgroundBrowsersLimit: {
		description:
			'Maximum number of background Coworking webviews kept alive at once (LRU-evicted, clamped 1-10).',
		type: 'number',
		default: 2,
		category: 'advanced',
	},

	// --- System ---
	installationId: {
		description: 'Unique installation identifier generated on first run. Do not modify.',
		type: 'string',
		default: null,
		category: 'internal',
	},
	suppressWindowsWarning: {
		description: 'Suppress the Windows experimental support warning dialog.',
		type: 'boolean',
		default: false,
		category: 'internal',
	},
	lastSelectedPromptId: {
		description:
			'ID of the prompt most recently edited in Settings → Maestro Prompts. Restored on reopen.',
		type: 'string',
		default: null,
		category: 'internal',
	},
};

// ============================================================================
// Helpers
// ============================================================================

/** All known sensitive setting keys */
export const SENSITIVE_KEYS = new Set(
	Object.entries(SETTINGS_METADATA)
		.filter(([, meta]) => meta.sensitive)
		.map(([key]) => key)
);

/** All setting categories in display order */
export const CATEGORY_LABELS: Record<SettingCategory, string> = {
	appearance: 'Appearance',
	editor: 'Editor & UI',
	shell: 'Shell & Terminal',
	notifications: 'Notifications',
	updates: 'Updates & Reporting',
	logging: 'Logging',
	web: 'Web Interface',
	ssh: 'SSH Remote',
	stats: 'Stats & Tracking',
	accessibility: 'Accessibility & Performance',
	'document-graph': 'Document Graph',
	context: 'Context Management',
	'file-indexing': 'File Indexing',
	integrations: 'Integrations',
	onboarding: 'Onboarding',
	advanced: 'Advanced',
	internal: 'Internal (auto-managed)',
};

/** Category display order */
export const CATEGORY_ORDER: SettingCategory[] = [
	'appearance',
	'editor',
	'shell',
	'notifications',
	'updates',
	'logging',
	'web',
	'ssh',
	'file-indexing',
	'context',
	'document-graph',
	'stats',
	'accessibility',
	'integrations',
	'onboarding',
	'advanced',
	'internal',
];

/**
 * Get the default value for a setting key.
 * Returns undefined for unknown keys.
 */
export function getSettingDefault(key: string): unknown {
	return SETTINGS_METADATA[key]?.default;
}

/**
 * Get metadata for a setting key.
 * Returns undefined for unknown keys.
 */
export function getSettingMetadata(key: string): SettingMetadata | undefined {
	return SETTINGS_METADATA[key];
}

/**
 * Build a complete defaults object from the metadata registry.
 */
export function getAllDefaults(): Record<string, unknown> {
	const defaults: Record<string, unknown> = {};
	for (const [key, meta] of Object.entries(SETTINGS_METADATA)) {
		defaults[key] = meta.default;
	}
	return defaults;
}
