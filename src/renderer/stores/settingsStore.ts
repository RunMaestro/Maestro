/**
 * settingsStore - Zustand store for all persistent application settings
 *
 * Replaces the 2,088-line useSettings hook with a centralized Zustand store.
 * All settings are loaded once from electron-store via loadAllSettings() and
 * persisted back on each mutation via window.maestro.settings.set().
 *
 * Key advantages:
 * - Selector-based subscriptions: components only re-render when their slice changes
 * - No refs needed: store.getState() gives current state synchronously
 * - Works outside React: services can read/write via getSettingsState()/getSettingsActions()
 * - Single batch load on startup eliminates ~60 individual IPC calls
 *
 * Can be used outside React via useSettingsStore.getState() / useSettingsStore.setState().
 */

import { create } from 'zustand';
import type {
	LLMProvider,
	ThemeId,
	ThemeColors,
	Shortcut,
	CustomAICommand,
	GlobalStats,
	AutoRunStats,
	MaestroUsageStats,
	OnboardingStats,
	LeaderboardRegistration,
	ContextManagementSettings,
	KeyboardMasteryStats,
	ThinkingMode,
	DirectorNotesSettings,
	EncoreFeatureFlags,
} from '../types';
import { DEFAULT_CUSTOM_THEME_COLORS } from '../constants/themes';
import { DEFAULT_SHORTCUTS, TAB_SHORTCUTS, FIXED_SHORTCUTS } from '../constants/shortcuts';
import { getLevelIndex } from '../constants/keyboardMastery';
import { commitCommandPrompt } from '../../prompts';

// ============================================================================
// Default Constants
// ============================================================================

export const DEFAULT_CONTEXT_MANAGEMENT_SETTINGS: ContextManagementSettings = {
	autoGroomContexts: true,
	maxContextTokens: 100000,
	showMergePreview: true,
	groomingTimeout: 60000,
	preferredGroomingAgent: 'fastest',
	contextWarningsEnabled: false,
	contextWarningYellowThreshold: 75,
	contextWarningRedThreshold: 90,
};

export const DEFAULT_GLOBAL_STATS: GlobalStats = {
	totalSessions: 0,
	totalMessages: 0,
	totalInputTokens: 0,
	totalOutputTokens: 0,
	totalCacheReadTokens: 0,
	totalCacheCreationTokens: 0,
	totalCostUsd: 0,
	totalActiveTimeMs: 0,
};

export const DEFAULT_AUTO_RUN_STATS: AutoRunStats = {
	cumulativeTimeMs: 0,
	longestRunMs: 0,
	longestRunTimestamp: 0,
	totalRuns: 0,
	currentBadgeLevel: 0,
	lastBadgeUnlockLevel: 0,
	lastAcknowledgedBadgeLevel: 0,
	badgeHistory: [],
};

export const DEFAULT_USAGE_STATS: MaestroUsageStats = {
	maxAgents: 0,
	maxDefinedAgents: 0,
	maxSimultaneousAutoRuns: 0,
	maxSimultaneousQueries: 0,
	maxQueueDepth: 0,
};

export const DEFAULT_KEYBOARD_MASTERY_STATS: KeyboardMasteryStats = {
	usedShortcuts: [],
	currentLevel: 0,
	lastLevelUpTimestamp: 0,
	lastAcknowledgedLevel: 0,
};

const TOTAL_SHORTCUTS_COUNT =
	Object.keys(DEFAULT_SHORTCUTS).length +
	Object.keys(TAB_SHORTCUTS).length +
	Object.keys(FIXED_SHORTCUTS).length;

export const DEFAULT_ONBOARDING_STATS: OnboardingStats = {
	wizardStartCount: 0,
	wizardCompletionCount: 0,
	wizardAbandonCount: 0,
	wizardResumeCount: 0,
	averageWizardDurationMs: 0,
	totalWizardDurationMs: 0,
	lastWizardCompletedAt: 0,
	tourStartCount: 0,
	tourCompletionCount: 0,
	tourSkipCount: 0,
	tourStepsViewedTotal: 0,
	averageTourStepsViewed: 0,
	totalConversationExchanges: 0,
	averageConversationExchanges: 0,
	totalConversationsCompleted: 0,
	totalPhasesGenerated: 0,
	averagePhasesPerWizard: 0,
	totalTasksGenerated: 0,
	averageTasksPerPhase: 0,
};

export const DEFAULT_ENCORE_FEATURES: EncoreFeatureFlags = {
	directorNotes: false,
};

export const DEFAULT_DIRECTOR_NOTES_SETTINGS: DirectorNotesSettings = {
	provider: 'claude-code',
	defaultLookbackDays: 7,
};

export const DEFAULT_AI_COMMANDS: CustomAICommand[] = [
	{
		id: 'commit',
		command: '/commit',
		description: 'Commit outstanding changes and push up',
		prompt: commitCommandPrompt,
		isBuiltIn: true,
	},
];

// ============================================================================
// Helper Functions
// ============================================================================

export function getBadgeLevelForTime(cumulativeTimeMs: number): number {
	const MINUTE = 60 * 1000;
	const HOUR = 60 * MINUTE;
	const DAY = 24 * HOUR;
	const WEEK = 7 * DAY;
	const MONTH = 30 * DAY;

	const thresholds = [
		15 * MINUTE,
		1 * HOUR,
		8 * HOUR,
		1 * DAY,
		1 * WEEK,
		1 * MONTH,
		3 * MONTH,
		6 * MONTH,
		365 * DAY,
		5 * 365 * DAY,
		10 * 365 * DAY,
	];

	let level = 0;
	for (let i = 0; i < thresholds.length; i++) {
		if (cumulativeTimeMs >= thresholds[i]) {
			level = i + 1;
		} else {
			break;
		}
	}
	return level;
}

// ============================================================================
// Store Types
// ============================================================================

export interface SettingsStoreState {
	settingsLoaded: boolean;
	conductorProfile: string;
	llmProvider: LLMProvider;
	modelSlug: string;
	apiKey: string;
	defaultShell: string;
	customShellPath: string;
	shellArgs: string;
	shellEnvVars: Record<string, string>;
	ghPath: string;
	fontFamily: string;
	fontSize: number;
	activeThemeId: ThemeId;
	customThemeColors: ThemeColors;
	customThemeBaseId: ThemeId;
	enterToSendAI: boolean;
	enterToSendTerminal: boolean;
	defaultSaveToHistory: boolean;
	defaultShowThinking: ThinkingMode;
	leftSidebarWidth: number;
	rightPanelWidth: number;
	markdownEditMode: boolean;
	chatRawTextMode: boolean;
	showHiddenFiles: boolean;
	terminalWidth: number;
	logLevel: string;
	maxLogBuffer: number;
	maxOutputLines: number;
	osNotificationsEnabled: boolean;
	audioFeedbackEnabled: boolean;
	audioFeedbackCommand: string;
	toastDuration: number;
	checkForUpdatesOnStartup: boolean;
	enableBetaUpdates: boolean;
	crashReportingEnabled: boolean;
	logViewerSelectedLevels: string[];
	shortcuts: Record<string, Shortcut>;
	tabShortcuts: Record<string, Shortcut>;
	customAICommands: CustomAICommand[];
	globalStats: GlobalStats;
	autoRunStats: AutoRunStats;
	usageStats: MaestroUsageStats;
	ungroupedCollapsed: boolean;
	tourCompleted: boolean;
	firstAutoRunCompleted: boolean;
	onboardingStats: OnboardingStats;
	leaderboardRegistration: LeaderboardRegistration | null;
	webInterfaceUseCustomPort: boolean;
	webInterfaceCustomPort: number;
	contextManagementSettings: ContextManagementSettings;
	keyboardMasteryStats: KeyboardMasteryStats;
	colorBlindMode: boolean;
	documentGraphShowExternalLinks: boolean;
	documentGraphMaxNodes: number;
	documentGraphPreviewCharLimit: number;
	statsCollectionEnabled: boolean;
	defaultStatsTimeRange: 'day' | 'week' | 'month' | 'year' | 'all';
	preventSleepEnabled: boolean;
	disableGpuAcceleration: boolean;
	disableConfetti: boolean;
	sshRemoteIgnorePatterns: string[];
	sshRemoteHonorGitignore: boolean;
	automaticTabNamingEnabled: boolean;
	fileTabAutoRefreshEnabled: boolean;
	suppressWindowsWarning: boolean;
	autoScrollAiMode: boolean;
	encoreFeatures: EncoreFeatureFlags;
	directorNotesSettings: DirectorNotesSettings;
	wakatimeApiKey: string;
	wakatimeEnabled: boolean;
}

export interface SettingsStoreActions {
	// Simple setters
	setConductorProfile: (value: string) => void;
	setLlmProvider: (value: LLMProvider) => void;
	setModelSlug: (value: string) => void;
	setApiKey: (value: string) => void;
	setDefaultShell: (value: string) => void;
	setCustomShellPath: (value: string) => void;
	setShellArgs: (value: string) => void;
	setShellEnvVars: (value: Record<string, string>) => void;
	setGhPath: (value: string) => void;
	setFontFamily: (value: string) => void;
	setFontSize: (value: number) => void;
	setActiveThemeId: (value: ThemeId) => void;
	setCustomThemeColors: (value: ThemeColors) => void;
	setCustomThemeBaseId: (value: ThemeId) => void;
	setEnterToSendAI: (value: boolean) => void;
	setEnterToSendTerminal: (value: boolean) => void;
	setDefaultSaveToHistory: (value: boolean) => void;
	setDefaultShowThinking: (value: ThinkingMode) => void;
	setLeftSidebarWidth: (value: number) => void;
	setRightPanelWidth: (value: number) => void;
	setMarkdownEditMode: (value: boolean) => void;
	setChatRawTextMode: (value: boolean) => void;
	setShowHiddenFiles: (value: boolean) => void;
	setTerminalWidth: (value: number) => void;
	setMaxOutputLines: (value: number) => void;
	setOsNotificationsEnabled: (value: boolean) => void;
	setAudioFeedbackEnabled: (value: boolean) => void;
	setAudioFeedbackCommand: (value: string) => void;
	setToastDuration: (value: number) => void;
	setCheckForUpdatesOnStartup: (value: boolean) => void;
	setEnableBetaUpdates: (value: boolean) => void;
	setCrashReportingEnabled: (value: boolean) => void;
	setLogViewerSelectedLevels: (value: string[]) => void;
	setShortcuts: (value: Record<string, Shortcut>) => void;
	setTabShortcuts: (value: Record<string, Shortcut>) => void;
	setCustomAICommands: (value: CustomAICommand[]) => void;
	setUngroupedCollapsed: (value: boolean) => void;
	setTourCompleted: (value: boolean) => void;
	setFirstAutoRunCompleted: (value: boolean) => void;
	setLeaderboardRegistration: (value: LeaderboardRegistration | null) => void;
	setWebInterfaceUseCustomPort: (value: boolean) => void;
	setWebInterfaceCustomPort: (value: number) => void;
	setColorBlindMode: (value: boolean) => void;
	setDocumentGraphShowExternalLinks: (value: boolean) => void;
	setDocumentGraphMaxNodes: (value: number) => void;
	setDocumentGraphPreviewCharLimit: (value: number) => void;
	setStatsCollectionEnabled: (value: boolean) => void;
	setDefaultStatsTimeRange: (value: 'day' | 'week' | 'month' | 'year' | 'all') => void;
	setDisableGpuAcceleration: (value: boolean) => void;
	setDisableConfetti: (value: boolean) => void;
	setSshRemoteIgnorePatterns: (value: string[]) => void;
	setSshRemoteHonorGitignore: (value: boolean) => void;
	setAutomaticTabNamingEnabled: (value: boolean) => void;
	setFileTabAutoRefreshEnabled: (value: boolean) => void;
	setSuppressWindowsWarning: (value: boolean) => void;
	setAutoScrollAiMode: (value: boolean) => void;
	setEncoreFeatures: (value: EncoreFeatureFlags) => void;
	setDirectorNotesSettings: (value: DirectorNotesSettings) => void;
	setWakatimeApiKey: (value: string) => void;
	setWakatimeEnabled: (value: boolean) => void;

	// Async setters
	setLogLevel: (value: string) => Promise<void>;
	setMaxLogBuffer: (value: number) => Promise<void>;
	setPreventSleepEnabled: (value: boolean) => Promise<void>;

	// Global stats
	setGlobalStats: (value: GlobalStats) => void;
	updateGlobalStats: (delta: Partial<GlobalStats>) => void;

	// Usage stats
	setUsageStats: (value: MaestroUsageStats) => void;
	updateUsageStats: (currentValues: Partial<MaestroUsageStats>) => void;

	// Auto-run stats
	setAutoRunStats: (value: AutoRunStats) => void;
	recordAutoRunComplete: (elapsedTimeMs: number) => {
		newBadgeLevel: number | null;
		isNewRecord: boolean;
	};
	updateAutoRunProgress: (deltaMs: number) => {
		newBadgeLevel: number | null;
		isNewRecord: boolean;
	};
	acknowledgeBadge: (level: number) => void;
	getUnacknowledgedBadgeLevel: () => number | null;

	// Onboarding stats
	setOnboardingStats: (value: OnboardingStats) => void;
	recordWizardStart: () => void;
	recordWizardComplete: (
		durationMs: number,
		conversationExchanges: number,
		phasesGenerated: number,
		tasksGenerated: number
	) => void;
	recordWizardAbandon: () => void;
	recordWizardResume: () => void;
	recordTourStart: () => void;
	recordTourComplete: (stepsViewed: number) => void;
	recordTourSkip: (stepsViewed: number) => void;
	getOnboardingAnalytics: () => {
		wizardCompletionRate: number;
		tourCompletionRate: number;
		averageConversationExchanges: number;
		averagePhasesPerWizard: number;
	};

	// Context management
	setContextManagementSettings: (value: ContextManagementSettings) => void;
	updateContextManagementSettings: (partial: Partial<ContextManagementSettings>) => void;

	// Keyboard mastery
	setKeyboardMasteryStats: (value: KeyboardMasteryStats) => void;
	recordShortcutUsage: (shortcutId: string) => { newLevel: number | null };
	acknowledgeKeyboardMasteryLevel: (level: number) => void;
	getUnacknowledgedKeyboardMasteryLevel: () => number | null;
}

export type SettingsStore = SettingsStoreState & SettingsStoreActions;

// ============================================================================
// Store Implementation
// ============================================================================

export const useSettingsStore = create<SettingsStore>()((set, get) => ({
	// ============================================================================
	// State (defaults)
	// ============================================================================

	settingsLoaded: false,
	conductorProfile: '',
	llmProvider: 'openrouter',
	modelSlug: 'anthropic/claude-3.5-sonnet',
	apiKey: '',
	defaultShell: 'zsh',
	customShellPath: '',
	shellArgs: '',
	shellEnvVars: {},
	ghPath: '',
	fontFamily: 'Roboto Mono, Menlo, "Courier New", monospace',
	fontSize: 14,
	activeThemeId: 'dracula',
	customThemeColors: DEFAULT_CUSTOM_THEME_COLORS,
	customThemeBaseId: 'dracula',
	enterToSendAI: false,
	enterToSendTerminal: true,
	defaultSaveToHistory: true,
	defaultShowThinking: 'off',
	leftSidebarWidth: 256,
	rightPanelWidth: 384,
	markdownEditMode: false,
	chatRawTextMode: false,
	showHiddenFiles: true,
	terminalWidth: 100,
	logLevel: 'info',
	maxLogBuffer: 5000,
	maxOutputLines: 25,
	osNotificationsEnabled: true,
	audioFeedbackEnabled: false,
	audioFeedbackCommand: 'say',
	toastDuration: 20,
	checkForUpdatesOnStartup: true,
	enableBetaUpdates: false,
	crashReportingEnabled: true,
	logViewerSelectedLevels: ['debug', 'info', 'warn', 'error', 'toast'],
	shortcuts: DEFAULT_SHORTCUTS,
	tabShortcuts: TAB_SHORTCUTS,
	customAICommands: DEFAULT_AI_COMMANDS,
	globalStats: DEFAULT_GLOBAL_STATS,
	autoRunStats: DEFAULT_AUTO_RUN_STATS,
	usageStats: DEFAULT_USAGE_STATS,
	ungroupedCollapsed: false,
	tourCompleted: false,
	firstAutoRunCompleted: false,
	onboardingStats: DEFAULT_ONBOARDING_STATS,
	leaderboardRegistration: null,
	webInterfaceUseCustomPort: false,
	webInterfaceCustomPort: 8080,
	contextManagementSettings: DEFAULT_CONTEXT_MANAGEMENT_SETTINGS,
	keyboardMasteryStats: DEFAULT_KEYBOARD_MASTERY_STATS,
	colorBlindMode: false,
	documentGraphShowExternalLinks: false,
	documentGraphMaxNodes: 50,
	documentGraphPreviewCharLimit: 100,
	statsCollectionEnabled: true,
	defaultStatsTimeRange: 'week',
	preventSleepEnabled: false,
	disableGpuAcceleration: false,
	disableConfetti: false,
	sshRemoteIgnorePatterns: ['.git', '*cache*'],
	sshRemoteHonorGitignore: true,
	automaticTabNamingEnabled: true,
	fileTabAutoRefreshEnabled: false,
	suppressWindowsWarning: false,
	autoScrollAiMode: false,
	encoreFeatures: DEFAULT_ENCORE_FEATURES,
	directorNotesSettings: DEFAULT_DIRECTOR_NOTES_SETTINGS,
	wakatimeApiKey: '',
	wakatimeEnabled: false,

	// ============================================================================
	// Simple Setters
	// ============================================================================

	setConductorProfile: (value) => {
		const trimmed = value.slice(0, 1000);
		set({ conductorProfile: trimmed });
		window.maestro.settings.set('conductorProfile', trimmed);
	},

	setLlmProvider: (value) => {
		set({ llmProvider: value });
		window.maestro.settings.set('llmProvider', value);
	},

	setModelSlug: (value) => {
		set({ modelSlug: value });
		window.maestro.settings.set('modelSlug', value);
	},

	setApiKey: (value) => {
		set({ apiKey: value });
		window.maestro.settings.set('apiKey', value);
	},

	setDefaultShell: (value) => {
		set({ defaultShell: value });
		window.maestro.settings.set('defaultShell', value);
	},

	setCustomShellPath: (value) => {
		set({ customShellPath: value });
		window.maestro.settings.set('customShellPath', value);
	},

	setShellArgs: (value) => {
		set({ shellArgs: value });
		window.maestro.settings.set('shellArgs', value);
	},

	setShellEnvVars: (value) => {
		set({ shellEnvVars: value });
		window.maestro.settings.set('shellEnvVars', value);
	},

	setGhPath: (value) => {
		set({ ghPath: value });
		window.maestro.settings.set('ghPath', value);
	},

	setFontFamily: (value) => {
		set({ fontFamily: value });
		window.maestro.settings.set('fontFamily', value);
	},

	setFontSize: (value) => {
		set({ fontSize: value });
		window.maestro.settings.set('fontSize', value);
	},

	setActiveThemeId: (value) => {
		set({ activeThemeId: value });
		window.maestro.settings.set('activeThemeId', value);
	},

	setCustomThemeColors: (value) => {
		set({ customThemeColors: value });
		window.maestro.settings.set('customThemeColors', value);
	},

	setCustomThemeBaseId: (value) => {
		set({ customThemeBaseId: value });
		window.maestro.settings.set('customThemeBaseId', value);
	},

	setEnterToSendAI: (value) => {
		set({ enterToSendAI: value });
		window.maestro.settings.set('enterToSendAI', value);
	},

	setEnterToSendTerminal: (value) => {
		set({ enterToSendTerminal: value });
		window.maestro.settings.set('enterToSendTerminal', value);
	},

	setDefaultSaveToHistory: (value) => {
		set({ defaultSaveToHistory: value });
		window.maestro.settings.set('defaultSaveToHistory', value);
	},

	setDefaultShowThinking: (value) => {
		set({ defaultShowThinking: value });
		window.maestro.settings.set('defaultShowThinking', value);
	},

	setLeftSidebarWidth: (value) => {
		const clamped = Math.max(256, Math.min(600, value));
		set({ leftSidebarWidth: clamped });
		window.maestro.settings.set('leftSidebarWidth', clamped);
	},

	setRightPanelWidth: (value) => {
		set({ rightPanelWidth: value });
		window.maestro.settings.set('rightPanelWidth', value);
	},

	setMarkdownEditMode: (value) => {
		set({ markdownEditMode: value });
		window.maestro.settings.set('markdownEditMode', value);
	},

	setChatRawTextMode: (value) => {
		set({ chatRawTextMode: value });
		window.maestro.settings.set('chatRawTextMode', value);
	},

	setShowHiddenFiles: (value) => {
		set({ showHiddenFiles: value });
		window.maestro.settings.set('showHiddenFiles', value);
	},

	setTerminalWidth: (value) => {
		set({ terminalWidth: value });
		window.maestro.settings.set('terminalWidth', value);
	},

	setMaxOutputLines: (value) => {
		set({ maxOutputLines: value });
		window.maestro.settings.set('maxOutputLines', value);
	},

	setOsNotificationsEnabled: (value) => {
		set({ osNotificationsEnabled: value });
		window.maestro.settings.set('osNotificationsEnabled', value);
	},

	setAudioFeedbackEnabled: (value) => {
		set({ audioFeedbackEnabled: value });
		window.maestro.settings.set('audioFeedbackEnabled', value);
	},

	setAudioFeedbackCommand: (value) => {
		set({ audioFeedbackCommand: value });
		window.maestro.settings.set('audioFeedbackCommand', value);
	},

	setToastDuration: (value) => {
		set({ toastDuration: value });
		window.maestro.settings.set('toastDuration', value);
	},

	setCheckForUpdatesOnStartup: (value) => {
		set({ checkForUpdatesOnStartup: value });
		window.maestro.settings.set('checkForUpdatesOnStartup', value);
	},

	setEnableBetaUpdates: (value) => {
		set({ enableBetaUpdates: value });
		window.maestro.settings.set('enableBetaUpdates', value);
	},

	setCrashReportingEnabled: (value) => {
		set({ crashReportingEnabled: value });
		window.maestro.settings.set('crashReportingEnabled', value);
	},

	setLogViewerSelectedLevels: (value) => {
		set({ logViewerSelectedLevels: value });
		window.maestro.settings.set('logViewerSelectedLevels', value);
	},

	setShortcuts: (value) => {
		set({ shortcuts: value });
		window.maestro.settings.set('shortcuts', value);
	},

	setTabShortcuts: (value) => {
		set({ tabShortcuts: value });
		window.maestro.settings.set('tabShortcuts', value);
	},

	setCustomAICommands: (value) => {
		set({ customAICommands: value });
		window.maestro.settings.set('customAICommands', value);
	},

	setUngroupedCollapsed: (value) => {
		set({ ungroupedCollapsed: value });
		window.maestro.settings.set('ungroupedCollapsed', value);
	},

	setTourCompleted: (value) => {
		set({ tourCompleted: value });
		window.maestro.settings.set('tourCompleted', value);
	},

	setFirstAutoRunCompleted: (value) => {
		set({ firstAutoRunCompleted: value });
		window.maestro.settings.set('firstAutoRunCompleted', value);
	},

	setLeaderboardRegistration: (value) => {
		set({ leaderboardRegistration: value });
		window.maestro.settings.set('leaderboardRegistration', value);
	},

	setWebInterfaceUseCustomPort: (value) => {
		set({ webInterfaceUseCustomPort: value });
		window.maestro.settings.set('webInterfaceUseCustomPort', value);
	},

	setWebInterfaceCustomPort: (value) => {
		// Store the value as-is during typing; validation happens on blur/submit
		set({ webInterfaceCustomPort: value });
		// Only persist valid port values
		if (value >= 1024 && value <= 65535) {
			window.maestro.settings.set('webInterfaceCustomPort', value);
		}
	},

	setColorBlindMode: (value) => {
		set({ colorBlindMode: value });
		window.maestro.settings.set('colorBlindMode', value);
	},

	setDocumentGraphShowExternalLinks: (value) => {
		set({ documentGraphShowExternalLinks: value });
		window.maestro.settings.set('documentGraphShowExternalLinks', value);
	},

	setDocumentGraphMaxNodes: (value) => {
		const clamped = Math.max(50, Math.min(1000, value));
		set({ documentGraphMaxNodes: clamped });
		window.maestro.settings.set('documentGraphMaxNodes', clamped);
	},

	setDocumentGraphPreviewCharLimit: (value) => {
		const clamped = Math.max(50, Math.min(500, value));
		set({ documentGraphPreviewCharLimit: clamped });
		window.maestro.settings.set('documentGraphPreviewCharLimit', clamped);
	},

	setStatsCollectionEnabled: (value) => {
		set({ statsCollectionEnabled: value });
		window.maestro.settings.set('statsCollectionEnabled', value);
	},

	setDefaultStatsTimeRange: (value) => {
		set({ defaultStatsTimeRange: value });
		window.maestro.settings.set('defaultStatsTimeRange', value);
	},

	setDisableGpuAcceleration: (value) => {
		set({ disableGpuAcceleration: value });
		window.maestro.settings.set('disableGpuAcceleration', value);
	},

	setDisableConfetti: (value) => {
		set({ disableConfetti: value });
		window.maestro.settings.set('disableConfetti', value);
	},

	setSshRemoteIgnorePatterns: (value) => {
		set({ sshRemoteIgnorePatterns: value });
		window.maestro.settings.set('sshRemoteIgnorePatterns', value);
	},

	setSshRemoteHonorGitignore: (value) => {
		set({ sshRemoteHonorGitignore: value });
		window.maestro.settings.set('sshRemoteHonorGitignore', value);
	},

	setAutomaticTabNamingEnabled: (value) => {
		set({ automaticTabNamingEnabled: value });
		window.maestro.settings.set('automaticTabNamingEnabled', value);
	},

	setFileTabAutoRefreshEnabled: (value) => {
		set({ fileTabAutoRefreshEnabled: value });
		window.maestro.settings.set('fileTabAutoRefreshEnabled', value);
	},

	setSuppressWindowsWarning: (value) => {
		set({ suppressWindowsWarning: value });
		window.maestro.settings.set('suppressWindowsWarning', value);
	},

	setAutoScrollAiMode: (value) => {
		set({ autoScrollAiMode: value });
		window.maestro.settings.set('autoScrollAiMode', value);
	},

	setEncoreFeatures: (value) => {
		set({ encoreFeatures: value });
		window.maestro.settings.set('encoreFeatures', value);
	},

	setDirectorNotesSettings: (value) => {
		set({ directorNotesSettings: value });
		window.maestro.settings.set('directorNotesSettings', value);
	},

	setWakatimeApiKey: (value) => {
		set({ wakatimeApiKey: value });
		window.maestro.settings.set('wakatimeApiKey', value);
	},

	setWakatimeEnabled: (value) => {
		set({ wakatimeEnabled: value });
		window.maestro.settings.set('wakatimeEnabled', value);
	},

	// ============================================================================
	// Async Setters
	// ============================================================================

	setLogLevel: async (value) => {
		set({ logLevel: value });
		await window.maestro.logger.setLogLevel(value);
	},

	setMaxLogBuffer: async (value) => {
		set({ maxLogBuffer: value });
		await window.maestro.logger.setMaxLogBuffer(value);
	},

	setPreventSleepEnabled: async (value) => {
		const prev = get().preventSleepEnabled;
		set({ preventSleepEnabled: value });
		try {
			await window.maestro.settings.set('preventSleepEnabled', value);
			await window.maestro.power.setEnabled(value);
		} catch (error) {
			// Rollback on failure so UI stays in sync with actual power state
			set({ preventSleepEnabled: prev });
			throw error; // Let Sentry capture
		}
	},

	// ============================================================================
	// Global Stats Actions
	// ============================================================================

	setGlobalStats: (value) => {
		set({ globalStats: value });
		window.maestro.settings.set('globalStats', value);
	},

	updateGlobalStats: (delta) => {
		const prev = get().globalStats;
		const updated: GlobalStats = {
			totalSessions: prev.totalSessions + (delta.totalSessions || 0),
			totalMessages: prev.totalMessages + (delta.totalMessages || 0),
			totalInputTokens: prev.totalInputTokens + (delta.totalInputTokens || 0),
			totalOutputTokens: prev.totalOutputTokens + (delta.totalOutputTokens || 0),
			totalCacheReadTokens: prev.totalCacheReadTokens + (delta.totalCacheReadTokens || 0),
			totalCacheCreationTokens:
				prev.totalCacheCreationTokens + (delta.totalCacheCreationTokens || 0),
			totalCostUsd: prev.totalCostUsd + (delta.totalCostUsd || 0),
			totalActiveTimeMs: prev.totalActiveTimeMs + (delta.totalActiveTimeMs || 0),
		};
		set({ globalStats: updated });
		window.maestro.settings.set('globalStats', updated);
	},

	// ============================================================================
	// Usage Stats Actions
	// ============================================================================

	setUsageStats: (value) => {
		const prev = get().usageStats;
		const updated: MaestroUsageStats = {
			maxAgents: Math.max(prev.maxAgents, value.maxAgents ?? 0),
			maxDefinedAgents: Math.max(prev.maxDefinedAgents, value.maxDefinedAgents ?? 0),
			maxSimultaneousAutoRuns: Math.max(
				prev.maxSimultaneousAutoRuns,
				value.maxSimultaneousAutoRuns ?? 0
			),
			maxSimultaneousQueries: Math.max(
				prev.maxSimultaneousQueries,
				value.maxSimultaneousQueries ?? 0
			),
			maxQueueDepth: Math.max(prev.maxQueueDepth, value.maxQueueDepth ?? 0),
		};
		set({ usageStats: updated });
		window.maestro.settings.set('usageStats', updated);
	},

	updateUsageStats: (currentValues) => {
		const prev = get().usageStats;
		const updated: MaestroUsageStats = {
			maxAgents: Math.max(prev.maxAgents, currentValues.maxAgents ?? 0),
			maxDefinedAgents: Math.max(prev.maxDefinedAgents, currentValues.maxDefinedAgents ?? 0),
			maxSimultaneousAutoRuns: Math.max(
				prev.maxSimultaneousAutoRuns,
				currentValues.maxSimultaneousAutoRuns ?? 0
			),
			maxSimultaneousQueries: Math.max(
				prev.maxSimultaneousQueries,
				currentValues.maxSimultaneousQueries ?? 0
			),
			maxQueueDepth: Math.max(prev.maxQueueDepth, currentValues.maxQueueDepth ?? 0),
		};
		// Only persist if any value actually changed
		if (
			updated.maxAgents !== prev.maxAgents ||
			updated.maxDefinedAgents !== prev.maxDefinedAgents ||
			updated.maxSimultaneousAutoRuns !== prev.maxSimultaneousAutoRuns ||
			updated.maxSimultaneousQueries !== prev.maxSimultaneousQueries ||
			updated.maxQueueDepth !== prev.maxQueueDepth
		) {
			window.maestro.settings.set('usageStats', updated);
		}
		set({ usageStats: updated });
	},

	// ============================================================================
	// Auto-run Stats Actions
	// ============================================================================

	setAutoRunStats: (value) => {
		set({ autoRunStats: value });
		window.maestro.settings.set('autoRunStats', value);
	},

	recordAutoRunComplete: (elapsedTimeMs) => {
		const prev = get().autoRunStats;

		// Don't add to cumulative time - it was already added incrementally during the run
		// Just check current badge level in case a badge wasn't triggered during incremental updates
		const newBadgeLevelCalc = getBadgeLevelForTime(prev.cumulativeTimeMs);

		// Check if this would be a new badge (edge case: badge threshold crossed between updates)
		let newBadgeLevel: number | null = null;
		if (newBadgeLevelCalc > prev.lastBadgeUnlockLevel) {
			newBadgeLevel = newBadgeLevelCalc;
		}

		// Check if this is a new longest run record
		const isNewRecord = elapsedTimeMs > prev.longestRunMs;

		// Build updated badge history if new badge unlocked
		let updatedBadgeHistory = prev.badgeHistory || [];
		if (newBadgeLevel !== null) {
			updatedBadgeHistory = [
				...updatedBadgeHistory,
				{ level: newBadgeLevel, unlockedAt: Date.now() },
			];
		}

		const updated: AutoRunStats = {
			cumulativeTimeMs: prev.cumulativeTimeMs, // Already updated incrementally
			longestRunMs: isNewRecord ? elapsedTimeMs : prev.longestRunMs,
			longestRunTimestamp: isNewRecord ? Date.now() : prev.longestRunTimestamp,
			totalRuns: prev.totalRuns + 1,
			currentBadgeLevel: newBadgeLevelCalc,
			lastBadgeUnlockLevel: newBadgeLevel !== null ? newBadgeLevelCalc : prev.lastBadgeUnlockLevel,
			lastAcknowledgedBadgeLevel: prev.lastAcknowledgedBadgeLevel ?? 0,
			badgeHistory: updatedBadgeHistory,
		};

		set({ autoRunStats: updated });
		window.maestro.settings.set('autoRunStats', updated);

		return { newBadgeLevel, isNewRecord };
	},

	updateAutoRunProgress: (deltaMs) => {
		const prev = get().autoRunStats;

		// Add the delta to cumulative time
		const newCumulativeTime = prev.cumulativeTimeMs + deltaMs;
		const newBadgeLevelCalc = getBadgeLevelForTime(newCumulativeTime);

		// Check if this unlocks a new badge
		let newBadgeLevel: number | null = null;
		if (newBadgeLevelCalc > prev.lastBadgeUnlockLevel) {
			newBadgeLevel = newBadgeLevelCalc;
		}

		// Build updated badge history if new badge unlocked
		let updatedBadgeHistory = prev.badgeHistory || [];
		if (newBadgeLevel !== null) {
			updatedBadgeHistory = [
				...updatedBadgeHistory,
				{ level: newBadgeLevel, unlockedAt: Date.now() },
			];
		}

		const updated: AutoRunStats = {
			cumulativeTimeMs: newCumulativeTime,
			longestRunMs: prev.longestRunMs, // Don't update until run completes
			longestRunTimestamp: prev.longestRunTimestamp,
			totalRuns: prev.totalRuns, // Don't increment - run not complete yet
			currentBadgeLevel: newBadgeLevelCalc,
			lastBadgeUnlockLevel: newBadgeLevel !== null ? newBadgeLevelCalc : prev.lastBadgeUnlockLevel,
			lastAcknowledgedBadgeLevel: prev.lastAcknowledgedBadgeLevel ?? 0,
			badgeHistory: updatedBadgeHistory,
		};

		set({ autoRunStats: updated });
		window.maestro.settings.set('autoRunStats', updated);

		// Note: isNewRecord is always false during progress - we don't know total run time yet
		return { newBadgeLevel, isNewRecord: false };
	},

	acknowledgeBadge: (level) => {
		const prev = get().autoRunStats;
		const updated: AutoRunStats = {
			...prev,
			lastAcknowledgedBadgeLevel: Math.max(level, prev.lastAcknowledgedBadgeLevel ?? 0),
		};
		set({ autoRunStats: updated });
		window.maestro.settings.set('autoRunStats', updated);
	},

	getUnacknowledgedBadgeLevel: () => {
		const stats = get().autoRunStats;
		const acknowledged = stats.lastAcknowledgedBadgeLevel ?? 0;
		const current = stats.currentBadgeLevel;
		if (current > acknowledged) {
			return current;
		}
		return null;
	},

	// ============================================================================
	// Onboarding Stats Actions
	// ============================================================================

	setOnboardingStats: (value) => {
		set({ onboardingStats: value });
		window.maestro.settings.set('onboardingStats', value);
	},

	recordWizardStart: () => {
		const prev = get().onboardingStats;
		const updated: OnboardingStats = {
			...prev,
			wizardStartCount: prev.wizardStartCount + 1,
		};
		set({ onboardingStats: updated });
		window.maestro.settings.set('onboardingStats', updated);
	},

	recordWizardComplete: (durationMs, conversationExchanges, phasesGenerated, tasksGenerated) => {
		const prev = get().onboardingStats;
		const newCompletionCount = prev.wizardCompletionCount + 1;
		const newTotalDuration = prev.totalWizardDurationMs + durationMs;
		const newTotalExchanges = prev.totalConversationExchanges + conversationExchanges;
		const newTotalPhases = prev.totalPhasesGenerated + phasesGenerated;
		const newTotalTasks = prev.totalTasksGenerated + tasksGenerated;

		const updated: OnboardingStats = {
			...prev,
			wizardCompletionCount: newCompletionCount,
			totalWizardDurationMs: newTotalDuration,
			averageWizardDurationMs: Math.round(newTotalDuration / newCompletionCount),
			lastWizardCompletedAt: Date.now(),

			// Conversation stats
			totalConversationExchanges: newTotalExchanges,
			totalConversationsCompleted: prev.totalConversationsCompleted + 1,
			averageConversationExchanges:
				newCompletionCount > 0 ? Math.round((newTotalExchanges / newCompletionCount) * 10) / 10 : 0,

			// Phase generation stats
			totalPhasesGenerated: newTotalPhases,
			averagePhasesPerWizard:
				newCompletionCount > 0 ? Math.round((newTotalPhases / newCompletionCount) * 10) / 10 : 0,
			totalTasksGenerated: newTotalTasks,
			averageTasksPerPhase:
				newTotalPhases > 0 ? Math.round((newTotalTasks / newTotalPhases) * 10) / 10 : 0,
		};
		set({ onboardingStats: updated });
		window.maestro.settings.set('onboardingStats', updated);
	},

	recordWizardAbandon: () => {
		const prev = get().onboardingStats;
		const updated: OnboardingStats = {
			...prev,
			wizardAbandonCount: prev.wizardAbandonCount + 1,
		};
		set({ onboardingStats: updated });
		window.maestro.settings.set('onboardingStats', updated);
	},

	recordWizardResume: () => {
		const prev = get().onboardingStats;
		const updated: OnboardingStats = {
			...prev,
			wizardResumeCount: prev.wizardResumeCount + 1,
		};
		set({ onboardingStats: updated });
		window.maestro.settings.set('onboardingStats', updated);
	},

	recordTourStart: () => {
		const prev = get().onboardingStats;
		const updated: OnboardingStats = {
			...prev,
			tourStartCount: prev.tourStartCount + 1,
		};
		set({ onboardingStats: updated });
		window.maestro.settings.set('onboardingStats', updated);
	},

	recordTourComplete: (stepsViewed) => {
		const prev = get().onboardingStats;
		const newCompletionCount = prev.tourCompletionCount + 1;
		const newTotalStepsViewed = prev.tourStepsViewedTotal + stepsViewed;
		const totalTours = newCompletionCount + prev.tourSkipCount;

		const updated: OnboardingStats = {
			...prev,
			tourCompletionCount: newCompletionCount,
			tourStepsViewedTotal: newTotalStepsViewed,
			averageTourStepsViewed:
				totalTours > 0 ? Math.round((newTotalStepsViewed / totalTours) * 10) / 10 : stepsViewed,
		};
		set({ onboardingStats: updated });
		window.maestro.settings.set('onboardingStats', updated);
	},

	recordTourSkip: (stepsViewed) => {
		const prev = get().onboardingStats;
		const newSkipCount = prev.tourSkipCount + 1;
		const newTotalStepsViewed = prev.tourStepsViewedTotal + stepsViewed;
		const totalTours = prev.tourCompletionCount + newSkipCount;

		const updated: OnboardingStats = {
			...prev,
			tourSkipCount: newSkipCount,
			tourStepsViewedTotal: newTotalStepsViewed,
			averageTourStepsViewed:
				totalTours > 0 ? Math.round((newTotalStepsViewed / totalTours) * 10) / 10 : stepsViewed,
		};
		set({ onboardingStats: updated });
		window.maestro.settings.set('onboardingStats', updated);
	},

	getOnboardingAnalytics: () => {
		const stats = get().onboardingStats;
		const totalWizardAttempts = stats.wizardStartCount;
		const totalTourAttempts = stats.tourStartCount;

		return {
			wizardCompletionRate:
				totalWizardAttempts > 0
					? Math.round((stats.wizardCompletionCount / totalWizardAttempts) * 100)
					: 0,
			tourCompletionRate:
				totalTourAttempts > 0
					? Math.round((stats.tourCompletionCount / totalTourAttempts) * 100)
					: 0,
			averageConversationExchanges: stats.averageConversationExchanges,
			averagePhasesPerWizard: stats.averagePhasesPerWizard,
		};
	},

	// ============================================================================
	// Context Management Actions
	// ============================================================================

	setContextManagementSettings: (value) => {
		set({ contextManagementSettings: value });
		window.maestro.settings.set('contextManagementSettings', value);
	},

	updateContextManagementSettings: (partial) => {
		const prev = get().contextManagementSettings;
		const updated = { ...prev, ...partial };
		set({ contextManagementSettings: updated });
		window.maestro.settings.set('contextManagementSettings', updated);
	},

	// ============================================================================
	// Keyboard Mastery Actions
	// ============================================================================

	setKeyboardMasteryStats: (value) => {
		set({ keyboardMasteryStats: value });
		window.maestro.settings.set('keyboardMasteryStats', value);
	},

	recordShortcutUsage: (shortcutId) => {
		const currentStats = get().keyboardMasteryStats;

		// Skip if already tracked
		if (currentStats.usedShortcuts.includes(shortcutId)) {
			return { newLevel: null };
		}

		// Add new shortcut to the list
		const updatedShortcuts = [...currentStats.usedShortcuts, shortcutId];

		// Calculate new percentage and level
		const percentage = (updatedShortcuts.length / TOTAL_SHORTCUTS_COUNT) * 100;
		const newLevelIndex = getLevelIndex(percentage);

		// Check if user leveled up
		const newLevel = newLevelIndex > currentStats.currentLevel ? newLevelIndex : null;

		const updated: KeyboardMasteryStats = {
			usedShortcuts: updatedShortcuts,
			currentLevel: newLevelIndex,
			lastLevelUpTimestamp: newLevel !== null ? Date.now() : currentStats.lastLevelUpTimestamp,
			lastAcknowledgedLevel: currentStats.lastAcknowledgedLevel,
		};

		set({ keyboardMasteryStats: updated });
		window.maestro.settings.set('keyboardMasteryStats', updated);

		return { newLevel };
	},

	acknowledgeKeyboardMasteryLevel: (level) => {
		const prev = get().keyboardMasteryStats;
		const updated: KeyboardMasteryStats = {
			...prev,
			lastAcknowledgedLevel: Math.max(level, prev.lastAcknowledgedLevel),
		};
		set({ keyboardMasteryStats: updated });
		window.maestro.settings.set('keyboardMasteryStats', updated);
	},

	getUnacknowledgedKeyboardMasteryLevel: () => {
		const stats = get().keyboardMasteryStats;
		const acknowledged = stats.lastAcknowledgedLevel;
		const current = stats.currentLevel;
		if (current > acknowledged) {
			return current;
		}
		return null;
	},
}));

// ============================================================================
// Selectors
// ============================================================================

export function selectIsLeaderboardRegistered(s: SettingsStoreState): boolean {
	return s.leaderboardRegistration !== null && s.leaderboardRegistration.emailConfirmed;
}

// ============================================================================
// Load All Settings
// ============================================================================

/** macOS Alt+key special character to normal key mapping for shortcut migration */
const MAC_ALT_CHAR_MAP: Record<string, string> = {
	'¬': 'l',
	π: 'p',
	'†': 't',
	'∫': 'b',
	'∂': 'd',
	ƒ: 'f',
	'©': 'g',
	'˙': 'h',
	ˆ: 'i',
	'∆': 'j',
	'˚': 'k',
	'¯': 'm',
	'˜': 'n',
	ø: 'o',
	'®': 'r',
	ß: 's',
	'√': 'v',
	'∑': 'w',
	'≈': 'x',
	'¥': 'y',
	Ω: 'z',
};

/**
 * Migrate shortcuts: fix macOS Alt+key special characters and merge with defaults.
 * Returns the migrated+merged shortcuts and whether a migration write is needed.
 */
function migrateShortcuts(
	saved: Record<string, Shortcut>,
	defaults: Record<string, Shortcut>
): { shortcuts: Record<string, Shortcut>; needsMigration: boolean } {
	const migrated: Record<string, Shortcut> = {};
	let needsMigration = false;

	for (const [id, shortcut] of Object.entries(saved)) {
		const migratedKeys = shortcut.keys.map((key) => {
			if (MAC_ALT_CHAR_MAP[key]) {
				needsMigration = true;
				return MAC_ALT_CHAR_MAP[key];
			}
			return key;
		});
		migrated[id] = { ...shortcut, keys: migratedKeys };
	}

	// Merge: use default labels (in case they changed) but preserve user's custom keys
	const merged: Record<string, Shortcut> = {};
	for (const [id, defaultShortcut] of Object.entries(defaults)) {
		const savedShortcut = migrated[id];
		merged[id] = {
			...defaultShortcut,
			keys: savedShortcut?.keys ?? defaultShortcut.keys,
		};
	}

	return { shortcuts: merged, needsMigration };
}

/**
 * Batch-load all settings from electron-store and apply them to the Zustand store.
 * Called once on app startup and again on system resume from sleep.
 */
export async function loadAllSettings(): Promise<void> {
	try {
		// Batch load all settings in a single IPC call
		const allSettings = (await window.maestro.settings.getAll()) as Record<string, unknown>;

		// Logger settings need separate calls (different IPC channel)
		const savedLogLevel = await window.maestro.logger.getLogLevel();
		const savedMaxLogBuffer = await window.maestro.logger.getMaxLogBuffer();

		// Build a single patch to apply to the store
		const patch: Partial<SettingsStoreState> = {};

		// --- Simple scalar settings ---

		if (allSettings['conductorProfile'] !== undefined)
			patch.conductorProfile = allSettings['conductorProfile'] as string;

		if (allSettings['llmProvider'] !== undefined)
			patch.llmProvider = allSettings['llmProvider'] as LLMProvider;

		if (allSettings['modelSlug'] !== undefined)
			patch.modelSlug = allSettings['modelSlug'] as string;

		if (allSettings['apiKey'] !== undefined) patch.apiKey = allSettings['apiKey'] as string;

		if (allSettings['defaultShell'] !== undefined)
			patch.defaultShell = allSettings['defaultShell'] as string;

		if (allSettings['customShellPath'] !== undefined)
			patch.customShellPath = allSettings['customShellPath'] as string;

		if (allSettings['shellArgs'] !== undefined)
			patch.shellArgs = allSettings['shellArgs'] as string;

		if (allSettings['shellEnvVars'] !== undefined)
			patch.shellEnvVars = allSettings['shellEnvVars'] as Record<string, string>;

		if (allSettings['ghPath'] !== undefined) patch.ghPath = allSettings['ghPath'] as string;

		if (allSettings['fontFamily'] !== undefined)
			patch.fontFamily = allSettings['fontFamily'] as string;

		if (allSettings['fontSize'] !== undefined) patch.fontSize = allSettings['fontSize'] as number;

		if (allSettings['activeThemeId'] !== undefined)
			patch.activeThemeId = allSettings['activeThemeId'] as ThemeId;

		if (allSettings['customThemeColors'] !== undefined)
			patch.customThemeColors = allSettings['customThemeColors'] as ThemeColors;

		if (allSettings['customThemeBaseId'] !== undefined)
			patch.customThemeBaseId = allSettings['customThemeBaseId'] as ThemeId;

		if (allSettings['enterToSendAI'] !== undefined)
			patch.enterToSendAI = allSettings['enterToSendAI'] as boolean;

		if (allSettings['enterToSendTerminal'] !== undefined)
			patch.enterToSendTerminal = allSettings['enterToSendTerminal'] as boolean;

		if (allSettings['defaultSaveToHistory'] !== undefined)
			patch.defaultSaveToHistory = allSettings['defaultSaveToHistory'] as boolean;

		// ThinkingMode: support legacy boolean values (true -> 'on', false -> 'off')
		if (allSettings['defaultShowThinking'] !== undefined) {
			const raw = allSettings['defaultShowThinking'];
			patch.defaultShowThinking =
				typeof raw === 'boolean' ? (raw ? 'on' : 'off') : (raw as ThinkingMode);
		}

		// leftSidebarWidth: clamp on load
		if (allSettings['leftSidebarWidth'] !== undefined)
			patch.leftSidebarWidth = Math.max(
				256,
				Math.min(600, allSettings['leftSidebarWidth'] as number)
			);

		if (allSettings['rightPanelWidth'] !== undefined)
			patch.rightPanelWidth = allSettings['rightPanelWidth'] as number;

		if (allSettings['markdownEditMode'] !== undefined)
			patch.markdownEditMode = allSettings['markdownEditMode'] as boolean;

		if (allSettings['chatRawTextMode'] !== undefined)
			patch.chatRawTextMode = allSettings['chatRawTextMode'] as boolean;

		if (allSettings['showHiddenFiles'] !== undefined)
			patch.showHiddenFiles = allSettings['showHiddenFiles'] as boolean;

		if (allSettings['terminalWidth'] !== undefined)
			patch.terminalWidth = allSettings['terminalWidth'] as number;

		// Logger settings
		if (savedLogLevel !== undefined) patch.logLevel = savedLogLevel;
		if (savedMaxLogBuffer !== undefined) patch.maxLogBuffer = savedMaxLogBuffer;

		// maxOutputLines: Infinity is serialized as null in JSON
		if (allSettings['maxOutputLines'] !== undefined) {
			patch.maxOutputLines =
				allSettings['maxOutputLines'] === null
					? Infinity
					: (allSettings['maxOutputLines'] as number);
		}

		if (allSettings['osNotificationsEnabled'] !== undefined)
			patch.osNotificationsEnabled = allSettings['osNotificationsEnabled'] as boolean;

		if (allSettings['audioFeedbackEnabled'] !== undefined)
			patch.audioFeedbackEnabled = allSettings['audioFeedbackEnabled'] as boolean;

		if (allSettings['audioFeedbackCommand'] !== undefined)
			patch.audioFeedbackCommand = allSettings['audioFeedbackCommand'] as string;

		if (allSettings['toastDuration'] !== undefined)
			patch.toastDuration = allSettings['toastDuration'] as number;

		if (allSettings['checkForUpdatesOnStartup'] !== undefined)
			patch.checkForUpdatesOnStartup = allSettings['checkForUpdatesOnStartup'] as boolean;

		if (allSettings['enableBetaUpdates'] !== undefined)
			patch.enableBetaUpdates = allSettings['enableBetaUpdates'] as boolean;

		if (allSettings['crashReportingEnabled'] !== undefined)
			patch.crashReportingEnabled = allSettings['crashReportingEnabled'] as boolean;

		if (allSettings['logViewerSelectedLevels'] !== undefined)
			patch.logViewerSelectedLevels = allSettings['logViewerSelectedLevels'] as string[];

		// --- Shortcuts (with Alt-key migration + merge) ---

		if (allSettings['shortcuts'] !== undefined) {
			const result = migrateShortcuts(
				allSettings['shortcuts'] as Record<string, Shortcut>,
				DEFAULT_SHORTCUTS
			);
			patch.shortcuts = result.shortcuts;
			if (result.needsMigration) {
				// Persist the migrated (but not yet merged) shortcuts so raw saved data is corrected
				const migratedRaw: Record<string, Shortcut> = {};
				for (const [id, shortcut] of Object.entries(
					allSettings['shortcuts'] as Record<string, Shortcut>
				)) {
					migratedRaw[id] = {
						...shortcut,
						keys: shortcut.keys.map((key) => MAC_ALT_CHAR_MAP[key] || key),
					};
				}
				window.maestro.settings.set('shortcuts', migratedRaw);
			}
		}

		if (allSettings['tabShortcuts'] !== undefined) {
			const result = migrateShortcuts(
				allSettings['tabShortcuts'] as Record<string, Shortcut>,
				TAB_SHORTCUTS
			);
			patch.tabShortcuts = result.shortcuts;
			if (result.needsMigration) {
				const migratedRaw: Record<string, Shortcut> = {};
				for (const [id, shortcut] of Object.entries(
					allSettings['tabShortcuts'] as Record<string, Shortcut>
				)) {
					migratedRaw[id] = {
						...shortcut,
						keys: shortcut.keys.map((key) => MAC_ALT_CHAR_MAP[key] || key),
					};
				}
				window.maestro.settings.set('tabShortcuts', migratedRaw);
			}
		}

		// --- Custom AI Commands (merge with defaults, skip /synopsis migration) ---

		if (
			allSettings['customAICommands'] !== undefined &&
			Array.isArray(allSettings['customAICommands'])
		) {
			const commandsById = new Map<string, CustomAICommand>();
			DEFAULT_AI_COMMANDS.forEach((cmd) => commandsById.set(cmd.id, cmd));
			(allSettings['customAICommands'] as CustomAICommand[]).forEach((cmd: CustomAICommand) => {
				// Migration: Skip old /synopsis command
				if (cmd.command === '/synopsis' || cmd.id === 'synopsis') {
					return;
				}
				// For built-in commands, merge to allow user edits but preserve isBuiltIn flag
				if (commandsById.has(cmd.id)) {
					const existing = commandsById.get(cmd.id)!;
					commandsById.set(cmd.id, { ...cmd, isBuiltIn: existing.isBuiltIn });
				} else {
					commandsById.set(cmd.id, cmd);
				}
			});
			patch.customAICommands = Array.from(commandsById.values());
		}

		// --- Stats objects (merge with defaults to pick up new fields) ---

		if (allSettings['globalStats'] !== undefined) {
			patch.globalStats = {
				...DEFAULT_GLOBAL_STATS,
				...(allSettings['globalStats'] as Partial<GlobalStats>),
			};
		}

		if (allSettings['autoRunStats'] !== undefined) {
			let stats = {
				...DEFAULT_AUTO_RUN_STATS,
				...(allSettings['autoRunStats'] as Partial<AutoRunStats>),
			};

			// One-time migration: Add 3 hours to compensate for concurrent Auto Run tallying bug
			const concurrentAutoRunTimeMigrationApplied =
				allSettings['concurrentAutoRunTimeMigrationApplied'];
			if (!concurrentAutoRunTimeMigrationApplied && stats.cumulativeTimeMs > 0) {
				const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
				stats = {
					...stats,
					cumulativeTimeMs: stats.cumulativeTimeMs + THREE_HOURS_MS,
				};
				window.maestro.settings.set('autoRunStats', stats);
				window.maestro.settings.set('concurrentAutoRunTimeMigrationApplied', true);
				console.log(
					'[Settings] Applied concurrent Auto Run time migration: added 3 hours to cumulative time'
				);
			}

			patch.autoRunStats = stats;
		}

		if (allSettings['usageStats'] !== undefined) {
			patch.usageStats = {
				...DEFAULT_USAGE_STATS,
				...(allSettings['usageStats'] as Partial<MaestroUsageStats>),
			};
		}

		if (allSettings['onboardingStats'] !== undefined) {
			patch.onboardingStats = {
				...DEFAULT_ONBOARDING_STATS,
				...(allSettings['onboardingStats'] as Partial<OnboardingStats>),
			};
		}

		if (allSettings['contextManagementSettings'] !== undefined) {
			patch.contextManagementSettings = {
				...DEFAULT_CONTEXT_MANAGEMENT_SETTINGS,
				...(allSettings['contextManagementSettings'] as Partial<ContextManagementSettings>),
			};
		}

		if (allSettings['keyboardMasteryStats'] !== undefined) {
			patch.keyboardMasteryStats = {
				...DEFAULT_KEYBOARD_MASTERY_STATS,
				...(allSettings['keyboardMasteryStats'] as Partial<KeyboardMasteryStats>),
			};
		}

		// --- Simple boolean/scalar settings ---

		if (allSettings['ungroupedCollapsed'] !== undefined)
			patch.ungroupedCollapsed = allSettings['ungroupedCollapsed'] as boolean;

		if (allSettings['tourCompleted'] !== undefined)
			patch.tourCompleted = allSettings['tourCompleted'] as boolean;

		if (allSettings['firstAutoRunCompleted'] !== undefined)
			patch.firstAutoRunCompleted = allSettings['firstAutoRunCompleted'] as boolean;

		if (allSettings['leaderboardRegistration'] !== undefined)
			patch.leaderboardRegistration = allSettings[
				'leaderboardRegistration'
			] as LeaderboardRegistration | null;

		if (allSettings['webInterfaceUseCustomPort'] !== undefined)
			patch.webInterfaceUseCustomPort = allSettings['webInterfaceUseCustomPort'] as boolean;

		if (allSettings['webInterfaceCustomPort'] !== undefined)
			patch.webInterfaceCustomPort = allSettings['webInterfaceCustomPort'] as number;

		if (allSettings['colorBlindMode'] !== undefined)
			patch.colorBlindMode = allSettings['colorBlindMode'] as boolean;

		// Document Graph settings (with validation)
		if (allSettings['documentGraphShowExternalLinks'] !== undefined)
			patch.documentGraphShowExternalLinks = allSettings[
				'documentGraphShowExternalLinks'
			] as boolean;

		if (allSettings['documentGraphMaxNodes'] !== undefined) {
			const maxNodes = allSettings['documentGraphMaxNodes'] as number;
			if (typeof maxNodes === 'number' && maxNodes >= 50 && maxNodes <= 1000) {
				patch.documentGraphMaxNodes = maxNodes;
			}
		}

		if (allSettings['documentGraphPreviewCharLimit'] !== undefined) {
			const charLimit = allSettings['documentGraphPreviewCharLimit'] as number;
			if (typeof charLimit === 'number' && charLimit >= 50 && charLimit <= 500) {
				patch.documentGraphPreviewCharLimit = charLimit;
			}
		}

		// Stats settings (with time range validation)
		if (allSettings['statsCollectionEnabled'] !== undefined)
			patch.statsCollectionEnabled = allSettings['statsCollectionEnabled'] as boolean;

		if (allSettings['defaultStatsTimeRange'] !== undefined) {
			const validTimeRanges = ['day', 'week', 'month', 'year', 'all'];
			if (validTimeRanges.includes(allSettings['defaultStatsTimeRange'] as string)) {
				patch.defaultStatsTimeRange = allSettings['defaultStatsTimeRange'] as
					| 'day'
					| 'week'
					| 'month'
					| 'year'
					| 'all';
			}
		}

		if (allSettings['preventSleepEnabled'] !== undefined)
			patch.preventSleepEnabled = allSettings['preventSleepEnabled'] as boolean;

		if (allSettings['disableGpuAcceleration'] !== undefined)
			patch.disableGpuAcceleration = allSettings['disableGpuAcceleration'] as boolean;

		if (allSettings['disableConfetti'] !== undefined)
			patch.disableConfetti = allSettings['disableConfetti'] as boolean;

		// SSH Remote settings (with array validation)
		if (
			allSettings['sshRemoteIgnorePatterns'] !== undefined &&
			Array.isArray(allSettings['sshRemoteIgnorePatterns'])
		) {
			patch.sshRemoteIgnorePatterns = allSettings['sshRemoteIgnorePatterns'] as string[];
		}

		if (allSettings['sshRemoteHonorGitignore'] !== undefined)
			patch.sshRemoteHonorGitignore = allSettings['sshRemoteHonorGitignore'] as boolean;

		if (allSettings['automaticTabNamingEnabled'] !== undefined)
			patch.automaticTabNamingEnabled = allSettings['automaticTabNamingEnabled'] as boolean;

		if (allSettings['fileTabAutoRefreshEnabled'] !== undefined)
			patch.fileTabAutoRefreshEnabled = allSettings['fileTabAutoRefreshEnabled'] as boolean;

		if (allSettings['suppressWindowsWarning'] !== undefined)
			patch.suppressWindowsWarning = allSettings['suppressWindowsWarning'] as boolean;

		if (allSettings['autoScrollAiMode'] !== undefined)
			patch.autoScrollAiMode = allSettings['autoScrollAiMode'] as boolean;

		// Encore Features (merge with defaults to preserve new flags)
		if (allSettings['encoreFeatures'] !== undefined) {
			patch.encoreFeatures = {
				...DEFAULT_ENCORE_FEATURES,
				...(allSettings['encoreFeatures'] as Partial<EncoreFeatureFlags>),
			};
		}

		// Director's Notes settings (merge with defaults to preserve new fields)
		if (allSettings['directorNotesSettings'] !== undefined) {
			patch.directorNotesSettings = {
				...DEFAULT_DIRECTOR_NOTES_SETTINGS,
				...(allSettings['directorNotesSettings'] as Partial<DirectorNotesSettings>),
			};
		}

		if (allSettings['wakatimeApiKey'] !== undefined)
			patch.wakatimeApiKey = allSettings['wakatimeApiKey'] as string;

		if (allSettings['wakatimeEnabled'] !== undefined)
			patch.wakatimeEnabled = allSettings['wakatimeEnabled'] as boolean;

		// Apply the entire patch in one setState call
		patch.settingsLoaded = true;
		useSettingsStore.setState(patch);
	} catch (error) {
		console.error('[Settings] Failed to load settings:', error);
		// Mark settings as loaded even if there was an error (use defaults)
		useSettingsStore.setState({ settingsLoaded: true });
	}
}

// ============================================================================
// Non-React Access
// ============================================================================

export function getSettingsState(): SettingsStoreState {
	return useSettingsStore.getState();
}

export function getSettingsActions() {
	const state = useSettingsStore.getState();
	return {
		setConductorProfile: state.setConductorProfile,
		setLlmProvider: state.setLlmProvider,
		setModelSlug: state.setModelSlug,
		setApiKey: state.setApiKey,
		setDefaultShell: state.setDefaultShell,
		setCustomShellPath: state.setCustomShellPath,
		setShellArgs: state.setShellArgs,
		setShellEnvVars: state.setShellEnvVars,
		setGhPath: state.setGhPath,
		setFontFamily: state.setFontFamily,
		setFontSize: state.setFontSize,
		setActiveThemeId: state.setActiveThemeId,
		setCustomThemeColors: state.setCustomThemeColors,
		setCustomThemeBaseId: state.setCustomThemeBaseId,
		setEnterToSendAI: state.setEnterToSendAI,
		setEnterToSendTerminal: state.setEnterToSendTerminal,
		setDefaultSaveToHistory: state.setDefaultSaveToHistory,
		setDefaultShowThinking: state.setDefaultShowThinking,
		setLeftSidebarWidth: state.setLeftSidebarWidth,
		setRightPanelWidth: state.setRightPanelWidth,
		setMarkdownEditMode: state.setMarkdownEditMode,
		setChatRawTextMode: state.setChatRawTextMode,
		setShowHiddenFiles: state.setShowHiddenFiles,
		setTerminalWidth: state.setTerminalWidth,
		setLogLevel: state.setLogLevel,
		setMaxLogBuffer: state.setMaxLogBuffer,
		setMaxOutputLines: state.setMaxOutputLines,
		setOsNotificationsEnabled: state.setOsNotificationsEnabled,
		setAudioFeedbackEnabled: state.setAudioFeedbackEnabled,
		setAudioFeedbackCommand: state.setAudioFeedbackCommand,
		setToastDuration: state.setToastDuration,
		setCheckForUpdatesOnStartup: state.setCheckForUpdatesOnStartup,
		setEnableBetaUpdates: state.setEnableBetaUpdates,
		setCrashReportingEnabled: state.setCrashReportingEnabled,
		setLogViewerSelectedLevels: state.setLogViewerSelectedLevels,
		setShortcuts: state.setShortcuts,
		setTabShortcuts: state.setTabShortcuts,
		setCustomAICommands: state.setCustomAICommands,
		setGlobalStats: state.setGlobalStats,
		updateGlobalStats: state.updateGlobalStats,
		setAutoRunStats: state.setAutoRunStats,
		recordAutoRunComplete: state.recordAutoRunComplete,
		updateAutoRunProgress: state.updateAutoRunProgress,
		acknowledgeBadge: state.acknowledgeBadge,
		getUnacknowledgedBadgeLevel: state.getUnacknowledgedBadgeLevel,
		setUsageStats: state.setUsageStats,
		updateUsageStats: state.updateUsageStats,
		setUngroupedCollapsed: state.setUngroupedCollapsed,
		setTourCompleted: state.setTourCompleted,
		setFirstAutoRunCompleted: state.setFirstAutoRunCompleted,
		setOnboardingStats: state.setOnboardingStats,
		recordWizardStart: state.recordWizardStart,
		recordWizardComplete: state.recordWizardComplete,
		recordWizardAbandon: state.recordWizardAbandon,
		recordWizardResume: state.recordWizardResume,
		recordTourStart: state.recordTourStart,
		recordTourComplete: state.recordTourComplete,
		recordTourSkip: state.recordTourSkip,
		getOnboardingAnalytics: state.getOnboardingAnalytics,
		setLeaderboardRegistration: state.setLeaderboardRegistration,
		setWebInterfaceUseCustomPort: state.setWebInterfaceUseCustomPort,
		setWebInterfaceCustomPort: state.setWebInterfaceCustomPort,
		setContextManagementSettings: state.setContextManagementSettings,
		updateContextManagementSettings: state.updateContextManagementSettings,
		setKeyboardMasteryStats: state.setKeyboardMasteryStats,
		recordShortcutUsage: state.recordShortcutUsage,
		acknowledgeKeyboardMasteryLevel: state.acknowledgeKeyboardMasteryLevel,
		getUnacknowledgedKeyboardMasteryLevel: state.getUnacknowledgedKeyboardMasteryLevel,
		setColorBlindMode: state.setColorBlindMode,
		setDocumentGraphShowExternalLinks: state.setDocumentGraphShowExternalLinks,
		setDocumentGraphMaxNodes: state.setDocumentGraphMaxNodes,
		setDocumentGraphPreviewCharLimit: state.setDocumentGraphPreviewCharLimit,
		setStatsCollectionEnabled: state.setStatsCollectionEnabled,
		setDefaultStatsTimeRange: state.setDefaultStatsTimeRange,
		setPreventSleepEnabled: state.setPreventSleepEnabled,
		setDisableGpuAcceleration: state.setDisableGpuAcceleration,
		setDisableConfetti: state.setDisableConfetti,
		setSshRemoteIgnorePatterns: state.setSshRemoteIgnorePatterns,
		setSshRemoteHonorGitignore: state.setSshRemoteHonorGitignore,
		setAutomaticTabNamingEnabled: state.setAutomaticTabNamingEnabled,
		setFileTabAutoRefreshEnabled: state.setFileTabAutoRefreshEnabled,
		setSuppressWindowsWarning: state.setSuppressWindowsWarning,
		setAutoScrollAiMode: state.setAutoScrollAiMode,
		setEncoreFeatures: state.setEncoreFeatures,
		setDirectorNotesSettings: state.setDirectorNotesSettings,
		setWakatimeApiKey: state.setWakatimeApiKey,
		setWakatimeEnabled: state.setWakatimeEnabled,
	};
}
