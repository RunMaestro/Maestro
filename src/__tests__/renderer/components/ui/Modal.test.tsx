import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTheme } from '../../../helpers/mockTheme';
import { Modal, ModalFooter } from '../../../../renderer/components/ui/Modal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

function renderModal(overrides: Partial<React.ComponentProps<typeof Modal>> = {}) {
	const onClose = overrides.onClose ?? vi.fn();

	render(
		<LayerStackProvider>
			<Modal
				theme={mockTheme}
				title="Shared Modal"
				priority={123}
				onClose={onClose}
				resizeKey="shared-modal-test"
				testId="shared-modal-overlay"
				{...overrides}
			>
				<div>Modal body</div>
			</Modal>
		</LayerStackProvider>
	);

	return { onClose };
}

describe('Modal', () => {
	beforeEach(() => {
		useSettingsStore.setState({ modalSizes: {} });
		vi.mocked(window.maestro.settings.set).mockClear();
	});

	it('renders resize handles when resizable with a stable key', () => {
		renderModal();

		expect(screen.getByTestId('modal-resize-handle-se')).toBeInTheDocument();
		expect(
			document.querySelector('[data-modal-resize-key="shared-modal-test"]')
		).toBeInTheDocument();
	});

	it('does not enable resizing without an explicit resizeKey', () => {
		renderModal({ resizeKey: undefined, width: 450, maxHeight: '70vh' });

		expect(screen.queryByTestId('modal-resize-handle-se')).not.toBeInTheDocument();
		expect(document.querySelector('[data-modal-resize-key]')).not.toBeInTheDocument();

		const card = screen.getByText('Modal body').closest('[role="dialog"] > div');
		expect(card).toHaveStyle({ maxHeight: '70vh' });
		expect((card as HTMLElement).style.width).toContain('450px');
	});

	it('keeps close button behavior unchanged', () => {
		const { onClose } = renderModal();

		fireEvent.click(screen.getByLabelText('Close modal'));

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('keeps backdrop close behavior opt-in', () => {
		const { onClose } = renderModal({ closeOnBackdropClick: true });

		fireEvent.click(screen.getByText('Modal body'));
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('shared-modal-overlay'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('routes Escape through LayerStack', async () => {
		const { onClose } = renderModal();

		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => {
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('focus management', () => {
		it('should focus initial focus ref when provided', async () => {
			const onClose = vi.fn();

			const TestComponent = () => {
				const inputRef = React.useRef<HTMLInputElement>(null);
				return (
					<Modal
						theme={mockTheme}
						title="Focus Test"
						priority={100}
						onClose={onClose}
						initialFocusRef={inputRef}
					>
						<input ref={inputRef} data-testid="focus-input" />
					</Modal>
				);
			};

			render(
				<LayerStackProvider>
					<TestComponent />
				</LayerStackProvider>
			);

			await waitFor(() => {
				expect(screen.getByTestId('focus-input')).toHaveFocus();
			});
		});

		it('should focus container when no initial focus ref is provided', async () => {
			const onClose = vi.fn();

			render(
				<LayerStackProvider>
					<Modal
						theme={mockTheme}
						title="Container Focus"
						priority={100}
						onClose={onClose}
						testId="modal-container"
					>
						<p>Content</p>
					</Modal>
				</LayerStackProvider>
			);

			await waitFor(() => {
				expect(screen.getByTestId('modal-container')).toHaveFocus();
			});
		});
	});

	describe('layer options', () => {
		it('should pass layer options to useModalLayer', () => {
			const onClose = vi.fn();
			const onBeforeClose = vi.fn().mockResolvedValue(false);

			render(
				<LayerStackProvider>
					<Modal
						theme={mockTheme}
						title="Options Test"
						priority={100}
						onClose={onClose}
						layerOptions={{
							isDirty: true,
							onBeforeClose,
							focusTrap: 'lenient',
						}}
					>
						<p>Content</p>
					</Modal>
				</LayerStackProvider>
			);

			// Modal should render successfully with options
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
	});
});

describe('ModalFooter', () => {
	it('should render cancel and confirm buttons', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(<ModalFooter theme={mockTheme} onCancel={onCancel} onConfirm={onConfirm} />);

		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
	});

	it('should use custom button labels', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(
			<ModalFooter
				theme={mockTheme}
				onCancel={onCancel}
				onConfirm={onConfirm}
				cancelLabel="Discard"
				confirmLabel="Save Changes"
			/>
		);

		expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
	});

	it('should call onCancel when cancel button is clicked', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(<ModalFooter theme={mockTheme} onCancel={onCancel} onConfirm={onConfirm} />);

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('should call onConfirm when confirm button is clicked', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(<ModalFooter theme={mockTheme} onCancel={onCancel} onConfirm={onConfirm} />);

		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it('should disable confirm button when confirmDisabled is true', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(
			<ModalFooter
				theme={mockTheme}
				onCancel={onCancel}
				onConfirm={onConfirm}
				confirmDisabled={true}
			/>
		);

		const confirmButton = screen.getByRole('button', { name: 'Confirm' });
		expect(confirmButton).toBeDisabled();
	});

	it('should hide cancel button when showCancel is false', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(
			<ModalFooter theme={mockTheme} onCancel={onCancel} onConfirm={onConfirm} showCancel={false} />
		);

		expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
	});

	it('should apply destructive styling when destructive is true', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(
			<ModalFooter theme={mockTheme} onCancel={onCancel} onConfirm={onConfirm} destructive={true} />
		);

		const confirmButton = screen.getByRole('button', { name: 'Confirm' });
		expect(confirmButton).toHaveStyle({ backgroundColor: mockTheme.colors.error });
	});

	it('should apply accent styling when not destructive', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(
			<ModalFooter
				theme={mockTheme}
				onCancel={onCancel}
				onConfirm={onConfirm}
				destructive={false}
			/>
		);

		const confirmButton = screen.getByRole('button', { name: 'Confirm' });
		expect(confirmButton).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
	});

	it('should apply custom className to confirm button', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();

		render(
			<ModalFooter
				theme={mockTheme}
				onCancel={onCancel}
				onConfirm={onConfirm}
				confirmClassName="custom-confirm"
			/>
		);

		const confirmButton = screen.getByRole('button', { name: 'Confirm' });
		expect(confirmButton).toHaveClass('custom-confirm');
	});
});
