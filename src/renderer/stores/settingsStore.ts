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
 * - Works outside React: services can read/write via useSettingsStore.getState()
 * - Single batch load on startup eliminates ~60 individual IPC calls
 *
 * Can be used outside React via useSettingsStore.getState() / useSettingsStore.setState().
 */

import { create } from 'zustand';
import type { BrowserConfirmPolicy } from '../../shared/coworkingBrowser';
import { isWindowsPlatform } from '../utils/platformUtils';
import type {
	LLMProvider,
	CustomAICommand,
	AchievementTimeSource,
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
import { FIXED_SHORTCUTS } from '../constants/shortcuts';
import {
	collectBoundShortcuts,
	countUsedBoundShortcuts,
	getLevelIndex,
} from '../constants/keyboardMastery';
import { RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH } from '../constants/rightPanel';
import type { MindMapLayoutType } from '../components/DocumentGraph/layoutTypes';
import { isMindMapLayoutType } from '../components/DocumentGraph/layoutTypes';
import { normalizePlaybackRate } from '../../shared/mediaTypes';
import {
	MEDIA_FLOAT_SETTINGS_KEY,
	MEDIA_QUEUE_SETTINGS_KEY,
	useMediaPlaybackStore,
	type PersistedMediaQueue,
} from './mediaPlaybackStore';
import { sanitizeMediaItems, sanitizeMediaTimes } from '../utils/mediaItems';
import { sanitizeMediaFloat } from '../utils/mediaFloatGeometry';
import { logger } from '../utils/logger';
import { useUIStore } from './uiStore';
import {
	useSnoozeHistoryStore,
	sanitizeSnoozeHistory,
	SNOOZE_HISTORY_SETTINGS_KEY,
} from './snoozeHistoryStore';
import type { ModalPosition, ModalResizeKey, ModalSize, ModalSizes } from '../utils/modalSizing';
import { normalizeModalPosition, sanitizeModalSizes } from '../utils/modalSizing';
import type { AnnotatorState, AnnotatorActions } from './settingsAnnotatorSlice';
import { createAnnotatorSlice, hydrateAnnotatorSettings } from './settingsAnnotatorSlice';
import type { WakatimeState, WakatimeActions } from './settingsWakatimeSlice';
import { createWakatimeSlice, hydrateWakatimeSettings } from './settingsWakatimeSlice';
import type { FileExplorerState, FileExplorerActions } from './settingsFileExplorerSlice';
import { createFileExplorerSlice, hydrateFileExplorerSettings } from './settingsFileExplorerSlice';
import type { NotificationsState, NotificationsActions } from './settingsNotificationsSlice';
import {
	createNotificationsSlice,
	hydrateNotificationsSettings,
} from './settingsNotificationsSlice';
import type {
	LeftPanelDisplayState,
	LeftPanelDisplayActions,
} from './settingsLeftPanelDisplaySlice';
import {
	createLeftPanelDisplaySlice,
	hydrateLeftPanelDisplaySettings,
} from './settingsLeftPanelDisplaySlice';
import type { BrowserTabsState, BrowserTabsActions } from './settingsBrowserTabsSlice';
import { createBrowserTabsSlice, hydrateBrowserTabsSettings } from './settingsBrowserTabsSlice';
import type { ShortcutsState, ShortcutsActions } from './settingsShortcutsSlice';
import { createShortcutsSlice, hydrateShortcutsSettings } from './settingsShortcutsSlice';
import type { ThemeState, ThemeActions } from './settingsThemeSlice';
import { createThemeSlice, hydrateThemeSettings } from './settingsThemeSlice';
export {
	DEFAULT_LOCAL_IGNORE_PATTERNS,
	DEFAULT_FILE_EXPLORER_MAX_DEPTH,
	FILE_EXPLORER_MIN_DEPTH,
	FILE_EXPLORER_MAX_DEPTH_CAP,
	DEFAULT_FILE_EXPLORER_MAX_ENTRIES,
	FILE_EXPLORER_MIN_ENTRIES,
	FILE_EXPLORER_MAX_ENTRIES_CAP,
	DEFAULT_SSH_REDUCE_ENTRY_CAP_FRACTION,
	SSH_REDUCE_ENTRY_CAP_MIN_FRACTION,
	SSH_REDUCE_ENTRY_CAP_MAX_FRACTION,
	SSH_REDUCE_ENTRY_CAP_STEP,
} from './settingsFileExplorerSlice';
import type { TextareaHeights, TextareaSizeKey } from '../utils/textareaSizing';
import { sanitizeTextareaHeights } from '../utils/textareaSizing';
import { normalizeUnlockedMilestone } from '../../shared/delegation';

// ============================================================================
// Prompt cache (loaded via IPC at startup)
// ============================================================================

let cachedCommitCommandPrompt: string = '';
let settingsStorePromptsLoaded = false;

export async function loadSettingsStorePrompts(force = false): Promise<void> {
	if (settingsStorePromptsLoaded && !force) return;

	const result = await window.maestro.prompts.get('commit-command');
	if (!result.success) {
		throw new Error(`Failed to load commit-command prompt: ${result.error}`);
	}
	cachedCommitCommandPrompt = result.content!;

	// Migrate legacy AI Commands override before finalizing the prompt value.
	// On first load: the store was created with an empty prompt from module-load time.
	// On refresh (force=true): the user edited/reset the prompt in Settings.
	const currentCommands = useSettingsStore.getState().customAICommands;
	const commitCmd = currentCommands.find((c) => c.id === 'commit');
	if (commitCmd && commitCmd.prompt !== cachedCommitCommandPrompt) {
		if (commitCmd.prompt && !force) {
			// User has a non-empty custom prompt from AI Commands (old way) - migrate it
			const saveResult = await window.maestro.prompts.save('commit-command', commitCmd.prompt);
			if (saveResult.success) {
				cachedCommitCommandPrompt = commitCmd.prompt;
			}
		} else {
			// First load (empty) or refresh - update store with loaded prompt
			useSettingsStore.setState({
				customAICommands: currentCommands.map((c) =>
					c.id === 'commit' ? { ...c, prompt: cachedCommitCommandPrompt } : c
				),
			});
		}
	}

	// Finalize after migration so DEFAULT_AI_COMMANDS reflects the final prompt value
	DEFAULT_AI_COMMANDS = [
		{
			id: 'commit',
			command: '/commit',
			description: 'Commit outstanding changes and push up',
			prompt: cachedCommitCommandPrompt,
			isBuiltIn: true,
		},
	];
	settingsStorePromptsLoaded = true;
}

function getCommitCommandPrompt(): string {
	return cachedCommitCommandPrompt;
}

// ============================================================================
// Shared Type Aliases
// ============================================================================

/**
 * Alias kept for the existing call sites. The layout names themselves live in
 * `DocumentGraph/layoutTypes`, which is also what the graph's own toolbar and
 * `L` cycle read - a private copy here silently rejected any layout added to
 * the graph but not mirrored into this file.
 */
export type DocumentGraphLayoutType = MindMapLayoutType;

const DEFAULT_CONTEXT_MANAGEMENT_SETTINGS: ContextManagementSettings = {
	autoGroomContexts: true,
	maxContextTokens: 100000,
	showMergePreview: true,
	groomingTimeout: 60000,
	preferredGroomingAgent: 'fastest',
	contextWarningsEnabled: false,
	contextWarningYellowThreshold: 75,
	contextWarningRedThreshold: 90,
};

const DEFAULT_AUTO_RUN_STATS: AutoRunStats = {
	cumulativeTimeMs: 0,
	cueTimeMs: 0,
	longestRunMs: 0,
	longestRunTimestamp: 0,
	totalRuns: 0,
	currentBadgeLevel: 0,
	lastBadgeUnlockLevel: 0,
	lastAcknowledgedBadgeLevel: 0,
	badgeHistory: [],
};

const DEFAULT_USAGE_STATS: MaestroUsageStats = {
	maxAgents: 0,
	maxDefinedAgents: 0,
	maxSimultaneousAutoRuns: 0,
	maxSimultaneousQueries: 0,
	maxQueueDepth: 0,
};

const DEFAULT_KEYBOARD_MASTERY_STATS: KeyboardMasteryStats = {
	usedShortcuts: [],
	currentLevel: 0,
	lastLevelUpTimestamp: 0,
	lastAcknowledgedLevel: 0,
};

const DEFAULT_ONBOARDING_STATS: OnboardingStats = {
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

const DEFAULT_ENCORE_FEATURES: EncoreFeatureFlags = {
	directorNotes: false,
	usageStats: true,
	symphony: true,
	maestroCue: false,
	pianola: false,
	plugins: false,
	concerto: false,
	groupsPlus: false,
};

// File Preview / Edit toolbar buttons. Each key maps to a visibility toggle in
// Settings → Display → File Edit & Preview. Buttons can be hidden but the
// underlying actions stay reachable via the command palette and hotkeys.
export const FILE_PREVIEW_TOOLBAR_BUTTON_KEYS = [
	'save',
	'wordWrap',
	'remoteImages',
	'htmlRender',
	'openInBrowser',
	'previewTier',
	'editToggle',
	'editImage',
	'copyContent',
	'publishGist',
	'documentGraph',
	'openInDefault',
	'revealInFolder',
	'copyPath',
	'delete',
] as const;

export type FilePreviewToolbarButton = (typeof FILE_PREVIEW_TOOLBAR_BUTTON_KEYS)[number];

export type FilePreviewToolbarVisibility = Record<FilePreviewToolbarButton, boolean>;

export const DEFAULT_FILE_PREVIEW_TOOLBAR_VISIBILITY: FilePreviewToolbarVisibility =
	FILE_PREVIEW_TOOLBAR_BUTTON_KEYS.reduce((acc, k) => {
		acc[k] = true;
		return acc;
	}, {} as FilePreviewToolbarVisibility);

const DEFAULT_DIRECTOR_NOTES_SETTINGS: DirectorNotesSettings = {
	provider: 'claude-code',
	defaultLookbackDays: 7,
	defaultMode: 'rich',
};

// Uses `let` so the binding updates after loadSettingsStorePrompts() populates the cache
let DEFAULT_AI_COMMANDS: CustomAICommand[] = [
	{
		id: 'commit',
		command: '/commit',
		description: 'Commit outstanding changes and push up',
		prompt: getCommitCommandPrompt(),
		isBuiltIn: true,
	},
];

// ============================================================================
// Helper Functions
// ============================================================================

function getBadgeLevelForTime(cumulativeTimeMs: number): number {
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

export interface SettingsStoreState
	extends
		AnnotatorState,
		WakatimeState,
		FileExplorerState,
		NotificationsState,
		LeftPanelDisplayState,
		BrowserTabsState,
		ShortcutsState,
		ThemeState {
	settingsLoaded: boolean;
	conductorProfile: string;
	globalShowHotkey: string[];
	llmProvider: LLMProvider;
	modelSlug: string;
	apiKey: string;
	defaultShell: string;
	customShellPath: string;
	shellArgs: string;
	shellEnvVars: Record<string, string>;
	/**
	 * Variables the user switched OFF in the environment editor. Same shape as
	 * `shellEnvVars`, but nothing reads it except the editor: parking a variable
	 * here is what keeps it out of every spawned process while preserving its
	 * value for later. Never merge this into a spawn env.
	 */
	shellEnvVarsDisabled: Record<string, string>;
	ghPath: string;
	/** Playback speed for audio/video in the file preview. Sticky across files. */
	mediaPlaybackRate: number;
	enterToSendAI: boolean;
	enterToSendAIExpanded: boolean;
	forcedParallelExecution: boolean;
	forcedParallelAcknowledged: boolean;
	/** When forced parallel is on, treat EVERY send as a force-send (no modifier needed). */
	forcedParallelAlways: boolean;
	/** When true, agents consulted via @-mention may write; when false (default), consults are read-only. */
	crossAgentMentionsWritable: boolean;
	defaultSaveToHistory: boolean;
	synopsisDebounceSeconds: number;
	defaultShowThinking: ThinkingMode;
	showToolCalls: boolean;
	leftSidebarWidth: number;
	rightPanelWidth: number;
	modalSizes: ModalSizes;
	/** Concerto stage presentation: true = popped out into a floating window. */
	concertoStageFloating: boolean;
	/** Where the popped-out Concerto stage was last dragged to, or null. */
	concertoStagePosition: ModalPosition | null;
	textareaHeights: TextareaHeights;
	markdownEditMode: boolean;
	chatRawTextMode: boolean;
	groupChatAutoScroll: boolean;
	bionifyReadingMode: boolean;
	bionifyIntensity: number;
	bionifyAlgorithm: string;
	terminalWidth: number;
	logLevel: string;
	maxLogBuffer: number;
	maxOutputLines: number;
	checkForUpdatesOnStartup: boolean;
	autoResumeOnLimit: boolean;
	autoResumeCheckIntervalHours: number;
	autoResumeGiveUpDays: number;
	enableBetaUpdates: boolean;
	crashReportingEnabled: boolean;
	logViewerSelectedLevels: string[];
	customAICommands: CustomAICommand[];
	totalActiveTimeMs: number;
	/**
	 * Highest delegation milestone ever unlocked (0 | 25 | 50 | 75 | 100).
	 *
	 * A high-water mark, not the live score: the delegation percentage is a
	 * ratio over retained history and can fall when you do a stretch of
	 * interactive work, and a bar that un-fills would read as losing something
	 * you earned. The live number rides a separate marker on the same track.
	 */
	delegationMilestone: number;
	autoRunStats: AutoRunStats;
	usageStats: MaestroUsageStats;
	ungroupedCollapsed: boolean;
	groupChatsExpanded: boolean;
	groupChatSortAlphabetical: boolean;
	starredSessionsCollapsed: boolean;
	tourCompleted: boolean;
	firstAutoRunCompleted: boolean;
	onboardingStats: OnboardingStats;
	leaderboardRegistration: LeaderboardRegistration | null;
	persistentWebLink: boolean;
	webInterfaceAutoStart: boolean;
	webInterfaceUseCustomPort: boolean;
	webInterfaceCustomPort: number;
	contextManagementSettings: ContextManagementSettings;
	keyboardMasteryStats: KeyboardMasteryStats;
	showStarredInUnreadFilter: boolean;
	showFilePreviewsInUnreadFilter: boolean;
	showTerminalTabsInUnreadFilter: boolean;
	showBrowserTabsInUnreadFilter: boolean;
	useCmd0AsLastTab: boolean;
	documentGraphShowExternalLinks: boolean;
	documentGraphConfirmClose: boolean;
	documentGraphMaxNodes: number;
	documentGraphPreviewCharLimit: number;
	documentGraphLayoutType: DocumentGraphLayoutType;
	statsCollectionEnabled: boolean;
	defaultStatsTimeRange: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all';
	preventSleepEnabled: boolean;
	disableGpuAcceleration: boolean;
	disableConfetti: boolean;
	suppressWindowsWarning: boolean;
	userMessageAlignment: 'left' | 'right';
	utilityAgentId: string | null;
	utilityModelId: string | null;
	encoreFeatures: EncoreFeatureFlags;
	symphonyRegistryUrls: string[];
	coworkingBrowserInteraction: string[];
	coworkingBrowserInteractionConfirm: Record<string, BrowserConfirmPolicy>;
	coworkingBackgroundBrowsers: boolean;
	coworkingBackgroundBrowsersLimit: number;
	directorNotesSettings: DirectorNotesSettings;
	useNativeTitleBar: boolean;
	autoHideMenuBar: boolean;
	// File Edit & Preview
	fileEditWordWrap: boolean;
	fileEditShowLineNumbers: boolean;
	filePreviewToolbarVisibility: FilePreviewToolbarVisibility;
	moderatorStandingInstructions: string;
	autoRunDisabled: boolean;
	dotfilesToggleHidden: boolean;
	autoRunInactivityTimeoutMin: number;
	autoRunMaxTaskDurationMin: number;
	speckitEnabled: boolean;
	openspecEnabled: boolean;
	bmadEnabled: boolean;
	lastSelectedPromptId: string | null;
	spellCheck: boolean;
}

export interface SettingsStoreActions
	extends
		AnnotatorActions,
		WakatimeActions,
		FileExplorerActions,
		NotificationsActions,
		LeftPanelDisplayActions,
		BrowserTabsActions,
		ShortcutsActions,
		ThemeActions {
	// Simple setters
	setConductorProfile: (value: string) => void;
	setGlobalShowHotkey: (value: string[]) => void;
	setLlmProvider: (value: LLMProvider) => void;
	setModelSlug: (value: string) => void;
	setApiKey: (value: string) => void;
	setDefaultShell: (value: string) => void;
	setCustomShellPath: (value: string) => void;
	setShellArgs: (value: string) => void;
	setShellEnvVars: (value: Record<string, string>) => void;
	setShellEnvVarsDisabled: (value: Record<string, string>) => void;
	setGhPath: (value: string) => void;
	setMediaPlaybackRate: (value: number) => void;
	setEnterToSendAI: (value: boolean) => void;
	setEnterToSendAIExpanded: (value: boolean) => void;
	setForcedParallelExecution: (value: boolean) => void;
	setForcedParallelAcknowledged: (value: boolean) => void;
	setForcedParallelAlways: (value: boolean) => void;
	setCrossAgentMentionsWritable: (value: boolean) => void;
	setDefaultSaveToHistory: (value: boolean) => void;
	setSynopsisDebounceSeconds: (value: number) => void;
	setDefaultShowThinking: (value: ThinkingMode) => void;
	setShowToolCalls: (value: boolean) => void;
	setLeftSidebarWidth: (value: number) => void;
	setRightPanelWidth: (value: number) => void;
	setModalSize: (key: ModalResizeKey, value: ModalSize) => void;
	/** Forget ONE modal's remembered size, so it reopens at its declared default. */
	resetModalSize: (key: ModalResizeKey) => void;
	resetModalSizes: () => void;
	setConcertoStageFloating: (value: boolean) => void;
	setConcertoStagePosition: (value: ModalPosition | null) => void;
	/** Remember the height a user dragged a resizable textarea to. */
	setTextareaHeight: (key: TextareaSizeKey, value: number) => void;
	setMarkdownEditMode: (value: boolean) => void;
	setChatRawTextMode: (value: boolean) => void;
	setGroupChatAutoScroll: (value: boolean) => void;
	setBionifyReadingMode: (value: boolean) => void;
	setBionifyIntensity: (value: number) => void;
	setBionifyAlgorithm: (value: string) => void;
	setTerminalWidth: (value: number) => void;
	setMaxOutputLines: (value: number) => void;
	setCheckForUpdatesOnStartup: (value: boolean) => void;
	setAutoResumeOnLimit: (value: boolean) => void;
	setAutoResumeCheckIntervalHours: (value: number) => void;
	setAutoResumeGiveUpDays: (value: number) => void;
	setEnableBetaUpdates: (value: boolean) => void;
	setCrashReportingEnabled: (value: boolean) => void;
	setLogViewerSelectedLevels: (value: string[]) => void;
	setCustomAICommands: (value: CustomAICommand[]) => void;
	setUngroupedCollapsed: (value: boolean) => void;
	setGroupChatsExpanded: (value: boolean) => void;
	setGroupChatSortAlphabetical: (value: boolean) => void;
	setStarredSessionsCollapsed: (value: boolean) => void;
	setTourCompleted: (value: boolean) => void;
	setFirstAutoRunCompleted: (value: boolean) => void;
	setLeaderboardRegistration: (value: LeaderboardRegistration | null) => void;
	setPersistentWebLink: (value: boolean) => Promise<void>;
	setWebInterfaceAutoStart: (value: boolean) => void;
	setWebInterfaceUseCustomPort: (value: boolean) => void;
	setWebInterfaceCustomPort: (value: number) => void;
	setShowStarredInUnreadFilter: (value: boolean) => void;
	setShowFilePreviewsInUnreadFilter: (value: boolean) => void;
	setShowTerminalTabsInUnreadFilter: (value: boolean) => void;
	setShowBrowserTabsInUnreadFilter: (value: boolean) => void;
	setUseCmd0AsLastTab: (value: boolean) => void;
	setDocumentGraphShowExternalLinks: (value: boolean) => void;
	setDocumentGraphConfirmClose: (value: boolean) => void;
	setDocumentGraphMaxNodes: (value: number) => void;
	setDocumentGraphPreviewCharLimit: (value: number) => void;
	setDocumentGraphLayoutType: (value: DocumentGraphLayoutType) => void;
	setStatsCollectionEnabled: (value: boolean) => void;
	setDefaultStatsTimeRange: (value: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all') => void;
	setDisableGpuAcceleration: (value: boolean) => void;
	setDisableConfetti: (value: boolean) => void;
	setSuppressWindowsWarning: (value: boolean) => void;
	setUserMessageAlignment: (value: 'left' | 'right') => void;
	setUtilityAgentId: (value: string | null) => void;
	setUtilityModelId: (value: string | null) => void;
	setEncoreFeatures: (value: EncoreFeatureFlags) => void;
	setSymphonyRegistryUrls: (value: string[]) => void;
	setCoworkingBrowserInteraction: (value: string[]) => void;
	setCoworkingBrowserInteractionConfirm: (value: Record<string, BrowserConfirmPolicy>) => void;
	setCoworkingBackgroundBrowsers: (value: boolean) => void;
	setCoworkingBackgroundBrowsersLimit: (value: number) => void;
	setDirectorNotesSettings: (value: DirectorNotesSettings) => void;
	setUseNativeTitleBar: (value: boolean) => void;
	setAutoHideMenuBar: (value: boolean) => void;
	setFileEditWordWrap: (value: boolean) => void;
	setFileEditShowLineNumbers: (value: boolean) => void;
	setFilePreviewToolbarButtonVisibility: (button: FilePreviewToolbarButton, value: boolean) => void;
	setModeratorStandingInstructions: (value: string) => void;
	setAutoRunDisabled: (value: boolean) => void;
	setDotfilesToggleHidden: (value: boolean) => void;
	setAutoRunInactivityTimeoutMin: (value: number) => void;
	setAutoRunMaxTaskDurationMin: (value: number) => void;
	setSpeckitEnabled: (value: boolean) => void;
	setOpenspecEnabled: (value: boolean) => void;
	setBmadEnabled: (value: boolean) => void;
	setLastSelectedPromptId: (value: string | null) => void;
	setSpellCheck: (value: boolean) => void;

	// Async setters
	setLogLevel: (value: string) => Promise<void>;
	setMaxLogBuffer: (value: number) => Promise<void>;
	setPreventSleepEnabled: (value: boolean) => Promise<void>;

	// Standalone active time
	setTotalActiveTimeMs: (value: number) => void;
	addTotalActiveTimeMs: (delta: number) => void;

	// Delegation milestone high-water mark
	unlockDelegationMilestone: (milestone: number) => void;

	// Usage stats
	setUsageStats: (value: MaestroUsageStats) => void;
	updateUsageStats: (currentValues: Partial<MaestroUsageStats>) => void;

	// Auto-run stats
	setAutoRunStats: (value: AutoRunStats) => void;
	recordAutoRunComplete: (elapsedTimeMs: number) => {
		newBadgeLevel: number | null;
		isNewRecord: boolean;
	};
	/**
	 * Credit a block of autonomous time toward the Conductor level. `source`
	 * defaults to 'autoRun'; pass 'cue' so the block also lands in the Cue
	 * subtotal shown on the About card.
	 */
	updateAutoRunProgress: (
		deltaMs: number,
		source?: AchievementTimeSource
	) => {
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

/** Shared renderer selector for every Groups+ surface. */
export const selectGroupsPlusEnabled = (state: SettingsStore) =>
	state.encoreFeatures.groupsPlus === true;

// ============================================================================
// Auto Run watchdog helpers
// ============================================================================

/** Default absolute cap (minutes) on a single Auto Run task before force-kill. */
export const DEFAULT_AUTORUN_MAX_TASK_DURATION_MIN = 480;

/**
 * Clamp a user-entered max-task-duration to the persisted range. 0 is the
 * explicit "unlimited" sentinel (no absolute cap); any positive value is rounded
 * and clamped to [1, 1440] minutes.
 */
export function clampAutoRunMaxTaskDurationMin(value: number): number {
	const rounded = Math.round(value);
	return rounded <= 0 ? 0 : Math.max(1, Math.min(1440, rounded));
}

/**
 * Sanitize a persisted max-task-duration read back from disk. Only a finite,
 * non-negative number is trustworthy: 0 stays "unlimited", a positive value is
 * clamped. Anything else (NaN, Infinity, negative, wrong type) is corrupt and
 * falls back to the default so a bad stored value can never silently DISABLE the
 * watchdog and let a chatty-but-stuck task hang the whole Auto Run.
 */
export function sanitizeLoadedAutoRunMaxTaskDurationMin(raw: unknown): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)
		return DEFAULT_AUTORUN_MAX_TASK_DURATION_MIN;
	return clampAutoRunMaxTaskDurationMin(raw);
}

// ============================================================================
// Store Implementation
// ============================================================================

/**
 * Resolve whether a send should force-parallel (bypass the busy-agent queue).
 *
 * The feature is a two-level opt-in:
 *  - `forcedParallelExecution` off  → never force (gate closed).
 *  - on, "modifier" mode            → force only when the caller passed the
 *    explicit override (the ⌘⇧↩ shortcut or the Force Send button).
 *  - on, "always" mode              → force EVERY send, no modifier needed.
 *
 * Single source of truth for all send paths (inline composer, expanded
 * composer, custom commands). Reads the store directly so callers don't
 * duplicate the truth table.
 */
export function resolveForceParallel(optionForce?: boolean): boolean {
	const s = useSettingsStore.getState();
	if (!s.forcedParallelExecution) return false;
	return optionForce === true || s.forcedParallelAlways;
}

export const useSettingsStore = create<SettingsStore>()((set, get, api) => {
	/** Monotonic counter to discard stale async completions in setPersistentWebLink */
	let persistentWebLinkRequestSeq = 0;

	return {
		// ============================================================================
		// State (defaults)
		// ============================================================================

		settingsLoaded: false,
		conductorProfile: '',
		globalShowHotkey: [],
		llmProvider: 'openrouter',
		modelSlug: 'anthropic/claude-3.5-sonnet',
		apiKey: '',
		defaultShell: isWindowsPlatform() ? 'powershell' : 'zsh',
		customShellPath: '',
		shellArgs: '',
		shellEnvVars: {},
		shellEnvVarsDisabled: {},
		ghPath: '',
		mediaPlaybackRate: 1,
		enterToSendAI: true,
		enterToSendAIExpanded: false,
		forcedParallelExecution: false,
		forcedParallelAcknowledged: false,
		forcedParallelAlways: false,
		crossAgentMentionsWritable: false,
		defaultSaveToHistory: true,
		synopsisDebounceSeconds: 0,
		defaultShowThinking: 'off',
		showToolCalls: true,
		leftSidebarWidth: 256,
		rightPanelWidth: 384,
		modalSizes: {},
		concertoStageFloating: false,
		concertoStagePosition: null,
		textareaHeights: {},
		markdownEditMode: false,
		chatRawTextMode: false,
		groupChatAutoScroll: true,
		bionifyReadingMode: false,
		bionifyIntensity: 1,
		bionifyAlgorithm: '- 0 1 1 2 0.4',
		terminalWidth: 100,
		logLevel: 'info',
		maxLogBuffer: 5000,
		maxOutputLines: Infinity,
		checkForUpdatesOnStartup: true,
		autoResumeOnLimit: true,
		autoResumeCheckIntervalHours: 2,
		autoResumeGiveUpDays: 7,
		enableBetaUpdates: false,
		crashReportingEnabled: true,
		logViewerSelectedLevels: ['debug', 'info', 'warn', 'error', 'toast'],
		customAICommands: DEFAULT_AI_COMMANDS,
		totalActiveTimeMs: 0,
		delegationMilestone: 0,
		autoRunStats: DEFAULT_AUTO_RUN_STATS,
		usageStats: DEFAULT_USAGE_STATS,
		ungroupedCollapsed: false,
		groupChatsExpanded: true,
		groupChatSortAlphabetical: false,
		starredSessionsCollapsed: false,
		tourCompleted: false,
		firstAutoRunCompleted: false,
		onboardingStats: DEFAULT_ONBOARDING_STATS,
		leaderboardRegistration: null,
		persistentWebLink: false,
		webInterfaceAutoStart: false,
		webInterfaceUseCustomPort: false,
		webInterfaceCustomPort: 8080,
		contextManagementSettings: DEFAULT_CONTEXT_MANAGEMENT_SETTINGS,
		keyboardMasteryStats: DEFAULT_KEYBOARD_MASTERY_STATS,
		showStarredInUnreadFilter: false,
		showFilePreviewsInUnreadFilter: false,
		showTerminalTabsInUnreadFilter: false,
		showBrowserTabsInUnreadFilter: false,
		useCmd0AsLastTab: true,
		documentGraphShowExternalLinks: false,
		documentGraphConfirmClose: true,
		documentGraphMaxNodes: 50,
		documentGraphPreviewCharLimit: 100,
		documentGraphLayoutType: 'hierarchical',
		statsCollectionEnabled: true,
		defaultStatsTimeRange: 'week',
		preventSleepEnabled: false,
		disableGpuAcceleration: false,
		disableConfetti: false,
		suppressWindowsWarning: false,
		userMessageAlignment: 'right',
		utilityAgentId: null,
		utilityModelId: null,
		encoreFeatures: DEFAULT_ENCORE_FEATURES,
		symphonyRegistryUrls: [],
		coworkingBrowserInteraction: [],
		coworkingBrowserInteractionConfirm: {},
		coworkingBackgroundBrowsers: false,
		coworkingBackgroundBrowsersLimit: 2,
		directorNotesSettings: DEFAULT_DIRECTOR_NOTES_SETTINGS,
		useNativeTitleBar: isWindowsPlatform(),
		autoHideMenuBar: false,
		fileEditWordWrap: true,
		fileEditShowLineNumbers: true,
		filePreviewToolbarVisibility: { ...DEFAULT_FILE_PREVIEW_TOOLBAR_VISIBILITY },
		moderatorStandingInstructions: '',
		autoRunDisabled: false,
		dotfilesToggleHidden: false,
		autoRunInactivityTimeoutMin: 240,
		autoRunMaxTaskDurationMin: DEFAULT_AUTORUN_MAX_TASK_DURATION_MIN,
		speckitEnabled: true,
		openspecEnabled: true,
		bmadEnabled: true,
		lastSelectedPromptId: null,
		spellCheck: false,

		...createAnnotatorSlice(set, get, api),
		...createWakatimeSlice(set, get, api),
		...createFileExplorerSlice(set, get, api),
		...createNotificationsSlice(set, get, api),
		...createLeftPanelDisplaySlice(set, get, api),
		...createBrowserTabsSlice(set, get, api),
		...createShortcutsSlice(set, get, api),
		...createThemeSlice(set, get, api),

		// ============================================================================
		// Simple Setters
		// ============================================================================

		setConductorProfile: (value) => {
			const trimmed = value.slice(0, 5000);
			set({ conductorProfile: trimmed });
			window.maestro.settings.set('conductorProfile', trimmed);
		},

		setGlobalShowHotkey: (value) => {
			set({ globalShowHotkey: value });
			window.maestro.settings.set('globalShowHotkey', value);
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

		setShellEnvVarsDisabled: (value) => {
			set({ shellEnvVarsDisabled: value });
			window.maestro.settings.set('shellEnvVarsDisabled', value);
		},

		setGhPath: (value) => {
			set({ ghPath: value });
			window.maestro.settings.set('ghPath', value);
		},

		setMediaPlaybackRate: (value) => {
			const rate = normalizePlaybackRate(value);
			set({ mediaPlaybackRate: rate });
			window.maestro.settings.set('mediaPlaybackRate', rate);
		},

		setEnterToSendAI: (value) => {
			set({ enterToSendAI: value });
			window.maestro.settings.set('enterToSendAI', value);
		},

		setEnterToSendAIExpanded: (value) => {
			set({ enterToSendAIExpanded: value });
			window.maestro.settings.set('enterToSendAIExpanded', value);
		},

		setForcedParallelExecution: (value) => {
			set({ forcedParallelExecution: value });
			window.maestro.settings.set('forcedParallelExecution', value);
		},

		setForcedParallelAcknowledged: (value) => {
			set({ forcedParallelAcknowledged: value });
			window.maestro.settings.set('forcedParallelAcknowledged', value);
		},

		setForcedParallelAlways: (value) => {
			set({ forcedParallelAlways: value });
			window.maestro.settings.set('forcedParallelAlways', value);
		},

		setCrossAgentMentionsWritable: (value) => {
			set({ crossAgentMentionsWritable: value });
			window.maestro.settings.set('crossAgentMentionsWritable', value);
		},

		setDefaultSaveToHistory: (value) => {
			set({ defaultSaveToHistory: value });
			window.maestro.settings.set('defaultSaveToHistory', value);
		},

		setSynopsisDebounceSeconds: (value) => {
			const clamped = Math.max(0, Math.round(value));
			set({ synopsisDebounceSeconds: clamped });
			window.maestro.settings.set('synopsisDebounceSeconds', clamped);
		},

		setDefaultShowThinking: (value) => {
			set({ defaultShowThinking: value });
			window.maestro.settings.set('defaultShowThinking', value);
		},

		setShowToolCalls: (value) => {
			set({ showToolCalls: value });
			window.maestro.settings.set('showToolCalls', value);
		},

		setLeftSidebarWidth: (value) => {
			const clamped = Math.max(256, Math.min(600, value));
			set({ leftSidebarWidth: clamped });
			window.maestro.settings.set('leftSidebarWidth', clamped);
		},

		setRightPanelWidth: (value) => {
			const clamped = Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(RIGHT_PANEL_MAX_WIDTH, value));
			set({ rightPanelWidth: clamped });
			window.maestro.settings.set('rightPanelWidth', clamped);
		},

		setModalSize: (key, value) => {
			const normalized = sanitizeModalSizes({ [key]: value })[key];
			if (!normalized) return;
			const next = {
				...get().modalSizes,
				[key]: normalized,
			};
			set({ modalSizes: next });
			window.maestro.settings.set('modalSizes', next);
		},

		// Single-key counterpart to resetModalSizes, backing the double-click-to-reset
		// gesture on a modal's resize handles. Bails without a settings write when the
		// modal was never resized, so an idle double-click costs nothing.
		resetModalSize: (key) => {
			const current = get().modalSizes;
			if (current[key] === undefined) return;
			const next = { ...current };
			delete next[key];
			set({ modalSizes: next });
			window.maestro.settings.set('modalSizes', next);
		},

		resetModalSizes: () => {
			set({ modalSizes: {} });
			window.maestro.settings.set('modalSizes', {});
		},

		setConcertoStageFloating: (value) => {
			set({ concertoStageFloating: value });
			window.maestro.settings.set('concertoStageFloating', value);
		},

		setConcertoStagePosition: (value) => {
			const normalized = value ? normalizeModalPosition(value) : null;
			set({ concertoStagePosition: normalized });
			window.maestro.settings.set('concertoStagePosition', normalized);
		},

		setTextareaHeight: (key, value) => {
			const normalized = sanitizeTextareaHeights({ [key]: value })[key];
			if (!normalized) return;
			if (get().textareaHeights[key] === normalized) return;
			const next = {
				...get().textareaHeights,
				[key]: normalized,
			};
			set({ textareaHeights: next });
			window.maestro.settings.set('textareaHeights', next);
		},

		setMarkdownEditMode: (value) => {
			set({ markdownEditMode: value });
			window.maestro.settings.set('markdownEditMode', value);
		},

		setChatRawTextMode: (value) => {
			set({ chatRawTextMode: value });
			window.maestro.settings.set('chatRawTextMode', value);
		},
		setGroupChatAutoScroll: (value) => {
			set({ groupChatAutoScroll: value });
			window.maestro.settings.set('groupChatAutoScroll', value);
		},

		setBionifyReadingMode: (value) => {
			set({ bionifyReadingMode: value });
			window.maestro.settings.set('bionifyReadingMode', value);
		},

		setBionifyIntensity: (value) => {
			const numericValue = Number(value);
			const clamped = Number.isFinite(numericValue)
				? Math.max(0.6, Math.min(1.5, numericValue))
				: 1;
			set({ bionifyIntensity: clamped });
			window.maestro.settings.set('bionifyIntensity', clamped);
		},

		setBionifyAlgorithm: (value) => {
			set({ bionifyAlgorithm: value });
			window.maestro.settings.set('bionifyAlgorithm', value);
		},

		setTerminalWidth: (value) => {
			set({ terminalWidth: value });
			window.maestro.settings.set('terminalWidth', value);
		},

		setMaxOutputLines: (value) => {
			set({ maxOutputLines: value });
			window.maestro.settings.set('maxOutputLines', value);
		},

		setCheckForUpdatesOnStartup: (value) => {
			set({ checkForUpdatesOnStartup: value });
			window.maestro.settings.set('checkForUpdatesOnStartup', value);
		},

		setAutoResumeOnLimit: (value) => {
			set({ autoResumeOnLimit: value });
			window.maestro.settings.set('autoResumeOnLimit', value);
		},

		setAutoResumeCheckIntervalHours: (value) => {
			// Guard against 0/negative/non-finite values (CLI or manual store edits)
			// that would destabilize the coordinator cadence.
			const normalized = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 2;
			set({ autoResumeCheckIntervalHours: normalized });
			window.maestro.settings.set('autoResumeCheckIntervalHours', normalized);
		},

		setAutoResumeGiveUpDays: (value) => {
			// Guard against 0/negative/non-finite values that would cause immediate
			// give-up behavior.
			const normalized = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 7;
			set({ autoResumeGiveUpDays: normalized });
			window.maestro.settings.set('autoResumeGiveUpDays', normalized);
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

		setCustomAICommands: (value) => {
			set({ customAICommands: value });
			window.maestro.settings.set('customAICommands', value);
		},

		setUngroupedCollapsed: (value) => {
			set({ ungroupedCollapsed: value });
			window.maestro.settings.set('ungroupedCollapsed', value);
		},

		setGroupChatsExpanded: (value) => {
			set({ groupChatsExpanded: value });
			window.maestro.settings.set('groupChatsExpanded', value);
		},

		setGroupChatSortAlphabetical: (value) => {
			set({ groupChatSortAlphabetical: value });
			window.maestro.settings.set('groupChatSortAlphabetical', value);
		},

		setStarredSessionsCollapsed: (value) => {
			set({ starredSessionsCollapsed: value });
			window.maestro.settings.set('starredSessionsCollapsed', value);
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

		setPersistentWebLink: async (value) => {
			const requestSeq = ++persistentWebLinkRequestSeq;
			// Optimistic update - immediately reflect user intent in UI
			set({ persistentWebLink: value });
			if (value) {
				try {
					// persistCurrentToken writes both webAuthToken and persistentWebLink
					// on the main side - the factory ignores webAuthToken unless
					// persistentWebLink is also true, so partial writes are safe
					const result = await window.maestro.live.persistCurrentToken();
					if (requestSeq !== persistentWebLinkRequestSeq) {
						// Stale: another call was made while this IPC was in-flight.
						// The IPC handler already wrote the token and flag in main -
						// only clear them if the user's latest intent was to disable.
						// Note: the superseding disable call may have already issued its
						// own clearPersistentToken, making this a redundant but harmless
						// second call - the handler is idempotent.
						if (!get().persistentWebLink) {
							try {
								await window.maestro.live.clearPersistentToken();
							} catch (clearError) {
								logger.error(
									'[Settings] Failed to clear stale persistent web link:',
									undefined,
									clearError
								);
							}
						}
						return;
					}
					if (!result.success) {
						// Rollback optimistic update on soft failure
						set({ persistentWebLink: false });
						logger.warn('[Settings] Failed to persist web link token:', undefined, result.message);
					}
				} catch (error) {
					if (requestSeq === persistentWebLinkRequestSeq) {
						// Rollback optimistic update on hard failure
						set({ persistentWebLink: false });
						logger.error('[Settings] Failed to persist web link token:', undefined, error);
					}
				}
			} else {
				try {
					// Atomically clear both keys on the main side
					const result = await window.maestro.live.clearPersistentToken();
					if (requestSeq !== persistentWebLinkRequestSeq) {
						// Stale: user re-enabled while this clear was in-flight.
						// The enable path will handle persisting - nothing to undo here.
						return;
					}
					if (!result.success) {
						// Rollback optimistic update on soft failure
						set({ persistentWebLink: true });
						logger.warn(
							'[Settings] Failed to clear persistent web link:',
							undefined,
							result.message
						);
					}
				} catch (error) {
					if (requestSeq === persistentWebLinkRequestSeq) {
						// Clear failed - rollback Zustand to match main-side state
						set({ persistentWebLink: true });
						logger.error('[Settings] Failed to clear persistent web link:', undefined, error);
					}
					// else: stale - a newer call is in charge, nothing to do
				}
			}
		},

		setWebInterfaceAutoStart: (value) => {
			set({ webInterfaceAutoStart: value });
			window.maestro.settings.set('webInterfaceAutoStart', value);
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

		setShowStarredInUnreadFilter: (value) => {
			set({ showStarredInUnreadFilter: value });
			window.maestro.settings.set('showStarredInUnreadFilter', value);
		},

		setShowFilePreviewsInUnreadFilter: (value) => {
			set({ showFilePreviewsInUnreadFilter: value });
			window.maestro.settings.set('showFilePreviewsInUnreadFilter', value);
		},

		setShowTerminalTabsInUnreadFilter: (value) => {
			set({ showTerminalTabsInUnreadFilter: value });
			window.maestro.settings.set('showTerminalTabsInUnreadFilter', value);
		},

		setShowBrowserTabsInUnreadFilter: (value) => {
			set({ showBrowserTabsInUnreadFilter: value });
			window.maestro.settings.set('showBrowserTabsInUnreadFilter', value);
		},

		setUseCmd0AsLastTab: (value) => {
			set({ useCmd0AsLastTab: value });
			window.maestro.settings.set('useCmd0AsLastTab', value);
		},

		setDocumentGraphShowExternalLinks: (value) => {
			set({ documentGraphShowExternalLinks: value });
			window.maestro.settings.set('documentGraphShowExternalLinks', value);
		},

		setDocumentGraphConfirmClose: (value) => {
			set({ documentGraphConfirmClose: value });
			window.maestro.settings.set('documentGraphConfirmClose', value);
		},

		setDocumentGraphMaxNodes: (value) => {
			const clamped = Math.max(50, Math.min(1000, value));
			set({ documentGraphMaxNodes: clamped });
			window.maestro.settings.set('documentGraphMaxNodes', clamped);
		},

		setDocumentGraphPreviewCharLimit: (value) => {
			// 0 is a real value, not a floor to clamp away: it means "previews off",
			// which draws each node as a filename pill.
			const clamped = Math.max(0, Math.min(500, value));
			set({ documentGraphPreviewCharLimit: clamped });
			window.maestro.settings.set('documentGraphPreviewCharLimit', clamped);
		},

		setDocumentGraphLayoutType: (value) => {
			const layoutType = isMindMapLayoutType(value) ? value : 'hierarchical';
			set({ documentGraphLayoutType: layoutType });
			window.maestro.settings.set('documentGraphLayoutType', layoutType);
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

		setSuppressWindowsWarning: (value) => {
			set({ suppressWindowsWarning: value });
			window.maestro.settings.set('suppressWindowsWarning', value);
		},

		setUserMessageAlignment: (value) => {
			set({ userMessageAlignment: value });
			window.maestro.settings.set('userMessageAlignment', value);
		},

		setUtilityAgentId: (value) => {
			set({ utilityAgentId: value });
			window.maestro.settings.set('utilityAgentId', value);
		},

		setUtilityModelId: (value) => {
			set({ utilityModelId: value });
			window.maestro.settings.set('utilityModelId', value);
		},

		setEncoreFeatures: (value) => {
			set({ encoreFeatures: value });
			window.maestro.settings.set('encoreFeatures', value);
		},

		setSymphonyRegistryUrls: (value) => {
			set({ symphonyRegistryUrls: value });
			window.maestro.settings.set('symphonyRegistryUrls', value);
		},

		setCoworkingBrowserInteraction: (value) => {
			set({ coworkingBrowserInteraction: value });
			window.maestro.settings.set('coworkingBrowserInteraction', value);
		},

		setCoworkingBrowserInteractionConfirm: (value) => {
			set({ coworkingBrowserInteractionConfirm: value });
			window.maestro.settings.set('coworkingBrowserInteractionConfirm', value);
		},

		setCoworkingBackgroundBrowsers: (value) => {
			set({ coworkingBackgroundBrowsers: value });
			window.maestro.settings.set('coworkingBackgroundBrowsers', value);
		},
		setCoworkingBackgroundBrowsersLimit: (value) => {
			const clamped = Math.min(10, Math.max(1, Math.floor(value) || 1));
			set({ coworkingBackgroundBrowsersLimit: clamped });
			window.maestro.settings.set('coworkingBackgroundBrowsersLimit', clamped);
		},

		setDirectorNotesSettings: (value) => {
			set({ directorNotesSettings: value });
			window.maestro.settings.set('directorNotesSettings', value);
		},

		setUseNativeTitleBar: (value) => {
			set({ useNativeTitleBar: value });
			window.maestro.settings.set('useNativeTitleBar', value);
		},

		setAutoHideMenuBar: (value) => {
			set({ autoHideMenuBar: value });
			window.maestro.settings.set('autoHideMenuBar', value);
		},

		setFileEditWordWrap: (value) => {
			set({ fileEditWordWrap: value });
			window.maestro.settings.set('fileEditWordWrap', value);
		},

		setFileEditShowLineNumbers: (value) => {
			set({ fileEditShowLineNumbers: value });
			window.maestro.settings.set('fileEditShowLineNumbers', value);
		},

		setFilePreviewToolbarButtonVisibility: (button, value) => {
			const next: FilePreviewToolbarVisibility = {
				...get().filePreviewToolbarVisibility,
				[button]: value,
			};
			set({ filePreviewToolbarVisibility: next });
			window.maestro.settings.set('filePreviewToolbarVisibility', next);
		},

		setModeratorStandingInstructions: (value) => {
			const trimmed = value.slice(0, 2000);
			set({ moderatorStandingInstructions: trimmed });
			window.maestro.settings.set('moderatorStandingInstructions', trimmed);
		},

		setAutoRunDisabled: (value) => {
			set({ autoRunDisabled: value });
			window.maestro.settings.set('autoRunDisabled', value);
		},

		setDotfilesToggleHidden: (value) => {
			set({ dotfilesToggleHidden: value });
			window.maestro.settings.set('dotfilesToggleHidden', value);
		},

		setSpeckitEnabled: (value) => {
			set({ speckitEnabled: value });
			window.maestro.settings.set('speckitEnabled', value);
		},

		setOpenspecEnabled: (value) => {
			set({ openspecEnabled: value });
			window.maestro.settings.set('openspecEnabled', value);
		},

		setBmadEnabled: (value) => {
			set({ bmadEnabled: value });
			window.maestro.settings.set('bmadEnabled', value);
		},

		setAutoRunInactivityTimeoutMin: (value) => {
			// 0 is a sentinel for "unlimited" (no watchdog). Any positive value is clamped to a sane range.
			const rounded = Math.round(value);
			const clamped = rounded <= 0 ? 0 : Math.max(1, Math.min(1440, rounded));
			set({ autoRunInactivityTimeoutMin: clamped });
			window.maestro.settings.set('autoRunInactivityTimeoutMin', clamped);
		},

		setAutoRunMaxTaskDurationMin: (value) => {
			// 0 is a sentinel for "unlimited" (no absolute cap). Any positive value is clamped to a sane range.
			const clamped = clampAutoRunMaxTaskDurationMin(value);
			set({ autoRunMaxTaskDurationMin: clamped });
			window.maestro.settings.set('autoRunMaxTaskDurationMin', clamped);
		},

		setLastSelectedPromptId: (value) => {
			set({ lastSelectedPromptId: value });
			window.maestro.settings.set('lastSelectedPromptId', value);
		},

		setSpellCheck: (value) => {
			set({ spellCheck: value });
			window.maestro.settings.set('spellCheck', value);
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
		// Standalone Active Time Actions
		// ============================================================================

		setTotalActiveTimeMs: (value) => {
			set({ totalActiveTimeMs: value });
			window.maestro.settings.set('totalActiveTimeMs', value);
		},

		addTotalActiveTimeMs: (delta) => {
			const prev = get().totalActiveTimeMs;
			const updated = prev + delta;
			set({ totalActiveTimeMs: updated });
			window.maestro.settings.set('totalActiveTimeMs', updated);
		},

		// ============================================================================
		// Delegation Milestone Actions
		// ============================================================================

		// Raise the delegation high-water mark. Monotonic on purpose: the caller
		// passes whatever milestone the CURRENT score has reached, and a score
		// that has since fallen must not claw back a mark already unlocked. The
		// value is normalized to a real milestone so nothing can fill the bar to
		// a mark the track does not have.
		unlockDelegationMilestone: (milestone) => {
			const normalized = normalizeUnlockedMilestone(milestone);
			const prev = get().delegationMilestone;
			if (normalized <= prev) return;
			set({ delegationMilestone: normalized });
			window.maestro.settings.set('delegationMilestone', normalized);
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
			// PERF: Skip both the persist AND the in-memory set when nothing changed.
			// updateUsageStats fires from useAutoRunAchievements on every `sessions` ref flip
			// (i.e., every ~200ms streaming flush). Calling `set` with a fresh object identity
			// each time triggers every consumer of useSettingsStore() to re-render, which
			// cascades through MaestroConsoleInner → GitStatusProvider → entire workspace tree.
			if (
				updated.maxAgents === prev.maxAgents &&
				updated.maxDefinedAgents === prev.maxDefinedAgents &&
				updated.maxSimultaneousAutoRuns === prev.maxSimultaneousAutoRuns &&
				updated.maxSimultaneousQueries === prev.maxSimultaneousQueries &&
				updated.maxQueueDepth === prev.maxQueueDepth
			) {
				return;
			}
			window.maestro.settings.set('usageStats', updated);
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
				cueTimeMs: prev.cueTimeMs ?? 0, // Also accrued incrementally
				longestRunMs: isNewRecord ? elapsedTimeMs : prev.longestRunMs,
				longestRunTimestamp: isNewRecord ? Date.now() : prev.longestRunTimestamp,
				totalRuns: prev.totalRuns + 1,
				currentBadgeLevel: newBadgeLevelCalc,
				lastBadgeUnlockLevel:
					newBadgeLevel !== null ? newBadgeLevelCalc : prev.lastBadgeUnlockLevel,
				lastAcknowledgedBadgeLevel: prev.lastAcknowledgedBadgeLevel ?? 0,
				badgeHistory: updatedBadgeHistory,
			};

			set({ autoRunStats: updated });
			window.maestro.settings.set('autoRunStats', updated);

			return { newBadgeLevel, isNewRecord };
		},

		updateAutoRunProgress: (deltaMs, source = 'autoRun') => {
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
				// Cue credit is a subset of cumulative time, not an addition to it
				cueTimeMs: (prev.cueTimeMs ?? 0) + (source === 'cue' ? deltaMs : 0),
				longestRunMs: prev.longestRunMs, // Don't update until run completes
				longestRunTimestamp: prev.longestRunTimestamp,
				totalRuns: prev.totalRuns, // Don't increment - run not complete yet
				currentBadgeLevel: newBadgeLevelCalc,
				lastBadgeUnlockLevel:
					newBadgeLevel !== null ? newBadgeLevelCalc : prev.lastBadgeUnlockLevel,
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
					newCompletionCount > 0
						? Math.round((newTotalExchanges / newCompletionCount) * 10) / 10
						: 0,

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

			// Calculate new percentage and level over the BOUND shortcuts only - an
			// unbound one can never be fired, so counting it would make the top
			// level unreachable. Read from the live maps so a binding the user
			// cleared in Settings leaves the denominator too.
			const bound = collectBoundShortcuts(get().shortcuts, get().tabShortcuts, FIXED_SHORTCUTS);
			const percentage =
				bound.length > 0
					? (countUsedBoundShortcuts(bound, updatedShortcuts) / bound.length) * 100
					: 0;
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
	};
});

// ============================================================================
// Selectors
// ============================================================================

export function selectIsLeaderboardRegistered(s: SettingsStoreState): boolean {
	return s.leaderboardRegistration !== null && s.leaderboardRegistration.emailConfirmed;
}

// ============================================================================
// Load All Settings
// ============================================================================

/**
 * Batch-load all settings from electron-store and apply them to the Zustand store.
 * Called once on app startup and again on system resume from sleep.
 */
export async function loadAllSettings(): Promise<void> {
	// Snapshot before the awaited reads below. Anything the user changes while
	// they are in flight must survive this load - see the filter before setState.
	const beforeRead = useSettingsStore.getState() as unknown as Record<string, unknown>;

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

		if (Array.isArray(allSettings['globalShowHotkey']))
			patch.globalShowHotkey = allSettings['globalShowHotkey'] as string[];

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

		if (allSettings['shellEnvVarsDisabled'] !== undefined)
			patch.shellEnvVarsDisabled = allSettings['shellEnvVarsDisabled'] as Record<string, string>;

		if (allSettings['ghPath'] !== undefined) patch.ghPath = allSettings['ghPath'] as string;

		hydrateThemeSettings(allSettings, patch);

		if (allSettings['mediaPlaybackRate'] !== undefined)
			patch.mediaPlaybackRate = normalizePlaybackRate(allSettings['mediaPlaybackRate']);

		if (allSettings['enterToSendAI'] !== undefined)
			patch.enterToSendAI = allSettings['enterToSendAI'] as boolean;

		if (allSettings['enterToSendAIExpanded'] !== undefined)
			patch.enterToSendAIExpanded = allSettings['enterToSendAIExpanded'] as boolean;

		if (allSettings['forcedParallelExecution'] !== undefined)
			patch.forcedParallelExecution = allSettings['forcedParallelExecution'] as boolean;
		if (allSettings['forcedParallelAcknowledged'] !== undefined)
			patch.forcedParallelAcknowledged = allSettings['forcedParallelAcknowledged'] as boolean;
		if (allSettings['forcedParallelAlways'] !== undefined)
			patch.forcedParallelAlways = allSettings['forcedParallelAlways'] as boolean;

		if (allSettings['crossAgentMentionsWritable'] !== undefined)
			patch.crossAgentMentionsWritable = allSettings['crossAgentMentionsWritable'] as boolean;

		if (allSettings['defaultSaveToHistory'] !== undefined)
			patch.defaultSaveToHistory = allSettings['defaultSaveToHistory'] as boolean;

		if (allSettings['synopsisDebounceSeconds'] !== undefined)
			patch.synopsisDebounceSeconds = allSettings['synopsisDebounceSeconds'] as number;

		// ThinkingMode: support legacy boolean values (true -> 'on', false -> 'off')
		if (allSettings['defaultShowThinking'] !== undefined) {
			const raw = allSettings['defaultShowThinking'];
			patch.defaultShowThinking =
				typeof raw === 'boolean' ? (raw ? 'on' : 'off') : (raw as ThinkingMode);
		}

		if (allSettings['showToolCalls'] !== undefined)
			patch.showToolCalls = allSettings['showToolCalls'] as boolean;

		// leftSidebarWidth: clamp on load
		if (allSettings['leftSidebarWidth'] !== undefined)
			patch.leftSidebarWidth = Math.max(
				256,
				Math.min(600, allSettings['leftSidebarWidth'] as number)
			);

		if (allSettings['rightPanelWidth'] !== undefined)
			patch.rightPanelWidth = Math.max(
				RIGHT_PANEL_MIN_WIDTH,
				Math.min(RIGHT_PANEL_MAX_WIDTH, allSettings['rightPanelWidth'] as number)
			);

		if (allSettings['modalSizes'] !== undefined)
			patch.modalSizes = sanitizeModalSizes(allSettings['modalSizes']);

		if (allSettings['concertoStageFloating'] !== undefined)
			patch.concertoStageFloating = allSettings['concertoStageFloating'] === true;

		if (allSettings['concertoStagePosition'] !== undefined)
			patch.concertoStagePosition = normalizeModalPosition(allSettings['concertoStagePosition']);

		if (allSettings['textareaHeights'] !== undefined)
			patch.textareaHeights = sanitizeTextareaHeights(allSettings['textareaHeights']);

		if (allSettings['markdownEditMode'] !== undefined)
			patch.markdownEditMode = allSettings['markdownEditMode'] as boolean;

		if (allSettings['chatRawTextMode'] !== undefined)
			patch.chatRawTextMode = allSettings['chatRawTextMode'] as boolean;
		if (allSettings['groupChatAutoScroll'] !== undefined)
			patch.groupChatAutoScroll = allSettings['groupChatAutoScroll'] as boolean;

		if (allSettings['bionifyReadingMode'] !== undefined)
			patch.bionifyReadingMode = allSettings['bionifyReadingMode'] as boolean;

		if (allSettings['bionifyIntensity'] !== undefined) {
			const savedIntensity = allSettings['bionifyIntensity'];
			if (typeof savedIntensity === 'number' && Number.isFinite(savedIntensity)) {
				patch.bionifyIntensity = Math.max(0.6, Math.min(1.5, savedIntensity));
			}
		}

		if (allSettings['bionifyAlgorithm'] !== undefined)
			patch.bionifyAlgorithm = allSettings['bionifyAlgorithm'] as string;

		hydrateFileExplorerSettings(allSettings, patch);

		hydrateNotificationsSettings(allSettings, patch);

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

		if (allSettings['checkForUpdatesOnStartup'] !== undefined)
			patch.checkForUpdatesOnStartup = allSettings['checkForUpdatesOnStartup'] as boolean;

		if (allSettings['autoResumeOnLimit'] !== undefined)
			patch.autoResumeOnLimit = allSettings['autoResumeOnLimit'] as boolean;

		if (allSettings['autoResumeCheckIntervalHours'] !== undefined) {
			const raw = allSettings['autoResumeCheckIntervalHours'];
			if (typeof raw === 'number' && Number.isFinite(raw))
				patch.autoResumeCheckIntervalHours = Math.max(1, Math.floor(raw));
		}

		if (allSettings['autoResumeGiveUpDays'] !== undefined) {
			const raw = allSettings['autoResumeGiveUpDays'];
			if (typeof raw === 'number' && Number.isFinite(raw))
				patch.autoResumeGiveUpDays = Math.max(1, Math.floor(raw));
		}

		if (allSettings['enableBetaUpdates'] !== undefined)
			patch.enableBetaUpdates = allSettings['enableBetaUpdates'] as boolean;

		if (allSettings['crashReportingEnabled'] !== undefined)
			patch.crashReportingEnabled = allSettings['crashReportingEnabled'] as boolean;

		if (allSettings['logViewerSelectedLevels'] !== undefined)
			patch.logViewerSelectedLevels = allSettings['logViewerSelectedLevels'] as string[];

		hydrateShortcutsSettings(allSettings, patch);

		// --- Custom AI Commands (merge with defaults, skip /synopsis migration) ---

		if (
			allSettings['customAICommands'] !== undefined &&
			Array.isArray(allSettings['customAICommands'])
		) {
			const commandsById = new Map<string, CustomAICommand>();
			DEFAULT_AI_COMMANDS.forEach((cmd) => commandsById.set(cmd.id, cmd));
			(allSettings['customAICommands'] as CustomAICommand[]).forEach((cmd: CustomAICommand) => {
				// The persisted array is whatever is on disk, not necessarily CustomAICommand[]:
				// electron-store hands back hand-edited / sync-mangled / legacy-schema entries
				// unchanged. Every consumer keys off `id` (edit, save, reset, delete, React keys),
				// so an entry without one is unusable and would otherwise be stored under the
				// Map key `undefined` and rendered anyway. Skip it instead of crashing later.
				// `id`, `command` and `prompt` are all load-bearing: consumers key off
				// `id` (edit, save, reset, delete, React keys), and the panel calls
				// `command.startsWith('/')` and `prompt.substring(...)` directly, so a
				// missing one is a crash rather than a cosmetic gap. `description` is
				// only rendered, so default it instead of discarding a command the
				// user may still want.
				if (
					!cmd ||
					typeof cmd !== 'object' ||
					typeof cmd.id !== 'string' ||
					!cmd.id ||
					typeof cmd.command !== 'string' ||
					typeof cmd.prompt !== 'string'
				) {
					logger.warn('Skipping malformed customAICommands entry (missing id, command or prompt)');
					return;
				}
				if (typeof cmd.description !== 'string') {
					cmd = { ...cmd, description: '' };
				}
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

		// Standalone totalActiveTimeMs: migrate from legacy globalStats if needed
		if (allSettings['totalActiveTimeMs'] !== undefined) {
			patch.totalActiveTimeMs = allSettings['totalActiveTimeMs'] as number;
		} else {
			// One-time migration: copy from globalStats.totalActiveTimeMs if it exists and is > 0
			const legacyGlobalStats = allSettings['globalStats'] as
				| { totalActiveTimeMs?: number }
				| undefined;
			if (legacyGlobalStats?.totalActiveTimeMs && legacyGlobalStats.totalActiveTimeMs > 0) {
				patch.totalActiveTimeMs = legacyGlobalStats.totalActiveTimeMs;
				window.maestro.settings.set('totalActiveTimeMs', legacyGlobalStats.totalActiveTimeMs);
			}
		}

		if (allSettings['delegationMilestone'] !== undefined) {
			patch.delegationMilestone = normalizeUnlockedMilestone(allSettings['delegationMilestone']);
		}

		if (allSettings['autoRunStats'] !== undefined) {
			// NOTE: a `concurrentAutoRunTimeMigrationApplied` migration used to add
			// 3 hours to `cumulativeTimeMs` here. It was removed because it grew the
			// local total without submitting a delta, which is exactly what
			// `services/leaderboard.ts` forbids: the 3 hours never reached the
			// leaderboard, pushed the local total above the server's, and (before the
			// drift branch in useAppInitialization) latched the startup sync off for
			// good. It was also keyed per install, so a multi-machine user collected
			// it once per machine, and it fired for installs that never saw the
			// concurrent-tallying bug at all (the flag is only written by the
			// migration, so a brand new install qualified after its first run).
			// Installs that already took the 3 hours keep them; nothing claws back.
			patch.autoRunStats = {
				...DEFAULT_AUTO_RUN_STATS,
				...(allSettings['autoRunStats'] as Partial<AutoRunStats>),
			};
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

		if (allSettings['groupChatsExpanded'] !== undefined)
			patch.groupChatsExpanded = allSettings['groupChatsExpanded'] as boolean;

		if (allSettings['groupChatSortAlphabetical'] !== undefined)
			patch.groupChatSortAlphabetical = allSettings['groupChatSortAlphabetical'] as boolean;

		if (allSettings['starredSessionsCollapsed'] !== undefined)
			patch.starredSessionsCollapsed = allSettings['starredSessionsCollapsed'] as boolean;

		// Bookmarks collapse lives in uiStore (it's transiently toggled by filter
		// mode at runtime), so its persisted value is hydrated directly into that
		// store rather than the settings store.
		if (allSettings['bookmarksCollapsed'] !== undefined)
			useUIStore.setState({ bookmarksCollapsed: allSettings['bookmarksCollapsed'] as boolean });

		// Hidden quota accounts live in uiStore (toggled at runtime from the Usage
		// Dashboard provider panels), so its persisted map hydrates directly there.
		if (allSettings['hiddenQuotaAccounts'] !== undefined)
			useUIStore.setState({
				hiddenQuotaAccounts: allSettings['hiddenQuotaAccounts'] as Record<string, string[]>,
			});

		// Collapsed docked plugin panels live in uiStore (toggled from the panel
		// slot header), so its persisted id list hydrates directly there. Validate
		// it is an array of strings first: a malformed stored value (null/object)
		// would otherwise reach PluginPanelSlot, which calls `.includes()` on it.
		if (Array.isArray(allSettings['hiddenPluginPanels']))
			useUIStore.setState({
				hiddenPluginPanels: (allSettings['hiddenPluginPanels'] as unknown[]).filter(
					(id): id is string => typeof id === 'string'
				),
			});

		// Usage Dashboard auto-refresh intervals live in uiStore alongside the
		// hidden-account map (both are provider-panel state), so the persisted map
		// hydrates directly there too.
		if (
			allSettings['usageRefreshIntervals'] !== undefined &&
			typeof allSettings['usageRefreshIntervals'] === 'object'
		)
			useUIStore.setState({
				usageRefreshIntervals: allSettings['usageRefreshIntervals'] as Record<string, number>,
			});

		// Resolved-snooze history lives in snoozeHistoryStore (it's appended from
		// the wake scheduler and the Snoozed Tabs modal, not from Settings), so its
		// persisted array hydrates directly there. Sanitized first: entries are
		// read straight back from disk and rendered.
		if (allSettings[SNOOZE_HISTORY_SETTINGS_KEY] !== undefined)
			useSnoozeHistoryStore.setState({
				entries: sanitizeSnoozeHistory(allSettings[SNOOZE_HISTORY_SETTINGS_KEY]),
			});

		// Floating media player geometry lives in mediaPlaybackStore so the
		// drag/resize handlers can read and write it without a settings
		// round-trip. (Per-modal `modalSizes` is NOT hydrated here: rc keeps it in
		// settingsStore behind sanitizeModalSizes, hydrated above with the other
		// settings-owned keys.)
		// Position and per-kind width only: the player's height is derived from
		// whatever is loaded (audio has no picture, video wants its own aspect
		// ratio), so it is not a stored number.
		if (allSettings[MEDIA_FLOAT_SETTINGS_KEY] !== undefined) {
			const float = sanitizeMediaFloat(allSettings[MEDIA_FLOAT_SETTINGS_KEY]);
			if (float)
				useMediaPlaybackStore.setState({
					floatPosition: { top: float.top, left: float.left },
					floatWidths: float.widths,
				});
		}

		// The play queue outlives a restart so a half-listened playlist is still
		// there tomorrow. It comes back hidden, paused, and DORMANT: restoring
		// what was queued should not start a podcast at launch, and it should not
		// put media controls in the Left Bar header either, since the user has not
		// played anything yet. The command palette's "Open Media Player" is what
		// reaches a dormant queue, and the first thing the user opens or
		// queues wakes it. Recently played is NOT restored - it is per-session by
		// design.
		if (allSettings[MEDIA_QUEUE_SETTINGS_KEY] !== undefined) {
			const stored = allSettings[MEDIA_QUEUE_SETTINGS_KEY] as PersistedMediaQueue | null;
			const items = sanitizeMediaItems(stored?.items);
			if (items.length > 0) {
				const ids = new Set(items.map((item) => item.id));
				const storedActive = stored?.activeItemId;
				useMediaPlaybackStore.setState({
					items,
					activeItemId:
						typeof storedActive === 'string' && ids.has(storedActive) ? storedActive : items[0].id,
					resumeTimes: sanitizeMediaTimes(stored?.resumeTimes, ids),
					durations: sanitizeMediaTimes(stored?.durations, ids),
					dismissed: true,
					dormant: true,
					playing: false,
					pendingAutoplay: false,
				});
			}
		}

		if (allSettings['tourCompleted'] !== undefined)
			patch.tourCompleted = allSettings['tourCompleted'] as boolean;

		if (allSettings['firstAutoRunCompleted'] !== undefined)
			patch.firstAutoRunCompleted = allSettings['firstAutoRunCompleted'] as boolean;

		if (allSettings['leaderboardRegistration'] !== undefined)
			patch.leaderboardRegistration = allSettings[
				'leaderboardRegistration'
			] as LeaderboardRegistration | null;

		if (allSettings['persistentWebLink'] !== undefined)
			patch.persistentWebLink = allSettings['persistentWebLink'] as boolean;

		if (typeof allSettings['webInterfaceAutoStart'] === 'boolean')
			patch.webInterfaceAutoStart = allSettings['webInterfaceAutoStart'];

		if (allSettings['webInterfaceUseCustomPort'] !== undefined)
			patch.webInterfaceUseCustomPort = allSettings['webInterfaceUseCustomPort'] as boolean;

		if (allSettings['webInterfaceCustomPort'] !== undefined)
			patch.webInterfaceCustomPort = allSettings['webInterfaceCustomPort'] as number;

		if (allSettings['showStarredInUnreadFilter'] !== undefined)
			patch.showStarredInUnreadFilter = allSettings['showStarredInUnreadFilter'] as boolean;

		if (allSettings['showFilePreviewsInUnreadFilter'] !== undefined)
			patch.showFilePreviewsInUnreadFilter = allSettings[
				'showFilePreviewsInUnreadFilter'
			] as boolean;

		if (allSettings['showTerminalTabsInUnreadFilter'] !== undefined)
			patch.showTerminalTabsInUnreadFilter = allSettings[
				'showTerminalTabsInUnreadFilter'
			] as boolean;

		if (allSettings['showBrowserTabsInUnreadFilter'] !== undefined)
			patch.showBrowserTabsInUnreadFilter = allSettings['showBrowserTabsInUnreadFilter'] as boolean;

		if (allSettings['useCmd0AsLastTab'] !== undefined)
			patch.useCmd0AsLastTab = allSettings['useCmd0AsLastTab'] as boolean;

		// Document Graph settings (with validation)
		if (allSettings['documentGraphShowExternalLinks'] !== undefined)
			patch.documentGraphShowExternalLinks = allSettings[
				'documentGraphShowExternalLinks'
			] as boolean;

		if (allSettings['documentGraphConfirmClose'] !== undefined)
			patch.documentGraphConfirmClose = allSettings['documentGraphConfirmClose'] as boolean;

		if (allSettings['documentGraphMaxNodes'] !== undefined) {
			const maxNodes = allSettings['documentGraphMaxNodes'] as number;
			if (typeof maxNodes === 'number' && maxNodes >= 50 && maxNodes <= 1000) {
				patch.documentGraphMaxNodes = maxNodes;
			}
		}

		if (allSettings['documentGraphPreviewCharLimit'] !== undefined) {
			const charLimit = allSettings['documentGraphPreviewCharLimit'] as number;
			// 0 means "previews off" (filename pills), so the floor is 0, not 50 -
			// a stricter floor here would silently discard the user's saved choice
			// on every launch and snap the graph back to full cards.
			if (typeof charLimit === 'number' && charLimit >= 0 && charLimit <= 500) {
				patch.documentGraphPreviewCharLimit = charLimit;
			}
		}

		if (allSettings['documentGraphLayoutType'] !== undefined) {
			const lt = allSettings['documentGraphLayoutType'] as string;
			if (isMindMapLayoutType(lt)) {
				patch.documentGraphLayoutType = lt;
			}
		}

		// Stats settings (with time range validation)
		if (allSettings['statsCollectionEnabled'] !== undefined)
			patch.statsCollectionEnabled = allSettings['statsCollectionEnabled'] as boolean;

		if (allSettings['defaultStatsTimeRange'] !== undefined) {
			const validTimeRanges = ['day', 'week', 'month', 'quarter', 'year', 'all'];
			if (validTimeRanges.includes(allSettings['defaultStatsTimeRange'] as string)) {
				patch.defaultStatsTimeRange = allSettings['defaultStatsTimeRange'] as
					| 'day'
					| 'week'
					| 'month'
					| 'quarter'
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

		hydrateBrowserTabsSettings(allSettings, patch);

		if (allSettings['suppressWindowsWarning'] !== undefined)
			patch.suppressWindowsWarning = allSettings['suppressWindowsWarning'] as boolean;

		if (allSettings['userMessageAlignment'] !== undefined)
			patch.userMessageAlignment = allSettings['userMessageAlignment'] as 'left' | 'right';

		if (allSettings['utilityAgentId'] !== undefined)
			patch.utilityAgentId = allSettings['utilityAgentId'] as string | null;

		if (allSettings['utilityModelId'] !== undefined)
			patch.utilityModelId = allSettings['utilityModelId'] as string | null;

		// Encore Features (merge with defaults to preserve new flags)
		if (allSettings['encoreFeatures'] !== undefined) {
			patch.encoreFeatures = {
				...DEFAULT_ENCORE_FEATURES,
				...(allSettings['encoreFeatures'] as Partial<EncoreFeatureFlags>),
			};
		}

		// Symphony registry URLs (additional user-configured registries)
		if (Array.isArray(allSettings['symphonyRegistryUrls'])) {
			patch.symphonyRegistryUrls = (allSettings['symphonyRegistryUrls'] as unknown[])
				.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
				.map((v) => v.trim());
		}

		// Coworking browser interaction (agent ids allowed to use browser tools)
		if (Array.isArray(allSettings['coworkingBrowserInteraction'])) {
			patch.coworkingBrowserInteraction = (allSettings['coworkingBrowserInteraction'] as unknown[])
				.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
				.map((v) => v.trim());
		}

		// Coworking browser interaction per-call confirm policy (per agent id).
		const rawConfirm = allSettings['coworkingBrowserInteractionConfirm'];
		if (rawConfirm && typeof rawConfirm === 'object' && !Array.isArray(rawConfirm)) {
			const out: Record<string, BrowserConfirmPolicy> = {};
			for (const [agentId, policy] of Object.entries(rawConfirm)) {
				if (policy === 'off' || policy === 'dangerous' || policy === 'all') {
					out[agentId] = policy;
				}
			}
			patch.coworkingBrowserInteractionConfirm = out;
		}

		if (typeof allSettings['coworkingBackgroundBrowsers'] === 'boolean') {
			patch.coworkingBackgroundBrowsers = allSettings['coworkingBackgroundBrowsers'];
		}
		if (
			typeof allSettings['coworkingBackgroundBrowsersLimit'] === 'number' &&
			Number.isFinite(allSettings['coworkingBackgroundBrowsersLimit'])
		) {
			patch.coworkingBackgroundBrowsersLimit = Math.min(
				10,
				Math.max(1, Math.floor(allSettings['coworkingBackgroundBrowsersLimit']) || 1)
			);
		}

		// Director's Notes settings (merge with defaults to preserve new fields)
		if (allSettings['directorNotesSettings'] !== undefined) {
			patch.directorNotesSettings = {
				...DEFAULT_DIRECTOR_NOTES_SETTINGS,
				...(allSettings['directorNotesSettings'] as Partial<DirectorNotesSettings>),
			};
		}

		hydrateWakatimeSettings(allSettings, patch);

		if (allSettings['useNativeTitleBar'] !== undefined)
			patch.useNativeTitleBar = allSettings['useNativeTitleBar'] as boolean;

		if (allSettings['autoHideMenuBar'] !== undefined)
			patch.autoHideMenuBar = allSettings['autoHideMenuBar'] as boolean;

		hydrateLeftPanelDisplaySettings(allSettings, patch);

		if (allSettings['fileEditWordWrap'] !== undefined)
			patch.fileEditWordWrap = allSettings['fileEditWordWrap'] as boolean;

		if (allSettings['fileEditShowLineNumbers'] !== undefined)
			patch.fileEditShowLineNumbers = allSettings['fileEditShowLineNumbers'] as boolean;

		// Toolbar visibility merges with defaults so new buttons added in a
		// future release default to visible even for users with persisted state.
		if (allSettings['filePreviewToolbarVisibility'] !== undefined) {
			patch.filePreviewToolbarVisibility = {
				...DEFAULT_FILE_PREVIEW_TOOLBAR_VISIBILITY,
				...(allSettings['filePreviewToolbarVisibility'] as Partial<FilePreviewToolbarVisibility>),
			};
		}

		if (allSettings['moderatorStandingInstructions'] !== undefined)
			patch.moderatorStandingInstructions = allSettings['moderatorStandingInstructions'] as string;

		if (allSettings['autoRunDisabled'] !== undefined)
			patch.autoRunDisabled = allSettings['autoRunDisabled'] as boolean;

		if (allSettings['dotfilesToggleHidden'] !== undefined)
			patch.dotfilesToggleHidden = allSettings['dotfilesToggleHidden'] as boolean;

		if (allSettings['autoRunInactivityTimeoutMin'] !== undefined)
			patch.autoRunInactivityTimeoutMin = allSettings['autoRunInactivityTimeoutMin'] as number;

		if (allSettings['autoRunMaxTaskDurationMin'] !== undefined) {
			// Sanitize on load so a corrupt persisted value can't silently disable the
			// absolute cap (which would let a chatty-but-stuck task hang the run).
			patch.autoRunMaxTaskDurationMin = sanitizeLoadedAutoRunMaxTaskDurationMin(
				allSettings['autoRunMaxTaskDurationMin']
			);
		} else if (allSettings['autoRunInactivityTimeoutMin'] === 0) {
			// Migration for installs that chose "Unlimited" inactivity (0) and never
			// touched the new absolute cap: they had NO Auto Run watchdog, so the
			// 480-min default would silently start killing their long tasks. Preserve
			// their unlimited intent by defaulting the new cap to 0 (also unlimited).
			//
			// PERSIST it immediately so the migration is one-shot: without writing the
			// key back, this branch would re-run on every load (the key stays absent),
			// and a user who set the cap to a real value only in-memory this session
			// would have it silently reset to 0 on the next restart. Writing the key
			// makes the sanitize branch above own it from here on.
			patch.autoRunMaxTaskDurationMin = 0;
			window.maestro.settings.set('autoRunMaxTaskDurationMin', 0);
		}

		if (allSettings['speckitEnabled'] !== undefined)
			patch.speckitEnabled = allSettings['speckitEnabled'] as boolean;

		if (allSettings['openspecEnabled'] !== undefined)
			patch.openspecEnabled = allSettings['openspecEnabled'] as boolean;

		if (allSettings['bmadEnabled'] !== undefined)
			patch.bmadEnabled = allSettings['bmadEnabled'] as boolean;

		if (allSettings['lastSelectedPromptId'] !== undefined)
			patch.lastSelectedPromptId = allSettings['lastSelectedPromptId'] as string | null;

		if (allSettings['spellCheck'] !== undefined)
			patch.spellCheck = allSettings['spellCheck'] as boolean;

		hydrateAnnotatorSettings(allSettings, patch);

		// On a RELOAD (system resume, another window's write), drop any key the user
		// changed while the reads above were in flight. This load is several IPC
		// round trips long, so reapplying the older snapshot on top of live typing
		// loses keystrokes and yanks the caret to the end of the field. Those edits
		// persisted themselves on the way in, so the in-memory value is the newer
		// one. Skipped on the initial hydration, where the store still holds
		// defaults and every disk value must land.
		if (beforeRead.settingsLoaded === true) {
			const live = useSettingsStore.getState() as unknown as Record<string, unknown>;
			const patchKeys = patch as unknown as Record<string, unknown>;
			for (const key of Object.keys(patchKeys)) {
				if (live[key] !== beforeRead[key]) {
					delete patchKeys[key];
				}
			}
		}

		// Apply the entire patch in one setState call
		patch.settingsLoaded = true;
		useSettingsStore.setState(patch);

		// Deliberately not awaited: it reads the Cue database over IPC and only
		// refines a display subtotal, so it must not hold up settings load.
		void backfillCueTimeIfNeeded(allSettings['cueTimeBackfillApplied'] === true);
	} catch (error) {
		logger.error('[Settings] Failed to load settings:', undefined, error);
		// Mark settings as loaded even if there was an error (use defaults)
		useSettingsStore.setState({ settingsLoaded: true });
	}
}

/**
 * One-time backfill of `autoRunStats.cueTimeMs`.
 *
 * Cue and Auto Run time were credited through one identical code path before
 * the split existed, so the Cue share of the already-accrued `cumulativeTimeMs`
 * cannot be recovered from settings alone. The Cue database still holds per-run
 * durations for its retention window, so this reconstructs the Cue share from
 * there using the engine's own crediting rule.
 *
 * This only re-attributes time already inside `cumulativeTimeMs` - it never adds
 * to the total, and is clamped so the subtotal can't exceed it. History older
 * than the Cue retention window is unrecoverable and stays attributed to Auto
 * Run, so the result is a floor, not an exact split.
 */
async function backfillCueTimeIfNeeded(alreadyApplied: boolean): Promise<void> {
	if (alreadyApplied) return;
	try {
		const historicalCreditMs = await window.maestro.cueStats.getHistoricalConductorCredit();
		// Mark applied regardless of the amount: a user with no retained Cue
		// history should not re-query the database on every launch.
		window.maestro.settings.set('cueTimeBackfillApplied', true);
		if (!Number.isFinite(historicalCreditMs) || historicalCreditMs <= 0) return;

		const prev = useSettingsStore.getState().autoRunStats;
		// Take the larger of the two: live Cue credit may already have accrued
		// between app launch and this call, and that time is also represented in
		// the historical total once its run completed.
		const cueTimeMs = Math.min(
			Math.max(prev.cueTimeMs ?? 0, historicalCreditMs),
			prev.cumulativeTimeMs
		);
		if (cueTimeMs === (prev.cueTimeMs ?? 0)) return;

		const updated: AutoRunStats = { ...prev, cueTimeMs };
		useSettingsStore.setState({ autoRunStats: updated });
		window.maestro.settings.set('autoRunStats', updated);
		logger.info(
			`[Settings] Backfilled Cue Conductor time from cue.db: ${Math.round(cueTimeMs / 60000)} minutes`
		);
	} catch (error) {
		// A missing/failed Cue database just means no historical split is
		// available. Leave the flag unset so a later launch can retry.
		logger.warn('[Settings] Cue time backfill skipped', undefined, error);
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
		setGlobalShowHotkey: state.setGlobalShowHotkey,
		setLlmProvider: state.setLlmProvider,
		setModelSlug: state.setModelSlug,
		setApiKey: state.setApiKey,
		setDefaultShell: state.setDefaultShell,
		setCustomShellPath: state.setCustomShellPath,
		setShellArgs: state.setShellArgs,
		setShellEnvVars: state.setShellEnvVars,
		setShellEnvVarsDisabled: state.setShellEnvVarsDisabled,
		setGhPath: state.setGhPath,
		setFontFamily: state.setFontFamily,
		setTerminalFontFamily: state.setTerminalFontFamily,
		setChatFontFamily: state.setChatFontFamily,
		setFilePreviewFontFamily: state.setFilePreviewFontFamily,
		setFileEditorFontFamily: state.setFileEditorFontFamily,
		setSurfaceFontFamily: state.setSurfaceFontFamily,
		setSurfaceFontSize: state.setSurfaceFontSize,
		setFontZoom: state.setFontZoom,
		resetTypography: state.resetTypography,
		setTypographyPromptSeen: state.setTypographyPromptSeen,
		setThemePromptSeen: state.setThemePromptSeen,
		setAgentPowersPromptSeen: state.setAgentPowersPromptSeen,
		applyTypographyPreset: state.applyTypographyPreset,
		setFontSize: state.setFontSize,
		setMediaPlaybackRate: state.setMediaPlaybackRate,
		setActiveThemeId: state.setActiveThemeId,
		setCustomThemeColors: state.setCustomThemeColors,
		setCustomThemeBaseId: state.setCustomThemeBaseId,
		setEnterToSendAI: state.setEnterToSendAI,
		setDefaultSaveToHistory: state.setDefaultSaveToHistory,
		setSynopsisDebounceSeconds: state.setSynopsisDebounceSeconds,
		setDefaultShowThinking: state.setDefaultShowThinking,
		setShowToolCalls: state.setShowToolCalls,
		setLeftSidebarWidth: state.setLeftSidebarWidth,
		setRightPanelWidth: state.setRightPanelWidth,
		setModalSize: state.setModalSize,
		resetModalSize: state.resetModalSize,
		resetModalSizes: state.resetModalSizes,
		setConcertoStageFloating: state.setConcertoStageFloating,
		setConcertoStagePosition: state.setConcertoStagePosition,
		setTextareaHeight: state.setTextareaHeight,
		setMarkdownEditMode: state.setMarkdownEditMode,
		setChatRawTextMode: state.setChatRawTextMode,
		setGroupChatAutoScroll: state.setGroupChatAutoScroll,
		setBionifyReadingMode: state.setBionifyReadingMode,
		setBionifyIntensity: state.setBionifyIntensity,
		setBionifyAlgorithm: state.setBionifyAlgorithm,
		setShowHiddenFiles: state.setShowHiddenFiles,
		setFileExplorerIconTheme: state.setFileExplorerIconTheme,
		setToastWidth: state.setToastWidth,
		setTerminalWidth: state.setTerminalWidth,
		setLogLevel: state.setLogLevel,
		setMaxLogBuffer: state.setMaxLogBuffer,
		setMaxOutputLines: state.setMaxOutputLines,
		setOsNotificationsEnabled: state.setOsNotificationsEnabled,
		setAudioFeedbackEnabled: state.setAudioFeedbackEnabled,
		setAudioFeedbackCommand: state.setAudioFeedbackCommand,
		setToastDuration: state.setToastDuration,
		setCheckForUpdatesOnStartup: state.setCheckForUpdatesOnStartup,
		setAutoResumeOnLimit: state.setAutoResumeOnLimit,
		setAutoResumeCheckIntervalHours: state.setAutoResumeCheckIntervalHours,
		setAutoResumeGiveUpDays: state.setAutoResumeGiveUpDays,
		setEnableBetaUpdates: state.setEnableBetaUpdates,
		setCrashReportingEnabled: state.setCrashReportingEnabled,
		setLogViewerSelectedLevels: state.setLogViewerSelectedLevels,
		setShortcuts: state.setShortcuts,
		setTabShortcuts: state.setTabShortcuts,
		setCustomAICommands: state.setCustomAICommands,
		setTotalActiveTimeMs: state.setTotalActiveTimeMs,
		addTotalActiveTimeMs: state.addTotalActiveTimeMs,
		unlockDelegationMilestone: state.unlockDelegationMilestone,
		setAutoRunStats: state.setAutoRunStats,
		recordAutoRunComplete: state.recordAutoRunComplete,
		updateAutoRunProgress: state.updateAutoRunProgress,
		acknowledgeBadge: state.acknowledgeBadge,
		getUnacknowledgedBadgeLevel: state.getUnacknowledgedBadgeLevel,
		setUsageStats: state.setUsageStats,
		updateUsageStats: state.updateUsageStats,
		setUngroupedCollapsed: state.setUngroupedCollapsed,
		setGroupChatsExpanded: state.setGroupChatsExpanded,
		setGroupChatSortAlphabetical: state.setGroupChatSortAlphabetical,
		setStarredSessionsCollapsed: state.setStarredSessionsCollapsed,
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
		setPersistentWebLink: state.setPersistentWebLink,
		setWebInterfaceAutoStart: state.setWebInterfaceAutoStart,
		setWebInterfaceUseCustomPort: state.setWebInterfaceUseCustomPort,
		setWebInterfaceCustomPort: state.setWebInterfaceCustomPort,
		setContextManagementSettings: state.setContextManagementSettings,
		updateContextManagementSettings: state.updateContextManagementSettings,
		setKeyboardMasteryStats: state.setKeyboardMasteryStats,
		recordShortcutUsage: state.recordShortcutUsage,
		acknowledgeKeyboardMasteryLevel: state.acknowledgeKeyboardMasteryLevel,
		getUnacknowledgedKeyboardMasteryLevel: state.getUnacknowledgedKeyboardMasteryLevel,
		setColorBlindMode: state.setColorBlindMode,
		setThemeGloss: state.setThemeGloss,
		setDocumentGraphShowExternalLinks: state.setDocumentGraphShowExternalLinks,
		setDocumentGraphConfirmClose: state.setDocumentGraphConfirmClose,
		setDocumentGraphMaxNodes: state.setDocumentGraphMaxNodes,
		setDocumentGraphPreviewCharLimit: state.setDocumentGraphPreviewCharLimit,
		setDocumentGraphLayoutType: state.setDocumentGraphLayoutType,
		setStatsCollectionEnabled: state.setStatsCollectionEnabled,
		setDefaultStatsTimeRange: state.setDefaultStatsTimeRange,
		setPreventSleepEnabled: state.setPreventSleepEnabled,
		setDisableGpuAcceleration: state.setDisableGpuAcceleration,
		setDisableConfetti: state.setDisableConfetti,
		setLocalIgnorePatterns: state.setLocalIgnorePatterns,
		setLocalHonorGitignore: state.setLocalHonorGitignore,
		setSshRemoteIgnorePatterns: state.setSshRemoteIgnorePatterns,
		setSshRemoteHonorGitignore: state.setSshRemoteHonorGitignore,
		setAutomaticTabNamingEnabled: state.setAutomaticTabNamingEnabled,
		setNewTabPlacement: state.setNewTabPlacement,
		setNewBrowserTabPlacement: state.setNewBrowserTabPlacement,
		setNewTerminalPlacement: state.setNewTerminalPlacement,
		setOpenedFilePlacement: state.setOpenedFilePlacement,
		setFileTabAutoRefreshEnabled: state.setFileTabAutoRefreshEnabled,
		setSuppressWindowsWarning: state.setSuppressWindowsWarning,
		setUtilityAgentId: state.setUtilityAgentId,
		setUtilityModelId: state.setUtilityModelId,
		setEncoreFeatures: state.setEncoreFeatures,
		setDirectorNotesSettings: state.setDirectorNotesSettings,
		setWakatimeApiKey: state.setWakatimeApiKey,
		setWakatimeEnabled: state.setWakatimeEnabled,
		setWakatimeDetailedTracking: state.setWakatimeDetailedTracking,
		setUseNativeTitleBar: state.setUseNativeTitleBar,
		setAutoHideMenuBar: state.setAutoHideMenuBar,
		setShowAgentName: state.setShowAgentName,
		setShowSessionIdPill: state.setShowSessionIdPill,
		setShowSessionCostPill: state.setShowSessionCostPill,
		setShowWorktreePill: state.setShowWorktreePill,
		setShowWorktreeBranchName: state.setShowWorktreeBranchName,
		setShowLeftPanelGroupMemberCount: state.setShowLeftPanelGroupMemberCount,
		showStarredSessionsSection: state.showStarredSessionsSection,
		setShowStarredSessionsSection: state.setShowStarredSessionsSection,
		setLeftPanelCollapsedPillsPerRow: state.setLeftPanelCollapsedPillsPerRow,
		setShowLeftPanelLocationPills: state.setShowLeftPanelLocationPills,
		setShowLeftPanelGitIndicator: state.setShowLeftPanelGitIndicator,
		setShowLeftPanelCueIndicator: state.setShowLeftPanelCueIndicator,
		setShowLeftPanelStartupCommandIndicator: state.setShowLeftPanelStartupCommandIndicator,
		setFileEditWordWrap: state.setFileEditWordWrap,
		setFileEditShowLineNumbers: state.setFileEditShowLineNumbers,
		setFilePreviewToolbarButtonVisibility: state.setFilePreviewToolbarButtonVisibility,
		setModeratorStandingInstructions: state.setModeratorStandingInstructions,
		setSpellCheck: state.setSpellCheck,
		setAutoRunDisabled: state.setAutoRunDisabled,
		setDotfilesToggleHidden: state.setDotfilesToggleHidden,
		setAutoRunInactivityTimeoutMin: state.setAutoRunInactivityTimeoutMin,
		setAutoRunMaxTaskDurationMin: state.setAutoRunMaxTaskDurationMin,
		setLastSelectedPromptId: state.setLastSelectedPromptId,
		setAnnotatorPenColor: state.setAnnotatorPenColor,
		setAnnotatorPenSize: state.setAnnotatorPenSize,
		setAnnotatorThinning: state.setAnnotatorThinning,
		setAnnotatorSmoothing: state.setAnnotatorSmoothing,
		setAnnotatorStreamline: state.setAnnotatorStreamline,
		setAnnotatorTaperStart: state.setAnnotatorTaperStart,
		setAnnotatorTaperEnd: state.setAnnotatorTaperEnd,
	};
}
