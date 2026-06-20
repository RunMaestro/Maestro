import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EncoreTab } from '../../renderer/components/Settings/tabs/EncoreTab';
import type { Theme } from '../../renderer/types';

const settingsState = vi.hoisted(() => ({
	encoreFeatures: { directorNotes: true },
	directorNotesSettings: {
		provider: 'claude-code',
		defaultLookbackDays: 7,
		customPath: undefined as string | undefined,
		customArgs: undefined as string | undefined,
		customEnvVars: undefined as Record<string, string> | undefined,
	},
	setDirectorNotesSettings: vi.fn(),
	setEncoreFeatures: vi.fn(),
}));

const agentState = vi.hoisted(() => ({
	availableModels: [] as string[],
	detectedAgents: [] as Array<{ id: string; name: string; available: boolean }>,
	initialAgentConfig: {} as Record<string, unknown>,
	initialCustomArgs: '',
	initialCustomEnvVars: {} as Record<string, string>,
	initialCustomPath: '',
	initialExpanded: true,
	isDetecting: false,
	loadingModels: false,
	refreshAgent: vi.fn(),
	refreshingAgent: false,
	refreshModels: vi.fn(),
	saveAgentConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../renderer/hooks', () => ({
	useSettings: () => settingsState,
}));

vi.mock('../../renderer/hooks/agent/useAgentConfiguration', async () => {
	const React = await import('react');

	return {
		useAgentConfiguration: () => {
			const [customPath, setCustomPath] = React.useState(agentState.initialCustomPath);
			const [customArgs, setCustomArgs] = React.useState(agentState.initialCustomArgs);
			const [customEnvVars, setCustomEnvVars] = React.useState(agentState.initialCustomEnvVars);
			const [agentConfig, setAgentConfig] = React.useState(agentState.initialAgentConfig);
			const [isConfigExpanded, setIsConfigExpanded] = React.useState(agentState.initialExpanded);
			const agentConfigRef = React.useRef(agentConfig);
			agentConfigRef.current = agentConfig;

			return {
				agentConfig,
				agentConfigRef,
				availableModels: agentState.availableModels,
				customArgs,
				customEnvVars,
				customPath,
				detectedAgents: agentState.detectedAgents,
				handleAgentChange: vi.fn(),
				hasCustomization:
					Boolean(customPath) || Boolean(customArgs) || Object.keys(customEnvVars).length > 0,
				isConfigExpanded,
				isDetecting: agentState.isDetecting,
				loadingModels: agentState.loadingModels,
				refreshAgent: agentState.refreshAgent,
				refreshingAgent: agentState.refreshingAgent,
				refreshModels: agentState.refreshModels,
				saveAgentConfig: agentState.saveAgentConfig,
				selectedAgent: settingsState.directorNotesSettings.provider,
				setAgentConfig,
				setCustomArgs,
				setCustomEnvVars,
				setCustomPath,
				toggleConfigExpanded: () => setIsConfigExpanded((expanded) => !expanded),
			};
		},
	};
});

vi.mock('../../renderer/components/shared/AgentConfigPanel', () => ({
	AgentConfigPanel: (props: any) => (
		<div data-testid="agent-config-panel">
			<span data-testid="custom-path">{props.customPath}</span>
			<span data-testid="custom-args">{props.customArgs}</span>
			<span data-testid="env-vars">{JSON.stringify(props.customEnvVars)}</span>
			<button type="button" onClick={() => props.onCustomPathBlur()}>
				Blur path
			</button>
			<button type="button" onClick={() => props.onCustomPathChange('')}>
				Clear path
			</button>
			<button type="button" onClick={() => props.onCustomArgsBlur()}>
				Blur args
			</button>
			<button type="button" onClick={() => props.onCustomArgsChange('')}>
				Clear args
			</button>
			<button type="button" onClick={() => props.onEnvVarAdd()}>
				Add env
			</button>
			<button type="button" onClick={() => props.onEnvVarKeyChange('OLD_ENV', 'RENAMED_ENV', '2')}>
				Rename env
			</button>
			<button type="button" onClick={() => props.onEnvVarValueChange('TOKEN', 'updated')}>
				Set env value
			</button>
			<button type="button" onClick={() => props.onEnvVarRemove('TOKEN')}>
				Remove env
			</button>
			<button type="button" onClick={() => props.onEnvVarsBlur()}>
				Blur env
			</button>
			<button type="button" onClick={() => props.onConfigChange('model', 'gpt-5')}>
				Set model
			</button>
			<button type="button" onClick={() => void props.onConfigBlur()}>
				Blur config
			</button>
		</div>
	),
}));

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		accent: '#10a37f',
		accentDim: '#10a37f20',
		accentForeground: '#000000',
		accentText: '#ffffff',
		bgActivity: '#1f2937',
		bgMain: '#111827',
		bgSidebar: '#0f172a',
		border: '#334155',
		error: '#ef4444',
		success: '#22c55e',
		textDim: '#94a3b8',
		textMain: '#f8fafc',
		warning: '#f59e0b',
	},
};

describe('EncoreTab integration', () => {
	beforeEach(() => {
		settingsState.encoreFeatures = { directorNotes: true };
		settingsState.directorNotesSettings = {
			provider: 'claude-code',
			defaultLookbackDays: 7,
			customPath: '/opt/claude',
			customArgs: '--fast',
			customEnvVars: { NEW_VAR: 'existing', OLD_ENV: '1', TOKEN: 'secret' },
		};
		settingsState.setDirectorNotesSettings.mockClear();
		settingsState.setEncoreFeatures.mockClear();

		agentState.detectedAgents = [
			{ id: 'claude-code', name: 'Claude Code', available: true },
			{ id: 'codex', name: 'Codex', available: true },
		];
		agentState.initialAgentConfig = {};
		agentState.initialCustomArgs = '--fast';
		agentState.initialCustomEnvVars = { NEW_VAR: 'existing', OLD_ENV: '1', TOKEN: 'secret' };
		agentState.initialCustomPath = '/opt/claude';
		agentState.initialExpanded = true;
		agentState.isDetecting = false;
		agentState.saveAgentConfig.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders detecting and empty-agent states for enabled Director Notes', () => {
		agentState.isDetecting = true;
		const { rerender } = render(<EncoreTab theme={theme} isOpen />);

		expect(screen.getByText('Detecting agents...')).toBeInTheDocument();

		agentState.isDetecting = false;
		agentState.detectedAgents = [];
		rerender(<EncoreTab theme={theme} isOpen />);

		expect(screen.getByText(/No agents available/)).toBeInTheDocument();
	});

	it('toggles Director Notes on from the feature header', () => {
		settingsState.encoreFeatures = { directorNotes: false };

		render(<EncoreTab theme={theme} isOpen />);

		fireEvent.click(screen.getByText("Director's Notes").closest('button')!);

		expect(settingsState.setEncoreFeatures).toHaveBeenCalledWith({ directorNotes: true });
	});

	it('persists provider customizations, env var edits, and config blur from the panel', () => {
		render(<EncoreTab theme={theme} isOpen />);

		fireEvent.click(screen.getByRole('button', { name: 'Blur path' }));
		expect(settingsState.setDirectorNotesSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				customPath: '/opt/claude',
				customArgs: '--fast',
				customEnvVars: { NEW_VAR: 'existing', OLD_ENV: '1', TOKEN: 'secret' },
			})
		);

		fireEvent.click(screen.getByRole('button', { name: 'Clear path' }));
		fireEvent.click(screen.getByRole('button', { name: 'Blur path' }));
		fireEvent.click(screen.getByRole('button', { name: 'Clear args' }));
		fireEvent.click(screen.getByRole('button', { name: 'Blur args' }));
		expect(settingsState.setDirectorNotesSettings).toHaveBeenCalledWith(
			expect.objectContaining({ customPath: undefined })
		);
		expect(settingsState.setDirectorNotesSettings).toHaveBeenCalledWith(
			expect.objectContaining({ customArgs: undefined })
		);

		fireEvent.click(screen.getByRole('button', { name: 'Add env' }));
		expect(screen.getByTestId('env-vars')).toHaveTextContent('"NEW_VAR_1":""');

		fireEvent.click(screen.getByRole('button', { name: 'Rename env' }));
		expect(screen.getByTestId('env-vars')).toHaveTextContent('"RENAMED_ENV":"2"');

		fireEvent.click(screen.getByRole('button', { name: 'Set env value' }));
		expect(screen.getByTestId('env-vars')).toHaveTextContent('"TOKEN":"updated"');

		fireEvent.click(screen.getByRole('button', { name: 'Remove env' }));
		expect(screen.getByTestId('env-vars')).not.toHaveTextContent('"TOKEN"');

		fireEvent.click(screen.getByRole('button', { name: 'Blur env' }));
		expect(settingsState.setDirectorNotesSettings).toHaveBeenLastCalledWith(
			expect.objectContaining({
				customEnvVars: expect.objectContaining({ RENAMED_ENV: '2' }),
			})
		);

		fireEvent.click(screen.getByRole('button', { name: 'Set model' }));
		fireEvent.click(screen.getByRole('button', { name: 'Blur config' }));
		expect(agentState.saveAgentConfig).toHaveBeenCalledWith('claude-code');
	});

	it('resets custom provider settings and updates lookback days', () => {
		render(<EncoreTab theme={theme} isOpen />);

		fireEvent.change(screen.getByLabelText('Select synopsis provider agent'), {
			target: { value: 'codex' },
		});
		expect(settingsState.setDirectorNotesSettings).toHaveBeenCalledWith({
			...settingsState.directorNotesSettings,
			provider: 'codex',
			customPath: undefined,
			customArgs: undefined,
			customEnvVars: undefined,
		});

		fireEvent.change(screen.getByRole('slider'), { target: { value: '30' } });
		expect(settingsState.setDirectorNotesSettings).toHaveBeenCalledWith({
			...settingsState.directorNotesSettings,
			defaultLookbackDays: 30,
		});
	});
});
