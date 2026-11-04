// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/ui/useDragAutoScroll.test.tsx
// Source: src/__tests__/renderer/hooks/ui/usePanZoom.test.tsx
// Source: src/__tests__/renderer/hooks/ui/useChatFileDropZone.test.tsx
// Source: src/__tests__/renderer/hooks/ui/useLayerSwipeDismiss.test.ts
import { describe, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act as s1_act, render as s1_render } from '@testing-library/react';
import { useRef } from 'react';
import { useDragAutoScroll } from '../../../../renderer/hooks/ui/useDragAutoScroll';
import {
	render as s2_render,
	screen as s2_screen,
	fireEvent as s2_fireEvent,
	act as s2_act,
} from '@testing-library/react';
import { usePanZoom, type UsePanZoomOptions } from '../../../../renderer/hooks/ui/usePanZoom';
import {
	fireEvent as s3_fireEvent,
	render as s3_render,
	screen as s3_screen,
} from '@testing-library/react';
import { useChatFileDropZone } from '../../../../renderer/hooks/ui/useChatFileDropZone';
import type { Theme } from '../../../../renderer/types';
import { renderHook } from '@testing-library/react';
import {
	LAYER_SWIPE_DISMISS,
	startsInsideScrolledRegion,
	useLayerSwipeDismiss,
} from '../../../../renderer/hooks/ui/useLayerSwipeDismiss';
import { isWebDesktop } from '../../../../renderer/utils/runtimeContext';
import { isCoarsePointer } from '../../../../renderer/utils/touch';
vi.mock('../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => true),
}));
vi.mock('../../../../renderer/utils/touch', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/utils/touch')>()),
	isCoarsePointer: vi.fn(() => true),
}));
// Source: src/__tests__/renderer/hooks/ui/useDragAutoScroll.test.tsx
describe('', () => {
	const RECT = { left: 100, right: 500, top: 0, bottom: 40 };
	function Harness({
		active,
		axis = 'horizontal' as const,
		startInset = 0,
		endInset = 0,
		edgeSize = 64,
		maxSpeed = 1000,
	}: {
		active: boolean;
		axis?: 'horizontal' | 'vertical';
		startInset?: number;
		endInset?: number;
		edgeSize?: number;
		maxSpeed?: number;
	}) {
		const ref = useRef<HTMLDivElement | null>(null);
		useDragAutoScroll(ref, {
			active,
			axis,
			edgeSize,
			maxSpeed,
			startInset: () => startInset,
			endInset: () => endInset,
		});
		return (
			<div
				ref={(el) => {
					if (!el) return;
					// jsdom has no layout, so its scrollLeft/scrollTop setters are inert.
					// Real own properties let the assertions read back what was written.
					Object.defineProperty(el, 'scrollLeft', { value: 0, writable: true, configurable: true });
					Object.defineProperty(el, 'scrollTop', { value: 0, writable: true, configurable: true });
					el.getBoundingClientRect = () =>
						({
							...RECT,
							width: RECT.right - RECT.left,
							height: RECT.bottom - RECT.top,
							x: RECT.left,
							y: RECT.top,
						}) as DOMRect;
					ref.current = el;
				}}
				data-testid="strip"
			/>
		);
	}
	/** Drive the rAF loop by hand so scroll deltas are deterministic. */
	let frameHandles = new Map<number, FrameRequestCallback>();
	let nextHandle = 0;
	let now = 0;
	function runFrame(elapsedMs: number) {
		now += elapsedMs;
		const pending = [...frameHandles.values()];
		frameHandles.clear();
		s1_act(() => {
			pending.forEach((cb) => cb(now));
		});
	}
	function dragOver(el: HTMLElement, clientX: number, clientY: number) {
		s1_act(() => {
			const event = new Event('dragover', { bubbles: true, cancelable: true });
			Object.assign(event, { clientX, clientY });
			el.dispatchEvent(event);
		});
	}
	describe('useDragAutoScroll', () => {
		beforeEach(() => {
			frameHandles = new Map();
			nextHandle = 0;
			now = 0;
			vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
				frameHandles.set(++nextHandle, cb);
				return nextHandle;
			});
			vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
				frameHandles.delete(handle);
			});
			vi.spyOn(performance, 'now').mockImplementation(() => now);
		});
		afterEach(() => {
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
		});
		it('scrolls toward the end when the drag hovers the trailing edge', () => {
			const { getByTestId } = s1_render(<Harness active />);
			const strip = getByTestId('strip');
			strip.scrollLeft = 0;
			// First frame only establishes the clock baseline.
			runFrame(0);
			dragOver(strip, 495, 20);
			runFrame(100);
			expect(strip.scrollLeft).toBeGreaterThan(0);
		});
		it('scrolls toward the start when the drag hovers the leading edge', () => {
			const { getByTestId } = s1_render(<Harness active />);
			const strip = getByTestId('strip');
			strip.scrollLeft = 200;
			runFrame(0);
			dragOver(strip, 105, 20);
			runFrame(100);
			expect(strip.scrollLeft).toBeLessThan(200);
		});
		it('leaves the middle of the strip alone', () => {
			const { getByTestId } = s1_render(<Harness active />);
			const strip = getByTestId('strip');
			strip.scrollLeft = 200;
			runFrame(0);
			dragOver(strip, 300, 20);
			runFrame(100);
			expect(strip.scrollLeft).toBe(200);
		});
		it('ramps speed with how deep into the band the pointer sits', () => {
			const { getByTestId, unmount } = s1_render(<Harness active />);
			const shallow = getByTestId('strip');
			shallow.scrollLeft = 0;
			runFrame(0);
			dragOver(shallow, 445, 20);
			runFrame(100);
			const shallowDelta = shallow.scrollLeft;
			unmount();
			const second = s1_render(<Harness active />);
			const deep = second.getByTestId('strip');
			deep.scrollLeft = 0;
			runFrame(0);
			dragOver(deep, 499, 20);
			runFrame(100);
			expect(deep.scrollLeft).toBeGreaterThan(shallowDelta);
		});
		it('treats the sticky insets as the real edges', () => {
			const { getByTestId } = s1_render(<Harness active startInset={80} endInset={48} />);
			const strip = getByTestId('strip');
			strip.scrollLeft = 200;
			// x=470 is inside the container but under the sticky trailing area, which
			// still counts as the trailing band, so it scrolls forward.
			runFrame(0);
			dragOver(strip, 470, 20);
			runFrame(100);
			expect(strip.scrollLeft).toBeGreaterThan(200);
			// x=190 sits past the 80px leading inset but still within a band measured
			// from the inset edge, so it scrolls back.
			const before = strip.scrollLeft;
			dragOver(strip, 190, 20);
			runFrame(100);
			expect(strip.scrollLeft).toBeLessThan(before);
		});
		it('ignores a pointer that has left the strip on the cross axis', () => {
			const { getByTestId } = s1_render(<Harness active />);
			const strip = getByTestId('strip');
			strip.scrollLeft = 200;
			runFrame(0);
			dragOver(strip, 495, 300);
			runFrame(100);
			expect(strip.scrollLeft).toBe(200);
		});
		it('stops when the platform stops reporting the pointer', () => {
			const { getByTestId } = s1_render(<Harness active />);
			const strip = getByTestId('strip');
			strip.scrollLeft = 0;
			runFrame(0);
			dragOver(strip, 495, 20);
			runFrame(100);
			const afterFirst = strip.scrollLeft;
			expect(afterFirst).toBeGreaterThan(0);
			// No further dragover: the drag left the window.
			runFrame(700);
			runFrame(100);
			expect(strip.scrollLeft).toBe(afterFirst);
		});
		it('does nothing while no drag is in flight', () => {
			const { getByTestId } = s1_render(<Harness active={false} />);
			const strip = getByTestId('strip');
			strip.scrollLeft = 200;
			dragOver(strip, 495, 20);
			runFrame(100);
			expect(strip.scrollLeft).toBe(200);
		});
		it('scrolls vertically when the axis is vertical', () => {
			const { getByTestId } = s1_render(<Harness active axis="vertical" edgeSize={10} />);
			const strip = getByTestId('strip');
			strip.scrollTop = 0;
			runFrame(0);
			// The rect is 40px tall, so the band is capped at half of it.
			dragOver(strip, 300, 39);
			runFrame(100);
			expect(strip.scrollTop).toBeGreaterThan(0);
		});
	});
});
// Source: src/__tests__/renderer/hooks/ui/usePanZoom.test.tsx
describe('', () => {
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
		s2_screen.getByTestId('canvas').getBoundingClientRect = () =>
			({
				left: 0,
				top: 0,
				width: 200,
				height: 100,
				right: 200,
				bottom: 100,
				x: 0,
				y: 0,
			}) as DOMRect;
	}
	function wheel(deltaY: number, clientX: number, clientY: number, ctrlKey = false) {
		const event = new WheelEvent('wheel', { deltaY, clientX, clientY, ctrlKey, cancelable: true });
		s2_act(() => {
			s2_screen.getByTestId('canvas').dispatchEvent(event);
		});
		return event;
	}
	describe('usePanZoom', () => {
		it('starts fitted', () => {
			s2_render(<Harness />);
			expect(latest.zoom).toBe(1);
			expect(latest.offset).toEqual({ x: 0, y: 0 });
			expect(latest.transform).toBe('translate(0px, 0px) scale(1)');
		});
		it('steps zoom in and out, and fits back', () => {
			s2_render(<Harness />);
			s2_act(() => latest.zoomIn());
			expect(latest.zoom).toBeCloseTo(1.25);
			s2_act(() => latest.zoomOut());
			s2_act(() => latest.zoomOut());
			expect(latest.zoom).toBeCloseTo(0.8);
			s2_act(() => latest.panBy(30, -10));
			s2_act(() => latest.fitToView());
			expect(latest.zoom).toBe(1);
			expect(latest.offset).toEqual({ x: 0, y: 0 });
		});
		it('clamps to the zoom bounds and reports them', () => {
			s2_render(<Harness minZoom={0.5} maxZoom={2} />);
			for (let i = 0; i < 10; i++) s2_act(() => latest.zoomIn());
			expect(latest.zoom).toBe(2);
			expect(latest.canZoomIn).toBe(false);
			for (let i = 0; i < 10; i++) s2_act(() => latest.zoomOut());
			expect(latest.zoom).toBe(0.5);
			expect(latest.canZoomOut).toBe(false);
		});
		it('zooms about the cursor so the point under it stays put', () => {
			s2_render(<Harness />);
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
			s2_render(<Harness />);
			stubCanvasRect();
			wheel(-10, 100, 50, true);
			const pinchZoom = latest.zoom;
			s2_act(() => latest.fitToView());
			wheel(-10, 100, 50, false);
			expect(pinchZoom).toBeGreaterThan(latest.zoom);
		});
		it('pans on drag, and keeps tracking on window after the cursor leaves', () => {
			s2_render(<Harness />);
			s2_fireEvent.mouseDown(s2_screen.getByTestId('canvas'), {
				button: 0,
				clientX: 10,
				clientY: 10,
			});
			expect(latest.dragging).toBe(true);
			s2_act(() => {
				window.dispatchEvent(new MouseEvent('mousemove', { clientX: 70, clientY: -20 }));
			});
			expect(latest.offset).toEqual({ x: 60, y: -30 });
			s2_act(() => {
				window.dispatchEvent(new MouseEvent('mouseup'));
			});
			expect(latest.dragging).toBe(false);
			s2_act(() => {
				window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 500 }));
			});
			expect(latest.offset).toEqual({ x: 60, y: -30 });
		});
		it('ignores a right-button press', () => {
			s2_render(<Harness />);
			s2_fireEvent.mouseDown(s2_screen.getByTestId('canvas'), { button: 2 });
			expect(latest.dragging).toBe(false);
		});
		it('resets to fitted when the reset key changes', () => {
			const { rerender } = s2_render(<Harness resetKey="a.png" />);
			s2_act(() => latest.zoomIn());
			s2_act(() => latest.panBy(10, 10));
			rerender(<Harness resetKey="b.png" />);
			expect(latest.zoom).toBe(1);
			expect(latest.offset).toEqual({ x: 0, y: 0 });
		});
	});
});
// Source: src/__tests__/renderer/hooks/ui/useChatFileDropZone.test.tsx
describe('', () => {
	const theme = {
		colors: {
			accent: '#7aa2f7',
			bgMain: '#1a1b26',
			bgSidebar: '#16161e',
			border: '#292e42',
			textMain: '#c0caf5',
			textDim: '#565f89',
		},
	} as unknown as Theme;
	function Host({ onDrop }: { onDrop: (e: React.DragEvent<HTMLElement>) => void }) {
		const zone = useChatFileDropZone(theme, onDrop);
		return (
			<div data-testid="zone" className="relative" {...zone.dragHandlers}>
				<span data-testid="dragging">{String(zone.isDragging)}</span>
				{zone.overlay}
			</div>
		);
	}
	/** DataTransfer stub: only `types` and `getData` are read by the zone. */
	function dataTransferOf(...types: string[]) {
		return { types, getData: (t: string) => (types.includes(t) ? '0' : '') };
	}
	describe('useChatFileDropZone', () => {
		it('lights up the overlay for an OS file drag', () => {
			s3_render(<Host onDrop={vi.fn()} />);
			s3_fireEvent.dragEnter(s3_screen.getByTestId('zone'), {
				dataTransfer: dataTransferOf('Files'),
			});
			expect(s3_screen.getByTestId('dragging').textContent).toBe('true');
		});
		it('forwards a staged-image drop to the caller', () => {
			const onDrop = vi.fn();
			s3_render(<Host onDrop={onDrop} />);
			s3_fireEvent.drop(s3_screen.getByTestId('zone'), {
				dataTransfer: dataTransferOf('application/x-maestro-staged-image'),
			});
			expect(onDrop).toHaveBeenCalledTimes(1);
		});
		it('does not light up the overlay for a staged-image drag', () => {
			// The strip lives inside this region, so an ordinary in-strip reorder
			// bubbles its dragenter up here. A full-panel banner on every reorder
			// would be worse than no affordance.
			s3_render(<Host onDrop={vi.fn()} />);
			s3_fireEvent.dragEnter(s3_screen.getByTestId('zone'), {
				dataTransfer: dataTransferOf('application/x-maestro-staged-image'),
			});
			expect(s3_screen.getByTestId('dragging').textContent).toBe('false');
		});
		it('ignores a drag carrying neither payload', () => {
			const onDrop = vi.fn();
			s3_render(<Host onDrop={onDrop} />);
			s3_fireEvent.drop(s3_screen.getByTestId('zone'), {
				dataTransfer: dataTransferOf('text/plain'),
			});
			expect(onDrop).not.toHaveBeenCalled();
			expect(s3_screen.getByTestId('dragging').textContent).toBe('false');
		});
	});
});
// Source: src/__tests__/renderer/hooks/ui/useLayerSwipeDismiss.test.ts
describe('', () => {
	const mockedIsWebDesktop = vi.mocked(isWebDesktop);
	const mockedIsCoarsePointer = vi.mocked(isCoarsePointer);
	function touch(
		type: 'touchstart' | 'touchend' | 'touchcancel',
		target: Element,
		x: number,
		y: number
	) {
		const point = { clientX: x, clientY: y, target } as unknown as Touch;
		const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
		Object.defineProperty(event, 'touches', { value: type === 'touchstart' ? [point] : [] });
		Object.defineProperty(event, 'changedTouches', { value: [point] });
		target.dispatchEvent(event);
	}
	function swipe(target: Element, from: [number, number], to: [number, number]) {
		touch('touchstart', target, from[0], from[1]);
		touch('touchend', target, to[0], to[1]);
	}
	describe('useLayerSwipeDismiss', () => {
		const originalInnerHeight = window.innerHeight;
		let api: {
			hasTopLayer: ReturnType<typeof vi.fn>;
			closeTopLayer: ReturnType<typeof vi.fn>;
		};
		let surface: HTMLDivElement;
		beforeEach(() => {
			Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
			mockedIsWebDesktop.mockReturnValue(true);
			mockedIsCoarsePointer.mockReturnValue(true);
			api = { hasTopLayer: vi.fn(() => true), closeTopLayer: vi.fn() };
			surface = document.createElement('div');
			document.body.appendChild(surface);
		});
		afterEach(() => {
			surface.remove();
			Object.defineProperty(window, 'innerHeight', {
				configurable: true,
				value: originalInnerHeight,
			});
		});
		it('closes the top layer on a quick swipe down that starts in the top band', () => {
			renderHook(() => useLayerSwipeDismiss(api));
			swipe(surface, [200, 100], [210, 300]);
			expect(api.closeTopLayer).toHaveBeenCalledTimes(1);
		});
		it('ignores a swipe that starts below the top band (that is scrolling)', () => {
			renderHook(() => useLayerSwipeDismiss(api));
			swipe(surface, [200, 400], [200, 700]);
			expect(api.closeTopLayer).not.toHaveBeenCalled();
		});
		it('ignores a short drift and a sideways drag', () => {
			renderHook(() => useLayerSwipeDismiss(api));
			swipe(surface, [200, 100], [200, 100 + LAYER_SWIPE_DISMISS.minDistance - 1]);
			swipe(surface, [200, 100], [400, 250]);
			expect(api.closeTopLayer).not.toHaveBeenCalled();
		});
		it('ignores a swipe up', () => {
			renderHook(() => useLayerSwipeDismiss(api));
			swipe(surface, [200, 150], [200, 20]);
			expect(api.closeTopLayer).not.toHaveBeenCalled();
		});
		it('does nothing when no layer is open', () => {
			api.hasTopLayer.mockReturnValue(false);
			renderHook(() => useLayerSwipeDismiss(api));
			swipe(surface, [200, 100], [200, 300]);
			expect(api.closeTopLayer).not.toHaveBeenCalled();
		});
		it('never starts from a form control', () => {
			renderHook(() => useLayerSwipeDismiss(api));
			const input = document.createElement('input');
			surface.appendChild(input);
			swipe(input, [200, 100], [200, 300]);
			expect(api.closeTopLayer).not.toHaveBeenCalled();
		});
		it('never starts inside a surface that opted out', () => {
			renderHook(() => useLayerSwipeDismiss(api));
			const canvasHost = document.createElement('div');
			canvasHost.setAttribute('data-no-swipe-dismiss', '');
			const inner = document.createElement('div');
			canvasHost.appendChild(inner);
			surface.appendChild(canvasHost);
			swipe(inner, [200, 100], [200, 300]);
			expect(api.closeTopLayer).not.toHaveBeenCalled();
		});
		it('never starts inside a list that is already scrolled down', () => {
			renderHook(() => useLayerSwipeDismiss(api));
			const list = document.createElement('div');
			Object.defineProperty(list, 'scrollTop', { configurable: true, value: 120 });
			const row = document.createElement('div');
			list.appendChild(row);
			surface.appendChild(list);
			expect(startsInsideScrolledRegion(row)).toBe(true);
			swipe(row, [200, 100], [200, 300]);
			expect(api.closeTopLayer).not.toHaveBeenCalled();
		});
		it('is inert in the Electron app and with a mouse', () => {
			mockedIsWebDesktop.mockReturnValue(false);
			renderHook(() => useLayerSwipeDismiss(api));
			swipe(surface, [200, 100], [200, 300]);
			expect(api.closeTopLayer).not.toHaveBeenCalled();
			mockedIsWebDesktop.mockReturnValue(true);
			mockedIsCoarsePointer.mockReturnValue(false);
			swipe(surface, [200, 100], [200, 300]);
			expect(api.closeTopLayer).not.toHaveBeenCalled();
		});
		it('stops listening on unmount', () => {
			const { unmount } = renderHook(() => useLayerSwipeDismiss(api));
			unmount();
			swipe(surface, [200, 100], [200, 300]);
			expect(api.closeTopLayer).not.toHaveBeenCalled();
		});
	});
});
