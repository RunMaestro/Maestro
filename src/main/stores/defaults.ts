/**
 * Store Default Values
 *
 * Centralized default values for all stores.
 * Separated for easy modification and testing.
 */

import {
	DEFAULT_SSH_REMOTE_HONOR_GITIGNORE,
	DEFAULT_SSH_REMOTE_IGNORE_PATTERNS,
	resolveDefaultShell,
} from '../../shared/settingsMetadata';

import type {
	MaestroSettings,
	SessionsData,
	GroupsData,
	AgentConfigsData,
	AgentCapabilitiesData,
	WindowState,
	ClaudeSessionOriginsData,
	AgentSessionOriginsData,
} from './types';

// ============================================================================
// Utility Functions for Defaults
// ============================================================================

/** Shared platform-aware shell resolver, retained as the main-store API. */
export const getDefaultShell = resolveDefaultShell;

// ============================================================================
// Store Defaults
// ============================================================================

export const SETTINGS_DEFAULTS: MaestroSettings = {
	activeThemeId: 'dracula',
	llmProvider: 'openrouter',
	modelSlug: 'anthropic/claude-3.5-sonnet',
	apiKey: '',
	shortcuts: {},
	fontSize: 14,
	fontFamily: 'Roboto Mono, Menlo, "Courier New", monospace',
	customFonts: [],
	logLevel: 'info',
	defaultShell: getDefaultShell(),
	webAuthEnabled: false,
	webAuthToken: null,
	persistentWebLink: false,
	webInterfaceUseCustomPort: false,
	webInterfaceCustomPort: 8080,
	sshRemotes: [],
	defaultSshRemoteId: null,
	sshRemoteIgnorePatterns: [...DEFAULT_SSH_REMOTE_IGNORE_PATTERNS],
	sshRemoteHonorGitignore: DEFAULT_SSH_REMOTE_HONOR_GITIGNORE,
	installationId: null,
	wakatimeEnabled: false,
	wakatimeApiKey: '',
	wakatimeDetailedTracking: false,
	totalActiveTimeMs: 0,
	lastSelectedPromptId: null,
	modalSizes: {},
	spellCheck: false,
	usageRefreshIntervals: {},
	annotatorPenColor: '#9146FF',
	annotatorPenSize: 10,
	annotatorThinning: 0.5,
	annotatorSmoothing: 0.5,
	annotatorStreamline: 0.5,
	annotatorTaperStart: 0,
	annotatorTaperEnd: 0,
	annotatorTextColor: '#9146FF',
	annotatorTextSize: 24,
	annotatorTextFont: 'sans-serif',
	annotatorTextBgColor: '',
	globalShowHotkey: [],
	// Coworking: agent ids allowed to use browser interaction tools (empty = all off)
	coworkingBrowserInteraction: [],
	// Coworking: per-agent browser-interaction per-call confirm policy (off|dangerous|all; default dangerous)
	coworkingBrowserInteractionConfirm: {},
	// Coworking: opt-in background webview host for cross-session browser access + LRU cap
	coworkingBackgroundBrowsers: false,
	coworkingBackgroundBrowsersLimit: 2,
	// Auto-resume agents that paused on a token/API/credit limit
	autoResumeOnLimit: true,
	autoResumeCheckIntervalHours: 2,
	autoResumeGiveUpDays: 7,
};

export const SESSIONS_DEFAULTS: SessionsData = {
	sessions: [],
};

export const GROUPS_DEFAULTS: GroupsData = {
	groups: [],
};

export const AGENT_CONFIGS_DEFAULTS: AgentConfigsData = {
	configs: {},
};

export const AGENT_CAPABILITIES_DEFAULTS: AgentCapabilitiesData = {
	snapshots: {},
};

export const WINDOW_STATE_DEFAULTS: WindowState = {
	width: 1400,
	height: 900,
	isMaximized: false,
	isFullScreen: false,
};

export const CLAUDE_SESSION_ORIGINS_DEFAULTS: ClaudeSessionOriginsData = {
	origins: {},
};

export const AGENT_SESSION_ORIGINS_DEFAULTS: AgentSessionOriginsData = {
	origins: {},
};
