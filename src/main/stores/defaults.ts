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

/** The settings shape `resolveConfiguredShell` needs. Kept structural so both
 * the real electron-store and a test double satisfy it. */
export interface ShellSettingsReader {
	get(key: 'defaultShell', defaultValue: string): string;
	get(key: 'customShellPath', defaultValue: string): string;
}

/**
 * The shell a one-off command actually runs in: the user's explicit custom
 * shell path when they set one, otherwise their selected shell, otherwise the
 * platform default.
 *
 * Shared because `process:runCommand` and AI command mode must agree. The
 * suggestion prompt names this shell to the model, so if the two ever resolved
 * differently the model would be told `zsh` while the command ran under
 * PowerShell - and the answer would be syntactically wrong through no fault of
 * the model.
 */
export function resolveConfiguredShell(store: ShellSettingsReader): string {
	const customShellPath = store.get('customShellPath', '');
	if (customShellPath && customShellPath.trim()) return customShellPath.trim();
	return store.get('defaultShell', getDefaultShell());
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
	terminalFontFamily: '',
	chatFontFamily: '',
	filePreviewFontFamily: '',
	fileEditorFontFamily: '',
	chatFontSize: 0,
	terminalFontSize: 0,
	filePreviewFontSize: 0,
	fileEditorFontSize: 0,
	fontZoom: 1,
	typographyPromptSeen: false,
	customFonts: [],
	mediaPlaybackRate: 1,
	mediaPlayerFloatRect: null,
	mediaPlayerQueue: null,
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
	concertoStageFloating: false,
	concertoStagePosition: null,
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
	// Utility agent for auxiliary tasks (tab naming, context grooming); null = use session agent
	utilityAgentId: null,
	utilityModelId: null,
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
