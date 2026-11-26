/**
 * @fileoverview Tests for AgentConfigPanel component
 * Tests: Built-in environment variables display, custom env vars, agent configuration
 *
 * Regression test for: MAESTRO_SESSION_RESUMED env var display in group chat moderator customization
 */

import { useState, useCallback } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AgentConfigPanel } from '../../../../renderer/components/shared/AgentConfigPanel';
import type { AgentConfig, AgentCapabilities } from '../../../../renderer/types';

import { createMockTheme } from '../../../helpers/mockTheme';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { getAgentDefinition } from '../../../../shared/maestro-lib/providers/definitions';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { resetStore } from '../../../helpers/resetStores';
import { AGENT_MODES, agentModeFields } from '../../../helpers/mockSession';

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

			// Input fields for custom env vars should be present. The name field is
			// a combobox (it suggests provider vars), so it is read by test id.
			const keyInputs = screen
				.getAllByTestId('env-var-key-input')
				.filter(
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

		it('should focus the unnamed row and open its suggestions after Add Variable', () => {
			// The parent owns the record, so simulate what it does: Add Variable
			// fires the callback, the parent adds the unnamed row, we re-render.
			const { rerender } = render(<AgentConfigPanel {...createDefaultProps()} />);

			fireEvent.click(screen.getByText('Add Variable'));
			rerender(<AgentConfigPanel {...createDefaultProps({ customEnvVars: { '': '' } })} />);

			const keyInput = screen.getByTestId('env-var-key-input');
			expect(keyInput).toHaveValue('');
			expect(keyInput).toHaveFocus();
			expect(screen.getByTestId('env-var-key-input-suggestions')).toBeInTheDocument();
		});

		it('should not focus an unnamed row that was already there on open', () => {
			render(<AgentConfigPanel {...createDefaultProps({ customEnvVars: { '': '' } })} />);

			// A blank row restored from disk is not something the user just asked
			// for, so it must leave the caret where it was.
			expect(screen.queryByTestId('env-var-key-input-suggestions')).not.toBeInTheDocument();
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
			const customKeyInput = screen
				.getAllByTestId('env-var-key-input')
				.find((input) => (input as HTMLInputElement).value === 'CUSTOM_VAR');
			expect(customKeyInput).toBeDefined();
		});
	});

	it('selects a known local auth path for agent environment variables', async () => {
		vi.mocked(window.maestro.agents.getKnownAuthDirs).mockResolvedValueOnce({
			claudeConfigDirs: ['/Users/me/.claude-work', '/Users/me/.claude-personal'],
			codexHomes: [],
		});
		const onEnvVarValueChange = vi.fn();

		render(
			<AgentConfigPanel
				{...createDefaultProps({
					customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/me/.claude-work' },
					onEnvVarValueChange,
				})}
			/>
		);

		fireEvent.change(await screen.findByLabelText('Known CLAUDE_CONFIG_DIR paths'), {
			target: { value: '/Users/me/.claude-personal' },
		});

		// Third arg is the row's enabled flag: the auth-path picker sits on a LIVE
		// row, and the value handler needs to know which record to write back to.
		expect(onEnvVarValueChange).toHaveBeenCalledWith(
			'CLAUDE_CONFIG_DIR',
			'/Users/me/.claude-personal',
			true
		);
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

	describe('Grok manual model and effort controls', () => {
		const agent = createMockAgent({
			...getAgentDefinition('grok'),
			capabilities: { supportsModelSelection: true } as AgentCapabilities,
		});
		beforeEach(() => {
			vi.useFakeTimers();
			resetStore(useSettingsStore);
		});
		afterEach(() => {
			vi.useRealTimers();
			resetStore(useSettingsStore);
		});

		it('uses the selected account environment and supplied model/effort menu through existing handlers', () => {
			const props = createDefaultProps({
				agent,
				customEnvVars: { GROK_HOME: '/profiles/grok-a' },
				availableModels: ['account-a-model'],
				dynamicOptions: { reasoningEffort: ['minimal'] },
			});
			const { rerender } = render(<AgentConfigPanel {...props} />);
			const account = screen.getByDisplayValue('/profiles/grok-a');
			fireEvent.change(account, { target: { value: '/profiles/grok-b' } });
			fireEvent.blur(account);
			expect(props.onEnvVarValueChange).toHaveBeenCalledExactlyOnceWith(
				'GROK_HOME',
				'/profiles/grok-b',
				true
			);
			expect(props.onEnvVarsBlur).toHaveBeenCalledOnce();
			rerender(
				<AgentConfigPanel
					{...props}
					customEnvVars={{ GROK_HOME: '/profiles/grok-b' }}
					availableModels={['grok-4.5']}
					dynamicOptions={{ reasoningEffort: ['low', 'high'] }}
				/>
			);
			expect(screen.queryByDisplayValue('/profiles/grok-a')).not.toBeInTheDocument();
			expect(screen.getByRole('textbox', { name: 'Model' })).toHaveValue('');
			expect(screen.getByRole('textbox', { name: 'Reasoning Effort' })).toHaveValue('');
			fireEvent.click(screen.getByRole('button', { name: 'Show model options' }));
			expect(screen.getByRole('textbox', { name: 'Model' })).toHaveFocus();
			expect(screen.queryByRole('button', { name: 'account-a-model' })).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: 'grok-4.5' }));
			expect(props.onConfigChange).toHaveBeenLastCalledWith('model', 'grok-4.5');
			expect(props.onConfigBlur).toHaveBeenLastCalledWith('model', 'grok-4.5');
			fireEvent.click(screen.getByRole('button', { name: 'Show reasoning effort options' }));
			expect(screen.queryByRole('button', { name: 'none' })).not.toBeInTheDocument();
			expect(screen.queryByRole('button', { name: 'minimal' })).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: 'high' }));
			expect(props.onConfigChange).toHaveBeenLastCalledWith('reasoningEffort', 'high');
			expect(props.onConfigBlur).toHaveBeenLastCalledWith('reasoningEffort', 'high');
			rerender(
				<AgentConfigPanel {...props} agentConfig={{ model: 'grok-4.5', reasoningEffort: 'high' }} />
			);
			for (const [name, key] of [
				['model', 'model'],
				['reasoning effort', 'reasoningEffort'],
			]) {
				fireEvent.click(screen.getByRole('button', { name: `Clear ${name} override` }));
				expect(props.onConfigChange).toHaveBeenLastCalledWith(key, '');
				expect(props.onConfigBlur).toHaveBeenLastCalledWith(key, '');
			}
		});

		it('explains the local ACP approval route and disables model selection with the capability off', () => {
			const props = createDefaultProps({
				agent: {
					...agent,
					capabilities: { ...agent.capabilities!, supportsModelSelection: false },
				},
				agentConfig: { model: 'grok-4.5' },
				availableModels: ['grok-4.5'],
				onRefreshModels: vi.fn(),
				onCodexTransportChange: vi.fn(),
				onEnableMaestroPChange: vi.fn(),
			});
			render(<AgentConfigPanel {...props} />);
			const note = screen.getByText(/Full Access uses headless streaming/);
			expect(note).toHaveTextContent(/Standard: Grok runs over its local ACP route/);
			expect(note).toHaveTextContent(/Not available on SSH remotes/);
			expect(note).toHaveTextContent(/Read-Only/);
			expect(note).not.toHaveTextContent(/unavailable for Grok/);
			expect(
				screen.getByText('Model selection is unavailable for this provider.')
			).toBeInTheDocument();
			expect(screen.getByRole('textbox', { name: 'Model' })).toBeDisabled();
			const clear = screen.getByRole('button', { name: 'Clear model override' });
			expect(clear).toBeDisabled();
			clear.click();
			expect(screen.queryByRole('button', { name: 'Show model options' })).not.toBeInTheDocument();
			expect(screen.queryByTitle('Refresh available models')).not.toBeInTheDocument();
			expect(
				screen.queryByRole('button', { name: /ACP|Standard|TUI Wrapper|codex app-server/ })
			).not.toBeInTheDocument();
			for (const handler of [
				props.onConfigChange,
				props.onConfigBlur,
				props.onRefreshModels,
				props.onCodexTransportChange,
				props.onEnableMaestroPChange,
			])
				expect(handler).not.toHaveBeenCalled();
		});

		it.each([{ availableModels: [] }, { availableModels: ['catalog-only'] }])(
			'keeps stored selections while options change to %j and refresh is requested',
			({ availableModels }) => {
				const props = createDefaultProps({
					agent,
					agentConfig: { model: 'stored-model', reasoningEffort: 'stored-effort' },
					onRefreshModels: vi.fn(),
				});
				const { rerender } = render(<AgentConfigPanel {...props} loadingModels />);
				rerender(
					<AgentConfigPanel
						{...props}
						availableModels={availableModels}
						dynamicOptions={{ reasoningEffort: [] }}
						configOptionNotes={{ model: 'Model discovery unavailable.' }}
					/>
				);
				expect(screen.getByDisplayValue('stored-model')).toHaveValue('stored-model');
				expect(screen.getByDisplayValue('stored-effort')).toHaveValue('stored-effort');
				expect(screen.getByTestId('config-option-note-model')).toHaveTextContent(
					'Model discovery unavailable.'
				);
				fireEvent.click(screen.getByTitle('Refresh available models'));
				expect(props.onRefreshModels).toHaveBeenCalledOnce();
				expect(props.onConfigChange).not.toHaveBeenCalled();
				expect(props.onConfigBlur).not.toHaveBeenCalled();
			}
		);

		it.each([{ availableModels: [] }, { availableModels: ['catalog-only'] }])(
			'commits manual values and inheritance with catalog %j',
			async ({ availableModels }) => {
				const onConfigBlur = vi.fn();
				function StatefulWrapper() {
					const [agentConfig, setAgentConfig] = useState({
						model: 'stored-model',
						reasoningEffort: 'stored-effort',
					});
					return (
						<AgentConfigPanel
							{...createDefaultProps({
								agent,
								agentConfig,
								availableModels,
								onConfigBlur,
								onConfigChange: (key, value) =>
									setAgentConfig((previous) => ({ ...previous, [key]: value })),
							})}
						/>
					);
				}
				render(<StatefulWrapper />);
				for (const [key, stored, manual] of [
					['model', 'stored-model', 'manual-model'],
					['reasoningEffort', 'stored-effort', 'manual-effort'],
				]) {
					const input = screen.getByDisplayValue(stored);
					fireEvent.focus(input);
					fireEvent.change(input, { target: { value: manual } });
					fireEvent.blur(input);
					await act(async () => vi.advanceTimersByTimeAsync(150));
					expect(onConfigBlur).toHaveBeenCalledWith(key, manual);
					expect(input).toHaveValue(manual);
				}
				fireEvent.click(screen.getByTitle('Reset to default model'));
				expect(onConfigBlur).toHaveBeenCalledWith('model', '');
				expect(screen.queryByDisplayValue('manual-model')).not.toBeInTheDocument();
				const effort = screen.getByDisplayValue('manual-effort');
				fireEvent.change(effort, { target: { value: '' } });
				fireEvent.blur(effort);
				await act(async () => vi.advanceTimersByTimeAsync(150));
				expect(onConfigBlur).toHaveBeenCalledWith('reasoningEffort', '');
				expect(effort).toHaveValue('');
			}
		);
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

	// One set of labels and controls in every mode; only where detection runs
	// differs (this computer for a local agent, over SSH for a remote or hosted one).
	describe.each(AGENT_MODES)('the same panel for a %s agent', (mode) => {
		const fields = agentModeFields(mode);
		const modeProps = {
			isSshEnabled: Boolean(fields.sessionSshRemoteConfig?.enabled),
			sshRemoteId: fields.sshRemoteId ?? undefined,
		};
		const agentsGet = () =>
			(window as unknown as { maestro: { agents: { get: ReturnType<typeof vi.fn> } } }).maestro
				.agents.get;

		beforeEach(() => {
			// The remote resolves the same binary this computer does.
			agentsGet().mockResolvedValue({ available: true, path: '/usr/local/bin/claude' });
		});
		afterEach(() => {
			agentsGet().mockResolvedValue(null);
		});

		it('reads the same Path label, value, hint and controls', async () => {
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						...modeProps,
						onRefreshAgent: vi.fn(),
						onEnableMaestroPChange: vi.fn(),
						onMaestroPModeChange: vi.fn(),
						enableMaestroP: true,
						maestroPMode: 'interactive',
					})}
				/>
			);

			expect(screen.getByText('Path')).toBeInTheDocument();
			expect(screen.queryByText('Remote Command')).not.toBeInTheDocument();
			expect(await screen.findByDisplayValue('/usr/local/bin/claude')).toBeInTheDocument();
			expect(screen.getByPlaceholderText('/path/to/claude')).toBeInTheDocument();
			expect(
				screen.getByText('Path to the claude binary. Edit to override the auto-detected path.')
			).toBeInTheDocument();
			expect(screen.getByText('Detect')).toBeInTheDocument();
			expect(screen.queryByText('Re-check')).not.toBeInTheDocument();
			for (const label of ['claude -p', 'TUI Wrapper', 'Dynamic']) {
				expect(screen.getByText(label)).toBeInTheDocument();
			}
			expect(screen.getByText('Maestro-P Path (optional)')).toBeInTheDocument();
			expect(screen.queryByText(/remote host/)).not.toBeInTheDocument();
		});

		it('runs Detect where the agent runs', async () => {
			const onRefreshAgent = vi.fn();
			render(<AgentConfigPanel {...createDefaultProps({ ...modeProps, onRefreshAgent })} />);
			const callsBefore = agentsGet().mock.calls.length;
			fireEvent.click(screen.getByText('Detect'));
			if (modeProps.isSshEnabled) {
				await waitFor(() => expect(agentsGet().mock.calls.length).toBeGreaterThan(callsBefore));
				expect(agentsGet()).toHaveBeenLastCalledWith('claude-code', 'r1');
				expect(onRefreshAgent).not.toHaveBeenCalled();
			} else {
				expect(onRefreshAgent).toHaveBeenCalledTimes(1);
				expect(agentsGet().mock.calls.length).toBe(callsBefore);
			}
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
			// default selection, with the same hint a local TUI agent reads.
			render(
				<AgentConfigPanel
					{...createDefaultProps({ onEnableMaestroPChange: vi.fn(), isSshEnabled: true })}
				/>
			);

			const tuiButton = screen.getByText('TUI Wrapper').closest('button');
			const apiButton = screen.getByText('claude -p').closest('button');
			expect(tuiButton?.className).toContain('ring-2');
			expect(apiButton?.className).not.toContain('ring-2');
			expect(screen.queryByText(/remote host/)).not.toBeInTheDocument();
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

		it('keeps the TUI option, runs API and says why when the remote has no maestro-p', async () => {
			// The remote probe reports maestro-p is absent: TUI can't run there, so
			// an unconfigured agent runs API, the option stays, and the reason shows.
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

			// Once the async probe resolves, the agent runs API; TUI stays listed and
			// choosing it is refused with the reason.
			await waitFor(() =>
				expect(
					(window as unknown as { maestro: { agents: { getRemoteMaestroPAvailable: any } } })
						.maestro.agents.getRemoteMaestroPAvailable
				).toHaveBeenCalled()
			);
			const apiButton = screen.getByText('claude -p').closest('button');
			await waitFor(() => expect(apiButton?.className).toContain('ring-2'));
			fireEvent.click(screen.getByText('TUI Wrapper'));
			expect(screen.getByText(/maestro-p was not found on the PATH/)).toBeInTheDocument();
			expect(apiButton?.className).toContain('ring-2');
			(
				window as unknown as {
					maestro: { agents: { getRemoteMaestroPAvailable: ReturnType<typeof vi.fn> } };
				}
			).maestro.agents.getRemoteMaestroPAvailable.mockResolvedValue(null);
		});

		it('links to the maestro-p install page from the TUI refusal', async () => {
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

			await waitFor(() =>
				expect(screen.getByText('claude -p').closest('button')?.className).toContain('ring-2')
			);
			fireEvent.click(screen.getByText('TUI Wrapper'));
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

		it('re-probes maestro-p with force when Detect is clicked for a remote agent', async () => {
			const probeFn = (
				window as unknown as {
					maestro: { agents: { getRemoteMaestroPAvailable: ReturnType<typeof vi.fn> } };
				}
			).maestro.agents.getRemoteMaestroPAvailable;
			// First probe (mount): maestro-p absent. After the user installs it on the
			// remote and clicks Detect, the forced re-probe reports it present.
			probeFn.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

			render(
				<AgentConfigPanel
					{...createDefaultProps({
						onEnableMaestroPChange: vi.fn(),
						onRefreshAgent: vi.fn(),
						isSshEnabled: true,
						sshRemoteId: 'remote-just-got-maestro-p',
					})}
				/>
			);

			await waitFor(() =>
				expect(screen.getByText('claude -p').closest('button')?.className).toContain('ring-2')
			);
			fireEvent.click(screen.getByText('TUI Wrapper'));
			expect(screen.getByText(/maestro-p was not found on the PATH/)).toBeInTheDocument();
			expect(probeFn).toHaveBeenLastCalledWith('remote-just-got-maestro-p', false);
			// There is no separate Re-check control: Detect is the one detection button.
			expect(screen.queryByText('Re-check')).not.toBeInTheDocument();

			fireEvent.click(screen.getByText('Detect'));

			await waitFor(() =>
				expect(probeFn).toHaveBeenLastCalledWith('remote-just-got-maestro-p', true)
			);
			await waitFor(() =>
				expect(screen.queryByText(/maestro-p was not found on the PATH/)).not.toBeInTheDocument()
			);

			probeFn.mockResolvedValue(null);
		});

		it('keeps Dynamic in the list for an SSH agent and refuses it with its reason when chosen', () => {
			const onEnableMaestroPChange = vi.fn();
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						onEnableMaestroPChange,
						isSshEnabled: true,
						enableMaestroP: false,
					})}
				/>
			);

			expect(screen.getByText('Dynamic')).toBeInTheDocument();
			fireEvent.click(screen.getByText('Dynamic'));
			expect(onEnableMaestroPChange).not.toHaveBeenCalled();
			expect(screen.getByRole('status')).toHaveTextContent(/Dynamic is not available/);
			expect(screen.getByText('claude -p').closest('button')?.className).toContain('ring-2');
		});

		it('shows the Maestro-P Path field for an SSH TUI agent, refused with its reason', () => {
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

			expect(screen.getByText('Maestro-P Path (optional)')).toBeInTheDocument();
			expect(screen.getByLabelText('Maestro-P Path (optional)')).toBeDisabled();
			expect(screen.getByText(/runs maestro-p from the PATH of the computer/)).toBeInTheDocument();
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

		it('shows no Time Limits / API Limits pill next to the selector', () => {
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

			expect(screen.getByText('Claude Token Source')).toBeInTheDocument();
			expect(screen.queryByText('API Limits')).not.toBeInTheDocument();
			expect(screen.queryByText('Time Limits')).not.toBeInTheDocument();
		});
	});
});

// =============================================================================
// CODEX TRANSPORT SELECTOR TESTS
// =============================================================================

describe('AgentConfigPanel - Codex Transport selector', () => {
	const codexAgent = () =>
		createMockAgent({
			id: 'codex',
			name: 'Codex',
			path: '/usr/local/bin/codex',
			binaryName: 'codex',
		});

	it('is hidden for a non-Codex agent even when the handler is supplied', () => {
		render(<AgentConfigPanel {...createDefaultProps({ onCodexTransportChange: vi.fn() })} />);

		expect(screen.queryByTestId('codex-transport-option')).not.toBeInTheDocument();
		expect(screen.queryByText('codex exec')).not.toBeInTheDocument();
	});

	it('is hidden for a Codex agent when no surface persists the value', () => {
		render(<AgentConfigPanel {...createDefaultProps({ agent: codexAgent() })} />);

		expect(screen.queryByTestId('codex-transport-option')).not.toBeInTheDocument();
	});

	it('defaults a Codex agent to codex exec', () => {
		render(
			<AgentConfigPanel
				{...createDefaultProps({ agent: codexAgent(), onCodexTransportChange: vi.fn() })}
			/>
		);

		expect(screen.getByText('Codex Transport')).toBeInTheDocument();
		const standard = screen.getByText('codex exec').closest('button');
		const appServer = screen.getByText('codex app-server').closest('button');
		expect(standard?.className).toContain('ring-2');
		expect(appServer?.className).not.toContain('ring-2');
		// The help text names the experimental status and the turns that stay on exec.
		expect(screen.getByText(/codex app-server is experimental/)).toBeInTheDocument();
		expect(
			screen.getByText(/SSH, image, Auto Run, and Cue turns keep using codex exec/)
		).toBeInTheDocument();
	});

	it('reports app-server when the user picks it', () => {
		const onCodexTransportChange = vi.fn();
		render(
			<AgentConfigPanel {...createDefaultProps({ agent: codexAgent(), onCodexTransportChange })} />
		);

		fireEvent.click(screen.getByText('codex app-server'));

		expect(onCodexTransportChange).toHaveBeenCalledWith('app-server');
	});

	it('shows a stored app-server choice as selected with the same hint over SSH', () => {
		render(
			<AgentConfigPanel
				{...createDefaultProps({
					agent: codexAgent(),
					codexTransport: 'app-server',
					onCodexTransportChange: vi.fn(),
					isSshEnabled: true,
				})}
			/>
		);

		const appServer = screen.getByText('codex app-server').closest('button');
		expect(appServer?.className).toContain('ring-2');
		expect(screen.queryByText(/This agent runs over SSH/)).not.toBeInTheDocument();
		expect(screen.getByText(/SSH, image, Auto Run, and Cue turns keep using/)).toBeInTheDocument();
	});
});

describe('AgentConfigPanel - native control selector', () => {
	const qwenAgent = () =>
		createMockAgent({
			id: 'qwen3-coder',
			name: 'Qwen3 Coder',
			path: '/usr/local/bin/qwen',
			binaryName: 'qwen',
		});

	it('defaults to current and reports a native selection', () => {
		const onHarnessControlModeChange = vi.fn();
		render(
			<AgentConfigPanel
				{...createDefaultProps({ agent: qwenAgent(), onHarnessControlModeChange })}
			/>
		);

		expect(screen.getByText('Control Mode')).toBeInTheDocument();
		expect(screen.getByText('current (default)').closest('button')?.className).toContain('ring-2');
		fireEvent.click(screen.getByText('native control'));
		expect(onHarnessControlModeChange).toHaveBeenCalledWith('native');
	});

	it.each(['claude-code', 'copilot-cli'])('offers native SDK control for %s', (agentId) => {
		render(
			<AgentConfigPanel
				{...createDefaultProps({
					agent: createMockAgent({ id: agentId, name: agentId, binaryName: agentId }),
					onHarnessControlModeChange: vi.fn(),
				})}
			/>
		);
		expect(screen.getByText('Control Mode')).toBeInTheDocument();
		expect(screen.getByText('native control')).toBeInTheDocument();
	});

	it('shows a stored native choice and hides the selector for unsupported providers', () => {
		const { rerender } = render(
			<AgentConfigPanel
				{...createDefaultProps({
					agent: qwenAgent(),
					harnessControlMode: 'native',
					onHarnessControlModeChange: vi.fn(),
				})}
			/>
		);
		expect(screen.getByText('native control').closest('button')?.className).toContain('ring-2');

		rerender(
			<AgentConfigPanel
				{...createDefaultProps({
					agent: createMockAgent({ id: 'codex', name: 'Codex', binaryName: 'codex' }),
					onHarnessControlModeChange: vi.fn(),
				})}
			/>
		);
		expect(screen.queryByTestId('harness-control-mode-option')).not.toBeInTheDocument();
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

	// The chooser lists the installations found where the agent runs: this
	// computer for a local agent, the SSH remote for a remote or hosted one.
	it.each(AGENT_MODES)(
		'lists the installations found where a %s agent runs, with the same label',
		async (mode) => {
			const fields = agentModeFields(mode);
			const isSshEnabled = Boolean(fields.sessionSshRemoteConfig?.enabled);
			const agentsGet = (
				window as unknown as { maestro: { agents: { get: ReturnType<typeof vi.fn> } } }
			).maestro.agents.get;
			agentsGet.mockResolvedValue({ available: true, path: CODEX_PATHS[0], allPaths: CODEX_PATHS });
			try {
				// A remote agent's own computer found nothing: only the remote's list may show.
				renderWithPaths(
					{ isSshEnabled, sshRemoteId: fields.sshRemoteId ?? undefined },
					isSshEnabled ? { allPaths: undefined } : {}
				);
				expect(await screen.findByText('Detected installations (3)')).toBeInTheDocument();
				for (const p of CODEX_PATHS) {
					expect(screen.getByRole('option', { name: p })).toBeInTheDocument();
				}
				if (isSshEnabled) expect(agentsGet).toHaveBeenCalledWith('codex', 'r1');
			} finally {
				agentsGet.mockResolvedValue(null);
			}
		}
	);

	it("never lists this computer's installations for an agent that runs over SSH", async () => {
		renderWithPaths({ isSshEnabled: true, sshRemoteId: 'r1' });
		await act(async () => {});
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

	describe('Advanced (.env) env var mode', () => {
		const MODE_KEY = 'envVarsEditor.advancedMode';

		beforeEach(() => {
			// jsdom here ships no working Storage, so the remembered mode needs
			// the shared in-memory stand-in. A fresh install is also the reset.
			installLocalStorageMock();
		});

		// The choice is remembered, so leaving it set would flip every later
		// test in this file onto the textarea.
		afterEach(() => {
			installLocalStorageMock();
		});

		const openAdvanced = () => fireEvent.click(screen.getByRole('radio', { name: 'Advanced' }));
		const textarea = () => screen.getByTestId('env-vars-dotenv-textarea') as HTMLTextAreaElement;

		it('offers no toggle to a consumer that cannot replace the record whole', () => {
			window.localStorage.setItem(MODE_KEY, 'true');
			render(<AgentConfigPanel {...createDefaultProps({ customEnvVars: { FOO: 'bar' } })} />);

			expect(screen.queryByRole('radio', { name: 'Advanced' })).not.toBeInTheDocument();
			// The remembered preference must not strand it on a mode it cannot commit from.
			expect(screen.queryByTestId('env-vars-dotenv-textarea')).not.toBeInTheDocument();
			expect(screen.getByPlaceholderText('VARIABLE_NAME')).toHaveValue('FOO');
		});

		it('shows the variables as text and replaces the record on edit', () => {
			const onEnvVarsReplace = vi.fn();
			render(
				<AgentConfigPanel
					{...createDefaultProps({ customEnvVars: { FOO: 'bar' }, onEnvVarsReplace })}
				/>
			);

			openAdvanced();
			expect(textarea()).toHaveValue('FOO=bar');
			expect(screen.queryByPlaceholderText('VARIABLE_NAME')).not.toBeInTheDocument();
			expect(screen.queryByText('Add Variable')).not.toBeInTheDocument();

			fireEvent.change(textarea(), { target: { value: 'FOO=bar\nexport NEW=1\n# OFF=2' } });

			// No parked record was passed, so the commented line is only a comment.
			expect(onEnvVarsReplace).toHaveBeenLastCalledWith({ FOO: 'bar', NEW: '1' }, {});
		});

		it('round-trips parked variables when the consumer can park', () => {
			const onEnvVarsReplace = vi.fn();
			render(
				<AgentConfigPanel
					{...createDefaultProps({
						customEnvVars: { FOO: 'bar' },
						customEnvVarsDisabled: { OFF: 'x' },
						onEnvVarToggle: vi.fn(),
						onEnvVarsReplace,
					})}
				/>
			);

			openAdvanced();
			expect(textarea()).toHaveValue('FOO=bar\n# OFF=x');

			fireEvent.change(textarea(), { target: { value: '# FOO=bar\nOFF=x' } });

			expect(onEnvVarsReplace).toHaveBeenLastCalledWith({ OFF: 'x' }, { FOO: 'bar' });
		});

		it('accepts the same values the rows accept, with no extra value rule', () => {
			// The per-agent rows do not validate values, so the text mode must not
			// drop a variable the rows already hold.
			const onEnvVarsReplace = vi.fn();
			render(
				<AgentConfigPanel
					{...createDefaultProps({ customEnvVars: { A: '$HOME/bin' }, onEnvVarsReplace })}
				/>
			);
			openAdvanced();

			fireEvent.change(textarea(), { target: { value: 'A=$HOME/bin\nB=1' } });

			expect(onEnvVarsReplace).toHaveBeenLastCalledWith({ A: '$HOME/bin', B: '1' }, {});
			expect(screen.queryByTestId('env-vars-dotenv-errors')).not.toBeInTheDocument();
		});

		it('reports a line that is not an assignment', () => {
			const onEnvVarsReplace = vi.fn();
			render(<AgentConfigPanel {...createDefaultProps({ onEnvVarsReplace })} />);
			openAdvanced();

			fireEvent.change(textarea(), { target: { value: 'GOOD=1\nnope' } });

			expect(onEnvVarsReplace).toHaveBeenLastCalledWith({ GOOD: '1' }, {});
			expect(screen.getByTestId('env-vars-dotenv-errors')).toHaveTextContent(
				'Line 2 not saved: Expected KEY=value.'
			);
		});

		it('persists on blur the way the value fields do', () => {
			const onEnvVarsBlur = vi.fn();
			render(
				<AgentConfigPanel {...createDefaultProps({ onEnvVarsReplace: vi.fn(), onEnvVarsBlur })} />
			);
			openAdvanced();

			fireEvent.blur(textarea());

			expect(onEnvVarsBlur).toHaveBeenCalledTimes(1);
			// No FocusEvent forwarded: a stray event arg was once saved as a value (MAESTRO-11C).
			expect(onEnvVarsBlur).toHaveBeenCalledWith();
		});

		it('keeps the read-only built-in variables on screen', () => {
			render(
				<AgentConfigPanel
					{...createDefaultProps({ onEnvVarsReplace: vi.fn(), showBuiltInEnvVars: true })}
				/>
			);
			openAdvanced();

			expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
		});
	});
});

// =============================================================================
// BLUR CALLBACK ARGUMENTS (MAESTRO-11C)
// =============================================================================

describe('AgentConfigPanel blur callbacks', () => {
	// The blur props are typed as no-argument callbacks, and Director's Notes hands
	// one persist function (whose optional first parameter is a path) to all of
	// them. Forwarding the FocusEvent stored the event as customPath, and the
	// settings IPC write threw "An object could not be cloned".
	it('calls onCustomArgsBlur with no arguments', () => {
		const onCustomArgsBlur = vi.fn();
		render(<AgentConfigPanel {...createDefaultProps({ onCustomArgsBlur })} />);

		fireEvent.blur(screen.getByPlaceholderText('--flag value --another-flag'));

		expect(onCustomArgsBlur).toHaveBeenCalledTimes(1);
		expect(onCustomArgsBlur).toHaveBeenCalledWith();
	});

	it('calls onEnvVarsBlur with no arguments when an env var value blurs', () => {
		const onEnvVarsBlur = vi.fn();
		render(
			<AgentConfigPanel
				{...createDefaultProps({ onEnvVarsBlur, customEnvVars: { MY_FLAG: 'on' } })}
			/>
		);

		fireEvent.blur(screen.getByDisplayValue('on'));

		expect(onEnvVarsBlur).toHaveBeenCalled();
		for (const call of onEnvVarsBlur.mock.calls) {
			expect(call).toEqual([]);
		}
	});
});
