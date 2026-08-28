import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
	useSettingsStore,
	loadAllSettings,
	selectIsLeaderboardRegistered,
	clampAutoRunMaxTaskDurationMin,
	sanitizeLoadedAutoRunMaxTaskDurationMin,
	DEFAULT_AUTORUN_MAX_TASK_DURATION_MIN,
	resolveForceParallel,
	FILE_PREVIEW_TOOLBAR_BUTTON_KEYS,
	DEFAULT_FILE_PREVIEW_TOOLBAR_VISIBILITY,
} from '../../../renderer/stores/settingsStore';
import type { SettingsStoreState } from '../../../renderer/stores/settingsStore';
import { SETTINGS_METADATA } from '../../../shared/settingsMetadata';
import { useUIStore } from '../../../renderer/stores/uiStore';
import {
	selectShowNowPlayingIndicator,
	useMediaPlaybackStore,
} from '../../../renderer/stores/mediaPlaybackStore';
import type { FileExplorerIconTheme } from '../../../renderer/utils/fileExplorerIcons/shared';
import { DEFAULT_SHORTCUTS, TAB_SHORTCUTS } from '../../../renderer/constants/shortcuts';
import { DEFAULT_CUSTOM_THEME_COLORS } from '../../../renderer/constants/themes';

// Pull defaults from a freshly-initialized store so tests don't need to re-import them.
// Deep-cloned so test mutations can't affect the captured reference.
// These constants match what the store uses internally (kept non-exported to prevent fan-out).
const _INITIAL_STATE = useSettingsStore.getState();
const DEFAULT_CONTEXT_MANAGEMENT_SETTINGS = JSON.parse(
	JSON.stringify(_INITIAL_STATE.contextManagementSettings)
);
const DEFAULT_AUTO_RUN_STATS = JSON.parse(JSON.stringify(_INITIAL_STATE.autoRunStats));
const DEFAULT_USAGE_STATS = JSON.parse(JSON.stringify(_INITIAL_STATE.usageStats));
const DEFAULT_KEYBOARD_MASTERY_STATS = JSON.parse(
	JSON.stringify(_INITIAL_STATE.keyboardMasteryStats)
);
const DEFAULT_ONBOARDING_STATS = JSON.parse(JSON.stringify(_INITIAL_STATE.onboardingStats));
const DEFAULT_AI_COMMANDS = JSON.parse(JSON.stringify(_INITIAL_STATE.customAICommands));

// Inlined badge level calculator matching settingsStore's internal function.
// Kept local so removing the export from the store doesn't break this test.
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

/**
 * Reset the Zustand store to initial state between tests.
 * Zustand stores are singletons, so state persists across tests unless explicitly reset.
 */
function resetStore() {
	useSettingsStore.setState({
		settingsLoaded: false,
		conductorProfile: '',
		globalShowHotkey: [],
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
		enterToSendAI: true,
		enterToSendAIExpanded: false,
		defaultSaveToHistory: true,
		defaultShowThinking: 'off',
		showToolCalls: true,
		leftSidebarWidth: 256,
		rightPanelWidth: 384,
		modalSizes: {},
		markdownEditMode: false,
		chatRawTextMode: false,
		groupChatAutoScroll: true,
		showHiddenFiles: true,
		fileExplorerIconTheme: 'default',
		terminalWidth: 100,
		logLevel: 'info',
		maxLogBuffer: 5000,
		maxOutputLines: Infinity,
		osNotificationsEnabled: true,
		audioFeedbackEnabled: false,
		audioFeedbackCommand: 'say',
		toastDuration: 20,
		idleNotificationEnabled: false,
		idleNotificationCommand: 'say Maestro is idle',
		checkForUpdatesOnStartup: true,
		enableBetaUpdates: false,
		crashReportingEnabled: true,
		logViewerSelectedLevels: ['debug', 'info', 'warn', 'error', 'toast'],
		shortcuts: DEFAULT_SHORTCUTS,
		tabShortcuts: TAB_SHORTCUTS,
		customAICommands: DEFAULT_AI_COMMANDS,
		totalActiveTimeMs: 0,
		autoRunStats: DEFAULT_AUTO_RUN_STATS,
		usageStats: DEFAULT_USAGE_STATS,
		ungroupedCollapsed: false,
		groupChatsExpanded: true,
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
		documentGraphLayoutType: 'hierarchical',
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
		directorNotesSettings: { provider: 'claude-code', defaultLookbackDays: 7 },
		wakatimeApiKey: '',
		wakatimeEnabled: false,
		forcedParallelExecution: false,
		forcedParallelAcknowledged: false,
		forcedParallelAlways: false,
	});
}

describe('settingsStore', () => {
	beforeEach(() => {
		resetStore();

		// Add power mock (not in global setup)
		if (!window.maestro.power) {
			(window.maestro as any).power = {
				setEnabled: vi.fn().mockResolvedValue(undefined),
			};
		}

		// Cue stats mock (not in global setup). loadAllSettings calls this for the
		// one-time cueTimeMs backfill; default to "no retained history".
		(window.maestro as any).cueStats = {
			getHistoricalConductorCredit: vi.fn().mockResolvedValue(0),
		};

		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ========================================================================
	// 1. Initial State
	// ========================================================================

	describe('initial state', () => {
		it('has correct default values for the initial settings fields', () => {
			const state = useSettingsStore.getState();

			expect(state.settingsLoaded).toBe(false);
			expect(state.conductorProfile).toBe('');
			expect(state.llmProvider).toBe('openrouter');
			expect(state.modelSlug).toBe('anthropic/claude-3.5-sonnet');
			expect(state.apiKey).toBe('');
			expect(state.defaultShell).toBe('zsh');
			expect(state.customShellPath).toBe('');
			expect(state.shellArgs).toBe('');
			expect(state.shellEnvVars).toEqual({});
			expect(state.ghPath).toBe('');
			expect(state.fontFamily).toBe('Roboto Mono, Menlo, "Courier New", monospace');
			// Every surface font defaults to empty, meaning "inherit the interface
			// font", so a fresh install pins no surface to a face of its own.
			expect(state.terminalFontFamily).toBe('');
			expect(state.chatFontFamily).toBe('');
			expect(state.filePreviewFontFamily).toBe('');
			expect(state.fileEditorFontFamily).toBe('');
			expect(state.fontSize).toBe(14);
			expect(state.activeThemeId).toBe('dracula');
			expect(state.customThemeColors).toEqual(DEFAULT_CUSTOM_THEME_COLORS);
			expect(state.customThemeBaseId).toBe('dracula');
			expect(state.enterToSendAI).toBe(true);
			expect(state.enterToSendAIExpanded).toBe(false);
			expect(state.defaultSaveToHistory).toBe(true);
			expect(state.defaultShowThinking).toBe('off');
			expect(state.showToolCalls).toBe(true);
			expect(state.leftSidebarWidth).toBe(256);
			expect(state.rightPanelWidth).toBe(384);
			expect(state.modalSizes).toEqual({});
			expect(state.markdownEditMode).toBe(false);
			expect(state.chatRawTextMode).toBe(false);
			expect(state.groupChatAutoScroll).toBe(true);
			expect(state.showHiddenFiles).toBe(true);
			expect(state.fileExplorerIconTheme).toBe('default');
			expect(state.fileExplorerMaxDepth).toBe(10);
			expect(state.fileExplorerMaxEntries).toBe(100_000);
			expect(state.sshReduceEntryCapEnabled).toBe(false);
			expect(state.sshReduceEntryCapFraction).toBe(0.1);
			expect(state.terminalWidth).toBe(100);
			expect(state.logLevel).toBe('info');
			expect(state.maxLogBuffer).toBe(5000);
			expect(state.maxOutputLines).toBe(Infinity);
			expect(state.osNotificationsEnabled).toBe(true);
			expect(state.audioFeedbackEnabled).toBe(false);
			expect(state.audioFeedbackCommand).toBe('say');
			expect(state.toastDuration).toBe(20);
			expect(state.checkForUpdatesOnStartup).toBe(true);
			expect(state.enableBetaUpdates).toBe(false);
			expect(state.crashReportingEnabled).toBe(true);
			expect(state.logViewerSelectedLevels).toEqual(['debug', 'info', 'warn', 'error', 'toast']);
			expect(state.shortcuts).toEqual(DEFAULT_SHORTCUTS);
			expect(state.tabShortcuts).toEqual(TAB_SHORTCUTS);
			expect(state.customAICommands).toEqual(DEFAULT_AI_COMMANDS);
			expect(state.totalActiveTimeMs).toBe(0);
			expect(state.autoRunStats).toEqual(DEFAULT_AUTO_RUN_STATS);
			expect(state.usageStats).toEqual(DEFAULT_USAGE_STATS);
			expect(state.ungroupedCollapsed).toBe(false);
			expect(state.groupChatsExpanded).toBe(true);
			expect(state.groupChatSortAlphabetical).toBe(false);
			expect(state.starredSessionsCollapsed).toBe(false);
			expect(state.tourCompleted).toBe(false);
			expect(state.firstAutoRunCompleted).toBe(false);
			expect(state.onboardingStats).toEqual(DEFAULT_ONBOARDING_STATS);
			expect(state.leaderboardRegistration).toBeNull();
			expect(state.webInterfaceUseCustomPort).toBe(false);
			expect(state.webInterfaceCustomPort).toBe(8080);
			expect(state.contextManagementSettings).toEqual(DEFAULT_CONTEXT_MANAGEMENT_SETTINGS);
			expect(state.keyboardMasteryStats).toEqual(DEFAULT_KEYBOARD_MASTERY_STATS);
			expect(state.colorBlindMode).toBe(false);
			expect(state.documentGraphShowExternalLinks).toBe(false);
			expect(state.documentGraphMaxNodes).toBe(50);
			expect(state.documentGraphPreviewCharLimit).toBe(100);
			expect(state.documentGraphLayoutType).toBe('hierarchical');
			expect(state.statsCollectionEnabled).toBe(true);
			expect(state.defaultStatsTimeRange).toBe('week');
			expect(state.preventSleepEnabled).toBe(false);
			expect(state.disableGpuAcceleration).toBe(false);
			expect(state.disableConfetti).toBe(false);
			expect(state.sshRemoteIgnorePatterns).toEqual(['.git', '*cache*']);
			expect(state.sshRemoteHonorGitignore).toBe(true);
			expect(state.automaticTabNamingEnabled).toBe(true);
			expect(state.fileTabAutoRefreshEnabled).toBe(false);
			expect(state.suppressWindowsWarning).toBe(false);
			expect(state.directorNotesSettings).toEqual({
				provider: 'claude-code',
				defaultLookbackDays: 7,
			});
			expect(state.wakatimeApiKey).toBe('');
			expect(state.wakatimeEnabled).toBe(false);
			expect(state.forcedParallelExecution).toBe(false);
			expect(state.forcedParallelAcknowledged).toBe(false);
		});
	});

	// ========================================================================
	// 2. Simple Setters
	// ========================================================================

	describe('simple setters', () => {
		describe('AI/LLM', () => {
			it('setLlmProvider updates state and persists', () => {
				useSettingsStore.getState().setLlmProvider('anthropic' as any);
				expect(useSettingsStore.getState().llmProvider).toBe('anthropic');
				expect(window.maestro.settings.set).toHaveBeenCalledWith('llmProvider', 'anthropic');
			});

			it('setModelSlug updates state and persists', () => {
				useSettingsStore.getState().setModelSlug('gpt-4');
				expect(useSettingsStore.getState().modelSlug).toBe('gpt-4');
				expect(window.maestro.settings.set).toHaveBeenCalledWith('modelSlug', 'gpt-4');
			});

			it('setApiKey updates state and persists', () => {
				useSettingsStore.getState().setApiKey('sk-test-key');
				expect(useSettingsStore.getState().apiKey).toBe('sk-test-key');
				expect(window.maestro.settings.set).toHaveBeenCalledWith('apiKey', 'sk-test-key');
			});
		});

		describe('Shell', () => {
			it('setDefaultShell updates state and persists', () => {
				useSettingsStore.getState().setDefaultShell('bash');
				expect(useSettingsStore.getState().defaultShell).toBe('bash');
				expect(window.maestro.settings.set).toHaveBeenCalledWith('defaultShell', 'bash');
			});

			it('setCustomShellPath updates state and persists', () => {
				useSettingsStore.getState().setCustomShellPath('/usr/local/bin/fish');
				expect(useSettingsStore.getState().customShellPath).toBe('/usr/local/bin/fish');
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'customShellPath',
					'/usr/local/bin/fish'
				);
			});

			it('setShellArgs updates state and persists', () => {
				useSettingsStore.getState().setShellArgs('--login');
				expect(useSettingsStore.getState().shellArgs).toBe('--login');
				expect(window.maestro.settings.set).toHaveBeenCalledWith('shellArgs', '--login');
			});

			it('setShellEnvVars updates state and persists', () => {
				const envVars = { NODE_ENV: 'development', PORT: '3000' };
				useSettingsStore.getState().setShellEnvVars(envVars);
				expect(useSettingsStore.getState().shellEnvVars).toEqual(envVars);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('shellEnvVars', envVars);
			});

			it('setGhPath updates state and persists', () => {
				useSettingsStore.getState().setGhPath('/usr/local/bin/gh');
				expect(useSettingsStore.getState().ghPath).toBe('/usr/local/bin/gh');
				expect(window.maestro.settings.set).toHaveBeenCalledWith('ghPath', '/usr/local/bin/gh');
			});
		});

		describe('Appearance', () => {
			it('setFontFamily updates state and persists', () => {
				useSettingsStore.getState().setFontFamily('Fira Code');
				expect(useSettingsStore.getState().fontFamily).toBe('Fira Code');
				expect(window.maestro.settings.set).toHaveBeenCalledWith('fontFamily', 'Fira Code');
			});

			it.each([
				['setTerminalFontFamily', 'terminalFontFamily'],
				['setChatFontFamily', 'chatFontFamily'],
				['setFilePreviewFontFamily', 'filePreviewFontFamily'],
				['setFileEditorFontFamily', 'fileEditorFontFamily'],
			] as const)('%s updates state and persists', (action, key) => {
				const store = useSettingsStore.getState() as unknown as Record<
					string,
					(value: string) => void
				>;
				store[action]('Verdana');
				expect((useSettingsStore.getState() as unknown as Record<string, string>)[key]).toBe(
					'Verdana'
				);
				expect(window.maestro.settings.set).toHaveBeenCalledWith(key, 'Verdana');
			});

			it('setFontSize updates state and persists', () => {
				useSettingsStore.getState().setFontSize(18);
				expect(useSettingsStore.getState().fontSize).toBe(18);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('fontSize', 18);
			});

			it('setActiveThemeId updates state and persists', () => {
				useSettingsStore.getState().setActiveThemeId('monokai' as any);
				expect(useSettingsStore.getState().activeThemeId).toBe('monokai');
				expect(window.maestro.settings.set).toHaveBeenCalledWith('activeThemeId', 'monokai');
			});

			it('setCustomThemeColors updates state and persists', () => {
				const colors = { ...DEFAULT_CUSTOM_THEME_COLORS, background: '#111111' };
				useSettingsStore.getState().setCustomThemeColors(colors);
				expect(useSettingsStore.getState().customThemeColors).toEqual(colors);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('customThemeColors', colors);
			});

			it('setCustomThemeBaseId updates state and persists', () => {
				useSettingsStore.getState().setCustomThemeBaseId('one-dark-pro' as any);
				expect(useSettingsStore.getState().customThemeBaseId).toBe('one-dark-pro');
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'customThemeBaseId',
					'one-dark-pro'
				);
			});
		});

		describe('Editor', () => {
			it('setEnterToSendAI updates state and persists', () => {
				useSettingsStore.getState().setEnterToSendAI(true);
				expect(useSettingsStore.getState().enterToSendAI).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('enterToSendAI', true);
			});

			it('setDefaultSaveToHistory updates state and persists', () => {
				useSettingsStore.getState().setDefaultSaveToHistory(false);
				expect(useSettingsStore.getState().defaultSaveToHistory).toBe(false);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('defaultSaveToHistory', false);
			});

			it('setDefaultShowThinking updates state and persists', () => {
				useSettingsStore.getState().setDefaultShowThinking('on');
				expect(useSettingsStore.getState().defaultShowThinking).toBe('on');
				expect(window.maestro.settings.set).toHaveBeenCalledWith('defaultShowThinking', 'on');
			});

			it('setShowToolCalls updates state and persists', () => {
				useSettingsStore.getState().setShowToolCalls(false);
				expect(useSettingsStore.getState().showToolCalls).toBe(false);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('showToolCalls', false);
			});
		});

		describe('Layout', () => {
			it('setRightPanelWidth updates state and persists', () => {
				useSettingsStore.getState().setRightPanelWidth(500);
				expect(useSettingsStore.getState().rightPanelWidth).toBe(500);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('rightPanelWidth', 500);
			});
		});

		describe('Display', () => {
			it('setMarkdownEditMode updates state and persists', () => {
				useSettingsStore.getState().setMarkdownEditMode(true);
				expect(useSettingsStore.getState().markdownEditMode).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('markdownEditMode', true);
			});

			it('setChatRawTextMode updates state and persists', () => {
				useSettingsStore.getState().setChatRawTextMode(true);
				expect(useSettingsStore.getState().chatRawTextMode).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('chatRawTextMode', true);
			});

			it('setGroupChatAutoScroll updates state and persists', () => {
				useSettingsStore.getState().setGroupChatAutoScroll(false);
				expect(useSettingsStore.getState().groupChatAutoScroll).toBe(false);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('groupChatAutoScroll', false);
			});

			it('setShowHiddenFiles updates state and persists', () => {
				useSettingsStore.getState().setShowHiddenFiles(false);
				expect(useSettingsStore.getState().showHiddenFiles).toBe(false);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('showHiddenFiles', false);
			});

			it('setFileExplorerIconTheme updates state and persists', () => {
				useSettingsStore.getState().setFileExplorerIconTheme('rich');
				expect(useSettingsStore.getState().fileExplorerIconTheme).toBe('rich');
				expect(window.maestro.settings.set).toHaveBeenCalledWith('fileExplorerIconTheme', 'rich');
			});
		});

		describe('Terminal', () => {
			it('setMaxOutputLines updates state and persists', () => {
				useSettingsStore.getState().setMaxOutputLines(50);
				expect(useSettingsStore.getState().maxOutputLines).toBe(50);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('maxOutputLines', 50);
			});
		});

		describe('Notifications', () => {
			it('setOsNotificationsEnabled updates state and persists', () => {
				useSettingsStore.getState().setOsNotificationsEnabled(false);
				expect(useSettingsStore.getState().osNotificationsEnabled).toBe(false);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('osNotificationsEnabled', false);
			});

			it('setAudioFeedbackEnabled updates state and persists', () => {
				useSettingsStore.getState().setAudioFeedbackEnabled(true);
				expect(useSettingsStore.getState().audioFeedbackEnabled).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('audioFeedbackEnabled', true);
			});

			it('setAudioFeedbackCommand updates state and persists', () => {
				useSettingsStore.getState().setAudioFeedbackCommand('afplay');
				expect(useSettingsStore.getState().audioFeedbackCommand).toBe('afplay');
				expect(window.maestro.settings.set).toHaveBeenCalledWith('audioFeedbackCommand', 'afplay');
			});

			it('setToastDuration updates state and persists', () => {
				useSettingsStore.getState().setToastDuration(10);
				expect(useSettingsStore.getState().toastDuration).toBe(10);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('toastDuration', 10);
			});
		});

		describe('Updates', () => {
			it('setCheckForUpdatesOnStartup updates state and persists', () => {
				useSettingsStore.getState().setCheckForUpdatesOnStartup(false);
				expect(useSettingsStore.getState().checkForUpdatesOnStartup).toBe(false);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('checkForUpdatesOnStartup', false);
			});

			it('setEnableBetaUpdates updates state and persists', () => {
				useSettingsStore.getState().setEnableBetaUpdates(true);
				expect(useSettingsStore.getState().enableBetaUpdates).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('enableBetaUpdates', true);
			});

			it('setCrashReportingEnabled updates state and persists', () => {
				useSettingsStore.getState().setCrashReportingEnabled(false);
				expect(useSettingsStore.getState().crashReportingEnabled).toBe(false);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('crashReportingEnabled', false);
			});
		});

		describe('Logging', () => {
			it('setLogViewerSelectedLevels updates state and persists', () => {
				const levels = ['error', 'warn'];
				useSettingsStore.getState().setLogViewerSelectedLevels(levels);
				expect(useSettingsStore.getState().logViewerSelectedLevels).toEqual(levels);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('logViewerSelectedLevels', levels);
			});
		});

		describe('Shortcuts', () => {
			it('setShortcuts updates state and persists', () => {
				const newShortcuts = {
					...DEFAULT_SHORTCUTS,
					toggleSidebar: { ...DEFAULT_SHORTCUTS.toggleSidebar, keys: ['Meta', 'b'] },
				};
				useSettingsStore.getState().setShortcuts(newShortcuts);
				expect(useSettingsStore.getState().shortcuts).toEqual(newShortcuts);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('shortcuts', newShortcuts);
			});

			it('setTabShortcuts updates state and persists', () => {
				const newTabShortcuts = {
					...TAB_SHORTCUTS,
					newTab: { ...TAB_SHORTCUTS.newTab, keys: ['Meta', 'Shift', 't'] },
				};
				useSettingsStore.getState().setTabShortcuts(newTabShortcuts);
				expect(useSettingsStore.getState().tabShortcuts).toEqual(newTabShortcuts);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('tabShortcuts', newTabShortcuts);
			});

			it('setCustomAICommands updates state and persists', () => {
				const commands = [
					...DEFAULT_AI_COMMANDS,
					{
						id: 'test',
						command: '/test',
						description: 'Test command',
						prompt: 'test',
						isBuiltIn: false,
					},
				];
				useSettingsStore.getState().setCustomAICommands(commands);
				expect(useSettingsStore.getState().customAICommands).toEqual(commands);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('customAICommands', commands);
			});
		});

		describe('Misc', () => {
			it('setUngroupedCollapsed updates state and persists', () => {
				useSettingsStore.getState().setUngroupedCollapsed(true);
				expect(useSettingsStore.getState().ungroupedCollapsed).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('ungroupedCollapsed', true);
			});

			it('setGroupChatsExpanded updates state and persists', () => {
				useSettingsStore.getState().setGroupChatsExpanded(false);
				expect(useSettingsStore.getState().groupChatsExpanded).toBe(false);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('groupChatsExpanded', false);
			});

			it('setGroupChatSortAlphabetical updates state and persists', () => {
				useSettingsStore.getState().setGroupChatSortAlphabetical(true);
				expect(useSettingsStore.getState().groupChatSortAlphabetical).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('groupChatSortAlphabetical', true);
			});

			it('setStarredSessionsCollapsed updates state and persists', () => {
				useSettingsStore.getState().setStarredSessionsCollapsed(true);
				expect(useSettingsStore.getState().starredSessionsCollapsed).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('starredSessionsCollapsed', true);
			});

			it('setTourCompleted updates state and persists', () => {
				useSettingsStore.getState().setTourCompleted(true);
				expect(useSettingsStore.getState().tourCompleted).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('tourCompleted', true);
			});

			it('setFirstAutoRunCompleted updates state and persists', () => {
				useSettingsStore.getState().setFirstAutoRunCompleted(true);
				expect(useSettingsStore.getState().firstAutoRunCompleted).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('firstAutoRunCompleted', true);
			});

			it('setLeaderboardRegistration updates state and persists', () => {
				const reg = { email: 'test@test.com', emailConfirmed: true, authToken: 'abc' };
				useSettingsStore.getState().setLeaderboardRegistration(reg as any);
				expect(useSettingsStore.getState().leaderboardRegistration).toEqual(reg);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('leaderboardRegistration', reg);
			});
		});

		describe('Web', () => {
			it('setWebInterfaceUseCustomPort updates state and persists', () => {
				useSettingsStore.getState().setWebInterfaceUseCustomPort(true);
				expect(useSettingsStore.getState().webInterfaceUseCustomPort).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('webInterfaceUseCustomPort', true);
			});
		});

		describe('Accessibility', () => {
			it('setColorBlindMode updates state and persists', () => {
				useSettingsStore.getState().setColorBlindMode(true);
				expect(useSettingsStore.getState().colorBlindMode).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('colorBlindMode', true);
			});
		});

		describe('Graph', () => {
			it('setDocumentGraphShowExternalLinks updates state and persists', () => {
				useSettingsStore.getState().setDocumentGraphShowExternalLinks(true);
				expect(useSettingsStore.getState().documentGraphShowExternalLinks).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'documentGraphShowExternalLinks',
					true
				);
			});

			it('setDocumentGraphLayoutType updates state and persists', () => {
				useSettingsStore.getState().setDocumentGraphLayoutType('radial');
				expect(useSettingsStore.getState().documentGraphLayoutType).toBe('radial');
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'documentGraphLayoutType',
					'radial'
				);
			});

			it('setDocumentGraphLayoutType rejects invalid values and persists fallback', () => {
				useSettingsStore.getState().setDocumentGraphLayoutType('invalid' as any);
				expect(useSettingsStore.getState().documentGraphLayoutType).toBe('hierarchical');
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'documentGraphLayoutType',
					'hierarchical'
				);
			});
		});

		describe('Stats settings', () => {
			it('setStatsCollectionEnabled updates state and persists', () => {
				useSettingsStore.getState().setStatsCollectionEnabled(false);
				expect(useSettingsStore.getState().statsCollectionEnabled).toBe(false);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('statsCollectionEnabled', false);
			});

			it('setDefaultStatsTimeRange updates state and persists', () => {
				useSettingsStore.getState().setDefaultStatsTimeRange('month');
				expect(useSettingsStore.getState().defaultStatsTimeRange).toBe('month');
				expect(window.maestro.settings.set).toHaveBeenCalledWith('defaultStatsTimeRange', 'month');
			});
		});

		describe('GPU/Confetti', () => {
			it('setDisableGpuAcceleration updates state and persists', () => {
				useSettingsStore.getState().setDisableGpuAcceleration(true);
				expect(useSettingsStore.getState().disableGpuAcceleration).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('disableGpuAcceleration', true);
			});

			it('setDisableConfetti updates state and persists', () => {
				useSettingsStore.getState().setDisableConfetti(true);
				expect(useSettingsStore.getState().disableConfetti).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('disableConfetti', true);
			});
		});

		describe('SSH', () => {
			it('setSshRemoteIgnorePatterns updates state and persists', () => {
				const patterns = ['.git', 'node_modules'];
				useSettingsStore.getState().setSshRemoteIgnorePatterns(patterns);
				expect(useSettingsStore.getState().sshRemoteIgnorePatterns).toEqual(patterns);
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'sshRemoteIgnorePatterns',
					patterns
				);
			});

			it('setSshRemoteHonorGitignore updates state and persists', () => {
				useSettingsStore.getState().setSshRemoteHonorGitignore(false);
				expect(useSettingsStore.getState().sshRemoteHonorGitignore).toBe(false);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('sshRemoteHonorGitignore', false);
			});
		});

		describe('Tabs', () => {
			it('setAutomaticTabNamingEnabled updates state and persists', () => {
				useSettingsStore.getState().setAutomaticTabNamingEnabled(false);
				expect(useSettingsStore.getState().automaticTabNamingEnabled).toBe(false);
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'automaticTabNamingEnabled',
					false
				);
			});

			it('setFileTabAutoRefreshEnabled updates state and persists', () => {
				useSettingsStore.getState().setFileTabAutoRefreshEnabled(true);
				expect(useSettingsStore.getState().fileTabAutoRefreshEnabled).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('fileTabAutoRefreshEnabled', true);
			});

			it('setSuppressWindowsWarning updates state and persists', () => {
				useSettingsStore.getState().setSuppressWindowsWarning(true);
				expect(useSettingsStore.getState().suppressWindowsWarning).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('suppressWindowsWarning', true);
			});

			it('setDirectorNotesSettings updates state and persists', () => {
				const settings = { provider: 'codex' as const, defaultLookbackDays: 14 };
				useSettingsStore.getState().setDirectorNotesSettings(settings);
				expect(useSettingsStore.getState().directorNotesSettings).toEqual(settings);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('directorNotesSettings', settings);
			});

			it('setWakatimeApiKey updates state and persists', () => {
				useSettingsStore.getState().setWakatimeApiKey('waka_test_key_123');
				expect(useSettingsStore.getState().wakatimeApiKey).toBe('waka_test_key_123');
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'wakatimeApiKey',
					'waka_test_key_123'
				);
			});

			it('setWakatimeEnabled updates state and persists', () => {
				useSettingsStore.getState().setWakatimeEnabled(true);
				expect(useSettingsStore.getState().wakatimeEnabled).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('wakatimeEnabled', true);
			});
		});

		describe('Forced Parallel Execution', () => {
			it('setForcedParallelExecution updates state and persists', () => {
				useSettingsStore.getState().setForcedParallelExecution(true);
				expect(useSettingsStore.getState().forcedParallelExecution).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('forcedParallelExecution', true);
			});

			it('setForcedParallelAcknowledged updates state and persists', () => {
				useSettingsStore.getState().setForcedParallelAcknowledged(true);
				expect(useSettingsStore.getState().forcedParallelAcknowledged).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'forcedParallelAcknowledged',
					true
				);
			});

			it('forcedParallelExecution defaults to false', () => {
				expect(useSettingsStore.getState().forcedParallelExecution).toBe(false);
			});

			it('forcedParallelAcknowledged defaults to false', () => {
				expect(useSettingsStore.getState().forcedParallelAcknowledged).toBe(false);
			});

			it('setForcedParallelAlways updates state and persists', () => {
				useSettingsStore.getState().setForcedParallelAlways(true);
				expect(useSettingsStore.getState().forcedParallelAlways).toBe(true);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('forcedParallelAlways', true);
			});

			it('forcedParallelAlways defaults to false', () => {
				expect(useSettingsStore.getState().forcedParallelAlways).toBe(false);
			});

			describe('resolveForceParallel', () => {
				it('never forces when the feature is off, regardless of option or always mode', () => {
					useSettingsStore.setState({
						forcedParallelExecution: false,
						forcedParallelAlways: true,
					});
					expect(resolveForceParallel(true)).toBe(false);
					expect(resolveForceParallel(false)).toBe(false);
				});

				it('modifier mode forces only when the caller passes the explicit override', () => {
					useSettingsStore.setState({
						forcedParallelExecution: true,
						forcedParallelAlways: false,
					});
					expect(resolveForceParallel(true)).toBe(true);
					expect(resolveForceParallel(false)).toBe(false);
					expect(resolveForceParallel(undefined)).toBe(false);
				});

				it('always mode forces every send even without the override', () => {
					useSettingsStore.setState({
						forcedParallelExecution: true,
						forcedParallelAlways: true,
					});
					expect(resolveForceParallel(undefined)).toBe(true);
					expect(resolveForceParallel(false)).toBe(true);
				});
			});
		});
	});

	// ========================================================================
	// 3. Setters with Validation
	// ========================================================================

	describe('setters with validation', () => {
		it('setConductorProfile trims to 5000 characters', () => {
			const longProfile = 'a'.repeat(6000);
			useSettingsStore.getState().setConductorProfile(longProfile);
			expect(useSettingsStore.getState().conductorProfile).toBe('a'.repeat(5000));
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'conductorProfile',
				'a'.repeat(5000)
			);
		});

		it('setLeftSidebarWidth clamps to 256-600', () => {
			// Below minimum
			useSettingsStore.getState().setLeftSidebarWidth(100);
			expect(useSettingsStore.getState().leftSidebarWidth).toBe(256);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('leftSidebarWidth', 256);

			vi.clearAllMocks();

			// Above maximum
			useSettingsStore.getState().setLeftSidebarWidth(800);
			expect(useSettingsStore.getState().leftSidebarWidth).toBe(600);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('leftSidebarWidth', 600);

			vi.clearAllMocks();

			// Within range
			useSettingsStore.getState().setLeftSidebarWidth(400);
			expect(useSettingsStore.getState().leftSidebarWidth).toBe(400);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('leftSidebarWidth', 400);
		});

		it('setModalSize persists a normalized size by key', () => {
			useSettingsStore.getState().setModalSize('settings', { width: 812.4, height: 620.6 });

			expect(useSettingsStore.getState().modalSizes).toEqual({
				settings: { width: 812, height: 621 },
			});
			expect(window.maestro.settings.set).toHaveBeenCalledWith('modalSizes', {
				settings: { width: 812, height: 621 },
			});
		});

		it('resetModalSizes clears persisted modal sizes', () => {
			useSettingsStore.setState({
				modalSizes: {
					settings: { width: 812, height: 621 },
				},
			});

			useSettingsStore.getState().resetModalSizes();

			expect(useSettingsStore.getState().modalSizes).toEqual({});
			expect(window.maestro.settings.set).toHaveBeenCalledWith('modalSizes', {});
		});

		it('resetModalSize drops one key and leaves the rest', () => {
			useSettingsStore.setState({
				modalSizes: {
					settings: { width: 812, height: 621 },
					about: { width: 560, height: 420 },
				},
			});

			useSettingsStore.getState().resetModalSize('settings');

			expect(useSettingsStore.getState().modalSizes).toEqual({
				about: { width: 560, height: 420 },
			});
			expect(window.maestro.settings.set).toHaveBeenCalledWith('modalSizes', {
				about: { width: 560, height: 420 },
			});
		});

		it('resetModalSize does not persist for a modal that was never resized', () => {
			useSettingsStore.setState({ modalSizes: {} });

			useSettingsStore.getState().resetModalSize('never-resized');

			expect(window.maestro.settings.set).not.toHaveBeenCalledWith('modalSizes', expect.anything());
		});

		it('setWebInterfaceCustomPort persists only valid 1024-65535', () => {
			// Valid port
			useSettingsStore.getState().setWebInterfaceCustomPort(3000);
			expect(useSettingsStore.getState().webInterfaceCustomPort).toBe(3000);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('webInterfaceCustomPort', 3000);

			vi.clearAllMocks();

			// Invalid port (below range) - state updates but no persist
			useSettingsStore.getState().setWebInterfaceCustomPort(80);
			expect(useSettingsStore.getState().webInterfaceCustomPort).toBe(80);
			expect(window.maestro.settings.set).not.toHaveBeenCalled();

			vi.clearAllMocks();

			// Invalid port (above range) - state updates but no persist
			useSettingsStore.getState().setWebInterfaceCustomPort(70000);
			expect(useSettingsStore.getState().webInterfaceCustomPort).toBe(70000);
			expect(window.maestro.settings.set).not.toHaveBeenCalled();
		});

		it('setDocumentGraphMaxNodes clamps to 50-1000', () => {
			useSettingsStore.getState().setDocumentGraphMaxNodes(10);
			expect(useSettingsStore.getState().documentGraphMaxNodes).toBe(50);

			useSettingsStore.getState().setDocumentGraphMaxNodes(2000);
			expect(useSettingsStore.getState().documentGraphMaxNodes).toBe(1000);

			useSettingsStore.getState().setDocumentGraphMaxNodes(500);
			expect(useSettingsStore.getState().documentGraphMaxNodes).toBe(500);
		});

		it('setDocumentGraphPreviewCharLimit clamps to 50-500', () => {
			useSettingsStore.getState().setDocumentGraphPreviewCharLimit(10);
			expect(useSettingsStore.getState().documentGraphPreviewCharLimit).toBe(50);

			useSettingsStore.getState().setDocumentGraphPreviewCharLimit(1000);
			expect(useSettingsStore.getState().documentGraphPreviewCharLimit).toBe(500);

			useSettingsStore.getState().setDocumentGraphPreviewCharLimit(250);
			expect(useSettingsStore.getState().documentGraphPreviewCharLimit).toBe(250);
		});
	});

	// ========================================================================
	// 4. Async Setters
	// ========================================================================

	describe('async setters', () => {
		it('setLogLevel updates state and calls logger.setLogLevel', async () => {
			await useSettingsStore.getState().setLogLevel('debug');
			expect(useSettingsStore.getState().logLevel).toBe('debug');
			expect(window.maestro.logger.setLogLevel).toHaveBeenCalledWith('debug');
		});

		it('setMaxLogBuffer updates state and calls logger.setMaxLogBuffer', async () => {
			await useSettingsStore.getState().setMaxLogBuffer(10000);
			expect(useSettingsStore.getState().maxLogBuffer).toBe(10000);
			expect(window.maestro.logger.setMaxLogBuffer).toHaveBeenCalledWith(10000);
		});

		it('setPreventSleepEnabled updates state, persists, and calls power.setEnabled', async () => {
			await useSettingsStore.getState().setPreventSleepEnabled(true);
			expect(useSettingsStore.getState().preventSleepEnabled).toBe(true);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('preventSleepEnabled', true);
			expect(window.maestro.power.setEnabled).toHaveBeenCalledWith(true);
		});
	});

	// ========================================================================
	// 5. Standalone Active Time Actions
	// ========================================================================

	describe('standalone active time actions', () => {
		it('setTotalActiveTimeMs replaces the value and persists', () => {
			useSettingsStore.getState().setTotalActiveTimeMs(120000);
			expect(useSettingsStore.getState().totalActiveTimeMs).toBe(120000);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('totalActiveTimeMs', 120000);
		});

		it('addTotalActiveTimeMs increments the value and persists', () => {
			useSettingsStore.setState({ totalActiveTimeMs: 50000 });
			vi.clearAllMocks();

			useSettingsStore.getState().addTotalActiveTimeMs(10000);
			expect(useSettingsStore.getState().totalActiveTimeMs).toBe(60000);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('totalActiveTimeMs', 60000);
		});

		it('addTotalActiveTimeMs accumulates across multiple calls', () => {
			useSettingsStore.setState({ totalActiveTimeMs: 0 });
			vi.clearAllMocks();

			useSettingsStore.getState().addTotalActiveTimeMs(5000);
			useSettingsStore.getState().addTotalActiveTimeMs(3000);
			useSettingsStore.getState().addTotalActiveTimeMs(2000);
			expect(useSettingsStore.getState().totalActiveTimeMs).toBe(10000);
		});

		it('setTotalActiveTimeMs overwrites previous value', () => {
			useSettingsStore.setState({ totalActiveTimeMs: 99999 });
			vi.clearAllMocks();

			useSettingsStore.getState().setTotalActiveTimeMs(0);
			expect(useSettingsStore.getState().totalActiveTimeMs).toBe(0);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('totalActiveTimeMs', 0);
		});
	});

	// ========================================================================
	// 6. Usage Stats Actions
	// ========================================================================

	describe('usage stats actions', () => {
		it('setUsageStats takes Math.max of each field', () => {
			useSettingsStore.setState({
				usageStats: {
					maxAgents: 5,
					maxDefinedAgents: 3,
					maxSimultaneousAutoRuns: 2,
					maxSimultaneousQueries: 4,
					maxQueueDepth: 1,
				},
			});
			vi.clearAllMocks();

			useSettingsStore.getState().setUsageStats({
				maxAgents: 3, // lower than existing
				maxDefinedAgents: 6, // higher than existing
				maxSimultaneousAutoRuns: 2,
				maxSimultaneousQueries: 4,
				maxQueueDepth: 5, // higher
			});

			const result = useSettingsStore.getState().usageStats;
			expect(result.maxAgents).toBe(5); // kept existing (higher)
			expect(result.maxDefinedAgents).toBe(6); // new value (higher)
			expect(result.maxQueueDepth).toBe(5); // new value (higher)
		});

		it('updateUsageStats only persists if values changed', () => {
			useSettingsStore.setState({
				usageStats: {
					maxAgents: 5,
					maxDefinedAgents: 3,
					maxSimultaneousAutoRuns: 2,
					maxSimultaneousQueries: 4,
					maxQueueDepth: 1,
				},
			});
			vi.clearAllMocks();

			// Pass higher value - should persist
			useSettingsStore.getState().updateUsageStats({ maxAgents: 10 });
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'usageStats',
				expect.objectContaining({ maxAgents: 10 })
			);
		});

		it('updateUsageStats does not persist when no values exceed current peaks', () => {
			useSettingsStore.setState({
				usageStats: {
					maxAgents: 5,
					maxDefinedAgents: 3,
					maxSimultaneousAutoRuns: 2,
					maxSimultaneousQueries: 4,
					maxQueueDepth: 1,
				},
			});
			vi.clearAllMocks();

			// Pass lower values - should NOT persist
			useSettingsStore.getState().updateUsageStats({ maxAgents: 2, maxQueueDepth: 0 });
			expect(window.maestro.settings.set).not.toHaveBeenCalled();

			// State still updates (keeps existing maxes)
			expect(useSettingsStore.getState().usageStats.maxAgents).toBe(5);
		});

		it('updateUsageStats handles partial updates', () => {
			useSettingsStore.setState({
				usageStats: {
					maxAgents: 5,
					maxDefinedAgents: 3,
					maxSimultaneousAutoRuns: 2,
					maxSimultaneousQueries: 4,
					maxQueueDepth: 1,
				},
			});
			vi.clearAllMocks();

			useSettingsStore.getState().updateUsageStats({ maxAgents: 8 });
			const result = useSettingsStore.getState().usageStats;
			expect(result.maxAgents).toBe(8);
			expect(result.maxDefinedAgents).toBe(3); // unchanged
		});

		it('updateUsageStats treats missing fields as 0', () => {
			useSettingsStore.setState({
				usageStats: {
					maxAgents: 5,
					maxDefinedAgents: 3,
					maxSimultaneousAutoRuns: 2,
					maxSimultaneousQueries: 4,
					maxQueueDepth: 1,
				},
			});
			vi.clearAllMocks();

			useSettingsStore.getState().updateUsageStats({});
			expect(useSettingsStore.getState().usageStats.maxAgents).toBe(5);
		});
	});

	// ========================================================================
	// 7. Auto-run Stats Actions
	// ========================================================================

	describe('auto-run stats actions', () => {
		it('setAutoRunStats directly replaces stats', () => {
			const newStats = {
				...DEFAULT_AUTO_RUN_STATS,
				totalRuns: 10,
				cumulativeTimeMs: 60000,
			};
			useSettingsStore.getState().setAutoRunStats(newStats);
			expect(useSettingsStore.getState().autoRunStats).toEqual(newStats);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('autoRunStats', newStats);
		});

		it('recordAutoRunComplete increments totalRuns', () => {
			useSettingsStore.setState({
				autoRunStats: { ...DEFAULT_AUTO_RUN_STATS, totalRuns: 5 },
			});
			vi.clearAllMocks();

			useSettingsStore.getState().recordAutoRunComplete(30000);
			expect(useSettingsStore.getState().autoRunStats.totalRuns).toBe(6);
		});

		it('recordAutoRunComplete detects new longest run record', () => {
			useSettingsStore.setState({
				autoRunStats: { ...DEFAULT_AUTO_RUN_STATS, longestRunMs: 10000 },
			});
			vi.clearAllMocks();

			const result = useSettingsStore.getState().recordAutoRunComplete(20000);
			expect(result.isNewRecord).toBe(true);
			expect(useSettingsStore.getState().autoRunStats.longestRunMs).toBe(20000);
		});

		it('recordAutoRunComplete returns isNewRecord false when not a record', () => {
			useSettingsStore.setState({
				autoRunStats: { ...DEFAULT_AUTO_RUN_STATS, longestRunMs: 50000 },
			});
			vi.clearAllMocks();

			const result = useSettingsStore.getState().recordAutoRunComplete(10000);
			expect(result.isNewRecord).toBe(false);
			expect(useSettingsStore.getState().autoRunStats.longestRunMs).toBe(50000);
		});

		it('recordAutoRunComplete does NOT add to cumulativeTimeMs (already tracked incrementally)', () => {
			useSettingsStore.setState({
				autoRunStats: { ...DEFAULT_AUTO_RUN_STATS, cumulativeTimeMs: 100000 },
			});
			vi.clearAllMocks();

			useSettingsStore.getState().recordAutoRunComplete(30000);
			// cumulativeTimeMs should remain unchanged
			expect(useSettingsStore.getState().autoRunStats.cumulativeTimeMs).toBe(100000);
		});

		it('recordAutoRunComplete detects badge level from existing cumulative time', () => {
			// Set cumulative time above 15min threshold (900000ms) but badge not yet unlocked
			useSettingsStore.setState({
				autoRunStats: {
					...DEFAULT_AUTO_RUN_STATS,
					cumulativeTimeMs: 15 * 60 * 1000, // 15 minutes
					lastBadgeUnlockLevel: 0,
				},
			});
			vi.clearAllMocks();

			const result = useSettingsStore.getState().recordAutoRunComplete(5000);
			expect(result.newBadgeLevel).toBe(1);
			expect(useSettingsStore.getState().autoRunStats.currentBadgeLevel).toBe(1);
		});

		it('updateAutoRunProgress adds delta to cumulativeTimeMs', () => {
			useSettingsStore.setState({
				autoRunStats: { ...DEFAULT_AUTO_RUN_STATS, cumulativeTimeMs: 50000 },
			});
			vi.clearAllMocks();

			useSettingsStore.getState().updateAutoRunProgress(10000);
			expect(useSettingsStore.getState().autoRunStats.cumulativeTimeMs).toBe(60000);
		});

		it('updateAutoRunProgress keeps Auto Run time out of the Cue subtotal', () => {
			useSettingsStore.setState({
				autoRunStats: { ...DEFAULT_AUTO_RUN_STATS, cumulativeTimeMs: 50000, cueTimeMs: 5000 },
			});
			vi.clearAllMocks();

			useSettingsStore.getState().updateAutoRunProgress(10000);
			expect(useSettingsStore.getState().autoRunStats.cueTimeMs).toBe(5000);
		});

		it('updateAutoRunProgress accrues Cue credit into both cumulative and Cue time', () => {
			useSettingsStore.setState({
				autoRunStats: { ...DEFAULT_AUTO_RUN_STATS, cumulativeTimeMs: 50000, cueTimeMs: 5000 },
			});
			vi.clearAllMocks();

			useSettingsStore.getState().updateAutoRunProgress(10000, 'cue');
			const stats = useSettingsStore.getState().autoRunStats;
			expect(stats.cumulativeTimeMs).toBe(60000);
			expect(stats.cueTimeMs).toBe(15000);
		});

		it('updateAutoRunProgress treats legacy stats without cueTimeMs as all Auto Run', () => {
			const { cueTimeMs: _dropped, ...legacy } = DEFAULT_AUTO_RUN_STATS;
			useSettingsStore.setState({
				autoRunStats: { ...legacy, cumulativeTimeMs: 50000 },
			});
			vi.clearAllMocks();

			useSettingsStore.getState().updateAutoRunProgress(10000, 'cue');
			expect(useSettingsStore.getState().autoRunStats.cueTimeMs).toBe(10000);
		});

		it('recordAutoRunComplete preserves the Cue subtotal', () => {
			useSettingsStore.setState({
				autoRunStats: { ...DEFAULT_AUTO_RUN_STATS, cumulativeTimeMs: 60000, cueTimeMs: 15000 },
			});
			vi.clearAllMocks();

			useSettingsStore.getState().recordAutoRunComplete(30000);
			expect(useSettingsStore.getState().autoRunStats.cueTimeMs).toBe(15000);
		});

		it('updateAutoRunProgress detects new badge level', () => {
			// Just below 15min threshold
			const justBelow15Min = 15 * 60 * 1000 - 1000;
			useSettingsStore.setState({
				autoRunStats: {
					...DEFAULT_AUTO_RUN_STATS,
					cumulativeTimeMs: justBelow15Min,
					lastBadgeUnlockLevel: 0,
				},
			});
			vi.clearAllMocks();

			const result = useSettingsStore.getState().updateAutoRunProgress(2000);
			expect(result.newBadgeLevel).toBe(1);
			expect(useSettingsStore.getState().autoRunStats.badgeHistory).toHaveLength(1);
			expect(useSettingsStore.getState().autoRunStats.badgeHistory[0].level).toBe(1);
		});

		it('updateAutoRunProgress returns isNewRecord: false', () => {
			useSettingsStore.setState({
				autoRunStats: { ...DEFAULT_AUTO_RUN_STATS, cumulativeTimeMs: 50000 },
			});
			vi.clearAllMocks();

			const result = useSettingsStore.getState().updateAutoRunProgress(10000);
			expect(result.isNewRecord).toBe(false);
		});

		it('acknowledgeBadge sets lastAcknowledgedBadgeLevel', () => {
			useSettingsStore.setState({
				autoRunStats: {
					...DEFAULT_AUTO_RUN_STATS,
					currentBadgeLevel: 3,
					lastAcknowledgedBadgeLevel: 1,
				},
			});
			vi.clearAllMocks();

			useSettingsStore.getState().acknowledgeBadge(3);
			expect(useSettingsStore.getState().autoRunStats.lastAcknowledgedBadgeLevel).toBe(3);
		});

		it('acknowledgeBadge takes Math.max to not go backwards', () => {
			useSettingsStore.setState({
				autoRunStats: {
					...DEFAULT_AUTO_RUN_STATS,
					lastAcknowledgedBadgeLevel: 5,
				},
			});
			vi.clearAllMocks();

			useSettingsStore.getState().acknowledgeBadge(3);
			expect(useSettingsStore.getState().autoRunStats.lastAcknowledgedBadgeLevel).toBe(5);
		});

		it('getUnacknowledgedBadgeLevel returns level when current > acknowledged', () => {
			useSettingsStore.setState({
				autoRunStats: {
					...DEFAULT_AUTO_RUN_STATS,
					currentBadgeLevel: 3,
					lastAcknowledgedBadgeLevel: 1,
				},
			});

			expect(useSettingsStore.getState().getUnacknowledgedBadgeLevel()).toBe(3);
		});

		it('getUnacknowledgedBadgeLevel returns null when all acknowledged', () => {
			useSettingsStore.setState({
				autoRunStats: {
					...DEFAULT_AUTO_RUN_STATS,
					currentBadgeLevel: 3,
					lastAcknowledgedBadgeLevel: 3,
				},
			});

			expect(useSettingsStore.getState().getUnacknowledgedBadgeLevel()).toBeNull();
		});
	});

	describe('getBadgeLevelForTime', () => {
		it('returns correct level for various thresholds', () => {
			const MINUTE = 60 * 1000;
			const HOUR = 60 * MINUTE;
			const DAY = 24 * HOUR;
			const WEEK = 7 * DAY;
			const MONTH = 30 * DAY;
			const YEAR = 365 * DAY;

			expect(getBadgeLevelForTime(0)).toBe(0);
			expect(getBadgeLevelForTime(14 * MINUTE)).toBe(0); // below 15min
			expect(getBadgeLevelForTime(15 * MINUTE)).toBe(1);
			expect(getBadgeLevelForTime(1 * HOUR)).toBe(2);
			expect(getBadgeLevelForTime(8 * HOUR)).toBe(3);
			expect(getBadgeLevelForTime(1 * DAY)).toBe(4);
			expect(getBadgeLevelForTime(1 * WEEK)).toBe(5);
			expect(getBadgeLevelForTime(1 * MONTH)).toBe(6);
			expect(getBadgeLevelForTime(3 * MONTH)).toBe(7);
			expect(getBadgeLevelForTime(6 * MONTH)).toBe(8);
			expect(getBadgeLevelForTime(1 * YEAR)).toBe(9);
			expect(getBadgeLevelForTime(5 * YEAR)).toBe(10);
			expect(getBadgeLevelForTime(10 * YEAR)).toBe(11);
		});
	});

	// ========================================================================
	// 8. Onboarding Stats Actions
	// ========================================================================

	describe('onboarding stats actions', () => {
		it('recordWizardStart increments count', () => {
			useSettingsStore.getState().recordWizardStart();
			expect(useSettingsStore.getState().onboardingStats.wizardStartCount).toBe(1);

			useSettingsStore.getState().recordWizardStart();
			expect(useSettingsStore.getState().onboardingStats.wizardStartCount).toBe(2);
		});

		it('recordWizardComplete updates averages, totals, and timestamp', () => {
			vi.spyOn(Date, 'now').mockReturnValue(1000000);

			useSettingsStore.getState().recordWizardComplete(5000, 10, 3, 12);

			const stats = useSettingsStore.getState().onboardingStats;
			expect(stats.wizardCompletionCount).toBe(1);
			expect(stats.totalWizardDurationMs).toBe(5000);
			expect(stats.averageWizardDurationMs).toBe(5000);
			expect(stats.lastWizardCompletedAt).toBe(1000000);
			expect(stats.totalConversationExchanges).toBe(10);
			expect(stats.totalConversationsCompleted).toBe(1);
			expect(stats.averageConversationExchanges).toBe(10);
			expect(stats.totalPhasesGenerated).toBe(3);
			expect(stats.totalTasksGenerated).toBe(12);
		});

		it('recordWizardAbandon increments count', () => {
			useSettingsStore.getState().recordWizardAbandon();
			expect(useSettingsStore.getState().onboardingStats.wizardAbandonCount).toBe(1);
		});

		it('recordWizardResume increments count', () => {
			useSettingsStore.getState().recordWizardResume();
			expect(useSettingsStore.getState().onboardingStats.wizardResumeCount).toBe(1);
		});

		it('recordTourStart increments count', () => {
			useSettingsStore.getState().recordTourStart();
			expect(useSettingsStore.getState().onboardingStats.tourStartCount).toBe(1);
		});

		it('recordTourComplete updates steps viewed and average', () => {
			useSettingsStore.getState().recordTourComplete(8);

			const stats = useSettingsStore.getState().onboardingStats;
			expect(stats.tourCompletionCount).toBe(1);
			expect(stats.tourStepsViewedTotal).toBe(8);
			expect(stats.averageTourStepsViewed).toBe(8);
		});

		it('recordTourSkip updates skip count and steps viewed', () => {
			useSettingsStore.getState().recordTourSkip(3);

			const stats = useSettingsStore.getState().onboardingStats;
			expect(stats.tourSkipCount).toBe(1);
			expect(stats.tourStepsViewedTotal).toBe(3);
			expect(stats.averageTourStepsViewed).toBe(3);
		});

		it('getOnboardingAnalytics returns correct rates', () => {
			useSettingsStore.setState({
				onboardingStats: {
					...DEFAULT_ONBOARDING_STATS,
					wizardStartCount: 10,
					wizardCompletionCount: 7,
					tourStartCount: 5,
					tourCompletionCount: 3,
					averageConversationExchanges: 8.5,
					averagePhasesPerWizard: 2.3,
				},
			});

			const analytics = useSettingsStore.getState().getOnboardingAnalytics();
			expect(analytics.wizardCompletionRate).toBe(70);
			expect(analytics.tourCompletionRate).toBe(60);
			expect(analytics.averageConversationExchanges).toBe(8.5);
			expect(analytics.averagePhasesPerWizard).toBe(2.3);
		});

		it('getOnboardingAnalytics handles zero starts (no division by zero)', () => {
			const analytics = useSettingsStore.getState().getOnboardingAnalytics();
			expect(analytics.wizardCompletionRate).toBe(0);
			expect(analytics.tourCompletionRate).toBe(0);
		});

		it('multiple wizard completions compute running averages correctly', () => {
			vi.spyOn(Date, 'now').mockReturnValue(1000000);

			useSettingsStore.getState().recordWizardComplete(4000, 8, 2, 6);
			useSettingsStore.getState().recordWizardComplete(6000, 12, 4, 18);

			const stats = useSettingsStore.getState().onboardingStats;
			expect(stats.wizardCompletionCount).toBe(2);
			expect(stats.totalWizardDurationMs).toBe(10000);
			expect(stats.averageWizardDurationMs).toBe(5000);
			expect(stats.totalConversationExchanges).toBe(20);
			expect(stats.averageConversationExchanges).toBe(10);
		});

		it('recordWizardComplete computes averagePhasesPerWizard and averageTasksPerPhase', () => {
			vi.spyOn(Date, 'now').mockReturnValue(1000000);

			useSettingsStore.getState().recordWizardComplete(5000, 10, 3, 9);

			const stats = useSettingsStore.getState().onboardingStats;
			expect(stats.averagePhasesPerWizard).toBe(3); // 3/1 = 3.0
			expect(stats.averageTasksPerPhase).toBe(3); // 9/3 = 3.0

			// Second completion
			useSettingsStore.getState().recordWizardComplete(3000, 6, 5, 25);

			const stats2 = useSettingsStore.getState().onboardingStats;
			// totalPhases = 8, completions = 2 -> 8/2 = 4.0
			expect(stats2.averagePhasesPerWizard).toBe(4);
			// totalTasks = 34, totalPhases = 8 -> 34/8 = 4.3 (rounded to 1 decimal)
			expect(stats2.averageTasksPerPhase).toBe(4.3);
		});
	});

	// ========================================================================
	// 9. Keyboard Mastery Actions
	// ========================================================================

	describe('keyboard mastery actions', () => {
		it('recordShortcutUsage adds new shortcut and returns null if no level up', () => {
			const result = useSettingsStore.getState().recordShortcutUsage('toggleSidebar');
			expect(result.newLevel).toBeNull();
			expect(useSettingsStore.getState().keyboardMasteryStats.usedShortcuts).toContain(
				'toggleSidebar'
			);
		});

		it('recordShortcutUsage skips already-tracked shortcut', () => {
			useSettingsStore.setState({
				keyboardMasteryStats: {
					...DEFAULT_KEYBOARD_MASTERY_STATS,
					usedShortcuts: ['toggleSidebar'],
				},
			});

			const result = useSettingsStore.getState().recordShortcutUsage('toggleSidebar');
			expect(result.newLevel).toBeNull();
			// Should still only have 1 entry
			expect(useSettingsStore.getState().keyboardMasteryStats.usedShortcuts).toEqual([
				'toggleSidebar',
			]);
		});

		it('recordShortcutUsage detects level-up', () => {
			// To trigger level 1 (student), we need >= 25% of total shortcuts
			// Total = DEFAULT_SHORTCUTS + TAB_SHORTCUTS + FIXED_SHORTCUTS keys
			const totalShortcuts =
				Object.keys(DEFAULT_SHORTCUTS).length + Object.keys(TAB_SHORTCUTS).length + 8; // FIXED_SHORTCUTS has 8 entries

			const needed = Math.ceil(totalShortcuts * 0.25);

			// Pre-populate with enough shortcuts to be just below level 1
			const fakeShortcuts: string[] = [];
			for (let i = 0; i < needed - 1; i++) {
				fakeShortcuts.push(`fake-shortcut-${i}`);
			}
			useSettingsStore.setState({
				keyboardMasteryStats: {
					...DEFAULT_KEYBOARD_MASTERY_STATS,
					usedShortcuts: fakeShortcuts,
					currentLevel: 0,
				},
			});

			const result = useSettingsStore
				.getState()
				.recordShortcutUsage(`shortcut-that-triggers-level-up`);

			// The new shortcut should have been added
			expect(useSettingsStore.getState().keyboardMasteryStats.usedShortcuts).toHaveLength(needed);

			// If this crossed the threshold, newLevel should be 1
			if (result.newLevel !== null) {
				expect(result.newLevel).toBeGreaterThan(0);
				expect(useSettingsStore.getState().keyboardMasteryStats.currentLevel).toBeGreaterThan(0);
			}
		});

		it('acknowledgeKeyboardMasteryLevel updates level', () => {
			useSettingsStore.setState({
				keyboardMasteryStats: {
					...DEFAULT_KEYBOARD_MASTERY_STATS,
					currentLevel: 2,
					lastAcknowledgedLevel: 0,
				},
			});

			useSettingsStore.getState().acknowledgeKeyboardMasteryLevel(2);
			expect(useSettingsStore.getState().keyboardMasteryStats.lastAcknowledgedLevel).toBe(2);
		});

		it('getUnacknowledgedKeyboardMasteryLevel returns level or null', () => {
			// Has unacknowledged level
			useSettingsStore.setState({
				keyboardMasteryStats: {
					...DEFAULT_KEYBOARD_MASTERY_STATS,
					currentLevel: 3,
					lastAcknowledgedLevel: 1,
				},
			});
			expect(useSettingsStore.getState().getUnacknowledgedKeyboardMasteryLevel()).toBe(3);

			// All acknowledged
			useSettingsStore.setState({
				keyboardMasteryStats: {
					...DEFAULT_KEYBOARD_MASTERY_STATS,
					currentLevel: 3,
					lastAcknowledgedLevel: 3,
				},
			});
			expect(useSettingsStore.getState().getUnacknowledgedKeyboardMasteryLevel()).toBeNull();
		});
	});

	// ========================================================================
	// 10. Context Management Actions
	// ========================================================================

	describe('context management actions', () => {
		it('setContextManagementSettings fully replaces settings', () => {
			const newSettings = {
				...DEFAULT_CONTEXT_MANAGEMENT_SETTINGS,
				autoGroomContexts: false,
				maxContextTokens: 50000,
			};
			useSettingsStore.getState().setContextManagementSettings(newSettings);
			expect(useSettingsStore.getState().contextManagementSettings).toEqual(newSettings);
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'contextManagementSettings',
				newSettings
			);
		});

		it('updateContextManagementSettings does partial merge', () => {
			useSettingsStore.getState().updateContextManagementSettings({
				maxContextTokens: 75000,
				contextWarningsEnabled: true,
			});

			const result = useSettingsStore.getState().contextManagementSettings;
			expect(result.maxContextTokens).toBe(75000);
			expect(result.contextWarningsEnabled).toBe(true);
			// Unchanged fields
			expect(result.autoGroomContexts).toBe(true);
			expect(result.showMergePreview).toBe(true);
		});
	});

	// ========================================================================
	// 11. loadAllSettings
	// ========================================================================

	describe('loadAllSettings', () => {
		it('loads all settings from getAll() on success', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				fontFamily: 'JetBrains Mono',
				chatFontFamily: 'Verdana',
				filePreviewFontFamily: 'Georgia',
				fileEditorFontFamily: 'Iosevka',
				fontSize: 16,
				activeThemeId: 'one-dark-pro',
				enterToSendAI: true,
			});

			await loadAllSettings();

			const state = useSettingsStore.getState();
			expect(state.settingsLoaded).toBe(true);
			expect(state.fontFamily).toBe('JetBrains Mono');
			expect(state.chatFontFamily).toBe('Verdana');
			expect(state.filePreviewFontFamily).toBe('Georgia');
			expect(state.fileEditorFontFamily).toBe('Iosevka');
			expect(state.fontSize).toBe(16);
			expect(state.activeThemeId).toBe('one-dark-pro');
			expect(state.enterToSendAI).toBe(true);
		});

		it('loads fileExplorerIconTheme when the persisted value is valid', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				fileExplorerIconTheme: 'rich' satisfies FileExplorerIconTheme,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().fileExplorerIconTheme).toBe('rich');
		});

		it('falls back to default for invalid fileExplorerIconTheme values', async () => {
			useSettingsStore.setState({ fileExplorerIconTheme: 'rich' });
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				fileExplorerIconTheme: 'neon' as any,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().fileExplorerIconTheme).toBe('default');
		});

		it('keeps edits made while a reload is in flight', async () => {
			// A reload (system resume, or another window's write) takes several IPC
			// round trips. Anything typed during that window must not be reverted to
			// the older on-disk snapshot - that loses characters and, because the
			// textarea is controlled, snaps the caret to the end of the field.
			useSettingsStore.setState({ settingsLoaded: true, conductorProfile: 'abc' });
			vi.mocked(window.maestro.settings.getAll).mockImplementation(async () => {
				useSettingsStore.getState().setConductorProfile('abcdef');
				return { conductorProfile: 'abc', fontSize: 16 };
			});

			await loadAllSettings();

			const state = useSettingsStore.getState();
			expect(state.conductorProfile).toBe('abcdef');
			// Untouched keys still load normally.
			expect(state.fontSize).toBe(16);
		});

		it('applies the disk value on the initial load even for touched keys', async () => {
			useSettingsStore.setState({ settingsLoaded: false, conductorProfile: '' });
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				conductorProfile: 'from disk',
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().conductorProfile).toBe('from disk');
		});

		describe('media player geometry', () => {
			it('restores the position and each kind width', async () => {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					mediaPlayerFloatRect: { top: 80, left: 90, widths: { audio: 420, video: 900 } },
				});

				await loadAllSettings();

				const state = useMediaPlaybackStore.getState();
				expect(state.floatPosition).toEqual({ top: 80, left: 90 });
				expect(state.floatWidths).toEqual({ audio: 420, video: 900 });
			});

			it('keeps the position from the older full-rect shape and drops its width', async () => {
				// Height is derived from the media now, and that width was saved
				// without recording which kind it belonged to.
				useMediaPlaybackStore.setState({ floatPosition: null, floatWidths: {} });
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					mediaPlayerFloatRect: { top: 10, left: 20, width: 480, height: 336 },
				});

				await loadAllSettings();

				const state = useMediaPlaybackStore.getState();
				expect(state.floatPosition).toEqual({ top: 10, left: 20 });
				expect(state.floatWidths).toEqual({});
			});
		});

		describe('media play queue', () => {
			const stored = {
				items: [
					{
						path: '/files/podcast.mp3',
						name: 'podcast.mp3',
						sessionId: 's1',
						sessionName: 'Agent One',
						kind: 'audio',
					},
					{ path: '/files/junk', name: 'junk', sessionId: 's1', kind: 'nonsense' },
				],
				activeItemId: 's1::/files/podcast.mp3',
				resumeTimes: { 's1::/files/podcast.mp3': 42, 'gone::x': 9 },
				durations: { 's1::/files/podcast.mp3': 266, 'gone::x': 30 },
			};

			it('restores the queue, the loaded item, and its position', async () => {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					mediaPlayerQueue: stored,
				});

				await loadAllSettings();

				const state = useMediaPlaybackStore.getState();
				// The malformed entry is dropped rather than handed to a media element.
				expect(state.items.map((i) => i.name)).toEqual(['podcast.mp3']);
				expect(state.activeItemId).toBe('s1::/files/podcast.mp3');
				expect(state.resumeTimes).toEqual({ 's1::/files/podcast.mp3': 42 });
				// Lengths come back too, so the queue list is not a column of `--:--`
				// until every entry has been played.
				expect(state.durations).toEqual({ 's1::/files/podcast.mp3': 266 });
			});

			it('comes back hidden and silent, so nothing plays at launch', async () => {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					mediaPlayerQueue: stored,
				});

				await loadAllSettings();

				const state = useMediaPlaybackStore.getState();
				expect(state.dismissed).toBe(true);
				expect(state.playing).toBe(false);
				expect(state.pendingAutoplay).toBe(false);
				// Dormant as well as hidden: a restored queue must not put media
				// controls in the Left Bar header at launch, when the user has not
				// played anything yet.
				expect(state.dormant).toBe(true);
				expect(selectShowNowPlayingIndicator(state)).toBe(false);
				// History is per-boot by design: a fresh session must not open onto a
				// log of last week's files.
				expect(state.history).toEqual([]);
			});

			it('ignores a stored queue with nothing usable left in it', async () => {
				useMediaPlaybackStore.setState({ items: [], activeItemId: null });
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					mediaPlayerQueue: { items: [], activeItemId: 'gone', resumeTimes: {} },
				});

				await loadAllSettings();

				expect(useMediaPlaybackStore.getState().activeItemId).toBeNull();
			});
		});

		it('uses defaults when settings are empty/undefined', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({});

			await loadAllSettings();

			const state = useSettingsStore.getState();
			expect(state.settingsLoaded).toBe(true);
			expect(state.fontFamily).toBe('Roboto Mono, Menlo, "Courier New", monospace');
			expect(state.fontSize).toBe(14);
		});

		describe('cue time backfill', () => {
			const HOUR = 60 * 60 * 1000;

			/** Let the un-awaited backfill promise chain settle. */
			const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

			it('re-attributes historical Cue credit into cueTimeMs', async () => {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					concurrentAutoRunTimeMigrationApplied: true,
					autoRunStats: { ...DEFAULT_AUTO_RUN_STATS, cumulativeTimeMs: 100 * HOUR },
				});
				(window.maestro as any).cueStats.getHistoricalConductorCredit.mockResolvedValue(25 * HOUR);

				await loadAllSettings();
				await flush();

				const stats = useSettingsStore.getState().autoRunStats;
				expect(stats.cueTimeMs).toBe(25 * HOUR);
				// Re-attribution only - the total must not grow.
				expect(stats.cumulativeTimeMs).toBe(100 * HOUR);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('cueTimeBackfillApplied', true);
			});

			it('never lets the Cue subtotal exceed the cumulative total', async () => {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					concurrentAutoRunTimeMigrationApplied: true,
					autoRunStats: { ...DEFAULT_AUTO_RUN_STATS, cumulativeTimeMs: 10 * HOUR },
				});
				(window.maestro as any).cueStats.getHistoricalConductorCredit.mockResolvedValue(50 * HOUR);

				await loadAllSettings();
				await flush();

				expect(useSettingsStore.getState().autoRunStats.cueTimeMs).toBe(10 * HOUR);
			});

			it('keeps live-accrued credit when it already exceeds the historical total', async () => {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					autoRunStats: {
						...DEFAULT_AUTO_RUN_STATS,
						cumulativeTimeMs: 100 * HOUR,
						cueTimeMs: 30 * HOUR,
					},
				});
				(window.maestro as any).cueStats.getHistoricalConductorCredit.mockResolvedValue(25 * HOUR);

				await loadAllSettings();
				await flush();

				expect(useSettingsStore.getState().autoRunStats.cueTimeMs).toBe(30 * HOUR);
			});

			it('does not run once the backfill flag is set', async () => {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					cueTimeBackfillApplied: true,
					autoRunStats: { ...DEFAULT_AUTO_RUN_STATS, cumulativeTimeMs: 100 * HOUR },
				});

				await loadAllSettings();
				await flush();

				expect(
					(window.maestro as any).cueStats.getHistoricalConductorCredit
				).not.toHaveBeenCalled();
				expect(useSettingsStore.getState().autoRunStats.cueTimeMs).toBe(0);
			});

			it('leaves the flag unset when the Cue database read fails, so it retries', async () => {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					concurrentAutoRunTimeMigrationApplied: true,
					autoRunStats: { ...DEFAULT_AUTO_RUN_STATS, cumulativeTimeMs: 100 * HOUR },
				});
				(window.maestro as any).cueStats.getHistoricalConductorCredit.mockRejectedValue(
					new Error('cue.db unavailable')
				);

				await loadAllSettings();
				await flush();

				expect(window.maestro.settings.set).not.toHaveBeenCalledWith(
					'cueTimeBackfillApplied',
					true
				);
				expect(useSettingsStore.getState().autoRunStats.cueTimeMs).toBe(0);
			});
		});

		it('loads persisted starredSessionsCollapsed into the settings store', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				starredSessionsCollapsed: true,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().starredSessionsCollapsed).toBe(true);
		});

		it('sanitizes a corrupt persisted autoRunMaxTaskDurationMin to the default (never disables the cap)', async () => {
			// A non-finite/negative stored value must NOT silently disable the
			// absolute watchdog (which would let a chatty-but-stuck task hang the run).
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				autoRunMaxTaskDurationMin: -1 as any,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().autoRunMaxTaskDurationMin).toBe(
				DEFAULT_AUTORUN_MAX_TASK_DURATION_MIN
			);
		});

		it('preserves an explicit persisted 0 (unlimited) for autoRunMaxTaskDurationMin', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				autoRunMaxTaskDurationMin: 0,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().autoRunMaxTaskDurationMin).toBe(0);
		});

		it('clamps an out-of-range persisted autoRunMaxTaskDurationMin', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				autoRunMaxTaskDurationMin: 99999,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().autoRunMaxTaskDurationMin).toBe(1440);
		});

		it('migrates existing "Unlimited" inactivity installs (0) to an unlimited absolute cap', async () => {
			// The user explicitly disabled the Auto Run watchdog by choosing Unlimited
			// inactivity and never persisted the new cap. Defaulting to 480 would
			// silently start killing their long tasks, so migrate the cap to 0 too.
			// Seed the fresh-install default so the assertion proves the migration ran.
			useSettingsStore.setState({
				autoRunMaxTaskDurationMin: DEFAULT_AUTORUN_MAX_TASK_DURATION_MIN,
			});
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				autoRunInactivityTimeoutMin: 0,
				// autoRunMaxTaskDurationMin intentionally absent (pre-feature install)
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().autoRunMaxTaskDurationMin).toBe(0);
			// One-shot: the migrated value is persisted so this branch doesn't re-run
			// on the next load (which would silently reset a cap the user set later).
			expect(window.maestro.settings.set).toHaveBeenCalledWith('autoRunMaxTaskDurationMin', 0);
		});

		it('does NOT migrate when inactivity is a normal value and the cap is unset (keeps the default)', async () => {
			// loadAllSettings only patches keys that are present, so seed the
			// fresh-install default to model a normal (non-migrating) startup.
			useSettingsStore.setState({
				autoRunMaxTaskDurationMin: DEFAULT_AUTORUN_MAX_TASK_DURATION_MIN,
			});
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				autoRunInactivityTimeoutMin: 240,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().autoRunMaxTaskDurationMin).toBe(
				DEFAULT_AUTORUN_MAX_TASK_DURATION_MIN
			);
		});

		it('hydrates persisted bookmarksCollapsed into the uiStore', async () => {
			useUIStore.setState({ bookmarksCollapsed: false });
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				bookmarksCollapsed: true,
			});

			await loadAllSettings();

			expect(useUIStore.getState().bookmarksCollapsed).toBe(true);
		});

		it('sets settingsLoaded = true on failure', async () => {
			vi.mocked(window.maestro.settings.getAll).mockRejectedValue(new Error('IPC failure'));

			await loadAllSettings();

			expect(useSettingsStore.getState().settingsLoaded).toBe(true);
		});

		it('migrates ThinkingMode boolean true to "on"', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				defaultShowThinking: true,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().defaultShowThinking).toBe('on');
		});

		it('migrates ThinkingMode boolean false to "off"', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				defaultShowThinking: false,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().defaultShowThinking).toBe('off');
		});

		it('clamps leftSidebarWidth on load', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				leftSidebarWidth: 100,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().leftSidebarWidth).toBe(256);
		});

		it('sanitizes modalSizes on load', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				modalSizes: {
					settings: { width: 900.2, height: 700.8 },
					broken: { width: -1, height: 400 },
					alsoBroken: { width: 500 },
				},
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().modalSizes).toEqual({
				settings: { width: 900, height: 701 },
			});
		});

		it('converts maxOutputLines null to Infinity', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				maxOutputLines: null,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().maxOutputLines).toBe(Infinity);
		});

		// Legacy installs persisted colorBlindMode as a string ('none' |
		// 'enabled' | 'deuteranopia' | …); a bare `as boolean` cast left
		// 'none' as a truthy string and silently forced every Usage Dashboard
		// chart onto the colorblind palette. These guard the coercion.
		it('coerces legacy colorBlindMode string "none" to false', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				colorBlindMode: 'none' as unknown as boolean,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().colorBlindMode).toBe(false);
		});

		it('coerces legacy colorBlindMode string "enabled" to true', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				colorBlindMode: 'enabled' as unknown as boolean,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().colorBlindMode).toBe(true);
		});

		it('coerces mobile colorBlindMode string "deuteranopia" to true', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				colorBlindMode: 'deuteranopia' as unknown as boolean,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().colorBlindMode).toBe(true);
		});

		it('coerces legacy colorBlindMode string "false" to false', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				colorBlindMode: 'false' as unknown as boolean,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().colorBlindMode).toBe(false);
		});

		it('passes boolean colorBlindMode through unchanged', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				colorBlindMode: true,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().colorBlindMode).toBe(true);
		});

		it('migrates shortcut Alt-key macOS special characters', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: {
					toggleSidebar: {
						id: 'toggleSidebar',
						label: 'Toggle Left Panel',
						keys: ['Alt', 'Meta', '¬'], // macOS special char for 'l'
					},
				},
			});

			await loadAllSettings();

			// The shortcut should have been migrated
			const shortcuts = useSettingsStore.getState().shortcuts;
			expect(shortcuts.toggleSidebar.keys).not.toContain('¬');
			// The migration should persist the corrected raw data
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'shortcuts',
				expect.objectContaining({
					toggleSidebar: expect.objectContaining({
						keys: ['Alt', 'Meta', 'l'],
					}),
				})
			);
		});

		it('persists the default-remap on migration so subsequent loads are stable', async () => {
			// User still has the OLD default for moveToGroup (Cmd+Shift+M).
			// The remap should (a) bump their binding to the new default, (b) persist
			// the new binding to disk so the next load does not re-trigger migration.
			// Regression test for the crash-and-relaunch loop caused by write
			// amplification: old code set needsMigration=true but wrote back the
			// unchanged keys, which the file watcher would pick up and re-trigger.
			const savedWithOldMoveToGroup = {
				moveToGroup: {
					id: 'moveToGroup',
					label: 'Move to Group',
					keys: ['Meta', 'Shift', 'm'],
				},
			};
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: savedWithOldMoveToGroup,
			});

			await loadAllSettings();

			const shortcuts = useSettingsStore.getState().shortcuts;
			expect(shortcuts.moveToGroup.keys).toEqual(['Alt', 'Meta', 'm']);
			// The persisted raw value must contain the NEW keys, otherwise the next
			// load re-detects migration and we re-enter the loop.
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'shortcuts',
				expect.objectContaining({
					moveToGroup: expect.objectContaining({
						keys: ['Alt', 'Meta', 'm'],
					}),
				})
			);

			// Simulate the re-load that the settings file watcher would trigger.
			// Feed back the value that was just persisted and confirm migration
			// does not fire a second write.
			const persistedCall = vi
				.mocked(window.maestro.settings.set)
				.mock.calls.find(([k]) => k === 'shortcuts');
			const persistedShortcuts = persistedCall?.[1] as Record<string, unknown>;
			vi.mocked(window.maestro.settings.set).mockClear();
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: persistedShortcuts,
			});

			await loadAllSettings();

			expect(
				vi.mocked(window.maestro.settings.set).mock.calls.some(([k]) => k === 'shortcuts')
			).toBe(false);
		});

		it('moves focusActiveTab off Opt+Cmd+F so cross-tab search can claim it', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: {
					focusActiveTab: {
						id: 'focusActiveTab',
						label: 'Focus Active Tab',
						keys: ['Alt', 'Meta', 'f'],
					},
				},
			});

			await loadAllSettings();

			const shortcuts = useSettingsStore.getState().shortcuts;
			expect(shortcuts.focusActiveTab.keys).toEqual(['Alt', 'Meta', 'ArrowUp']);
			// The freed combo now belongs to cross-tab message search.
			expect(shortcuts.searchAllTabs.keys).toEqual(['Alt', 'Meta', 'f']);
		});

		it('strips a persisted Cmd+Shift+Down binding and restores the bundled default', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: {
					nextUnreadTab: {
						id: 'nextUnreadTab',
						label: 'Next Unread / Draft Tab',
						keys: ['Meta', 'Shift', 'ArrowDown'],
					},
				},
			});

			await loadAllSettings();

			// Cmd+Shift+Down is select-to-end in every text field; Maestro must not
			// shadow it, so the action falls back to its own default instead.
			expect(useSettingsStore.getState().shortcuts.nextUnreadTab.keys).toEqual([
				'Alt',
				'Meta',
				'ArrowDown',
			]);
			const persisted = vi
				.mocked(window.maestro.settings.set)
				.mock.calls.find(([k]) => k === 'shortcuts')?.[1] as Record<string, { keys: string[] }>;
			expect(persisted.nextUnreadTab.keys).toEqual(['Alt', 'Meta', 'ArrowDown']);
		});

		it('strips the Windows Ctrl+Shift+Down spelling of the same reserved chord', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: {
					nextUnreadTab: {
						id: 'nextUnreadTab',
						label: 'Next Unread / Draft Tab',
						keys: ['Ctrl', 'Shift', 'ArrowDown'],
					},
				},
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().shortcuts.nextUnreadTab.keys).toEqual([
				'Alt',
				'Meta',
				'ArrowDown',
			]);
		});

		it('strips a reserved chord from tabShortcuts too, which is a separate persist key', async () => {
			// tabShortcuts runs the same migration through a second call site with
			// its own defaults table and its own settings key. A guard applied to
			// only one of the two leaves half the bindings able to shadow the OS.
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				tabShortcuts: {
					closeAllTabs: {
						id: 'closeAllTabs',
						label: 'Close All Tabs',
						keys: ['Meta', 'Shift', 'ArrowUp'],
					},
				},
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().tabShortcuts.closeAllTabs.keys).toEqual([
				'Meta',
				'Shift',
				'w',
			]);
			const persisted = vi
				.mocked(window.maestro.settings.set)
				.mock.calls.find(([k]) => k === 'tabShortcuts')?.[1] as Record<string, { keys: string[] }>;
			expect(persisted.closeAllTabs.keys).toEqual(['Meta', 'Shift', 'w']);
		});

		it('moves New Group Chat off Opt+Cmd+C and hands the combo to Concerto', async () => {
			// Without this remap the two COLLIDE: anyone who has ever opened the
			// Shortcuts tab has the whole map persisted, so New Group Chat would keep
			// Opt+Cmd+C while Concerto's new default also claimed it, and whichever
			// branch runs first in the keyboard handler would swallow the other.
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: {
					newGroupChat: {
						id: 'newGroupChat',
						label: 'New Group Chat',
						keys: ['Alt', 'Meta', 'c'],
					},
				},
			});

			await loadAllSettings();

			const shortcuts = useSettingsStore.getState().shortcuts;
			expect(shortcuts.newGroupChat.keys).toEqual(['Alt', 'Meta', 'g']);
			expect(shortcuts.toggleConcerto.keys).toEqual(['Alt', 'Meta', 'c']);
		});

		it('carries both retired Concerto bindings forward, including a skipped build', async () => {
			// The stage went bare Opt+C -> Opt+Cmd+V -> Opt+Cmd+C. A user who skipped
			// the middle build still carries the oldest default, so both are listed.
			for (const oldKeys of [
				['Alt', 'c'],
				['Alt', 'Meta', 'v'],
			]) {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					shortcuts: {
						toggleConcerto: {
							id: 'toggleConcerto',
							label: 'Show/Hide Concerto Stage',
							keys: oldKeys,
						},
					},
				});

				await loadAllSettings();

				expect(useSettingsStore.getState().shortcuts.toggleConcerto.keys).toEqual([
					'Alt',
					'Meta',
					'c',
				]);
			}
		});

		it('returns Jump to Bottom to Cmd+Shift+J from every interim binding', async () => {
			// The action went Cmd+Shift+J -> Opt+J -> Opt+Cmd+Down -> Cmd+Shift+J.
			// Both interim eras must land back on the original chord; a user who
			// skipped a build carries whichever one they last received.
			for (const oldKeys of [
				['Alt', 'j'],
				['Alt', 'Meta', 'ArrowDown'],
			]) {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					shortcuts: {
						jumpToBottom: { id: 'jumpToBottom', label: 'Jump to Bottom', keys: oldKeys },
					},
				});

				await loadAllSettings();

				expect(useSettingsStore.getState().shortcuts.jumpToBottom.keys).toEqual([
					'Meta',
					'Shift',
					'j',
				]);
			}
		});

		it('does not re-migrate Jump to Bottom once it is already on Cmd+Shift+J', async () => {
			// Cmd+Shift+J is the destination, so it must NOT appear in fromKeys -
			// remapping a chord onto itself sets needsMigration on every load and
			// re-enters the persist/file-watcher loop.
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: {
					jumpToBottom: {
						id: 'jumpToBottom',
						label: 'Jump to Bottom',
						keys: ['Meta', 'Shift', 'j'],
					},
				},
			});

			vi.mocked(window.maestro.settings.set).mockClear();
			await loadAllSettings();

			expect(useSettingsStore.getState().shortcuts.jumpToBottom.keys).toEqual([
				'Meta',
				'Shift',
				'j',
			]);
			expect(
				vi.mocked(window.maestro.settings.set).mock.calls.some(([k]) => k === 'shortcuts')
			).toBe(false);
		});

		it('gives the tiling family its Ctrl+Cmd defaults over a persisted unbound map', async () => {
			// The merge keeps a saved `keys` whenever it is PRESENT, and `[]` is
			// present. Anyone who opened Settings -> Shortcuts while these shipped
			// unbound has empty arrays on disk and would never see the new defaults.
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: {
					tileAiBelow: { id: 'tileAiBelow', label: 'Tile New AI Chat Below', keys: [] },
					tileBrowserBelow: { id: 'tileBrowserBelow', label: 'Tile New Browser Below', keys: [] },
					tileFileBelow: { id: 'tileFileBelow', label: 'Tile New File Below', keys: [] },
					tileTerminalBelow: {
						id: 'tileTerminalBelow',
						label: 'Tile New Terminal Below',
						keys: [],
					},
				},
			});

			await loadAllSettings();

			const shortcuts = useSettingsStore.getState().shortcuts;
			expect(shortcuts.tileAiBelow.keys).toEqual(['Control', 'Meta', 't']);
			expect(shortcuts.tileBrowserBelow.keys).toEqual(['Control', 'Meta', 'b']);
			expect(shortcuts.tileFileBelow.keys).toEqual(['Control', 'Meta', 'f']);
			expect(shortcuts.tileTerminalBelow.keys).toEqual(['Control', 'Meta', 'j']);
		});

		it('moves Tile New Terminal off Cmd+Shift+J so Jump to Bottom can hold it', async () => {
			// The one binding that would otherwise put two live actions on one key.
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: {
					tileTerminalBelow: {
						id: 'tileTerminalBelow',
						label: 'Tile New Terminal Below',
						keys: ['Meta', 'Shift', 'j'],
					},
				},
			});

			await loadAllSettings();

			const shortcuts = useSettingsStore.getState().shortcuts;
			expect(shortcuts.tileTerminalBelow.keys).toEqual(['Control', 'Meta', 'j']);
			expect(shortcuts.jumpToBottom.keys).toEqual(['Meta', 'Shift', 'j']);
		});

		it('leaves a user-customized New Group Chat binding alone', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: {
					newGroupChat: {
						id: 'newGroupChat',
						label: 'New Group Chat',
						keys: ['Meta', 'Shift', 'q'],
					},
				},
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().shortcuts.newGroupChat.keys).toEqual([
				'Meta',
				'Shift',
				'q',
			]);
		});

		it('leaves a user-customized focusActiveTab binding alone', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: {
					focusActiveTab: {
						id: 'focusActiveTab',
						label: 'Focus Active Tab',
						keys: ['Meta', 'Shift', 'j'],
					},
				},
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().shortcuts.focusActiveTab.keys).toEqual([
				'Meta',
				'Shift',
				'j',
			]);
		});

		it.each([
			['the original Cmd+Shift+2 default', ['Meta', 'Shift', '2']],
			['the interim Cmd+Shift+E default', ['Meta', 'Shift', 'e']],
		])('moves toggleAutoRunExpanded off %s onto Cmd+Shift+3', async (_label, fromKeys) => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: {
					toggleAutoRunExpanded: {
						id: 'toggleAutoRunExpanded',
						label: 'Auto Run Expanded Preview',
						keys: fromKeys,
					},
				},
			});

			await loadAllSettings();

			const shortcuts = useSettingsStore.getState().shortcuts;
			expect(shortcuts.toggleAutoRunExpanded.keys).toEqual(['Meta', 'Shift', '3']);
			// The freed combo now belongs to the queued-message editor.
			expect(shortcuts.editLastQueuedMessage.keys).toEqual(['Meta', 'Shift', 'e']);
		});

		it('leaves a user-customized toggleAutoRunExpanded binding alone', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: {
					toggleAutoRunExpanded: {
						id: 'toggleAutoRunExpanded',
						label: 'Auto Run Expanded Preview',
						keys: ['Meta', 'Shift', 'q'],
					},
				},
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().shortcuts.toggleAutoRunExpanded.keys).toEqual([
				'Meta',
				'Shift',
				'q',
			]);
		});

		it('merges shortcuts: preserves user keys but updates labels from defaults', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: {
					toggleSidebar: {
						id: 'toggleSidebar',
						label: 'Old Label',
						keys: ['Meta', 'b'],
					},
				},
			});

			await loadAllSettings();

			const shortcuts = useSettingsStore.getState().shortcuts;
			// User's custom keys preserved
			expect(shortcuts.toggleSidebar.keys).toEqual(['Meta', 'b']);
			// Label updated from defaults
			expect(shortcuts.toggleSidebar.label).toBe('Toggle Left Panel');
			// All default shortcuts present (merged)
			expect(Object.keys(shortcuts)).toEqual(Object.keys(DEFAULT_SHORTCUTS));
		});

		it('merges custom AI commands: preserves user commands, skips /synopsis', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				customAICommands: [
					{
						id: 'synopsis',
						command: '/synopsis',
						description: 'Old synopsis',
						prompt: 'old',
						isBuiltIn: true,
					},
					{
						id: 'custom-cmd',
						command: '/custom',
						description: 'My custom command',
						prompt: 'do something',
						isBuiltIn: false,
					},
					{
						id: 'commit',
						command: '/commit',
						description: 'User edited commit',
						prompt: 'user prompt',
						isBuiltIn: true,
					},
				],
			});

			await loadAllSettings();

			const commands = useSettingsStore.getState().customAICommands;
			// /synopsis should be filtered out
			expect(commands.find((c) => c.id === 'synopsis')).toBeUndefined();
			// Custom command preserved
			expect(commands.find((c) => c.id === 'custom-cmd')).toBeDefined();
			// Built-in commit command with user edits but isBuiltIn preserved
			const commitCmd = commands.find((c) => c.id === 'commit');
			expect(commitCmd).toBeDefined();
			expect(commitCmd!.isBuiltIn).toBe(true);
		});

		// MAESTRO-YP/YQ/YR: settings.json is user/sync/legacy editable, so the
		// persisted array is not guaranteed to be CustomAICommand[]. An entry with
		// no id cannot be edited, saved, reset or deleted (all keyed by id) and was
		// stored under the Map key `undefined`, then rendered anyway - which crashed
		// the Settings modal. Drop it during hydration instead.
		it('skips malformed customAICommands entries that have no id', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				customAICommands: [
					{
						command: '/legacy',
						description: 'Persisted before ids existed',
						prompt: 'legacy',
					},
					{ id: '', command: '/blank', description: 'Blank id', prompt: 'blank' },
					null,
					'not-an-object',
					{
						id: 'custom-cmd',
						command: '/custom',
						description: 'My custom command',
						prompt: 'do something',
						isBuiltIn: false,
					},
				],
			});

			await loadAllSettings();

			const commands = useSettingsStore.getState().customAICommands;
			// Every surviving entry is usable.
			expect(commands.every((c) => c && typeof c.id === 'string' && c.id)).toBe(true);
			expect(commands.find((c) => c?.command === '/legacy')).toBeUndefined();
			expect(commands.find((c) => c?.command === '/blank')).toBeUndefined();
			// Well-formed entries still come through, alongside the defaults.
			expect(commands.find((c) => c.id === 'custom-cmd')).toBeDefined();
			expect(commands.find((c) => c.id === 'commit')).toBeDefined();
		});

		// An id alone is not enough. The panel calls command.startsWith('/') and
		// prompt.substring(...) directly, so an entry carrying an id but missing
		// either one still crashes the Settings modal (MAESTRO-YP/YQ/YR).
		it('skips customAICommands entries whose command or prompt is unusable', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				customAICommands: [
					{ id: 'no-command', description: 'Lost its command', prompt: 'x' },
					{ id: 'no-prompt', command: '/nope', description: 'Lost its prompt' },
					{ id: 'wrong-types', command: 42, description: 'Not strings', prompt: [] },
					{
						id: 'no-description',
						command: '/keep',
						prompt: 'description is only rendered',
					},
				],
			});

			await loadAllSettings();

			const commands = useSettingsStore.getState().customAICommands;
			expect(commands.find((c) => c.id === 'no-command')).toBeUndefined();
			expect(commands.find((c) => c.id === 'no-prompt')).toBeUndefined();
			expect(commands.find((c) => c.id === 'wrong-types')).toBeUndefined();
			// A missing description is cosmetic, so the command survives with ''.
			expect(commands.find((c) => c.id === 'no-description')?.description).toBe('');
			// Nothing that survives can crash the panel's string calls.
			expect(
				commands.every((c) => typeof c.command === 'string' && typeof c.prompt === 'string')
			).toBe(true);
		});

		it('never grows cumulative auto-run time on load', async () => {
			// The removed concurrent-tallying migration added 3 hours here. Loading
			// settings must not invent time: any local growth that does not also
			// submit a leaderboard delta pushes the local total above the server's,
			// which the server can never reconcile.
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				autoRunStats: {
					...DEFAULT_AUTO_RUN_STATS,
					cumulativeTimeMs: 100000,
				},
				// Migration flag absent - the pre-fix code treated this as "apply it"
			});

			await loadAllSettings();

			const stats = useSettingsStore.getState().autoRunStats;
			expect(stats.cumulativeTimeMs).toBe(100000);
			expect(window.maestro.settings.set).not.toHaveBeenCalledWith(
				'concurrentAutoRunTimeMigrationApplied',
				true
			);
		});

		it('totalActiveTimeMs migration: copies from legacy globalStats when standalone field absent', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				globalStats: {
					totalActiveTimeMs: 60000,
				},
				// No standalone totalActiveTimeMs field
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().totalActiveTimeMs).toBe(60000);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('totalActiveTimeMs', 60000);
		});

		it('totalActiveTimeMs migration: standalone field takes precedence over legacy globalStats', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				totalActiveTimeMs: 99000,
				globalStats: {
					totalActiveTimeMs: 60000,
				},
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().totalActiveTimeMs).toBe(99000);
		});

		it('totalActiveTimeMs migration: defaults to 0 when neither source exists', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({});

			await loadAllSettings();

			expect(useSettingsStore.getState().totalActiveTimeMs).toBe(0);
		});

		it('validates documentGraphMaxNodes on load (rejects out-of-range)', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				documentGraphMaxNodes: 10, // below 50
			});

			await loadAllSettings();

			// Invalid value rejected, keeps default
			expect(useSettingsStore.getState().documentGraphMaxNodes).toBe(50);
		});

		it('validates defaultStatsTimeRange on load', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				defaultStatsTimeRange: 'invalid-range',
			});

			await loadAllSettings();

			// Invalid value rejected, keeps default
			expect(useSettingsStore.getState().defaultStatsTimeRange).toBe('week');
		});

		it('accepts quarter as valid defaultStatsTimeRange', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				defaultStatsTimeRange: 'quarter',
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().defaultStatsTimeRange).toBe('quarter');
		});

		it('validates documentGraphPreviewCharLimit on load (rejects out-of-range)', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				documentGraphPreviewCharLimit: 5000, // above 500
			});

			await loadAllSettings();

			// Invalid value rejected, keeps default
			expect(useSettingsStore.getState().documentGraphPreviewCharLimit).toBe(100);
		});

		it('validates documentGraphLayoutType on load (rejects invalid)', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				documentGraphLayoutType: 'invalid-layout',
			});

			await loadAllSettings();

			// Invalid value rejected, keeps default
			expect(useSettingsStore.getState().documentGraphLayoutType).toBe('hierarchical');
		});

		it('loads valid documentGraphLayoutType from settings', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				documentGraphLayoutType: 'force',
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().documentGraphLayoutType).toBe('force');
		});
	});

	// ========================================================================
	// 12. selectIsLeaderboardRegistered
	// ========================================================================

	describe('selectIsLeaderboardRegistered', () => {
		it('returns false when registration is null', () => {
			const state = useSettingsStore.getState() as SettingsStoreState;
			expect(selectIsLeaderboardRegistered(state)).toBe(false);
		});

		it('returns false when emailConfirmed is false', () => {
			useSettingsStore.setState({
				leaderboardRegistration: {
					email: 'test@test.com',
					emailConfirmed: false,
				} as any,
			});
			const state = useSettingsStore.getState() as SettingsStoreState;
			expect(selectIsLeaderboardRegistered(state)).toBe(false);
		});

		it('returns true when emailConfirmed is true', () => {
			useSettingsStore.setState({
				leaderboardRegistration: {
					email: 'test@test.com',
					emailConfirmed: true,
				} as any,
			});
			const state = useSettingsStore.getState() as SettingsStoreState;
			expect(selectIsLeaderboardRegistered(state)).toBe(true);
		});
	});

	// ========================================================================
	// 13. setPersistentWebLink race-condition and rollback tests
	// ========================================================================

	describe('setPersistentWebLink', () => {
		beforeEach(() => {
			useSettingsStore.setState({ persistentWebLink: false });
		});

		it('should optimistically set persistentWebLink to true and call persistCurrentToken', async () => {
			const { setPersistentWebLink } = useSettingsStore.getState();
			await setPersistentWebLink(true);

			expect(useSettingsStore.getState().persistentWebLink).toBe(true);
			expect(window.maestro.live.persistCurrentToken).toHaveBeenCalledOnce();
		});

		it('should rollback to false on soft IPC failure (result.success === false)', async () => {
			vi.mocked(window.maestro.live.persistCurrentToken).mockResolvedValueOnce({
				success: false,
				message: 'Web server is not running.',
			});

			const { setPersistentWebLink } = useSettingsStore.getState();
			await setPersistentWebLink(true);

			expect(useSettingsStore.getState().persistentWebLink).toBe(false);
		});

		it('should rollback to false on hard IPC failure (thrown exception)', async () => {
			vi.mocked(window.maestro.live.persistCurrentToken).mockRejectedValueOnce(
				new Error('IPC timeout')
			);

			const { setPersistentWebLink } = useSettingsStore.getState();
			await setPersistentWebLink(true);

			expect(useSettingsStore.getState().persistentWebLink).toBe(false);
		});

		it('should call clearPersistentToken when disabling', async () => {
			useSettingsStore.setState({ persistentWebLink: true });

			const { setPersistentWebLink } = useSettingsStore.getState();
			await setPersistentWebLink(false);

			expect(useSettingsStore.getState().persistentWebLink).toBe(false);
			expect(window.maestro.live.clearPersistentToken).toHaveBeenCalledOnce();
		});

		it('should rollback to true on clearPersistentToken hard failure (thrown exception)', async () => {
			useSettingsStore.setState({ persistentWebLink: true });
			vi.mocked(window.maestro.live.clearPersistentToken).mockRejectedValueOnce(
				new Error('IPC timeout')
			);

			const { setPersistentWebLink } = useSettingsStore.getState();
			await setPersistentWebLink(false);

			expect(useSettingsStore.getState().persistentWebLink).toBe(true);
		});

		it('should rollback to true on clearPersistentToken soft failure (result.success === false)', async () => {
			useSettingsStore.setState({ persistentWebLink: true });
			vi.mocked(window.maestro.live.clearPersistentToken).mockResolvedValueOnce({
				success: false,
				message: 'Settings write failed.',
			} as any);

			const { setPersistentWebLink } = useSettingsStore.getState();
			await setPersistentWebLink(false);

			expect(useSettingsStore.getState().persistentWebLink).toBe(true);
		});

		it('should handle rapid double-toggle (enable then disable) correctly', async () => {
			// Simulate enable call that resolves slowly
			let resolveEnable: (value: any) => void;
			const slowEnable = new Promise((resolve) => {
				resolveEnable = resolve;
			});
			vi.mocked(window.maestro.live.persistCurrentToken).mockReturnValueOnce(slowEnable as any);

			const { setPersistentWebLink } = useSettingsStore.getState();

			// Start enable (will be in-flight)
			const enablePromise = setPersistentWebLink(true);
			// Immediately disable (supersedes the enable)
			const disablePromise = setPersistentWebLink(false);

			// Resolve the slow enable after disable was called
			resolveEnable!({ success: true });

			await enablePromise;
			await disablePromise;

			// Final state should reflect the last user intent: disabled
			expect(useSettingsStore.getState().persistentWebLink).toBe(false);
			expect(window.maestro.live.clearPersistentToken).toHaveBeenCalled();
		});

		it('should handle rapid reverse toggle (disable then enable) correctly', async () => {
			// Start with enabled state
			useSettingsStore.setState({ persistentWebLink: true });

			// Simulate disable call that resolves slowly
			let resolveClear: (value: any) => void;
			const slowClear = new Promise((resolve) => {
				resolveClear = resolve;
			});
			vi.mocked(window.maestro.live.clearPersistentToken).mockReturnValueOnce(slowClear as any);

			const { setPersistentWebLink } = useSettingsStore.getState();

			// Start disable (will be in-flight)
			const disablePromise = setPersistentWebLink(false);
			// Immediately re-enable (supersedes the disable)
			const enablePromise = setPersistentWebLink(true);

			// Resolve the slow clear after enable was called
			resolveClear!({ success: true });

			await disablePromise;
			await enablePromise;

			// Final state should reflect the last user intent: enabled
			expect(useSettingsStore.getState().persistentWebLink).toBe(true);
			expect(window.maestro.live.persistCurrentToken).toHaveBeenCalled();
		});
	});

	// ========================================================================
	// 14. Non-React Access
	// ========================================================================

	describe('non-React access', () => {
		it('useSettingsStore.getState() returns current state', () => {
			useSettingsStore.setState({ fontSize: 20 });
			const state = useSettingsStore.getState();
			expect(state.fontSize).toBe(20);
		});

		it('useSettingsStore.getState() exposes action functions that work', () => {
			expect(typeof useSettingsStore.getState().setFontSize).toBe('function');

			useSettingsStore.getState().setFontSize(22);
			expect(useSettingsStore.getState().fontSize).toBe(22);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('fontSize', 22);
		});
	});

	describe('Auto Run max-task-duration helpers', () => {
		it('clamps user input: 0 stays unlimited, positive values snap into [1, 1440]', () => {
			expect(clampAutoRunMaxTaskDurationMin(0)).toBe(0);
			expect(clampAutoRunMaxTaskDurationMin(-30)).toBe(0); // user cleared / typed negative => unlimited
			expect(clampAutoRunMaxTaskDurationMin(0.4)).toBe(0); // rounds to 0
			expect(clampAutoRunMaxTaskDurationMin(30)).toBe(30);
			expect(clampAutoRunMaxTaskDurationMin(99999)).toBe(1440);
			expect(clampAutoRunMaxTaskDurationMin(0.6)).toBe(1); // rounds up, then min 1
		});

		it('sanitizes persisted values: 0 stays unlimited, corrupt values fall back to the default', () => {
			expect(sanitizeLoadedAutoRunMaxTaskDurationMin(0)).toBe(0);
			expect(sanitizeLoadedAutoRunMaxTaskDurationMin(120)).toBe(120);
			expect(sanitizeLoadedAutoRunMaxTaskDurationMin(99999)).toBe(1440);
			// Corrupt/untrustworthy: must NOT disable the cap, so fall back to default.
			expect(sanitizeLoadedAutoRunMaxTaskDurationMin(-1)).toBe(
				DEFAULT_AUTORUN_MAX_TASK_DURATION_MIN
			);
			expect(sanitizeLoadedAutoRunMaxTaskDurationMin(NaN)).toBe(
				DEFAULT_AUTORUN_MAX_TASK_DURATION_MIN
			);
			expect(sanitizeLoadedAutoRunMaxTaskDurationMin(Infinity)).toBe(
				DEFAULT_AUTORUN_MAX_TASK_DURATION_MIN
			);
			expect(sanitizeLoadedAutoRunMaxTaskDurationMin('480' as any)).toBe(
				DEFAULT_AUTORUN_MAX_TASK_DURATION_MIN
			);
			expect(sanitizeLoadedAutoRunMaxTaskDurationMin(undefined as any)).toBe(
				DEFAULT_AUTORUN_MAX_TASK_DURATION_MIN
			);
		});
	});

	// ========================================================================
	// 15. File Preview Toolbar Metadata Parity
	// ========================================================================

	// The SETTINGS_METADATA default is a plain object literal, so TypeScript
	// can't catch a key that drifts out of sync with the canonical key list the
	// way it does for the Record<FilePreviewToolbarButton, ...> maps. `editImage`
	// went missing here once already; `maestro-cli settings reset` writes this
	// literal verbatim, so a gap ships an incomplete map to disk.
	describe('filePreviewToolbarVisibility metadata parity', () => {
		it('metadata default covers exactly the canonical toolbar button keys', () => {
			const metaDefault = SETTINGS_METADATA.filePreviewToolbarVisibility.default as Record<
				string,
				boolean
			>;

			expect(Object.keys(metaDefault).sort()).toEqual([...FILE_PREVIEW_TOOLBAR_BUTTON_KEYS].sort());
		});

		it('metadata default and the store default agree on every button', () => {
			const metaDefault = SETTINGS_METADATA.filePreviewToolbarVisibility.default as Record<
				string,
				boolean
			>;

			expect(metaDefault).toEqual(DEFAULT_FILE_PREVIEW_TOOLBAR_VISIBILITY);
		});

		it('metadata description lists every toolbar button key', () => {
			const { description } = SETTINGS_METADATA.filePreviewToolbarVisibility;

			for (const key of FILE_PREVIEW_TOOLBAR_BUTTON_KEYS) {
				expect(description).toContain(key);
			}
		});
	});
});
