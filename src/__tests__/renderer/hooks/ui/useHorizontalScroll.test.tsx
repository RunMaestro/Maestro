import { render } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
	useHorizontalScroll,
	type HorizontalScrollState,
} from '../../../../renderer/hooks/ui/useHorizontalScroll';

const CLIENT_WIDTH = 500;
const SCROLL_WIDTH = 2000;
const MAX_SCROLL_LEFT = SCROLL_WIDTH - CLIENT_WIDTH;

/**
 * jsdom has no layout engine: `scrollWidth`/`clientWidth` read 0, its
 * `scrollLeft` setter is inert on an attached element, and the shared test setup
 * stubs `Element.prototype.scrollTo` with a no-op. Back all of them with plain
 * fields so the assertions describe the hook's arithmetic rather than jsdom's
 * scroll model.
 */
function makeStrip(options?: { scrollLeft?: number; scrollWidth?: number }): HTMLDivElement & {
	scrollTo: ReturnType<typeof vi.fn>;
} {
	const element = document.createElement('div');
	let scrollLeft = options?.scrollLeft ?? 0;

	Object.defineProperty(element, 'clientWidth', { value: CLIENT_WIDTH, configurable: true });
	Object.defineProperty(element, 'scrollWidth', {
		value: options?.scrollWidth ?? SCROLL_WIDTH,
		configurable: true,
	});
	Object.defineProperty(element, 'scrollLeft', {
		configurable: true,
		get: () => scrollLeft,
		set: (next: number) => {
			scrollLeft = next;
		},
	});

	const scrollTo = vi.fn((scrollOptions: ScrollToOptions) => {
		if (typeof scrollOptions.left === 'number') scrollLeft = scrollOptions.left;
	});
	Object.defineProperty(element, 'scrollTo', { value: scrollTo, configurable: true });

	document.body.appendChild(element);
	return element as HTMLDivElement & { scrollTo: typeof scrollTo };
}

function Harness({
	element,
	onState,
}: {
	element: HTMLDivElement;
	onState?: (state: HorizontalScrollState) => void;
}): JSX.Element {
	const ref = useRef<HTMLElement | null>(element);
	const state = useHorizontalScroll(ref);
	onState?.(state);
	return <div data-testid="host" />;
}

function dispatchWheel(
	element: HTMLDivElement,
	init: { deltaX?: number; deltaY?: number; deltaMode?: number }
): WheelEvent {
	const event = new WheelEvent('wheel', {
		deltaX: init.deltaX ?? 0,
		deltaY: init.deltaY ?? 0,
		deltaMode: init.deltaMode ?? 0,
		bubbles: true,
		cancelable: true,
	});
	element.dispatchEvent(event);
	return event;
}

describe('useHorizontalScroll', () => {
	it('maps a vertical wheel gesture onto the horizontal axis', () => {
		const element = makeStrip();
		render(<Harness element={element} />);

		const event = dispatchWheel(element, { deltaY: 120 });

		expect(element.scrollLeft).toBe(120);
		expect(event.defaultPrevented).toBe(true);
	});

	it('scrolls instantly, never deferring to a smooth scroll-behavior', () => {
		// The regression this guards: a per-tick write that defers to a
		// `scroll-behavior: smooth` element restarts an eased animation on every
		// wheel event, so the strip trails the gesture instead of tracking it.
		const element = makeStrip();
		render(<Harness element={element} />);

		dispatchWheel(element, { deltaY: 120 });

		expect(element.scrollTo).toHaveBeenCalledWith({ left: 120, behavior: 'instant' });
	});

	it('leaves a horizontal gesture to the browser so the platform keeps its momentum', () => {
		const element = makeStrip();
		render(<Harness element={element} />);

		const event = dispatchWheel(element, { deltaX: 120, deltaY: 10 });

		// Untouched: the native scroll moves it, this handler must not.
		expect(element.scrollLeft).toBe(0);
		expect(event.defaultPrevented).toBe(false);
	});

	it('scales a line-mode delta into pixels instead of crawling one notch', () => {
		const element = makeStrip();
		render(<Harness element={element} />);

		dispatchWheel(element, { deltaY: 3, deltaMode: 1 });

		expect(element.scrollLeft).toBe(48);
	});

	it('scales a page-mode delta by the visible width', () => {
		const element = makeStrip();
		render(<Harness element={element} />);

		dispatchWheel(element, { deltaY: 1, deltaMode: 2 });

		expect(element.scrollLeft).toBe(CLIENT_WIDTH);
	});

	it('clamps at the far edge rather than overshooting', () => {
		const element = makeStrip({ scrollLeft: MAX_SCROLL_LEFT - 20 });
		render(<Harness element={element} />);

		dispatchWheel(element, { deltaY: 500 });

		expect(element.scrollLeft).toBe(MAX_SCROLL_LEFT);
	});

	it('releases the gesture at an end stop so the surrounding page can scroll', () => {
		const element = makeStrip({ scrollLeft: MAX_SCROLL_LEFT });
		render(<Harness element={element} />);

		const event = dispatchWheel(element, { deltaY: 120 });

		expect(element.scrollLeft).toBe(MAX_SCROLL_LEFT);
		expect(event.defaultPrevented).toBe(false);
	});

	it('ignores a strip with nothing to scroll', () => {
		const element = makeStrip({ scrollWidth: CLIENT_WIDTH });
		render(<Harness element={element} />);

		const event = dispatchWheel(element, { deltaY: 120 });

		expect(element.scrollLeft).toBe(0);
		expect(event.defaultPrevented).toBe(false);
	});

	it('eases scrollByPage, so the arrow buttons stay smooth without the strip opting in', () => {
		// The arrow buttons are the ONE caller that wants an animation. Asking for
		// it here is what lets the strip drop `scroll-smooth`, which would otherwise
		// also ease the per-tick wheel writes and the browser's scroll-into-view.
		const element = makeStrip();
		let state: HorizontalScrollState | undefined;
		render(<Harness element={element} onState={(next) => (state = next)} />);

		state?.scrollByPage('right');

		expect(element.scrollTo).toHaveBeenCalledWith({
			left: CLIENT_WIDTH * 0.8,
			behavior: 'smooth',
		});
	});

	it('never asks scrollByPage for an offset outside the scrollable range', () => {
		const element = makeStrip({ scrollLeft: 20 });
		let state: HorizontalScrollState | undefined;
		render(<Harness element={element} onState={(next) => (state = next)} />);

		state?.scrollByPage('left');
		expect(element.scrollLeft).toBe(0);

		state?.scrollByPage('right');
		state?.scrollByPage('right');
		state?.scrollByPage('right');
		state?.scrollByPage('right');
		state?.scrollByPage('right');
		expect(element.scrollLeft).toBe(MAX_SCROLL_LEFT);
	});

	it('coalesces a burst of scroll events into one measurement per frame', () => {
		// `measure` reads `scrollWidth`/`clientWidth`, so measuring per event forces
		// a synchronous layout for every event in a flick - work nobody ever sees.
		const element = makeStrip();
		render(<Harness element={element} />);

		const requestFrame = vi.spyOn(globalThis, 'requestAnimationFrame');
		for (let i = 0; i < 10; i++) {
			element.dispatchEvent(new Event('scroll'));
		}

		expect(requestFrame).toHaveBeenCalledTimes(1);
		requestFrame.mockRestore();
	});
});
