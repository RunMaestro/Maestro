/**
 * Store Default Values
 *
 * Centralized default values for all stores.
 * Separated for easy modification and testing.
 */

import path from 'path';
import { isWindows } from '../../shared/platformDetection';

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

/**
 * Get the default shell based on the current platform.
 */
export function getDefaultShell(): string {
	// Windows: $SHELL doesn't exist; default to PowerShell
	if (isWindows()) {
		return 'powershell';
	}
	// Unix: Respect user's configured login shell from $SHELL
	const shellPath = process.env.SHELL;
	if (shellPath) {
		const shellName = path.basename(shellPath);
		// Valid Unix shell IDs from shellDetector.ts
		if (['bash', 'zsh', 'fish', 'sh', 'tcsh'].includes(shellName)) {
			return shellName;
		}
	}
	// Fallback to the platform's default shell
	return process.platform === 'darwin' ? 'zsh' : 'bash';
}

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
	sshRemoteIgnorePatterns: ['.git', '.*cache*'],
	sshRemoteHonorGitignore: false,
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
	// TTSR: master runtime switch (AND'd with the `ttsr` Encore flag), globally
	// disabled rule names, interrupt teardown mode, and the built-in rule enable map
	ttsrEnabled: false,
	ttsrDisabledRules: [],
	ttsrContextMode: 'keep',
	ttsrBuiltinRules: {},
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
