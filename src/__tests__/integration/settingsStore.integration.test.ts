import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	getSettingsActions,
	getSettingsState,
	loadAllSettings,
	selectIsLeaderboardRegistered,
	useSettingsStore,
} from '../../renderer/stores/settingsStore';
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	TAB_SHORTCUTS,
} from '../../renderer/constants/shortcuts';
import { DEFAULT_CUSTOM_THEME_COLORS } from '../../renderer/constants/themes';
import { logger } from '../../renderer/utils/logger';

const initialState = useSettingsStore.getState();
const DEFAULT_CONTEXT_MANAGEMENT_SETTINGS = JSON.parse(
	JSON.stringify(initialState.contextManagementSettings)
);
const DEFAULT_AUTO_RUN_STATS = JSON.parse(JSON.stringify(initialState.autoRunStats));
const DEFAULT_USAGE_STATS = JSON.parse(JSON.stringify(initialState.usageStats));
const DEFAULT_KEYBOARD_MASTERY_STATS = JSON.parse(
	JSON.stringify(initialState.keyboardMasteryStats)
);
const DEFAULT_ONBOARDING_STATS = JSON.parse(JSON.stringify(initialState.onboardingStats));
const DEFAULT_AI_COMMANDS = JSON.parse(JSON.stringify(initialState.customAICommands));
const DEFAULT_ENCORE_FEATURES = JSON.parse(JSON.stringify(initialState.encoreFeatures));
const DEFAULT_DIRECTOR_NOTES_SETTINGS = JSON.parse(
	JSON.stringify(initialState.directorNotesSettings)
);

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

const defaultStatePatch = { ...initialState };

function resetStore() {
	useSettingsStore.setState({
		...defaultStatePatch,
		customThemeColors: { ...DEFAULT_CUSTOM_THEME_COLORS },
		shortcuts: { ...DEFAULT_SHORTCUTS },
		tabShortcuts: { ...TAB_SHORTCUTS },
		customAICommands: [...DEFAULT_AI_COMMANDS],
		autoRunStats: { ...DEFAULT_AUTO_RUN_STATS, badgeHistory: [] },
		usageStats: { ...DEFAULT_USAGE_STATS },
		onboardingStats: { ...DEFAULT_ONBOARDING_STATS },
		contextManagementSettings: { ...DEFAULT_CONTEXT_MANAGEMENT_SETTINGS },
		keyboardMasteryStats: { ...DEFAULT_KEYBOARD_MASTERY_STATS, usedShortcuts: [] },
		localIgnorePatterns: [...initialState.localIgnorePatterns],
		logViewerSelectedLevels: [...initialState.logViewerSelectedLevels],
		symphonyRegistryUrls: [...initialState.symphonyRegistryUrls],
		filePreviewToolbarVisibility: { ...initialState.filePreviewToolbarVisibility },
		sshRemoteIgnorePatterns: ['.git', '*cache*'],
		encoreFeatures: { ...DEFAULT_ENCORE_FEATURES },
		directorNotesSettings: { ...DEFAULT_DIRECTOR_NOTES_SETTINGS },
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe('settingsStore integration', () => {
	beforeEach(() => {
		resetStore();
		vi.useRealTimers();
		vi.clearAllMocks();

		(window.maestro as any).power = {
			setEnabled: vi.fn().mockResolvedValue(undefined),
		};

		vi.mocked(window.maestro.settings.set).mockResolvedValue(undefined);
		vi.mocked(window.maestro.settings.getAll).mockResolvedValue({});
		vi.mocked(window.maestro.logger.getLogLevel).mockResolvedValue('info');
		vi.mocked(window.maestro.logger.getMaxLogBuffer).mockResolvedValue(5000);
		vi.mocked(window.maestro.logger.setLogLevel).mockResolvedValue(undefined);
		vi.mocked(window.maestro.logger.setMaxLogBuffer).mockResolvedValue(undefined);
		vi.mocked(window.maestro.live.persistCurrentToken).mockResolvedValue({ success: true });
		vi.mocked(window.maestro.live.clearPersistentToken).mockResolvedValue({ success: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('persists a representative settings session through the Electron settings bridge', () => {
		const actions = getSettingsActions();
		const themeColors = { ...DEFAULT_CUSTOM_THEME_COLORS, background: '#101010' };
		const customCommand = {
			id: 'explain',
			command: '/explain',
			description: 'Explain the current task',
			prompt: 'Explain this.',
			isBuiltIn: false,
		};
		const leaderboardRegistration = {
			email: 'integration@example.com',
			emailConfirmed: true,
			authToken: 'token',
		};

		actions.setLlmProvider('anthropic' as any);
		actions.setModelSlug('claude-opus');
		actions.setApiKey('integration-api-key-placeholder');
		actions.setDefaultShell('bash');
		actions.setCustomShellPath('/bin/fish');
		actions.setShellArgs('-l');
		actions.setShellEnvVars({ FOO: 'bar' });
		actions.setGhPath('/opt/homebrew/bin/gh');
		actions.setFontFamily('Fira Code');
		actions.setFontSize(16);
		actions.setActiveThemeId('monokai' as any);
		actions.setCustomThemeColors(themeColors);
		actions.setCustomThemeBaseId('monokai' as any);
		actions.setEnterToSendAI(true);
		actions.setEnterToSendAIExpanded(true);
		actions.setDefaultSaveToHistory(false);
		actions.setDefaultShowThinking('on');
		actions.setRightPanelWidth(520);
		actions.setMarkdownEditMode(true);
		actions.setChatRawTextMode(true);
		actions.setBionifyReadingMode(true);
		actions.setBionifyAlgorithm('1 0 2');
		actions.setShowHiddenFiles(false);
		actions.setFileExplorerIconTheme('rich');
		actions.setTerminalWidth(140);
		actions.setMaxOutputLines(Infinity);
		actions.setOsNotificationsEnabled(false);
		actions.setAudioFeedbackEnabled(true);
		actions.setAudioFeedbackCommand('afplay');
		actions.setToastDuration(8);
		actions.setCheckForUpdatesOnStartup(false);
		actions.setEnableBetaUpdates(true);
		actions.setCrashReportingEnabled(false);
		actions.setLogViewerSelectedLevels(['warn', 'error']);
		actions.setCustomAICommands([...DEFAULT_AI_COMMANDS, customCommand]);
		actions.setUngroupedCollapsed(true);
		actions.setTourCompleted(true);
		actions.setFirstAutoRunCompleted(true);
		actions.setLeaderboardRegistration(leaderboardRegistration);
		actions.setWebInterfaceUseCustomPort(true);
		actions.setColorBlindMode(true);
		actions.setDocumentGraphShowExternalLinks(true);
		actions.setStatsCollectionEnabled(false);
		actions.setDefaultStatsTimeRange('month');
		actions.setDisableGpuAcceleration(true);
		actions.setDisableConfetti(true);
		actions.setLocalIgnorePatterns(['dist', '.cache']);
		actions.setLocalHonorGitignore(false);
		actions.setSshRemoteIgnorePatterns(['.git', 'vendor']);
		actions.setSshRemoteHonorGitignore(false);
		actions.setAutomaticTabNamingEnabled(false);
		actions.setFileTabAutoRefreshEnabled(true);
		actions.setSuppressWindowsWarning(true);
		actions.setUserMessageAlignment('left');
		actions.setEncoreFeatures({ directorNotes: true });
		actions.setDirectorNotesSettings({ provider: 'codex', defaultLookbackDays: 14 });
		actions.setWakatimeApiKey('waka-key');
		actions.setWakatimeEnabled(true);
		actions.setWakatimeDetailedTracking(true);
		actions.setUseNativeTitleBar(true);
		actions.setAutoHideMenuBar(true);
		actions.setSpellCheck(true);

		const state = getSettingsState();
		expect(state.llmProvider).toBe('anthropic');
		expect(state.customThemeColors).toEqual(themeColors);
		expect(state.leaderboardRegistration).toEqual(leaderboardRegistration);
		expect(selectIsLeaderboardRegistered(state)).toBe(true);
		expect(state.encoreFeatures.directorNotes).toBe(true);
		expect(state.userMessageAlignment).toBe('left');
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'apiKey',
			'integration-api-key-placeholder'
		);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('customAICommands', [
			...DEFAULT_AI_COMMANDS,
			customCommand,
		]);
	});

	it('validates constrained settings before writing them back to persisted settings', () => {
		const actions = getSettingsActions();

		actions.setConductorProfile('a'.repeat(5200));
		actions.setLeftSidebarWidth(100);
		actions.setBionifyIntensity(Number.NaN);
		actions.setDocumentGraphMaxNodes(5000);
		actions.setDocumentGraphPreviewCharLimit(10);
		actions.setDocumentGraphLayoutType('tree' as any);
		actions.setModeratorStandingInstructions('b'.repeat(2100));

		expect(getSettingsState().conductorProfile).toHaveLength(5000);
		expect(getSettingsState().leftSidebarWidth).toBe(256);
		expect(getSettingsState().bionifyIntensity).toBe(1);
		expect(getSettingsState().documentGraphMaxNodes).toBe(1000);
		expect(getSettingsState().documentGraphPreviewCharLimit).toBe(50);
		expect(getSettingsState().documentGraphLayoutType).toBe('hierarchical');
		expect(getSettingsState().moderatorStandingInstructions).toHaveLength(2000);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('conductorProfile', 'a'.repeat(5000));
		expect(window.maestro.settings.set).toHaveBeenCalledWith('bionifyIntensity', 1);

		vi.mocked(window.maestro.settings.set).mockClear();
		actions.setWebInterfaceCustomPort(80);
		expect(getSettingsState().webInterfaceCustomPort).toBe(80);
		expect(window.maestro.settings.set).not.toHaveBeenCalledWith('webInterfaceCustomPort', 80);

		actions.setWebInterfaceCustomPort(4242);
		actions.setBionifyIntensity(2);
		actions.setDocumentGraphMaxNodes(25);
		actions.setDocumentGraphPreviewCharLimit(800);
		actions.setDocumentGraphLayoutType('radial');
		expect(getSettingsState().webInterfaceCustomPort).toBe(4242);
		expect(getSettingsState().bionifyIntensity).toBe(1.5);
		expect(getSettingsState().documentGraphMaxNodes).toBe(50);
		expect(getSettingsState().documentGraphPreviewCharLimit).toBe(500);
		expect(getSettingsState().documentGraphLayoutType).toBe('radial');
		expect(window.maestro.settings.set).toHaveBeenCalledWith('webInterfaceCustomPort', 4242);
	});

	it('persists direct collection and stats setters', () => {
		const actions = getSettingsActions();
		const shortcuts = {
			...DEFAULT_SHORTCUTS,
			agentSessions: {
				...DEFAULT_SHORTCUTS.agentSessions,
				keys: ['Meta', 'Shift', 'A'],
			},
		};
		const tabShortcuts = {
			...TAB_SHORTCUTS,
			closeTab: {
				...TAB_SHORTCUTS.closeTab,
				keys: ['Meta', 'Shift', 'W'],
			},
		};
		const customCommand = {
			id: 'explain',
			command: '/explain',
			description: 'Explain current task',
			prompt: 'Explain this task',
		};
		const onboardingStats = { ...DEFAULT_ONBOARDING_STATS, wizardStartCount: 11 };
		const contextManagementSettings = {
			...DEFAULT_CONTEXT_MANAGEMENT_SETTINGS,
			maxContextTokens: 654321,
		};
		const keyboardMasteryStats = {
			...DEFAULT_KEYBOARD_MASTERY_STATS,
			usedShortcuts: ['agentSessions'],
		};
		const autoRunStats = {
			...DEFAULT_AUTO_RUN_STATS,
			cumulativeTimeMs: 60 * 60 * 1000,
			lastBadgeUnlockLevel: 0,
			badgeHistory: [],
		};

		actions.setShortcuts(shortcuts);
		actions.setTabShortcuts(tabShortcuts);
		actions.setCustomAICommands([customCommand]);
		actions.setAutoRunStats(autoRunStats);
		actions.setOnboardingStats(onboardingStats);
		actions.setContextManagementSettings(contextManagementSettings);
		actions.setKeyboardMasteryStats(keyboardMasteryStats);
		const completion = actions.recordAutoRunComplete(90 * 1000);

		const state = getSettingsState();
		expect(state.shortcuts.agentSessions.keys).toEqual(['Meta', 'Shift', 'A']);
		expect(state.tabShortcuts.closeTab.keys).toEqual(['Meta', 'Shift', 'W']);
		expect(state.customAICommands).toEqual([customCommand]);
		expect(state.autoRunStats.currentBadgeLevel).toBe(getBadgeLevelForTime(60 * 60 * 1000));
		expect(state.autoRunStats.badgeHistory).toHaveLength(1);
		expect(state.onboardingStats.wizardStartCount).toBe(11);
		expect(state.contextManagementSettings.maxContextTokens).toBe(654321);
		expect(state.keyboardMasteryStats.usedShortcuts).toEqual(['agentSessions']);
		expect(completion).toEqual({ newBadgeLevel: 2, isNewRecord: true });
		expect(window.maestro.settings.set).toHaveBeenCalledWith('shortcuts', shortcuts);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('tabShortcuts', tabShortcuts);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('customAICommands', [customCommand]);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('autoRunStats', autoRunStats);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('onboardingStats', onboardingStats);
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'contextManagementSettings',
			contextManagementSettings
		);
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'keyboardMasteryStats',
			keyboardMasteryStats
		);
	});

	it('keeps persistent web link state consistent across success, rollback, and stale IPC completions', async () => {
		const actions = getSettingsActions();
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

		await actions.setPersistentWebLink(true);
		expect(getSettingsState().persistentWebLink).toBe(true);
		expect(window.maestro.live.persistCurrentToken).toHaveBeenCalledTimes(1);

		vi.mocked(window.maestro.live.clearPersistentToken).mockResolvedValueOnce({
			success: false,
			message: 'cannot clear',
		});
		await actions.setPersistentWebLink(false);
		expect(getSettingsState().persistentWebLink).toBe(true);
		expect(warnSpy).toHaveBeenCalledWith(
			'[Settings] Failed to clear persistent web link:',
			undefined,
			'cannot clear'
		);

		vi.mocked(window.maestro.live.persistCurrentToken).mockRejectedValueOnce(new Error('offline'));
		await actions.setPersistentWebLink(true);
		expect(getSettingsState().persistentWebLink).toBe(false);
		expect(errorSpy).toHaveBeenCalledWith(
			'[Settings] Failed to persist web link token:',
			undefined,
			expect.any(Error)
		);

		const inFlightPersist = deferred<{ success: boolean }>();
		vi.mocked(window.maestro.live.persistCurrentToken).mockReturnValueOnce(inFlightPersist.promise);
		vi.mocked(window.maestro.live.clearPersistentToken).mockResolvedValue({ success: true });

		const enable = actions.setPersistentWebLink(true);
		expect(getSettingsState().persistentWebLink).toBe(true);
		const disable = actions.setPersistentWebLink(false);
		expect(getSettingsState().persistentWebLink).toBe(false);

		await disable;
		inFlightPersist.resolve({ success: true });
		await enable;
		expect(getSettingsState().persistentWebLink).toBe(false);
		expect(window.maestro.live.clearPersistentToken).toHaveBeenCalledTimes(3);
	});

	it('covers persistent web link soft failures, stale cleanup failures, and hard clear rollback', async () => {
		const actions = getSettingsActions();
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

		vi.mocked(window.maestro.live.persistCurrentToken).mockResolvedValueOnce({
			success: false,
			message: 'cannot persist',
		});
		await actions.setPersistentWebLink(true);
		expect(getSettingsState().persistentWebLink).toBe(false);
		expect(warnSpy).toHaveBeenCalledWith(
			'[Settings] Failed to persist web link token:',
			undefined,
			'cannot persist'
		);

		const inFlightPersist = deferred<{ success: boolean }>();
		vi.mocked(window.maestro.live.persistCurrentToken).mockReturnValueOnce(inFlightPersist.promise);
		vi.mocked(window.maestro.live.clearPersistentToken)
			.mockResolvedValueOnce({ success: true })
			.mockRejectedValueOnce(new Error('stale cleanup failed'));
		const enable = actions.setPersistentWebLink(true);
		const disable = actions.setPersistentWebLink(false);
		await disable;
		inFlightPersist.resolve({ success: true });
		await enable;
		expect(errorSpy).toHaveBeenCalledWith(
			'[Settings] Failed to clear stale persistent web link:',
			undefined,
			expect.any(Error)
		);
		expect(getSettingsState().persistentWebLink).toBe(false);

		useSettingsStore.setState({ persistentWebLink: true });
		const inFlightClear = deferred<{ success: boolean }>();
		vi.mocked(window.maestro.live.clearPersistentToken).mockReturnValueOnce(inFlightClear.promise);
		vi.mocked(window.maestro.live.persistCurrentToken).mockResolvedValueOnce({ success: true });
		const staleDisable = actions.setPersistentWebLink(false);
		const freshEnable = actions.setPersistentWebLink(true);
		inFlightClear.resolve({ success: true });
		await staleDisable;
		await freshEnable;
		expect(getSettingsState().persistentWebLink).toBe(true);

		vi.mocked(window.maestro.live.clearPersistentToken).mockRejectedValueOnce(
			new Error('clear offline')
		);
		await actions.setPersistentWebLink(false);
		expect(getSettingsState().persistentWebLink).toBe(true);
		expect(errorSpy).toHaveBeenCalledWith(
			'[Settings] Failed to clear persistent web link:',
			undefined,
			expect.any(Error)
		);
	});

	it('coordinates async logger and power settings with rollback on prevent-sleep failure', async () => {
		const actions = getSettingsActions();

		await actions.setLogLevel('debug');
		await actions.setMaxLogBuffer(9000);
		await actions.setPreventSleepEnabled(true);

		expect(getSettingsState().logLevel).toBe('debug');
		expect(getSettingsState().maxLogBuffer).toBe(9000);
		expect(getSettingsState().preventSleepEnabled).toBe(true);
		expect(window.maestro.logger.setLogLevel).toHaveBeenCalledWith('debug');
		expect(window.maestro.logger.setMaxLogBuffer).toHaveBeenCalledWith(9000);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('preventSleepEnabled', true);
		expect((window.maestro as any).power.setEnabled).toHaveBeenCalledWith(true);

		(window.maestro as any).power.setEnabled.mockRejectedValueOnce(new Error('power assertion'));
		await expect(actions.setPreventSleepEnabled(false)).rejects.toThrow('power assertion');
		expect(getSettingsState().preventSleepEnabled).toBe(true);
	});

	it('records active-time, usage, auto-run, onboarding, context, and keyboard mastery workflows', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));

		const actions = getSettingsActions();
		const fifteenMinutes = 15 * 60 * 1000;

		actions.setTotalActiveTimeMs(1000);
		actions.addTotalActiveTimeMs(250);
		expect(getSettingsState().totalActiveTimeMs).toBe(1250);
		expect(getBadgeLevelForTime(fifteenMinutes)).toBe(1);

		actions.setUsageStats({
			maxAgents: 3,
			maxDefinedAgents: 4,
			maxSimultaneousAutoRuns: 1,
			maxSimultaneousQueries: 2,
			maxQueueDepth: 5,
		});
		vi.mocked(window.maestro.settings.set).mockClear();
		actions.updateUsageStats({ maxAgents: 1, maxQueueDepth: 4 });
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
		actions.updateUsageStats({ maxAgents: 8, maxSimultaneousQueries: 6 });
		expect(getSettingsState().usageStats.maxAgents).toBe(8);
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'usageStats',
			expect.objectContaining({ maxAgents: 8, maxSimultaneousQueries: 6 })
		);

		const progress = actions.updateAutoRunProgress(fifteenMinutes);
		expect(progress).toEqual({ newBadgeLevel: 1, isNewRecord: false });
		expect(actions.getUnacknowledgedBadgeLevel()).toBe(1);
		actions.acknowledgeBadge(1);
		expect(actions.getUnacknowledgedBadgeLevel()).toBeNull();
		const complete = actions.recordAutoRunComplete(fifteenMinutes * 2);
		expect(complete).toEqual({ newBadgeLevel: null, isNewRecord: true });
		expect(getSettingsState().autoRunStats.totalRuns).toBe(1);
		expect(getSettingsState().autoRunStats.longestRunTimestamp).toBe(Date.now());

		actions.recordWizardStart();
		actions.recordWizardComplete(120000, 6, 3, 12);
		actions.recordWizardAbandon();
		actions.recordWizardResume();
		actions.recordTourStart();
		actions.recordTourComplete(5);
		actions.recordTourSkip(2);
		expect(actions.getOnboardingAnalytics()).toEqual({
			wizardCompletionRate: 100,
			tourCompletionRate: 100,
			averageConversationExchanges: 6,
			averagePhasesPerWizard: 3,
		});
		expect(getSettingsState().onboardingStats.averageTasksPerPhase).toBe(4);
		expect(getSettingsState().onboardingStats.averageTourStepsViewed).toBe(3.5);

		actions.updateContextManagementSettings({
			maxContextTokens: 120000,
			contextWarningsEnabled: true,
		});
		expect(getSettingsState().contextManagementSettings).toEqual(
			expect.objectContaining({ maxContextTokens: 120000, contextWarningsEnabled: true })
		);

		const shortcutIds = [
			...Object.keys(DEFAULT_SHORTCUTS),
			...Object.keys(TAB_SHORTCUTS),
			...Object.keys(FIXED_SHORTCUTS),
		];
		const firstLevelCount = Math.ceil(shortcutIds.length * 0.25);
		let shortcutResult: { newLevel: number | null } = { newLevel: null };
		for (const shortcutId of shortcutIds.slice(0, firstLevelCount)) {
			shortcutResult = actions.recordShortcutUsage(shortcutId);
		}
		expect(shortcutResult.newLevel).toBe(1);
		expect(actions.getUnacknowledgedKeyboardMasteryLevel()).toBe(1);
		expect(actions.recordShortcutUsage(shortcutIds[0])).toEqual({ newLevel: null });
		actions.acknowledgeKeyboardMasteryLevel(1);
		expect(actions.getUnacknowledgedKeyboardMasteryLevel()).toBeNull();
	});

	it('loads persisted settings in one IPC batch and applies migrations, merges, and validation', async () => {
		const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
		const firstShortcutId = Object.keys(DEFAULT_SHORTCUTS)[0];
		const firstTabShortcutId = Object.keys(TAB_SHORTCUTS)[0];
		const savedBuiltIn = {
			...DEFAULT_AI_COMMANDS[0],
			description: 'Edited built-in command',
			prompt: 'Edited prompt',
		};
		const customCommand = {
			id: 'custom',
			command: '/custom',
			description: 'Custom command',
			prompt: 'Run custom command.',
			isBuiltIn: false,
		};

		vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
			conductorProfile: 'loaded profile',
			llmProvider: 'anthropic',
			modelSlug: 'claude-opus',
			apiKey: 'loaded-key',
			defaultShell: 'bash',
			customShellPath: '/bin/fish',
			shellArgs: '-l',
			shellEnvVars: { A: 'B' },
			ghPath: '/usr/bin/gh',
			fontFamily: 'JetBrains Mono',
			fontSize: 18,
			activeThemeId: 'monokai',
			customThemeColors: { ...DEFAULT_CUSTOM_THEME_COLORS, background: '#222222' },
			customThemeBaseId: 'dracula',
			enterToSendAI: true,
			enterToSendAIExpanded: true,
			defaultSaveToHistory: false,
			defaultShowThinking: true,
			leftSidebarWidth: 900,
			rightPanelWidth: 512,
			markdownEditMode: true,
			chatRawTextMode: true,
			bionifyReadingMode: true,
			bionifyIntensity: 2,
			bionifyAlgorithm: '2 1 0',
			showHiddenFiles: false,
			fileExplorerIconTheme: 'not-valid',
			terminalWidth: 160,
			maxOutputLines: null,
			osNotificationsEnabled: false,
			audioFeedbackEnabled: true,
			audioFeedbackCommand: 'say done',
			toastDuration: 12,
			checkForUpdatesOnStartup: false,
			enableBetaUpdates: true,
			crashReportingEnabled: false,
			logViewerSelectedLevels: ['error'],
			shortcuts: {
				[firstShortcutId]: {
					...DEFAULT_SHORTCUTS[firstShortcutId],
					keys: ['Meta', '¬'],
				},
			},
			tabShortcuts: {
				[firstTabShortcutId]: {
					...TAB_SHORTCUTS[firstTabShortcutId],
					keys: ['Alt', 'π'],
				},
			},
			customAICommands: [
				savedBuiltIn,
				{
					id: 'synopsis',
					command: '/synopsis',
					description: 'Legacy synopsis',
					prompt: 'skip me',
					isBuiltIn: true,
				},
				customCommand,
			],
			globalStats: { totalActiveTimeMs: 9876 },
			autoRunStats: { cumulativeTimeMs: 1000, totalRuns: 2 },
			usageStats: { maxAgents: 7 },
			onboardingStats: { wizardStartCount: 3 },
			contextManagementSettings: { maxContextTokens: 123456 },
			keyboardMasteryStats: { usedShortcuts: ['toggleSidebar'] },
			ungroupedCollapsed: true,
			tourCompleted: true,
			firstAutoRunCompleted: true,
			leaderboardRegistration: {
				email: 'loaded@example.com',
				emailConfirmed: true,
				authToken: 'loaded-token',
			},
			persistentWebLink: true,
			webInterfaceUseCustomPort: true,
			webInterfaceCustomPort: 7777,
			colorBlindMode: true,
			documentGraphShowExternalLinks: true,
			documentGraphMaxNodes: 25,
			documentGraphPreviewCharLimit: 900,
			documentGraphLayoutType: 'grid',
			statsCollectionEnabled: false,
			defaultStatsTimeRange: 'decade',
			preventSleepEnabled: true,
			disableGpuAcceleration: true,
			disableConfetti: true,
			localIgnorePatterns: ['vendor'],
			localHonorGitignore: false,
			sshRemoteIgnorePatterns: ['tmp'],
			sshRemoteHonorGitignore: false,
			automaticTabNamingEnabled: false,
			fileTabAutoRefreshEnabled: true,
			suppressWindowsWarning: true,
			userMessageAlignment: 'left',
			encoreFeatures: { directorNotes: true },
			directorNotesSettings: { provider: 'opencode', defaultLookbackDays: 3 },
			wakatimeApiKey: 'waka-loaded',
			wakatimeEnabled: true,
			wakatimeDetailedTracking: true,
			useNativeTitleBar: true,
			autoHideMenuBar: true,
			moderatorStandingInstructions: 'always summarize',
			spellCheck: true,
		});
		vi.mocked(window.maestro.logger.getLogLevel).mockResolvedValue('debug');
		vi.mocked(window.maestro.logger.getMaxLogBuffer).mockResolvedValue(12345);

		await loadAllSettings();

		const state = getSettingsState();
		expect(state.settingsLoaded).toBe(true);
		expect(state.defaultShowThinking).toBe('on');
		expect(state.leftSidebarWidth).toBe(600);
		expect(state.logLevel).toBe('debug');
		expect(state.maxLogBuffer).toBe(12345);
		expect(state.maxOutputLines).toBe(Infinity);
		expect(state.fileExplorerIconTheme).toBe('default');
		expect(state.bionifyIntensity).toBe(1.5);
		expect(state.shortcuts[firstShortcutId].keys).toEqual(['Meta', 'l']);
		expect(state.tabShortcuts[firstTabShortcutId].keys).toEqual(['Alt', 'p']);
		expect(state.customAICommands).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: DEFAULT_AI_COMMANDS[0].id,
					description: 'Edited built-in command',
					isBuiltIn: true,
				}),
				customCommand,
			])
		);
		expect(state.customAICommands.some((command) => command.id === 'synopsis')).toBe(false);
		expect(state.totalActiveTimeMs).toBe(9876);
		expect(state.autoRunStats.cumulativeTimeMs).toBe(3 * 60 * 60 * 1000 + 1000);
		expect(state.usageStats).toEqual(expect.objectContaining({ maxAgents: 7, maxQueueDepth: 0 }));
		expect(state.onboardingStats).toEqual(expect.objectContaining({ wizardStartCount: 3 }));
		expect(state.contextManagementSettings.maxContextTokens).toBe(123456);
		expect(state.keyboardMasteryStats.usedShortcuts).toEqual(['toggleSidebar']);
		expect(state.documentGraphMaxNodes).toBe(50);
		expect(state.documentGraphPreviewCharLimit).toBe(100);
		expect(state.documentGraphLayoutType).toBe('hierarchical');
		expect(state.defaultStatsTimeRange).toBe('week');
		expect(state.wakatimeEnabled).toBe(true);
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'shortcuts',
			expect.objectContaining({
				[firstShortcutId]: expect.objectContaining({ keys: ['Meta', 'l'] }),
			})
		);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('totalActiveTimeMs', 9876);
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'concurrentAutoRunTimeMigrationApplied',
			true
		);
		expect(logSpy).toHaveBeenCalledWith(
			'[Settings] Applied concurrent Auto Run time migration: added 3 hours to cumulative time'
		);
	});

	it('loads valid graph and stats settings from the batch IPC payload', async () => {
		vi.mocked(window.maestro.settings.getAll).mockResolvedValueOnce({
			totalActiveTimeMs: 2468,
			documentGraphMaxNodes: 250,
			documentGraphPreviewCharLimit: 320,
			documentGraphLayoutType: 'radial',
			statsCollectionEnabled: false,
			defaultStatsTimeRange: 'year',
		});

		await loadAllSettings();

		const state = getSettingsState();
		expect(state.totalActiveTimeMs).toBe(2468);
		expect(state.documentGraphMaxNodes).toBe(250);
		expect(state.documentGraphPreviewCharLimit).toBe(320);
		expect(state.documentGraphLayoutType).toBe('radial');
		expect(state.statsCollectionEnabled).toBe(false);
		expect(state.defaultStatsTimeRange).toBe('year');
	});

	it('marks settings loaded when the batch-load IPC fails', async () => {
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.settings.getAll).mockRejectedValueOnce(
			new Error('settings unavailable')
		);

		await loadAllSettings();

		expect(getSettingsState().settingsLoaded).toBe(true);
		expect(errorSpy).toHaveBeenCalledWith(
			'[Settings] Failed to load settings:',
			undefined,
			expect.any(Error)
		);
	});
});
