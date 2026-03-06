/**
 * Tests for EncoreTab component
 *
 * Tests the Encore Features settings tab including:
 * - Rendering header and description text
 * - Director's Notes toggle (on/off)
 * - Provider dropdown with detected agents
 * - Agent detection on mount and refresh
 * - Customize button expanding config panel
 * - Custom path/args input fields
 * - Custom env vars editor integration
 * - Lookback period slider (1-90 range)
 * - Lookback scale markers
 * - Configuration persistence via window.maestro.agents.setConfig
 * - Agent config panel rendering for supported agents
 * - Models selection and refresh
 * - Agent detection error handling
 * - Config expansion/collapse toggle
 * - DN description text when enabled
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { EncoreTab } from '../../../../../renderer/components/Settings/tabs/EncoreTab';
import type { Theme, AgentConfig } from '../../../../../renderer/types';

// Mock AgentConfigPanel to avoid deep rendering
vi.mock('../../../../../renderer/components/shared/AgentConfigPanel', () => ({
	AgentConfigPanel: (props: any) => (
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
			{/* Expose callbacks for testing */}
			<button
				data-testid="trigger-custom-path-change"
				onClick={() => props.onCustomPathChange('/custom/path')}
			/>
			<button data-testid="trigger-custom-path-blur" onClick={() => props.onCustomPathBlur()} />
			<button data-testid="trigger-custom-path-clear" onClick={() => props.onCustomPathClear()} />
			<button
				data-testid="trigger-custom-args-change"
				onClick={() => props.onCustomArgsChange('--verbose')}
			/>
			<button data-testid="trigger-custom-args-blur" onClick={() => props.onCustomArgsBlur()} />
			<button data-testid="trigger-custom-args-clear" onClick={() => props.onCustomArgsClear()} />
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
				onClick={() => props.onConfigBlur('model', 'test-model')}
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
const mockSetEncoreFeatures = vi.fn();
const mockSetDirectorNotesSettings = vi.fn();
const mockSetStatsCollectionEnabled = vi.fn();
const mockSetDefaultStatsTimeRange = vi.fn();
const mockSetWakatimeEnabled = vi.fn();
const mockSetWakatimeApiKey = vi.fn();
const mockSetWakatimeDetailedTracking = vi.fn();

// Override mechanism for per-test customization
let mockUseSettingsOverrides: Record<string, any> = {};

vi.mock('../../../../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => ({
		encoreFeatures: { directorNotes: false },
		setEncoreFeatures: mockSetEncoreFeatures,
		directorNotesSettings: {
			provider: 'claude-code',
			defaultLookbackDays: 7,
		},
		setDirectorNotesSettings: mockSetDirectorNotesSettings,
		// Stats
		statsCollectionEnabled: true,
		setStatsCollectionEnabled: mockSetStatsCollectionEnabled,
		defaultStatsTimeRange: 'week',
		setDefaultStatsTimeRange: mockSetDefaultStatsTimeRange,
		// WakaTime
		wakatimeEnabled: false,
		setWakatimeEnabled: mockSetWakatimeEnabled,
		wakatimeApiKey: '',
		setWakatimeApiKey: mockSetWakatimeApiKey,
		wakatimeDetailedTracking: false,
		setWakatimeDetailedTracking: mockSetWakatimeDetailedTracking,
		// Symphony
		symphonyRegistryUrls: [],
		setSymphonyRegistryUrls: vi.fn(),
		...mockUseSettingsOverrides,
	}),
}));

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: '#bd93f920',
		accentText: '#ff79c6',
		accentForeground: '#ffffff',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

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

describe('EncoreTab', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockUseSettingsOverrides = {};

		// Reset window.maestro mocks
		vi.mocked(window.maestro.agents.detect).mockResolvedValue(mockAllAgents);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
		vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(undefined);
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue([]);
		vi.mocked(window.maestro.stats.getDatabaseSize).mockResolvedValue(1024 * 1024);
		vi.mocked(window.maestro.stats.getEarliestTimestamp).mockResolvedValue(null);
		vi.mocked(window.maestro.wakatime.checkCli).mockResolvedValue({ available: false });
		vi.mocked(window.maestro.wakatime.validateApiKey).mockResolvedValue({ valid: false });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	// ── 1. Rendering ──────────────────────────────────────────────────────

	describe('rendering', () => {
		it('should render Encore Features header', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Encore Features')).toBeInTheDocument();
		});

		it('should render description text', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(
				screen.getByText(/Optional features that extend Maestro's capabilities/)
			).toBeInTheDocument();
			expect(screen.getByText(/Disabled features are completely hidden/)).toBeInTheDocument();
		});

		it("should render Director's Notes feature section", async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText("Director's Notes")).toBeInTheDocument();
		});

		it('should render Beta badge', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Beta')).toBeInTheDocument();
		});

		it("should render subtitle description for Director's Notes", async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(
				screen.getByText('Unified history view and AI-generated synopsis across all sessions')
			).toBeInTheDocument();
		});
	});

	// ── 2. Director's Notes Toggle ────────────────────────────────────────

	describe("Director's Notes toggle", () => {
		it('should default to off (DN settings hidden)', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText("Director's Notes")).toBeInTheDocument();
			expect(screen.queryByText('Synopsis Provider')).not.toBeInTheDocument();
		});

		it('should call setEncoreFeatures with directorNotes true when toggled on', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const dnToggle = screen.getByText("Director's Notes").closest('button');
			expect(dnToggle).toBeInTheDocument();
			fireEvent.click(dnToggle!);

			expect(mockSetEncoreFeatures).toHaveBeenCalledWith({
				directorNotes: true,
			});
		});

		it('should call setEncoreFeatures with directorNotes false when toggled off', async () => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const dnToggle = screen.getByText("Director's Notes").closest('button');
			fireEvent.click(dnToggle!);

			expect(mockSetEncoreFeatures).toHaveBeenCalledWith({
				directorNotes: false,
			});
		});
	});

	// ── 3. Provider Dropdown ──────────────────────────────────────────────

	describe('provider dropdown', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should render detected available agents as options', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const select = screen.getByLabelText('Select synopsis provider agent');
			expect(select).toBeInTheDocument();

			const options = select.querySelectorAll('option');
			// Only supported and available agents: claude-code, codex
			expect(options.length).toBe(2);
			expect(options[0]).toHaveValue('claude-code');
			expect(options[0]).toHaveTextContent('Claude Code');
			expect(options[1]).toHaveValue('codex');
			expect(options[1]).toHaveTextContent('Codex (Beta)');
		});

		it('should call setDirectorNotesSettings on provider change', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const select = screen.getByLabelText('Select synopsis provider agent');
			fireEvent.change(select, { target: { value: 'codex' } });

			expect(mockSetDirectorNotesSettings).toHaveBeenCalledWith({
				provider: 'codex',
				defaultLookbackDays: 7,
				customPath: undefined,
				customArgs: undefined,
				customEnvVars: undefined,
			});
		});

		it('should render Synopsis Provider label', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Synopsis Provider')).toBeInTheDocument();
		});

		it('should render provider description text', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(
				screen.getByText('The AI agent used to generate synopsis summaries')
			).toBeInTheDocument();
		});
	});

	// ── 4. Agent Detection ────────────────────────────────────────────────

	describe('agent detection', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should call agents.detect on mount when DN is enabled and tab is open', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.agents.detect).toHaveBeenCalled();
		});

		it('should not call agents.detect when tab is not open', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={false} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.agents.detect).not.toHaveBeenCalled();
		});

		it('should not call agents.detect when DN is disabled', async () => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: false } };
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.agents.detect).not.toHaveBeenCalled();
		});

		it('should show only available and non-hidden agents', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const select = screen.getByLabelText('Select synopsis provider agent');
			const options = select.querySelectorAll('option');

			// mockAllAgents has: claude-code (available, visible), codex (available, visible),
			// opencode (not available), hidden-agent (hidden)
			// AGENT_TILES supported: claude-code, codex, opencode, factory-droid
			// Intersection: claude-code, codex (opencode not available, factory-droid not detected)
			expect(options.length).toBe(2);

			const values = Array.from(options).map((o) => o.getAttribute('value'));
			expect(values).toContain('claude-code');
			expect(values).toContain('codex');
			expect(values).not.toContain('opencode');
			expect(values).not.toContain('hidden-agent');
		});

		it('should show "Detecting agents..." while loading', async () => {
			let resolveDetect: (agents: AgentConfig[]) => void;
			vi.mocked(window.maestro.agents.detect).mockReturnValue(
				new Promise((resolve) => {
					resolveDetect = resolve;
				})
			);

			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Detecting agents...')).toBeInTheDocument();

			// Resolve detection
			await act(async () => {
				resolveDetect!(mockAvailableAgents);
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.queryByText('Detecting agents...')).not.toBeInTheDocument();
		});

		it('should show "No agents available" when none are detected', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([]);

			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText(/No agents available/)).toBeInTheDocument();
		});
	});

	// ── 5. Agent Refresh ──────────────────────────────────────────────────

	describe('agent refresh', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should refresh agents when refresh button in AgentConfigPanel is clicked', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Expand the config panel
			const customizeButton = screen.getByTitle('Customize provider settings');
			fireEvent.click(customizeButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Clear initial detection call count
			vi.mocked(window.maestro.agents.detect).mockClear();

			// Trigger refresh via AgentConfigPanel mock
			const refreshButton = screen.getByTestId('trigger-refresh-agent');
			await act(async () => {
				fireEvent.click(refreshButton);
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.agents.detect).toHaveBeenCalledTimes(1);
		});
	});

	// ── 6. Customize Button ───────────────────────────────────────────────

	describe('customize button', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should render Customize button when agents are available', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const customizeButton = screen.getByTitle('Customize provider settings');
			expect(customizeButton).toBeInTheDocument();
			expect(customizeButton).toHaveTextContent('Customize');
		});

		it('should expand config panel when Customize is clicked', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.queryByTestId('agent-config-panel')).not.toBeInTheDocument();

			const customizeButton = screen.getByTitle('Customize provider settings');
			fireEvent.click(customizeButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByTestId('agent-config-panel')).toBeInTheDocument();
		});

		it('should show agent configuration title in expanded panel', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const customizeButton = screen.getByTitle('Customize provider settings');
			fireEvent.click(customizeButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Claude Code Configuration')).toBeInTheDocument();
		});

		it('should load agent config when expanding', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			vi.mocked(window.maestro.agents.getConfig).mockClear();

			const customizeButton = screen.getByTitle('Customize provider settings');
			fireEvent.click(customizeButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.agents.getConfig).toHaveBeenCalledWith('claude-code');
		});
	});

	// ── 7. Custom Path/Args ───────────────────────────────────────────────

	describe('custom path/args', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should pass custom path to AgentConfigPanel', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Expand config
			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByTestId('agent-config-custom-path')).toHaveTextContent('');
		});

		it('should update custom path via AgentConfigPanel callback', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTestId('trigger-custom-path-change'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByTestId('agent-config-custom-path')).toHaveTextContent('/custom/path');
		});

		it('should persist custom path on blur', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Set a custom path first
			fireEvent.click(screen.getByTestId('trigger-custom-path-change'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Trigger blur to persist
			fireEvent.click(screen.getByTestId('trigger-custom-path-blur'));

			expect(mockSetDirectorNotesSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					customPath: '/custom/path',
				})
			);
		});

		it('should clear custom path via callback', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Set then clear
			fireEvent.click(screen.getByTestId('trigger-custom-path-change'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTestId('trigger-custom-path-clear'));

			expect(mockSetDirectorNotesSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					customPath: undefined,
				})
			);
		});

		it('should update custom args via AgentConfigPanel callback', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTestId('trigger-custom-args-change'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByTestId('agent-config-custom-args')).toHaveTextContent('--verbose');
		});

		it('should clear custom args via callback', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTestId('trigger-custom-args-clear'));

			expect(mockSetDirectorNotesSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					customArgs: undefined,
				})
			);
		});
	});

	// ── 8. Custom Env Vars ────────────────────────────────────────────────

	describe('custom env vars', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should pass env vars to AgentConfigPanel', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByTestId('agent-config-env-vars')).toHaveTextContent('{}');
		});

		it('should add a new env var via callback', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTestId('trigger-env-var-add'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByTestId('agent-config-env-vars')).toHaveTextContent(
				JSON.stringify({ NEW_VAR: '' })
			);
		});

		it('should update env var key via callback', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// First add a var, then change its key
			fireEvent.click(screen.getByTestId('trigger-env-var-add'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// The mock callback triggers onEnvVarKeyChange('OLD_KEY', 'NEW_KEY', 'value')
			// but our env vars have 'NEW_VAR', so the callback will do:
			// delete newVars['OLD_KEY'], set newVars['NEW_KEY'] = 'value'
			fireEvent.click(screen.getByTestId('trigger-env-var-key-change'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const envVarsText = screen.getByTestId('agent-config-env-vars').textContent;
			expect(envVarsText).toContain('NEW_KEY');
		});

		it('should update env var value via callback', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// The mock triggers onEnvVarValueChange('MY_VAR', 'new-value')
			fireEvent.click(screen.getByTestId('trigger-env-var-value-change'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const envVarsText = screen.getByTestId('agent-config-env-vars').textContent;
			expect(envVarsText).toContain('MY_VAR');
			expect(envVarsText).toContain('new-value');
		});

		it('should remove env var via callback', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Add var first
			fireEvent.click(screen.getByTestId('trigger-env-var-value-change'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Remove it (triggers onEnvVarRemove('MY_VAR'))
			fireEvent.click(screen.getByTestId('trigger-env-var-remove'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const envVarsText = screen.getByTestId('agent-config-env-vars').textContent;
			expect(envVarsText).not.toContain('MY_VAR');
		});

		it('should persist env vars on blur', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Add an env var then blur
			fireEvent.click(screen.getByTestId('trigger-env-var-add'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTestId('trigger-env-vars-blur'));

			expect(mockSetDirectorNotesSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					customEnvVars: { NEW_VAR: '' },
				})
			);
		});
	});

	// ── 9. Lookback Period Slider ─────────────────────────────────────────

	describe('lookback period slider', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should render slider with min=1, max=90', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const slider = screen.getByRole('slider');
			expect(slider).toBeInTheDocument();
			expect(slider).toHaveAttribute('min', '1');
			expect(slider).toHaveAttribute('max', '90');
		});

		it('should show current lookback value in label', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText(/Default Lookback Period: 7 days/)).toBeInTheDocument();
		});

		it('should have correct default value', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const slider = screen.getByRole('slider');
			expect(slider).toHaveValue('7');
		});

		it('should call setDirectorNotesSettings when slider is changed', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const slider = screen.getByRole('slider');
			fireEvent.change(slider, { target: { value: '30' } });

			expect(mockSetDirectorNotesSettings).toHaveBeenCalledWith({
				provider: 'claude-code',
				defaultLookbackDays: 30,
			});
		});

		it('should render lookback description text', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText(/How far back to look when generating notes/)).toBeInTheDocument();
		});
	});

	// ── 10. Lookback Scale Markers ────────────────────────────────────────

	describe('lookback scale markers', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should display markers at key positions', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('1 day')).toBeInTheDocument();
			expect(screen.getByText('7')).toBeInTheDocument();
			expect(screen.getByText('14')).toBeInTheDocument();
			expect(screen.getByText('30')).toBeInTheDocument();
			expect(screen.getByText('60')).toBeInTheDocument();
			expect(screen.getByText('90 days')).toBeInTheDocument();
		});
	});

	// ── 11. Configuration Persistence ─────────────────────────────────────

	describe('configuration persistence', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should persist agent config via window.maestro.agents.setConfig on config blur', async () => {
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({ model: 'claude-3-sonnet' });

			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Expand config panel
			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Change config then blur
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
	});

	// ── 12. Agent Config Panel ────────────────────────────────────────────

	describe('agent config panel', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should render AgentConfigPanel when expanded', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByTestId('agent-config-panel')).toBeInTheDocument();
			expect(screen.getByTestId('agent-config-agent-id')).toHaveTextContent('claude-code');
		});

		it('should pass the correct agent to AgentConfigPanel', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByTestId('agent-config-agent-id')).toHaveTextContent('claude-code');
		});

		it('should show "Customized" indicator when custom config exists', async () => {
			mockUseSettingsOverrides = {
				encoreFeatures: { directorNotes: true },
				directorNotesSettings: {
					provider: 'claude-code',
					defaultLookbackDays: 7,
					customPath: '/custom/claude',
				},
			};

			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Customized')).toBeInTheDocument();
		});
	});

	// ── 13. Models Selection ──────────────────────────────────────────────

	describe('models selection', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should load models when agent supports model selection and config is expanded', async () => {
			const agentWithModels: AgentConfig[] = [
				{
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
				},
			];

			vi.mocked(window.maestro.agents.detect).mockResolvedValue(agentWithModels);
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue([
				'claude-3-opus',
				'claude-3-sonnet',
				'claude-3-haiku',
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
				JSON.stringify(['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'])
			);
		});

		it('should not load models when agent does not support model selection', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Default mockAvailableAgents have no capabilities.supportsModelSelection
			expect(window.maestro.agents.getModels).not.toHaveBeenCalled();
		});
	});

	// ── 14. Models Refresh ────────────────────────────────────────────────

	describe('models refresh', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should call getModels with force=true when refresh models is triggered', async () => {
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['model-1', 'model-2']);

			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			vi.mocked(window.maestro.agents.getModels).mockClear();
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue([
				'model-1',
				'model-2',
				'model-3',
			]);

			fireEvent.click(screen.getByTestId('trigger-refresh-models'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.agents.getModels).toHaveBeenCalledWith('claude-code', true);
		});
	});

	// ── 15. Agent Detection Error ─────────────────────────────────────────

	describe('agent detection error', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should handle detection error gracefully and stop detecting', async () => {
			vi.mocked(window.maestro.agents.detect).mockRejectedValue(new Error('Detection failed'));

			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Should not be stuck in detecting state
			expect(screen.queryByText('Detecting agents...')).not.toBeInTheDocument();
			// Should show no agents available since detection failed and list is empty
			expect(screen.getByText(/No agents available/)).toBeInTheDocument();
		});

		it('should handle getModels error gracefully', async () => {
			const agentWithModels: AgentConfig[] = [
				{
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
				},
			];

			vi.mocked(window.maestro.agents.detect).mockResolvedValue(agentWithModels);
			vi.mocked(window.maestro.agents.getModels).mockRejectedValue(new Error('Models failed'));

			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Should not crash, loading should be false
			expect(screen.getByTestId('agent-config-loading-models')).toHaveTextContent('false');
		});
	});

	// ── 16. Config Expansion/Collapse ─────────────────────────────────────

	describe('config expansion/collapse', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should toggle config panel on/off', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const customizeButton = screen.getByTitle('Customize provider settings');

			// Initially collapsed
			expect(screen.queryByTestId('agent-config-panel')).not.toBeInTheDocument();

			// Click to expand
			fireEvent.click(customizeButton);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});
			expect(screen.getByTestId('agent-config-panel')).toBeInTheDocument();

			// Click again to collapse
			fireEvent.click(customizeButton);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});
			expect(screen.queryByTestId('agent-config-panel')).not.toBeInTheDocument();
		});

		it('should show customization indicator dot when custom config exists', async () => {
			mockUseSettingsOverrides = {
				encoreFeatures: { directorNotes: true },
				directorNotesSettings: {
					provider: 'claude-code',
					defaultLookbackDays: 7,
					customArgs: '--verbose',
				},
			};

			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// The customize button should have a colored dot indicating customization
			const customizeButton = screen.getByTitle('Customize provider settings');
			// The dot is a span inside the button with a rounded-full class
			const dot = customizeButton.querySelector('.rounded-full');
			expect(dot).toBeInTheDocument();
		});
	});

	// ── 17. DN Description Text ───────────────────────────────────────────

	describe('DN description text when enabled', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should show all description text when DN is enabled', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(
				screen.getByText('Unified history view and AI-generated synopsis across all sessions')
			).toBeInTheDocument();
			expect(
				screen.getByText('The AI agent used to generate synopsis summaries')
			).toBeInTheDocument();
			expect(screen.getByText(/How far back to look when generating notes/)).toBeInTheDocument();
		});

		it('should hide DN settings section when DN is disabled', async () => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: false } };

			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.queryByText('Synopsis Provider')).not.toBeInTheDocument();
			expect(screen.queryByRole('slider')).not.toBeInTheDocument();
			expect(
				screen.queryByText('The AI agent used to generate synopsis summaries')
			).not.toBeInTheDocument();
		});
	});

	// ── Additional: Agent change resets state ─────────────────────────────

	describe('agent change behavior', () => {
		beforeEach(() => {
			mockUseSettingsOverrides = { encoreFeatures: { directorNotes: true } };
		});

		it('should reset custom config when provider is changed', async () => {
			mockUseSettingsOverrides = {
				encoreFeatures: { directorNotes: true },
				directorNotesSettings: {
					provider: 'claude-code',
					defaultLookbackDays: 7,
					customPath: '/custom/path',
					customArgs: '--verbose',
				},
			};

			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const select = screen.getByLabelText('Select synopsis provider agent');
			fireEvent.change(select, { target: { value: 'codex' } });

			expect(mockSetDirectorNotesSettings).toHaveBeenCalledWith({
				provider: 'codex',
				defaultLookbackDays: 7,
				customPath: undefined,
				customArgs: undefined,
				customEnvVars: undefined,
			});
		});

		it('should load new agent config when provider is changed while expanded', async () => {
			render(<EncoreTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Expand config
			fireEvent.click(screen.getByTitle('Customize provider settings'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			vi.mocked(window.maestro.agents.getConfig).mockClear();

			// Change provider
			const select = screen.getByLabelText('Select synopsis provider agent');
			fireEvent.change(select, { target: { value: 'codex' } });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.agents.getConfig).toHaveBeenCalledWith('codex');
		});
	});
});
