/**
 * Tests for the Concerto stage window.
 *
 * The load-bearing behaviour here is that CLOSING the stage parks it rather
 * than destroying it: a panel can be a live HTML document (a game mid-move, a
 * half-filled form), so the same iframe must come back on reopen. The rest pins
 * the three ways in and out that every Maestro surface owes the user - Escape,
 * a graphical exit, and a remembered size.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConcertoStageModal } from '../../../../renderer/components/Concerto/ConcertoStageModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { applyMovementPayload, useMovementStore } from '../../../../renderer/stores/movementStore';
import { getModalActions, useModalStore } from '../../../../renderer/stores/modalStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { mockTheme } from '../../../helpers/mockTheme';

function renderStage() {
	return render(
		<LayerStackProvider>
			<ConcertoStageModal theme={mockTheme} />
		</LayerStackProvider>
	);
}

const stageCard = () => screen.getByTestId('concerto-stage-modal');

describe('ConcertoStageModal', () => {
	beforeEach(() => {
		useMovementStore.setState({
			items: [],
			dismissedItems: [],
			viewportWidth: 0,
			viewportHeight: 0,
			flashedId: null,
		});
		getModalActions().setConcertoStageOpen(false);
		useSettingsStore.setState({ concertoStageFloating: false, concertoStagePosition: null });
	});

	it('opens itself when an agent composes a Concerto', () => {
		renderStage();
		expect(stageCard()).toHaveStyle({ display: 'none' });

		act(() => applyMovementPayload({ op: 'add', id: 'board', title: 'Chess' }));

		expect(stageCard()).not.toHaveStyle({ display: 'none' });
		expect(document.querySelector('[data-movement-id="board"]')).not.toBeNull();
	});

	it('parks a closed stage instead of destroying its live panels', () => {
		act(() =>
			applyMovementPayload({
				op: 'add',
				id: 'board',
				viewType: 'html',
				title: 'Chess',
				body: '<button>Move</button>',
			})
		);
		renderStage();
		const frame = screen.getByTestId('concerto-html-iframe');

		fireEvent.click(screen.getByTestId('concerto-stage-esc'));

		expect(useModalStore.getState().isOpen('concertoStage')).toBe(false);
		expect(stageCard()).toHaveStyle({ display: 'none' });
		// Same element, not a remount: the game keeps its position.
		expect(screen.getByTestId('concerto-html-iframe')).toBe(frame);
		expect(useMovementStore.getState().items).toHaveLength(1);

		act(() => getModalActions().setConcertoStageOpen(true));

		expect(screen.getByTestId('concerto-html-iframe')).toBe(frame);
	});

	it('closes on Escape and reopens from the hotkey action', () => {
		act(() => getModalActions().setConcertoStageOpen(true));
		renderStage();

		fireEvent.keyDown(window, { key: 'Escape' });
		expect(useModalStore.getState().isOpen('concertoStage')).toBe(false);

		act(() => getModalActions().toggleConcertoStage());
		expect(useModalStore.getState().isOpen('concertoStage')).toBe(true);
	});

	it('is resizable under a stable key so its size is remembered', () => {
		act(() => getModalActions().setConcertoStageOpen(true));
		renderStage();

		expect(stageCard().querySelector('[data-modal-resize-key="concerto-stage"]')).not.toBeNull();
	});

	describe('floating mode', () => {
		function pointer(type: string, clientX: number, clientY: number, pointerId = 3): MouseEvent {
			const event = new MouseEvent(type, { clientX, clientY, bubbles: true });
			Object.defineProperty(event, 'pointerId', { value: pointerId });
			return event;
		}

		it('pops out and docks again without remounting the stage', () => {
			act(() =>
				applyMovementPayload({
					op: 'add',
					id: 'board',
					viewType: 'html',
					title: 'Chess',
					body: '<button>Move</button>',
				})
			);
			renderStage();
			const frame = screen.getByTestId('concerto-html-iframe');
			expect(screen.queryByTestId('modal-float-handle')).not.toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: 'Pop Concerto stage out' }));

			expect(useSettingsStore.getState().concertoStageFloating).toBe(true);
			expect(screen.getByTestId('modal-float-handle')).toBeInTheDocument();
			// The whole point of popping out: the game does not restart.
			expect(screen.getByTestId('concerto-html-iframe')).toBe(frame);

			fireEvent.click(screen.getByRole('button', { name: 'Dock Concerto stage' }));

			expect(useSettingsStore.getState().concertoStageFloating).toBe(false);
			expect(screen.getByTestId('concerto-html-iframe')).toBe(frame);
		});

		it('stops blocking the app once floating', () => {
			useSettingsStore.setState({ concertoStageFloating: true });
			act(() => getModalActions().setConcertoStageOpen(true));
			renderStage();

			// No backdrop, and the layer itself is click-through: the user is meant to
			// keep working in the app beside the stage.
			const overlay = stageCard();
			expect(overlay).toHaveClass('pointer-events-none');
			expect(overlay).not.toHaveClass('modal-overlay');
			expect(overlay).not.toHaveAttribute('aria-modal');
		});

		it('drags by the header and remembers where it was dropped', () => {
			useSettingsStore.setState({
				concertoStageFloating: true,
				concertoStagePosition: { x: 100, y: 80 },
			});
			act(() => getModalActions().setConcertoStageOpen(true));
			renderStage();

			const handle = screen.getByTestId('modal-float-handle');
			Object.defineProperties(handle, {
				setPointerCapture: { configurable: true, value: vi.fn() },
				releasePointerCapture: { configurable: true, value: vi.fn() },
			});

			fireEvent(handle, pointer('pointerdown', 200, 200));
			fireEvent(window, pointer('pointermove', 260, 240));
			fireEvent(window, pointer('pointerup', 260, 240));

			expect(useSettingsStore.getState().concertoStagePosition).toEqual({ x: 160, y: 120 });
		});

		it('clamps a dropped position so the header stays grabbable', () => {
			useSettingsStore.setState({
				concertoStageFloating: true,
				concertoStagePosition: { x: 10, y: 10 },
			});
			act(() => getModalActions().setConcertoStageOpen(true));
			renderStage();

			const handle = screen.getByTestId('modal-float-handle');
			Object.defineProperties(handle, {
				setPointerCapture: { configurable: true, value: vi.fn() },
				releasePointerCapture: { configurable: true, value: vi.fn() },
			});

			// Yank it far past the bottom-right corner and off the top-left.
			fireEvent(handle, pointer('pointerdown', 0, 0, 4));
			fireEvent(window, pointer('pointermove', -500, -500, 4));
			fireEvent(window, pointer('pointerup', -500, -500, 4));

			expect(useSettingsStore.getState().concertoStagePosition).toEqual({ x: 0, y: 0 });
		});
	});
});
