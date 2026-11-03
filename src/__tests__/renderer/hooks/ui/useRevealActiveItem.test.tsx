import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	computeRevealScroll,
	revealActiveProps,
	useRevealActiveItem,
	type RevealAlign,
} from '../../../../renderer/hooks/ui/useRevealActiveItem';

const ITEM_WIDTH = 100;
const ITEM_COUNT = 6;

describe('computeRevealScroll', () => {
	const axis = {
		scroll: 0,
		viewport: 200,
		content: 600,
		padStart: 0,
		padEnd: 0,
		itemSize: 100,
	};

	it('leaves the scroll alone when the item is already visible', () => {
		expect(computeRevealScroll({ ...axis, itemStart: 100 })).toBe(0);
	});

	it('scrolls forward just far enough to show an item past the end', () => {
		expect(computeRevealScroll({ ...axis, itemStart: 400 })).toBe(300);
	});

	it('scrolls back to an item before the start', () => {
		expect(computeRevealScroll({ ...axis, scroll: 300, itemStart: 100 })).toBe(100);
	});

	it('keeps the container padding clear on both sides', () => {
		const padded = { ...axis, padStart: 24, padEnd: 24 };
		expect(computeRevealScroll({ ...padded, itemStart: 400 })).toBe(324);
		expect(computeRevealScroll({ ...padded, scroll: 300, itemStart: 100 })).toBe(76);
	});

	it('lines an item wider than the view up with its start', () => {
		expect(computeRevealScroll({ ...axis, scroll: 50, itemStart: 100, itemSize: 300 })).toBe(100);
	});

	it('centers the item when asked', () => {
		expect(computeRevealScroll({ ...axis, itemStart: 300 }, 'center')).toBe(250);
	});

	it('never leaves the scrollable range', () => {
		expect(computeRevealScroll({ ...axis, itemStart: 0 }, 'center')).toBe(0);
		expect(computeRevealScroll({ ...axis, itemStart: 500 }, 'center')).toBe(400);
	});
});

// jsdom has no layout engine, so the strip's geometry is described with data
// attributes and read back through stubbed prototype getters.
function Strip({
	active,
	clientWidth = 200,
	align,
}: {
	active: number;
	clientWidth?: number;
	align?: RevealAlign;
}) {
	const revealRef = useRevealActiveItem<HTMLDivElement>(active, { align });
	return (
		<div ref={revealRef} data-testid="strip" data-client-width={clientWidth}>
			{Array.from({ length: ITEM_COUNT }, (_, i) => (
				<button key={i} data-index={i} {...revealActiveProps(i === active)}>
					{i}
				</button>
			))}
		</div>
	);
}

describe('useRevealActiveItem', () => {
	let scrollTo: ReturnType<typeof vi.fn>;
	let resizeCallbacks: Array<() => void>;
	const originalResizeObserver = globalThis.ResizeObserver;

	beforeEach(() => {
		const scrollLeft = new WeakMap<Element, number>();
		scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
			scrollLeft.set(this, options.left ?? 0);
		});
		Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
			configurable: true,
			value: scrollTo,
		});
		Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
			configurable: true,
			get(this: HTMLElement) {
				return scrollLeft.get(this) ?? 0;
			},
		});
		Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
			configurable: true,
			get(this: HTMLElement) {
				return Number(this.dataset.clientWidth ?? 0);
			},
		});
		Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
			configurable: true,
			get(this: HTMLElement) {
				return this.dataset.clientWidth ? ITEM_WIDTH * ITEM_COUNT : 0;
			},
		});
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: HTMLElement
		) {
			const strip = this.closest<HTMLElement>('[data-testid="strip"]');
			const offset = strip ? (scrollLeft.get(strip) ?? 0) : 0;
			const left = this.dataset.index ? Number(this.dataset.index) * ITEM_WIDTH - offset : 0;
			const width = this.dataset.index ? ITEM_WIDTH : Number(this.dataset.clientWidth ?? 0);
			return { left, width, top: 0, height: 20, right: left + width, bottom: 20 } as DOMRect;
		});

		resizeCallbacks = [];
		globalThis.ResizeObserver = class {
			private callback: () => void;
			constructor(callback: () => void) {
				this.callback = callback;
			}
			observe() {
				resizeCallbacks.push(this.callback);
			}
			disconnect() {
				resizeCallbacks = resizeCallbacks.filter((cb) => cb !== this.callback);
			}
			unobserve() {}
		} as unknown as typeof ResizeObserver;
	});

	afterEach(() => {
		for (const prop of ['scrollTo', 'scrollLeft', 'clientWidth', 'scrollWidth']) {
			delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
		}
		vi.restoreAllMocks();
		globalThis.ResizeObserver = originalResizeObserver;
	});

	it('lands on the active item instantly on mount', () => {
		render(<Strip active={4} />);
		expect(scrollTo).toHaveBeenCalledWith({ left: 300, top: 0, behavior: 'auto' });
	});

	it('scrolls smoothly when the selection changes after mount', () => {
		const { rerender } = render(<Strip active={4} />);
		scrollTo.mockClear();

		rerender(<Strip active={0} />);
		expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 0, behavior: 'smooth' });
	});

	it('does nothing when the active item is already visible', () => {
		render(<Strip active={1} />);
		expect(scrollTo).not.toHaveBeenCalled();
	});

	it('does nothing when the strip does not overflow', () => {
		render(<Strip active={5} clientWidth={ITEM_WIDTH * ITEM_COUNT} />);
		expect(scrollTo).not.toHaveBeenCalled();
	});

	it('re-reveals the active item when the strip is resized', () => {
		const { getByTestId, rerender } = render(<Strip active={2} clientWidth={600} />);
		expect(scrollTo).not.toHaveBeenCalled();

		rerender(<Strip active={2} clientWidth={200} />);
		expect(getByTestId('strip').dataset.clientWidth).toBe('200');
		resizeCallbacks.forEach((cb) => cb());

		expect(scrollTo).toHaveBeenCalledWith({ left: 100, top: 0, behavior: 'auto' });
	});

	it('ignores observer ticks that carry no size change', () => {
		render(<Strip active={4} />);
		resizeCallbacks.forEach((cb) => cb());
		scrollTo.mockClear();

		resizeCallbacks.forEach((cb) => cb());
		expect(scrollTo).not.toHaveBeenCalled();
	});

	it('centers the active item when asked', () => {
		render(<Strip active={3} align="center" />);
		expect(scrollTo).toHaveBeenCalledWith({ left: 250, top: 0, behavior: 'auto' });
	});
});
