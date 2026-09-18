/**
 * LongPressable - a <div> that also opens a right-click-style affordance on a
 * touch long-press.
 *
 * The desktop renderer runs on phones (web-desktop build) where context menus
 * are otherwise right-click-only and thus unreachable. Wrap a row / header in
 * this component and pass `onLongPress` to reach the same menu a right-click
 * opens. Mouse and keyboard behavior is unchanged: `onClick` / `onContextMenu`
 * pass straight through, except the click synthesized immediately after a
 * long-press is swallowed so the menu opens without also firing the element's
 * click action (select row, toggle group, etc.).
 *
 * Built on the shared `useLongPress` hook, so it inherits scroll-awareness (a
 * long-press does not fire while the user is scrolling a list) and a haptic on
 * open.
 */

import React, { useCallback, useRef } from 'react';
import { useLongPress } from '../../hooks/utils/useLongPress';

/**
 * How long after a long-press the synthesized click is still swallowed. iOS
 * Safari does not synthesize a click after a long-press at all, so a flag that
 * waited for "the next click" swallowed the user's NEXT deliberate tap on the
 * row instead. A window bounds the suppression to the click that belongs to
 * the press.
 */
const POST_LONG_PRESS_CLICK_WINDOW_MS = 700;

export interface LongPressableProps extends React.HTMLAttributes<HTMLDivElement> {
	/**
	 * Fired on a touch long-press with the element's bounding rect. Use it to
	 * open the same affordance a right-click would (e.g. a context menu). Pair
	 * with `longPressMouseEvent` to hand the rect to a mouse-oriented handler.
	 */
	onLongPress: (rect: DOMRect) => void;
	/**
	 * Receives the rendered `<div>` so a host that already owns a ref to its
	 * root (a tab chip registering itself with the tab bar) can keep it. The
	 * long-press hook needs the element too, so the two are merged here rather
	 * than forcing the host to choose.
	 */
	innerRef?: (el: HTMLDivElement | null) => void;
}

/**
 * Build a minimal MouseEvent-like object anchored near a rect's left edge so a
 * touch long-press can reuse an existing mouse `onContextMenu` handler (which
 * reads `clientX` / `clientY`). The menu position is clamped to the viewport by
 * `useContextMenuPosition`, so the exact anchor only needs to be close.
 */
export function longPressMouseEvent(rect: DOMRect): React.MouseEvent {
	return {
		preventDefault() {},
		stopPropagation() {},
		clientX: Math.round(rect.left + 16),
		clientY: Math.round(rect.top + rect.height / 2),
	} as unknown as React.MouseEvent;
}

export function LongPressable({
	onLongPress,
	onClick,
	innerRef,
	children,
	...rest
}: LongPressableProps) {
	// A long-press that opens a menu is usually followed by a synthesized click
	// on touch; swallow that one click so the element's own click action does
	// not also fire. Time-bounded (see POST_LONG_PRESS_CLICK_WINDOW_MS): a
	// browser that never sends the click must not cost the user their next tap.
	const suppressClickUntilRef = useRef(0);

	const { elementRef, handlers } = useLongPress({
		onLongPress: (rect) => {
			suppressClickUntilRef.current = Date.now() + POST_LONG_PRESS_CLICK_WINDOW_MS;
			onLongPress(rect);
		},
	});

	const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
		const suppressUntil = suppressClickUntilRef.current;
		suppressClickUntilRef.current = 0;
		if (suppressUntil && Date.now() < suppressUntil) return;
		onClick?.(e);
	};

	const setRef = useCallback(
		(el: HTMLDivElement | null) => {
			(elementRef as React.MutableRefObject<HTMLElement | null>).current = el;
			innerRef?.(el);
		},
		[elementRef, innerRef]
	);

	return (
		<div {...rest} ref={setRef} onClick={handleClick} {...handlers}>
			{children}
		</div>
	);
}
