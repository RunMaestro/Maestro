import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
	CueSettingsSection,
	DirectorNotesSection,
	SymphonyRegistrySection,
	UsageStatsSection,
	WakatimeSettings,
} from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import type {
	CueSettingsState,
	DirectorNotesAgentState,
	SymphonyRegistryState,
	WakatimeSettingsState,
} from '../../../../../../renderer/components/Settings/tabs/EncoreTab/types';
import { DEFAULT_CUE_SETTINGS } from '../../../../../../shared/cue';
import type { DirectorNotesSettings } from '../../../../../../renderer/types';
import { mockTheme } from '../../../../../helpers/mockTheme';

vi.mock('../../../../../../renderer/components/shared/AgentConfigPanel', () => ({
	AgentConfigPanel: (props: any) => (
		<div data-testid="agent-config-panel">
			<span data-testid="agent-config-agent-id">{props.agent?.id}</span>
			<button data-testid="agent-config-path" onClick={() => props.onCustomPathBlur()} />
			<button
				data-testid="agent-config-model"
				onClick={() => props.onConfigChange('model', 'opus')}
			/>
		</div>
	),
}));

function wakatimeState(overrides: Partial<WakatimeSettingsState> = {}): WakatimeSettingsState {
	return {
		wakatimeCliStatus: null,
		wakatimeKeyValid: null,
		wakatimeKeyValidating: false,
		handleWakatimeApiKeyChange: vi.fn(),
		validateWakatimeApiKey: vi.fn(),
		...overrides,
	};
}

function registryState(overrides: Partial<SymphonyRegistryState> = {}): SymphonyRegistryState {
	return {
		newRegistryUrl: '',
		registryUrlError: null,
		setNewRegistryUrl: vi.fn(),
		addRegistryUrl: vi.fn(),
		removeRegistryUrl: vi.fn(),
		...overrides,
	};
}

function cueState(overrides: Partial<CueSettingsState> = {}): CueSettingsState {
	return {
		cueSettings: { ...DEFAULT_CUE_SETTINGS },
		cueSettingsLoaded: true,
		cueSettingsSaveState: 'idle',
		cueQueueSizeStr: String(DEFAULT_CUE_SETTINGS.queue_size),
		updateCueSettings: vi.fn(),
		handleTimeoutMinutesChange: vi.fn(),
		handleTimeoutOnFailChange: vi.fn(),
		handleMaxConcurrentChange: vi.fn(),
		handleQueueSizeChange: vi.fn(),
		handleQueueSizeBlur: vi.fn(),
		...overrides,
	};
}

function directorState(overrides: Partial<DirectorNotesAgentState> = {}): DirectorNotesAgentState {
	const agentConfiguration = {
		detectedAgents: [
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
		],
		isDetecting: false,
		isConfigExpanded: false,
		toggleConfigExpanded: vi.fn(),
		customPath: '',
		setCustomPath: vi.fn(),
		customArgs: '',
		setCustomArgs: vi.fn(),
		customEnvVars: {},
		agentConfig: {},
		setAgentConfig: vi.fn(),
		agentConfigRef: { current: {} },
		availableModels: [],
		loadingModels: false,
		refreshModels: vi.fn(),
		dynamicOptions: {},
		loadingDynamicOptions: false,
		refreshAgent: vi.fn(),
		refreshingAgent: false,
		hasCustomization: false,
	} as any;

	return {
		agentConfiguration,
		availableTiles: [
			{ id: 'claude-code', name: 'Claude Code', supported: true },
			{ id: 'codex', name: 'Codex', supported: true },
		],
		selectedAgentConfig: agentConfiguration.detectedAgents[0],
		selectedTile: { id: 'claude-code', name: 'Claude Code', supported: true },
		handleAgentChange: vi.fn(),
		persistCustomConfig: vi.fn(),
		handleEnvVarKeyChange: vi.fn(),
		handleEnvVarValueChange: vi.fn(),
		handleEnvVarRemove: vi.fn(),
		handleEnvVarAdd: vi.fn(),
		handleConfigChange: vi.fn(),
		handleConfigBlur: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as DirectorNotesAgentState;
}

const directorNotesSettings: DirectorNotesSettings = {
	provider: 'claude-code',
	defaultLookbackDays: 7,
};

describe('EncoreTab section components', () => {
	it('renders the Usage & Stats lookback selector and persists changes', () => {
		const setDefaultStatsTimeRange = vi.fn();

		const { rerender } = render(
			<UsageStatsSection
				theme={mockTheme}
				defaultStatsTimeRange="week"
				setDefaultStatsTimeRange={setDefaultStatsTimeRange}
				wakatimeEnabled={false}
				setWakatimeEnabled={vi.fn()}
				wakatimeApiKey=""
				wakatimeDetailedTracking={false}
				setWakatimeDetailedTracking={vi.fn()}
				wakatimeState={wakatimeState()}
			/>
		);

		// Chromeless body: no card header/state pill/Manage - the detail pane
		// owns those. The config controls render directly.
		expect(document.querySelector('[data-setting-id="encore-usage-stats"]')).toBeInTheDocument();
		expect(screen.queryByTestId('encore-feature-header')).not.toBeInTheDocument();
		expect(screen.queryByTestId('encore-feature-manage')).not.toBeInTheDocument();
		expect(screen.getByText('Default lookback window')).toBeInTheDocument();

		const select = screen.getByLabelText('Select default lookback window') as HTMLSelectElement;
		expect(select.value).toBe('week');
		fireEvent.change(select, { target: { value: 'quarter' } });
		expect(setDefaultStatsTimeRange).toHaveBeenCalledWith('quarter');

		rerender(
			<UsageStatsSection
				theme={mockTheme}
				defaultStatsTimeRange="month"
				setDefaultStatsTimeRange={setDefaultStatsTimeRange}
				wakatimeEnabled={false}
				setWakatimeEnabled={vi.fn()}
				wakatimeApiKey=""
				wakatimeDetailedTracking={false}
				setWakatimeDetailedTracking={vi.fn()}
				wakatimeState={wakatimeState()}
			/>
		);
		expect(
			(screen.getByLabelText('Select default lookback window') as HTMLSelectElement).value
		).toBe('month');
	});

	it('wires WakaTime controls, validation indicators, and clear action', () => {
		const setWakatimeEnabled = vi.fn();
		const setWakatimeDetailedTracking = vi.fn();
		const state = wakatimeState({
			wakatimeCliStatus: { available: false },
			wakatimeKeyValid: false,
			handleWakatimeApiKeyChange: vi.fn(),
			validateWakatimeApiKey: vi.fn(),
		});

		render(
			<WakatimeSettings
				theme={mockTheme}
				wakatimeEnabled
				setWakatimeEnabled={setWakatimeEnabled}
				wakatimeApiKey="waka_key"
				wakatimeDetailedTracking={false}
				setWakatimeDetailedTracking={setWakatimeDetailedTracking}
				wakatimeState={state}
			/>
		);

		fireEvent.click(screen.getByRole('switch', { name: 'Enable WakaTime tracking' }));
		fireEvent.click(screen.getByRole('switch', { name: 'Detailed file tracking' }));
		fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'waka_new' } });
		fireEvent.blur(screen.getByLabelText('API Key'));
		fireEvent.click(screen.getByRole('button', { name: 'Clear WakaTime API key' }));

		expect(
			screen.getByText('WakaTime CLI is being installed automatically...')
		).toBeInTheDocument();
		expect(setWakatimeEnabled).toHaveBeenCalledWith(false);
		expect(setWakatimeDetailedTracking).toHaveBeenCalledWith(true);
		expect(state.handleWakatimeApiKeyChange).toHaveBeenCalledWith('waka_new');
		expect(state.validateWakatimeApiKey).toHaveBeenCalledTimes(1);
		expect(state.handleWakatimeApiKeyChange).toHaveBeenCalledWith('');
	});

	it('renders Symphony registries and wires add, Enter, remove, and error states', () => {
		const state = registryState({
			newRegistryUrl: 'https://example.com/registry.json',
			registryUrlError: 'URL already added',
		});

		render(
			<SymphonyRegistrySection
				theme={mockTheme}
				symphonyRegistryUrls={['https://custom.example/registry.json']}
				registryState={state}
			/>
		);

		// Chromeless body: config controls render directly, no accordion header.
		expect(document.querySelector('[data-setting-id="encore-symphony"]')).toBeInTheDocument();
		expect(screen.queryByTestId('encore-feature-header')).not.toBeInTheDocument();
		expect(screen.getByText('Registry Sources')).toBeInTheDocument();
		expect(screen.getByText('default')).toBeInTheDocument();
		expect(screen.getByText('https://custom.example/registry.json')).toBeInTheDocument();
		expect(screen.getByText('URL already added')).toBeInTheDocument();

		const input = screen.getByPlaceholderText('https://example.com/registry.json');
		fireEvent.change(input, { target: { value: 'https://new.example/registry.json' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		fireEvent.click(screen.getByRole('button', { name: /Add/ }));
		fireEvent.click(screen.getByTitle('Remove registry URL'));

		expect(state.setNewRegistryUrl).toHaveBeenCalledWith('https://new.example/registry.json');
		expect(state.addRegistryUrl).toHaveBeenCalledTimes(2);
		expect(state.removeRegistryUrl).toHaveBeenCalledWith('https://custom.example/registry.json');
	});

	it('wires Cue loading, save status, and setting inputs', () => {
		const state = cueState({ cueSettingsSaveState: 'no-targets' });

		const { rerender } = render(<CueSettingsSection theme={mockTheme} cueState={state} />);

		expect(document.querySelector('[data-setting-id="encore-cue"]')).toBeInTheDocument();
		expect(screen.getByText('Global Cue Settings')).toBeInTheDocument();
		expect(screen.getByText(/No cue.yaml yet/)).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText('Timeout (minutes)'), { target: { value: '45' } });
		fireEvent.change(screen.getByLabelText('On Source Failure'), {
			target: { value: 'continue' },
		});
		fireEvent.change(screen.getByLabelText('Max Concurrent Runs'), { target: { value: '3' } });
		fireEvent.change(screen.getByLabelText('Event Queue Size'), { target: { value: '0' } });
		fireEvent.blur(screen.getByLabelText('Event Queue Size'));

		expect(state.handleTimeoutMinutesChange).toHaveBeenCalledWith('45');
		expect(state.handleTimeoutOnFailChange).toHaveBeenCalledWith('continue');
		expect(state.handleMaxConcurrentChange).toHaveBeenCalledWith('3');
		expect(state.handleQueueSizeChange).toHaveBeenCalledWith('0');
		expect(state.handleQueueSizeBlur).toHaveBeenCalledTimes(1);

		rerender(
			<CueSettingsSection theme={mockTheme} cueState={cueState({ cueSettingsLoaded: false })} />
		);
		expect(screen.getByText(/Loading settings/)).toBeInTheDocument();
	});

	it('renders Director Notes provider options and lookback controls', () => {
		const setDirectorNotesSettings = vi.fn();
		const state = directorState();

		render(
			<DirectorNotesSection
				theme={mockTheme}
				directorNotesSettings={directorNotesSettings}
				setDirectorNotesSettings={setDirectorNotesSettings}
				directorNotesAgentState={state}
			/>
		);

		expect(document.querySelector('[data-setting-id="encore-director-notes"]')).toBeInTheDocument();
		expect(screen.queryByTestId('encore-feature-header')).not.toBeInTheDocument();

		const select = screen.getByLabelText('Select synopsis provider agent');
		expect(within(select).getAllByRole('option')).toHaveLength(2);
		fireEvent.change(select, { target: { value: 'codex' } });
		fireEvent.click(screen.getByTitle('Customize provider settings'));
		fireEvent.change(screen.getByLabelText('Default Lookback Period: 7 days'), {
			target: { value: '30' },
		});

		expect(state.handleAgentChange).toHaveBeenCalledWith('codex');
		expect(state.agentConfiguration.toggleConfigExpanded).toHaveBeenCalledTimes(1);
		expect(setDirectorNotesSettings).toHaveBeenCalledWith({
			provider: 'claude-code',
			defaultLookbackDays: 30,
		});
	});

	it('renders Director Notes detecting, empty, and expanded config states', () => {
		const { rerender } = render(
			<DirectorNotesSection
				theme={mockTheme}
				directorNotesSettings={directorNotesSettings}
				setDirectorNotesSettings={vi.fn()}
				directorNotesAgentState={directorState({
					agentConfiguration: {
						...directorState().agentConfiguration,
						isDetecting: true,
					},
				})}
			/>
		);

		expect(screen.getByText('Detecting agents...')).toBeInTheDocument();

		rerender(
			<DirectorNotesSection
				theme={mockTheme}
				directorNotesSettings={directorNotesSettings}
				setDirectorNotesSettings={vi.fn()}
				directorNotesAgentState={directorState({ availableTiles: [] })}
			/>
		);
		expect(screen.getByText(/No agents available/)).toBeInTheDocument();

		const expanded = directorState();
		expanded.agentConfiguration.isConfigExpanded = true;
		expanded.agentConfiguration.hasCustomization = true;
		rerender(
			<DirectorNotesSection
				theme={mockTheme}
				directorNotesSettings={directorNotesSettings}
				setDirectorNotesSettings={vi.fn()}
				directorNotesAgentState={expanded}
			/>
		);

		expect(screen.getByText('Claude Code Configuration')).toBeInTheDocument();
		expect(screen.getByText('Customized')).toBeInTheDocument();
		expect(screen.getByTestId('agent-config-agent-id')).toHaveTextContent('claude-code');
	});

	it('renders the Director Notes default reading-mode toggle and persists changes', () => {
		const setDirectorNotesSettings = vi.fn();

		render(
			<DirectorNotesSection
				theme={mockTheme}
				directorNotesSettings={directorNotesSettings}
				setDirectorNotesSettings={setDirectorNotesSettings}
				directorNotesAgentState={directorState()}
			/>
		);

		// Defaults to 'rich' when defaultMode is unset.
		const richButton = screen.getByRole('button', { name: 'rich', pressed: true });
		expect(richButton).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'plain' }));
		expect(setDirectorNotesSettings).toHaveBeenCalledWith({
			provider: 'claude-code',
			defaultLookbackDays: 7,
			defaultMode: 'plain',
		});
	});
});
