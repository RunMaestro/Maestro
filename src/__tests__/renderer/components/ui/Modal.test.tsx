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

	describe('floating mode', () => {
		it('drops the backdrop and lets clicks through to the app behind it', () => {
			renderModal({
				floating: { position: { x: 40, y: 60 }, onMovePointerDown: vi.fn() },
			});

			const overlay = screen.getByTestId('shared-modal-overlay');
			// Click-through layer, no dimming, and not a modal to assistive tech:
			// the user is expected to keep working beside it.
			expect(overlay).toHaveClass('pointer-events-none');
			expect(overlay).not.toHaveClass('modal-overlay');
			expect(overlay).not.toHaveAttribute('aria-modal');

			const card = overlay.querySelector('[data-modal-resize-key]') as HTMLElement;
			expect(card).toHaveClass('pointer-events-auto');
			expect(card).toHaveStyle({ left: '40px', top: '60px' });
		});

		it('offers only the edges a top-left-pinned window can grow from', () => {
			renderModal({
				floating: { position: { x: 0, y: 0 }, onMovePointerDown: vi.fn() },
			});

			for (const direction of ['e', 'se', 's']) {
				expect(screen.getByTestId(`modal-resize-handle-${direction}`)).toBeInTheDocument();
			}
			// A north/west drag cannot be honored without also moving the window, so
			// those handles are not offered rather than silently acting like their
			// opposite edge.
			for (const direction of ['n', 'ne', 'w', 'nw', 'sw']) {
				expect(screen.queryByTestId(`modal-resize-handle-${direction}`)).not.toBeInTheDocument();
			}
		});

		it('makes the header a drag handle without eating its buttons', () => {
			const onMovePointerDown = vi.fn();
			const onClose = vi.fn();
			renderModal({ floating: { position: { x: 0, y: 0 }, onMovePointerDown }, onClose });

			const handle = screen.getByTestId('modal-float-handle');
			fireEvent.pointerDown(handle);
			expect(onMovePointerDown).toHaveBeenCalled();

			// The close button lives inside the drag handle and must still click.
			fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
			expect(onClose).toHaveBeenCalled();
		});

		it('still closes on Escape, so the passive layer keeps its way out', async () => {
			const onClose = vi.fn();
			renderModal({ floating: { position: { x: 0, y: 0 }, onMovePointerDown: vi.fn() }, onClose });

			fireEvent.keyDown(document, { key: 'Escape' });

			await waitFor(() => expect(onClose).toHaveBeenCalled());
		});

		it('keeps a docked modal blocking, so floating is opt-in', () => {
			renderModal();

			const overlay = screen.getByTestId('shared-modal-overlay');
			expect(overlay).toHaveClass('modal-overlay');
			expect(overlay).toHaveAttribute('aria-modal', 'true');
			expect(screen.queryByTestId('modal-float-handle')).not.toBeInTheDocument();
			expect(screen.getByTestId('modal-resize-handle-nw')).toBeInTheDocument();
		});
	});
	describe('ModalFooter type scale', () => {
		/**
		 * These buttons carried no size class, so they took the interface font
		 * size directly - at a 16px setting with a 1.2 zoom that is over 19px,
		 * which made a two-word button larger than the modal's own `text-sm`
		 * title and gave a routine confirmation the weight of a warning.
		 */
		function renderFooter(overrides: Partial<React.ComponentProps<typeof ModalFooter>> = {}) {
			render(
				<ModalFooter
					theme={mockTheme}
					onCancel={vi.fn()}
					onConfirm={vi.fn()}
					cancelLabel="Cancel"
					confirmLabel="Remove"
					{...overrides}
				/>
			);
		}

		it('sizes both buttons explicitly rather than inheriting', () => {
			renderFooter();

			for (const name of ['Cancel', 'Remove']) {
				expect(screen.getByRole('button', { name }).className).toContain('text-sm');
			}
		});

		it('does not render a button larger than the modal title', () => {
			// The title is `text-sm`; a control should not outweigh the heading
			// that names what it acts on.
			renderModal({
				title: 'Remove Queued Message?',
				footer: (
					<ModalFooter
						theme={mockTheme}
						onCancel={vi.fn()}
						onConfirm={vi.fn()}
						confirmLabel="Remove"
					/>
				),
			});

			const title = screen.getByText('Remove Queued Message?');
			const button = screen.getByRole('button', { name: 'Remove' });
			expect(title.className).toContain('text-sm');
			expect(button.className).toContain('text-sm');
		});

		it('keeps the destructive styling independent of the size', () => {
			// Shrinking the label must not quietly change what the button means.
			renderFooter({ destructive: true, confirmLabel: 'Remove' });
			const button = screen.getByRole('button', { name: 'Remove' });

			expect(button.className).toContain('text-sm');
			expect(button).toHaveStyle({ backgroundColor: mockTheme.colors.error });
		});

		it('tightens the vertical padding to match', () => {
			// Otherwise the box stays tall around smaller text and the button
			// looks loose rather than smaller.
			renderFooter();
			expect(screen.getByRole('button', { name: 'Remove' }).className).toContain('py-1.5');
		});
	});
});
