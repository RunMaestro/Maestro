/**
 * useOptionalLabelFits - drop a label entirely rather than truncate it.
 *
 * For a single-line header whose label carries no meaning in fragments. A
 * truncated "GROUP CHA..." is worse than no label at all: it costs the same
 * row space, reads as a rendering fault, and tells the user nothing the icon
 * beside it did not already say. This reports whether the label currently fits
 * so the caller can render it or omit it - never clip it.
 *
 * ## Why this is measured rather than a CSS breakpoint
 *
 * The obvious fix is a container query at some pixel width, and that is what
 * the surrounding control ladder does (`@container gcheader` in index.css).
 * It cannot decide this one, for two reasons:
 *
 * 1. **The font size is a user setting.** `document.documentElement.style
 *    .fontSize` is written from the `fontSize` preference, so every rem-based
 *    size in the row - the label, the padding, the icons - scales with it while
 *    the sidebar's width stays in pixels. A px threshold is correct at exactly
 *    one font size, and the row was clipping at the larger ones.
 * 2. **The other content is conditional.** The sort button, the archive
 *    button, and the count badge each appear only sometimes, so the width the
 *    label has to fit into is not a function of the container width alone. No
 *    static threshold can be right for every combination.
 *
 * ## How it decides
 *
 * The label must be laid out so it CANNOT shrink (`shrink-0`, no wrapping) and
 * the row must clip its own overflow. Then `scrollWidth` is the width the row
 * actually wants and `clientWidth` is what it has, so overflow is exactly the
 * "would have truncated" condition.
 *
 * Restoring is the half that needs care. Once the label is gone, the row no
 * longer overflows, so the same comparison would immediately bring it back and
 * oscillate. Instead the required width measured while the label WAS shown is
 * remembered, and the label returns only when the row is at least that wide
 * again. That number is a real measurement rather than an estimate, so the
 * restore cannot flap: at that width the label demonstrably fit.
 *
 * Returns `true` before the first measurement, so a label renders by default
 * and is removed only once something is known to be too tight. In jsdom, where
 * there is no layout engine and both widths read 0, it stays `true`.
 *
 * ```tsx
 * const rowRef = useRef<HTMLDivElement>(null);
 * const labelFits = useOptionalLabelFits(rowRef);
 * return (
 *   <div ref={rowRef} className="flex items-center overflow-hidden">
 *     <Icon className="shrink-0" />
 *     {labelFits && <span className="shrink-0 whitespace-nowrap">Group Chats</span>}
 *   </div>
 * );
 * ```
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

export function useOptionalLabelFits(rowRef: RefObject<HTMLElement | null>): boolean {
	const [fits, setFits] = useState(true);
	/**
	 * Row width required WITH the label, captured on the last frame it was
	 * shown. Null until measured, which is why a label that has never rendered
	 * is never hidden.
	 */
	const requiredWidth = useRef<number | null>(null);

	useEffect(() => {
		const element = rowRef.current;
		if (!element) return;

		const measure = () => {
			if (fits) {
				// scrollWidth is the row's true appetite because the label refuses
				// to shrink. Record it before hiding, since it is the only moment
				// the real requirement is observable.
				requiredWidth.current = element.scrollWidth;
				if (element.scrollWidth > element.clientWidth) setFits(false);
				return;
			}
			// Hidden: the row fits trivially, so compare against the remembered
			// requirement instead of the current overflow.
			if (requiredWidth.current !== null && element.clientWidth >= requiredWidth.current) {
				setFits(true);
			}
		};

		measure();

		// jsdom has no layout engine and no ResizeObserver by default; bail out
		// rather than throwing so component tests can render without a polyfill.
		if (typeof ResizeObserver === 'undefined') return;

		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [rowRef, fits]);

	return fits;
}
