import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	useCueSettingsState,
	useDirectorNotesAgentState,
	useWakatimeSettingsState,
} from '../../../../../../renderer/components/Settings/tabs/EncoreTab/hooks';
import { DEFAULT_CUE_SETTINGS } from '../../../../../../shared/cue';
import type { AgentConfig, DirectorNotesSettings } from '../../../../../../renderer/types';
import { useAgentConfiguration } from '../../../../../../renderer/hooks/agent/useAgentConfiguration';
import { cueService } from '../../../../../../renderer/services/cue';

vi.mock('../../../../../../renderer/services/cue', () => ({
	cueService: {
		getSettings: vi.fn(),
		saveSettings: vi.fn(),
	},
}));

vi.mock('../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen', () => ({
	AGENT_TILES: [
		{ id: 'claude-code', name: 'Claude Code', supported: true },
		{ id: 'codex', name: 'Codex', supported: true },
		{ id: 'opencode', name: 'OpenCode', supported: true },
		{ id: 'gemini-cli', name: 'Gemini CLI', supported: false },
	],
}));

vi.mock('../../../../../../renderer/hooks/agent/useAgentConfiguration', () => ({
	useAgentConfiguration: vi.fn(),
}));

const detectedAgents: AgentConfig[] = [
	{
		id: 'claude-code',
		name: 'Claude Code',
		available: true,
		path: '/usr/local/bin/claude',
		hidden: false,
	},
	{
		id: 'codex',
		name: 'Codex',
		available: true,
		path: '/usr/local/bin/codex',
		hidden: false,
	},
];

async function flushPromises() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
}

function makeAgentConfiguration(overrides: Record<string, unknown> = {}) {
	return {
		detectedAgents,
		isDetecting: false,
		detectAgents: vi.fn(),
		selectedAgent: 'claude-code',
		setSelectedAgent: vi.fn(),
		handleAgentChange: vi.fn(),
		isConfigExpanded: false,
		toggleConfigExpanded: vi.fn(),
		customPath: '',
		setCustomPath: vi.fn(),
		customArgs: '',
		setCustomArgs: vi.fn(),
		customEnvVars: {},
		setCustomEnvVars: vi.fn(),
		enableMaestroP: false,
		setEnableMaestroP: vi.fn(),
		maestroPMode: 'dynamic',
		setMaestroPMode: vi.fn(),
		maestroPPath: '',
		setMaestroPPath: vi.fn(),
		agentConfig: {},
		setAgentConfig: vi.fn(),
		agentConfigRef: { current: {} },
		availableModels: [],
		loadingModels: false,
		refreshModels: vi.fn(),
		dynamicOptions: {},
		loadingDynamicOptions: false,
		refreshingAgent: false,
		refreshAgent: vi.fn(),
		sshRemotes: [],
		sshRemoteConfig: undefined,
		setSshRemoteConfig: vi.fn(),
		loadAgentConfig: vi.fn(),
		saveAgentConfig: vi.fn().mockResolvedValue(true),
		resetState: vi.fn(),
		hasCustomization: false,
		...overrides,
	} as any;
}

describe('EncoreTab hooks', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		vi.mocked(window.maestro.wakatime.checkCli).mockResolvedValue({ available: true });
		vi.mocked(window.maestro.wakatime.validateApiKey).mockResolvedValue({ valid: true });
		vi.mocked(cueService.getSettings).mockResolvedValue(DEFAULT_CUE_SETTINGS);
		vi.mocked(cueService.saveSettings).mockResolvedValue({ writtenRoots: ['/repo'] });
		vi.mocked(useAgentConfiguration).mockReturnValue(makeAgentConfiguration());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('useWakatimeSettingsState', () => {
		it('checks CLI availability and retries once when unavailable', async () => {
			vi.mocked(window.maestro.wakatime.checkCli)
				.mockResolvedValueOnce({ available: false })
				.mockResolvedValueOnce({ available: true, version: '1.2.3' });

			const { result } = renderHook(() =>
				useWakatimeSettingsState({
					isOpen: true,
					wakatimeEnabled: true,
					wakatimeApiKey: '',
					setWakatimeApiKey: vi.fn(),
				})
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(result.current.wakatimeCliStatus).toEqual({ available: false });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});

			expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(2);
			expect(result.current.wakatimeCliStatus).toEqual({ available: true, version: '1.2.3' });
		});

		it('cancels pending CLI retries on cleanup', async () => {
			vi.mocked(window.maestro.wakatime.checkCli).mockResolvedValue({ available: false });

			const { unmount } = renderHook(() =>
				useWakatimeSettingsState({
					isOpen: true,
					wakatimeEnabled: true,
					wakatimeApiKey: '',
					setWakatimeApiKey: vi.fn(),
				})
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			unmount();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});

			expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(1);
		});

		it('validates API keys and records success', async () => {
			vi.mocked(window.maestro.wakatime.validateApiKey).mockResolvedValue({ valid: true });
			const { result } = renderHook(() =>
				useWakatimeSettingsState({
					isOpen: true,
					wakatimeEnabled: true,
					wakatimeApiKey: 'waka_valid',
					setWakatimeApiKey: vi.fn(),
				})
			);

			act(() => {
				result.current.validateWakatimeApiKey();
			});
			expect(result.current.wakatimeKeyValidating).toBe(true);

			await flushPromises();
			expect(window.maestro.wakatime.validateApiKey).toHaveBeenCalledWith('waka_valid');
			expect(result.current.wakatimeKeyValidating).toBe(false);
			expect(result.current.wakatimeKeyValid).toBe(true);
		});

		it('ignores stale API key validation results after the key changes', async () => {
			let resolveValidation: (value: { valid: boolean }) => void;
			vi.mocked(window.maestro.wakatime.validateApiKey).mockReturnValue(
				new Promise((resolve) => {
					resolveValidation = resolve;
				})
			);
			let apiKey = 'waka_old';
			const setApiKey = vi.fn((value: string) => {
				apiKey = value;
			});
			const { result, rerender } = renderHook(
				({ keyValue }) =>
					useWakatimeSettingsState({
						isOpen: true,
						wakatimeEnabled: true,
						wakatimeApiKey: keyValue,
						setWakatimeApiKey: setApiKey,
					}),
				{ initialProps: { keyValue: apiKey } }
			);

			act(() => {
				result.current.validateWakatimeApiKey();
			});
			act(() => {
				result.current.handleWakatimeApiKeyChange('waka_new');
			});
			rerender({ keyValue: apiKey });

			await act(async () => {
				resolveValidation!({ valid: true });
				await vi.advanceTimersByTimeAsync(0);
			});

			expect(result.current.wakatimeKeyValid).toBeNull();
			expect(result.current.wakatimeKeyValidating).toBe(false);
		});
	});

	describe('useCueSettingsState', () => {
		it('loads Cue settings only when the tab is open and Cue is enabled', async () => {
			vi.mocked(cueService.getSettings).mockResolvedValue({ max_concurrent: 3 } as any);
			const { result } = renderHook(() =>
				useCueSettingsState({ isOpen: true, maestroCueEnabled: true })
			);

			await flushPromises();

			expect(result.current.cueSettingsLoaded).toBe(true);
			expect(cueService.getSettings).toHaveBeenCalledTimes(1);
			expect(result.current.cueSettings).toEqual({
				...DEFAULT_CUE_SETTINGS,
				max_concurrent: 3,
			});
			expect(result.current.cueQueueSizeStr).toBe(String(DEFAULT_CUE_SETTINGS.queue_size));
		});

		it('skips Cue setting load while hidden or disabled', () => {
			renderHook(() => useCueSettingsState({ isOpen: false, maestroCueEnabled: true }));
			renderHook(() => useCueSettingsState({ isOpen: true, maestroCueEnabled: false }));

			expect(cueService.getSettings).not.toHaveBeenCalled();
		});

		it('debounces Cue saves and reports saved state', async () => {
			const { result } = renderHook(() =>
				useCueSettingsState({ isOpen: true, maestroCueEnabled: true })
			);
			await flushPromises();
			expect(result.current.cueSettingsLoaded).toBe(true);

			act(() => {
				result.current.handleMaxConcurrentChange('5');
			});

			expect(result.current.cueSettings.max_concurrent).toBe(5);
			expect(cueService.saveSettings).not.toHaveBeenCalled();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(400);
			});

			expect(result.current.cueSettingsSaveState).toBe('saved');
			expect(cueService.saveSettings).toHaveBeenCalledWith({
				...DEFAULT_CUE_SETTINGS,
				max_concurrent: 5,
			});
		});

		it('flushes pending Cue saves when Settings closes before the debounce fires', async () => {
			const { result, rerender } = renderHook(
				({ isOpen, maestroCueEnabled }) => useCueSettingsState({ isOpen, maestroCueEnabled }),
				{ initialProps: { isOpen: true, maestroCueEnabled: true } }
			);
			await flushPromises();
			expect(result.current.cueSettingsLoaded).toBe(true);

			act(() => {
				result.current.handleMaxConcurrentChange('6');
			});
			expect(cueService.saveSettings).not.toHaveBeenCalled();

			rerender({ isOpen: false, maestroCueEnabled: true });
			await flushPromises();

			expect(cueService.saveSettings).toHaveBeenCalledTimes(1);
			expect(cueService.saveSettings).toHaveBeenCalledWith({
				...DEFAULT_CUE_SETTINGS,
				max_concurrent: 6,
			});

			await act(async () => {
				await vi.advanceTimersByTimeAsync(400);
			});
			expect(cueService.saveSettings).toHaveBeenCalledTimes(1);
		});

		it('reports no-targets and error save states', async () => {
			vi.mocked(cueService.saveSettings).mockResolvedValueOnce({ writtenRoots: [] });
			const noTargets = renderHook(() =>
				useCueSettingsState({ isOpen: true, maestroCueEnabled: true })
			);
			await flushPromises();
			expect(noTargets.result.current.cueSettingsLoaded).toBe(true);

			act(() => {
				noTargets.result.current.handleTimeoutMinutesChange('45');
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(400);
			});
			expect(noTargets.result.current.cueSettingsSaveState).toBe('no-targets');
			noTargets.unmount();

			vi.mocked(cueService.saveSettings).mockRejectedValueOnce(new Error('disk failed'));
			const failed = renderHook(() =>
				useCueSettingsState({ isOpen: true, maestroCueEnabled: true })
			);
			await flushPromises();
			expect(failed.result.current.cueSettingsLoaded).toBe(true);

			act(() => {
				failed.result.current.handleTimeoutOnFailChange('continue');
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(400);
			});
			expect(failed.result.current.cueSettingsSaveState).toBe('error');
		});

		it('lets the queue size field clear while keeping numeric settings clamped', async () => {
			const { result } = renderHook(() =>
				useCueSettingsState({ isOpen: true, maestroCueEnabled: true })
			);
			await flushPromises();
			expect(result.current.cueSettingsLoaded).toBe(true);

			act(() => {
				result.current.handleQueueSizeChange('');
			});
			expect(result.current.cueQueueSizeStr).toBe('');
			expect(result.current.cueSettings.queue_size).toBe(0);

			act(() => {
				result.current.handleQueueSizeBlur();
			});
			expect(result.current.cueQueueSizeStr).toBe('0');

			act(() => {
				result.current.handleQueueSizeChange('12000');
			});
			expect(result.current.cueSettings.queue_size).toBe(10000);
		});
	});

	describe('useDirectorNotesAgentState', () => {
		const directorNotesSettings: DirectorNotesSettings = {
			provider: 'claude-code',
			defaultLookbackDays: 7,
		};

		it('filters detected supported agents into available tiles', () => {
			vi.mocked(useAgentConfiguration).mockReturnValue(
				makeAgentConfiguration({
					detectedAgents: [
						...detectedAgents,
						{ id: 'opencode', name: 'OpenCode', available: false, hidden: false },
					],
				})
			);

			const { result } = renderHook(() =>
				useDirectorNotesAgentState({
					isOpen: true,
					directorNotesEnabled: true,
					directorNotesSettings,
					setDirectorNotesSettings: vi.fn(),
				})
			);

			expect(result.current.availableTiles.map((tile) => tile.id)).toEqual([
				'claude-code',
				'codex',
				'opencode',
			]);
			expect(result.current.selectedAgentConfig?.id).toBe('claude-code');
			expect(result.current.selectedTile?.name).toBe('Claude Code');
		});

		it('resets custom config when the synopsis provider changes', () => {
			const handleAgentChange = vi.fn();
			vi.mocked(useAgentConfiguration).mockReturnValue(
				makeAgentConfiguration({ handleAgentChange })
			);
			const setDirectorNotesSettings = vi.fn();
			const { result } = renderHook(() =>
				useDirectorNotesAgentState({
					isOpen: true,
					directorNotesEnabled: true,
					directorNotesSettings: {
						...directorNotesSettings,
						customPath: '/custom/claude',
						customArgs: '--verbose',
						customEnvVars: { FOO: 'bar' },
					},
					setDirectorNotesSettings,
				})
			);

			act(() => {
				result.current.handleAgentChange('codex');
			});

			expect(setDirectorNotesSettings).toHaveBeenCalledWith({
				provider: 'codex',
				defaultLookbackDays: 7,
				customPath: undefined,
				customArgs: undefined,
				customEnvVars: undefined,
			});
			expect(handleAgentChange).toHaveBeenCalledWith('codex');
		});

		it('persists custom path, args, and env vars on blur', () => {
			const setDirectorNotesSettings = vi.fn();
			vi.mocked(useAgentConfiguration).mockReturnValue(
				makeAgentConfiguration({
					customPath: '/custom/claude',
					customArgs: '--print',
					customEnvVars: { NODE_ENV: 'test' },
				})
			);
			const { result } = renderHook(() =>
				useDirectorNotesAgentState({
					isOpen: true,
					directorNotesEnabled: true,
					directorNotesSettings,
					setDirectorNotesSettings,
				})
			);

			act(() => {
				result.current.persistCustomConfig();
			});

			expect(setDirectorNotesSettings).toHaveBeenCalledWith({
				provider: 'claude-code',
				defaultLookbackDays: 7,
				customPath: '/custom/claude',
				customArgs: '--print',
				customEnvVars: { NODE_ENV: 'test' },
			});
		});

		it('wires env var and agent config callbacks to the shared configuration hook', async () => {
			const setCustomEnvVars = vi.fn();
			const setAgentConfig = vi.fn();
			const saveAgentConfig = vi.fn().mockResolvedValue(true);
			const agentConfigRef = { current: {} };
			vi.mocked(useAgentConfiguration).mockReturnValue(
				makeAgentConfiguration({
					customEnvVars: { OLD_KEY: 'old' },
					setCustomEnvVars,
					agentConfig: { model: 'old-model' },
					setAgentConfig,
					agentConfigRef,
					saveAgentConfig,
				})
			);
			const { result } = renderHook(() =>
				useDirectorNotesAgentState({
					isOpen: true,
					directorNotesEnabled: true,
					directorNotesSettings,
					setDirectorNotesSettings: vi.fn(),
				})
			);

			act(() => {
				result.current.handleEnvVarKeyChange('OLD_KEY', 'NEW_KEY', 'value');
				result.current.handleEnvVarValueChange('FOO', 'bar');
				result.current.handleEnvVarRemove('OLD_KEY');
				result.current.handleEnvVarAdd();
				result.current.handleConfigChange('model', 'new-model');
			});
			await act(async () => {
				await result.current.handleConfigBlur();
			});

			expect(setCustomEnvVars).toHaveBeenCalledWith({ NEW_KEY: 'value' });
			expect(setCustomEnvVars).toHaveBeenCalledWith({ OLD_KEY: 'old', FOO: 'bar' });
			expect(setCustomEnvVars).toHaveBeenCalledWith({});
			expect(setCustomEnvVars).toHaveBeenCalledWith({ OLD_KEY: 'old', NEW_VAR: '' });
			expect(setAgentConfig).toHaveBeenCalledWith({ model: 'new-model' });
			expect(agentConfigRef.current).toEqual({ model: 'new-model' });
			expect(saveAgentConfig).toHaveBeenCalledWith('claude-code');
		});

		it('adds env vars with a unique key even when existing values are empty', () => {
			const setCustomEnvVars = vi.fn();
			vi.mocked(useAgentConfiguration).mockReturnValue(
				makeAgentConfiguration({
					customEnvVars: { NEW_VAR: '' },
					setCustomEnvVars,
				})
			);
			const { result } = renderHook(() =>
				useDirectorNotesAgentState({
					isOpen: true,
					directorNotesEnabled: true,
					directorNotesSettings,
					setDirectorNotesSettings: vi.fn(),
				})
			);

			act(() => {
				result.current.handleEnvVarAdd();
			});

			expect(setCustomEnvVars).toHaveBeenCalledWith({ NEW_VAR: '', NEW_VAR_1: '' });
		});
	});
});
