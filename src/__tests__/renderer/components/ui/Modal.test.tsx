import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTheme } from '../../../helpers/mockTheme';
import { Modal, ModalFooter } from '../../../../renderer/components/ui/Modal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

/** RTL `wrapper` form of the LayerStackProvider the other helpers nest inline. */
const LayerStackWrapper = ({ children }: { children: React.ReactNode }) => (
	<LayerStackProvider>{children}</LayerStackProvider>
);

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

	it('applies a remembered size to the card', () => {
		useSettingsStore.setState({
			modalSizes: { 'shared-modal-test': { width: 700, height: 500 } },
		});
		renderModal();

		const card = screen.getByText('Modal body').closest('[role="dialog"] > div');
		expect(card).toHaveStyle({ width: '700px', height: '500px' });
	});

	describe('portal', () => {
		const renderInHost = (props: Partial<React.ComponentProps<typeof Modal>> = {}) =>
			render(
				<div data-testid="host">
					<Modal
						theme={mockTheme}
						title="Portaled"
						priority={100}
						onClose={vi.fn()}
						testId="portal-overlay"
						{...props}
					>
						<p>Content</p>
					</Modal>
				</div>,
				{ wrapper: LayerStackWrapper }
			);

		it('should render in place by default', () => {
			renderInHost();

			const host = screen.getByTestId('host');
			expect(host).toContainElement(screen.getByTestId('portal-overlay'));
		});

		it('should escape the host subtree when portal is set', () => {
			// The Main Panel wraps the session view in `isolate`, a stacking
			// context that traps the backdrop's z-index and lets the Left/Right
			// panels paint over it. jsdom has no layout engine, so assert the
			// overlay is NOT a descendant of its host rather than checking paint
			// order - toBeInTheDocument() would pass either way.
			renderInHost({ portal: true });

			const overlay = screen.getByTestId('portal-overlay');
			expect(screen.getByTestId('host')).not.toContainElement(overlay);
			expect(overlay.parentElement).toBe(document.body);
		});

		it('should still close on Escape through the layer stack when portaled', async () => {
			const onClose = vi.fn();
			renderInHost({ portal: true, onClose });

			// React context flows through portals, so useModalLayer registration
			// is unaffected by the DOM relocation.
			fireEvent.keyDown(document, { key: 'Escape' });

			await waitFor(() => expect(onClose).toHaveBeenCalled());
		});
	});
});
