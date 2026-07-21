import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MovementOverlay } from '../../../../renderer/components/Movement/MovementOverlay';
import { applyMovementPayload, useMovementStore } from '../../../../renderer/stores/movementStore';
import { flashConcertoTarget } from '../../../../renderer/utils/concertoLinks';
import { mockTheme } from '../../../helpers/mockTheme';

describe('MovementOverlay', () => {
	beforeEach(() => {
		useMovementStore.setState({
			items: [],
			dismissedItems: [],
			viewportWidth: 0,
			viewportHeight: 0,
			hidden: false,
			flashedId: null,
		});
		vi.mocked(window.maestro.process.releaseConcertoHtmlDocument).mockClear();
		vi.mocked(window.maestro.process.restoreConcertoHtmlDocument).mockReset();
		vi.mocked(window.maestro.process.restoreConcertoHtmlDocument).mockResolvedValue(44);
	});

	it('reopens a user-closed HTML movement from its chat chip as a fresh frame', async () => {
		applyMovementPayload({
			op: 'add',
			id: 'mockup',
			viewType: 'html',
			title: 'Checkout mockup',
			body: '<button>Buy</button>',
			revision: 8,
		});
		render(<MovementOverlay theme={mockTheme} />);
		const originalFrame = screen.getByTestId('concerto-html-iframe');

		fireEvent.click(screen.getByRole('button', { name: 'Close movement panel' }));
		expect(screen.queryByTestId('concerto-html-iframe')).not.toBeInTheDocument();

		await act(async () => {
			await expect(flashConcertoTarget('maestro://concerto/movement/mockup')).resolves.toBe(true);
		});

		const restoredFrame = screen.getByTestId('concerto-html-iframe');
		expect(restoredFrame).not.toBe(originalFrame);
		expect(restoredFrame.getAttribute('src')).toContain('revision=44');
		expect(window.maestro.process.restoreConcertoHtmlDocument).toHaveBeenCalledWith(
			'movement',
			'mockup',
			'<button>Buy</button>'
		);
	});

	it('labels plugin-namespaced host views with their provenance', () => {
		applyMovementPayload({
			op: 'add',
			id: 'com.acme.metrics/release-summary',
			title: 'Release summary',
			body: JSON.stringify({ blocks: [] }),
			sourcePlugin: 'Acme Metrics',
		});

		render(<MovementOverlay theme={mockTheme} />);

		expect(screen.getByText('from Acme Metrics')).toHaveAttribute('title', 'from Acme Metrics');
	});

	it('renders an HTML movement in the isolated document frame', () => {
		applyMovementPayload({
			op: 'add',
			id: 'mockup',
			viewType: 'html',
			title: 'Checkout mockup',
			body: '<button>Buy</button><script>window.clicked=true</script>',
		});

		render(<MovementOverlay theme={mockTheme} />);

		const iframe = screen.getByTestId('concerto-html-iframe');
		expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
		expect(iframe.getAttribute('src')).toContain(
			'maestro-concerto://render/?surface=movement&id=mockup'
		);

		fireEvent.click(screen.getByRole('button', { name: 'Close movement panel' }));
		expect(window.maestro.process.releaseConcertoHtmlDocument).toHaveBeenCalledWith(
			'movement',
			'mockup'
		);
		expect(useMovementStore.getState().items).toEqual([]);
		expect(useMovementStore.getState().dismissedItems).toMatchObject([{ id: 'mockup' }]);
	});

	it('keeps HTML frames mounted while the overlay is stashed', () => {
		applyMovementPayload({
			op: 'add',
			id: 'live-game',
			viewType: 'html',
			title: 'Live game',
			body: '<button>Move</button>',
		});
		render(<MovementOverlay theme={mockTheme} />);
		const frame = screen.getByTestId('concerto-html-iframe');

		act(() => useMovementStore.getState().setHidden(true));

		expect(screen.getByTestId('concerto-html-iframe')).toBe(frame);
		expect(screen.getByTestId('movement-panels')).toHaveStyle({ visibility: 'hidden' });
		expect(screen.getByTitle('Show Concerto windows')).toBeInTheDocument();

		act(() => useMovementStore.getState().setHidden(false));

		expect(screen.getByTestId('concerto-html-iframe')).toBe(frame);
		expect(screen.getByTestId('movement-panels')).toHaveStyle({ visibility: 'visible' });
	});

	it('minimizes a Concerto without unmounting it and restores it from the taskbar', () => {
		applyMovementPayload({
			op: 'add',
			id: 'chess',
			viewType: 'html',
			title: 'Chess',
			body: '<button>Move</button>',
		});
		applyMovementPayload({ op: 'add', id: 'notes', title: 'Notes' });
		render(<MovementOverlay theme={mockTheme} />);
		const frame = screen.getByTestId('concerto-html-iframe');

		fireEvent.click(screen.getByRole('button', { name: 'Minimize Chess' }));

		expect(useMovementStore.getState().items.find((item) => item.id === 'chess')?.minimized).toBe(
			true
		);
		expect(screen.getByTestId('concerto-html-iframe')).toBe(frame);
		expect(document.querySelector('[data-movement-id="chess"]')).toHaveStyle({
			visibility: 'hidden',
		});

		fireEvent.mouseEnter(screen.getByTestId('movement-taskbar'));
		expect(screen.getByLabelText('Concerto taskbar')).toHaveAttribute('aria-hidden', 'false');
		fireEvent.click(screen.getByRole('button', { name: 'Restore Chess' }));

		expect(useMovementStore.getState().items.at(-1)).toMatchObject({
			id: 'chess',
			minimized: false,
		});
		expect(document.querySelector('[data-movement-id="chess"]')).toHaveStyle({
			visibility: 'visible',
		});
		expect(screen.getByTestId('concerto-html-iframe')).toBe(frame);
	});
});
