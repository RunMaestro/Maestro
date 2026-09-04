/**
 * @fileoverview Tests for AgentConfigPanel component
 * Tests: Built-in environment variables display, custom env vars, agent configuration
 *
 * Regression test for: MAESTRO_SESSION_RESUMED env var display in group chat moderator customization
 */

import { useState, useCallback } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentConfigPanel } from '../../../../renderer/components/shared/AgentConfigPanel';
import type { AgentConfig, AgentCapabilities } from '../../../../renderer/types';

import { createMockTheme } from '../../../helpers/mockTheme';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	RefreshCw: ({ className }: { className?: string }) => (
		<span data-testid="refresh-icon" className={className}>
			🔄
		</span>
	),
	Plus: ({ className }: { className?: string }) => (
		<span data-testid="plus-icon" className={className}>
			+
		</span>
	),
	Trash2: ({ className }: { className?: string }) => (
		<span data-testid="trash-icon" className={className}>
			🗑
		</span>
	),
	HelpCircle: ({ className }: { className?: string }) => (
		<span data-testid="help-circle-icon" className={className}>
			?
		</span>
	),
	ChevronDown: ({ className }: { className?: string }) => (
		<span data-testid="chevron-down-icon" className={className}>
			▼
		</span>
	),
	Eye: ({ className }: { className?: string }) => (
		<span data-testid="eye-icon" className={className}>
			👁
		</span>
	),
	EyeOff: ({ className }: { className?: string }) => (
		<span data-testid="eye-off-icon" className={className}>
			🚫
		</span>
	),
}));

// Mock the URL opener so we can assert the install link routes through it
const openUrlMock = vi.fn();
vi.mock('../../../../renderer/utils/openUrl', () => ({
	openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

// =============================================================================
// TEST HELPERS
// =============================================================================

function createMockAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id: 'claude-code',
		name: 'Claude Code',
		available: true,
		path: '/usr/local/bin/claude',
		binaryName: 'claude',
		hidden: false,
		...overrides,
	};
}

function createDefaultProps(overrides: Partial<Parameters<typeof AgentConfigPanel>[0]> = {}) {
	return {
		theme: createMockTheme(),
		agent: createMockAgent(),
		customPath: '',
		onCustomPathChange: vi.fn(),
		onCustomPathBlur: vi.fn(),
		customArgs: '',
		onCustomArgsChange: vi.fn(),
		onCustomArgsBlur: vi.fn(),
		customEnvVars: {},
		onEnvVarKeyChange: vi.fn(),
		onEnvVarValueChange: vi.fn(),
		onEnvVarRemove: vi.fn(),
		onEnvVarAdd: vi.fn(),
		onEnvVarsBlur: vi.fn(),
		agentConfig: {},
		onConfigChange: vi.fn(),
		onConfigBlur: vi.fn(),
		...overrides,
	};
}

// =============================================================================
// BUILT-IN ENVIRONMENT VARIABLES TESTS
// =============================================================================

describe('AgentConfigPanel', () => {
	describe('Built-in environment variables (MAESTRO_SESSION_RESUMED)', () => {
		it('should NOT display MAESTRO_SESSION_RESUMED when showBuiltInEnvVars is false (default)', () => {
			render(<AgentConfigPanel {...createDefaultProps()} />);

			// MAESTRO_SESSION_RESUMED should NOT be visible
			expect(screen.queryByText('MAESTRO_SESSION_RESUMED')).not.toBeInTheDocument();
		});

		it('should NOT display MAESTRO_SESSION_RESUMED when showBuiltInEnvVars is explicitly false', () => {
			render(<AgentConfigPanel {...createDefaultProps({ showBuiltInEnvVars: false })} />);

			// MAESTRO_SESSION_RESUMED should NOT be visible
			expect(screen.queryByText('MAESTRO_SESSION_RESUMED')).not.toBeInTheDocument();
		});

		it('should display MAESTRO_SESSION_RESUMED when showBuiltInEnvVars is true', () => {
			render(<AgentConfigPanel {...createDefaultProps({ showBuiltInEnvVars: true })} />);

			// MAESTRO_SESSION_RESUMED should be visible
			expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
		});

		it('should display the value hint for MAESTRO_SESSION_RESUMED', () => {
			render(<AgentConfigPanel {...createDefaultProps({ showBuiltInEnvVars: true })} />);

			// Value hint should be displayed
			expect(screen.getByText('1 (when resuming)')).toBeInTheDocument();
		});

		it('should display a help icon for MAESTRO_SESSION_RESUMED tooltip', () => {
			render(<AgentConfigPanel {...createDefaultProps({ showBuiltInEnvVars: true })} />);

			// Help icon should be present
			expect(screen.getByTestId('help-circle-icon')).toBeInTheDocument();
		});
	});

	describe('OpenCode Agent field', () => {
		const openCodeAgent = createMockAgent({
			id: 'opencode',
			name: 'OpenCode',
			binaryName: 'opencode',
			path: '/usr/local/bin/opencode',
		});

		it('is hidden for non-OpenCode providers', () => {
			render(<AgentConfigPanel {...createDefaultProps()} />);

			expect(screen.queryByText('OpenCode Agent (optional)')).not.toBeInTheDocument();
		});

		it('renders for OpenCode', () => {
			render(<AgentConfigPanel {...createDefaultProps({ agent: openCodeAgent })} />);

			expect(screen.getByText('OpenCode Agent (optional)')).toBeInTheDocument();
		});

		it('shows the agent name parsed out of the existing custom args', () => {
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						agent: openCodeAgent,
						customArgs: '--verbose --agent prometheus',
					})}
				/>
			);

			expect(screen.getByDisplayValue('prometheus')).toBeInTheDocument();
		});

		it('writes the name into custom args, preserving the other args', () => {
			const onCustomArgsChange = vi.fn();
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						agent: openCodeAgent,
						customArgs: '--verbose',
						onCustomArgsChange,
					})}
				/>
			);

			fireEvent.change(screen.getByPlaceholderText('build'), {
				target: { value: 'sisyphus' },
			});

			expect(onCustomArgsChange).toHaveBeenCalledWith('--verbose --agent sisyphus');
		});

		it('removes the flag when the field is cleared', () => {
			const onCustomArgsChange = vi.fn();
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						agent: openCodeAgent,
						customArgs: '--agent prometheus --verbose',
						onCustomArgsChange,
					})}
				/>
			);

			fireEvent.change(screen.getByPlaceholderText('build'), { target: { value: '' } });

			expect(onCustomArgsChange).toHaveBeenCalledWith('--verbose');
		});
	});

	describe('Custom environment variables', () => {
		it('should render custom env vars', () => {
			const customEnvVars = {
				MY_VAR: 'my_value',
				ANOTHER_VAR: 'another_value',
			};

			render(<AgentConfigPanel {...createDefaultProps({ customEnvVars })} />);

			// Input fields for custom env vars should be present
			// The key inputs should have the var names as values
			const inputs = screen.getAllByRole('textbox');
			const keyInputs = inputs.filter(
				(input) =>
					(input as HTMLInputElement).value === 'MY_VAR' ||
					(input as HTMLInputElement).value === 'ANOTHER_VAR'
			);
			expect(keyInputs.length).toBe(2);
		});

		it('should show Add Variable button', () => {
			render(<AgentConfigPanel {...createDefaultProps()} />);

			expect(screen.getByText('Add Variable')).toBeInTheDocument();
		});

		it('should display both built-in and custom env vars when showBuiltInEnvVars is true', () => {
			const customEnvVars = {
				CUSTOM_VAR: 'custom_value',
			};

			render(
				<AgentConfigPanel {...createDefaultProps({ showBuiltInEnvVars: true, customEnvVars })} />
			);

			// Built-in should be visible
			expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();

			// Custom var should also be in an input
			const inputs = screen.getAllByRole('textbox');
			const customKeyInput = inputs.find(
				(input) => (input as HTMLInputElement).value === 'CUSTOM_VAR'
			);
			expect(customKeyInput).toBeDefined();
		});
	});

	describe('Model field clear button', () => {
		const modelAgent = createMockAgent({
			configOptions: [
				{
					key: 'model',
					label: 'Model',
					type: 'text',
					description: 'Model to use',
					default: '',
				},
			],
			capabilities: {
				supportsModelSelection: true,
			} as Partial<AgentCapabilities> as AgentCapabilities,
		});

		it('should show Clear button when model has a value', () => {
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						agent: modelAgent,
						agentConfig: { model: 'opencode/kimi-k2.5-free' },
						availableModels: ['opencode/kimi-k2.5-free', 'another-model'],
					})}
				/>
			);

			expect(screen.getByText('Clear')).toBeInTheDocument();
		});

		it('should NOT show Clear button when model is empty', () => {
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						agent: modelAgent,
						agentConfig: { model: '' },
						availableModels: ['opencode/kimi-k2.5-free'],
					})}
				/>
			);

			expect(screen.queryByText('Clear')).not.toBeInTheDocument();
		});

		it('should call onChange and onBlur with empty string when Clear is clicked', async () => {
			const onConfigChange = vi.fn();
			const onConfigBlur = vi.fn();

			render(
				<AgentConfigPanel
					{...createDefaultProps({
						agent: modelAgent,
						agentConfig: { model: 'opencode/kimi-k2.5-free' },
						availableModels: ['opencode/kimi-k2.5-free'],
						onConfigChange,
						onConfigBlur,
					})}
				/>
			);

			const clearBtn = screen.getByText('Clear');
			clearBtn.click();

			expect(onConfigChange).toHaveBeenCalledWith('model', '');
			expect(onConfigBlur).toHaveBeenCalledWith('model', '');
		});

		it('should commit empty value when user manually clears input and blurs', async () => {
			const onConfigChange = vi.fn();
			const onConfigBlur = vi.fn();

			render(
				<AgentConfigPanel
					{...createDefaultProps({
						agent: modelAgent,
						agentConfig: { model: 'opencode/kimi-k2.5-free' },
						availableModels: ['opencode/kimi-k2.5-free'],
						onConfigChange,
						onConfigBlur,
					})}
				/>
			);

			const modelInput = screen.getByDisplayValue('opencode/kimi-k2.5-free');

			// Focus to enter filter mode, then clear the text and blur
			fireEvent.focus(modelInput);
			fireEvent.change(modelInput, { target: { value: '' } });
			fireEvent.blur(modelInput);

			// The blur handler uses setTimeout(150ms), so wait for it
			await waitFor(() => {
				expect(onConfigChange).toHaveBeenCalledWith('model', '');
				expect(onConfigBlur).toHaveBeenCalledWith('model', '');
			});
		});
	});

	describe('Agent configuration sections', () => {
		it('should render path input pre-filled with detected path', () => {
			render(<AgentConfigPanel {...createDefaultProps()} />);

			expect(screen.getByText('Path')).toBeInTheDocument();
			// The input should be pre-filled with the detected path
			const pathInput = screen.getByDisplayValue('/usr/local/bin/claude');
			expect(pathInput).toBeInTheDocument();
		});

		it('should show custom path when provided, not detected path', () => {
			render(
				<AgentConfigPanel {...createDefaultProps({ customPath: '/custom/path/to/claude' })} />
			);

			// The input should show the custom path
			const pathInput = screen.getByDisplayValue('/custom/path/to/claude');
			expect(pathInput).toBeInTheDocument();
		});

		it('should render custom arguments input section', () => {
			render(<AgentConfigPanel {...createDefaultProps()} />);

			expect(screen.getByText('Custom Arguments (optional)')).toBeInTheDocument();
		});

		it('should render environment variables section', () => {
			render(<AgentConfigPanel {...createDefaultProps()} />);

			expect(screen.getByText('Environment Variables (optional)')).toBeInTheDocument();
		});
	});

	describe('Claude Token Source selector', () => {
		it('offers API / TUI / Dynamic for a local claude-code agent', () => {
			render(<AgentConfigPanel {...createDefaultProps({ onEnableMaestroPChange: vi.fn() })} />);

			expect(screen.getByText('Claude Token Source')).toBeInTheDocument();
			expect(screen.getByText('claude -p')).toBeInTheDocument();
			expect(screen.getByText('TUI Wrapper')).toBeInTheDocument();
			expect(screen.getByText('Dynamic')).toBeInTheDocument();
		});

		it('defaults an unconfigured SSH agent to TUI (remote maestro-p), not API', () => {
			// enableMaestroP left undefined (never configured) + SSH => TUI is the
			// default selection, and the remote-host hint renders.
			render(
				<AgentConfigPanel
					{...createDefaultProps({ onEnableMaestroPChange: vi.fn(), isSshEnabled: true })}
				/>
			);

			const tuiButton = screen.getByText('TUI Wrapper').closest('button');
			const apiButton = screen.getByText('claude -p').closest('button');
			expect(tuiButton?.className).toContain('ring-2');
			expect(apiButton?.className).not.toContain('ring-2');
			expect(screen.getByText(/Runs maestro-p on the remote host/)).toBeInTheDocument();
		});

		it('honors an explicit API choice on an SSH agent (does not force TUI)', () => {
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						onEnableMaestroPChange: vi.fn(),
						isSshEnabled: true,
						enableMaestroP: false,
					})}
				/>
			);

			const apiButton = screen.getByText('claude -p').closest('button');
			const tuiButton = screen.getByText('TUI Wrapper').closest('button');
			expect(apiButton?.className).toContain('ring-2');
			expect(tuiButton?.className).not.toContain('ring-2');
		});

		it('disables the TUI option and falls back to API when the remote has no maestro-p', async () => {
			// The remote probe reports maestro-p is absent: TUI can't run there, so
			// the option is dropped and an unconfigured agent defaults to API.
			(
				window as unknown as {
					maestro: { agents: { getRemoteMaestroPAvailable: ReturnType<typeof vi.fn> } };
				}
			).maestro.agents.getRemoteMaestroPAvailable.mockResolvedValue(false);
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						onEnableMaestroPChange: vi.fn(),
						isSshEnabled: true,
						sshRemoteId: 'remote-without-maestro-p',
					})}
				/>
			);

			// Once the async probe resolves, the warning appears and TUI is gone.
			await waitFor(() =>
				expect(screen.getByText(/maestro-p was not found on the remote/)).toBeInTheDocument()
			);
			expect(screen.queryByText('TUI Wrapper')).not.toBeInTheDocument();
			const apiButton = screen.getByText('claude -p').closest('button');
			expect(apiButton?.className).toContain('ring-2');
			(
				window as unknown as {
					maestro: { agents: { getRemoteMaestroPAvailable: ReturnType<typeof vi.fn> } };
				}
			).maestro.agents.getRemoteMaestroPAvailable.mockResolvedValue(null);
		});

		it('links to the maestro-p install page from the missing-remote warning', async () => {
			openUrlMock.mockClear();
			(
				window as unknown as {
					maestro: { agents: { getRemoteMaestroPAvailable: ReturnType<typeof vi.fn> } };
				}
			).maestro.agents.getRemoteMaestroPAvailable.mockResolvedValue(false);
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						onEnableMaestroPChange: vi.fn(),
						isSshEnabled: true,
						sshRemoteId: 'remote-without-maestro-p',
					})}
				/>
			);

			const installLink = await screen.findByText('Install maestro-p');
			fireEvent.click(installLink);
			expect(openUrlMock).toHaveBeenCalledWith(
				'https://runmaestro.ai/maestro-p/',
				expect.objectContaining({ ctrlKey: false })
			);

			(
				window as unknown as {
					maestro: { agents: { getRemoteMaestroPAvailable: ReturnType<typeof vi.fn> } };
				}
			).maestro.agents.getRemoteMaestroPAvailable.mockResolvedValue(null);
		});

		it('re-probes the remote with force when the Re-check button is clicked', async () => {
			const probeFn = (
				window as unknown as {
					maestro: { agents: { getRemoteMaestroPAvailable: ReturnType<typeof vi.fn> } };
				}
			).maestro.agents.getRemoteMaestroPAvailable;
			// First probe (mount): maestro-p absent. After the user installs it on the
			// remote and clicks Re-check, the forced re-probe reports it present.
			probeFn.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

			render(
				<AgentConfigPanel
					{...createDefaultProps({
						onEnableMaestroPChange: vi.fn(),
						isSshEnabled: true,
						sshRemoteId: 'remote-just-got-maestro-p',
					})}
				/>
			);

			// Mount probe resolves to absent: TUI option missing, warning shown.
			await waitFor(() =>
				expect(screen.getByText(/maestro-p was not found on the remote/)).toBeInTheDocument()
			);
			expect(probeFn).toHaveBeenLastCalledWith('remote-just-got-maestro-p', false);

			fireEvent.click(screen.getByText('Re-check'));

			// The refresh forces a cache-bypassing re-probe...
			await waitFor(() =>
				expect(probeFn).toHaveBeenLastCalledWith('remote-just-got-maestro-p', true)
			);
			// ...which now reports maestro-p present: the warning clears and TUI returns.
			await waitFor(() =>
				expect(screen.queryByText(/maestro-p was not found on the remote/)).not.toBeInTheDocument()
			);
			expect(screen.getByText('TUI Wrapper')).toBeInTheDocument();

			probeFn.mockResolvedValue(null);
		});

		it('renders the selector for SSH agents but drops the Dynamic option', () => {
			render(
				<AgentConfigPanel
					{...createDefaultProps({ onEnableMaestroPChange: vi.fn(), isSshEnabled: true })}
				/>
			);

			expect(screen.getByText('Claude Token Source')).toBeInTheDocument();
			expect(screen.getByText('claude -p')).toBeInTheDocument();
			expect(screen.getByText('TUI Wrapper')).toBeInTheDocument();
			expect(screen.queryByText('Dynamic')).not.toBeInTheDocument();
		});

		it('hides the local Maestro-P Path override when SSH is enabled and TUI is selected', () => {
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						onEnableMaestroPChange: vi.fn(),
						onMaestroPModeChange: vi.fn(),
						isSshEnabled: true,
						enableMaestroP: true,
						maestroPMode: 'interactive',
					})}
				/>
			);

			// The remote TUI hint shows, but the local-script path input does not.
			expect(screen.getByText(/Runs maestro-p on the remote host/)).toBeInTheDocument();
			expect(screen.queryByText('Maestro-P Path (optional)')).not.toBeInTheDocument();
		});

		it('still shows the local Maestro-P Path override for a local TUI agent', () => {
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						onEnableMaestroPChange: vi.fn(),
						onMaestroPModeChange: vi.fn(),
						enableMaestroP: true,
						maestroPMode: 'interactive',
					})}
				/>
			);

			expect(screen.getByText('Maestro-P Path (optional)')).toBeInTheDocument();
		});
	});
});

// =============================================================================
// DETECTED INSTALLATION CHOOSER TESTS
// =============================================================================

describe('AgentConfigPanel - detected installation chooser', () => {
	const CODEX_PATHS = [
		'/opt/homebrew/bin/codex',
		'/Users/test/.nvm/versions/node/v20.11.0/bin/codex',
		'/usr/local/bin/codex-multi-auth-codex',
	];

	function renderWithPaths(
		overrides: Partial<Parameters<typeof AgentConfigPanel>[0]> = {},
		agentOverrides: Partial<AgentConfig> = {}
	) {
		const props = createDefaultProps({
			agent: createMockAgent({
				id: 'codex',
				name: 'Codex',
				binaryName: 'codex',
				path: CODEX_PATHS[0],
				allPaths: CODEX_PATHS,
				...agentOverrides,
			}),
			...overrides,
		});
		render(<AgentConfigPanel {...props} />);
		return props;
	}

	it('does not render a chooser when only one installation was detected', () => {
		renderWithPaths({}, { allPaths: ['/opt/homebrew/bin/codex'] });

		expect(screen.queryByText(/Detected installations/)).not.toBeInTheDocument();
	});

	it('does not render a chooser when detection reported no alternatives', () => {
		renderWithPaths({}, { allPaths: undefined });

		expect(screen.queryByText(/Detected installations/)).not.toBeInTheDocument();
	});

	it('lists every detected installation when more than one exists', () => {
		renderWithPaths();

		expect(screen.getByText('Detected installations (3)')).toBeInTheDocument();
		for (const p of CODEX_PATHS) {
			expect(screen.getByRole('option', { name: p })).toBeInTheDocument();
		}
	});

	it('preselects the detected path when no custom path is set', () => {
		renderWithPaths();

		const select = screen.getByRole('combobox') as HTMLSelectElement;
		expect(select.value).toBe(CODEX_PATHS[0]);
	});

	it('preselects the custom path when it matches a detected installation', () => {
		renderWithPaths({ customPath: CODEX_PATHS[2] });

		const select = screen.getByRole('combobox') as HTMLSelectElement;
		expect(select.value).toBe(CODEX_PATHS[2]);
	});

	it('persists the selection immediately when a path is chosen', () => {
		const props = renderWithPaths();

		const select = screen.getByRole('combobox');
		fireEvent.change(select, { target: { value: CODEX_PATHS[1] } });

		expect(props.onCustomPathChange).toHaveBeenCalledWith(CODEX_PATHS[1]);
		expect(props.onCustomPathBlur).toHaveBeenCalled();
	});

	it('surfaces a hand-typed wrapper as an explicit Custom entry', () => {
		// A wrapper that detection never found (e.g. not on PATH) must not be
		// silently misrepresented as the first detected option.
		renderWithPaths({ customPath: '~/bin/codex-wrapper' });

		const select = screen.getByRole('combobox') as HTMLSelectElement;
		expect(screen.getByRole('option', { name: 'Custom: ~/bin/codex-wrapper' })).toBeInTheDocument();
		expect(select.value).not.toBe(CODEX_PATHS[0]);
	});

	it('hides the chooser when the agent runs over SSH', () => {
		renderWithPaths({ isSshEnabled: true });

		expect(screen.queryByText(/Detected installations/)).not.toBeInTheDocument();
	});

	// Regression: a blur handler wired the way real call sites do it (reading
	// its own committed value back out of React state, e.g. the wizard's
	// useAgentConfigurationPanel.ts) used to see the PREVIOUS path, not the one
	// just picked - onCustomPathChange only schedules a state update, and
	// onCustomPathBlur fired synchronously right after it, before that update
	// committed. The bare vi.fn() mocks above can't catch this since they have
	// no real state to go stale. This wraps the panel in that exact pattern.
	it('a stateful onCustomPathBlur receives the newly selected path, not the stale one', () => {
		const persisted: (string | undefined)[] = [];

		function StatefulWrapper() {
			const [customPath, setCustomPath] = useState('');
			// Mirrors the real bug shape: falls back to the stale closure value
			// when no value is passed, but should receive the fresh one directly.
			const handleBlur = useCallback(
				(value?: string) => {
					persisted.push(value ?? customPath);
				},
				[customPath]
			);

			const props = createDefaultProps({
				agent: createMockAgent({
					id: 'codex',
					name: 'Codex',
					binaryName: 'codex',
					path: CODEX_PATHS[0],
					allPaths: CODEX_PATHS,
				}),
				customPath,
				onCustomPathChange: setCustomPath,
				onCustomPathBlur: handleBlur,
			});
			return <AgentConfigPanel {...props} />;
		}

		render(<StatefulWrapper />);
		const select = screen.getByRole('combobox');
		fireEvent.change(select, { target: { value: CODEX_PATHS[1] } });

		expect(persisted).toEqual([CODEX_PATHS[1]]);
	});

	describe('env var disable toggle', () => {
		it('renders no eye button when the parked record is not supplied', () => {
			render(<AgentConfigPanel {...createDefaultProps({ customEnvVars: { MY_VAR: 'x' } })} />);

			expect(screen.queryByTitle(/^Disable /)).not.toBeInTheDocument();
			expect(screen.queryByTitle(/^Enable /)).not.toBeInTheDocument();
		});

		it('reports the switched-to state when a live var is disabled', () => {
			const onEnvVarToggle = vi.fn();
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						customEnvVars: { MY_VAR: 'x' },
						customEnvVarsDisabled: {},
						onEnvVarToggle,
					})}
				/>
			);

			fireEvent.click(screen.getByTitle(/^Disable MY_VAR/));

			expect(onEnvVarToggle).toHaveBeenCalledWith('MY_VAR', false);
		});

		it('lists parked vars alongside live ones and can switch one back on', () => {
			const onEnvVarToggle = vi.fn();
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						customEnvVars: { LIVE: 'a' },
						customEnvVarsDisabled: { PARKED: 'b' },
						onEnvVarToggle,
					})}
				/>
			);

			expect(screen.getByDisplayValue('PARKED')).toBeInTheDocument();
			expect(screen.getByDisplayValue('b')).toBeInTheDocument();

			fireEvent.click(screen.getByTitle(/^Enable PARKED/));

			expect(onEnvVarToggle).toHaveBeenCalledWith('PARKED', true);
		});

		it('routes edits on a parked row to the parked record', () => {
			const onEnvVarValueChange = vi.fn();
			const onEnvVarRemove = vi.fn();
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						customEnvVars: {},
						customEnvVarsDisabled: { PARKED: 'b' },
						onEnvVarToggle: vi.fn(),
						onEnvVarValueChange,
						onEnvVarRemove,
					})}
				/>
			);

			fireEvent.change(screen.getByDisplayValue('b'), { target: { value: 'c' } });
			expect(onEnvVarValueChange).toHaveBeenCalledWith('PARKED', 'c', false);

			fireEvent.click(screen.getByTitle('Remove variable'));
			expect(onEnvVarRemove).toHaveBeenCalledWith('PARKED', false);
		});

		it('keeps a row in place after it is toggled off', () => {
			// The parked record renders after the live one, so without the stable-ID
			// sort a switched-off row would jump below its still-live neighbour.
			const { rerender } = render(
				<AgentConfigPanel
					{...createDefaultProps({
						customEnvVars: { FIRST: 'a', SECOND: 'b' },
						customEnvVarsDisabled: {},
						onEnvVarToggle: vi.fn(),
					})}
				/>
			);

			rerender(
				<AgentConfigPanel
					{...createDefaultProps({
						customEnvVars: { SECOND: 'b' },
						customEnvVarsDisabled: { FIRST: 'a' },
						onEnvVarToggle: vi.fn(),
					})}
				/>
			);

			const keyInputs = screen.getAllByPlaceholderText('VARIABLE_NAME');
			expect(keyInputs[0]).toHaveValue('FIRST');
			expect(keyInputs[1]).toHaveValue('SECOND');
			expect(screen.getByTitle(/^Enable FIRST/)).toBeInTheDocument();
		});
	});
});
