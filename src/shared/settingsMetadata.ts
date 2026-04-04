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
	fileExplorerIconTheme: {
		description: 'Icon theme for the file explorer sidebar. Options: default, material, or none.',
		type: 'string',
		default: 'default',
		category: 'appearance',
	},
	disableConfetti: {
		description: 'Disable confetti animations for badge unlocks and achievements.',
		type: 'boolean',
		default: false,
		category: 'appearance',
	},

	// --- Editor / UI Behavior ---
	conductorProfile: {
		description: 'Custom persona/instructions for the conductor (system prompt context).',
		type: 'string',
		default: '',
		category: 'editor',
	},
	enterToSendAI: {
		description:
			'When true, pressing Enter sends messages in AI mode. When false, Ctrl+Enter sends.',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	enterToSendTerminal: {
		description: 'When true, pressing Enter sends commands in terminal mode.',
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
	autoScrollAiMode: {
		description: 'Automatically scroll to the bottom when new AI output arrives.',
		type: 'boolean',
		default: false,
		category: 'editor',
	},
	automaticTabNamingEnabled: {
		description: 'Automatically name tabs based on the first message or task.',
		type: 'boolean',
		default: true,
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
		default: 25,
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
		description: 'Shell command used for audio feedback (e.g., say on macOS, espeak on Linux).',
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

	// --- Updates & Crash Reporting ---
	checkForUpdatesOnStartup: {
		description: 'Automatically check for Maestro updates on launch.',
		type: 'boolean',
		default: true,
		category: 'updates',
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
		description: 'Layout algorithm for the document graph. Values: mindmap, radial, force.',
		type: 'string',
		default: 'mindmap',
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

	// --- Encore Features (experimental) ---
	encoreFeatures: {
		description: 'Feature flags for experimental/encore features. Object with boolean flags.',
		type: 'object',
		default: { directorNotes: false },
		category: 'advanced',
	},
	directorNotesSettings: {
		description: "Director's Notes settings: provider, lookback window.",
		type: 'object',
		default: { provider: 'claude-code', defaultLookbackDays: 7 },
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
