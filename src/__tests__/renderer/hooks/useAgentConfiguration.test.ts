/**
 * Tests for useAgentConfiguration hook
 *
 * Covers agent detection, config loading, model management,
 * custom path/args/envvars, config expansion, SSH remotes,
 * agent change, refresh, and reset.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAgentConfiguration } from '../../../renderer/hooks/agent/useAgentConfiguration';
import type { AgentDiscoveryResult } from '../../../shared/types';
import type { AgentConfig } from '../../../renderer/types';

// Mock window.maestro
const mockDetect = vi.fn();
const mockGetConfig = vi.fn();
const mockSetConfig = vi.fn();
const mockGetModels = vi.fn();
const mockGetConfigOptions = vi.fn();
const mockRefresh = vi.fn();
const mockGetSshConfigs = vi.fn();

(window as any).maestro = {
	agents: {
		detect: mockDetect,
		getConfig: mockGetConfig,
		setConfig: mockSetConfig,
		getModels: mockGetModels,
		getConfigOptions: mockGetConfigOptions,
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
				expect(result.current.agentConfig).toEqual({ model: 'opus' });
			});
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

	describe('Grok draft discovery', () => {
		const context = {
			kind: 'draft' as const,
			cwd: '/project',
			customEnvVars: { GROK_HOME: '/account-a' },
		};
		const manual = { model: 'manual-model', effort: 'manual-effort' };
		const discovered: AgentDiscoveryResult = { status: 'discovered', options: ['catalog-only'] };
		beforeEach(() => {
			vi.useFakeTimers();
			mockDetect.mockResolvedValue([makeAgent({ id: 'grok' })]);
			mockGetConfig.mockResolvedValue(manual);
			mockGetModels.mockReset().mockResolvedValue(discovered);
			mockGetConfigOptions.mockReset().mockResolvedValue(discovered);
		});
		afterEach(() => vi.useRealTimers());

		it.each([undefined, {}, { GROK_HOME: ' ' }] as (Record<string, string> | undefined)[])(
			'preserves raw environment override %j',
			async (customEnvVars) => {
				const { result } = renderHook(() =>
					useAgentConfiguration({
						enabled: true,
						discoveryContext: context,
						initialValues: { selectedAgent: 'grok', customEnvVars },
					})
				);
				await act(async () => {});
				await act(async () => result.current.toggleConfigExpanded());
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(mockGetModels).toHaveBeenLastCalledWith(
					expect.objectContaining({
						providerId: 'grok',
						forceRefresh: false,
						context: expect.objectContaining({
							cwd: '/project',
							customEnvVars: customEnvVars ?? context.customEnvVars,
						}),
					})
				);
				expect(result.current.availableModels).toEqual(['catalog-only']);
				expect(result.current.agentConfig).toEqual(manual);
			}
		);

		it.each(['account', 'path', 'model', 'remote', 'workspace'] as const)(
			'discards late model and effort responses after a %s change',
			async (change) => {
				const { result, rerender } = renderHook(
					({ cwd }) =>
						useAgentConfiguration({
							enabled: true,
							discoveryContext: { ...context, cwd },
							initialValues: { selectedAgent: 'grok' },
						}),
					{ initialProps: { cwd: '/project' } }
				);
				await act(async () => {});
				await act(async () => result.current.toggleConfigExpanded());
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(result.current.modelDiscoveryStatus).toBe('discovered');
				let resolveModels!: (value: AgentDiscoveryResult) => void;
				let resolveEfforts!: (value: AgentDiscoveryResult) => void;
				mockGetModels.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							resolveModels = resolve;
						})
				);
				mockGetConfigOptions.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							resolveEfforts = resolve;
						})
				);
				act(() => {
					void result.current.refreshModels();
				});
				expect(mockGetModels.mock.lastCall?.[0].forceRefresh).toBe(true);
				act(() => {
					if (change === 'account') result.current.setCustomEnvVars({ GROK_HOME: '/account-b' });
					if (change === 'path') result.current.setCustomPath('/other/grok');
					if (change === 'model')
						result.current.setAgentConfig({ model: 'typed-model', effort: 'typed-effort' });
					if (change === 'remote')
						result.current.setSshRemoteConfig({ enabled: true, remoteId: 'remote-b' });
					if (change === 'workspace') rerender({ cwd: '/other-project' });
				});
				expect(result.current.availableModels).toEqual([]);
				expect(result.current.dynamicOptions).toEqual({});
				expect(result.current.modelDiscoveryStatus).toBe('unavailable');
				await act(async () => {
					resolveModels({ status: 'discovered', options: ['stale-model'] });
					resolveEfforts({ status: 'discovered', options: ['stale-effort'] });
				});
				expect(result.current.availableModels).toEqual([]);
				expect(result.current.dynamicOptions).toEqual({});
				await act(async () => vi.advanceTimersByTimeAsync(300));
				const expected = {
					account: { customEnvVars: { GROK_HOME: '/account-b' } },
					path: { customPath: '/other/grok' },
					model: { model: 'typed-model', effort: 'typed-effort' },
					remote: { sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-b' } },
					workspace: { cwd: '/other-project' },
				}[change];
				expect(mockGetModels.mock.lastCall?.[0].context).toEqual(expect.objectContaining(expected));
				expect(result.current.availableModels).toEqual(['catalog-only']);
				expect(result.current.dynamicOptions).toEqual({ effort: ['catalog-only'] });
				expect(mockGetConfigOptions.mock.lastCall).toEqual([
					mockGetModels.mock.lastCall?.[0],
					'effort',
				]);
				expect(result.current.agentConfig).toEqual(change === 'model' ? expected : manual);
			}
		);

		it.each(['unavailable', 'configured-fallback'] as const)(
			'exposes %s without clearing manual values or inventing cwd',
			async (status) => {
				const fallback = { status, options: status === 'unavailable' ? [] : ['manual-model'] };
				mockGetModels.mockResolvedValue(fallback);
				mockGetConfigOptions.mockResolvedValue({
					...fallback,
					options: status === 'unavailable' ? [] : ['manual-effort'],
				});
				const { result } = renderHook(() =>
					useAgentConfiguration({ enabled: true, initialValues: { selectedAgent: 'grok' } })
				);
				await act(async () => {});
				await act(async () => result.current.toggleConfigExpanded());
				await act(async () => vi.advanceTimersByTimeAsync(300));
				expect(mockGetModels.mock.lastCall?.[0].context).toEqual(
					expect.objectContaining({ cwd: undefined, customEnvVars: undefined })
				);
				expect(result.current.modelDiscoveryStatus).toBe(status);
				expect(result.current.dynamicOptionStatuses).toEqual({ effort: status });
				expect(result.current.availableModels).toEqual(fallback.options);
				expect(result.current.agentConfig).toEqual(manual);
			}
		);

		it('debounces executable typing while immediately hiding the old catalog', async () => {
			const { result } = renderHook(() =>
				useAgentConfiguration({
					enabled: true,
					discoveryContext: context,
					initialValues: { selectedAgent: 'grok' },
				})
			);
			await act(async () => {});
			await act(async () => result.current.toggleConfigExpanded());
			await act(async () => vi.advanceTimersByTimeAsync(300));
			mockGetModels.mockClear();
			act(() => result.current.setCustomPath('/g'));
			expect(result.current.availableModels).toEqual([]);
			await act(async () => vi.advanceTimersByTimeAsync(299));
			act(() => result.current.setCustomPath('/grok'));
			await act(async () => vi.advanceTimersByTimeAsync(299));
			expect(mockGetModels).not.toHaveBeenCalled();
			await act(async () => vi.advanceTimersByTimeAsync(1));
			expect(mockGetModels).toHaveBeenCalledTimes(1);
			expect(mockGetModels.mock.lastCall?.[0].context.customPath).toBe('/grok');
		});
	});
});
