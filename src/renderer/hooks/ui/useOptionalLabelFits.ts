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
 * ## The same decision, vertically
 *
 * `useOptionalContentFits(ref, { axis: 'height' })` asks it of a column: the
 * Settings sidebar shows the Models subtree expanded whenever it fits without
 * scrolling the sidebar, and collapses it (open only under the selected tab)
 * when it would not. The element must be the one that scrolls or clips, so its
 * `scrollHeight` is what it wants and `clientHeight` what it has. Measurement
 * runs in a layout effect, so content shown optimistically and then dropped
 * never paints.
 *
 * `contentKey` is for content the caller changes on purpose (rows added or
 * removed). A change shows the optional content again so the new requirement
 * is measured with it present, rather than judged against a stale number.
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

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface OptionalContentFitsOptions {
	/** Which way the content overflows. Defaults to `width`. */
	axis?: 'width' | 'height';
	/** Changes when the caller changes the container's content; forces a fresh measurement. */
	contentKey?: string | number;
}

export function useOptionalContentFits(
	containerRef: RefObject<HTMLElement | null>,
	{ axis = 'width', contentKey }: OptionalContentFitsOptions = {}
): boolean {
	const [fits, setFits] = useState(true);
	/**
	 * Size required WITH the optional content, captured on the last frame it
	 * was shown. Null until measured, which is why content that has never
	 * rendered is never hidden.
	 */
	const required = useRef<number | null>(null);

	// New content means the remembered requirement no longer describes it:
	// show the optional part again and measure afresh.
	const lastContentKey = useRef(contentKey);
	useLayoutEffect(() => {
		if (lastContentKey.current === contentKey) return;
		lastContentKey.current = contentKey;
		required.current = null;
		setFits(true);
	}, [contentKey]);

	useLayoutEffect(() => {
		const element = containerRef.current;
		if (!element) return;

		const wanted = () => (axis === 'width' ? element.scrollWidth : element.scrollHeight);
		const available = () => (axis === 'width' ? element.clientWidth : element.clientHeight);

		const measure = () => {
			if (fits) {
				// The scroll size is the container's true appetite because the
				// optional content refuses to shrink. Record it before hiding,
				// since it is the only moment the real requirement is observable.
				required.current = wanted();
				if (wanted() > available()) setFits(false);
				return;
			}
			// Hidden: the container fits trivially, so compare against the
			// remembered requirement instead of the current overflow.
			if (required.current !== null && available() >= required.current) {
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
	}, [containerRef, fits, axis, contentKey]);

	return fits;
}

/** Whether an optional label fits its row: {@link useOptionalContentFits} across the width. */
export function useOptionalLabelFits(rowRef: RefObject<HTMLElement | null>): boolean {
	return useOptionalContentFits(rowRef);
}
