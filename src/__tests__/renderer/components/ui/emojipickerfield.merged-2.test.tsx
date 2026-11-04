// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/components/ui/Modal.test.tsx
// Source: src/__tests__/renderer/components/ui/RecordDetailModal.test.tsx
import { describe, beforeEach, expect, it, vi } from 'vitest';
import S1_React from 'react';
import {
	fireEvent as s1_fireEvent,
	render as s1_render,
	screen as s1_screen,
	waitFor,
} from '@testing-library/react';
import { mockTheme as s1_mockTheme } from '../../../helpers/mockTheme';
import { Modal, ModalFooter } from '../../../../renderer/components/ui/Modal';
import { LayerStackProvider as S1_LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import S2_React from 'react';
import {
	render as s2_render,
	screen as s2_screen,
	fireEvent as s2_fireEvent,
} from '@testing-library/react';
import { RecordDetailModal } from '../../../../renderer/components/ui/RecordDetailModal';
import { LayerStackProvider as S2_LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../../../renderer/constants/modalPriorities';
import { mockTheme as s2_mockTheme } from '../../../helpers/mockTheme';
// Source: src/__tests__/renderer/components/ui/Modal.test.tsx
describe('', () => {
	/** RTL `wrapper` form of the LayerStackProvider the other helpers nest inline. */
	const LayerStackWrapper = ({ children }: { children: S1_React.ReactNode }) => (
		<S1_LayerStackProvider>{children}</S1_LayerStackProvider>
	);
	function renderModal(overrides: Partial<S1_React.ComponentProps<typeof Modal>> = {}) {
		const onClose = overrides.onClose ?? vi.fn();
		s1_render(
			<S1_LayerStackProvider>
				<Modal
					theme={s1_mockTheme}
					title="Shared Modal"
					priority={123}
					onClose={onClose}
					resizeKey="shared-modal-test"
					testId="shared-modal-overlay"
					{...overrides}
				>
					<div>Modal body</div>
				</Modal>
			</S1_LayerStackProvider>
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
			expect(s1_screen.getByTestId('modal-resize-handle-se')).toBeInTheDocument();
			expect(
				document.querySelector('[data-modal-resize-key="shared-modal-test"]')
			).toBeInTheDocument();
		});
		it('does not enable resizing without an explicit resizeKey', () => {
			renderModal({ resizeKey: undefined, width: 450, maxHeight: '70vh' });
			expect(s1_screen.queryByTestId('modal-resize-handle-se')).not.toBeInTheDocument();
			expect(document.querySelector('[data-modal-resize-key]')).not.toBeInTheDocument();
			const card = s1_screen.getByText('Modal body').closest('[role="dialog"] > div');
			expect(card).toHaveStyle({ maxHeight: '70vh' });
			expect((card as HTMLElement).style.width).toContain('450px');
		});
		it('keeps close button behavior unchanged', () => {
			const { onClose } = renderModal();
			s1_fireEvent.click(s1_screen.getByLabelText('Close modal'));
			expect(onClose).toHaveBeenCalledTimes(1);
		});
		it('keeps backdrop close behavior opt-in', () => {
			const { onClose } = renderModal({ closeOnBackdropClick: true });
			s1_fireEvent.click(s1_screen.getByText('Modal body'));
			expect(onClose).not.toHaveBeenCalled();
			s1_fireEvent.click(s1_screen.getByTestId('shared-modal-overlay'));
			expect(onClose).toHaveBeenCalledTimes(1);
		});
		it('routes Escape through LayerStack', async () => {
			const { onClose } = renderModal();
			s1_fireEvent.keyDown(window, { key: 'Escape' });
			await waitFor(() => {
				expect(onClose).toHaveBeenCalledTimes(1);
			});
		});
		describe('focus management', () => {
			it('should focus initial focus ref when provided', async () => {
				const onClose = vi.fn();
				const TestComponent = () => {
					const inputRef = S1_React.useRef<HTMLInputElement>(null);
					return (
						<Modal
							theme={s1_mockTheme}
							title="Focus Test"
							priority={100}
							onClose={onClose}
							initialFocusRef={inputRef}
						>
							<input ref={inputRef} data-testid="focus-input" />
						</Modal>
					);
				};
				s1_render(
					<S1_LayerStackProvider>
						<TestComponent />
					</S1_LayerStackProvider>
				);
				await waitFor(() => {
					expect(s1_screen.getByTestId('focus-input')).toHaveFocus();
				});
			});
			it('should focus container when no initial focus ref is provided', async () => {
				const onClose = vi.fn();
				s1_render(
					<S1_LayerStackProvider>
						<Modal
							theme={s1_mockTheme}
							title="Container Focus"
							priority={100}
							onClose={onClose}
							testId="modal-container"
						>
							<p>Content</p>
						</Modal>
					</S1_LayerStackProvider>
				);
				await waitFor(() => {
					expect(s1_screen.getByTestId('modal-container')).toHaveFocus();
				});
			});
		});
		describe('layer options', () => {
			it('should pass layer options to useModalLayer', () => {
				const onClose = vi.fn();
				const onBeforeClose = vi.fn().mockResolvedValue(false);
				s1_render(
					<S1_LayerStackProvider>
						<Modal
							theme={s1_mockTheme}
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
					</S1_LayerStackProvider>
				);
				// Modal should render successfully with options
				expect(s1_screen.getByRole('dialog')).toBeInTheDocument();
			});
		});
		it('applies a remembered size to the card', () => {
			useSettingsStore.setState({
				modalSizes: { 'shared-modal-test': { width: 700, height: 500 } },
			});
			renderModal();
			const card = s1_screen.getByText('Modal body').closest('[role="dialog"] > div');
			expect(card).toHaveStyle({ width: '700px', height: '500px' });
		});
		describe('portal', () => {
			const renderInHost = (props: Partial<S1_React.ComponentProps<typeof Modal>> = {}) =>
				s1_render(
					<div data-testid="host">
						<Modal
							theme={s1_mockTheme}
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
				const host = s1_screen.getByTestId('host');
				expect(host).toContainElement(s1_screen.getByTestId('portal-overlay'));
			});
			it('should escape the host subtree when portal is set', () => {
				// The Main Panel wraps the session view in `isolate`, a stacking
				// context that traps the backdrop's z-index and lets the Left/Right
				// panels paint over it. jsdom has no layout engine, so assert the
				// overlay is NOT a descendant of its host rather than checking paint
				// order - toBeInTheDocument() would pass either way.
				renderInHost({ portal: true });
				const overlay = s1_screen.getByTestId('portal-overlay');
				expect(s1_screen.getByTestId('host')).not.toContainElement(overlay);
				expect(overlay.parentElement).toBe(document.body);
			});
			it('should still close on Escape through the layer stack when portaled', async () => {
				const onClose = vi.fn();
				renderInHost({ portal: true, onClose });
				// React context flows through portals, so useModalLayer registration
				// is unaffected by the DOM relocation.
				s1_fireEvent.keyDown(document, { key: 'Escape' });
				await waitFor(() => expect(onClose).toHaveBeenCalled());
			});
		});
		describe('floating mode', () => {
			it('drops the backdrop and lets clicks through to the app behind it', () => {
				renderModal({
					floating: { position: { x: 40, y: 60 }, onMovePointerDown: vi.fn() },
				});
				const overlay = s1_screen.getByTestId('shared-modal-overlay');
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
					expect(s1_screen.getByTestId(`modal-resize-handle-${direction}`)).toBeInTheDocument();
				}
				// A north/west drag cannot be honored without also moving the window, so
				// those handles are not offered rather than silently acting like their
				// opposite edge.
				for (const direction of ['n', 'ne', 'w', 'nw', 'sw']) {
					expect(
						s1_screen.queryByTestId(`modal-resize-handle-${direction}`)
					).not.toBeInTheDocument();
				}
			});
			it('makes the header a drag handle without eating its buttons', () => {
				const onMovePointerDown = vi.fn();
				const onClose = vi.fn();
				renderModal({ floating: { position: { x: 0, y: 0 }, onMovePointerDown }, onClose });
				const handle = s1_screen.getByTestId('modal-float-handle');
				s1_fireEvent.pointerDown(handle);
				expect(onMovePointerDown).toHaveBeenCalled();
				// The close button lives inside the drag handle and must still click.
				s1_fireEvent.click(s1_screen.getByRole('button', { name: 'Close modal' }));
				expect(onClose).toHaveBeenCalled();
			});
			it('still closes on Escape, so the passive layer keeps its way out', async () => {
				const onClose = vi.fn();
				renderModal({
					floating: { position: { x: 0, y: 0 }, onMovePointerDown: vi.fn() },
					onClose,
				});
				s1_fireEvent.keyDown(document, { key: 'Escape' });
				await waitFor(() => expect(onClose).toHaveBeenCalled());
			});
			it('keeps a docked modal blocking, so floating is opt-in', () => {
				renderModal();
				const overlay = s1_screen.getByTestId('shared-modal-overlay');
				expect(overlay).toHaveClass('modal-overlay');
				expect(overlay).toHaveAttribute('aria-modal', 'true');
				expect(s1_screen.queryByTestId('modal-float-handle')).not.toBeInTheDocument();
				expect(s1_screen.getByTestId('modal-resize-handle-nw')).toBeInTheDocument();
			});
		});
		describe('ModalFooter type scale', () => {
			/**
			 * These buttons carried no size class, so they took the interface font
			 * size directly - at a 16px setting with a 1.2 zoom that is over 19px,
			 * which made a two-word button larger than the modal's own `text-sm`
			 * title and gave a routine confirmation the weight of a warning.
			 */
			function renderFooter(overrides: Partial<S1_React.ComponentProps<typeof ModalFooter>> = {}) {
				s1_render(
					<ModalFooter
						theme={s1_mockTheme}
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
					expect(s1_screen.getByRole('button', { name }).className).toContain('text-sm');
				}
			});
			it('does not render a button larger than the modal title', () => {
				// The title is `text-sm`; a control should not outweigh the heading
				// that names what it acts on.
				renderModal({
					title: 'Remove Queued Message?',
					footer: (
						<ModalFooter
							theme={s1_mockTheme}
							onCancel={vi.fn()}
							onConfirm={vi.fn()}
							confirmLabel="Remove"
						/>
					),
				});
				const title = s1_screen.getByText('Remove Queued Message?');
				const button = s1_screen.getByRole('button', { name: 'Remove' });
				expect(title.className).toContain('text-sm');
				expect(button.className).toContain('text-sm');
			});
			it('keeps the destructive styling independent of the size', () => {
				// Shrinking the label must not quietly change what the button means.
				renderFooter({ destructive: true, confirmLabel: 'Remove' });
				const button = s1_screen.getByRole('button', { name: 'Remove' });
				expect(button.className).toContain('text-sm');
				expect(button).toHaveStyle({ backgroundColor: s1_mockTheme.colors.error });
			});
			it('tightens the vertical padding to match', () => {
				// Otherwise the box stays tall around smaller text and the button
				// looks loose rather than smaller.
				renderFooter();
				expect(s1_screen.getByRole('button', { name: 'Remove' }).className).toContain('py-1.5');
			});
		});
	});
});
// Source: src/__tests__/renderer/components/ui/RecordDetailModal.test.tsx
describe('', () => {
	// lucide-react icons are auto-mocked globally in src/__tests__/setup.ts
	/**
	 * The shared record view, tested at the seam the CSV suite cannot see.
	 *
	 * `CsvTableRenderer.test.tsx` already drives the body of this component through
	 * the CSV adapter - filtering, row stepping, the keyboard model. What that
	 * suite cannot cover is the part that made it shared in the first place: a
	 * second caller supplying its own field mapping, test ids, and modal priority.
	 * Those props are what stop the parquet viewer and the CSV table from fighting
	 * over one hard-coded identity, so they get their own assertions here.
	 */
	const FIELDS = [
		{ key: 'id', value: '42' },
		{ key: 'region', value: 'eu' },
		{ key: 'notes', value: 'line one\nline two' },
	];
	function renderModal(overrides: Partial<S2_React.ComponentProps<typeof RecordDetailModal>> = {}) {
		return s2_render(
			<S2_LayerStackProvider>
				<RecordDetailModal
					fields={FIELDS}
					index={0}
					total={3}
					onNavigate={vi.fn()}
					onClose={vi.fn()}
					theme={s2_mockTheme}
					priority={MODAL_PRIORITIES.TABLE_ROW_DETAIL}
					resizeKey="test-record-detail"
					testIdPrefix="test-record"
					{...overrides}
				/>
			</S2_LayerStackProvider>
		);
	}
	describe('RecordDetailModal', () => {
		it('renders the caller-supplied fields rather than deriving them itself', () => {
			renderModal();
			expect(s2_screen.getByText('id')).toBeInTheDocument();
			expect(s2_screen.getByText('region')).toBeInTheDocument();
			expect(s2_screen.getByText('42')).toBeInTheDocument();
			expect(s2_screen.getByText('eu')).toBeInTheDocument();
		});
		it('namespaces every test id under the caller prefix', () => {
			// The whole point of the prefix: two surfaces can have a record modal
			// open in the same app without a test targeting "whichever one is up".
			renderModal();
			expect(s2_screen.getByTestId('test-record-modal')).toBeInTheDocument();
			expect(s2_screen.getByTestId('test-record-search')).toBeInTheDocument();
			expect(s2_screen.getByTestId('test-record-fields')).toBeInTheDocument();
			expect(s2_screen.queryByTestId('csv-row-detail-modal')).not.toBeInTheDocument();
		});
		it('shows the position within the rows the table is currently displaying', () => {
			renderModal({ index: 1, total: 3 });
			expect(s2_screen.getByText('Row 2')).toBeInTheDocument();
			expect(s2_screen.getByText(/of 3/)).toBeInTheDocument();
		});
		it('filters on both field names and values', () => {
			renderModal();
			s2_fireEvent.change(s2_screen.getByTestId('test-record-search'), {
				target: { value: 'region' },
			});
			expect(s2_screen.getByText('region')).toBeInTheDocument();
			expect(s2_screen.queryByText('42')).not.toBeInTheDocument();
			// Matching a VALUE keeps its field visible too - a record view is read by
			// value at least as often as by field name.
			s2_fireEvent.change(s2_screen.getByTestId('test-record-search'), { target: { value: '42' } });
			expect(s2_screen.getByText('id')).toBeInTheDocument();
			expect(s2_screen.queryByText('eu')).not.toBeInTheDocument();
		});
		it('steps rows with Left and Right without closing', () => {
			const onNavigate = vi.fn();
			const onClose = vi.fn();
			renderModal({ index: 1, total: 3, onNavigate, onClose });
			s2_fireEvent.keyDown(s2_screen.getByTestId('test-record-fields'), { key: 'ArrowRight' });
			expect(onNavigate).toHaveBeenCalledWith(2);
			s2_fireEvent.keyDown(s2_screen.getByTestId('test-record-fields'), { key: 'ArrowLeft' });
			expect(onNavigate).toHaveBeenCalledWith(0);
			expect(onClose).not.toHaveBeenCalled();
		});
		it('does not step past either end of the displayed rows', () => {
			const onNavigate = vi.fn();
			const { unmount } = renderModal({ index: 0, total: 3, onNavigate });
			s2_fireEvent.keyDown(s2_screen.getByTestId('test-record-fields'), { key: 'ArrowLeft' });
			expect(onNavigate).not.toHaveBeenCalled();
			unmount();
			renderModal({ index: 2, total: 3, onNavigate });
			s2_fireEvent.keyDown(s2_screen.getByTestId('test-record-fields'), { key: 'ArrowRight' });
			expect(onNavigate).not.toHaveBeenCalled();
		});
		it('renders an empty value as a placeholder instead of a blank row', () => {
			renderModal({ fields: [{ key: 'notes', value: '' }] });
			expect(s2_screen.getByText('notes')).toBeInTheDocument();
			expect(s2_screen.getByText('empty')).toBeInTheDocument();
		});
	});
});
