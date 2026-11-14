/**
 * useBarChartFocus - hover AND keyboard access for a Usage Dashboard bar chart.
 *
 * A chart is ONE tab stop (the dashboard's keyboard model): the container takes
 * focus, Left/Right step through the bars, Home/End jump to the ends, Escape
 * clears. The highlighted bar drives the same tooltip the mouse does, anchored
 * above that bar's slot. Hover keeps working as before: pointer handlers per
 * bar set the same `activeIndex` and anchor the tooltip to the cursor.
 *
 * Bars are assumed to share the container's width equally (flex-1 bars, or an
 * SVG slot grid). A chart with padding passes `slotCenter` to say where a
 * bar's slot sits inside the container's bounding rect.
 */

import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

export interface BarAnchor {
	x: number;
	y: number;
}

export interface UseBarChartFocusOptions {
	/**
	 * Viewport point to anchor the tooltip for a keyboard-highlighted bar.
	 * Defaults to the top center of the bar's equal-width slot.
	 */
	slotCenter?: (index: number, rect: DOMRect, count: number) => BarAnchor;
}

export interface UseBarChartFocusResult {
	/** The highlighted bar, or null. */
	activeIndex: number | null;
	/** Where its tooltip goes (viewport coordinates), or null. */
	anchor: BarAnchor | null;
	/** Spread onto the chart's container: the single tab stop. */
	containerProps: {
		ref: (el: Element | null) => void;
		tabIndex: 0;
		onKeyDown: (event: KeyboardEvent<Element>) => void;
		onBlur: () => void;
		'aria-roledescription': string;
	};
	/** Spread onto one bar for hover. */
	barProps: (index: number) => {
		onMouseEnter: (event: MouseEvent<Element>) => void;
		onMouseMove: (event: MouseEvent<Element>) => void;
		onMouseLeave: () => void;
	};
	clear: () => void;
}

function defaultSlotCenter(index: number, rect: DOMRect, count: number): BarAnchor {
	return { x: rect.left + (rect.width * (index + 0.5)) / Math.max(count, 1), y: rect.top };
}

export function useBarChartFocus(
	count: number,
	options: UseBarChartFocusOptions = {}
): UseBarChartFocusResult {
	const [activeIndex, setActiveIndex] = useState<number | null>(null);
	const [anchor, setAnchor] = useState<BarAnchor | null>(null);
	const containerRef = useRef<Element | null>(null);
	const slotCenterRef = useRef(options.slotCenter);
	slotCenterRef.current = options.slotCenter;

	const clear = useCallback(() => {
		setActiveIndex(null);
		setAnchor(null);
	}, []);

	const highlight = useCallback(
		(index: number) => {
			setActiveIndex(index);
			const el = containerRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			setAnchor((slotCenterRef.current ?? defaultSlotCenter)(index, rect, count));
		},
		[count]
	);

	const onKeyDown = useCallback(
		(event: KeyboardEvent<Element>) => {
			if (count === 0) return;
			const current = activeIndex;
			let next: number | null = null;
			switch (event.key) {
				case 'ArrowRight':
					next = current === null ? 0 : Math.min(count - 1, current + 1);
					break;
				case 'ArrowLeft':
					next = current === null ? count - 1 : Math.max(0, current - 1);
					break;
				case 'Home':
					next = 0;
					break;
				case 'End':
					next = count - 1;
					break;
				case 'Escape':
					if (current !== null) {
						event.preventDefault();
						event.stopPropagation();
						clear();
					}
					return;
				default:
					return;
			}
			event.preventDefault();
			event.stopPropagation();
			highlight(next);
		},
		[activeIndex, clear, count, highlight]
	);

	const ref = useCallback((el: Element | null) => {
		containerRef.current = el;
	}, []);

	const barProps = useCallback(
		(index: number) => ({
			onMouseEnter: (event: MouseEvent<Element>) => {
				setActiveIndex(index);
				setAnchor({ x: event.clientX, y: event.clientY });
			},
			onMouseMove: (event: MouseEvent<Element>) => {
				setAnchor({ x: event.clientX, y: event.clientY });
			},
			onMouseLeave: clear,
		}),
		[clear]
	);

	return {
		activeIndex,
		anchor,
		containerProps: {
			ref,
			tabIndex: 0,
			onKeyDown,
			onBlur: clear,
			'aria-roledescription': 'chart, use left and right arrows to read each bar',
		},
		barProps,
		clear,
	};
}
