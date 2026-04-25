/**
 * @fileoverview Tests for AgentConfigPanel component
 * Tests: Built-in environment variables display, custom env vars, agent configuration
 *
 * Regression test for: MAESTRO_SESSION_RESUMED env var display in group chat moderator customization
 */

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
});
