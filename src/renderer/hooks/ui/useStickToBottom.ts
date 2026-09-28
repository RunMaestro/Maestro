/**
 * useStickToBottom - keep a scrolling box pinned to its newest content.
 *
 * For a box whose content GROWS while the user watches it (streaming command
 * output, a live log tail). It follows the tail as long as the user is at the
 * bottom, and stops the moment they scroll up to read something - then resumes
 * on its own when they scroll back down.
 *
 * That "stops the moment they scroll up" half is the whole point. A box that
 * unconditionally jumps to the bottom on every chunk makes reading earlier
 * output impossible: the user scrolls up, the next chunk yanks them back, and
 * the box feels like it is fighting them.
 *
 * ## Why pinning is derived, not remembered
 *
 * Whether we are pinned is recomputed from the element's own geometry on every
 * scroll event, rather than tracked as "did the user or did we cause this". A
 * remembered flag needs to tell a programmatic scroll from a user scroll, which
 * means a guard flag, which means a race whenever a scroll event does not
 * arrive (scrolling to where you already are fires nothing). Geometry has no
 * such ambiguity: after we scroll to the bottom we ARE at the bottom, so the
 * event our own scroll produces recomputes to exactly the state we set.
 *
 * ## Usage
 *
 * ```tsx
 * const stickRef = useStickToBottom(text);
 * return <div ref={stickRef} className="overflow-auto">{text}</div>;
 * ```
 *
 * Pass whatever value changes when the content changes as `contentKey`. It is
 * the signal to re-pin, so it must change on every append.
 *
 * Distinct from `useScrollIntoView`, which brings ONE element into view inside
 * a list (keyboard navigation of a dropdown), and from the transcript's own
 * MutationObserver auto-scroll in `TerminalOutput`, which owns the whole
 * conversation pane. This hook is for a single self-contained scrolling box.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useEventListener } from '../utils/useEventListener';

/**
 * How close to the bottom still counts as "at the bottom", in pixels.
 *
 * Matches the transcript's own threshold in `TerminalOutput`, so a user who is
 * a few pixels off the bottom gets the same follow-the-output behavior in the
 * card as they do in the conversation around it. Sub-pixel layout rounding also
 * means an exact equality test would drop the pin at rest on some zoom levels.
 */
const BOTTOM_THRESHOLD_PX = 50;

/**
 * @param contentKey - changes whenever the content grows; triggers a re-pin
 * @param enabled    - set false to leave scrolling entirely to the user
 * @returns a callback ref to put on the scrolling element
 */
export function useStickToBottom<T extends HTMLElement>(
	contentKey: unknown,
	enabled: boolean = true
): (node: T | null) => void {
	// State, not a ref: `useEventListener` needs to re-subscribe when the
	// element arrives, and a ref assignment does not re-render. The element is
	// null until the box mounts, which the hook below already treats as "skip".
	const [element, setElement] = useState<T | null>(null);

	// A ref so the scroll handler can update it without re-rendering the card on
	// every scroll event - this says nothing the UI renders.
	const pinnedRef = useRef(true);

	const measurePinned = useCallback((node: T): boolean => {
		return node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_THRESHOLD_PX;
	}, []);

	useEventListener(
		'scroll',
		() => {
			if (element) pinnedRef.current = measurePinned(element);
		},
		{ target: element, enabled }
	);

	// Layout effect, not a passive one: the scroll has to land in the same frame
	// the new content does, or the box paints once at the old position and the
	// output visibly jumps afterwards.
	useLayoutEffect(() => {
		if (!enabled || !element || !pinnedRef.current) return;
		element.scrollTop = element.scrollHeight;
	}, [element, contentKey, enabled]);

	return setElement;
}
