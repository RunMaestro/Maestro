/**
 * useSettings - Thin adapter over settingsStore
 *
 * Delegates all state and actions to the Zustand settingsStore.
 * Keeps 3 DOM/lifecycle side effects that require React hooks:
 * 1. Load settings on mount
 * 2. Reload settings on system resume from sleep
 * 3. Apply font size to document root element
 *
 * The UseSettingsReturn interface is unchanged - zero consumer changes needed.
 */

import { useEffect } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { shallow } from 'zustand/shallow';
import type { BrowserConfirmPolicy } from '../../../shared/coworkingBrowser';
import type { TtsrContextMode } from '../../../shared/ttsr-types';
import type {
	LLMProvider,
	ThemeId,
	ThemeColors,
	Shortcut,
	CustomAICommand,
	AutoRunStats,
	MaestroUsageStats,
	OnboardingStats,
	LeaderboardRegistration,
	ContextManagementSettings,
	KeyboardMasteryStats,
	ThinkingMode,
	DirectorNotesSettings,
	EncoreFeatureFlags,
} from '../../types';
import type { FileExplorerIconTheme } from '../../utils/fileExplorerIcons/shared';
import type { ToastWidth } from '../../../shared/toastWidth';
import {
	useSettingsStore,
	loadAllSettings,
	selectIsLeaderboardRegistered,
} from '../../stores/settingsStore';
import type { SettingsStore } from '../../stores/settingsStore';
import type {
	DocumentGraphLayoutType,
	FilePreviewToolbarButton,
	FilePreviewToolbarVisibility,
} from '../../stores/settingsStore';
import type { ModalResizeKey, ModalSize, ModalSizes } from '../../utils/modalSizing';
import { notifyToast } from '../../stores/notificationStore';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { logger } from '../../utils/logger';

export interface UseSettingsReturn {
	// Loading state
	settingsLoaded: boolean;

	// Conductor Profile (About Me)
	conductorProfile: string;
	setConductorProfile: (value: string) => void;

	// Global show-Maestro hotkey (system-wide). Empty array = unset.
	globalShowHotkey: string[];
	setGlobalShowHotkey: (value: string[]) => void;

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
	enterToSendAIExpanded: boolean;
	setEnterToSendAIExpanded: (value: boolean) => void;
	defaultSaveToHistory: boolean;
	setDefaultSaveToHistory: (value: boolean) => void;
	synopsisDebounceSeconds: number;
	setSynopsisDebounceSeconds: (value: number) => void;

	// Default thinking toggle (three states: 'off' | 'on' | 'sticky')
	defaultShowThinking: ThinkingMode;
	setDefaultShowThinking: (value: ThinkingMode) => void;
	leftSidebarWidth: number;
	rightPanelWidth: number;
	modalSizes: ModalSizes;
	markdownEditMode: boolean;
	chatRawTextMode: boolean;
	groupChatAutoScroll: boolean;
	bionifyReadingMode: boolean;
	bionifyIntensity: number;
	bionifyAlgorithm: string;
	setLeftSidebarWidth: (value: number) => void;
	setRightPanelWidth: (value: number) => void;
	setModalSize: (key: ModalResizeKey, value: ModalSize) => void;
	resetModalSizes: () => void;
	setMarkdownEditMode: (value: boolean) => void;
	setChatRawTextMode: (value: boolean) => void;
	setGroupChatAutoScroll: (value: boolean) => void;
	setBionifyReadingMode: (value: boolean) => void;
	setBionifyIntensity: (value: number) => void;
	setBionifyAlgorithm: (value: string) => void;
	showHiddenFiles: boolean;
	setShowHiddenFiles: (value: boolean) => void;
	fileExplorerIconTheme: FileExplorerIconTheme;
	setFileExplorerIconTheme: (value: FileExplorerIconTheme) => void;
	toastWidth: ToastWidth;
	setToastWidth: (value: ToastWidth) => void;

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
	idleNotificationEnabled: boolean;
	setIdleNotificationEnabled: (value: boolean) => void;
	idleNotificationCommand: string;
	setIdleNotificationCommand: (value: string) => void;

	// Update settings
	checkForUpdatesOnStartup: boolean;
	setCheckForUpdatesOnStartup: (value: boolean) => void;
	// Auto-resume paused agents when provider limits/credits become available again
	autoResumeOnLimit: boolean;
	setAutoResumeOnLimit: (value: boolean) => void;
	autoResumeCheckIntervalHours: number;
	setAutoResumeCheckIntervalHours: (value: number) => void;
	autoResumeGiveUpDays: number;
	setAutoResumeGiveUpDays: (value: number) => void;
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

	// Standalone active time (migrated from globalStats.totalActiveTimeMs)
	totalActiveTimeMs: number;
	setTotalActiveTimeMs: (value: number) => void;
	addTotalActiveTimeMs: (delta: number) => void;

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
	groupChatsExpanded: boolean;
	setGroupChatsExpanded: (value: boolean) => void;
	starredSessionsCollapsed: boolean;
	setStarredSessionsCollapsed: (value: boolean) => void;

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

	// Tab filtering settings
	showStarredInUnreadFilter: boolean;
	setShowStarredInUnreadFilter: (value: boolean) => void;
	showFilePreviewsInUnreadFilter: boolean;
	setShowFilePreviewsInUnreadFilter: (value: boolean) => void;
	useCmd0AsLastTab: boolean;
	setUseCmd0AsLastTab: (value: boolean) => void;
	showBrowserTabDomain: boolean;
	setShowBrowserTabDomain: (value: boolean) => void;
	tabBarWheelScroll: boolean;
	setTabBarWheelScroll: (value: boolean) => void;

	// Document Graph settings
	documentGraphShowExternalLinks: boolean;
	setDocumentGraphShowExternalLinks: (value: boolean) => void;
	documentGraphMaxNodes: number;
	setDocumentGraphMaxNodes: (value: number) => void;
	documentGraphPreviewCharLimit: number;
	setDocumentGraphPreviewCharLimit: (value: number) => void;
	documentGraphLayoutType: DocumentGraphLayoutType;
	setDocumentGraphLayoutType: (value: DocumentGraphLayoutType) => void;

	// Stats settings
	statsCollectionEnabled: boolean;
	setStatsCollectionEnabled: (value: boolean) => void;
	defaultStatsTimeRange: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all';
	setDefaultStatsTimeRange: (value: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all') => void;

	// Power management settings
	preventSleepEnabled: boolean;
	setPreventSleepEnabled: (value: boolean) => Promise<void>;

	// Rendering settings
	disableGpuAcceleration: boolean;
	setDisableGpuAcceleration: (value: boolean) => void;
	disableConfetti: boolean;
	setDisableConfetti: (value: boolean) => void;

	// Local file indexing ignore patterns
	localIgnorePatterns: string[];
	setLocalIgnorePatterns: (value: string[]) => void;
	localHonorGitignore: boolean;
	setLocalHonorGitignore: (value: boolean) => void;

	// File explorer indexing limits (global)
	fileExplorerMaxDepth: number;
	setFileExplorerMaxDepth: (value: number) => void;
	fileExplorerMaxEntries: number;
	setFileExplorerMaxEntries: (value: number) => void;
	sshReduceEntryCapEnabled: boolean;
	setSshReduceEntryCapEnabled: (value: boolean) => void;
	sshReduceEntryCapFraction: number;
	setSshReduceEntryCapFraction: (value: number) => void;

	// SSH Remote file indexing settings
	sshRemoteIgnorePatterns: string[];
	setSshRemoteIgnorePatterns: (value: string[]) => void;
	sshRemoteHonorGitignore: boolean;
	setSshRemoteHonorGitignore: (value: boolean) => void;

	// Browser settings
	useSystemBrowser: boolean;
	setUseSystemBrowser: (value: boolean) => void;
	browserHomeUrl: string;
	setBrowserHomeUrl: (value: string) => void;
	htmlDoubleClickOpensInBrowser: boolean;
	setHtmlDoubleClickOpensInBrowser: (value: boolean) => void;
	browserTabKeepAlive: 'off' | 'recent' | 'all';
	setBrowserTabKeepAlive: (value: 'off' | 'recent' | 'all') => void;
	browserTabKeepAliveLimit: number;
	setBrowserTabKeepAliveLimit: (value: number) => void;

	// Automatic tab naming settings
	automaticTabNamingEnabled: boolean;
	setAutomaticTabNamingEnabled: (value: boolean) => void;

	// Where new tabs are inserted in the tab bar (per content type)
	newTabPlacement: 'end' | 'after-current';
	setNewTabPlacement: (value: 'end' | 'after-current') => void;
	newBrowserTabPlacement: 'end' | 'after-current';
	setNewBrowserTabPlacement: (value: 'end' | 'after-current') => void;
	newTerminalPlacement: 'end' | 'after-current';
	setNewTerminalPlacement: (value: 'end' | 'after-current') => void;
	openedFilePlacement: 'end' | 'after-current';
	setOpenedFilePlacement: (value: 'end' | 'after-current') => void;

	// File tab auto-refresh settings
	fileTabAutoRefreshEnabled: boolean;
	setFileTabAutoRefreshEnabled: (value: boolean) => void;

	// Windows warning suppression
	suppressWindowsWarning: boolean;
	setSuppressWindowsWarning: (value: boolean) => void;

	// Message alignment
	userMessageAlignment: 'left' | 'right';
	setUserMessageAlignment: (value: 'left' | 'right') => void;

	// Encore Features - optional features disabled by default
	encoreFeatures: EncoreFeatureFlags;
	setEncoreFeatures: (value: EncoreFeatureFlags) => void;

	// Symphony registry URLs (additional user-configured registries)
	symphonyRegistryUrls: string[];
	setSymphonyRegistryUrls: (value: string[]) => void;

	// TTSR (Time-Traveling Stream Rules)
	ttsrEnabled: boolean;
	setTtsrEnabled: (value: boolean) => void;
	ttsrDisabledRules: string[];
	setTtsrDisabledRules: (value: string[]) => void;
	ttsrContextMode: TtsrContextMode;
	setTtsrContextMode: (value: TtsrContextMode) => void;

	// Coworking browser interaction (agent ids allowed to use browser tools)
	coworkingBrowserInteraction: string[];
	setCoworkingBrowserInteraction: (value: string[]) => void;
	coworkingBrowserInteractionConfirm: Record<string, BrowserConfirmPolicy>;
	setCoworkingBrowserInteractionConfirm: (value: Record<string, BrowserConfirmPolicy>) => void;
	coworkingBackgroundBrowsers: boolean;
	setCoworkingBackgroundBrowsers: (value: boolean) => void;
	coworkingBackgroundBrowsersLimit: number;
	setCoworkingBackgroundBrowsersLimit: (value: number) => void;

	// Forced Parallel Execution
	forcedParallelExecution: boolean;
	setForcedParallelExecution: (value: boolean) => void;
	forcedParallelAcknowledged: boolean;
	setForcedParallelAcknowledged: (value: boolean) => void;

	// Director's Notes settings
	directorNotesSettings: DirectorNotesSettings;
	setDirectorNotesSettings: (value: DirectorNotesSettings) => void;

	// WakaTime integration settings
	wakatimeApiKey: string;
	setWakatimeApiKey: (value: string) => void;
	wakatimeEnabled: boolean;
	setWakatimeEnabled: (value: boolean) => void;
	wakatimeDetailedTracking: boolean;
	setWakatimeDetailedTracking: (value: boolean) => void;

	// Window chrome settings
	useNativeTitleBar: boolean;
	setUseNativeTitleBar: (value: boolean) => void;
	autoHideMenuBar: boolean;
	setAutoHideMenuBar: (value: boolean) => void;

	// Main header panel pill toggles
	showAgentName: boolean;
	setShowAgentName: (value: boolean) => void;
	showSessionIdPill: boolean;
	setShowSessionIdPill: (value: boolean) => void;
	showSessionCostPill: boolean;
	setShowSessionCostPill: (value: boolean) => void;

	// Worktree display in left panel agent list
	showWorktreePill: boolean;
	setShowWorktreePill: (value: boolean) => void;
	showWorktreeBranchName: boolean;
	setShowWorktreeBranchName: (value: boolean) => void;

	// Left side panel
	showStarredSessionsSection: boolean;
	setShowStarredSessionsSection: (value: boolean) => void;
	showLeftPanelGroupMemberCount: boolean;
	setShowLeftPanelGroupMemberCount: (value: boolean) => void;
	leftPanelCollapsedPillsPerRow: number;
	setLeftPanelCollapsedPillsPerRow: (value: number) => void;
	showLeftPanelLocationPills: boolean;
	setShowLeftPanelLocationPills: (value: boolean) => void;
	showLeftPanelGitIndicator: boolean;
	setShowLeftPanelGitIndicator: (value: boolean) => void;
	showLeftPanelCueIndicator: boolean;
	setShowLeftPanelCueIndicator: (value: boolean) => void;
	showLeftPanelStartupCommandIndicator: boolean;
	setShowLeftPanelStartupCommandIndicator: (value: boolean) => void;
	showGroupLabelInBookmarks: boolean;
	setShowGroupLabelInBookmarks: (value: boolean) => void;
	showFullGroupLabelInBookmarks: boolean;
	setShowFullGroupLabelInBookmarks: (value: boolean) => void;

	// File Edit & Preview
	fileEditWordWrap: boolean;
	setFileEditWordWrap: (value: boolean) => void;
	fileEditShowLineNumbers: boolean;
	setFileEditShowLineNumbers: (value: boolean) => void;
	filePreviewToolbarVisibility: FilePreviewToolbarVisibility;
	setFilePreviewToolbarButtonVisibility: (button: FilePreviewToolbarButton, value: boolean) => void;

	// Group Chat settings
	moderatorStandingInstructions: string;
	setModeratorStandingInstructions: (value: string) => void;

	// Auto Run kill switch
	autoRunDisabled: boolean;
	setAutoRunDisabled: (value: boolean) => void;
	autoRunInactivityTimeoutMin: number;
	setAutoRunInactivityTimeoutMin: (value: number) => void;
	autoRunMaxTaskDurationMin: number;
	setAutoRunMaxTaskDurationMin: (value: number) => void;

	// Built-in AI command bundle visibility
	speckitEnabled: boolean;
	setSpeckitEnabled: (value: boolean) => void;
	openspecEnabled: boolean;
	setOpenspecEnabled: (value: boolean) => void;
	bmadEnabled: boolean;
	setBmadEnabled: (value: boolean) => void;

	// Hide ".files" (dotfiles) toggle in file explorer toolbar
	dotfilesToggleHidden: boolean;
	setDotfilesToggleHidden: (value: boolean) => void;

	// Spell check
	spellCheck: boolean;
	setSpellCheck: (value: boolean) => void;
}

// PERF: Identity selector reused across renders so the hook doesn't allocate a new
// selector function each call (Zustand's useStoreWithEqualityFn would otherwise see
// a fresh selector and recompute every render).
const selectAllSettings = (s: SettingsStore): SettingsStore => s;

export function useSettings(): UseSettingsReturn {
	// PERF: Subscribe with shallow equality on the top-level state so a `set()` call that
	// only flips one field doesn't re-render every consumer of useSettings. Critically,
	// when an action calls `set({ x: value })` where `x === value` already, the resulting
	// state object has a new reference but identical fields - shallow equality stops the
	// re-render cascade through MaestroConsoleInner → GitStatusProvider → workspace tree.
	const store = useStoreWithEqualityFn(useSettingsStore, selectAllSettings, shallow);
	const isLeaderboardRegistered = useSettingsStore(selectIsLeaderboardRegistered);

	// Load settings on mount
	useEffect(() => {
		window.__updateSplash?.(45, 'Reading the score...');
		loadAllSettings();
	}, []);

	// Reload settings when system resumes from sleep/suspend
	useEffect(() => {
		if (!window.maestro?.app?.onSystemResume) {
			return;
		}
		const cleanup = window.maestro.app.onSystemResume(() => {
			logger.info('[Settings] System resumed from sleep, reloading settings');
			loadAllSettings();
		});
		return cleanup;
	}, []);

	// Reload settings when external change detected (e.g., maestro-cli settings set)
	useEffect(() => {
		if (!window.maestro?.settings?.onExternalChange) {
			return;
		}
		const cleanup = window.maestro.settings.onExternalChange(() => {
			logger.info('[Settings] External settings change detected, reloading');
			loadAllSettings();
		});
		return cleanup;
	}, []);

	// Apply font size to HTML root element so rem-based Tailwind classes scale.
	// Also expose --font-scale so fixed-width modals can scale proportionally
	// (see .modal-w-* utility classes in index.css). 14px is the design baseline.
	// Only apply after settings are loaded to prevent layout shift from default->saved font size
	useEffect(() => {
		if (store.settingsLoaded) {
			document.documentElement.style.fontSize = `${store.fontSize}px`;
			document.documentElement.style.setProperty('--font-scale', String(store.fontSize / 14));
		}
	}, [store.fontSize, store.settingsLoaded]);

	// Surface global-hotkey registration failures (e.g. combo already owned by
	// another app). Mounted here so the toast fires even when Settings is closed.
	useEffect(() => {
		if (!window.maestro?.app?.onGlobalHotkeyRegistrationFailed) return;
		const cleanup = window.maestro.app.onGlobalHotkeyRegistrationFailed((keys) => {
			const combo = keys.length > 0 ? formatShortcutKeys(keys) : '(none)';
			logger.warn(`[Settings] Global hotkey registration failed: ${combo}`);
			notifyToast({
				color: 'orange',
				title: 'Global hotkey unavailable',
				message: `${combo} is already in use by another app. Pick a different combo in Settings → General.`,
				dismissible: true,
			});
		});
		return cleanup;
	}, []);

	return {
		...store,
		isLeaderboardRegistered,
	};
}
