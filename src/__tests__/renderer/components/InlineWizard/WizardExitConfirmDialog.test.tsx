/**
 * Tests for WizardExitConfirmDialog.tsx
 *
 * Tests the exit confirmation dialog for the inline wizard:
 * - Renders with correct content
 * - Cancel button closes dialog and calls onCancel
 * - The destructive "Yes, Exit" button calls onConfirm and holds focus
 * - Escape key calls onCancel
 * - Layer stack registration
 * - Focus management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WizardExitConfirmDialog } from '../../../../renderer/components/InlineWizard/WizardExitConfirmDialog';

import { mockTheme } from '../../../helpers/mockTheme';
// Mock useLayerStack
const mockRegisterLayer = vi.fn(() => 'layer-1');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// Mock theme for testing

describe('WizardExitConfirmDialog', () => {
	const defaultProps = {
		theme: mockTheme,
		onConfirm: vi.fn(),
		onCancel: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('rendering', () => {
		it('renders the dialog with correct title', () => {
			render(<WizardExitConfirmDialog {...defaultProps} />);
			expect(screen.getByText('Exit Wizard?')).toBeInTheDocument();
		});

		it('renders the warning message', () => {
			render(<WizardExitConfirmDialog {...defaultProps} />);
			expect(
				screen.getByText(/Are you sure you want to exit the wizard and lose your progress\?/)
			).toBeInTheDocument();
		});

		it('renders the destructive confirm and Cancel buttons', () => {
			render(<WizardExitConfirmDialog {...defaultProps} />);
			expect(screen.getByRole('button', { name: 'Yes, Exit' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
		});

		it('renders keyboard hints', () => {
			render(<WizardExitConfirmDialog {...defaultProps} />);
			expect(screen.getByText('Tab')).toBeInTheDocument();
			expect(screen.getByText('Enter')).toBeInTheDocument();
			expect(screen.getByText('Esc')).toBeInTheDocument();
		});

		it('renders warning icon', () => {
			const { container } = render(<WizardExitConfirmDialog {...defaultProps} />);
			// AlertCircle icon should be present
			const svgIcons = container.querySelectorAll('svg');
			expect(svgIcons.length).toBeGreaterThan(0);
		});
	});

	describe('button interactions', () => {
		it('calls onConfirm when the destructive button is clicked', () => {
			const onConfirm = vi.fn();
			render(<WizardExitConfirmDialog {...defaultProps} onConfirm={onConfirm} />);

			fireEvent.click(screen.getByTestId('wizard-exit-confirm-button'));

			expect(onConfirm).toHaveBeenCalledTimes(1);
		});

		it('calls onCancel when Cancel button is clicked', () => {
			const onCancel = vi.fn();
			render(<WizardExitConfirmDialog {...defaultProps} onCancel={onCancel} />);

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

			expect(onCancel).toHaveBeenCalledTimes(1);
		});
	});

	describe('layer stack', () => {
		it('registers with layer stack on mount', () => {
			render(<WizardExitConfirmDialog {...defaultProps} />);

			expect(mockRegisterLayer).toHaveBeenCalledTimes(1);
			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
					priority: 775, // INLINE_WIZARD_EXIT_CONFIRM
					blocksLowerLayers: true,
					capturesFocus: true,
					focusTrap: 'strict',
					ariaLabel: 'Confirm Exit Wizard',
				})
			);
		});

		it('unregisters from layer stack on unmount', () => {
			const { unmount } = render(<WizardExitConfirmDialog {...defaultProps} />);

			unmount();

			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-1');
		});

		it('calls onCancel when Escape is pressed via layer stack', () => {
			const onCancel = vi.fn();
			render(<WizardExitConfirmDialog {...defaultProps} onCancel={onCancel} />);

			// Get the onEscape handler that was registered
			const registerCall = mockRegisterLayer.mock.calls[0][0];
			expect(registerCall.onEscape).toBeDefined();

			// Simulate Escape via layer stack
			registerCall.onEscape();

			expect(onCancel).toHaveBeenCalledTimes(1);
		});
	});

	describe('focus management', () => {
		it('focuses the destructive button on mount so Enter confirms', () => {
			render(<WizardExitConfirmDialog {...defaultProps} />);

			expect(screen.getByTestId('wizard-exit-confirm-button')).toHaveFocus();
		});

		it('confirms on Enter, since Enter activates the focused destructive button', () => {
			const onConfirm = vi.fn();
			const onCancel = vi.fn();
			render(
				<WizardExitConfirmDialog {...defaultProps} onConfirm={onConfirm} onCancel={onCancel} />
			);

			// jsdom does not synthesize the click a real Enter press produces on a focused
			// button, so assert the wiring: focus is on the confirm button and it confirms.
			expect(screen.getByTestId('wizard-exit-confirm-button')).toHaveFocus();
			fireEvent.click(document.activeElement as HTMLElement);

			expect(onConfirm).toHaveBeenCalledTimes(1);
			expect(onCancel).not.toHaveBeenCalled();
		});
	});

	describe('accessibility', () => {
		it('has correct dialog role and aria attributes', () => {
			render(<WizardExitConfirmDialog {...defaultProps} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-labelledby', 'wizard-exit-dialog-title');
			expect(dialog).toHaveAttribute('aria-describedby', 'wizard-exit-dialog-description');
		});

		it('has correct heading structure', () => {
			render(<WizardExitConfirmDialog {...defaultProps} />);

			const heading = screen.getByRole('heading', { name: 'Exit Wizard?' });
			expect(heading).toHaveAttribute('id', 'wizard-exit-dialog-title');
		});
	});

	describe('styling', () => {
		it('applies theme colors to background', () => {
			const { container } = render(<WizardExitConfirmDialog {...defaultProps} />);

			const dialogContent = container.querySelector('.border.rounded-xl');
			expect(dialogContent).toHaveStyle({
				backgroundColor: mockTheme.colors.bgSidebar,
				borderColor: mockTheme.colors.border,
			});
		});

		it('applies the destructive color to the icon container', () => {
			const { container } = render(<WizardExitConfirmDialog {...defaultProps} />);

			const iconContainer = container.querySelector('.rounded-lg');
			expect(iconContainer).toHaveStyle({
				backgroundColor: `${mockTheme.colors.error}20`,
			});
		});

		it('paints the confirm button in the destructive color', () => {
			render(<WizardExitConfirmDialog {...defaultProps} />);

			expect(screen.getByTestId('wizard-exit-confirm-button')).toHaveStyle({
				backgroundColor: mockTheme.colors.error,
			});
		});
	});
});
