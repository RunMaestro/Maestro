import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../../../../../renderer/types';
import { useAgentConfigurationPanel } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useAgentConfigurationPanel';
import { useAgentDetection } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useAgentDetection';
import { useAgentSelectionFocus } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useAgentSelectionFocus';
import { useAgentSelectionKeyboard } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useAgentSelectionKeyboard';
import { useSshRemotes } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useSshRemotes';
import { captureException } from '../../../../../../renderer/utils/sentry';

vi.mock('../../../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

function agent(overrides: Partial<AgentConfig>): AgentConfig {
	return {
		id: 'claude-code',
		name: 'Claude Code',
		available: true,
		hidden: false,
		...overrides,
	};
}

function createRefs() {
	const nameInput = document.createElement('input');
	const firstTile = document.createElement('button');
	const secondTile = document.createElement('button');
	vi.spyOn(nameInput, 'focus');
	vi.spyOn(firstTile, 'focus');
	vi.spyOn(secondTile, 'focus');

	return {
		nameInput,
		firstTile,
		secondTile,
		refs: {
			nameInputRef: { current: nameInput } as React.RefObject<HTMLInputElement>,
			tileRefs: { current: [firstTile, secondTile] } as React.RefObject<
				(HTMLButtonElement | null)[]
			>,
			containerRef: { current: null } as React.RefObject<HTMLDivElement>,
		},
	};
}

describe('AgentSelectionScreen hooks', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			agent({ id: 'claude-code', available: true }),
			agent({ id: 'terminal', hidden: true }),
		]);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue([]);
		vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(undefined);
		vi.mocked(window.maestro.agents.setCustomPath).mockResolvedValue(undefined);
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [],
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('detects local agents, filters hidden entries, auto-selects Claude, and announces', async () => {
		const setAvailableAgents = vi.fn();
		const setSelectedAgent = vi.fn();
		const { result } = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: undefined,
				selectedAgent: null,
				setAvailableAgents,
				setSelectedAgent,
			})
		);

		await waitFor(() => expect(result.current.isDetecting).toBe(false));

		expect(window.maestro.agents.detect).toHaveBeenCalledWith(undefined);
		expect(result.current.detectedAgents).toHaveLength(1);
		expect(setAvailableAgents).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'claude-code' }),
		]);
		expect(setSelectedAgent).toHaveBeenCalledWith('claude-code');
		expect(result.current.announcement).toContain('Claude Code automatically selected');
	});

	it('does not auto-select when a restored agent is already selected', async () => {
		const setAvailableAgents = vi.fn();
		const setSelectedAgent = vi.fn();
		const { result } = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: undefined,
				selectedAgent: 'codex',
				setAvailableAgents,
				setSelectedAgent,
			})
		);

		await waitFor(() => expect(result.current.isDetecting).toBe(false));

		expect(setSelectedAgent).not.toHaveBeenCalled();
	});

	it('detects with SSH remote ID and exposes all-agent connection errors', async () => {
		const setAvailableAgents = vi.fn();
		const setSelectedAgent = vi.fn();
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			agent({ id: 'claude-code', available: false, error: 'Connection timed out' } as any),
			agent({ id: 'codex', available: false, error: 'Connection timed out' } as any),
		]);

		const { result } = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				selectedAgent: null,
				setAvailableAgents,
				setSelectedAgent,
			})
		);

		await waitFor(() => expect(result.current.isDetecting).toBe(false));

		expect(window.maestro.agents.detect).toHaveBeenCalledWith('remote-1');
		expect(result.current.sshConnectionError).toBe('Connection timed out');
		expect(result.current.announcement).toContain('Unable to connect to remote host');

		vi.mocked(window.maestro.agents.detect).mockClear();
		await act(async () => result.current.refreshAgentDetection());
		expect(window.maestro.agents.detect).toHaveBeenCalledWith('remote-1');
	});

	it('handles thrown detection errors and ignores stale completion after unmount', async () => {
		const setAvailableAgents = vi.fn();
		const setSelectedAgent = vi.fn();
		vi.mocked(window.maestro.agents.detect).mockRejectedValue(new Error('boom'));

		const { result, unmount } = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				selectedAgent: null,
				setAvailableAgents,
				setSelectedAgent,
			})
		);

		await waitFor(() => expect(result.current.isDetecting).toBe(false));
		expect(result.current.sshConnectionError).toBe('boom');

		let resolveDetect: (agents: AgentConfig[]) => void = () => {};
		vi.mocked(window.maestro.agents.detect).mockReturnValue(
			new Promise((resolve) => {
				resolveDetect = resolve;
			})
		);
		const stale = renderHook(() =>
			useAgentDetection({
				sshRemoteConfig: undefined,
				selectedAgent: null,
				setAvailableAgents,
				setSelectedAgent,
			})
		);
		stale.unmount();
		await act(async () => resolveDetect([agent({ id: 'codex' })]));
		expect(setAvailableAgents).not.toHaveBeenCalledWith([expect.objectContaining({ id: 'codex' })]);
		unmount();
	});

	it('loads SSH remotes, syncs restored context, and forwards local or remote selections', async () => {
		const setWizardSessionSshRemoteConfig = vi.fn();
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [{ id: 'remote-1', name: 'Server', host: 'host' } as any],
		});

		const { result, rerender } = renderHook(
			({ sessionSshRemoteConfig }) =>
				useSshRemotes({
					sessionSshRemoteConfig,
					setWizardSessionSshRemoteConfig,
				}),
			{ initialProps: { sessionSshRemoteConfig: undefined as any } }
		);

		await waitFor(() => expect(result.current.sshRemotes).toHaveLength(1));
		expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalledTimes(1);

		act(() => result.current.handleSshRemoteChange('remote-1'));
		expect(result.current.sshRemoteConfig).toEqual({ enabled: true, remoteId: 'remote-1' });
		expect(setWizardSessionSshRemoteConfig).toHaveBeenCalledWith({
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: undefined,
		});

		act(() => result.current.handleSshRemoteChange(''));
		expect(setWizardSessionSshRemoteConfig).toHaveBeenCalledWith({
			enabled: false,
			remoteId: null,
		});

		rerender({
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-2',
				workingDirOverride: '/work',
			},
		});

		expect(result.current.sshRemoteConfig).toEqual({
			enabled: true,
			remoteId: 'remote-2',
			workingDirOverride: '/work',
		});
		await waitFor(() => expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalledTimes(2));

		rerender({
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-2',
				workingDirOverride: '/other-work',
			},
		});

		expect(result.current.sshRemoteConfig).toEqual({
			enabled: true,
			remoteId: 'remote-2',
			workingDirOverride: '/other-work',
		});
		expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalledTimes(2);
	});

	it('swallows SSH remote load failures and reports telemetry', async () => {
		const error = new Error('no ssh');
		vi.mocked(window.maestro.sshRemote.getConfigs).mockRejectedValue(error);

		const { result } = renderHook(() =>
			useSshRemotes({
				sessionSshRemoteConfig: undefined,
				setWizardSessionSshRemoteConfig: vi.fn(),
			})
		);

		await waitFor(() => expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalled());
		expect(result.current.sshRemotes).toEqual([]);
		expect(captureException).toHaveBeenCalledWith(error, {
			extra: {
				operation: 'agentSelection:loadSshRemotes',
				sessionRemoteEnabled: false,
				sessionRemoteId: null,
			},
		});
	});

	it('handles unsuccessful SSH remote config responses', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: false,
			error: 'Failed to load',
		});

		const { result } = renderHook(() =>
			useSshRemotes({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				setWizardSessionSshRemoteConfig: vi.fn(),
			})
		);

		await waitFor(() => expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalled());
		expect(result.current.sshRemotes).toEqual([]);
		expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
			extra: {
				operation: 'agentSelection:loadSshRemotes',
				sessionRemoteEnabled: true,
				sessionRemoteId: 'remote-1',
				error: 'Failed to load',
			},
		});
		expect((vi.mocked(captureException).mock.calls[0][0] as Error).message).toBe('Failed to load');
	});

	it('focuses name field for one selectable agent and tile for multiple selectable agents', () => {
		const { refs, nameInput, secondTile } = createRefs();
		const setFocusedTileIndex = vi.fn();
		const setIsNameFieldFocused = vi.fn();
		const { rerender } = renderHook(
			({ detectedAgents, selectedAgent }) =>
				useAgentSelectionFocus({
					isDetecting: false,
					selectedAgent,
					detectedAgents,
					refs,
					setFocusedTileIndex,
					setIsNameFieldFocused,
				}),
			{
				initialProps: {
					detectedAgents: [agent({ id: 'claude-code', available: true })],
					selectedAgent: null as string | null,
				},
			}
		);

		expect(nameInput.focus).toHaveBeenCalled();
		expect(setIsNameFieldFocused).toHaveBeenCalledWith(true);

		rerender({
			detectedAgents: [
				agent({ id: 'claude-code', available: true }),
				agent({ id: 'codex', available: true }),
			],
			selectedAgent: 'codex',
		});

		expect(setFocusedTileIndex).toHaveBeenCalledWith(1);
		expect(secondTile.focus).toHaveBeenCalled();
	});

	it('handles keyboard navigation, field focus, selection, and continue', () => {
		const { refs, nameInput, secondTile } = createRefs();
		const setFocusedTileIndex = vi.fn();
		const setIsNameFieldFocused = vi.fn();
		const setSelectedAgent = vi.fn();
		const nextStep = vi.fn();
		const preventDefault = vi.fn();

		const { result, rerender } = renderHook(
			({ isNameFieldFocused, focusedTileIndex }) =>
				useAgentSelectionKeyboard({
					isNameFieldFocused,
					focusedTileIndex,
					detectedAgents: [
						agent({ id: 'claude-code', available: true }),
						agent({ id: 'codex', available: true }),
					],
					nameInputRef: refs.nameInputRef,
					tileRefs: refs.tileRefs,
					setIsNameFieldFocused,
					setFocusedTileIndex,
					setSelectedAgent,
					canProceedToNext: () => true,
					nextStep,
				}),
			{ initialProps: { isNameFieldFocused: false, focusedTileIndex: 0 } }
		);

		act(() => result.current({ key: 'ArrowRight', preventDefault } as any));
		expect(setFocusedTileIndex).toHaveBeenCalledWith(1);
		expect(secondTile.focus).toHaveBeenCalled();

		act(() => result.current({ key: 'Tab', shiftKey: false, preventDefault } as any));
		expect(setIsNameFieldFocused).toHaveBeenCalledWith(true);
		expect(nameInput.focus).toHaveBeenCalled();

		act(() => result.current({ key: ' ', preventDefault } as any));
		expect(setSelectedAgent).toHaveBeenCalledWith('claude-code');

		act(() => result.current({ key: 'Enter', preventDefault } as any));
		expect(nextStep).toHaveBeenCalledTimes(1);

		rerender({ isNameFieldFocused: true, focusedTileIndex: 0 });
		act(() => result.current({ key: 'Tab', shiftKey: true, preventDefault } as any));
		expect(setFocusedTileIndex).toHaveBeenCalledWith(1);
	});

	it('opens and closes config panel, loading config and models with SSH ID', async () => {
		vi.useFakeTimers();
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({ model: 'old' });
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['gpt-5']);
		const showConfigView = vi.fn();
		const showGridView = vi.fn();
		const announce = vi.fn();
		const setWizardSessionSshRemoteConfig = vi.fn();

		const { result } = renderHook(() =>
			useAgentConfigurationPanel({
				detectedAgents: [
					agent({
						id: 'codex',
						available: true,
						capabilities: { supportsModelSelection: true } as any,
					}),
				],
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				configuringAgentId: 'codex',
				setConfiguringAgentId: vi.fn(),
				setSelectedAgent: vi.fn(),
				setWizardCustomPath: vi.fn(),
				setWizardCustomArgs: vi.fn(),
				setWizardCustomEnvVars: vi.fn(),
				setWizardAgentConfigValues: vi.fn(),
				setWizardSessionSshRemoteConfig,
				customPath: '/bin/codex',
				customEnvVars: {},
				refreshAgentDetection: vi.fn(),
				showConfigView,
				showGridView,
				announce,
			})
		);

		await act(async () => {
			await result.current.handleOpenConfig('codex');
		});

		expect(window.maestro.agents.getConfig).toHaveBeenCalledWith('codex');
		expect(window.maestro.agents.getModels).toHaveBeenCalledWith('codex', false, 'remote-1');
		expect(result.current.agentConfig).toEqual({ model: 'old' });
		expect(result.current.availableModels).toEqual(['gpt-5']);
		expect(showConfigView).toHaveBeenCalledTimes(1);
		expect(announce).toHaveBeenCalledWith('Configuring Codex');

		const loadError = new Error('load failed');
		vi.mocked(window.maestro.agents.getModels).mockRejectedValueOnce(loadError);
		await act(async () => {
			await result.current.handleOpenConfig('codex');
		});
		expect(captureException).toHaveBeenCalledWith(loadError, {
			extra: {
				operation: 'agentSelection:loadModels',
				agentId: 'codex',
				remoteMode: true,
			},
		});

		act(() => result.current.handleCloseConfig());
		expect(setWizardSessionSshRemoteConfig).toHaveBeenCalledWith({
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: undefined,
		});
		expect(showGridView).toHaveBeenCalledWith('codex');
	});

	it('handles custom config, env vars, model refresh, agent refresh, and config persistence', async () => {
		const setWizardCustomPath = vi.fn();
		const setWizardCustomArgs = vi.fn();
		const setWizardCustomEnvVars = vi.fn();
		const refreshAgentDetection = vi.fn();
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['model-a']);

		const { result } = renderHook(() =>
			useAgentConfigurationPanel({
				detectedAgents: [agent({ id: 'codex' })],
				sshRemoteConfig: undefined,
				configuringAgentId: 'codex',
				setConfiguringAgentId: vi.fn(),
				setSelectedAgent: vi.fn(),
				setWizardCustomPath,
				setWizardCustomArgs,
				setWizardCustomEnvVars,
				setWizardAgentConfigValues: vi.fn(),
				setWizardSessionSshRemoteConfig: vi.fn(),
				customPath: '/bin/codex',
				customEnvVars: { OLD: '1' },
				refreshAgentDetection,
				showConfigView: vi.fn(),
				showGridView: vi.fn(),
				announce: vi.fn(),
			})
		);

		act(() => result.current.setCustomPath(''));
		act(() => result.current.setCustomArgs('--flag'));
		act(() => result.current.handleEnvVarKeyChange('OLD', 'NEW', '2'));
		act(() => result.current.handleEnvVarValueChange('OLD', '3'));
		act(() => result.current.handleEnvVarRemove('OLD'));
		act(() => result.current.handleEnvVarAdd());
		act(() => result.current.handleConfigChange('model', 'gpt-5'));

		await act(async () => result.current.handleConfigBlur('model', 'gpt-5'));
		await act(async () => result.current.handleCustomPathBlur());
		await act(async () => result.current.handleRefreshModels());
		const refreshError = new Error('refresh failed');
		vi.mocked(window.maestro.agents.getModels).mockRejectedValueOnce(refreshError);
		await act(async () => result.current.handleRefreshModels());
		await act(async () => result.current.handleRefreshAgent());

		expect(setWizardCustomPath).toHaveBeenCalledWith(undefined);
		expect(setWizardCustomArgs).toHaveBeenCalledWith('--flag');
		expect(setWizardCustomEnvVars).toHaveBeenCalledWith({ NEW: '2' });
		expect(setWizardCustomEnvVars).toHaveBeenCalledWith({ OLD: '3' });
		expect(setWizardCustomEnvVars).toHaveBeenCalledWith(undefined);
		expect(setWizardCustomEnvVars).toHaveBeenCalledWith({ OLD: '1', NEW_VAR: '' });
		expect(window.maestro.agents.setConfig).toHaveBeenCalledWith('codex', { model: 'gpt-5' });
		expect(window.maestro.agents.setCustomPath).toHaveBeenCalledWith('codex', '/bin/codex');
		expect(window.maestro.agents.getModels).toHaveBeenCalledWith('codex', true, undefined);
		expect(captureException).toHaveBeenCalledWith(refreshError, {
			extra: {
				operation: 'agentSelection:refreshModels',
				agentId: 'codex',
				remoteMode: false,
			},
		});
		expect(refreshAgentDetection).toHaveBeenCalledTimes(2);
	});
});
