import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MovementOverlay } from '../../../../renderer/components/Movement/MovementOverlay';
import { applyMovementPayload, useMovementStore } from '../../../../renderer/stores/movementStore';
import { flashConcertoTarget } from '../../../../renderer/utils/concertoLinks';
import { mockTheme } from '../../../helpers/mockTheme';

function pointer(type: string, clientX: number, clientY: number, pointerId = 7): MouseEvent {
	const event = new MouseEvent(type, { clientX, clientY, bubbles: true });
	Object.defineProperty(event, 'pointerId', { value: pointerId });
	return event;
}

function enablePointerCapture(handle: HTMLElement): void {
	Object.defineProperties(handle, {
		setPointerCapture: { configurable: true, value: vi.fn() },
		releasePointerCapture: { configurable: true, value: vi.fn() },
	});
}

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

	it('keeps the Maestro viewport current for agent layout reads', () => {
		const originalWidth = window.innerWidth;
		const originalHeight = window.innerHeight;
		try {
			Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
			Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
			applyMovementPayload({ op: 'add', id: 'viewport-probe' });
			render(<MovementOverlay theme={mockTheme} />);

			expect(useMovementStore.getState()).toMatchObject({
				viewportWidth: 1440,
				viewportHeight: 900,
			});

			Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
			Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 });
			fireEvent(window, new Event('resize'));

			expect(useMovementStore.getState()).toMatchObject({
				viewportWidth: 1280,
				viewportHeight: 720,
			});
		} finally {
			Object.defineProperty(window, 'innerWidth', {
				configurable: true,
				value: originalWidth,
			});
			Object.defineProperty(window, 'innerHeight', {
				configurable: true,
				value: originalHeight,
			});
		}
	});

	it('hides and restores all windows from the taskbar without remounting HTML frames', () => {
		applyMovementPayload({
			op: 'add',
			id: 'live-game',
			viewType: 'html',
			title: 'Live game',
			body: '<button>Move</button>',
		});
		render(<MovementOverlay theme={mockTheme} />);
		const frame = screen.getByTestId('concerto-html-iframe');

		fireEvent.mouseEnter(screen.getByTestId('movement-taskbar'));
		expect(screen.getAllByRole('button', { name: 'Hide all Concerto windows' })).toHaveLength(1);
		fireEvent.click(screen.getByRole('button', { name: 'Hide all Concerto windows' }));

		expect(screen.getByTestId('concerto-html-iframe')).toBe(frame);
		expect(screen.getByTestId('movement-panels')).toHaveStyle({ visibility: 'hidden' });
		expect(document.querySelector('[data-movement-id="live-game"]')).toHaveStyle({
			visibility: 'hidden',
		});
		expect(screen.getByRole('button', { name: 'Show all Concerto windows' })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Show all Concerto windows' }));

		expect(screen.getByTestId('concerto-html-iframe')).toBe(frame);
		expect(screen.getByTestId('movement-panels')).toHaveStyle({ visibility: 'visible' });
	});

	it('pins the taskbar open when its launcher is clicked', () => {
		applyMovementPayload({ op: 'add', id: 'notes', title: 'Notes' });
		render(<MovementOverlay theme={mockTheme} />);
		const taskbar = screen.getByTestId('movement-taskbar');

		fireEvent.mouseEnter(taskbar);
		fireEvent.click(screen.getByRole('button', { name: 'Pin Concerto taskbar open' }));
		fireEvent.mouseLeave(taskbar);

		expect(screen.getByRole('button', { name: 'Unpin Concerto taskbar' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		expect(screen.getByLabelText('Concerto taskbar')).toHaveAttribute('aria-hidden', 'false');
	});

	it('anchors the collapsed taskbar at bottom-right above every Concerto', () => {
		applyMovementPayload({ op: 'add', id: 'back-window', title: 'Back window' });
		applyMovementPayload({ op: 'add', id: 'front-window', title: 'Front window' });
		render(<MovementOverlay theme={mockTheme} />);

		const anchor = screen.getByTestId('movement-taskbar-anchor');
		const taskbar = screen.getByTestId('movement-taskbar');
		expect(anchor).toHaveClass('bottom-3', 'right-3');
		expect(anchor).not.toHaveClass('left-1/2', '-translate-x-1/2');
		expect(anchor).toHaveStyle({ zIndex: 3 });
		expect(document.querySelector('[data-movement-id="back-window"]')).toHaveStyle({
			zIndex: 1,
		});
		expect(document.querySelector('[data-movement-id="front-window"]')).toHaveStyle({
			zIndex: 2,
		});
		expect(taskbar).toHaveStyle({ width: '44px' });

		fireEvent.mouseEnter(anchor);
		expect(screen.getByLabelText('Concerto taskbar')).toHaveAttribute('aria-hidden', 'false');
		expect(screen.getByRole('button', { name: 'Pin Concerto taskbar open' })).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		expect(anchor).toHaveClass('right-3');

		const taskbarContent = screen.getByLabelText('Concerto taskbar');
		fireEvent.click(within(taskbarContent).getByRole('button', { name: 'Minimize Back window' }));
		fireEvent.click(within(taskbarContent).getByRole('button', { name: 'Restore Back window' }));

		expect(useMovementStore.getState().items.map((item) => item.id)).toEqual([
			'front-window',
			'back-window',
		]);
		expect(
			within(taskbarContent)
				.getAllByRole('button', { name: /^Minimize (Back|Front) window$/ })
				.map((button) => button.textContent)
		).toEqual(['Back window', 'Front window']);
	});

	it('gives an unpinned taskbar a grace period before collapsing', () => {
		vi.useFakeTimers();
		try {
			applyMovementPayload({ op: 'add', id: 'notes', title: 'Notes' });
			render(<MovementOverlay theme={mockTheme} />);
			const taskbar = screen.getByTestId('movement-taskbar');

			fireEvent.mouseEnter(taskbar);
			fireEvent.mouseLeave(taskbar);
			act(() => vi.advanceTimersByTime(1499));
			expect(screen.getByLabelText('Concerto taskbar')).toHaveAttribute('aria-hidden', 'false');

			act(() => vi.advanceTimersByTime(1));
			expect(screen.getByLabelText('Concerto taskbar', { hidden: true })).toHaveAttribute(
				'aria-hidden',
				'true'
			);
		} finally {
			vi.useRealTimers();
		}
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
		const taskbar = screen.getByLabelText('Concerto taskbar');
		expect(taskbar).toHaveAttribute('aria-hidden', 'false');
		fireEvent.click(within(taskbar).getByRole('button', { name: 'Restore Chess' }));

		expect(useMovementStore.getState().items.at(-1)).toMatchObject({
			id: 'chess',
			minimized: false,
		});
		expect(document.querySelector('[data-movement-id="chess"]')).toHaveStyle({
			visibility: 'visible',
		});
		expect(screen.getByTestId('concerto-html-iframe')).toBe(frame);

		fireEvent.click(within(taskbar).getByRole('button', { name: 'Minimize Chess' }));
		expect(useMovementStore.getState().items.find((item) => item.id === 'chess')).toMatchObject({
			minimized: true,
		});
		expect(screen.getByTestId('concerto-html-iframe')).toBe(frame);

		fireEvent.click(within(taskbar).getByRole('button', { name: 'Restore Chess' }));
		expect(useMovementStore.getState().items.at(-1)).toMatchObject({
			id: 'chess',
			minimized: false,
		});
	});

	it('resizes from every edge and corner and keeps north-west geometry atomic', () => {
		applyMovementPayload({
			op: 'add',
			id: 'canvas',
			x: 100,
			y: 80,
			width: 400,
			height: 300,
		});
		render(<MovementOverlay theme={mockTheme} />);

		for (const direction of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
			expect(screen.getByTestId(`movement-resize-handle-${direction}`)).toBeInTheDocument();
		}

		const westHandle = screen.getByTestId('movement-resize-handle-w');
		enablePointerCapture(westHandle);
		fireEvent(westHandle, pointer('pointerdown', 100, 200));
		fireEvent(window, pointer('pointermove', 150, 200));
		fireEvent(window, pointer('pointerup', 150, 200));

		expect(useMovementStore.getState().items[0]).toMatchObject({
			x: 150,
			y: 80,
			width: 350,
			height: 300,
		});

		const northHandle = screen.getByTestId('movement-resize-handle-n');
		enablePointerCapture(northHandle);
		fireEvent(northHandle, pointer('pointerdown', 250, 80, 8));
		fireEvent(window, pointer('pointermove', 250, 120, 8));
		fireEvent(window, pointer('pointerup', 250, 120, 8));

		expect(useMovementStore.getState().items[0]).toMatchObject({
			x: 150,
			y: 120,
			width: 350,
			height: 260,
		});
	});
});
