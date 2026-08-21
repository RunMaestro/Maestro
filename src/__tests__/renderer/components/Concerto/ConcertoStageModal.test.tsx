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
import { beforeEach, describe, expect, it } from 'vitest';
import { ConcertoStageModal } from '../../../../renderer/components/Concerto/ConcertoStageModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { applyMovementPayload, useMovementStore } from '../../../../renderer/stores/movementStore';
import { getModalActions, useModalStore } from '../../../../renderer/stores/modalStore';
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
});
