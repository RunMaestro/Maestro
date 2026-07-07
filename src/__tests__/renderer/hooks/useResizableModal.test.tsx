import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizeHandles } from '../../../renderer/components/ui/ResizeHandles';
import { useResizableModal } from '../../../renderer/hooks/ui/useResizableModal';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';

function setViewport(width: number, height: number) {
	Object.defineProperty(window, 'innerWidth', {
		configurable: true,
		value: width,
	});
	Object.defineProperty(window, 'innerHeight', {
		configurable: true,
		value: height,
	});
}

function Harness({
	resizeKey = 'test-modal',
	defaultSize = { width: 400, height: 300 },
	minSize = { width: 320, height: 240 },
	enabled = true,
}: {
	resizeKey?: string;
	defaultSize?: { width: number; height: number };
	minSize?: { width: number; height: number };
	enabled?: boolean;
}) {
	const modal = useResizableModal({
		resizeKey,
		defaultSize,
		minSize,
		enabled,
	});

	return (
		<div ref={modal.modalRef} data-testid="modal" style={modal.style}>
			<ResizeHandles onResizeStart={modal.onResizeStart} accentColor="#ff00ff" />
		</div>
	);
}

describe('useResizableModal', () => {
	beforeEach(() => {
		setViewport(1200, 900);
		useSettingsStore.setState({ modalSizes: {} });
		vi.mocked(window.maestro.settings.set).mockClear();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('renders all edge and corner handles', () => {
		render(<Harness />);

		for (const direction of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
			expect(screen.getByTestId(`modal-resize-handle-${direction}`)).toBeInTheDocument();
		}
	});

	it('updates DOM size live and persists only on mouseup', () => {
		render(<Harness />);

		const modal = screen.getByTestId('modal');
		expect(modal).toHaveStyle({ width: '400px', height: '300px' });

		fireEvent.mouseDown(screen.getByTestId('modal-resize-handle-se'), {
			clientX: 0,
			clientY: 0,
		});
		fireEvent.mouseMove(document, {
			clientX: 50,
			clientY: 20,
		});

		expect(modal.style.width).toBe('500px');
		expect(modal.style.height).toBe('340px');
		expect(window.maestro.settings.set).not.toHaveBeenCalled();

		fireEvent.mouseUp(document);

		expect(useSettingsStore.getState().modalSizes['test-modal']).toEqual({
			width: 500,
			height: 340,
		});
		expect(window.maestro.settings.set).toHaveBeenCalledWith('modalSizes', {
			'test-modal': { width: 500, height: 340 },
		});
	});

	it('cleans document drag listeners when unmounted during a drag', () => {
		const removeSpy = vi.spyOn(document, 'removeEventListener');
		const { unmount } = render(<Harness />);

		fireEvent.mouseDown(screen.getByTestId('modal-resize-handle-e'), {
			clientX: 0,
			clientY: 0,
		});

		unmount();

		expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
		expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));
	});

	it('re-clamps immediately and persists (debounced) when the viewport shrinks', async () => {
		render(<Harness defaultSize={{ width: 700, height: 600 }} />);

		const modal = screen.getByTestId('modal');
		expect(modal).toHaveStyle({ width: '700px', height: '600px' });

		setViewport(500, 400);
		act(() => {
			window.dispatchEvent(new Event('resize'));
		});

		// DOM and React state re-clamp synchronously; only the settings write is debounced.
		expect(modal.style.width).toBe('436px');
		expect(modal.style.height).toBe('336px');
		expect(window.maestro.settings.set).not.toHaveBeenCalled();

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 350));
		});

		expect(useSettingsStore.getState().modalSizes['test-modal']).toEqual({
			width: 436,
			height: 336,
		});
	});

	it('debounces settings persistence across rapid viewport resize events', async () => {
		render(<Harness defaultSize={{ width: 700, height: 600 }} />);

		setViewport(500, 400);
		act(() => {
			window.dispatchEvent(new Event('resize'));
		});
		setViewport(480, 380);
		act(() => {
			window.dispatchEvent(new Event('resize'));
		});
		setViewport(460, 360);
		act(() => {
			window.dispatchEvent(new Event('resize'));
		});

		expect(window.maestro.settings.set).not.toHaveBeenCalled();

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 350));
		});

		// Three rapid ticks coalesce into a single persisted write.
		expect(window.maestro.settings.set).toHaveBeenCalledTimes(1);
	});

	it('a manual drag commit is not later overwritten by a stale pending debounced resize write', async () => {
		render(<Harness defaultSize={{ width: 700, height: 600 }} />);

		// Schedule a debounced persist from a viewport shrink...
		setViewport(500, 400);
		act(() => {
			window.dispatchEvent(new Event('resize'));
		});

		// ...then, before that debounce fires, the user manually drags to a
		// different size and releases - this should commit and persist immediately.
		// (The viewport-resize handler already clamped the size to the 500x400
		// viewport's exact max, so shrinking from the "nw" corner is used here to
		// land on a value distinct from that stale ceiling.)
		fireEvent.mouseDown(screen.getByTestId('modal-resize-handle-nw'), {
			clientX: 0,
			clientY: 0,
		});
		fireEvent.mouseMove(document, { clientX: 30, clientY: 20 });
		fireEvent.mouseUp(document);

		expect(useSettingsStore.getState().modalSizes['test-modal']).toEqual({
			width: 376,
			height: 296,
		});

		// Let the stale debounced viewport-resize write's timer elapse - it must
		// not land and clobber the manual commit above.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 350));
		});

		expect(useSettingsStore.getState().modalSizes['test-modal']).toEqual({
			width: 376,
			height: 296,
		});
	});

	it('cleans up a previous drag before starting a new one if the first never received mouseup', () => {
		render(<Harness />);

		fireEvent.mouseDown(screen.getByTestId('modal-resize-handle-e'), {
			clientX: 0,
			clientY: 0,
		});

		const removeSpy = vi.spyOn(document, 'removeEventListener');

		// Start a second drag without the first drag ever getting a mouseup -
		// the first drag's document listeners must be torn down, not orphaned.
		fireEvent.mouseDown(screen.getByTestId('modal-resize-handle-s'), {
			clientX: 0,
			clientY: 0,
		});

		expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
		expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));

		fireEvent.mouseUp(document);

		// Only the second (active) drag should commit.
		expect(window.maestro.settings.set).toHaveBeenCalledTimes(1);
	});

	it('commits the in-progress size and tears down listeners when the window loses focus mid-drag', () => {
		render(<Harness />);

		const modal = screen.getByTestId('modal');
		fireEvent.mouseDown(screen.getByTestId('modal-resize-handle-se'), {
			clientX: 0,
			clientY: 0,
		});
		fireEvent.mouseMove(document, { clientX: 50, clientY: 20 });

		expect(modal.style.width).toBe('500px');
		expect(window.maestro.settings.set).not.toHaveBeenCalled();

		fireEvent(window, new Event('blur'));

		expect(useSettingsStore.getState().modalSizes['test-modal']).toEqual({
			width: 500,
			height: 340,
		});

		// Further mouse movement (e.g. unrelated activity elsewhere in the app)
		// must not keep resizing the modal - the drag listeners were removed.
		fireEvent.mouseMove(document, { clientX: 999, clientY: 999 });
		expect(modal.style.width).toBe('500px');
	});

	it('uses a saved size when it is valid', () => {
		useSettingsStore.setState({
			modalSizes: {
				'test-modal': { width: 520, height: 360 },
			},
		});

		render(<Harness />);

		expect(screen.getByTestId('modal')).toHaveStyle({
			width: '520px',
			height: '360px',
		});
	});
});
