/**
 * Tests for EncoreTab component (the Plugins tab).
 *
 * Post-restructure contract: EncoreTab renders ONLY the Extensions marketplace
 * (ExtensionsView) and hands it a `settingsBodies` map keyed by Encore flag.
 * Per-feature config lives INSIDE each tile's detail pane (a Settings sub-tab);
 * there is no longer a "Feature settings" accordion list on the tab itself.
 *
 * This suite mocks ExtensionsView to render whatever `settingsBodies` it
 * receives, so it verifies:
 * - EncoreTab builds a settingsBodies map with exactly the four configurable
 *   first-party keys (usageStats/symphony/maestroCue/directorNotes), each wired
 *   to its real config body (asserted via the body's data-setting-id anchor).
 * - Pianola has no inline config body (it uses its own modal).
 * - The real Director's Notes hook chain: agent detection is gated on
 *   isOpen && directorNotes-enabled; provider changes + custom config persist
 *   through window.maestro; models load for capable agents.
 * - The real Usage & Stats lookback control persists through useSettings.
 *
 * Section-body rendering (labels, slider, markers) is covered by the section
 * component suite; the config hooks are covered by the hooks suite. This suite
 * does NOT restate either - it defends only the tab's wiring + integration.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { EncoreTab } from '../../../../../renderer/components/Settings/tabs/EncoreTab';
import type { AgentConfig } from '../../../../../renderer/types';

import { mockTheme } from '../../../../helpers/mockTheme';

// Mock the Extensions marketplace to render the settingsBodies map it receives.
// Each config body is wrapped in a keyed testid so the tab's wiring (which keys
// it passes, and that each body actually rendered) is observable, while the
// marketplace's own grid/detail behaviour stays out of scope (it has its own
// component + e2e coverage).
vi.mock('../../../../../renderer/components/Settings/Extensions/ExtensionsView', () => ({
	ExtensionsView: ({
		settingsBodies,
	}: {
		settingsBodies?: Partial<Record<string, React.ReactNode>>;
	}) => (
		<div data-testid="extensions-view-mock">
			{settingsBodies &&
				Object.entries(settingsBodies).map(([key, body]) => (
					<div key={key} data-testid={`settings-body-${key}`}>
						{body}
					</div>
				))}
		</div>
	),
}));

// Mock AgentConfigPanel to avoid deep rendering; expose callbacks as buttons.
vi.mock('../../../../../renderer/components/shared/AgentConfigPanel', () => ({
	AgentConfigPanel: (props: {
		agent?: { id?: string };
		customPath?: string;
		customArgs?: string;
		customEnvVars?: Record<string, string>;
		availableModels?: string[];
		loadingModels?: boolean;
		refreshingAgent?: boolean;
		onCustomPathChange: (v: string) => void;
		onCustomPathBlur: () => void;
		onCustomArgsChange: (v: string) => void;
		onCustomArgsBlur: () => void;
		onEnvVarAdd: () => void;
		onEnvVarKeyChange: (oldKey: string, newKey: string, value: string) => void;
		onEnvVarValueChange: (key: string, value: string) => void;
		onEnvVarRemove: (key: string) => void;
		onEnvVarsBlur: () => void;
		onConfigChange: (key: string, value: unknown) => void;
		onConfigBlur: (key: string, value: unknown) => void;
		onRefreshModels?: () => void;
		onRefreshAgent?: () => void;
	}) => (
		<div data-testid="agent-config-panel">
			<span data-testid="agent-config-agent-id">{props.agent?.id}</span>
			<span data-testid="agent-config-custom-path">{props.customPath}</span>
			<span data-testid="agent-config-custom-args">{props.customArgs}</span>
			<span data-testid="agent-config-env-vars">{JSON.stringify(props.customEnvVars)}</span>
			<span data-testid="agent-config-available-models">
				{JSON.stringify(props.availableModels)}
			</span>
			<span data-testid="agent-config-loading-models">{String(props.loadingModels)}</span>
			<span data-testid="agent-config-refreshing-agent">{String(props.refreshingAgent)}</span>
			<button
				data-testid="trigger-custom-path-change"
				onClick={() => props.onCustomPathChange('/custom/path')}
			/>
			<button data-testid="trigger-custom-path-blur" onClick={() => props.onCustomPathBlur()} />
			<button
				data-testid="trigger-custom-args-change"
				onClick={() => props.onCustomArgsChange('--verbose')}
			/>
			<button data-testid="trigger-custom-args-blur" onClick={() => props.onCustomArgsBlur()} />
			<button data-testid="trigger-env-var-add" onClick={() => props.onEnvVarAdd()} />
			<button
				data-testid="trigger-env-var-key-change"
				onClick={() => props.onEnvVarKeyChange('OLD_KEY', 'NEW_KEY', 'value')}
			/>
			<button
				data-testid="trigger-env-var-value-change"
				onClick={() => props.onEnvVarValueChange('MY_VAR', 'new-value')}
			/>
			<button data-testid="trigger-env-var-remove" onClick={() => props.onEnvVarRemove('MY_VAR')} />
			<button data-testid="trigger-env-vars-blur" onClick={() => props.onEnvVarsBlur()} />
			<button
				data-testid="trigger-config-change"
				onClick={() => props.onConfigChange('model', 'claude-3-opus')}
			/>
			<button
				data-testid="trigger-config-blur"
				onClick={() => props.onConfigBlur('model', 'claude-3-opus')}
			/>
			<button data-testid="trigger-refresh-models" onClick={() => props.onRefreshModels?.()} />
			<button data-testid="trigger-refresh-agent" onClick={() => props.onRefreshAgent?.()} />
		</div>
	),
}));

// Mock AGENT_TILES from Wizard
vi.mock('../../../../../renderer/components/Wizard/screens/AgentSelectionScreen', () => ({
	AGENT_TILES: [
		{ id: 'claude-code', name: 'Claude Code', supported: true },
		{ id: 'codex', name: 'Codex', supported: true },
		{ id: 'opencode', name: 'OpenCode', supported: true },
		{ id: 'factory-droid', name: 'Factory Droid', supported: true },
		{ id: 'gemini-cli', name: 'Gemini CLI', supported: false },
	],
}));

// Shared mock fns for useSettings setters
const mockSetDirectorNotesSettings = vi.fn();
const mockSetDefaultStatsTimeRange = vi.fn();

// Override mechanism for per-test customization
let mockUseSettingsOverrides: Record<string, unknown> = {};

vi.mock('../../../../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => ({
		encoreFeatures: { directorNotes: false },
		setEncoreFeatures: vi.fn(),
		directorNotesSettings: {
			provider: 'claude-code',
			defaultLookbackDays: 7,
		},
		setDirectorNotesSettings: mockSetDirectorNotesSettings,
		// Stats
		statsCollectionEnabled: true,
		setStatsCollectionEnabled: vi.fn(),
		defaultStatsTimeRange: 'week',
		setDefaultStatsTimeRange: mockSetDefaultStatsTimeRange,
		// WakaTime
		wakatimeEnabled: false,
		setWakatimeEnabled: vi.fn(),
		wakatimeApiKey: '',
		setWakatimeApiKey: vi.fn(),
		wakatimeDetailedTracking: false,
		setWakatimeDetailedTracking: vi.fn(),
		// Symphony
		symphonyRegistryUrls: [],
		setSymphonyRegistryUrls: vi.fn(),
		...mockUseSettingsOverrides,
	}),
}));

const mockAvailableAgents: AgentConfig[] = [
	{
		id: 'claude-code',
		name: 'Claude Code',
		available: true,
		path: '/usr/local/bin/claude',
		binaryName: 'claude',
		hidden: false,
	},
	{
		id: 'codex',
		name: 'Codex',
		available: true,
		path: '/usr/local/bin/codex',
		binaryName: 'codex',
		hidden: false,
	},
];

const mockAllAgents: AgentConfig[] = [
	...mockAvailableAgents,
	{
		id: 'opencode',
		name: 'OpenCode',
		available: false,
		hidden: false,
	},
	{
		id: 'hidden-agent',
		name: 'Hidden Agent',
		available: true,
		hidden: true,
	},
];

const claudeWithModels: AgentConfig = {
	id: 'claude-code',
	name: 'Claude Code',
	available: true,
	path: '/usr/local/bin/claude',
	hidden: false,
	capabilities: {
		supportsModelSelection: true,
		supportsResume: true,
		supportsReadOnlyMode: true,
		supportsJsonOutput: true,
		supportsSessionId: true,
		supportsImageInput: true,
		supportsImageInputOnResume: true,
		supportsSlashCommands: true,
		supportsSessionStorage: true,
		supportsCostTracking: true,
		supportsUsageStats: true,
		supportsBatchMode: true,
		requiresPromptToStart: false,
		supportsStreaming: true,
		supportsResultMessages: true,
		supportsStreamJsonInput: true,
		supportsContextMerge: false,
		supportsContextExport: false,
	},
};

describe('EncoreTab', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockUseSettingsOverrides = {};

		vi.mocked(window.maestro.agents.detect).mockResolvedValue(mockAllAgents);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
		vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(undefined);
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue([]);
		vi.mocked(window.maestro.wakatime.checkCli).mockResolvedValue({ available: false });
		vi.mocked(window.maestro.wakatime.validateApiKey).mockResolvedValue({ valid: false });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	// ── 1. Tab wiring: marketplace + settingsBodies map ─────────────────────

	describe('marketplace + settingsBodies wiring', () => {
		it('renders only the Extensions marketplace (no Feature settings accordion)', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByTestId('extensions-view-mock')).toBeInTheDocument();
			// The old separate config list + accordion are gone.
			expect(screen.queryByText('Feature settings')).not.toBeInTheDocument();
			expect(screen.queryByTestId('encore-feature-header')).not.toBeInTheDocument();
			expect(screen.queryByTestId('encore-feature-manage')).not.toBeInTheDocument();
		});

		it('passes a settingsBodies map with exactly the four configurable feature keys', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByTestId('settings-body-usageStats')).toBeInTheDocument();
			expect(screen.getByTestId('settings-body-symphony')).toBeInTheDocument();
			expect(screen.getByTestId('settings-body-maestroCue')).toBeInTheDocument();
			expect(screen.getByTestId('settings-body-directorNotes')).toBeInTheDocument();
			// Pianola configures via its own modal - no inline body in the map.
			expect(screen.queryByTestId('settings-body-pianola')).not.toBeInTheDocument();
			expect(screen.queryByTestId('settings-body-plugins')).not.toBeInTheDocument();
		});

		it('wires each key to its real config body (data-setting-id anchors present)', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Each body renders its own settings-search anchor; their presence
			// proves EncoreTab built and passed the actual section components,
			// not empty placeholders.
			expect(document.querySelector('[data-setting-id="encore-usage-stats"]')).toBeInTheDocument();
			expect(document.querySelector('[data-setting-id="encore-symphony"]')).toBeInTheDocument();
			expect(document.querySelector('[data-setting-id="encore-cue"]')).toBeInTheDocument();
			expect(
				document.querySelector('[data-setting-id="encore-director-notes"]')
			).toBeInTheDocument();
		});
	});

	// ── 2. Director's Notes: agent-detection gating (real hook chain) ───────

	describe("Director's Notes agent detection gating", () => {
		it('detects agents on mount when DN is enabled and the tab is open', async () => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
			render(<EncoreTab theme={mockTheme} isOpen={true} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.agents.detect).toHaveBeenCalled();
		});

		it('does not detect agents when the tab is closed', async () => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
			render(<EncoreTab theme={mockTheme} isOpen={false} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.agents.detect).not.toHaveBeenCalled();
		});

		it('does not detect agents when DN is disabled', async () => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: false } };
			render(<EncoreTab theme={mockTheme} isOpen={true} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.agents.detect).not.toHaveBeenCalled();
		});
	});

	// ── 3. Director's Notes: provider selection (real hook → useSettings) ───

	describe("Director's Notes provider selection", () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('shows only detected + supported agents as options', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const select = screen.getByLabelText('Select synopsis provider agent');
			const values = Array.from(select.querySelectorAll('option')).map((o) =>
				o.getAttribute('value')
			);
			// mockAllAgents: claude-code + codex are available & supported;
			// opencode not available; hidden-agent not in AGENT_TILES.
			expect(values).toEqual(['claude-code', 'codex']);
		});

		it('persists the provider (resetting custom fields) and loads the new agent config', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Expand the config panel so a provider change reloads config.
			fireEvent.click(screen.getByTitle('Customize provider settings'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});
			vi.mocked(window.maestro.agents.getConfig).mockClear();

			fireEvent.change(screen.getByLabelText('Select synopsis provider agent'), {
				target: { value: 'codex' },
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(mockSetDirectorNotesSettings).toHaveBeenCalledWith({
				provider: 'codex',
				defaultLookbackDays: 7,
				customPath: undefined,
				customArgs: undefined,
				customEnvVars: undefined,
			});
			expect(window.maestro.agents.getConfig).toHaveBeenCalledWith('codex');
		});
	});

	// ── 4. Director's Notes: customize panel (real hook → window.maestro) ───

	describe("Director's Notes customize panel", () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('loads the selected agent config when the config panel is expanded', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});
			vi.mocked(window.maestro.agents.getConfig).mockClear();

			fireEvent.click(screen.getByTitle('Customize provider settings'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByTestId('agent-config-panel')).toBeInTheDocument();
			expect(screen.getByTestId('agent-config-agent-id')).toHaveTextContent('claude-code');
			expect(window.maestro.agents.getConfig).toHaveBeenCalledWith('claude-code');
		});

		it('persists agent config to window.maestro.agents.setConfig on config blur', async () => {
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({ model: 'claude-3-sonnet' });
			render(<EncoreTab theme={mockTheme} isOpen={true} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTestId('trigger-config-change'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});
			vi.mocked(window.maestro.agents.setConfig).mockClear();
			fireEvent.click(screen.getByTestId('trigger-config-blur'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.agents.setConfig).toHaveBeenCalledWith(
				'claude-code',
				expect.objectContaining({ model: 'claude-3-opus' })
			);
		});

		it('loads models only for agents that support model selection', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([claudeWithModels]);
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue([
				'claude-3-opus',
				'claude-3-sonnet',
			]);
			render(<EncoreTab theme={mockTheme} isOpen={true} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.agents.getModels).toHaveBeenCalledWith('claude-code');
			expect(screen.getByTestId('agent-config-available-models')).toHaveTextContent(
				JSON.stringify(['claude-3-opus', 'claude-3-sonnet'])
			);
		});

		it('does not load models for agents without model selection', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.agents.getModels).not.toHaveBeenCalled();
		});

		it('refreshes models with force=true from the panel refresh action', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([claudeWithModels]);
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['model-1']);
			render(<EncoreTab theme={mockTheme} isOpen={true} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});
			vi.mocked(window.maestro.agents.getModels).mockClear();

			fireEvent.click(screen.getByTestId('trigger-refresh-models'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.agents.getModels).toHaveBeenCalledWith('claude-code', true);
		});
	});

	// ── 5. Director's Notes: detection failure is non-fatal ────────────────

	describe("Director's Notes detection failure", () => {
		it('recovers from a detection error without getting stuck detecting', async () => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
			vi.mocked(window.maestro.agents.detect).mockRejectedValue(new Error('Detection failed'));

			render(<EncoreTab theme={mockTheme} isOpen={true} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.queryByText('Detecting agents...')).not.toBeInTheDocument();
			expect(screen.getByText(/No agents available/)).toBeInTheDocument();
		});
	});

	// ── 6. Usage & Stats: lookback control persists via useSettings ────────

	describe('Usage & Stats lookback wiring', () => {
		it('persists the default lookback window through setDefaultStatsTimeRange', async () => {
			mockUseSettingsOverrides = {
				encoreFeatures: { usageStats: true },
				defaultStatsTimeRange: 'week',
			};
			render(<EncoreTab theme={mockTheme} isOpen={true} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const dropdown = screen.getByLabelText('Select default lookback window') as HTMLSelectElement;
			expect(dropdown.value).toBe('week');
			fireEvent.change(dropdown, { target: { value: 'quarter' } });
			expect(mockSetDefaultStatsTimeRange).toHaveBeenCalledWith('quarter');
		});
	});
});
