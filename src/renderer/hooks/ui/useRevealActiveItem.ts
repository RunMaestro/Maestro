/**
 * useRevealActiveItem - keep the active item of a scrolling strip on screen.
 *
 * A tab strip, segmented bar, or sidebar nav that scrolls instead of wrapping
 * can hold its active item out of sight: a tab picked by keyboard, a tab
 * restored when a modal reopens, or a container the user just made narrower.
 * The selection is real, but nothing on screen shows it.
 *
 * Mark the active item with `data-reveal-active` ({@link revealActiveProps})
 * and attach the returned callback ref to the scrolling container. The item is
 * revealed when `activeKey` changes (instantly on mount, smoothly after) and
 * again whenever the container is resized.
 *
 * It scrolls the CONTAINER only, never its ancestors. `scrollIntoView` walks
 * every scrolling ancestor, so a segmented bar below the fold of a dashboard
 * would drag the whole dashboard down to it on mount.
 *
 * ```tsx
 * const revealRef = useRevealActiveItem<HTMLDivElement>(activeTab);
 * return (
 *   <div ref={revealRef} className="flex overflow-x-auto">
 *     {tabs.map((tab) => (
 *       <button key={tab.id} {...revealActiveProps(tab.id === activeTab)}>{tab.label}</button>
 *     ))}
 *   </div>
 * );
 * ```
 */

import { useCallback, useEffect, useRef } from 'react';

export const REVEAL_ACTIVE_ATTRIBUTE = 'data-reveal-active';

/** Spread onto each item; only the active one carries the marker. */
export function revealActiveProps(isActive: boolean): { [REVEAL_ACTIVE_ATTRIBUTE]?: 'true' } {
	return isActive ? { [REVEAL_ACTIVE_ATTRIBUTE]: 'true' } : {};
}

export type RevealAlign = 'nearest' | 'center';

export interface RevealAxis {
	/** Current scroll offset (`scrollLeft` / `scrollTop`). */
	scroll: number;
	/** Visible size of the container (`clientWidth` / `clientHeight`). */
	viewport: number;
	/** Total scrollable size (`scrollWidth` / `scrollHeight`). */
	content: number;
	/** Container padding on each side, kept clear around a revealed item. */
	padStart: number;
	padEnd: number;
	/** Item position and size, in the container's scroll coordinates. */
	itemStart: number;
	itemSize: number;
}

/**
 * The scroll offset that brings the item into view along one axis. Returns the
 * current offset unchanged when the item is already visible under `nearest`,
 * and never leaves the scrollable range.
 */
export function computeRevealScroll(axis: RevealAxis, align: RevealAlign = 'nearest'): number {
	const { scroll, viewport, content, padStart, padEnd, itemStart, itemSize } = axis;
	const maxScroll = Math.max(0, content - viewport);
	let target = scroll;

	if (align === 'center') {
		target = itemStart + itemSize / 2 - viewport / 2;
	} else {
		const viewStart = scroll + padStart;
		const viewEnd = scroll + viewport - padEnd;
		const itemEnd = itemStart + itemSize;
		// An item larger than the view lines up with its start, which is where
		// its label is.
		if (itemStart < viewStart || itemSize > viewEnd - viewStart) {
			target = itemStart - padStart;
		} else if (itemEnd > viewEnd) {
			target = itemEnd - viewport + padEnd;
		}
	}

	return Math.min(maxScroll, Math.max(0, Math.round(target)));
}

function revealIn(container: HTMLElement, align: RevealAlign, behavior: ScrollBehavior): void {
	const item = container.querySelector<HTMLElement>(`[${REVEAL_ACTIVE_ATTRIBUTE}="true"]`);
	if (!item) return;

	const overflowsX = container.scrollWidth > container.clientWidth;
	const overflowsY = container.scrollHeight > container.clientHeight;
	if (!overflowsX && !overflowsY) return;

	const box = container.getBoundingClientRect();
	const rect = item.getBoundingClientRect();
	const style = getComputedStyle(container);

	const left = overflowsX
		? computeRevealScroll(
				{
					scroll: container.scrollLeft,
					viewport: container.clientWidth,
					content: container.scrollWidth,
					padStart: parseFloat(style.paddingLeft) || 0,
					padEnd: parseFloat(style.paddingRight) || 0,
					itemStart: rect.left - box.left - container.clientLeft + container.scrollLeft,
					itemSize: rect.width,
				},
				align
			)
		: container.scrollLeft;
	const top = overflowsY
		? computeRevealScroll(
				{
					scroll: container.scrollTop,
					viewport: container.clientHeight,
					content: container.scrollHeight,
					padStart: parseFloat(style.paddingTop) || 0,
					padEnd: parseFloat(style.paddingBottom) || 0,
					itemStart: rect.top - box.top - container.clientTop + container.scrollTop,
					itemSize: rect.height,
				},
				align
			)
		: container.scrollTop;

	if (left !== container.scrollLeft || top !== container.scrollTop) {
		container.scrollTo({ left, top, behavior });
	}
}

export function useRevealActiveItem<T extends HTMLElement = HTMLElement>(
	activeKey: unknown,
	{ align = 'nearest' }: { align?: RevealAlign } = {}
): (element: T | null) => void {
	const containerRef = useRef<T | null>(null);
	const observerRef = useRef<ResizeObserver | null>(null);
	const alignRef = useRef(align);
	alignRef.current = align;
	const hasRevealedRef = useRef(false);

	// A callback ref rather than a RefObject: a surface can swap its container
	// (Settings trades its sidebar for a tab strip on a phone), and the observer
	// has to follow the element that is actually mounted.
	const setContainer = useCallback((element: T | null) => {
		observerRef.current?.disconnect();
		observerRef.current = null;
		containerRef.current = element;
		if (!element || typeof ResizeObserver === 'undefined') return;

		// Only a real size change re-reveals. A smooth scroll still in flight
		// would otherwise be cancelled by an instant one on every observer tick.
		let lastWidth = -1;
		let lastHeight = -1;
		const observer = new ResizeObserver(() => {
			const { clientWidth, clientHeight } = element;
			if (clientWidth === lastWidth && clientHeight === lastHeight) return;
			lastWidth = clientWidth;
			lastHeight = clientHeight;
			revealIn(element, alignRef.current, 'auto');
		});
		observer.observe(element);
		observerRef.current = observer;
	}, []);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		// Opening on a far tab should land there, not animate across the strip.
		revealIn(container, align, hasRevealedRef.current ? 'smooth' : 'auto');
		hasRevealedRef.current = true;
	}, [activeKey, align]);

	return setContainer;
}
