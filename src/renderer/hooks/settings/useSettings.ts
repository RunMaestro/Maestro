import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
} from '../../types';
import { DEFAULT_CUSTOM_THEME_COLORS } from '../../constants/themes';
import { DEFAULT_SHORTCUTS, TAB_SHORTCUTS, FIXED_SHORTCUTS } from '../../constants/shortcuts';
import { getLevelIndex } from '../../constants/keyboardMastery';
import { commitCommandPrompt } from '../../../prompts';

// Default context management settings
const DEFAULT_CONTEXT_MANAGEMENT_SETTINGS: ContextManagementSettings = {
	autoGroomContexts: true, // Automatically groom contexts during transfer
	maxContextTokens: 100000, // Maximum tokens for context operations
	showMergePreview: true, // Show preview before merge
	groomingTimeout: 60000, // 1 minute timeout for grooming operations
	preferredGroomingAgent: 'fastest', // 'fastest' or specific ToolType
	// Context window warning settings (Phase 6)
	contextWarningsEnabled: true, // Enable context consumption warnings
	contextWarningYellowThreshold: 60, // Yellow warning at 60% (min: 30, max: 90)
	contextWarningRedThreshold: 80, // Red warning at 80% (min: 50, max: 95)
};

// Default global stats
const DEFAULT_GLOBAL_STATS: GlobalStats = {
	totalSessions: 0,
	totalMessages: 0,
	totalInputTokens: 0,
	totalOutputTokens: 0,
	totalCacheReadTokens: 0,
	totalCacheCreationTokens: 0,
	totalCostUsd: 0,
	totalActiveTimeMs: 0,
};

// Default auto-run stats
const DEFAULT_AUTO_RUN_STATS: AutoRunStats = {
	cumulativeTimeMs: 0,
	longestRunMs: 0,
	longestRunTimestamp: 0,
	totalRuns: 0,
	currentBadgeLevel: 0,
	lastBadgeUnlockLevel: 0,
	lastAcknowledgedBadgeLevel: 0,
	badgeHistory: [],
};

// Default usage stats (peak tracking for achievements)
// New users start at 0, peaks are tracked as they use the app
const DEFAULT_USAGE_STATS: MaestroUsageStats = {
	maxAgents: 0,
	maxDefinedAgents: 0,
	maxSimultaneousAutoRuns: 0,
	maxSimultaneousQueries: 0,
	maxQueueDepth: 0,
};

// Default keyboard mastery stats
const DEFAULT_KEYBOARD_MASTERY_STATS: KeyboardMasteryStats = {
	usedShortcuts: [],
	currentLevel: 0,
	lastLevelUpTimestamp: 0,
	lastAcknowledgedLevel: 0,
};

// Total shortcuts for calculating mastery percentage (includes all shortcut types)
const TOTAL_SHORTCUTS_COUNT =
	Object.keys(DEFAULT_SHORTCUTS).length +
	Object.keys(TAB_SHORTCUTS).length +
	Object.keys(FIXED_SHORTCUTS).length;

// Default onboarding stats (all local, no external telemetry)
const DEFAULT_ONBOARDING_STATS: OnboardingStats = {
	// Wizard statistics
	wizardStartCount: 0,
	wizardCompletionCount: 0,
	wizardAbandonCount: 0,
	wizardResumeCount: 0,
	averageWizardDurationMs: 0,
	totalWizardDurationMs: 0,
	lastWizardCompletedAt: 0,

	// Tour statistics
	tourStartCount: 0,
	tourCompletionCount: 0,
	tourSkipCount: 0,
	tourStepsViewedTotal: 0,
	averageTourStepsViewed: 0,

	// Conversation statistics
	totalConversationExchanges: 0,
	averageConversationExchanges: 0,
	totalConversationsCompleted: 0,

	// Phase generation statistics
	totalPhasesGenerated: 0,
	averagePhasesPerWizard: 0,
	totalTasksGenerated: 0,
	averageTasksPerPhase: 0,
};

// Default AI commands that ship with Maestro
// Template variables available: {{AGENT_NAME}}, {{AGENT_PATH}}, {{TAB_NAME}}, {{AGENT_GROUP}}, {{AGENT_SESSION_ID}}, {{DATE}}, {{TIME}}, etc.
const DEFAULT_AI_COMMANDS: CustomAICommand[] = [
	{
		id: 'commit',
		command: '/commit',
		description: 'Commit outstanding changes and push up',
		prompt: commitCommandPrompt,
		isBuiltIn: true,
	},
];

export interface UseSettingsReturn {
	// Loading state
	settingsLoaded: boolean;

	// LLM settings
	llmProvider: LLMProvider;
	modelSlug: string;
	apiKey: string;
	setLlmProvider: (value: LLMProvider) => void;
	setModelSlug: (value: string) => void;
	setApiKey: (value: string) => void;

	// Shell settings
	defaultShell: string;
	setDefaultShell: (value: string) => void;
	customShellPath: string;
	setCustomShellPath: (value: string) => void;
	shellArgs: string;
	setShellArgs: (value: string) => void;
	shellEnvVars: Record<string, string>;
	setShellEnvVars: (value: Record<string, string>) => void;

	// GitHub CLI settings
	ghPath: string;
	setGhPath: (value: string) => void;

	// Font settings
	fontFamily: string;
	fontSize: number;
	setFontFamily: (value: string) => void;
	setFontSize: (value: number) => void;

	// UI settings
	activeThemeId: ThemeId;
	setActiveThemeId: (value: ThemeId) => void;
	customThemeColors: ThemeColors;
	setCustomThemeColors: (value: ThemeColors) => void;
	customThemeBaseId: ThemeId;
	setCustomThemeBaseId: (value: ThemeId) => void;
	enterToSendAI: boolean;
	setEnterToSendAI: (value: boolean) => void;
	enterToSendTerminal: boolean;
	setEnterToSendTerminal: (value: boolean) => void;
	defaultSaveToHistory: boolean;
	setDefaultSaveToHistory: (value: boolean) => void;

	// Default thinking toggle
	defaultShowThinking: boolean;
	setDefaultShowThinking: (value: boolean) => void;
	leftSidebarWidth: number;
	rightPanelWidth: number;
	markdownEditMode: boolean;
	setLeftSidebarWidth: (value: number) => void;
	setRightPanelWidth: (value: number) => void;
	setMarkdownEditMode: (value: boolean) => void;
	showHiddenFiles: boolean;
	setShowHiddenFiles: (value: boolean) => void;

	// Terminal settings
	terminalWidth: number;
	setTerminalWidth: (value: number) => void;

	// Logging settings
	logLevel: string;
	setLogLevel: (value: string) => void;
	maxLogBuffer: number;
	setMaxLogBuffer: (value: number) => void;

	// Output settings
	maxOutputLines: number;
	setMaxOutputLines: (value: number) => void;

	// Notification settings
	osNotificationsEnabled: boolean;
	setOsNotificationsEnabled: (value: boolean) => void;
	audioFeedbackEnabled: boolean;
	setAudioFeedbackEnabled: (value: boolean) => void;
	audioFeedbackCommand: string;
	setAudioFeedbackCommand: (value: string) => void;
	toastDuration: number;
	setToastDuration: (value: number) => void;

	// Update settings
	checkForUpdatesOnStartup: boolean;
	setCheckForUpdatesOnStartup: (value: boolean) => void;
	enableBetaUpdates: boolean;
	setEnableBetaUpdates: (value: boolean) => void;

	// Crash reporting settings
	crashReportingEnabled: boolean;
	setCrashReportingEnabled: (value: boolean) => void;

	// Log Viewer settings
	logViewerSelectedLevels: string[];
	setLogViewerSelectedLevels: (value: string[]) => void;

	// Shortcuts
	shortcuts: Record<string, Shortcut>;
	setShortcuts: (value: Record<string, Shortcut>) => void;
	tabShortcuts: Record<string, Shortcut>;
	setTabShortcuts: (value: Record<string, Shortcut>) => void;

	// Custom AI Commands
	customAICommands: CustomAICommand[];
	setCustomAICommands: (value: CustomAICommand[]) => void;

	// Global Stats (persistent across restarts)
	globalStats: GlobalStats;
	setGlobalStats: (value: GlobalStats) => void;
	updateGlobalStats: (delta: Partial<GlobalStats>) => void;

	// Auto-run Stats (persistent across restarts)
	autoRunStats: AutoRunStats;
	setAutoRunStats: (value: AutoRunStats) => void;
	recordAutoRunComplete: (elapsedTimeMs: number) => {
		newBadgeLevel: number | null;
		isNewRecord: boolean;
	};
	updateAutoRunProgress: (currentRunElapsedMs: number) => {
		newBadgeLevel: number | null;
		isNewRecord: boolean;
	};
	acknowledgeBadge: (level: number) => void;
	getUnacknowledgedBadgeLevel: () => number | null;

	// Usage Stats (peak tracking for achievements image)
	usageStats: MaestroUsageStats;
	setUsageStats: (value: MaestroUsageStats) => void;
	updateUsageStats: (currentValues: Partial<MaestroUsageStats>) => void;

	// UI collapse states (persistent)
	ungroupedCollapsed: boolean;
	setUngroupedCollapsed: (value: boolean) => void;

	// Onboarding settings
	tourCompleted: boolean;
	setTourCompleted: (value: boolean) => void;
	firstAutoRunCompleted: boolean;
	setFirstAutoRunCompleted: (value: boolean) => void;

	// Onboarding Stats (persistent, local-only analytics)
	onboardingStats: OnboardingStats;
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

	// Leaderboard Registration (persistent)
	leaderboardRegistration: LeaderboardRegistration | null;
	setLeaderboardRegistration: (value: LeaderboardRegistration | null) => void;
	isLeaderboardRegistered: boolean;

	// Web Interface settings
	webInterfaceUseCustomPort: boolean;
	setWebInterfaceUseCustomPort: (value: boolean) => void;
	webInterfaceCustomPort: number;
	setWebInterfaceCustomPort: (value: number) => void;

	// Context Management settings
	contextManagementSettings: ContextManagementSettings;
	setContextManagementSettings: (value: ContextManagementSettings) => void;
	updateContextManagementSettings: (partial: Partial<ContextManagementSettings>) => void;

	// Keyboard Mastery (gamification for shortcut usage)
	keyboardMasteryStats: KeyboardMasteryStats;
	setKeyboardMasteryStats: (value: KeyboardMasteryStats) => void;
	recordShortcutUsage: (shortcutId: string) => { newLevel: number | null };
	acknowledgeKeyboardMasteryLevel: (level: number) => void;
	getUnacknowledgedKeyboardMasteryLevel: () => number | null;

	// Accessibility settings
	colorBlindMode: boolean;
	setColorBlindMode: (value: boolean) => void;

	// Document Graph settings
	documentGraphShowExternalLinks: boolean;
	setDocumentGraphShowExternalLinks: (value: boolean) => void;
	documentGraphMaxNodes: number;
	setDocumentGraphMaxNodes: (value: number) => void;
	documentGraphPreviewCharLimit: number;
	setDocumentGraphPreviewCharLimit: (value: number) => void;

	// Stats settings
	statsCollectionEnabled: boolean;
	setStatsCollectionEnabled: (value: boolean) => void;
	defaultStatsTimeRange: 'day' | 'week' | 'month' | 'year' | 'all';
	setDefaultStatsTimeRange: (value: 'day' | 'week' | 'month' | 'year' | 'all') => void;

	// Power management settings
	preventSleepEnabled: boolean;
	setPreventSleepEnabled: (value: boolean) => Promise<void>;

	// Rendering settings
	disableGpuAcceleration: boolean;
	setDisableGpuAcceleration: (value: boolean) => void;
	disableConfetti: boolean;
	setDisableConfetti: (value: boolean) => void;
}

export function useSettings(): UseSettingsReturn {
	// Loading state
	const [settingsLoaded, setSettingsLoaded] = useState(false);

	// LLM Config
	const [llmProvider, setLlmProviderState] = useState<LLMProvider>('openrouter');
	const [modelSlug, setModelSlugState] = useState('anthropic/claude-3.5-sonnet');
	const [apiKey, setApiKeyState] = useState('');

	// Shell Config
	const [defaultShell, setDefaultShellState] = useState('zsh');
	const [customShellPath, setCustomShellPathState] = useState('');
	const [shellArgs, setShellArgsState] = useState('');
	const [shellEnvVars, setShellEnvVarsState] = useState<Record<string, string>>({});

	// GitHub CLI Config
	const [ghPath, setGhPathState] = useState('');

	// Font Config
	const [fontFamily, setFontFamilyState] = useState('Roboto Mono, Menlo, "Courier New", monospace');
	const [fontSize, setFontSizeState] = useState(14);

	// UI Config
	const [activeThemeId, setActiveThemeIdState] = useState<ThemeId>('dracula');
	const [customThemeColors, setCustomThemeColorsState] = useState<ThemeColors>(
		DEFAULT_CUSTOM_THEME_COLORS
	);
	const [customThemeBaseId, setCustomThemeBaseIdState] = useState<ThemeId>('dracula');
	const [enterToSendAI, setEnterToSendAIState] = useState(false); // AI mode defaults to Command+Enter
	const [enterToSendTerminal, setEnterToSendTerminalState] = useState(true); // Terminal defaults to Enter
	const [defaultSaveToHistory, setDefaultSaveToHistoryState] = useState(true); // History toggle defaults to on
	const [defaultShowThinking, setDefaultShowThinkingState] = useState(false); // Thinking toggle defaults to off
	const [leftSidebarWidth, setLeftSidebarWidthState] = useState(256);
	const [rightPanelWidth, setRightPanelWidthState] = useState(384);
	const [markdownEditMode, setMarkdownEditModeState] = useState(false);
	const [showHiddenFiles, setShowHiddenFilesState] = useState(true); // Default: show hidden files

	// Terminal Config
	const [terminalWidth, setTerminalWidthState] = useState(100);

	// Logging Config
	const [logLevel, setLogLevelState] = useState('info');
	const [maxLogBuffer, setMaxLogBufferState] = useState(5000);

	// Output Config
	const [maxOutputLines, setMaxOutputLinesState] = useState(25);

	// Notification Config
	const [osNotificationsEnabled, setOsNotificationsEnabledState] = useState(true); // Default: on
	const [audioFeedbackEnabled, setAudioFeedbackEnabledState] = useState(false); // Default: off
	const [audioFeedbackCommand, setAudioFeedbackCommandState] = useState('say'); // Default: macOS say command
	const [toastDuration, setToastDurationState] = useState(20); // Default: 20 seconds, 0 = never auto-dismiss

	// Update Config
	const [checkForUpdatesOnStartup, setCheckForUpdatesOnStartupState] = useState(true); // Default: on
	const [enableBetaUpdates, setEnableBetaUpdatesState] = useState(false); // Default: off (stable only)

	// Crash Reporting Config
	const [crashReportingEnabled, setCrashReportingEnabledState] = useState(true); // Default: on (opt-out)

	// Log Viewer Config
	const [logViewerSelectedLevels, setLogViewerSelectedLevelsState] = useState<string[]>([
		'debug',
		'info',
		'warn',
		'error',
		'toast',
	]);

	// Shortcuts
	const [shortcuts, setShortcutsState] = useState<Record<string, Shortcut>>(DEFAULT_SHORTCUTS);
	const [tabShortcuts, setTabShortcutsState] = useState<Record<string, Shortcut>>(TAB_SHORTCUTS);

	// Custom AI Commands
	const [customAICommands, setCustomAICommandsState] =
		useState<CustomAICommand[]>(DEFAULT_AI_COMMANDS);

	// Global Stats (persistent)
	const [globalStats, setGlobalStatsState] = useState<GlobalStats>(DEFAULT_GLOBAL_STATS);

	// Auto-run Stats (persistent)
	const [autoRunStats, setAutoRunStatsState] = useState<AutoRunStats>(DEFAULT_AUTO_RUN_STATS);

	// Usage Stats (peak tracking for achievements image)
	const [usageStats, setUsageStatsState] = useState<MaestroUsageStats>(DEFAULT_USAGE_STATS);

	// UI collapse states (persistent)
	const [ungroupedCollapsed, setUngroupedCollapsedState] = useState(false);

	// Onboarding settings (persistent)
	const [tourCompleted, setTourCompletedState] = useState(false);
	const [firstAutoRunCompleted, setFirstAutoRunCompletedState] = useState(false);

	// Onboarding Stats (persistent, local-only analytics)
	const [onboardingStats, setOnboardingStatsState] =
		useState<OnboardingStats>(DEFAULT_ONBOARDING_STATS);

	// Leaderboard Registration (persistent)
	const [leaderboardRegistration, setLeaderboardRegistrationState] =
		useState<LeaderboardRegistration | null>(null);

	// Web Interface settings (persistent)
	const [webInterfaceUseCustomPort, setWebInterfaceUseCustomPortState] = useState(false);
	const [webInterfaceCustomPort, setWebInterfaceCustomPortState] = useState(8080);

	// Context Management settings (persistent)
	const [contextManagementSettings, setContextManagementSettingsState] =
		useState<ContextManagementSettings>(DEFAULT_CONTEXT_MANAGEMENT_SETTINGS);

	// Keyboard Mastery stats (persistent gamification)
	const [keyboardMasteryStats, setKeyboardMasteryStatsState] = useState<KeyboardMasteryStats>(
		DEFAULT_KEYBOARD_MASTERY_STATS
	);
	// Ref to read current stats synchronously for level-up detection
	const keyboardMasteryStatsRef = useRef<KeyboardMasteryStats>(DEFAULT_KEYBOARD_MASTERY_STATS);
	// Keep ref in sync with state
	useEffect(() => {
		keyboardMasteryStatsRef.current = keyboardMasteryStats;
	}, [keyboardMasteryStats]);

	// Accessibility settings
	const [colorBlindMode, setColorBlindModeState] = useState(false);

	// Document Graph settings
	const [documentGraphShowExternalLinks, setDocumentGraphShowExternalLinksState] = useState(false); // Default: false
	const [documentGraphMaxNodes, setDocumentGraphMaxNodesState] = useState(50); // Default: 50
	const [documentGraphPreviewCharLimit, setDocumentGraphPreviewCharLimitState] = useState(100); // Default: 100 (matches original hard-coded value)

	// Stats settings
	const [statsCollectionEnabled, setStatsCollectionEnabledState] = useState(true); // Default: enabled
	const [defaultStatsTimeRange, setDefaultStatsTimeRangeState] = useState<
		'day' | 'week' | 'month' | 'year' | 'all'
	>('week'); // Default: week

	// Power management settings
	const [preventSleepEnabled, setPreventSleepEnabledState] = useState(false); // Default: disabled

	// Rendering settings
	const [disableGpuAcceleration, setDisableGpuAccelerationState] = useState(false); // Default: disabled (GPU enabled)
	const [disableConfetti, setDisableConfettiState] = useState(false); // Default: disabled (confetti enabled)

	// Wrapper functions that persist to electron-store
	// PERF: All wrapped in useCallback to prevent re-renders
	const setLlmProvider = useCallback((value: LLMProvider) => {
		setLlmProviderState(value);
		window.maestro.settings.set('llmProvider', value);
	}, []);

	const setModelSlug = useCallback((value: string) => {
		setModelSlugState(value);
		window.maestro.settings.set('modelSlug', value);
	}, []);

	const setApiKey = useCallback((value: string) => {
		setApiKeyState(value);
		window.maestro.settings.set('apiKey', value);
	}, []);

	const setDefaultShell = useCallback((value: string) => {
		setDefaultShellState(value);
		window.maestro.settings.set('defaultShell', value);
	}, []);

	const setCustomShellPath = useCallback((value: string) => {
		setCustomShellPathState(value);
		window.maestro.settings.set('customShellPath', value);
	}, []);

	const setShellArgs = useCallback((value: string) => {
		setShellArgsState(value);
		window.maestro.settings.set('shellArgs', value);
	}, []);

	const setShellEnvVars = useCallback((value: Record<string, string>) => {
		setShellEnvVarsState(value);
		window.maestro.settings.set('shellEnvVars', value);
	}, []);

	const setGhPath = useCallback((value: string) => {
		setGhPathState(value);
		window.maestro.settings.set('ghPath', value);
	}, []);

	const setFontFamily = useCallback((value: string) => {
		setFontFamilyState(value);
		window.maestro.settings.set('fontFamily', value);
	}, []);

	const setFontSize = useCallback((value: number) => {
		setFontSizeState(value);
		window.maestro.settings.set('fontSize', value);
	}, []);

	const setActiveThemeId = useCallback((value: ThemeId) => {
		setActiveThemeIdState(value);
		window.maestro.settings.set('activeThemeId', value);
	}, []);

	const setCustomThemeColors = useCallback((value: ThemeColors) => {
		setCustomThemeColorsState(value);
		window.maestro.settings.set('customThemeColors', value);
	}, []);

	const setCustomThemeBaseId = useCallback((value: ThemeId) => {
		setCustomThemeBaseIdState(value);
		window.maestro.settings.set('customThemeBaseId', value);
	}, []);

	const setEnterToSendAI = useCallback((value: boolean) => {
		setEnterToSendAIState(value);
		window.maestro.settings.set('enterToSendAI', value);
	}, []);

	const setEnterToSendTerminal = useCallback((value: boolean) => {
		setEnterToSendTerminalState(value);
		window.maestro.settings.set('enterToSendTerminal', value);
	}, []);

	const setDefaultSaveToHistory = useCallback((value: boolean) => {
		setDefaultSaveToHistoryState(value);
		window.maestro.settings.set('defaultSaveToHistory', value);
	}, []);

	const setDefaultShowThinking = useCallback((value: boolean) => {
		setDefaultShowThinkingState(value);
		window.maestro.settings.set('defaultShowThinking', value);
	}, []);

	const setLeftSidebarWidth = useCallback((width: number) => {
		const clampedWidth = Math.max(256, Math.min(600, width));
		setLeftSidebarWidthState(clampedWidth);
		window.maestro.settings.set('leftSidebarWidth', clampedWidth);
	}, []);

	const setRightPanelWidth = useCallback((width: number) => {
		setRightPanelWidthState(width);
		window.maestro.settings.set('rightPanelWidth', width);
	}, []);

	const setMarkdownEditMode = useCallback((value: boolean) => {
		setMarkdownEditModeState(value);
		window.maestro.settings.set('markdownEditMode', value);
	}, []);

	const setShowHiddenFiles = useCallback((value: boolean) => {
		setShowHiddenFilesState(value);
		window.maestro.settings.set('showHiddenFiles', value);
	}, []);

	const setShortcuts = useCallback((value: Record<string, Shortcut>) => {
		setShortcutsState(value);
		window.maestro.settings.set('shortcuts', value);
	}, []);

	const setTabShortcuts = useCallback((value: Record<string, Shortcut>) => {
		setTabShortcutsState(value);
		window.maestro.settings.set('tabShortcuts', value);
	}, []);

	const setTerminalWidth = useCallback((value: number) => {
		setTerminalWidthState(value);
		window.maestro.settings.set('terminalWidth', value);
	}, []);

	const setLogLevel = useCallback(async (value: string) => {
		setLogLevelState(value);
		await window.maestro.logger.setLogLevel(value);
	}, []);

	const setMaxLogBuffer = useCallback(async (value: number) => {
		setMaxLogBufferState(value);
		await window.maestro.logger.setMaxLogBuffer(value);
	}, []);

	const setMaxOutputLines = useCallback((value: number) => {
		setMaxOutputLinesState(value);
		window.maestro.settings.set('maxOutputLines', value);
	}, []);

	const setOsNotificationsEnabled = useCallback((value: boolean) => {
		setOsNotificationsEnabledState(value);
		window.maestro.settings.set('osNotificationsEnabled', value);
	}, []);

	const setAudioFeedbackEnabled = useCallback((value: boolean) => {
		setAudioFeedbackEnabledState(value);
		window.maestro.settings.set('audioFeedbackEnabled', value);
	}, []);

	const setAudioFeedbackCommand = useCallback((value: string) => {
		setAudioFeedbackCommandState(value);
		window.maestro.settings.set('audioFeedbackCommand', value);
	}, []);

	const setToastDuration = useCallback((value: number) => {
		setToastDurationState(value);
		window.maestro.settings.set('toastDuration', value);
	}, []);

	const setCheckForUpdatesOnStartup = useCallback((value: boolean) => {
		setCheckForUpdatesOnStartupState(value);
		window.maestro.settings.set('checkForUpdatesOnStartup', value);
	}, []);

	const setEnableBetaUpdates = useCallback((value: boolean) => {
		setEnableBetaUpdatesState(value);
		window.maestro.settings.set('enableBetaUpdates', value);
	}, []);

	const setCrashReportingEnabled = useCallback((value: boolean) => {
		setCrashReportingEnabledState(value);
		window.maestro.settings.set('crashReportingEnabled', value);
	}, []);

	const setLogViewerSelectedLevels = useCallback((value: string[]) => {
		setLogViewerSelectedLevelsState(value);
		window.maestro.settings.set('logViewerSelectedLevels', value);
	}, []);

	const setCustomAICommands = useCallback((value: CustomAICommand[]) => {
		setCustomAICommandsState(value);
		window.maestro.settings.set('customAICommands', value);
	}, []);

	const setGlobalStats = useCallback((value: GlobalStats) => {
		setGlobalStatsState(value);
		window.maestro.settings.set('globalStats', value);
	}, []);

	// Update global stats by adding deltas to existing values
	const updateGlobalStats = useCallback((delta: Partial<GlobalStats>) => {
		setGlobalStatsState((prev) => {
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
			window.maestro.settings.set('globalStats', updated);
			return updated;
		});
	}, []);

	const setAutoRunStats = useCallback((value: AutoRunStats) => {
		setAutoRunStatsState(value);
		window.maestro.settings.set('autoRunStats', value);
	}, []);

	// Usage Stats setters - enforces Math.max() to never decrease peak values
	const setUsageStats = useCallback((value: MaestroUsageStats) => {
		setUsageStatsState((prev) => {
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
			window.maestro.settings.set('usageStats', updated);
			return updated;
		});
	}, []);

	// Update usage stats - only updates values if new value is higher (tracks peak usage)
	const updateUsageStats = useCallback((currentValues: Partial<MaestroUsageStats>) => {
		setUsageStatsState((prev) => {
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
			return updated;
		});
	}, []);

	// Import badge calculation from constants (moved inline to avoid circular dependency)
	const getBadgeLevelForTime = (cumulativeTimeMs: number): number => {
		// Time thresholds in milliseconds
		const MINUTE = 60 * 1000;
		const HOUR = 60 * MINUTE;
		const DAY = 24 * HOUR;
		const WEEK = 7 * DAY;
		const MONTH = 30 * DAY;

		const thresholds = [
			15 * MINUTE, // Level 1: 15 minutes
			1 * HOUR, // Level 2: 1 hour
			8 * HOUR, // Level 3: 8 hours
			1 * DAY, // Level 4: 1 day
			1 * WEEK, // Level 5: 1 week
			1 * MONTH, // Level 6: 1 month
			3 * MONTH, // Level 7: 3 months
			6 * MONTH, // Level 8: 6 months
			365 * DAY, // Level 9: 1 year
			5 * 365 * DAY, // Level 10: 5 years
			10 * 365 * DAY, // Level 11: 10 years
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
	};

	// Record an auto-run completion and check for new badges/records
	// NOTE: Cumulative time is tracked incrementally during the run via updateAutoRunProgress(),
	// so we don't add elapsedTimeMs to cumulative here - only check for longest run record and increment totalRuns
	const recordAutoRunComplete = useCallback(
		(elapsedTimeMs: number): { newBadgeLevel: number | null; isNewRecord: boolean } => {
			let newBadgeLevel: number | null = null;
			let isNewRecord = false;

			setAutoRunStatsState((prev) => {
				// Don't add to cumulative time - it was already added incrementally during the run
				// Just check current badge level in case a badge wasn't triggered during incremental updates
				const newBadgeLevelCalc = getBadgeLevelForTime(prev.cumulativeTimeMs);

				// Check if this would be a new badge (edge case: badge threshold crossed between updates)
				if (newBadgeLevelCalc > prev.lastBadgeUnlockLevel) {
					newBadgeLevel = newBadgeLevelCalc;
				}

				// Check if this is a new longest run record
				isNewRecord = elapsedTimeMs > prev.longestRunMs;

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
					lastBadgeUnlockLevel:
						newBadgeLevel !== null ? newBadgeLevelCalc : prev.lastBadgeUnlockLevel,
					lastAcknowledgedBadgeLevel: prev.lastAcknowledgedBadgeLevel ?? 0,
					badgeHistory: updatedBadgeHistory,
				};

				window.maestro.settings.set('autoRunStats', updated);
				return updated;
			});

			return { newBadgeLevel, isNewRecord };
		},
		[]
	);

	// Track progress during an active auto-run (called periodically, e.g., every minute)
	// deltaMs is the time elapsed since the last call (NOT total elapsed time)
	// This updates cumulative time and longest run WITHOUT incrementing totalRuns
	// Returns badge/record info so caller can show standing ovation during run
	const updateAutoRunProgress = useCallback(
		(deltaMs: number): { newBadgeLevel: number | null; isNewRecord: boolean } => {
			let newBadgeLevel: number | null = null;
			const isNewRecord = false;

			setAutoRunStatsState((prev) => {
				// Add the delta to cumulative time
				const newCumulativeTime = prev.cumulativeTimeMs + deltaMs;
				const newBadgeLevelCalc = getBadgeLevelForTime(newCumulativeTime);

				// Check if this unlocks a new badge
				if (newBadgeLevelCalc > prev.lastBadgeUnlockLevel) {
					newBadgeLevel = newBadgeLevelCalc;
				}

				// Note: We don't update longestRunMs here because we don't know the total
				// run time yet. That's handled when the run completes.

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
					lastBadgeUnlockLevel:
						newBadgeLevel !== null ? newBadgeLevelCalc : prev.lastBadgeUnlockLevel,
					lastAcknowledgedBadgeLevel: prev.lastAcknowledgedBadgeLevel ?? 0,
					badgeHistory: updatedBadgeHistory,
				};

				window.maestro.settings.set('autoRunStats', updated);
				return updated;
			});

			return { newBadgeLevel, isNewRecord };
		},
		[]
	);

	// Acknowledge that user has seen the standing ovation for a badge level
	const acknowledgeBadge = useCallback((level: number) => {
		setAutoRunStatsState((prev) => {
			const updated: AutoRunStats = {
				...prev,
				lastAcknowledgedBadgeLevel: Math.max(level, prev.lastAcknowledgedBadgeLevel ?? 0),
			};
			window.maestro.settings.set('autoRunStats', updated);
			return updated;
		});
	}, []);

	// Ref to read auto run stats synchronously (avoids callback recreation)
	const autoRunStatsRef = useRef<AutoRunStats>(DEFAULT_AUTO_RUN_STATS);
	useEffect(() => {
		autoRunStatsRef.current = autoRunStats;
	}, [autoRunStats]);

	// Get the highest unacknowledged badge level (if any)
	// Uses ref to read current stats, making this callback stable
	const getUnacknowledgedBadgeLevel = useCallback((): number | null => {
		const stats = autoRunStatsRef.current;
		const acknowledged = stats.lastAcknowledgedBadgeLevel ?? 0;
		const current = stats.currentBadgeLevel;
		if (current > acknowledged) {
			return current;
		}
		return null;
	}, []);

	// UI collapse state setters
	const setUngroupedCollapsed = useCallback((value: boolean) => {
		setUngroupedCollapsedState(value);
		window.maestro.settings.set('ungroupedCollapsed', value);
	}, []);

	// Onboarding setters
	const setTourCompleted = useCallback((value: boolean) => {
		setTourCompletedState(value);
		window.maestro.settings.set('tourCompleted', value);
	}, []);

	const setFirstAutoRunCompleted = useCallback((value: boolean) => {
		setFirstAutoRunCompletedState(value);
		window.maestro.settings.set('firstAutoRunCompleted', value);
	}, []);

	// Onboarding Stats functions
	const setOnboardingStats = useCallback((value: OnboardingStats) => {
		setOnboardingStatsState(value);
		window.maestro.settings.set('onboardingStats', value);
	}, []);

	// Record when wizard is started
	const recordWizardStart = useCallback(() => {
		setOnboardingStatsState((prev) => {
			const updated: OnboardingStats = {
				...prev,
				wizardStartCount: prev.wizardStartCount + 1,
			};
			window.maestro.settings.set('onboardingStats', updated);
			return updated;
		});
	}, []);

	// Record when wizard is completed successfully
	const recordWizardComplete = useCallback(
		(
			durationMs: number,
			conversationExchanges: number,
			phasesGenerated: number,
			tasksGenerated: number
		) => {
			setOnboardingStatsState((prev) => {
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
						newCompletionCount > 0
							? Math.round((newTotalExchanges / newCompletionCount) * 10) / 10
							: 0,

					// Phase generation stats
					totalPhasesGenerated: newTotalPhases,
					averagePhasesPerWizard:
						newCompletionCount > 0
							? Math.round((newTotalPhases / newCompletionCount) * 10) / 10
							: 0,
					totalTasksGenerated: newTotalTasks,
					averageTasksPerPhase:
						newTotalPhases > 0 ? Math.round((newTotalTasks / newTotalPhases) * 10) / 10 : 0,
				};
				window.maestro.settings.set('onboardingStats', updated);
				return updated;
			});
		},
		[]
	);

	// Record when wizard is abandoned (closed before completion)
	const recordWizardAbandon = useCallback(() => {
		setOnboardingStatsState((prev) => {
			const updated: OnboardingStats = {
				...prev,
				wizardAbandonCount: prev.wizardAbandonCount + 1,
			};
			window.maestro.settings.set('onboardingStats', updated);
			return updated;
		});
	}, []);

	// Record when wizard is resumed from saved state
	const recordWizardResume = useCallback(() => {
		setOnboardingStatsState((prev) => {
			const updated: OnboardingStats = {
				...prev,
				wizardResumeCount: prev.wizardResumeCount + 1,
			};
			window.maestro.settings.set('onboardingStats', updated);
			return updated;
		});
	}, []);

	// Record when tour is started
	const recordTourStart = useCallback(() => {
		setOnboardingStatsState((prev) => {
			const updated: OnboardingStats = {
				...prev,
				tourStartCount: prev.tourStartCount + 1,
			};
			window.maestro.settings.set('onboardingStats', updated);
			return updated;
		});
	}, []);

	// Record when tour is completed (all steps viewed)
	const recordTourComplete = useCallback((stepsViewed: number) => {
		setOnboardingStatsState((prev) => {
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
			window.maestro.settings.set('onboardingStats', updated);
			return updated;
		});
	}, []);

	// Record when tour is skipped before completion
	const recordTourSkip = useCallback((stepsViewed: number) => {
		setOnboardingStatsState((prev) => {
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
			window.maestro.settings.set('onboardingStats', updated);
			return updated;
		});
	}, []);

	// Ref to read onboarding stats synchronously (avoids callback recreation)
	const onboardingStatsRef = useRef<OnboardingStats>(DEFAULT_ONBOARDING_STATS);
	useEffect(() => {
		onboardingStatsRef.current = onboardingStats;
	}, [onboardingStats]);

	// Get computed analytics for display
	// Uses ref to read current stats, making this callback stable
	const getOnboardingAnalytics = useCallback(() => {
		const stats = onboardingStatsRef.current;
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
	}, []);

	// Leaderboard Registration setter
	const setLeaderboardRegistration = useCallback((value: LeaderboardRegistration | null) => {
		setLeaderboardRegistrationState(value);
		window.maestro.settings.set('leaderboardRegistration', value);
	}, []);

	// Computed property for checking if registered
	const isLeaderboardRegistered = useMemo(() => {
		return leaderboardRegistration !== null && leaderboardRegistration.emailConfirmed;
	}, [leaderboardRegistration]);

	// Web Interface settings setters
	const setWebInterfaceUseCustomPort = useCallback((value: boolean) => {
		setWebInterfaceUseCustomPortState(value);
		window.maestro.settings.set('webInterfaceUseCustomPort', value);
	}, []);

	const setWebInterfaceCustomPort = useCallback((value: number) => {
		// Store the value as-is during typing; validation happens on blur/submit
		setWebInterfaceCustomPortState(value);
		// Only persist valid port values
		if (value >= 1024 && value <= 65535) {
			window.maestro.settings.set('webInterfaceCustomPort', value);
		}
	}, []);

	// Context Management settings setters
	const setContextManagementSettings = useCallback((value: ContextManagementSettings) => {
		setContextManagementSettingsState(value);
		window.maestro.settings.set('contextManagementSettings', value);
	}, []);

	// Update partial context management settings (convenience function)
	const updateContextManagementSettings = useCallback(
		(partial: Partial<ContextManagementSettings>) => {
			setContextManagementSettingsState((prev) => {
				const updated = { ...prev, ...partial };
				window.maestro.settings.set('contextManagementSettings', updated);
				return updated;
			});
		},
		[]
	);

	// Keyboard Mastery setters and functions
	const setKeyboardMasteryStats = useCallback((value: KeyboardMasteryStats) => {
		setKeyboardMasteryStatsState(value);
		keyboardMasteryStatsRef.current = value; // Update ref immediately
		window.maestro.settings.set('keyboardMasteryStats', value);
	}, []);

	// Record usage of a shortcut - returns newLevel if user leveled up
	// Note: We read current state synchronously to return the correct level-up info
	const recordShortcutUsage = useCallback((shortcutId: string): { newLevel: number | null } => {
		// Read current state synchronously to calculate level-up before setState
		const currentStats = keyboardMasteryStatsRef.current;

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

		// Update state, ref, and persist
		setKeyboardMasteryStatsState(updated);
		keyboardMasteryStatsRef.current = updated; // Update ref immediately for next call
		window.maestro.settings.set('keyboardMasteryStats', updated);

		return { newLevel };
	}, []);

	// Acknowledge that user has seen the keyboard mastery level celebration
	const acknowledgeKeyboardMasteryLevel = useCallback((level: number) => {
		setKeyboardMasteryStatsState((prev) => {
			const updated: KeyboardMasteryStats = {
				...prev,
				lastAcknowledgedLevel: Math.max(level, prev.lastAcknowledgedLevel),
			};
			window.maestro.settings.set('keyboardMasteryStats', updated);
			return updated;
		});
	}, []);

	// Get the highest unacknowledged keyboard mastery level (if any)
	// Uses ref to read current stats, making this callback stable
	const getUnacknowledgedKeyboardMasteryLevel = useCallback((): number | null => {
		const stats = keyboardMasteryStatsRef.current;
		const acknowledged = stats.lastAcknowledgedLevel;
		const current = stats.currentLevel;
		if (current > acknowledged) {
			return current;
		}
		return null;
	}, []);

	// Colorblind mode toggle
	const setColorBlindMode = useCallback((value: boolean) => {
		setColorBlindModeState(value);
		window.maestro.settings.set('colorBlindMode', value);
	}, []);

	// Document Graph show external links
	const setDocumentGraphShowExternalLinks = useCallback((value: boolean) => {
		setDocumentGraphShowExternalLinksState(value);
		window.maestro.settings.set('documentGraphShowExternalLinks', value);
	}, []);

	// Document Graph max nodes
	const setDocumentGraphMaxNodes = useCallback((value: number) => {
		// Clamp value between 50 and 1000
		const clampedValue = Math.max(50, Math.min(1000, value));
		setDocumentGraphMaxNodesState(clampedValue);
		window.maestro.settings.set('documentGraphMaxNodes', clampedValue);
	}, []);

	// Document Graph preview character limit
	const setDocumentGraphPreviewCharLimit = useCallback((value: number) => {
		// Clamp value between 50 (minimum readable) and 500 (a couple sentences)
		const clampedValue = Math.max(50, Math.min(500, value));
		setDocumentGraphPreviewCharLimitState(clampedValue);
		window.maestro.settings.set('documentGraphPreviewCharLimit', clampedValue);
	}, []);

	// Stats collection enabled
	const setStatsCollectionEnabled = useCallback((value: boolean) => {
		setStatsCollectionEnabledState(value);
		window.maestro.settings.set('statsCollectionEnabled', value);
	}, []);

	// Default stats time range
	const setDefaultStatsTimeRange = useCallback(
		(value: 'day' | 'week' | 'month' | 'year' | 'all') => {
			setDefaultStatsTimeRangeState(value);
			window.maestro.settings.set('defaultStatsTimeRange', value);
		},
		[]
	);

	// Sleep prevention enabled (persists to settings AND calls main process)
	const setPreventSleepEnabled = useCallback(async (value: boolean) => {
		setPreventSleepEnabledState(value);
		await window.maestro.settings.set('preventSleepEnabled', value);
		await window.maestro.power.setEnabled(value);
	}, []);

	// GPU acceleration disabled (requires app restart to take effect)
	const setDisableGpuAcceleration = useCallback((value: boolean) => {
		setDisableGpuAccelerationState(value);
		window.maestro.settings.set('disableGpuAcceleration', value);
	}, []);

	// Confetti animations disabled
	const setDisableConfetti = useCallback((value: boolean) => {
		setDisableConfettiState(value);
		window.maestro.settings.set('disableConfetti', value);
	}, []);

	// Load settings from electron-store on mount
	// PERF: Use batch loading to reduce IPC calls from ~60 to 3
	useEffect(() => {
		const loadSettings = async () => {
			try {
				// Batch load all settings in a single IPC call
				const allSettings = (await window.maestro.settings.getAll()) as Record<string, unknown>;

				// Extract settings from the batch response
				const savedEnterToSendAI = allSettings['enterToSendAI'];
				const savedEnterToSendTerminal = allSettings['enterToSendTerminal'];
				const savedDefaultSaveToHistory = allSettings['defaultSaveToHistory'];
				const savedDefaultShowThinking = allSettings['defaultShowThinking'];

				const savedLlmProvider = allSettings['llmProvider'];
				const savedModelSlug = allSettings['modelSlug'];
				const savedApiKey = allSettings['apiKey'];
				const savedDefaultShell = allSettings['defaultShell'];
				const savedCustomShellPath = allSettings['customShellPath'];
				const savedShellArgs = allSettings['shellArgs'];
				const savedShellEnvVars = allSettings['shellEnvVars'];
				const savedGhPath = allSettings['ghPath'];
				const savedFontSize = allSettings['fontSize'];
				const savedFontFamily = allSettings['fontFamily'];
				const savedLeftSidebarWidth = allSettings['leftSidebarWidth'];
				const savedRightPanelWidth = allSettings['rightPanelWidth'];
				const savedMarkdownEditMode = allSettings['markdownEditMode'];
				const savedShowHiddenFiles = allSettings['showHiddenFiles'];
				const savedShortcuts = allSettings['shortcuts'];
				const savedTabShortcuts = allSettings['tabShortcuts'];
				const savedActiveThemeId = allSettings['activeThemeId'];
				const savedCustomThemeColors = allSettings['customThemeColors'];
				const savedCustomThemeBaseId = allSettings['customThemeBaseId'];
				const savedTerminalWidth = allSettings['terminalWidth'];
				// These two still need separate calls as they go through the logger API
				const savedLogLevel = await window.maestro.logger.getLogLevel();
				const savedMaxLogBuffer = await window.maestro.logger.getMaxLogBuffer();
				const savedMaxOutputLines = allSettings['maxOutputLines'];
				const savedOsNotificationsEnabled = allSettings['osNotificationsEnabled'];
				const savedAudioFeedbackEnabled = allSettings['audioFeedbackEnabled'];
				const savedAudioFeedbackCommand = allSettings['audioFeedbackCommand'];
				const savedToastDuration = allSettings['toastDuration'];
				const savedCheckForUpdatesOnStartup = allSettings['checkForUpdatesOnStartup'];
				const savedEnableBetaUpdates = allSettings['enableBetaUpdates'];
				const savedCrashReportingEnabled = allSettings['crashReportingEnabled'];
				const savedLogViewerSelectedLevels = allSettings['logViewerSelectedLevels'];
				const savedCustomAICommands = allSettings['customAICommands'];
				const savedGlobalStats = allSettings['globalStats'];
				const savedAutoRunStats = allSettings['autoRunStats'];
				const savedUsageStats = allSettings['usageStats'];
				const concurrentAutoRunTimeMigrationApplied =
					allSettings['concurrentAutoRunTimeMigrationApplied'];
				const savedUngroupedCollapsed = allSettings['ungroupedCollapsed'];
				const savedTourCompleted = allSettings['tourCompleted'];
				const savedFirstAutoRunCompleted = allSettings['firstAutoRunCompleted'];
				const savedOnboardingStats = allSettings['onboardingStats'];
				const savedLeaderboardRegistration = allSettings['leaderboardRegistration'];
				const savedWebInterfaceUseCustomPort = allSettings['webInterfaceUseCustomPort'];
				const savedWebInterfaceCustomPort = allSettings['webInterfaceCustomPort'];
				const savedContextManagementSettings = allSettings['contextManagementSettings'];
				const savedKeyboardMasteryStats = allSettings['keyboardMasteryStats'];
				const savedColorBlindMode = allSettings['colorBlindMode'];
				const savedDocumentGraphShowExternalLinks = allSettings['documentGraphShowExternalLinks'];
				const savedDocumentGraphMaxNodes = allSettings['documentGraphMaxNodes'];
				const savedDocumentGraphPreviewCharLimit = allSettings['documentGraphPreviewCharLimit'];
				const savedStatsCollectionEnabled = allSettings['statsCollectionEnabled'];
				const savedDefaultStatsTimeRange = allSettings['defaultStatsTimeRange'];
				const savedPreventSleepEnabled = allSettings['preventSleepEnabled'];
				const savedDisableGpuAcceleration = allSettings['disableGpuAcceleration'];
				const savedDisableConfetti = allSettings['disableConfetti'];

				if (savedEnterToSendAI !== undefined) setEnterToSendAIState(savedEnterToSendAI as boolean);
				if (savedEnterToSendTerminal !== undefined)
					setEnterToSendTerminalState(savedEnterToSendTerminal as boolean);
				if (savedDefaultSaveToHistory !== undefined)
					setDefaultSaveToHistoryState(savedDefaultSaveToHistory as boolean);
				if (savedDefaultShowThinking !== undefined)
					setDefaultShowThinkingState(savedDefaultShowThinking as boolean);

				if (savedLlmProvider !== undefined) setLlmProviderState(savedLlmProvider as LLMProvider);
				if (savedModelSlug !== undefined) setModelSlugState(savedModelSlug as string);
				if (savedApiKey !== undefined) setApiKeyState(savedApiKey as string);
				if (savedDefaultShell !== undefined) setDefaultShellState(savedDefaultShell as string);
				if (savedCustomShellPath !== undefined)
					setCustomShellPathState(savedCustomShellPath as string);
				if (savedShellArgs !== undefined) setShellArgsState(savedShellArgs as string);
				if (savedShellEnvVars !== undefined)
					setShellEnvVarsState(savedShellEnvVars as Record<string, string>);
				if (savedGhPath !== undefined) setGhPathState(savedGhPath as string);
				if (savedFontSize !== undefined) setFontSizeState(savedFontSize as number);
				if (savedFontFamily !== undefined) setFontFamilyState(savedFontFamily as string);
				if (savedLeftSidebarWidth !== undefined)
					setLeftSidebarWidthState(Math.max(256, Math.min(600, savedLeftSidebarWidth as number)));
				if (savedRightPanelWidth !== undefined)
					setRightPanelWidthState(savedRightPanelWidth as number);
				if (savedMarkdownEditMode !== undefined)
					setMarkdownEditModeState(savedMarkdownEditMode as boolean);
				if (savedShowHiddenFiles !== undefined)
					setShowHiddenFilesState(savedShowHiddenFiles as boolean);
				if (savedActiveThemeId !== undefined) setActiveThemeIdState(savedActiveThemeId as ThemeId);
				if (savedCustomThemeColors !== undefined)
					setCustomThemeColorsState(savedCustomThemeColors as ThemeColors);
				if (savedCustomThemeBaseId !== undefined)
					setCustomThemeBaseIdState(savedCustomThemeBaseId as ThemeId);
				if (savedTerminalWidth !== undefined) setTerminalWidthState(savedTerminalWidth as number);
				if (savedLogLevel !== undefined) setLogLevelState(savedLogLevel);
				if (savedMaxLogBuffer !== undefined) setMaxLogBufferState(savedMaxLogBuffer);
				if (savedMaxOutputLines !== undefined)
					setMaxOutputLinesState(savedMaxOutputLines as number);
				if (savedOsNotificationsEnabled !== undefined)
					setOsNotificationsEnabledState(savedOsNotificationsEnabled as boolean);
				if (savedAudioFeedbackEnabled !== undefined)
					setAudioFeedbackEnabledState(savedAudioFeedbackEnabled as boolean);
				if (savedAudioFeedbackCommand !== undefined)
					setAudioFeedbackCommandState(savedAudioFeedbackCommand as string);
				if (savedToastDuration !== undefined) setToastDurationState(savedToastDuration as number);
				if (savedCheckForUpdatesOnStartup !== undefined)
					setCheckForUpdatesOnStartupState(savedCheckForUpdatesOnStartup as boolean);
				if (savedEnableBetaUpdates !== undefined)
					setEnableBetaUpdatesState(savedEnableBetaUpdates as boolean);
				if (savedCrashReportingEnabled !== undefined)
					setCrashReportingEnabledState(savedCrashReportingEnabled as boolean);
				if (savedLogViewerSelectedLevels !== undefined)
					setLogViewerSelectedLevelsState(savedLogViewerSelectedLevels as string[]);

				// Merge saved shortcuts with defaults (in case new shortcuts were added)
				if (savedShortcuts !== undefined) {
					// Migration: Fix shortcuts that were recorded with macOS Alt+key special characters
					// On macOS, Alt+L produces '¬', Alt+P produces 'π', etc. These should be 'l', 'p', etc.
					const macAltCharMap: Record<string, string> = {
						'¬': 'l', // Alt+L
						π: 'p', // Alt+P
						'†': 't', // Alt+T
						'∫': 'b', // Alt+B
						'∂': 'd', // Alt+D
						ƒ: 'f', // Alt+F
						'©': 'g', // Alt+G
						'˙': 'h', // Alt+H
						ˆ: 'i', // Alt+I (circumflex)
						'∆': 'j', // Alt+J
						'˚': 'k', // Alt+K
						'¯': 'm', // Alt+M (macron, though some keyboards differ)
						'˜': 'n', // Alt+N
						ø: 'o', // Alt+O
						'®': 'r', // Alt+R
						ß: 's', // Alt+S
						'√': 'v', // Alt+V
						'∑': 'w', // Alt+W
						'≈': 'x', // Alt+X
						'¥': 'y', // Alt+Y
						Ω: 'z', // Alt+Z
					};

					const migratedShortcuts: Record<string, Shortcut> = {};
					let needsMigration = false;

					for (const [id, shortcut] of Object.entries(savedShortcuts as Record<string, Shortcut>)) {
						const migratedKeys = shortcut.keys.map((key) => {
							if (macAltCharMap[key]) {
								needsMigration = true;
								return macAltCharMap[key];
							}
							return key;
						});
						migratedShortcuts[id] = { ...shortcut, keys: migratedKeys };
					}

					// If migration was needed, save the corrected shortcuts
					if (needsMigration) {
						window.maestro.settings.set('shortcuts', migratedShortcuts);
					}

					// Merge: use default labels (in case they changed) but preserve user's custom keys
					const mergedShortcuts: Record<string, Shortcut> = {};
					for (const [id, defaultShortcut] of Object.entries(DEFAULT_SHORTCUTS)) {
						const savedShortcut = migratedShortcuts[id];
						mergedShortcuts[id] = {
							...defaultShortcut,
							// Preserve user's custom keys if they exist
							keys: savedShortcut?.keys ?? defaultShortcut.keys,
						};
					}
					setShortcutsState(mergedShortcuts);
				}

				// Merge saved tab shortcuts with defaults (in case new shortcuts were added)
				if (savedTabShortcuts !== undefined) {
					// Apply same macOS Alt+key migration
					const macAltCharMap: Record<string, string> = {
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

					const migratedTabShortcuts: Record<string, Shortcut> = {};
					let needsTabMigration = false;

					for (const [id, shortcut] of Object.entries(
						savedTabShortcuts as Record<string, Shortcut>
					)) {
						const migratedKeys = shortcut.keys.map((key) => {
							if (macAltCharMap[key]) {
								needsTabMigration = true;
								return macAltCharMap[key];
							}
							return key;
						});
						migratedTabShortcuts[id] = { ...shortcut, keys: migratedKeys };
					}

					if (needsTabMigration) {
						window.maestro.settings.set('tabShortcuts', migratedTabShortcuts);
					}

					// Merge: use default labels but preserve user's custom keys
					const mergedTabShortcuts: Record<string, Shortcut> = {};
					for (const [id, defaultShortcut] of Object.entries(TAB_SHORTCUTS)) {
						const savedShortcut = migratedTabShortcuts[id];
						mergedTabShortcuts[id] = {
							...defaultShortcut,
							keys: savedShortcut?.keys ?? defaultShortcut.keys,
						};
					}
					setTabShortcutsState(mergedTabShortcuts);
				}

				// Merge saved AI commands with defaults (ensure built-in commands always exist)
				if (savedCustomAICommands !== undefined && Array.isArray(savedCustomAICommands)) {
					// Start with defaults, then merge saved commands (by ID to avoid duplicates)
					const commandsById = new Map<string, CustomAICommand>();
					DEFAULT_AI_COMMANDS.forEach((cmd) => commandsById.set(cmd.id, cmd));
					(savedCustomAICommands as CustomAICommand[]).forEach((cmd: CustomAICommand) => {
						// Migration: Skip old /synopsis command - it was renamed to /history which is now
						// a built-in command handled by Maestro directly (not a custom AI command)
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
					setCustomAICommandsState(Array.from(commandsById.values()));
				}

				// Load global stats
				if (savedGlobalStats !== undefined) {
					setGlobalStatsState({
						...DEFAULT_GLOBAL_STATS,
						...(savedGlobalStats as Partial<GlobalStats>),
					});
				}

				// Load auto-run stats
				if (savedAutoRunStats !== undefined) {
					let stats = {
						...DEFAULT_AUTO_RUN_STATS,
						...(savedAutoRunStats as Partial<AutoRunStats>),
					};

					// One-time migration: Add 3 hours to compensate for bug where concurrent Auto Runs
					// weren't being tallied correctly (fixed in v0.11.3)
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

					setAutoRunStatsState(stats);
				}

				// Load usage stats
				if (savedUsageStats !== undefined) {
					setUsageStatsState({
						...DEFAULT_USAGE_STATS,
						...(savedUsageStats as Partial<MaestroUsageStats>),
					});
				}

				// Load onboarding settings
				// UI collapse states
				if (savedUngroupedCollapsed !== undefined)
					setUngroupedCollapsedState(savedUngroupedCollapsed as boolean);

				if (savedTourCompleted !== undefined) setTourCompletedState(savedTourCompleted as boolean);
				if (savedFirstAutoRunCompleted !== undefined)
					setFirstAutoRunCompletedState(savedFirstAutoRunCompleted as boolean);

				// Load onboarding stats
				if (savedOnboardingStats !== undefined) {
					setOnboardingStatsState({
						...DEFAULT_ONBOARDING_STATS,
						...(savedOnboardingStats as Partial<OnboardingStats>),
					});
				}

				// Load leaderboard registration
				if (savedLeaderboardRegistration !== undefined) {
					setLeaderboardRegistrationState(
						savedLeaderboardRegistration as LeaderboardRegistration | null
					);
				}

				// Load web interface settings
				if (savedWebInterfaceUseCustomPort !== undefined)
					setWebInterfaceUseCustomPortState(savedWebInterfaceUseCustomPort as boolean);
				if (savedWebInterfaceCustomPort !== undefined)
					setWebInterfaceCustomPortState(savedWebInterfaceCustomPort as number);

				// Load context management settings
				if (savedContextManagementSettings !== undefined) {
					setContextManagementSettingsState({
						...DEFAULT_CONTEXT_MANAGEMENT_SETTINGS,
						...(savedContextManagementSettings as Partial<ContextManagementSettings>),
					});
				}

				// Load keyboard mastery stats
				if (savedKeyboardMasteryStats !== undefined) {
					setKeyboardMasteryStatsState({
						...DEFAULT_KEYBOARD_MASTERY_STATS,
						...(savedKeyboardMasteryStats as Partial<KeyboardMasteryStats>),
					});
				}

				// Accessibility settings
				if (savedColorBlindMode !== undefined)
					setColorBlindModeState(savedColorBlindMode as boolean);

				// Document Graph settings
				if (savedDocumentGraphShowExternalLinks !== undefined) {
					setDocumentGraphShowExternalLinksState(savedDocumentGraphShowExternalLinks as boolean);
				}
				if (savedDocumentGraphMaxNodes !== undefined) {
					const maxNodes = savedDocumentGraphMaxNodes as number;
					if (typeof maxNodes === 'number' && maxNodes >= 50 && maxNodes <= 1000) {
						setDocumentGraphMaxNodesState(maxNodes);
					}
				}
				if (savedDocumentGraphPreviewCharLimit !== undefined) {
					const charLimit = savedDocumentGraphPreviewCharLimit as number;
					if (typeof charLimit === 'number' && charLimit >= 50 && charLimit <= 500) {
						setDocumentGraphPreviewCharLimitState(charLimit);
					}
				}

				// Stats settings
				if (savedStatsCollectionEnabled !== undefined) {
					setStatsCollectionEnabledState(savedStatsCollectionEnabled as boolean);
				}
				if (savedDefaultStatsTimeRange !== undefined) {
					const validTimeRanges = ['day', 'week', 'month', 'year', 'all'];
					if (validTimeRanges.includes(savedDefaultStatsTimeRange as string)) {
						setDefaultStatsTimeRangeState(
							savedDefaultStatsTimeRange as 'day' | 'week' | 'month' | 'year' | 'all'
						);
					}
				}

				// Power management settings
				// Note: The main process loads this setting on its own at startup from settingsStore,
				// so we only need to sync the renderer state here.
				if (savedPreventSleepEnabled !== undefined) {
					setPreventSleepEnabledState(savedPreventSleepEnabled as boolean);
				}

				// Rendering settings
				// Note: GPU setting is read by the main process before app.ready, so changes require restart.
				if (savedDisableGpuAcceleration !== undefined) {
					setDisableGpuAccelerationState(savedDisableGpuAcceleration as boolean);
				}
				if (savedDisableConfetti !== undefined) {
					setDisableConfettiState(savedDisableConfetti as boolean);
				}
			} catch (error) {
				console.error('[Settings] Failed to load settings:', error);
			} finally {
				// Mark settings as loaded even if there was an error (use defaults)
				setSettingsLoaded(true);
			}
		};
		loadSettings();
	}, []);

	// Apply font size to HTML root element so rem-based Tailwind classes scale
	// Only apply after settings are loaded to prevent layout shift from default->saved font size
	useEffect(() => {
		if (settingsLoaded) {
			document.documentElement.style.fontSize = `${fontSize}px`;
		}
	}, [fontSize, settingsLoaded]);

	// PERF: Memoize return object to prevent unnecessary re-renders in consumers
	return useMemo(
		() => ({
			settingsLoaded,
			llmProvider,
			modelSlug,
			apiKey,
			setLlmProvider,
			setModelSlug,
			setApiKey,
			defaultShell,
			setDefaultShell,
			customShellPath,
			setCustomShellPath,
			shellArgs,
			setShellArgs,
			shellEnvVars,
			setShellEnvVars,
			ghPath,
			setGhPath,
			fontFamily,
			fontSize,
			setFontFamily,
			setFontSize,
			activeThemeId,
			setActiveThemeId,
			customThemeColors,
			setCustomThemeColors,
			customThemeBaseId,
			setCustomThemeBaseId,
			enterToSendAI,
			setEnterToSendAI,
			enterToSendTerminal,
			setEnterToSendTerminal,
			defaultSaveToHistory,
			setDefaultSaveToHistory,
			defaultShowThinking,
			setDefaultShowThinking,
			leftSidebarWidth,
			rightPanelWidth,
			markdownEditMode,
			setLeftSidebarWidth,
			setRightPanelWidth,
			setMarkdownEditMode,
			showHiddenFiles,
			setShowHiddenFiles,
			terminalWidth,
			setTerminalWidth,
			logLevel,
			setLogLevel,
			maxLogBuffer,
			setMaxLogBuffer,
			maxOutputLines,
			setMaxOutputLines,
			osNotificationsEnabled,
			setOsNotificationsEnabled,
			audioFeedbackEnabled,
			setAudioFeedbackEnabled,
			audioFeedbackCommand,
			setAudioFeedbackCommand,
			toastDuration,
			setToastDuration,
			checkForUpdatesOnStartup,
			setCheckForUpdatesOnStartup,
			enableBetaUpdates,
			setEnableBetaUpdates,
			crashReportingEnabled,
			setCrashReportingEnabled,
			logViewerSelectedLevels,
			setLogViewerSelectedLevels,
			shortcuts,
			setShortcuts,
			tabShortcuts,
			setTabShortcuts,
			customAICommands,
			setCustomAICommands,
			globalStats,
			setGlobalStats,
			updateGlobalStats,
			autoRunStats,
			setAutoRunStats,
			recordAutoRunComplete,
			updateAutoRunProgress,
			acknowledgeBadge,
			getUnacknowledgedBadgeLevel,
			usageStats,
			setUsageStats,
			updateUsageStats,
			ungroupedCollapsed,
			setUngroupedCollapsed,
			tourCompleted,
			setTourCompleted,
			firstAutoRunCompleted,
			setFirstAutoRunCompleted,
			onboardingStats,
			setOnboardingStats,
			recordWizardStart,
			recordWizardComplete,
			recordWizardAbandon,
			recordWizardResume,
			recordTourStart,
			recordTourComplete,
			recordTourSkip,
			getOnboardingAnalytics,
			leaderboardRegistration,
			setLeaderboardRegistration,
			isLeaderboardRegistered,
			webInterfaceUseCustomPort,
			setWebInterfaceUseCustomPort,
			webInterfaceCustomPort,
			setWebInterfaceCustomPort,
			contextManagementSettings,
			setContextManagementSettings,
			updateContextManagementSettings,
			keyboardMasteryStats,
			setKeyboardMasteryStats,
			recordShortcutUsage,
			acknowledgeKeyboardMasteryLevel,
			getUnacknowledgedKeyboardMasteryLevel,
			colorBlindMode,
			setColorBlindMode,
			documentGraphShowExternalLinks,
			setDocumentGraphShowExternalLinks,
			documentGraphMaxNodes,
			setDocumentGraphMaxNodes,
			documentGraphPreviewCharLimit,
			setDocumentGraphPreviewCharLimit,
			statsCollectionEnabled,
			setStatsCollectionEnabled,
			defaultStatsTimeRange,
			setDefaultStatsTimeRange,
			preventSleepEnabled,
			setPreventSleepEnabled,
			disableGpuAcceleration,
			setDisableGpuAcceleration,
			disableConfetti,
			setDisableConfetti,
		}),
		[
			// State values
			settingsLoaded,
			llmProvider,
			modelSlug,
			apiKey,
			defaultShell,
			customShellPath,
			shellArgs,
			shellEnvVars,
			ghPath,
			fontFamily,
			fontSize,
			activeThemeId,
			customThemeColors,
			customThemeBaseId,
			enterToSendAI,
			enterToSendTerminal,
			defaultSaveToHistory,
			defaultShowThinking,
			leftSidebarWidth,
			rightPanelWidth,
			markdownEditMode,
			showHiddenFiles,
			terminalWidth,
			logLevel,
			maxLogBuffer,
			maxOutputLines,
			osNotificationsEnabled,
			audioFeedbackEnabled,
			audioFeedbackCommand,
			toastDuration,
			checkForUpdatesOnStartup,
			enableBetaUpdates,
			crashReportingEnabled,
			logViewerSelectedLevels,
			shortcuts,
			tabShortcuts,
			customAICommands,
			globalStats,
			autoRunStats,
			usageStats,
			ungroupedCollapsed,
			tourCompleted,
			firstAutoRunCompleted,
			onboardingStats,
			// Setter functions (stable via useCallback)
			setLlmProvider,
			setModelSlug,
			setApiKey,
			setDefaultShell,
			setCustomShellPath,
			setShellArgs,
			setShellEnvVars,
			setGhPath,
			setFontFamily,
			setFontSize,
			setActiveThemeId,
			setCustomThemeColors,
			setCustomThemeBaseId,
			setEnterToSendAI,
			setEnterToSendTerminal,
			setDefaultSaveToHistory,
			setDefaultShowThinking,
			setLeftSidebarWidth,
			setRightPanelWidth,
			setMarkdownEditMode,
			setShowHiddenFiles,
			setTerminalWidth,
			setLogLevel,
			setMaxLogBuffer,
			setMaxOutputLines,
			setOsNotificationsEnabled,
			setAudioFeedbackEnabled,
			setAudioFeedbackCommand,
			setToastDuration,
			setCheckForUpdatesOnStartup,
			setEnableBetaUpdates,
			setCrashReportingEnabled,
			setLogViewerSelectedLevels,
			setShortcuts,
			setTabShortcuts,
			setCustomAICommands,
			setGlobalStats,
			updateGlobalStats,
			setAutoRunStats,
			recordAutoRunComplete,
			updateAutoRunProgress,
			acknowledgeBadge,
			// getUnacknowledgedBadgeLevel is stable (uses ref), no need to include
			setUngroupedCollapsed,
			setTourCompleted,
			setFirstAutoRunCompleted,
			setOnboardingStats,
			recordWizardStart,
			recordWizardComplete,
			recordWizardAbandon,
			recordWizardResume,
			recordTourStart,
			recordTourComplete,
			recordTourSkip,
			// getOnboardingAnalytics is stable (uses ref), no need to include
			leaderboardRegistration,
			setLeaderboardRegistration,
			isLeaderboardRegistered,
			webInterfaceUseCustomPort,
			setWebInterfaceUseCustomPort,
			webInterfaceCustomPort,
			setWebInterfaceCustomPort,
			contextManagementSettings,
			setContextManagementSettings,
			updateContextManagementSettings,
			keyboardMasteryStats,
			setKeyboardMasteryStats,
			recordShortcutUsage,
			acknowledgeKeyboardMasteryLevel,
			// getUnacknowledgedKeyboardMasteryLevel is stable (uses ref), no need to include
			colorBlindMode,
			setColorBlindMode,
			documentGraphShowExternalLinks,
			setDocumentGraphShowExternalLinks,
			documentGraphMaxNodes,
			setDocumentGraphMaxNodes,
			documentGraphPreviewCharLimit,
			setDocumentGraphPreviewCharLimit,
			statsCollectionEnabled,
			setStatsCollectionEnabled,
			defaultStatsTimeRange,
			setDefaultStatsTimeRange,
			preventSleepEnabled,
			setPreventSleepEnabled,
			disableGpuAcceleration,
			setDisableGpuAcceleration,
			disableConfetti,
			setDisableConfetti,
		]
	);
}
