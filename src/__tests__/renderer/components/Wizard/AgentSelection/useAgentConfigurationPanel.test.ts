import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../../../../renderer/types';
import { useAgentConfigurationPanel } from '../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/hooks/useAgentConfigurationPanel';

describe('useAgentConfigurationPanel', () => {
	it('ignores a stale provider config load after another agent is selected', async () => {
		const cursorConfig = Promise.withResolvers<Record<string, unknown>>();
		const claudeConfig = Promise.withResolvers<Record<string, unknown>>();
		const getConfig = vi.fn((agentId: string) =>
			agentId === 'cursor-cli' ? cursorConfig.promise : claudeConfig.promise
		);
		Object.assign(window.maestro.agents, {
			getConfig,
			getModels: vi.fn().mockResolvedValue([]),
			getMaestroPDetectedPath: vi.fn().mockResolvedValue(undefined),
			setCustomPath: vi.fn(),
			setConfig: vi.fn(),
		});

		const setWizardAgentConfigValues = vi.fn();
		const showConfigView = vi.fn();
		const agents = [
			{ id: 'cursor-cli', capabilities: { supportsModelSelection: false } },
			{ id: 'claude-code', capabilities: { supportsModelSelection: false } },
		] as unknown as AgentConfig[];
		const { result } = renderHook(() =>
			useAgentConfigurationPanel({
				detectedAgents: agents,
				sshRemoteConfig: undefined,
				configuringAgentId: null,
				setConfiguringAgentId: vi.fn(),
				setSelectedAgent: vi.fn(),
				setWizardCustomPath: vi.fn(),
				setWizardCustomArgs: vi.fn(),
				setWizardCustomEnvVars: vi.fn(),
				setWizardAgentConfigValues,
				setWizardSessionSshRemoteConfig: vi.fn(),
				customPath: '',
				customEnvVars: {},
				refreshAgentDetection: vi.fn().mockResolvedValue(undefined),
				showConfigView,
				showGridView: vi.fn(),
				announce: vi.fn(),
			})
		);

		let cursorLoad!: Promise<void>;
		let claudeLoad!: Promise<void>;
		act(() => {
			cursorLoad = result.current.handleOpenConfig('cursor-cli');
			claudeLoad = result.current.handleOpenConfig('claude-code');
		});

		claudeConfig.resolve({ model: 'claude-model' });
		await act(async () => claudeLoad);
		cursorConfig.resolve({ model: 'cursor-model' });
		await act(async () => cursorLoad);

		expect(setWizardAgentConfigValues).toHaveBeenCalledTimes(1);
		expect(setWizardAgentConfigValues).toHaveBeenLastCalledWith({ model: 'claude-model' });
		expect(showConfigView).toHaveBeenCalledTimes(1);
	});
});
