import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDragAutoScroll } from '../../../../renderer/hooks/ui/useDragAutoScroll';

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
	act(() => {
		pending.forEach((cb) => cb(now));
	});
}

function dragOver(el: HTMLElement, clientX: number, clientY: number) {
	act(() => {
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
		const { getByTestId } = render(<Harness active />);
		const strip = getByTestId('strip');
		strip.scrollLeft = 0;

		// First frame only establishes the clock baseline.
		runFrame(0);
		dragOver(strip, 495, 20);
		runFrame(100);

		expect(strip.scrollLeft).toBeGreaterThan(0);
	});

	it('scrolls toward the start when the drag hovers the leading edge', () => {
		const { getByTestId } = render(<Harness active />);
		const strip = getByTestId('strip');
		strip.scrollLeft = 200;

		runFrame(0);
		dragOver(strip, 105, 20);
		runFrame(100);

		expect(strip.scrollLeft).toBeLessThan(200);
	});

	it('leaves the middle of the strip alone', () => {
		const { getByTestId } = render(<Harness active />);
		const strip = getByTestId('strip');
		strip.scrollLeft = 200;

		runFrame(0);
		dragOver(strip, 300, 20);
		runFrame(100);

		expect(strip.scrollLeft).toBe(200);
	});

	it('ramps speed with how deep into the band the pointer sits', () => {
		const { getByTestId, unmount } = render(<Harness active />);
		const shallow = getByTestId('strip');
		shallow.scrollLeft = 0;
		runFrame(0);
		dragOver(shallow, 445, 20);
		runFrame(100);
		const shallowDelta = shallow.scrollLeft;
		unmount();

		const second = render(<Harness active />);
		const deep = second.getByTestId('strip');
		deep.scrollLeft = 0;
		runFrame(0);
		dragOver(deep, 499, 20);
		runFrame(100);

		expect(deep.scrollLeft).toBeGreaterThan(shallowDelta);
	});

	it('treats the sticky insets as the real edges', () => {
		const { getByTestId } = render(<Harness active startInset={80} endInset={48} />);
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
		const { getByTestId } = render(<Harness active />);
		const strip = getByTestId('strip');
		strip.scrollLeft = 200;

		runFrame(0);
		dragOver(strip, 495, 300);
		runFrame(100);

		expect(strip.scrollLeft).toBe(200);
	});

	it('stops when the platform stops reporting the pointer', () => {
		const { getByTestId } = render(<Harness active />);
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
		const { getByTestId } = render(<Harness active={false} />);
		const strip = getByTestId('strip');
		strip.scrollLeft = 200;

		dragOver(strip, 495, 20);
		runFrame(100);

		expect(strip.scrollLeft).toBe(200);
	});

	it('scrolls vertically when the axis is vertical', () => {
		const { getByTestId } = render(<Harness active axis="vertical" edgeSize={10} />);
		const strip = getByTestId('strip');
		strip.scrollTop = 0;

		runFrame(0);
		// The rect is 40px tall, so the band is capped at half of it.
		dragOver(strip, 300, 39);
		runFrame(100);

		expect(strip.scrollTop).toBeGreaterThan(0);
	});
});
