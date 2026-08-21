/**
 * useElementWidth - track an element's rendered width via ResizeObserver.
 *
 * For layout that has to be computed in JS rather than CSS: an inline SVG chart
 * needs a real pixel width for its viewBox, and a responsive breakpoint that
 * switches column counts needs a number to compare. Anything expressible in CSS
 * should stay in CSS.
 *
 * Returns 0 until the first measurement lands, so callers should treat 0 as
 * "not measured yet" and skip rendering width-dependent content on that frame
 * rather than drawing a zero-width chart.
 *
 * ```tsx
 * const ref = useRef<HTMLDivElement>(null);
 * const width = useElementWidth(ref);
 * return <div ref={ref}>{width > 0 && <Sparkline width={width} ... />}</div>;
 * ```
 */

import { useEffect, useState, type RefObject } from 'react';

export function useElementWidth(ref: RefObject<HTMLElement | null>, enabled = true): number {
	const [width, setWidth] = useState(0);

	useEffect(() => {
		const element = ref.current;
		if (!enabled || !element) {
			return;
		}

		const measure = () => setWidth(element.offsetWidth);
		measure();

		// jsdom has no layout engine and no ResizeObserver by default; bail out
		// rather than throwing so component tests can render without a polyfill.
		if (typeof ResizeObserver === 'undefined') {
			return;
		}

		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref, enabled]);

	return width;
}
