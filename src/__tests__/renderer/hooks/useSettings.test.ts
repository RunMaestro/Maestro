import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSettings } from '../../../renderer/hooks';
import type {
	GlobalStats,
	AutoRunStats,
	OnboardingStats,
	CustomAICommand,
} from '../../../renderer/types';
import { DEFAULT_SHORTCUTS } from '../../../renderer/constants/shortcuts';

// Helper to wait for settings to load
const waitForSettingsLoaded = async (result: { current: ReturnType<typeof useSettings> }) => {
	await waitFor(() => {
		expect(result.current.settingsLoaded).toBe(true);
	});
};

describe('useSettings', () => {
	// Save original document.documentElement.style.fontSize
	let originalFontSize: string;

	beforeEach(() => {
		vi.clearAllMocks();
		originalFontSize = document.documentElement.style.fontSize;
		// Reset all mocks to return empty/default (default behavior)
		// PERF: Implementation now uses batch loading via getAll() instead of individual get() calls
		vi.mocked(window.maestro.settings.getAll).mockResolvedValue({});
		vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);
		vi.mocked(window.maestro.logger.getLogLevel).mockResolvedValue('info');
		vi.mocked(window.maestro.logger.getMaxLogBuffer).mockResolvedValue(5000);
	});

	afterEach(() => {
		document.documentElement.style.fontSize = originalFontSize;
	});

	describe('initialization and default values', () => {
		it('should initialize with settingsLoaded=false', () => {
			const { result } = renderHook(() => useSettings());
			expect(result.current.settingsLoaded).toBe(false);
		});

		it('should set settingsLoaded=true after loading', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);
			expect(result.current.settingsLoaded).toBe(true);
		});

		it('should have correct default values for LLM settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.llmProvider).toBe('openrouter');
			expect(result.current.modelSlug).toBe('anthropic/claude-3.5-sonnet');
			expect(result.current.apiKey).toBe('');
		});

		it('should have correct default values for shell settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.defaultShell).toBe('zsh');
			expect(result.current.ghPath).toBe('');
		});

		it('should have correct default values for font settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.fontFamily).toBe('Roboto Mono, Menlo, "Courier New", monospace');
			expect(result.current.fontSize).toBe(14);
		});

		it('should have correct default values for UI settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.activeThemeId).toBe('dracula');
			expect(result.current.enterToSendAI).toBe(false);
			expect(result.current.enterToSendTerminal).toBe(true);
			expect(result.current.defaultSaveToHistory).toBe(true);
			expect(result.current.leftSidebarWidth).toBe(256);
			expect(result.current.rightPanelWidth).toBe(384);
			expect(result.current.markdownEditMode).toBe(false);
		});

		it('should have correct default values for terminal settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.terminalWidth).toBe(100);
		});

		it('should have correct default values for logging settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.logLevel).toBe('info');
			expect(result.current.maxLogBuffer).toBe(5000);
		});

		it('should have correct default values for output settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.maxOutputLines).toBe(25);
		});

		it('should have correct default values for notification settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.osNotificationsEnabled).toBe(true);
			expect(result.current.audioFeedbackEnabled).toBe(false);
			expect(result.current.audioFeedbackCommand).toBe('say');
			expect(result.current.toastDuration).toBe(20);
		});

		it('should have correct default values for log viewer settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.logViewerSelectedLevels).toEqual([
				'debug',
				'info',
				'warn',
				'error',
				'toast',
			]);
		});

		it('should have correct default values for rendering settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.disableGpuAcceleration).toBe(false);
			expect(result.current.disableConfetti).toBe(false);
		});

		it('should have default shortcuts', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.shortcuts).toEqual(DEFAULT_SHORTCUTS);
		});

		it('should have default AI commands with /commit built-in', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.customAICommands).toHaveLength(1);
			expect(result.current.customAICommands[0].id).toBe('commit');
			expect(result.current.customAICommands[0].command).toBe('/commit');
			expect(result.current.customAICommands[0].isBuiltIn).toBe(true);
		});

		it('should have default global stats (all zeros)', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.globalStats).toEqual({
				totalSessions: 0,
				totalMessages: 0,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheCreationTokens: 0,
				totalCostUsd: 0,
				totalActiveTimeMs: 0,
			});
		});

		it('should have default auto-run stats (all zeros)', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.autoRunStats).toEqual({
				cumulativeTimeMs: 0,
				longestRunMs: 0,
				longestRunTimestamp: 0,
				totalRuns: 0,
				currentBadgeLevel: 0,
				lastBadgeUnlockLevel: 0,
				lastAcknowledgedBadgeLevel: 0,
				badgeHistory: [],
			});
		});
	});

	describe('loading saved settings', () => {
		it('should load saved LLM settings', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				llmProvider: 'anthropic',
				modelSlug: 'claude-3-opus',
				apiKey: 'test-api-key',
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.llmProvider).toBe('anthropic');
			expect(result.current.modelSlug).toBe('claude-3-opus');
			expect(result.current.apiKey).toBe('test-api-key');
		});

		it('should load saved UI settings', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				activeThemeId: 'gruvbox',
				enterToSendAI: true,
				enterToSendTerminal: false,
				defaultSaveToHistory: true,
				leftSidebarWidth: 300,
				rightPanelWidth: 400,
				markdownEditMode: true,
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.activeThemeId).toBe('gruvbox');
			expect(result.current.enterToSendAI).toBe(true);
			expect(result.current.enterToSendTerminal).toBe(false);
			expect(result.current.defaultSaveToHistory).toBe(true);
			expect(result.current.leftSidebarWidth).toBe(300);
			expect(result.current.rightPanelWidth).toBe(400);
			expect(result.current.markdownEditMode).toBe(true);
		});

		it('should load saved notification settings', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				osNotificationsEnabled: false,
				audioFeedbackEnabled: true,
				audioFeedbackCommand: 'espeak',
				toastDuration: 30,
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.osNotificationsEnabled).toBe(false);
			expect(result.current.audioFeedbackEnabled).toBe(true);
			expect(result.current.audioFeedbackCommand).toBe('espeak');
			expect(result.current.toastDuration).toBe(30);
		});

		it('should merge saved shortcuts with defaults', async () => {
			const customShortcuts = {
				toggleSidebar: { id: 'toggleSidebar', label: 'Toggle Left Panel', keys: ['Meta', 'b'] },
			};

			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				shortcuts: customShortcuts,
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// Should have the custom shortcut merged with defaults
			expect(result.current.shortcuts.toggleSidebar.keys).toEqual(['Meta', 'b']);
			// Other defaults should still be present
			expect(result.current.shortcuts.toggleRightPanel).toEqual(DEFAULT_SHORTCUTS.toggleRightPanel);
		});

		it('should merge saved AI commands with defaults, preserving isBuiltIn flag', async () => {
			const savedCommands: CustomAICommand[] = [
				{
					id: 'commit',
					command: '/commit',
					description: 'Custom commit desc',
					prompt: 'custom prompt',
					isBuiltIn: false,
				},
				{ id: 'custom', command: '/custom', description: 'Custom command', prompt: 'custom' },
			];

			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				customAICommands: savedCommands,
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// Built-in command should preserve isBuiltIn=true from default
			const commitCmd = result.current.customAICommands.find((c) => c.id === 'commit');
			expect(commitCmd?.isBuiltIn).toBe(true);

			// Custom command should be included
			const customCmd = result.current.customAICommands.find((c) => c.id === 'custom');
			expect(customCmd).toBeDefined();
			expect(customCmd?.description).toBe('Custom command');
		});

		it('should filter out old /synopsis command (renamed to /history built-in)', async () => {
			// User may have old /synopsis command saved from before it was renamed to /history
			const savedCommands: CustomAICommand[] = [
				{
					id: 'synopsis',
					command: '/synopsis',
					description: 'Old synopsis command',
					prompt: 'old prompt',
				},
				{ id: 'custom', command: '/custom', description: 'Custom command', prompt: 'custom' },
			];

			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				customAICommands: savedCommands,
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// Old /synopsis command should be filtered out
			const synopsisCmd = result.current.customAICommands.find((c) => c.command === '/synopsis');
			expect(synopsisCmd).toBeUndefined();

			// Also check by id
			const synopsisCmdById = result.current.customAICommands.find((c) => c.id === 'synopsis');
			expect(synopsisCmdById).toBeUndefined();

			// Custom command should still be included
			const customCmd = result.current.customAICommands.find((c) => c.id === 'custom');
			expect(customCmd).toBeDefined();
			expect(customCmd?.description).toBe('Custom command');

			// Should still have the default /commit command
			const commitCmd = result.current.customAICommands.find((c) => c.id === 'commit');
			expect(commitCmd).toBeDefined();
		});

		it('should merge saved global stats with defaults', async () => {
			const savedStats: Partial<GlobalStats> = {
				totalSessions: 100,
				totalMessages: 500,
			};

			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				globalStats: savedStats,
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.globalStats.totalSessions).toBe(100);
			expect(result.current.globalStats.totalMessages).toBe(500);
			// Other fields should have default values
			expect(result.current.globalStats.totalInputTokens).toBe(0);
		});

		it('should merge saved auto-run stats with defaults', async () => {
			const savedStats: Partial<AutoRunStats> = {
				cumulativeTimeMs: 3600000, // 1 hour
				totalRuns: 10,
				currentBadgeLevel: 2,
			};

			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				autoRunStats: savedStats,
				concurrentAutoRunTimeMigrationApplied: true, // Skip migration in tests
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.autoRunStats.cumulativeTimeMs).toBe(3600000);
			expect(result.current.autoRunStats.totalRuns).toBe(10);
			expect(result.current.autoRunStats.currentBadgeLevel).toBe(2);
			// Other fields should have default values
			expect(result.current.autoRunStats.longestRunMs).toBe(0);
		});

		it('should load log level and max buffer from logger API', async () => {
			vi.mocked(window.maestro.logger.getLogLevel).mockResolvedValue('debug');
			vi.mocked(window.maestro.logger.getMaxLogBuffer).mockResolvedValue(10000);

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.logLevel).toBe('debug');
			expect(result.current.maxLogBuffer).toBe(10000);
		});

		it('should load rendering settings from saved values', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				disableGpuAcceleration: true,
				disableConfetti: true,
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.disableGpuAcceleration).toBe(true);
			expect(result.current.disableConfetti).toBe(true);
		});
	});

	describe('setter functions - LLM settings', () => {
		it('should update llmProvider and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setLlmProvider('anthropic');
			});

			expect(result.current.llmProvider).toBe('anthropic');
			expect(window.maestro.settings.set).toHaveBeenCalledWith('llmProvider', 'anthropic');
		});

		it('should update modelSlug and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setModelSlug('claude-3-opus');
			});

			expect(result.current.modelSlug).toBe('claude-3-opus');
			expect(window.maestro.settings.set).toHaveBeenCalledWith('modelSlug', 'claude-3-opus');
		});

		it('should update apiKey and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setApiKey('new-api-key');
			});

			expect(result.current.apiKey).toBe('new-api-key');
			expect(window.maestro.settings.set).toHaveBeenCalledWith('apiKey', 'new-api-key');
		});
	});

	describe('setter functions - shell settings', () => {
		it('should update defaultShell and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setDefaultShell('bash');
			});

			expect(result.current.defaultShell).toBe('bash');
			expect(window.maestro.settings.set).toHaveBeenCalledWith('defaultShell', 'bash');
		});

		it('should update ghPath and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setGhPath('/usr/local/bin/gh');
			});

			expect(result.current.ghPath).toBe('/usr/local/bin/gh');
			expect(window.maestro.settings.set).toHaveBeenCalledWith('ghPath', '/usr/local/bin/gh');
		});
	});

	describe('setter functions - font settings', () => {
		it('should update fontFamily and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setFontFamily('JetBrains Mono');
			});

			expect(result.current.fontFamily).toBe('JetBrains Mono');
			expect(window.maestro.settings.set).toHaveBeenCalledWith('fontFamily', 'JetBrains Mono');
		});

		it('should update fontSize and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setFontSize(16);
			});

			expect(result.current.fontSize).toBe(16);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('fontSize', 16);
		});
	});

	describe('setter functions - UI settings', () => {
		it('should update activeThemeId and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setActiveThemeId('monokai');
			});

			expect(result.current.activeThemeId).toBe('monokai');
			expect(window.maestro.settings.set).toHaveBeenCalledWith('activeThemeId', 'monokai');
		});

		it('should update enterToSendAI and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setEnterToSendAI(true);
			});

			expect(result.current.enterToSendAI).toBe(true);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('enterToSendAI', true);
		});

		it('should update enterToSendTerminal and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setEnterToSendTerminal(false);
			});

			expect(result.current.enterToSendTerminal).toBe(false);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('enterToSendTerminal', false);
		});

		it('should update defaultSaveToHistory and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setDefaultSaveToHistory(true);
			});

			expect(result.current.defaultSaveToHistory).toBe(true);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('defaultSaveToHistory', true);
		});

		it('should update leftSidebarWidth and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setLeftSidebarWidth(300);
			});

			expect(result.current.leftSidebarWidth).toBe(300);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('leftSidebarWidth', 300);
		});

		it('should update rightPanelWidth and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setRightPanelWidth(500);
			});

			expect(result.current.rightPanelWidth).toBe(500);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('rightPanelWidth', 500);
		});

		it('should update markdownEditMode and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setMarkdownEditMode(true);
			});

			expect(result.current.markdownEditMode).toBe(true);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('markdownEditMode', true);
		});
	});

	describe('setter functions - terminal settings', () => {
		it('should update terminalWidth and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setTerminalWidth(120);
			});

			expect(result.current.terminalWidth).toBe(120);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('terminalWidth', 120);
		});
	});

	describe('setter functions - logging settings', () => {
		it('should update logLevel via logger API', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			await act(async () => {
				await result.current.setLogLevel('debug');
			});

			expect(result.current.logLevel).toBe('debug');
			expect(window.maestro.logger.setLogLevel).toHaveBeenCalledWith('debug');
		});

		it('should update maxLogBuffer via logger API', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			await act(async () => {
				await result.current.setMaxLogBuffer(10000);
			});

			expect(result.current.maxLogBuffer).toBe(10000);
			expect(window.maestro.logger.setMaxLogBuffer).toHaveBeenCalledWith(10000);
		});
	});

	describe('setter functions - output settings', () => {
		it('should update maxOutputLines and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setMaxOutputLines(50);
			});

			expect(result.current.maxOutputLines).toBe(50);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('maxOutputLines', 50);
		});
	});

	describe('setter functions - notification settings', () => {
		it('should update osNotificationsEnabled and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setOsNotificationsEnabled(false);
			});

			expect(result.current.osNotificationsEnabled).toBe(false);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('osNotificationsEnabled', false);
		});

		it('should update audioFeedbackEnabled and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setAudioFeedbackEnabled(true);
			});

			expect(result.current.audioFeedbackEnabled).toBe(true);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('audioFeedbackEnabled', true);
		});

		it('should update audioFeedbackCommand and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setAudioFeedbackCommand('espeak');
			});

			expect(result.current.audioFeedbackCommand).toBe('espeak');
			expect(window.maestro.settings.set).toHaveBeenCalledWith('audioFeedbackCommand', 'espeak');
		});

		it('should update toastDuration and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setToastDuration(30);
			});

			expect(result.current.toastDuration).toBe(30);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('toastDuration', 30);
		});
	});

	describe('setter functions - log viewer settings', () => {
		it('should update logViewerSelectedLevels and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			const newLevels = ['error', 'warn'];
			act(() => {
				result.current.setLogViewerSelectedLevels(newLevels);
			});

			expect(result.current.logViewerSelectedLevels).toEqual(newLevels);
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'logViewerSelectedLevels',
				newLevels
			);
		});
	});

	describe('setter functions - shortcuts', () => {
		it('should update shortcuts and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			const newShortcuts = {
				...DEFAULT_SHORTCUTS,
				toggleSidebar: { id: 'toggleSidebar', label: 'Toggle Left Panel', keys: ['Meta', 'b'] },
			};
			act(() => {
				result.current.setShortcuts(newShortcuts);
			});

			expect(result.current.shortcuts.toggleSidebar.keys).toEqual(['Meta', 'b']);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('shortcuts', newShortcuts);
		});
	});

	describe('setter functions - custom AI commands', () => {
		it('should update customAICommands and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			const newCommands: CustomAICommand[] = [
				{ id: 'test', command: '/test', description: 'Test', prompt: 'test prompt' },
			];
			act(() => {
				result.current.setCustomAICommands(newCommands);
			});

			expect(result.current.customAICommands).toEqual(newCommands);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('customAICommands', newCommands);
		});
	});

	describe('setter functions - rendering settings', () => {
		it('should update disableGpuAcceleration and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setDisableGpuAcceleration(true);
			});

			expect(result.current.disableGpuAcceleration).toBe(true);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('disableGpuAcceleration', true);
		});

		it('should update disableConfetti and persist to settings', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.setDisableConfetti(true);
			});

			expect(result.current.disableConfetti).toBe(true);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('disableConfetti', true);
		});
	});

	describe('global stats', () => {
		it('should update globalStats with setGlobalStats', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			const newStats: GlobalStats = {
				totalSessions: 10,
				totalMessages: 100,
				totalInputTokens: 5000,
				totalOutputTokens: 3000,
				totalCacheReadTokens: 1000,
				totalCacheCreationTokens: 500,
				totalCostUsd: 1.5,
				totalActiveTimeMs: 3600000,
			};
			act(() => {
				result.current.setGlobalStats(newStats);
			});

			expect(result.current.globalStats).toEqual(newStats);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('globalStats', newStats);
		});

		it('should update globalStats incrementally with updateGlobalStats', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// First update
			act(() => {
				result.current.updateGlobalStats({
					totalSessions: 5,
					totalMessages: 20,
				});
			});

			expect(result.current.globalStats.totalSessions).toBe(5);
			expect(result.current.globalStats.totalMessages).toBe(20);
			expect(result.current.globalStats.totalInputTokens).toBe(0); // unchanged

			// Second update
			act(() => {
				result.current.updateGlobalStats({
					totalSessions: 3,
					totalInputTokens: 1000,
				});
			});

			expect(result.current.globalStats.totalSessions).toBe(8); // 5 + 3
			expect(result.current.globalStats.totalMessages).toBe(20); // unchanged
			expect(result.current.globalStats.totalInputTokens).toBe(1000);
		});

		it('should persist updated globalStats', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.updateGlobalStats({
					totalSessions: 1,
					totalCostUsd: 0.5,
				});
			});

			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'globalStats',
				expect.objectContaining({
					totalSessions: 1,
					totalCostUsd: 0.5,
				})
			);
		});
	});

	describe('auto-run stats and badges', () => {
		it('should update autoRunStats with setAutoRunStats', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			const newStats: AutoRunStats = {
				cumulativeTimeMs: 3600000,
				longestRunMs: 1800000,
				longestRunTimestamp: Date.now(),
				totalRuns: 5,
				currentBadgeLevel: 2,
				lastBadgeUnlockLevel: 2,
				lastAcknowledgedBadgeLevel: 1,
				badgeHistory: [{ level: 1, unlockedAt: Date.now() - 10000 }],
			};
			act(() => {
				result.current.setAutoRunStats(newStats);
			});

			expect(result.current.autoRunStats).toEqual(newStats);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('autoRunStats', newStats);
		});

		describe('recordAutoRunComplete', () => {
			// NOTE: recordAutoRunComplete does NOT add to cumulativeTimeMs - that's done by updateAutoRunProgress.
			// recordAutoRunComplete only checks the badge level based on existing cumulative time,
			// updates longest run, and increments totalRuns.

			it('should increment total runs but not cumulative time', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				act(() => {
					result.current.recordAutoRunComplete(600000); // 10 minutes (elapsed, not added)
				});

				// cumulativeTimeMs is NOT incremented - stays at 0
				expect(result.current.autoRunStats.cumulativeTimeMs).toBe(0);
				expect(result.current.autoRunStats.totalRuns).toBe(1);
			});

			it('should update longest run if new record', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				// First run
				act(() => {
					result.current.recordAutoRunComplete(300000); // 5 minutes
				});

				expect(result.current.autoRunStats.longestRunMs).toBe(300000);
				expect(result.current.autoRunStats.longestRunTimestamp).toBeGreaterThan(0);

				// Second run - longer (should update record)
				act(() => {
					result.current.recordAutoRunComplete(600000); // 10 minutes
				});

				expect(result.current.autoRunStats.longestRunMs).toBe(600000);
				// Timestamp should be set (can be same or greater due to fast execution)
				expect(result.current.autoRunStats.longestRunTimestamp).toBeGreaterThan(0);
				const secondTimestamp = result.current.autoRunStats.longestRunTimestamp;

				// Third run - shorter (not a new record, longestRunMs unchanged)
				act(() => {
					result.current.recordAutoRunComplete(100000); // ~1.5 minutes
				});

				expect(result.current.autoRunStats.longestRunMs).toBe(600000); // unchanged
				// Timestamp should also remain the same
				expect(result.current.autoRunStats.longestRunTimestamp).toBe(secondTimestamp);
			});

			it('should unlock badge level 1 when cumulative time already at 15 minutes', async () => {
				// Pre-load cumulative time (simulating updateAutoRunProgress having been called)
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					autoRunStats: {
						cumulativeTimeMs: 15 * 60 * 1000, // 15 minutes already accumulated
						longestRunMs: 0,
						longestRunTimestamp: 0,
						totalRuns: 0,
						currentBadgeLevel: 0,
						lastBadgeUnlockLevel: 0,
						lastAcknowledgedBadgeLevel: 0,
						badgeHistory: [],
					},
					concurrentAutoRunTimeMigrationApplied: true, // Skip migration in tests
				});

				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				act(() => {
					result.current.recordAutoRunComplete(15 * 60 * 1000); // elapsed time
				});

				expect(result.current.autoRunStats.currentBadgeLevel).toBe(1);
				expect(result.current.autoRunStats.lastBadgeUnlockLevel).toBe(1);
				// Badge history should record the unlock
				expect(result.current.autoRunStats.badgeHistory).toHaveLength(1);
				expect(result.current.autoRunStats.badgeHistory[0].level).toBe(1);
			});

			it('should unlock badge level 2 at 1 hour', async () => {
				// Pre-load with cumulative time at 1 hour
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					autoRunStats: {
						cumulativeTimeMs: 60 * 60 * 1000, // 60 minutes already accumulated
						longestRunMs: 0,
						longestRunTimestamp: 0,
						totalRuns: 0,
						currentBadgeLevel: 1,
						lastBadgeUnlockLevel: 1,
						lastAcknowledgedBadgeLevel: 0,
						badgeHistory: [{ level: 1, unlockedAt: Date.now() - 10000 }],
					},
				});

				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				act(() => {
					result.current.recordAutoRunComplete(2 * 60 * 1000); // elapsed time
				});

				expect(result.current.autoRunStats.currentBadgeLevel).toBe(2);
				expect(result.current.autoRunStats.lastBadgeUnlockLevel).toBe(2);
				// Badge history should now have 2 entries
				expect(result.current.autoRunStats.badgeHistory).toHaveLength(2);
				expect(result.current.autoRunStats.badgeHistory[1].level).toBe(2);
			});

			it('should add badge to history when new badge unlocked', async () => {
				// Pre-load with cumulative time at 15 minutes
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					autoRunStats: {
						cumulativeTimeMs: 15 * 60 * 1000, // 15 minutes already accumulated
						longestRunMs: 0,
						longestRunTimestamp: 0,
						totalRuns: 0,
						currentBadgeLevel: 0,
						lastBadgeUnlockLevel: 0,
						lastAcknowledgedBadgeLevel: 0,
						badgeHistory: [],
					},
					concurrentAutoRunTimeMigrationApplied: true, // Skip migration in tests
				});

				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				const before = Date.now();
				act(() => {
					result.current.recordAutoRunComplete(15 * 60 * 1000); // elapsed time
				});
				const after = Date.now();

				expect(result.current.autoRunStats.badgeHistory).toHaveLength(1);
				expect(result.current.autoRunStats.badgeHistory[0].level).toBe(1);
				expect(result.current.autoRunStats.badgeHistory[0].unlockedAt).toBeGreaterThanOrEqual(
					before
				);
				expect(result.current.autoRunStats.badgeHistory[0].unlockedAt).toBeLessThanOrEqual(after);
			});

			it('should persist autoRunStats after recording', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				act(() => {
					result.current.recordAutoRunComplete(600000);
				});

				// cumulativeTimeMs stays at 0 because recordAutoRunComplete doesn't add time
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'autoRunStats',
					expect.objectContaining({
						cumulativeTimeMs: 0,
						totalRuns: 1,
					})
				);
			});
		});

		describe('acknowledgeBadge', () => {
			it('should update lastAcknowledgedBadgeLevel', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				act(() => {
					result.current.acknowledgeBadge(3);
				});

				expect(result.current.autoRunStats.lastAcknowledgedBadgeLevel).toBe(3);
			});

			it('should not decrease lastAcknowledgedBadgeLevel', async () => {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					autoRunStats: {
						cumulativeTimeMs: 0,
						longestRunMs: 0,
						longestRunTimestamp: 0,
						totalRuns: 0,
						currentBadgeLevel: 5,
						lastBadgeUnlockLevel: 5,
						lastAcknowledgedBadgeLevel: 5,
						badgeHistory: [],
					},
				});

				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				act(() => {
					result.current.acknowledgeBadge(3); // Try to set lower
				});

				expect(result.current.autoRunStats.lastAcknowledgedBadgeLevel).toBe(5); // unchanged
			});

			it('should persist after acknowledgement', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				act(() => {
					result.current.acknowledgeBadge(2);
				});

				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'autoRunStats',
					expect.objectContaining({
						lastAcknowledgedBadgeLevel: 2,
					})
				);
			});
		});

		describe('getUnacknowledgedBadgeLevel', () => {
			it('should return null when no unacknowledged badges', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				expect(result.current.getUnacknowledgedBadgeLevel()).toBe(null);
			});

			it('should return current level when higher than acknowledged', async () => {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					autoRunStats: {
						cumulativeTimeMs: 3600000, // 1 hour
						longestRunMs: 0,
						longestRunTimestamp: 0,
						totalRuns: 5,
						currentBadgeLevel: 3,
						lastBadgeUnlockLevel: 3,
						lastAcknowledgedBadgeLevel: 1,
						badgeHistory: [],
					},
				});

				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				expect(result.current.getUnacknowledgedBadgeLevel()).toBe(3);
			});

			it('should return null when current equals acknowledged', async () => {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					autoRunStats: {
						cumulativeTimeMs: 3600000,
						longestRunMs: 0,
						longestRunTimestamp: 0,
						totalRuns: 5,
						currentBadgeLevel: 3,
						lastBadgeUnlockLevel: 3,
						lastAcknowledgedBadgeLevel: 3,
						badgeHistory: [],
					},
				});

				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				expect(result.current.getUnacknowledgedBadgeLevel()).toBe(null);
			});
		});
	});

	describe('getBadgeLevelForTime (internal function tested via updateAutoRunProgress)', () => {
		// These tests verify the badge level calculation through updateAutoRunProgress
		// NOTE: updateAutoRunProgress adds time to cumulativeTimeMs, while recordAutoRunComplete
		// only reads the existing cumulativeTimeMs. So we use updateAutoRunProgress to test badge levels.
		const MINUTE = 60 * 1000;
		const HOUR = 60 * MINUTE;
		const DAY = 24 * HOUR;
		const WEEK = 7 * DAY;
		const MONTH = 30 * DAY;
		const YEAR = 365 * DAY;

		it('should return level 0 for less than 15 minutes', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.updateAutoRunProgress(14 * MINUTE);
			});

			expect(result.current.autoRunStats.currentBadgeLevel).toBe(0);
		});

		it('should return level 1 for >= 15 minutes', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.updateAutoRunProgress(15 * MINUTE);
			});

			expect(result.current.autoRunStats.currentBadgeLevel).toBe(1);
		});

		it('should return level 2 for >= 1 hour', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.updateAutoRunProgress(1 * HOUR);
			});

			expect(result.current.autoRunStats.currentBadgeLevel).toBe(2);
		});

		it('should return level 3 for >= 8 hours', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.updateAutoRunProgress(8 * HOUR);
			});

			expect(result.current.autoRunStats.currentBadgeLevel).toBe(3);
		});

		it('should return level 4 for >= 1 day', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.updateAutoRunProgress(1 * DAY);
			});

			expect(result.current.autoRunStats.currentBadgeLevel).toBe(4);
		});

		it('should return level 5 for >= 1 week', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.updateAutoRunProgress(1 * WEEK);
			});

			expect(result.current.autoRunStats.currentBadgeLevel).toBe(5);
		});

		it('should return level 6 for >= 1 month', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.updateAutoRunProgress(1 * MONTH);
			});

			expect(result.current.autoRunStats.currentBadgeLevel).toBe(6);
		});

		it('should return level 7 for >= 3 months', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.updateAutoRunProgress(3 * MONTH);
			});

			expect(result.current.autoRunStats.currentBadgeLevel).toBe(7);
		});

		it('should return level 8 for >= 6 months', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.updateAutoRunProgress(6 * MONTH);
			});

			expect(result.current.autoRunStats.currentBadgeLevel).toBe(8);
		});

		it('should return level 9 for >= 1 year', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.updateAutoRunProgress(1 * YEAR);
			});

			expect(result.current.autoRunStats.currentBadgeLevel).toBe(9);
		});

		it('should return level 10 for >= 5 years', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.updateAutoRunProgress(5 * YEAR);
			});

			expect(result.current.autoRunStats.currentBadgeLevel).toBe(10);
		});

		it('should return level 11 for >= 10 years', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.updateAutoRunProgress(10 * YEAR);
			});

			expect(result.current.autoRunStats.currentBadgeLevel).toBe(11);
		});

		it('should stay at level 11 for > 10 years', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			act(() => {
				result.current.updateAutoRunProgress(20 * YEAR);
			});

			expect(result.current.autoRunStats.currentBadgeLevel).toBe(11);
		});
	});

	describe('font size effect', () => {
		it('should apply font size to document root', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// Default font size is 14
			expect(document.documentElement.style.fontSize).toBe('14px');

			act(() => {
				result.current.setFontSize(18);
			});

			expect(document.documentElement.style.fontSize).toBe('18px');
		});

		it('should apply saved font size on load', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				fontSize: 20,
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(document.documentElement.style.fontSize).toBe('20px');
		});
	});

	describe('edge cases', () => {
		it('should handle undefined values from settings.getAll gracefully', async () => {
			// All settings return empty object (uses defaults)
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// Should use defaults
			expect(result.current.llmProvider).toBe('openrouter');
			expect(result.current.activeThemeId).toBe('dracula');
		});

		it('should handle null lastAcknowledgedBadgeLevel in acknowledgeBadge', async () => {
			// Set up stats with undefined/null lastAcknowledgedBadgeLevel
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				autoRunStats: {
					cumulativeTimeMs: 0,
					longestRunMs: 0,
					longestRunTimestamp: 0,
					totalRuns: 0,
					currentBadgeLevel: 0,
					lastBadgeUnlockLevel: 0,
					// lastAcknowledgedBadgeLevel is undefined
					badgeHistory: [],
				},
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// Should not throw
			act(() => {
				result.current.acknowledgeBadge(1);
			});

			expect(result.current.autoRunStats.lastAcknowledgedBadgeLevel).toBe(1);
		});

		it('should handle null badgeHistory in updateAutoRunProgress', async () => {
			// Set up stats with undefined/null badgeHistory
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				autoRunStats: {
					cumulativeTimeMs: 14 * 60 * 1000, // Just below badge 1
					longestRunMs: 0,
					longestRunTimestamp: 0,
					totalRuns: 0,
					currentBadgeLevel: 0,
					lastBadgeUnlockLevel: 0,
					lastAcknowledgedBadgeLevel: 0,
					// badgeHistory is undefined
				},
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// Should not throw - updateAutoRunProgress adds time to cumulativeTimeMs
			act(() => {
				result.current.updateAutoRunProgress(60 * 1000); // 1 more minute = badge 1
			});

			expect(result.current.autoRunStats.badgeHistory).toHaveLength(1);
		});

		it('should handle getUnacknowledgedBadgeLevel with null lastAcknowledgedBadgeLevel', async () => {
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				autoRunStats: {
					cumulativeTimeMs: 3600000,
					longestRunMs: 0,
					longestRunTimestamp: 0,
					totalRuns: 5,
					currentBadgeLevel: 3,
					lastBadgeUnlockLevel: 3,
					// lastAcknowledgedBadgeLevel is undefined
					badgeHistory: [],
				},
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			// Should return currentBadgeLevel when lastAcknowledged is undefined/0
			expect(result.current.getUnacknowledgedBadgeLevel()).toBe(3);
		});
	});

	describe('onboarding stats', () => {
		it('should have default onboarding stats (all zeros)', async () => {
			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.onboardingStats).toEqual({
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
			});
		});

		it('should load saved onboarding stats', async () => {
			const savedStats: Partial<OnboardingStats> = {
				wizardStartCount: 5,
				wizardCompletionCount: 3,
				tourStartCount: 4,
				tourCompletionCount: 2,
			};

			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				onboardingStats: savedStats,
			});

			const { result } = renderHook(() => useSettings());
			await waitForSettingsLoaded(result);

			expect(result.current.onboardingStats.wizardStartCount).toBe(5);
			expect(result.current.onboardingStats.wizardCompletionCount).toBe(3);
			expect(result.current.onboardingStats.tourStartCount).toBe(4);
			expect(result.current.onboardingStats.tourCompletionCount).toBe(2);
			// Other fields should have default values
			expect(result.current.onboardingStats.wizardAbandonCount).toBe(0);
		});

		describe('recordWizardStart', () => {
			it('should increment wizard start count', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				act(() => {
					result.current.recordWizardStart();
				});

				expect(result.current.onboardingStats.wizardStartCount).toBe(1);
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'onboardingStats',
					expect.objectContaining({
						wizardStartCount: 1,
					})
				);
			});

			it('should increment from existing count', async () => {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					onboardingStats: { wizardStartCount: 5 },
				});

				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				act(() => {
					result.current.recordWizardStart();
				});

				expect(result.current.onboardingStats.wizardStartCount).toBe(6);
			});
		});

		describe('recordWizardComplete', () => {
			it('should update wizard completion stats correctly', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				const durationMs = 300000; // 5 minutes
				const conversationExchanges = 10;
				const phasesGenerated = 3;
				const tasksGenerated = 15;

				act(() => {
					result.current.recordWizardComplete(
						durationMs,
						conversationExchanges,
						phasesGenerated,
						tasksGenerated
					);
				});

				expect(result.current.onboardingStats.wizardCompletionCount).toBe(1);
				expect(result.current.onboardingStats.totalWizardDurationMs).toBe(300000);
				expect(result.current.onboardingStats.averageWizardDurationMs).toBe(300000);
				expect(result.current.onboardingStats.totalConversationExchanges).toBe(10);
				expect(result.current.onboardingStats.averageConversationExchanges).toBe(10);
				expect(result.current.onboardingStats.totalConversationsCompleted).toBe(1);
				expect(result.current.onboardingStats.totalPhasesGenerated).toBe(3);
				expect(result.current.onboardingStats.averagePhasesPerWizard).toBe(3);
				expect(result.current.onboardingStats.totalTasksGenerated).toBe(15);
				expect(result.current.onboardingStats.averageTasksPerPhase).toBe(5); // 15 / 3
				expect(result.current.onboardingStats.lastWizardCompletedAt).toBeGreaterThan(0);
			});

			it('should calculate averages correctly over multiple completions', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				// First completion
				act(() => {
					result.current.recordWizardComplete(300000, 10, 3, 15);
				});

				// Second completion
				act(() => {
					result.current.recordWizardComplete(600000, 20, 5, 25);
				});

				expect(result.current.onboardingStats.wizardCompletionCount).toBe(2);
				expect(result.current.onboardingStats.totalWizardDurationMs).toBe(900000); // 300000 + 600000
				expect(result.current.onboardingStats.averageWizardDurationMs).toBe(450000); // 900000 / 2
				expect(result.current.onboardingStats.totalConversationExchanges).toBe(30); // 10 + 20
				expect(result.current.onboardingStats.averageConversationExchanges).toBe(15); // 30 / 2
				expect(result.current.onboardingStats.totalPhasesGenerated).toBe(8); // 3 + 5
				expect(result.current.onboardingStats.averagePhasesPerWizard).toBe(4); // 8 / 2
				expect(result.current.onboardingStats.totalTasksGenerated).toBe(40); // 15 + 25
				expect(result.current.onboardingStats.averageTasksPerPhase).toBe(5); // 40 / 8
			});
		});

		describe('recordWizardAbandon', () => {
			it('should increment wizard abandon count', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				act(() => {
					result.current.recordWizardAbandon();
				});

				expect(result.current.onboardingStats.wizardAbandonCount).toBe(1);
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'onboardingStats',
					expect.objectContaining({
						wizardAbandonCount: 1,
					})
				);
			});
		});

		describe('recordWizardResume', () => {
			it('should increment wizard resume count', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				act(() => {
					result.current.recordWizardResume();
				});

				expect(result.current.onboardingStats.wizardResumeCount).toBe(1);
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'onboardingStats',
					expect.objectContaining({
						wizardResumeCount: 1,
					})
				);
			});
		});

		describe('recordTourStart', () => {
			it('should increment tour start count', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				act(() => {
					result.current.recordTourStart();
				});

				expect(result.current.onboardingStats.tourStartCount).toBe(1);
				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'onboardingStats',
					expect.objectContaining({
						tourStartCount: 1,
					})
				);
			});
		});

		describe('recordTourComplete', () => {
			it('should update tour completion stats correctly', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				act(() => {
					result.current.recordTourComplete(8);
				});

				expect(result.current.onboardingStats.tourCompletionCount).toBe(1);
				expect(result.current.onboardingStats.tourStepsViewedTotal).toBe(8);
				expect(result.current.onboardingStats.averageTourStepsViewed).toBe(8);
			});

			it('should calculate average steps over multiple tours', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				// First completion
				act(() => {
					result.current.recordTourComplete(8);
				});

				// Second completion
				act(() => {
					result.current.recordTourComplete(10);
				});

				expect(result.current.onboardingStats.tourCompletionCount).toBe(2);
				expect(result.current.onboardingStats.tourStepsViewedTotal).toBe(18); // 8 + 10
				expect(result.current.onboardingStats.averageTourStepsViewed).toBe(9); // 18 / 2
			});
		});

		describe('recordTourSkip', () => {
			it('should update tour skip stats correctly', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				act(() => {
					result.current.recordTourSkip(3);
				});

				expect(result.current.onboardingStats.tourSkipCount).toBe(1);
				expect(result.current.onboardingStats.tourStepsViewedTotal).toBe(3);
				expect(result.current.onboardingStats.averageTourStepsViewed).toBe(3);
			});

			it('should include skipped tours in average calculation', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				// Complete tour with 8 steps
				act(() => {
					result.current.recordTourComplete(8);
				});

				// Skip tour after 2 steps
				act(() => {
					result.current.recordTourSkip(2);
				});

				expect(result.current.onboardingStats.tourCompletionCount).toBe(1);
				expect(result.current.onboardingStats.tourSkipCount).toBe(1);
				expect(result.current.onboardingStats.tourStepsViewedTotal).toBe(10); // 8 + 2
				expect(result.current.onboardingStats.averageTourStepsViewed).toBe(5); // 10 / 2 tours
			});
		});

		describe('getOnboardingAnalytics', () => {
			it('should return 0 rates when no wizard or tour attempts', async () => {
				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				const analytics = result.current.getOnboardingAnalytics();

				expect(analytics.wizardCompletionRate).toBe(0);
				expect(analytics.tourCompletionRate).toBe(0);
				expect(analytics.averageConversationExchanges).toBe(0);
				expect(analytics.averagePhasesPerWizard).toBe(0);
			});

			it('should calculate correct completion rates', async () => {
				vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
					onboardingStats: {
						wizardStartCount: 10,
						wizardCompletionCount: 7,
						tourStartCount: 8,
						tourCompletionCount: 6,
						averageConversationExchanges: 12.5,
						averagePhasesPerWizard: 3.2,
					},
				});

				const { result } = renderHook(() => useSettings());
				await waitForSettingsLoaded(result);

				const analytics = result.current.getOnboardingAnalytics();

				expect(analytics.wizardCompletionRate).toBe(70); // 7/10 * 100
				expect(analytics.tourCompletionRate).toBe(75); // 6/8 * 100
				expect(analytics.averageConversationExchanges).toBe(12.5);
				expect(analytics.averagePhasesPerWizard).toBe(3.2);
			});
		});
	});
});
