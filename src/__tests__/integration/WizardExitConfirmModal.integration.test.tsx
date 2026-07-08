import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WizardExitConfirmModal } from '../../renderer/components/Wizard/WizardExitConfirmModal';
import { MODAL_PRIORITIES } from '../../renderer/constants/modalPriorities';
import type { Theme } from '../../renderer/types';

const mockRegisterLayer = vi.fn(() => 'wizard-exit-layer');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		background: '#1a1a1a',
		backgroundDim: '#0d0d0d',
		backgroundBright: '#2a2a2a',
		bgActivity: '#333333',
		bgMain: '#1a1a1a',
		bgSidebar: '#141414',
		textMain: '#ffffff',
		textDim: '#888888',
		textMuted: '#666666',
		textBright: '#ffffff',
		border: '#333333',
		borderBright: '#444444',
		success: '#00ff00',
		warning: '#ffff00',
		error: '#ff0000',
		accent: '#007bff',
		accentForeground: '#ffffff',
		accentText: '#66b2ff',
	},
};

describe('WizardExitConfirmModal', () => {
	const defaultProps = {
		theme: mockTheme,
		currentStep: 3,
		totalSteps: 5,
		onConfirmExit: vi.fn(),
		onCancel: vi.fn(),
		onQuitWithoutSaving: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders the prompt, progress, actions, and safe default focus', () => {
		const { container } = render(<WizardExitConfirmModal {...defaultProps} />);

		expect(screen.getByRole('heading', { name: 'Exit Setup Wizard?' })).toBeInTheDocument();
		expect(screen.getByText('Are you sure you want to exit the setup wizard?')).toBeInTheDocument();
		expect(screen.getByText('Step 3 of 5')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Exit & Save Progress' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Just Quit' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
		expect(container.querySelector('.transition-all.duration-300')).toHaveStyle({ width: '50%' });
	});

	it('calls the correct action callbacks', () => {
		const onConfirmExit = vi.fn();
		const onQuitWithoutSaving = vi.fn();
		const onCancel = vi.fn();
		render(
			<WizardExitConfirmModal
				{...defaultProps}
				onConfirmExit={onConfirmExit}
				onQuitWithoutSaving={onQuitWithoutSaving}
				onCancel={onCancel}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Exit & Save Progress' }));
		fireEvent.click(screen.getByRole('button', { name: 'Just Quit' }));
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(onConfirmExit).toHaveBeenCalledTimes(1);
		expect(onQuitWithoutSaving).toHaveBeenCalledTimes(1);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('registers and unregisters a strict modal layer', () => {
		const { unmount } = render(<WizardExitConfirmModal {...defaultProps} />);

		expect(mockRegisterLayer).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'modal',
				priority: MODAL_PRIORITIES.WIZARD_EXIT_CONFIRM,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'strict',
				ariaLabel: 'Confirm Exit Setup Wizard',
			})
		);

		unmount();

		expect(mockUnregisterLayer).toHaveBeenCalledWith('wizard-exit-layer');
	});

	it('uses the latest cancel callback for registered and updated escape handlers', () => {
		const firstCancel = vi.fn();
		const nextCancel = vi.fn();
		const { rerender } = render(
			<WizardExitConfirmModal {...defaultProps} onCancel={firstCancel} />
		);
		const registeredHandler = mockRegisterLayer.mock.calls[0][0].onEscape;

		registeredHandler();

		expect(firstCancel).toHaveBeenCalledTimes(1);

		rerender(<WizardExitConfirmModal {...defaultProps} onCancel={nextCancel} />);

		const latestHandler = mockUpdateLayerHandler.mock.calls.at(-1)?.[1];
		expect(latestHandler).toEqual(expect.any(Function));

		latestHandler();

		expect(nextCancel).toHaveBeenCalledTimes(1);
	});

	it('skips layer updates and unregister when registration returns no id', () => {
		mockRegisterLayer.mockReturnValueOnce(undefined as unknown as string);

		const { unmount } = render(<WizardExitConfirmModal {...defaultProps} />);

		expect(mockUpdateLayerHandler).not.toHaveBeenCalled();

		unmount();

		expect(mockUnregisterLayer).not.toHaveBeenCalled();
	});

	it('allows Tab navigation but stops propagation for other keys', () => {
		render(<WizardExitConfirmModal {...defaultProps} />);
		const dialog = screen.getByRole('dialog');
		const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
		const arrowEvent = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true });
		const tabStopPropagation = vi.spyOn(tabEvent, 'stopPropagation');
		const arrowStopPropagation = vi.spyOn(arrowEvent, 'stopPropagation');

		fireEvent(dialog, tabEvent);
		fireEvent(dialog, arrowEvent);

		expect(tabStopPropagation).not.toHaveBeenCalled();
		expect(arrowStopPropagation).toHaveBeenCalledTimes(1);
	});

	it('sets dialog aria attributes', () => {
		render(<WizardExitConfirmModal {...defaultProps} />);

		const dialog = screen.getByRole('dialog');
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		expect(dialog).toHaveAttribute('aria-labelledby', 'wizard-exit-title');
		expect(dialog).toHaveAttribute('aria-describedby', 'wizard-exit-description');
	});
});
