/**
 * Tests for useAgentConfiguration hook
 *
 * Covers agent detection, config loading, model management,
 * custom path/args/envvars, config expansion, SSH remotes,
 * agent change, refresh, and reset.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAgentConfiguration } from '../../../renderer/hooks/agent/useAgentConfiguration';
import type { AgentConfig } from '../../../renderer/types';

// Mock window.maestro
const mockDetect = vi.fn();
const mockGetConfig = vi.fn();
const mockSetConfig = vi.fn();
const mockGetModels = vi.fn();
const mockRefresh = vi.fn();
const mockGetSshConfigs = vi.fn();

(window as any).maestro = {
	agents: {
		detect: mockDetect,
		getConfig: mockGetConfig,
		setConfig: mockSetConfig,
		getModels: mockGetModels,
		refresh: mockRefresh,
	},
	sshRemote: {
		getConfigs: mockGetSshConfigs,
	},
};

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id: 'claude-code',
		name: 'Claude Code',
		binaryName: 'claude',
		command: 'claude',
		args: [],
		available: true,
		capabilities: {} as any,
		...overrides,
	} as AgentConfig;
}

const agentClaude = makeAgent({ id: 'claude-code', name: 'Claude Code' });
const agentCodex = makeAgent({ id: 'codex', name: 'Codex' });
const agentHidden = makeAgent({ id: 'hidden', name: 'Hidden', hidden: true } as any);
const agentUnavailable = makeAgent({ id: 'unavail', name: 'Unavail', available: false });

describe('useAgentConfiguration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDetect.mockResolvedValue([agentClaude, agentCodex]);
		mockGetConfig.mockResolvedValue({ model: 'opus' });
		mockSetConfig.mockResolvedValue(undefined);
		mockGetModels.mockResolvedValue(['opus', 'sonnet']);
		mockGetSshConfigs.mockResolvedValue({ success: true, configs: [] });
	});

	describe('initial state', () => {
		it('starts with detecting=true and empty state', () => {
			const { result } = renderHook(() => useAgentConfiguration({ enabled: false }));

			expect(result.current.isDetecting).toBe(true);
			expect(result.current.detectedAgents).toEqual([]);
			expect(result.current.selectedAgent).toBeNull();
			expect(result.current.customPath).toBe('');
			expect(result.current.customArgs).toBe('');
			expect(result.current.customEnvVars).toEqual({});
			expect(result.current.agentConfig).toEqual({});
			expect(result.current.availableModels).toEqual([]);
			expect(result.current.loadingModels).toBe(false);
			expect(result.current.refreshingAgent).toBe(false);
			expect(result.current.isConfigExpanded).toBe(false);
			expect(result.current.hasCustomization).toBe(false);
			expect(result.current.sshRemotes).toEqual([]);
			expect(result.current.sshRemoteConfig).toBeUndefined();
		});

		it('applies initialValues for selectedAgent', async () => {
			const { result } = renderHook(() =>
				useAgentConfiguration({
					enabled: true,
					autoSelect: false,
					initialValues: { selectedAgent: 'codex' },
				})
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			expect(result.current.selectedAgent).toBe('codex');
		});

		it('applies initialValues for custom config', async () => {
			const { result } = renderHook(() =>
				useAgentConfiguration({
					enabled: true,
					autoSelect: false,
					initialValues: {
						customPath: '/custom/path',
						customArgs: '--extra',
						customEnvVars: { KEY: 'val' },
					},
				})
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			expect(result.current.customPath).toBe('/custom/path');
			expect(result.current.customArgs).toBe('--extra');
			expect(result.current.customEnvVars).toEqual({ KEY: 'val' });
		});
	});

	describe('agent detection', () => {
		it('detects agents when enabled', async () => {
			const { result } = renderHook(() => useAgentConfiguration({ enabled: true }));

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			expect(mockDetect).toHaveBeenCalled();
			expect(result.current.detectedAgents).toEqual([agentClaude, agentCodex]);
		});

		it('filters out hidden and unavailable agents by default', async () => {
			mockDetect.mockResolvedValue([agentClaude, agentHidden, agentUnavailable]);

			const { result } = renderHook(() => useAgentConfiguration({ enabled: true }));

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			expect(result.current.detectedAgents).toEqual([agentClaude]);
		});

		it('uses custom agentFilter when provided', async () => {
			const filter = (a: AgentConfig) => a.id === 'codex';
			mockDetect.mockResolvedValue([agentClaude, agentCodex]);

			const { result } = renderHook(() =>
				useAgentConfiguration({ enabled: true, agentFilter: filter })
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			expect(result.current.detectedAgents).toEqual([agentCodex]);
		});

		it('auto-selects first agent when autoSelect=true', async () => {
			const { result } = renderHook(() =>
				useAgentConfiguration({ enabled: true, autoSelect: true })
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			expect(result.current.selectedAgent).toBe('claude-code');
		});

		it('does not auto-select when autoSelect=false', async () => {
			const { result } = renderHook(() =>
				useAgentConfiguration({ enabled: true, autoSelect: false })
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			expect(result.current.selectedAgent).toBeNull();
		});

		it('does not detect when not enabled', () => {
			renderHook(() => useAgentConfiguration({ enabled: false }));

			expect(mockDetect).not.toHaveBeenCalled();
		});

		it('resets state when enabled transitions to false', async () => {
			const { result, rerender } = renderHook(
				({ enabled }: { enabled: boolean }) => useAgentConfiguration({ enabled }),
				{ initialProps: { enabled: true } }
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			expect(result.current.detectedAgents.length).toBeGreaterThan(0);

			rerender({ enabled: false });

			expect(result.current.detectedAgents).toEqual([]);
			expect(result.current.selectedAgent).toBeNull();
		});

		it('handles detection error gracefully', async () => {
			mockDetect.mockRejectedValue(new Error('Network error'));
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const { result } = renderHook(() => useAgentConfiguration({ enabled: true }));

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			expect(result.current.detectedAgents).toEqual([]);
			consoleSpy.mockRestore();
		});
	});

	describe('config expansion', () => {
		it('toggles config expansion', () => {
			const { result } = renderHook(() => useAgentConfiguration({ enabled: false }));

			expect(result.current.isConfigExpanded).toBe(false);

			act(() => {
				result.current.toggleConfigExpanded();
			});

			expect(result.current.isConfigExpanded).toBe(true);

			act(() => {
				result.current.toggleConfigExpanded();
			});

			expect(result.current.isConfigExpanded).toBe(false);
		});

		it('loads config when expanding with a selected agent', async () => {
			const { result } = renderHook(() =>
				useAgentConfiguration({ enabled: true, autoSelect: true })
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			act(() => {
				result.current.toggleConfigExpanded();
			});

			await waitFor(() => {
				expect(mockGetConfig).toHaveBeenCalledWith('claude-code');
			});

			expect(result.current.agentConfig).toEqual({ model: 'opus' });
		});
	});

	describe('custom config state', () => {
		it('sets and tracks custom path', () => {
			const { result } = renderHook(() => useAgentConfiguration({ enabled: false }));

			act(() => {
				result.current.setCustomPath('/my/path');
			});

			expect(result.current.customPath).toBe('/my/path');
			expect(result.current.hasCustomization).toBe(true);
		});

		it('sets and tracks custom args', () => {
			const { result } = renderHook(() => useAgentConfiguration({ enabled: false }));

			act(() => {
				result.current.setCustomArgs('--verbose');
			});

			expect(result.current.customArgs).toBe('--verbose');
			expect(result.current.hasCustomization).toBe(true);
		});

		it('sets and tracks custom env vars', () => {
			const { result } = renderHook(() => useAgentConfiguration({ enabled: false }));

			act(() => {
				result.current.setCustomEnvVars({ API_KEY: 'secret' });
			});

			expect(result.current.customEnvVars).toEqual({ API_KEY: 'secret' });
			expect(result.current.hasCustomization).toBe(true);
		});

		it('reports no customization when all empty', () => {
			const { result } = renderHook(() => useAgentConfiguration({ enabled: false }));

			expect(result.current.hasCustomization).toBe(false);
		});
	});

	describe('agent change', () => {
		it('resets custom config on agent change', async () => {
			const { result } = renderHook(() =>
				useAgentConfiguration({ enabled: true, autoSelect: true })
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			// Set some custom config
			act(() => {
				result.current.setCustomPath('/custom');
				result.current.setCustomArgs('--x');
				result.current.setCustomEnvVars({ K: 'V' });
			});

			expect(result.current.hasCustomization).toBe(true);

			// Change agent
			act(() => {
				result.current.handleAgentChange('codex');
			});

			expect(result.current.selectedAgent).toBe('codex');
			expect(result.current.customPath).toBe('');
			expect(result.current.customArgs).toBe('');
			expect(result.current.customEnvVars).toEqual({});
			expect(result.current.hasCustomization).toBe(false);
		});
	});

	describe('model management', () => {
		it('loads models when expanding config for agent with model selection', async () => {
			const agentWithModels = makeAgent({
				id: 'claude-code',
				capabilities: { supportsModelSelection: true } as any,
			});
			mockDetect.mockResolvedValue([agentWithModels]);

			const { result } = renderHook(() =>
				useAgentConfiguration({ enabled: true, autoSelect: true })
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			// Expand config to trigger load
			act(() => {
				result.current.toggleConfigExpanded();
			});

			await waitFor(() => {
				expect(result.current.availableModels.length).toBeGreaterThan(0);
			});

			expect(result.current.availableModels).toEqual(['opus', 'sonnet']);
		});

		it('refreshes models with force flag', async () => {
			const { result } = renderHook(() =>
				useAgentConfiguration({ enabled: true, autoSelect: true })
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			mockGetModels.mockResolvedValue(['opus', 'sonnet', 'haiku']);

			await act(async () => {
				await result.current.refreshModels();
			});

			expect(mockGetModels).toHaveBeenCalledWith('claude-code', true);
			expect(result.current.availableModels).toEqual(['opus', 'sonnet', 'haiku']);
		});

		it('does not refresh models when no agent selected', async () => {
			const { result } = renderHook(() =>
				useAgentConfiguration({ enabled: true, autoSelect: false })
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			await act(async () => {
				await result.current.refreshModels();
			});

			expect(mockGetModels).not.toHaveBeenCalled();
		});
	});

	describe('agent refresh', () => {
		it('re-detects agents on refresh', async () => {
			const { result } = renderHook(() =>
				useAgentConfiguration({ enabled: true, autoSelect: true })
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			const newAgent = makeAgent({ id: 'opencode', name: 'OpenCode' });
			mockDetect.mockResolvedValue([agentClaude, agentCodex, newAgent]);

			await act(async () => {
				await result.current.refreshAgent();
			});

			expect(result.current.detectedAgents).toHaveLength(3);
			expect(result.current.refreshingAgent).toBe(false);
		});
	});

	describe('SSH remotes', () => {
		it('loads SSH remotes when enabled', async () => {
			const remotes = [{ id: 'remote-1', name: 'My Server', host: 'server.com' }];
			mockGetSshConfigs.mockResolvedValue({ success: true, configs: remotes });

			const { result } = renderHook(() =>
				useAgentConfiguration({ enabled: true, loadSshRemotes: true })
			);

			await waitFor(() => {
				expect(result.current.sshRemotes.length).toBeGreaterThan(0);
			});

			expect(result.current.sshRemotes).toEqual(remotes);
		});

		it('does not load SSH remotes when loadSshRemotes=false', async () => {
			const { result } = renderHook(() =>
				useAgentConfiguration({ enabled: true, loadSshRemotes: false })
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			expect(mockGetSshConfigs).not.toHaveBeenCalled();
			expect(result.current.sshRemotes).toEqual([]);
		});

		it('sets SSH remote config', () => {
			const { result } = renderHook(() => useAgentConfiguration({ enabled: false }));

			const sshConfig = { enabled: true, remoteId: 'remote-1' };
			act(() => {
				result.current.setSshRemoteConfig(sshConfig as any);
			});

			expect(result.current.sshRemoteConfig).toEqual(sshConfig);
		});
	});

	describe('save agent config', () => {
		it('saves config via IPC', async () => {
			const { result } = renderHook(() => useAgentConfiguration({ enabled: false }));

			// Set some config on the ref
			act(() => {
				result.current.agentConfigRef.current = { model: 'sonnet' };
			});

			await act(async () => {
				await result.current.saveAgentConfig('claude-code');
			});

			expect(mockSetConfig).toHaveBeenCalledWith('claude-code', { model: 'sonnet' });
		});
	});

	describe('reset state', () => {
		it('resets all state to defaults', async () => {
			const { result } = renderHook(() =>
				useAgentConfiguration({ enabled: true, autoSelect: true })
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			// Modify state
			act(() => {
				result.current.setCustomPath('/path');
				result.current.setCustomArgs('--arg');
				result.current.setCustomEnvVars({ K: 'V' });
				result.current.toggleConfigExpanded();
			});

			// Reset
			act(() => {
				result.current.resetState();
			});

			expect(result.current.selectedAgent).toBeNull();
			expect(result.current.customPath).toBe('');
			expect(result.current.customArgs).toBe('');
			expect(result.current.customEnvVars).toEqual({});
			expect(result.current.isConfigExpanded).toBe(false);
			expect(result.current.detectedAgents).toEqual([]);
			expect(result.current.isDetecting).toBe(true);
			expect(result.current.hasCustomization).toBe(false);
		});
	});

	describe('agent config state', () => {
		it('sets agent config and updates ref', () => {
			const { result } = renderHook(() => useAgentConfiguration({ enabled: false }));

			act(() => {
				result.current.setAgentConfig({ model: 'haiku', contextWindow: 200000 });
			});

			expect(result.current.agentConfig).toEqual({ model: 'haiku', contextWindow: 200000 });
		});
	});

	describe('load agent config', () => {
		it('loads config and models for agent with model selection', async () => {
			const agentWithModels = makeAgent({
				id: 'claude-code',
				capabilities: { supportsModelSelection: true } as any,
			});
			mockDetect.mockResolvedValue([agentWithModels]);

			const { result } = renderHook(() =>
				useAgentConfiguration({ enabled: true, autoSelect: true })
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			await act(async () => {
				await result.current.loadAgentConfig('claude-code');
			});

			expect(mockGetConfig).toHaveBeenCalledWith('claude-code');
			expect(mockGetModels).toHaveBeenCalledWith('claude-code');
			expect(result.current.agentConfig).toEqual({ model: 'opus' });
			expect(result.current.availableModels).toEqual(['opus', 'sonnet']);
		});

		it('loads config but not models for agent without model selection', async () => {
			const { result } = renderHook(() =>
				useAgentConfiguration({ enabled: true, autoSelect: true })
			);

			await waitFor(() => {
				expect(result.current.isDetecting).toBe(false);
			});

			await act(async () => {
				await result.current.loadAgentConfig('claude-code');
			});

			expect(mockGetConfig).toHaveBeenCalledWith('claude-code');
			// Agent doesn't have supportsModelSelection, so no getModels call
			expect(result.current.agentConfig).toEqual({ model: 'opus' });
		});
	});
});
