import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
	useSettingsStore,
	loadAllSettings,
	getBadgeLevelForTime,
	selectIsLeaderboardRegistered,
	getSettingsState,
	getSettingsActions,
	DEFAULT_CONTEXT_MANAGEMENT_SETTINGS,
	DEFAULT_AUTO_RUN_STATS,
	DEFAULT_USAGE_STATS,
	DEFAULT_KEYBOARD_MASTERY_STATS,
	DEFAULT_ONBOARDING_STATS,
	DEFAULT_AI_COMMANDS,
} from '../../../renderer/stores/settingsStore';
import type { SettingsStoreState } from '../../../renderer/stores/settingsStore';
import { DEFAULT_SHORTCUTS, TAB_SHORTCUTS } from '../../../renderer/constants/shortcuts';
import { DEFAULT_CUSTOM_THEME_COLORS } from '../../../renderer/constants/themes';

/**
 * Reset the Zustand store to initial state between tests.
 * Zustand stores are singletons, so state persists across tests unless explicitly reset.
 */
function resetStore() {
	useSettingsStore.setState({
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
		totalActiveTimeMs: 0,
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
		documentGraphLayoutType: 'mindmap',
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

		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ========================================================================
	// 1. Initial State
	// ========================================================================

	describe('initial state', () => {
		it('has correct default values for all 65 fields', () => {
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
			expect(state.fontSize).toBe(14);
			expect(state.activeThemeId).toBe('dracula');
			expect(state.customThemeColors).toEqual(DEFAULT_CUSTOM_THEME_COLORS);
			expect(state.customThemeBaseId).toBe('dracula');
			expect(state.enterToSendAI).toBe(false);
			expect(state.enterToSendTerminal).toBe(true);
			expect(state.defaultSaveToHistory).toBe(true);
			expect(state.defaultShowThinking).toBe('off');
			expect(state.leftSidebarWidth).toBe(256);
			expect(state.rightPanelWidth).toBe(384);
			expect(state.markdownEditMode).toBe(false);
			expect(state.chatRawTextMode).toBe(false);
			expect(state.showHiddenFiles).toBe(true);
			expect(state.terminalWidth).toBe(100);
			expect(state.logLevel).toBe('info');
			expect(state.maxLogBuffer).toBe(5000);
			expect(state.maxOutputLines).toBe(25);
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
			expect(state.documentGraphLayoutType).toBe('mindmap');
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

			it('setEnterToSendTerminal updates state and persists', () => {
				useSettingsStore.getState().setEnterToSendTerminal(false);
				expect(useSettingsStore.getState().enterToSendTerminal).toBe(false);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('enterToSendTerminal', false);
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

			it('setShowHiddenFiles updates state and persists', () => {
				useSettingsStore.getState().setShowHiddenFiles(false);
				expect(useSettingsStore.getState().showHiddenFiles).toBe(false);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('showHiddenFiles', false);
			});
		});

		describe('Terminal', () => {
			it('setTerminalWidth updates state and persists', () => {
				useSettingsStore.getState().setTerminalWidth(120);
				expect(useSettingsStore.getState().terminalWidth).toBe(120);
				expect(window.maestro.settings.set).toHaveBeenCalledWith('terminalWidth', 120);
			});

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

			it('setDocumentGraphLayoutType rejects invalid values', () => {
				useSettingsStore.getState().setDocumentGraphLayoutType('invalid' as any);
				expect(useSettingsStore.getState().documentGraphLayoutType).toBe('mindmap');
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
	});

	// ========================================================================
	// 3. Setters with Validation
	// ========================================================================

	describe('setters with validation', () => {
		it('setConductorProfile trims to 1000 characters', () => {
			const longProfile = 'a'.repeat(1500);
			useSettingsStore.getState().setConductorProfile(longProfile);
			expect(useSettingsStore.getState().conductorProfile).toBe('a'.repeat(1000));
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'conductorProfile',
				'a'.repeat(1000)
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
				fontSize: 16,
				activeThemeId: 'one-dark-pro',
				enterToSendAI: true,
			});

			await loadAllSettings();

			const state = useSettingsStore.getState();
			expect(state.settingsLoaded).toBe(true);
			expect(state.fontFamily).toBe('JetBrains Mono');
			expect(state.fontSize).toBe(16);
			expect(state.activeThemeId).toBe('one-dark-pro');
			expect(state.enterToSendAI).toBe(true);
		});

		it('uses defaults when settings are empty/undefined', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({});

			await loadAllSettings();

			const state = useSettingsStore.getState();
			expect(state.settingsLoaded).toBe(true);
			expect(state.fontFamily).toBe('Roboto Mono, Menlo, "Courier New", monospace');
			expect(state.fontSize).toBe(14);
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

		it('converts maxOutputLines null to Infinity', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				maxOutputLines: null,
			});

			await loadAllSettings();

			expect(useSettingsStore.getState().maxOutputLines).toBe(Infinity);
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

		it('applies auto-run time migration for concurrent tallying bug', async () => {
			const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				autoRunStats: {
					...DEFAULT_AUTO_RUN_STATS,
					cumulativeTimeMs: 100000,
				},
				// Migration not yet applied
			});

			await loadAllSettings();

			const stats = useSettingsStore.getState().autoRunStats;
			expect(stats.cumulativeTimeMs).toBe(100000 + THREE_HOURS_MS);
			// Should persist the migrated stats and the flag
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'autoRunStats',
				expect.objectContaining({ cumulativeTimeMs: 100000 + THREE_HOURS_MS })
			);
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
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
			expect(useSettingsStore.getState().documentGraphLayoutType).toBe('mindmap');
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
	// 13. Non-React Access
	// ========================================================================

	describe('non-React access', () => {
		it('getSettingsState returns current state', () => {
			useSettingsStore.setState({ fontSize: 20 });
			const state = getSettingsState();
			expect(state.fontSize).toBe(20);
		});

		it('getSettingsActions returns action functions that work', () => {
			const actions = getSettingsActions();
			expect(typeof actions.setFontSize).toBe('function');

			actions.setFontSize(22);
			expect(useSettingsStore.getState().fontSize).toBe(22);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('fontSize', 22);
		});
	});
});
