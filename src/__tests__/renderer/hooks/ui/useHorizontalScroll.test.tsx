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

/**
 * jsdom lays nothing out, so every rect is zero. Give the strip a viewport and
 * the child a position within the scrolled content, then derive the child's
 * on-screen rect the way a real layout would: content position minus scroll.
 */
function placeChild(
	element: HTMLDivElement,
	child: HTMLElement,
	{ left, width }: { left: number; width: number }
): void {
	element.getBoundingClientRect = () =>
		({ left: 0, right: CLIENT_WIDTH, width: CLIENT_WIDTH }) as DOMRect;
	child.getBoundingClientRect = () =>
		({
			left: left - element.scrollLeft,
			right: left - element.scrollLeft + width,
			width,
		}) as DOMRect;
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

	it('reveals a child past the right edge, clear of the edge overlay', () => {
		const element = makeStrip();
		const child = document.createElement('button');
		placeChild(element, child, { left: 600, width: 220 });
		let state: HorizontalScrollState | undefined;
		render(<Harness element={element} onState={(next) => (state = next)} />);

		state?.scrollIntoView(child, 64);

		// Trailing edge at 820, viewport ends at 500, 64px of that is overlay:
		// scroll the 384px that puts the child clear of it and no further.
		expect(element.scrollLeft).toBe(384);
	});

	it('reveals a child past the left edge, clear of the edge overlay', () => {
		const element = makeStrip({ scrollLeft: 700 });
		const child = document.createElement('button');
		placeChild(element, child, { left: 600, width: 220 });
		let state: HorizontalScrollState | undefined;
		render(<Harness element={element} onState={(next) => (state = next)} />);

		state?.scrollIntoView(child, 64);

		expect(element.scrollLeft).toBe(536);
	});

	it('leaves a child that is already fully visible alone', () => {
		// Arrowing between two tiles that both fit must not nudge the strip - a
		// scroll on every keypress reads as drift the user did not ask for.
		const element = makeStrip({ scrollLeft: 100 });
		const child = document.createElement('button');
		placeChild(element, child, { left: 200, width: 220 });
		let state: HorizontalScrollState | undefined;
		render(<Harness element={element} onState={(next) => (state = next)} />);

		state?.scrollIntoView(child, 64);

		expect(element.scrollTo).not.toHaveBeenCalled();
		expect(element.scrollLeft).toBe(100);
	});

	it('shows the leading edge of a child too wide to fit', () => {
		// Such a child overflows BOTH edges. Revealing the trailing edge would put
		// the start of it off-screen, which is the worse of the two.
		const element = makeStrip({ scrollLeft: 400 });
		const child = document.createElement('button');
		placeChild(element, child, { left: 300, width: 900 });
		let state: HorizontalScrollState | undefined;
		render(<Harness element={element} onState={(next) => (state = next)} />);

		state?.scrollIntoView(child, 0);

		expect(element.scrollLeft).toBe(300);
	});

	it('clamps a reveal to the scrollable range and ignores a missing child', () => {
		const element = makeStrip({ scrollLeft: MAX_SCROLL_LEFT - 10 });
		const child = document.createElement('button');
		placeChild(element, child, { left: SCROLL_WIDTH - 100, width: 220 });
		let state: HorizontalScrollState | undefined;
		render(<Harness element={element} onState={(next) => (state = next)} />);

		state?.scrollIntoView(child, 64);
		expect(element.scrollLeft).toBe(MAX_SCROLL_LEFT);

		state?.scrollIntoView(null, 64);
		state?.scrollIntoView(undefined, 64);
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
