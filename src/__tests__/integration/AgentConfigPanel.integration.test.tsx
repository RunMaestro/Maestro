/**
 * @fileoverview Tests for AgentConfigPanel component
 * Tests: Built-in environment variables display, custom env vars, agent configuration
 *
 * Regression test for: MAESTRO_SESSION_RESUMED env var display in group chat moderator customization
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentConfigPanel } from '../../renderer/components/shared/AgentConfigPanel';
import type { Theme, AgentConfig } from '../../renderer/types';
import { logger } from '../../renderer/utils/logger';

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
}));

// =============================================================================
// TEST HELPERS
// =============================================================================

function createMockTheme(): Theme {
	return {
		id: 'test-theme',
		name: 'Test Theme',
		colors: {
			bgMain: '#1a1a1a',
			bgSidebar: '#252525',
			bgActivity: '#333333',
			textMain: '#ffffff',
			textDim: '#888888',
			accent: '#6366f1',
			border: '#333333',
			success: '#22c55e',
			error: '#ef4444',
			warning: '#f59e0b',
			contextFree: '#22c55e',
			contextMedium: '#f59e0b',
			contextHigh: '#ef4444',
		},
	};
}

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

const modelCapableAgent = createMockAgent({
	capabilities: { supportsModelSelection: true } as NonNullable<AgentConfig['capabilities']>,
	configOptions: [
		{
			key: 'model',
			type: 'text',
			label: 'Model',
			description: 'Model to use for requests',
			default: 'claude-3-sonnet',
		},
		{
			key: 'contextWindow',
			type: 'number',
			label: 'Context Window',
			description: 'Maximum context size',
			default: 200000,
		},
		{
			key: 'streaming',
			type: 'checkbox',
			label: 'Streaming',
			description: 'Enable streaming responses',
			default: false,
		},
		{
			key: 'approval',
			type: 'select',
			label: 'Approval Mode',
			description: 'Controls command approval behavior',
			default: 'suggest',
			options: ['suggest', 'auto'],
		},
	],
});

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

		it('toggles the built-in environment variable help text', async () => {
			render(<AgentConfigPanel {...createDefaultProps({ showBuiltInEnvVars: true })} />);

			const helpButton = screen.getByTitle('What is this?');

			fireEvent.click(helpButton);
			expect(screen.getByText(/skip initialization on resumed sessions/i)).toBeInTheDocument();

			fireEvent.click(helpButton);
			expect(
				screen.queryByText(/skip initialization on resumed sessions/i)
			).not.toBeInTheDocument();

			fireEvent.click(helpButton);
			expect(screen.getByText(/skip initialization on resumed sessions/i)).toBeInTheDocument();

			fireEvent.blur(helpButton);
			await waitFor(() =>
				expect(
					screen.queryByText(/skip initialization on resumed sessions/i)
				).not.toBeInTheDocument()
			);
		});

		it('defers environment variable key changes until blur and updates values immediately', () => {
			const props = createDefaultProps({ customEnvVars: { OLD_KEY: 'old-value' } });

			render(<AgentConfigPanel {...props} />);

			const keyInput = screen.getByDisplayValue('OLD_KEY');
			const valueInput = screen.getByDisplayValue('old-value');

			fireEvent.change(keyInput, { target: { value: 'NEW_KEY' } });
			expect(props.onEnvVarKeyChange).not.toHaveBeenCalled();

			fireEvent.change(valueInput, { target: { value: 'new-value' } });
			expect(props.onEnvVarValueChange).toHaveBeenCalledWith('OLD_KEY', 'new-value');

			fireEvent.blur(keyInput);
			expect(props.onEnvVarKeyChange).toHaveBeenCalledWith('OLD_KEY', 'NEW_KEY', 'old-value');
			expect(props.onEnvVarsBlur).toHaveBeenCalled();
		});

		it('blurs unchanged environment variable keys without renaming them', () => {
			const props = createDefaultProps({ customEnvVars: { KEEP_KEY: 'keep-value' } });

			render(<AgentConfigPanel {...props} />);

			fireEvent.blur(screen.getByDisplayValue('KEEP_KEY'));

			expect(props.onEnvVarKeyChange).not.toHaveBeenCalled();
			expect(props.onEnvVarsBlur).toHaveBeenCalledTimes(1);
		});

		it('handles add and remove environment variable actions', () => {
			const props = createDefaultProps({ customEnvVars: { REMOVE_ME: '1' } });

			render(<AgentConfigPanel {...props} />);

			fireEvent.click(screen.getByTitle('Remove variable'));
			expect(props.onEnvVarRemove).toHaveBeenCalledWith('REMOVE_ME');

			fireEvent.click(screen.getByText('Add Variable'));
			expect(props.onEnvVarAdd).toHaveBeenCalled();
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

		it('should not show a path reset button when custom path differs from detected path', () => {
			render(
				<AgentConfigPanel {...createDefaultProps({ customPath: '/custom/path/to/claude' })} />
			);

			expect(screen.queryByText('Reset')).not.toBeInTheDocument();
		});

		it('should not show a path reset button when custom path matches detected path', () => {
			render(<AgentConfigPanel {...createDefaultProps({ customPath: '/usr/local/bin/claude' })} />);

			expect(screen.queryByText('Reset')).not.toBeInTheDocument();
		});

		it('should NOT show Reset button when no custom path is set', () => {
			render(<AgentConfigPanel {...createDefaultProps({ customPath: '' })} />);

			expect(screen.queryByText('Reset')).not.toBeInTheDocument();
		});

		it('should render custom arguments input section', () => {
			render(<AgentConfigPanel {...createDefaultProps()} />);

			expect(screen.getByText('Custom Arguments (optional)')).toBeInTheDocument();
		});

		it('should render environment variables section', () => {
			render(<AgentConfigPanel {...createDefaultProps()} />);

			expect(screen.getByText('Environment Variables (optional)')).toBeInTheDocument();
		});

		it('wires path, custom argument, and detect actions', () => {
			const props = createDefaultProps({
				customPath: '/custom/claude',
				customArgs: '--dangerously-skip-permissions',
				onRefreshAgent: vi.fn(),
			});

			render(<AgentConfigPanel {...props} />);

			fireEvent.change(screen.getByDisplayValue('/custom/claude'), {
				target: { value: '/new/claude' },
			});
			expect(props.onCustomPathChange).toHaveBeenCalledWith('/new/claude');

			fireEvent.blur(screen.getByDisplayValue('/custom/claude'));
			expect(props.onCustomPathBlur).toHaveBeenCalled();

			fireEvent.change(screen.getByDisplayValue('--dangerously-skip-permissions'), {
				target: { value: '--verbose' },
			});
			expect(props.onCustomArgsChange).toHaveBeenCalledWith('--verbose');

			fireEvent.blur(screen.getByDisplayValue('--dangerously-skip-permissions'));
			expect(props.onCustomArgsBlur).toHaveBeenCalled();

			fireEvent.click(screen.getByText('Detect'));
			expect(props.onRefreshAgent).toHaveBeenCalled();
		});

		it('shows an editable remote command field when SSH is enabled without a custom path', () => {
			const props = createDefaultProps({
				isSshEnabled: true,
				agent: createMockAgent({ path: '/usr/local/bin/claude', binaryName: 'claude' }),
			});

			render(<AgentConfigPanel {...props} />);

			expect(screen.getByText('Remote Command')).toBeInTheDocument();
			expect(screen.queryByText('Detect')).not.toBeInTheDocument();

			const commandInput = screen.getByPlaceholderText('claude');
			expect(commandInput).toHaveValue('');
			expect(commandInput).not.toHaveAttribute('readOnly');

			fireEvent.change(commandInput, { target: { value: 'claude-dev' } });
			expect(props.onCustomPathChange).toHaveBeenCalledWith('claude-dev');

			fireEvent.blur(commandInput);
			expect(props.onCustomPathBlur).toHaveBeenCalled();
		});

		it('uses compact spacing and remote custom command copy when SSH has a custom command', () => {
			const { container } = render(
				<AgentConfigPanel
					{...createDefaultProps({
						compact: true,
						customPath: 'claude-dev',
						isSshEnabled: true,
					})}
				/>
			);

			expect(container.firstElementChild).toHaveClass('space-y-2');
			expect(container.querySelector('.p-2.rounded.border')).toBeTruthy();
			expect(screen.getByText('Remote Command')).toBeInTheDocument();
			expect(screen.getByDisplayValue('claude-dev')).toBeInTheDocument();
			expect(screen.queryByTitle('Reset to remote binary name')).not.toBeInTheDocument();
		});

		it('shows refreshing path detection state and falls back to an empty path value', () => {
			const props = createDefaultProps({
				agent: createMockAgent({ path: '' }),
				onRefreshAgent: vi.fn(),
				refreshingAgent: true,
			});

			render(<AgentConfigPanel {...props} />);

			expect(screen.getByTestId('refresh-icon')).toHaveClass('animate-spin');
			expect(screen.getByPlaceholderText('/path/to/claude')).toHaveValue('');
		});

		it('persists number, checkbox, and select config options', () => {
			const props = createDefaultProps({
				agent: modelCapableAgent,
				agentConfig: {
					contextWindow: 150000,
					streaming: false,
					approval: 'suggest',
				},
			});

			const { rerender } = render(<AgentConfigPanel {...props} />);

			const contextWindowInput = screen.getByDisplayValue('150000');
			fireEvent.change(contextWindowInput, { target: { value: '175000' } });
			expect(props.onConfigChange).toHaveBeenCalledWith('contextWindow', 175000);

			rerender(
				<AgentConfigPanel
					{...props}
					agentConfig={{ ...props.agentConfig, contextWindow: 175000 }}
				/>
			);
			fireEvent.blur(screen.getByDisplayValue('175000'));
			expect(props.onConfigBlur).toHaveBeenCalledWith('contextWindow', 175000);

			fireEvent.click(screen.getByRole('checkbox'));
			expect(props.onConfigChange).toHaveBeenCalledWith('streaming', true);
			expect(props.onConfigBlur).toHaveBeenCalledWith('streaming', true);

			fireEvent.change(screen.getByRole('combobox'), { target: { value: 'auto' } });
			expect(props.onConfigChange).toHaveBeenCalledWith('approval', 'auto');
			expect(props.onConfigBlur).toHaveBeenCalledWith('approval', 'auto');
		});

		it('normalizes empty and invalid number config values to zero', () => {
			const props = createDefaultProps({
				agent: createMockAgent({
					configOptions: [
						{
							key: 'retries',
							type: 'number',
							label: 'Retries',
							description: 'Retry count',
						},
					],
				}),
				agentConfig: { retries: 5 },
			});

			const { rerender } = render(<AgentConfigPanel {...props} />);

			const retriesInput = screen.getByDisplayValue('5');
			expect(retriesInput).toHaveAttribute('placeholder', '0');

			fireEvent.change(retriesInput, { target: { value: '' } });
			expect(props.onConfigChange).toHaveBeenCalledWith('retries', 0);

			rerender(<AgentConfigPanel {...props} agentConfig={{ retries: '' }} />);
			const emptyRetriesInput = screen.getByRole('spinbutton');
			fireEvent.blur(emptyRetriesInput);
			expect(props.onConfigBlur).toHaveBeenCalledWith('retries', 0);

			Object.defineProperty(emptyRetriesInput, 'value', {
				configurable: true,
				get: () => 'not-a-number',
			});
			fireEvent.change(emptyRetriesInput);
			expect(props.onConfigChange).toHaveBeenCalledTimes(2);
			expect(props.onConfigChange).toHaveBeenLastCalledWith('retries', 0);

			fireEvent.blur(emptyRetriesInput);
			expect(props.onConfigBlur).toHaveBeenCalledTimes(2);
			expect(props.onConfigBlur).toHaveBeenLastCalledWith('retries', 0);
		});

		it('renders select config options without a configured value or default', () => {
			const props = createDefaultProps({
				agent: createMockAgent({
					configOptions: [
						{
							key: 'approval',
							type: 'select',
							label: 'Approval Mode',
							description: 'Controls command approval behavior',
							options: ['manual', 'auto'],
						},
					],
				}),
			});

			render(<AgentConfigPanel {...props} />);

			const approvalSelect = screen.getByRole('combobox');
			expect(approvalSelect).toHaveValue('manual');

			fireEvent.change(approvalSelect, { target: { value: 'manual' } });
			expect(props.onConfigChange).toHaveBeenCalledWith('approval', 'manual');
			expect(props.onConfigBlur).toHaveBeenCalledWith('approval', 'manual');
		});

		it('allows config option changes when blur persistence is unavailable', () => {
			const onConfigChange = vi.fn();
			const props = createDefaultProps({
				agent: modelCapableAgent,
				agentConfig: {
					contextWindow: 150000,
					streaming: false,
					approval: 'suggest',
				},
				onConfigBlur: undefined,
				onConfigChange,
			});

			render(<AgentConfigPanel {...props} />);

			fireEvent.click(screen.getByRole('checkbox'));
			expect(onConfigChange).toHaveBeenCalledWith('streaming', true);

			fireEvent.change(screen.getByRole('combobox'), { target: { value: 'auto' } });
			expect(onConfigChange).toHaveBeenCalledWith('approval', 'auto');
		});

		it('logs asynchronous config persistence failures without throwing', async () => {
			const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
			const rejection = new Error('disk unavailable');
			const props = createDefaultProps({
				agent: createMockAgent({
					configOptions: [
						{
							key: 'streaming',
							type: 'checkbox',
							label: 'Streaming',
							description: 'Enable streaming responses',
							default: false,
						},
					],
				}),
				onConfigBlur: vi.fn(() => Promise.reject(rejection)),
			});

			try {
				render(<AgentConfigPanel {...props} />);

				fireEvent.click(screen.getByRole('checkbox'));

				await waitFor(() => {
					expect(loggerError).toHaveBeenCalledWith(
						'Failed to persist config field "streaming":',
						undefined,
						rejection
					);
				});
			} finally {
				loggerError.mockRestore();
			}
		});

		it('supports model dropdown filtering, selection, and refresh', () => {
			const props = createDefaultProps({
				agent: modelCapableAgent,
				agentConfig: { model: 'claude-3-sonnet' },
				availableModels: ['claude-3-sonnet', 'claude-3-opus'],
				onRefreshModels: vi.fn(),
			});

			render(<AgentConfigPanel {...props} />);

			expect(screen.getByText('2 models available')).toBeInTheDocument();
			fireEvent.click(screen.getByTitle('Refresh available models'));
			expect(props.onRefreshModels).toHaveBeenCalled();

			const modelInput = screen.getByDisplayValue('claude-3-sonnet');
			fireEvent.focus(modelInput);

			fireEvent.change(modelInput, { target: { value: 'opus' } });
			expect(screen.getByText('claude-3-opus')).toBeInTheDocument();
			expect(screen.queryByText('claude-3-sonnet')).not.toBeInTheDocument();

			fireEvent.click(screen.getByText('claude-3-opus'));
			expect(props.onConfigChange).toHaveBeenCalledWith('model', 'claude-3-opus');
			expect(props.onConfigBlur).toHaveBeenCalledWith('model', 'claude-3-opus');
		});

		it('opens the model dropdown from the chevron button without bubbling', () => {
			const onOuterClick = vi.fn();
			const props = createDefaultProps({
				agent: modelCapableAgent,
				agentConfig: { model: 'claude-3-sonnet' },
				availableModels: ['claude-3-sonnet', 'claude-3-opus'],
			});

			render(
				<div onClick={onOuterClick}>
					<AgentConfigPanel {...props} />
				</div>
			);

			const modelInput = screen.getByDisplayValue('claude-3-sonnet');
			const dropdownButton = screen.getByTestId('chevron-down-icon').closest('button')!;

			fireEvent.click(dropdownButton);

			expect(screen.getByRole('button', { name: 'claude-3-sonnet' })).toBeInTheDocument();
			expect(document.activeElement).toBe(modelInput);
			expect(onOuterClick).not.toHaveBeenCalled();
		});

		it('resets model filter text on outside click without committing it', async () => {
			const props = createDefaultProps({
				agent: modelCapableAgent,
				agentConfig: { model: 'claude-3-sonnet' },
				availableModels: ['claude-3-sonnet', 'claude-3-opus'],
			});

			render(<AgentConfigPanel {...props} />);

			const modelInput = screen.getByDisplayValue('claude-3-sonnet');
			fireEvent.focus(modelInput);
			fireEvent.change(modelInput, { target: { value: 'opus' } });
			expect(await screen.findByText('claude-3-opus')).toBeInTheDocument();

			fireEvent.mouseDown(document.body);

			await waitFor(() => {
				expect(screen.queryByText('claude-3-opus')).not.toBeInTheDocument();
				expect(modelInput).toHaveValue('claude-3-sonnet');
			});
			expect(props.onConfigChange).not.toHaveBeenCalled();
		});

		it('keeps the model dropdown open on inside clicks and closes it outside when not filtering', async () => {
			const props = createDefaultProps({
				agent: modelCapableAgent,
				agentConfig: { model: 'claude-3-sonnet' },
				availableModels: ['claude-3-sonnet', 'claude-3-opus'],
			});

			render(<AgentConfigPanel {...props} />);

			const modelInput = screen.getByDisplayValue('claude-3-sonnet');
			const dropdownButton = screen.getByTestId('chevron-down-icon').closest('button')!;
			fireEvent.click(dropdownButton);
			expect(screen.getByRole('button', { name: 'claude-3-sonnet' })).toBeInTheDocument();

			fireEvent.mouseDown(modelInput);
			expect(screen.getByRole('button', { name: 'claude-3-sonnet' })).toBeInTheDocument();

			fireEvent.mouseDown(document.body);

			await waitFor(() => {
				expect(screen.queryByRole('button', { name: 'claude-3-sonnet' })).not.toBeInTheDocument();
			});
			expect(modelInput).toHaveValue('claude-3-sonnet');
			expect(props.onConfigChange).not.toHaveBeenCalled();
		});

		it('does not let the delayed blur overwrite a selected model', async () => {
			const props = createDefaultProps({
				agent: modelCapableAgent,
				agentConfig: { model: 'claude-3-sonnet' },
				availableModels: ['claude-3-sonnet', 'claude-3-opus'],
			});

			render(<AgentConfigPanel {...props} />);

			const modelInput = screen.getByDisplayValue('claude-3-sonnet');
			fireEvent.focus(modelInput);
			fireEvent.change(modelInput, { target: { value: 'opus' } });
			fireEvent.click(await screen.findByText('claude-3-opus'));
			fireEvent.blur(modelInput);

			await new Promise((resolve) => setTimeout(resolve, 200));

			expect(props.onConfigChange).toHaveBeenCalledWith('model', 'claude-3-opus');
			expect(props.onConfigBlur).toHaveBeenCalledTimes(1);
			expect(props.onConfigBlur).toHaveBeenCalledWith('model', 'claude-3-opus');
		});

		it('commits a typed custom model on blur when no dropdown item is selected', async () => {
			const props = createDefaultProps({
				agent: modelCapableAgent,
				agentConfig: { model: 'claude-3-sonnet' },
				availableModels: ['claude-3-sonnet', 'claude-3-opus'],
			});

			render(<AgentConfigPanel {...props} />);

			const modelInput = screen.getByDisplayValue('claude-3-sonnet');
			fireEvent.focus(modelInput);
			fireEvent.change(modelInput, { target: { value: 'local-model' } });
			fireEvent.blur(modelInput);

			await waitFor(() => {
				expect(props.onConfigChange).toHaveBeenCalledWith('model', 'local-model');
				expect(props.onConfigBlur).toHaveBeenCalledWith('model', 'local-model');
			});
		});

		it('commits a cleared model on blur to restore the default model setting', async () => {
			const props = createDefaultProps({
				agent: modelCapableAgent,
				agentConfig: { model: 'claude-3-sonnet' },
				availableModels: ['claude-3-sonnet', 'claude-3-opus'],
			});

			render(<AgentConfigPanel {...props} />);

			const modelInput = screen.getByDisplayValue('claude-3-sonnet');
			fireEvent.focus(modelInput);
			fireEvent.change(modelInput, { target: { value: '' } });
			fireEvent.blur(modelInput);

			await waitFor(() => {
				expect(props.onConfigChange).toHaveBeenCalledWith('model', '');
				expect(props.onConfigBlur).toHaveBeenCalledWith('model', '');
			});
		});

		it('shows model loading and singular available-model copy', () => {
			const { rerender } = render(
				<AgentConfigPanel
					{...createDefaultProps({
						agent: modelCapableAgent,
						availableModels: [],
						loadingModels: true,
						onRefreshModels: vi.fn(),
					})}
				/>
			);

			expect(screen.getByText('Loading available models...')).toBeInTheDocument();
			expect(screen.getByTestId('refresh-icon')).toHaveClass('animate-spin');

			rerender(
				<AgentConfigPanel
					{...createDefaultProps({
						agent: modelCapableAgent,
						availableModels: ['claude-3-sonnet'],
						loadingModels: false,
					})}
				/>
			);

			expect(screen.getByText('1 model available')).toBeInTheDocument();
		});

		it('commits non-model text config values on blur after the parent rerenders', async () => {
			const textAgent = createMockAgent({
				configOptions: [
					{
						key: 'systemPrompt',
						type: 'text',
						label: 'System Prompt',
						description: 'Prompt prefix',
						default: 'default prompt',
					},
				],
			});
			const props = createDefaultProps({
				agent: textAgent,
				agentConfig: { systemPrompt: 'initial prompt' },
			});

			const { rerender } = render(<AgentConfigPanel {...props} />);

			fireEvent.focus(screen.getByDisplayValue('initial prompt'));
			fireEvent.change(screen.getByDisplayValue('initial prompt'), {
				target: { value: 'updated prompt' },
			});
			expect(props.onConfigChange).toHaveBeenCalledWith('systemPrompt', 'updated prompt');

			rerender(<AgentConfigPanel {...props} agentConfig={{ systemPrompt: 'updated prompt' }} />);
			fireEvent.blur(screen.getByDisplayValue('updated prompt'));

			await waitFor(() => {
				expect(props.onConfigBlur).toHaveBeenCalledWith('systemPrompt', 'updated prompt');
			});
		});

		it('handles text config options without a default placeholder', () => {
			const textAgent = createMockAgent({
				configOptions: [
					{
						key: 'systemPrompt',
						type: 'text',
						label: 'System Prompt',
						description: 'Prompt prefix',
					},
				],
			});
			const props = createDefaultProps({ agent: textAgent, agentConfig: { systemPrompt: '' } });

			render(<AgentConfigPanel {...props} />);

			const textInput = screen
				.getAllByRole('textbox')
				.find((input) => input.getAttribute('placeholder') === '');
			expect(textInput).toBeDefined();

			fireEvent.focus(textInput!);
			fireEvent.change(textInput!, { target: { value: 'new prompt' } });

			expect(props.onConfigChange).toHaveBeenCalledWith('systemPrompt', 'new prompt');
		});

		it('cleans up stale environment variable display state after keys are removed', () => {
			const props = createDefaultProps({ customEnvVars: { REMOVE_ME: '1' } });
			const { rerender } = render(<AgentConfigPanel {...props} />);

			expect(screen.getByDisplayValue('REMOVE_ME')).toBeInTheDocument();

			rerender(<AgentConfigPanel {...props} customEnvVars={{ KEEP_ME: '2' }} />);

			expect(screen.queryByDisplayValue('REMOVE_ME')).not.toBeInTheDocument();
			expect(screen.getByDisplayValue('KEEP_ME')).toBeInTheDocument();
		});

		it('keeps pending environment variable key edits when the backing key remains present', () => {
			const props = createDefaultProps({ customEnvVars: { KEEP_ME: '1' } });
			const { rerender } = render(<AgentConfigPanel {...props} />);

			fireEvent.change(screen.getByDisplayValue('KEEP_ME'), { target: { value: 'EDITED_KEY' } });

			rerender(<AgentConfigPanel {...props} customEnvVars={{ KEEP_ME: '2' }} />);

			expect(screen.getByDisplayValue('EDITED_KEY')).toBeInTheDocument();
			expect(screen.getByDisplayValue('2')).toBeInTheDocument();
		});

		it('stops field clicks from bubbling to parent overlays', () => {
			const onOuterClick = vi.fn();
			const props = createDefaultProps({
				customPath: '/custom/claude',
				customArgs: '--verbose',
				customEnvVars: { API_KEY: 'secret' },
				agent: modelCapableAgent,
				agentConfig: {
					model: 'claude-3-sonnet',
					contextWindow: 150000,
					streaming: false,
					approval: 'suggest',
				},
				availableModels: ['claude-3-sonnet', 'claude-3-opus'],
			});

			render(
				<div onClick={onOuterClick}>
					<AgentConfigPanel {...props} />
				</div>
			);

			fireEvent.click(screen.getByDisplayValue('/custom/claude'));
			fireEvent.click(screen.getByDisplayValue('--verbose'));
			fireEvent.click(screen.getByDisplayValue('API_KEY'));
			fireEvent.click(screen.getByDisplayValue('secret'));
			fireEvent.click(screen.getByDisplayValue('claude-3-sonnet'));
			fireEvent.click(screen.getByDisplayValue('150000'));
			fireEvent.click(screen.getByRole('combobox'));

			expect(onOuterClick).not.toHaveBeenCalled();
		});
	});
});
