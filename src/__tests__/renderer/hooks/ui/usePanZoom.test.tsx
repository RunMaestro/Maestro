/**
 * `usePanZoom` - wheel zoom about the cursor, drag pan, stepped zoom.
 *
 * Pinned here: zooming about a point keeps that point still (the offset math),
 * the wheel listener is non-passive so a pinch cannot fall through to the page
 * zoom, the drag keeps tracking after the cursor leaves the canvas, and the
 * bounds hold.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { usePanZoom, type UsePanZoomOptions } from '../../../../renderer/hooks/ui/usePanZoom';

let latest: ReturnType<typeof usePanZoom>;

function Harness(props: UsePanZoomOptions) {
	const pz = usePanZoom(props);
	latest = pz;
	return (
		<div ref={pz.containerRef} data-testid="canvas" onMouseDown={pz.onMouseDown}>
			<div data-testid="content" style={{ transform: pz.transform }} />
		</div>
	);
}

/** A 200x100 canvas at the origin, so its center is (100, 50). */
function stubCanvasRect() {
	screen.getByTestId('canvas').getBoundingClientRect = () =>
		({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0 }) as DOMRect;
}

function wheel(deltaY: number, clientX: number, clientY: number, ctrlKey = false) {
	const event = new WheelEvent('wheel', { deltaY, clientX, clientY, ctrlKey, cancelable: true });
	act(() => {
		screen.getByTestId('canvas').dispatchEvent(event);
	});
	return event;
}

describe('usePanZoom', () => {
	it('starts fitted', () => {
		render(<Harness />);
		expect(latest.zoom).toBe(1);
		expect(latest.offset).toEqual({ x: 0, y: 0 });
		expect(latest.transform).toBe('translate(0px, 0px) scale(1)');
	});

	it('steps zoom in and out, and fits back', () => {
		render(<Harness />);
		act(() => latest.zoomIn());
		expect(latest.zoom).toBeCloseTo(1.25);
		act(() => latest.zoomOut());
		act(() => latest.zoomOut());
		expect(latest.zoom).toBeCloseTo(0.8);
		act(() => latest.panBy(30, -10));
		act(() => latest.fitToView());
		expect(latest.zoom).toBe(1);
		expect(latest.offset).toEqual({ x: 0, y: 0 });
	});

	it('clamps to the zoom bounds and reports them', () => {
		render(<Harness minZoom={0.5} maxZoom={2} />);
		for (let i = 0; i < 10; i++) act(() => latest.zoomIn());
		expect(latest.zoom).toBe(2);
		expect(latest.canZoomIn).toBe(false);
		for (let i = 0; i < 10; i++) act(() => latest.zoomOut());
		expect(latest.zoom).toBe(0.5);
		expect(latest.canZoomOut).toBe(false);
	});

	it('zooms about the cursor so the point under it stays put', () => {
		render(<Harness />);
		stubCanvasRect();
		// Cursor at (150, 50): 50px right of center. Zoom in by 1 - (-500 * 0.002) = 2x.
		const event = wheel(-500, 150, 50);
		expect(latest.zoom).toBeCloseTo(2);
		// The content point under the cursor was at +50; after 2x it must still be
		// at +50 on screen, so the offset moves left by 50.
		expect(latest.offset.x).toBeCloseTo(-50);
		expect(latest.offset.y).toBeCloseTo(0);
		// Non-passive listener: the page itself must not scroll or zoom.
		expect(event.defaultPrevented).toBe(true);
	});

	it('treats a ctrl-wheel pinch with more sensitivity than a scroll', () => {
		render(<Harness />);
		stubCanvasRect();
		wheel(-10, 100, 50, true);
		const pinchZoom = latest.zoom;
		act(() => latest.fitToView());
		wheel(-10, 100, 50, false);
		expect(pinchZoom).toBeGreaterThan(latest.zoom);
	});

	it('pans on drag, and keeps tracking on window after the cursor leaves', () => {
		render(<Harness />);
		fireEvent.mouseDown(screen.getByTestId('canvas'), { button: 0, clientX: 10, clientY: 10 });
		expect(latest.dragging).toBe(true);
		act(() => {
			window.dispatchEvent(new MouseEvent('mousemove', { clientX: 70, clientY: -20 }));
		});
		expect(latest.offset).toEqual({ x: 60, y: -30 });
		act(() => {
			window.dispatchEvent(new MouseEvent('mouseup'));
		});
		expect(latest.dragging).toBe(false);
		act(() => {
			window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 500 }));
		});
		expect(latest.offset).toEqual({ x: 60, y: -30 });
	});

	it('ignores a right-button press', () => {
		render(<Harness />);
		fireEvent.mouseDown(screen.getByTestId('canvas'), { button: 2 });
		expect(latest.dragging).toBe(false);
	});

	it('resets to fitted when the reset key changes', () => {
		const { rerender } = render(<Harness resetKey="a.png" />);
		act(() => latest.zoomIn());
		act(() => latest.panBy(10, 10));
		rerender(<Harness resetKey="b.png" />);
		expect(latest.zoom).toBe(1);
		expect(latest.offset).toEqual({ x: 0, y: 0 });
	});
});
