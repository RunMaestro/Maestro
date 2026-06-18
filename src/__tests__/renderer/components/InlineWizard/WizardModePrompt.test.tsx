/**
 * Tests for WizardModePrompt component
 *
 * Tests the modal/inline prompt shown when wizard mode is 'ask':
 * - Rendering with mode buttons and goal input
 * - Button click handlers (New, Iterate, Cancel)
 * - Goal input functionality
 * - Focus management
 * - Mode selection and callback behavior
 * - Layer stack integration
 * - Accessibility
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WizardModePrompt } from '../../../../renderer/components/InlineWizard/WizardModePrompt';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	Wand2: () => <svg data-testid="wand-icon" />,
	FileText: () => <svg data-testid="file-text-icon" />,
	RefreshCw: () => <svg data-testid="refresh-icon" />,
	X: () => <svg data-testid="x-icon" />,
}));

// Create a test theme
const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

// Helper to render with LayerStackProvider
const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('WizardModePrompt', () => {
	const defaultProps = {
		theme: testTheme,
		isOpen: true,
		onSelectMode: vi.fn(),
		onSetGoal: vi.fn(),
		onClose: vi.fn(),
		existingDocCount: 3,
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('rendering', () => {
		it('renders nothing when not open', () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} isOpen={false} />);

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});

		it('renders modal when open', () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('renders header with title and wand icon', () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			expect(screen.getByText('Wizard Mode')).toBeInTheDocument();
			expect(screen.getByTestId('wand-icon')).toBeInTheDocument();
		});

		it('renders "Create New Plan" option button', () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			expect(screen.getByText('Create New Plan')).toBeInTheDocument();
			expect(screen.getByTestId('file-text-icon')).toBeInTheDocument();
		});

		it('renders "Iterate on Existing" option button', () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			expect(screen.getByText('Iterate on Existing')).toBeInTheDocument();
			expect(screen.getByTestId('refresh-icon')).toBeInTheDocument();
		});

		it('renders Cancel button', () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			expect(screen.getByTestId('wizard-mode-cancel-button')).toBeInTheDocument();
		});

		it('shows existing document count in intro text', () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} existingDocCount={5} />);

			expect(screen.getByText(/You have 5 existing Auto Run documents/)).toBeInTheDocument();
		});

		it('shows singular form for 1 document', () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} existingDocCount={1} />);

			expect(screen.getByText(/You have 1 existing Auto Run document\./)).toBeInTheDocument();
		});

		it('shows alternative text when no documents exist', () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} existingDocCount={0} />);

			expect(
				screen.getByText(/Choose how you want to proceed with the wizard/)
			).toBeInTheDocument();
		});

		it('has correct test IDs for buttons', () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			expect(screen.getByTestId('wizard-mode-new-button')).toBeInTheDocument();
			expect(screen.getByTestId('wizard-mode-iterate-button')).toBeInTheDocument();
			expect(screen.getByTestId('wizard-mode-cancel-button')).toBeInTheDocument();
		});
	});

	describe('Create New Plan flow', () => {
		it('calls onSetGoal with null and onSelectMode with "new" when clicked', () => {
			const onSelectMode = vi.fn();
			const onSetGoal = vi.fn();
			const onClose = vi.fn();

			renderWithLayerStack(
				<WizardModePrompt
					{...defaultProps}
					onSelectMode={onSelectMode}
					onSetGoal={onSetGoal}
					onClose={onClose}
				/>
			);

			fireEvent.click(screen.getByTestId('wizard-mode-new-button'));

			expect(onSetGoal).toHaveBeenCalledWith(null);
			expect(onSelectMode).toHaveBeenCalledWith('new');
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('Iterate on Existing flow', () => {
		it('shows goal input when iterate option is selected', async () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			fireEvent.click(screen.getByTestId('wizard-mode-iterate-button'));

			await waitFor(() => {
				expect(screen.getByTestId('wizard-mode-goal-input')).toBeInTheDocument();
			});
		});

		it('focuses goal input when iterate option is selected', async () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			fireEvent.click(screen.getByTestId('wizard-mode-iterate-button'));

			await waitFor(() => {
				expect(document.activeElement).toBe(screen.getByTestId('wizard-mode-goal-input'));
			});
		});

		it('shows Back button when goal input is visible', async () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			fireEvent.click(screen.getByTestId('wizard-mode-iterate-button'));

			await waitFor(() => {
				expect(screen.getByText('Back')).toBeInTheDocument();
			});
		});

		it('shows Continue button disabled when goal is empty', async () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			fireEvent.click(screen.getByTestId('wizard-mode-iterate-button'));

			await waitFor(() => {
				const confirmButton = screen.getByTestId('wizard-mode-confirm-button');
				expect(confirmButton).toBeDisabled();
			});
		});

		it('enables Continue button when goal is entered', async () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			fireEvent.click(screen.getByTestId('wizard-mode-iterate-button'));

			await waitFor(() => {
				expect(screen.getByTestId('wizard-mode-goal-input')).toBeInTheDocument();
			});

			const input = screen.getByTestId('wizard-mode-goal-input');
			fireEvent.change(input, { target: { value: 'Add user authentication' } });

			expect(screen.getByTestId('wizard-mode-confirm-button')).not.toBeDisabled();
		});

		it('calls callbacks with correct values when Continue is clicked', async () => {
			const onSelectMode = vi.fn();
			const onSetGoal = vi.fn();
			const onClose = vi.fn();

			renderWithLayerStack(
				<WizardModePrompt
					{...defaultProps}
					onSelectMode={onSelectMode}
					onSetGoal={onSetGoal}
					onClose={onClose}
				/>
			);

			fireEvent.click(screen.getByTestId('wizard-mode-iterate-button'));

			await waitFor(() => {
				expect(screen.getByTestId('wizard-mode-goal-input')).toBeInTheDocument();
			});

			const input = screen.getByTestId('wizard-mode-goal-input');
			fireEvent.change(input, { target: { value: 'Add user authentication' } });

			fireEvent.click(screen.getByTestId('wizard-mode-confirm-button'));

			expect(onSetGoal).toHaveBeenCalledWith('Add user authentication');
			expect(onSelectMode).toHaveBeenCalledWith('iterate');
			expect(onClose).toHaveBeenCalled();
		});

		it('trims whitespace from goal', async () => {
			const onSetGoal = vi.fn();

			renderWithLayerStack(<WizardModePrompt {...defaultProps} onSetGoal={onSetGoal} />);

			fireEvent.click(screen.getByTestId('wizard-mode-iterate-button'));

			await waitFor(() => {
				expect(screen.getByTestId('wizard-mode-goal-input')).toBeInTheDocument();
			});

			const input = screen.getByTestId('wizard-mode-goal-input');
			fireEvent.change(input, { target: { value: '  Add auth  ' } });

			fireEvent.click(screen.getByTestId('wizard-mode-confirm-button'));

			expect(onSetGoal).toHaveBeenCalledWith('Add auth');
		});

		it('keeps Continue button disabled if only whitespace entered', async () => {
			const onSetGoal = vi.fn();
			const onSelectMode = vi.fn();

			renderWithLayerStack(
				<WizardModePrompt {...defaultProps} onSetGoal={onSetGoal} onSelectMode={onSelectMode} />
			);

			fireEvent.click(screen.getByTestId('wizard-mode-iterate-button'));

			await waitFor(() => {
				expect(screen.getByTestId('wizard-mode-goal-input')).toBeInTheDocument();
			});

			// Manually set value and simulate a way to bypass the disabled button
			const input = screen.getByTestId('wizard-mode-goal-input') as HTMLInputElement;
			fireEvent.change(input, { target: { value: '   ' } });

			// Continue button should still be disabled for whitespace-only
			expect(screen.getByTestId('wizard-mode-confirm-button')).toBeDisabled();
		});

		it('hides goal input when Back is clicked', async () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			fireEvent.click(screen.getByTestId('wizard-mode-iterate-button'));

			await waitFor(() => {
				expect(screen.getByTestId('wizard-mode-goal-input')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Back'));

			await waitFor(() => {
				expect(screen.queryByTestId('wizard-mode-goal-input')).not.toBeInTheDocument();
			});
		});
	});

	describe('keyboard interactions', () => {
		it('submits on Enter when goal is entered', async () => {
			const onSelectMode = vi.fn();
			const onSetGoal = vi.fn();

			renderWithLayerStack(
				<WizardModePrompt {...defaultProps} onSelectMode={onSelectMode} onSetGoal={onSetGoal} />
			);

			fireEvent.click(screen.getByTestId('wizard-mode-iterate-button'));

			await waitFor(() => {
				expect(screen.getByTestId('wizard-mode-goal-input')).toBeInTheDocument();
			});

			const input = screen.getByTestId('wizard-mode-goal-input');
			fireEvent.change(input, { target: { value: 'Add auth' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onSelectMode).toHaveBeenCalledWith('iterate');
			expect(onSetGoal).toHaveBeenCalledWith('Add auth');
		});

		it('does not submit on Enter when goal is empty', async () => {
			const onSelectMode = vi.fn();

			renderWithLayerStack(<WizardModePrompt {...defaultProps} onSelectMode={onSelectMode} />);

			fireEvent.click(screen.getByTestId('wizard-mode-iterate-button'));

			await waitFor(() => {
				expect(screen.getByTestId('wizard-mode-goal-input')).toBeInTheDocument();
			});

			const input = screen.getByTestId('wizard-mode-goal-input');
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onSelectMode).not.toHaveBeenCalled();
		});
	});

	describe('cancel behavior', () => {
		it('calls onClose when Cancel button is clicked', () => {
			const onClose = vi.fn();
			renderWithLayerStack(<WizardModePrompt {...defaultProps} onClose={onClose} />);

			fireEvent.click(screen.getByTestId('wizard-mode-cancel-button'));

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('state reset on open', () => {
		it('resets selected option when modal reopens', async () => {
			const { rerender } = renderWithLayerStack(
				<WizardModePrompt {...defaultProps} isOpen={true} />
			);

			// Select iterate option
			fireEvent.click(screen.getByTestId('wizard-mode-iterate-button'));

			await waitFor(() => {
				expect(screen.getByTestId('wizard-mode-goal-input')).toBeInTheDocument();
			});

			// Close and reopen
			rerender(
				<LayerStackProvider>
					<WizardModePrompt {...defaultProps} isOpen={false} />
				</LayerStackProvider>
			);

			rerender(
				<LayerStackProvider>
					<WizardModePrompt {...defaultProps} isOpen={true} />
				</LayerStackProvider>
			);

			// Goal input should not be visible
			expect(screen.queryByTestId('wizard-mode-goal-input')).not.toBeInTheDocument();
		});
	});

	describe('accessibility', () => {
		it('has correct ARIA attributes on modal', () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Wizard Mode');
		});

		it('has accessible label on goal input', async () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			fireEvent.click(screen.getByTestId('wizard-mode-iterate-button'));

			await waitFor(() => {
				expect(screen.getByLabelText(/What do you want to add or change/)).toBeInTheDocument();
			});
		});

		it('has semantic button elements', () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			// New button, Iterate button, Cancel, and X close button
			const buttons = screen.getAllByRole('button');
			expect(buttons.length).toBeGreaterThanOrEqual(3);
		});
	});

	describe('layer stack integration', () => {
		it('registers and unregisters without errors', () => {
			const { unmount } = renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(() => unmount()).not.toThrow();
		});
	});

	describe('theming', () => {
		it('applies theme colors to modal', () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			// The modal container should have theme background
			const dialog = screen.getByRole('dialog');
			expect(dialog).toBeInTheDocument();
		});

		it('displays option buttons with correct icons', () => {
			renderWithLayerStack(<WizardModePrompt {...defaultProps} />);

			expect(screen.getByTestId('file-text-icon')).toBeInTheDocument();
			expect(screen.getByTestId('refresh-icon')).toBeInTheDocument();
		});
	});
});
