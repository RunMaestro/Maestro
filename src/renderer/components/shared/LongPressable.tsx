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

import React, { useRef } from 'react';
import { useLongPress } from '../../hooks/utils/useLongPress';

export interface LongPressableProps extends React.HTMLAttributes<HTMLDivElement> {
	/**
	 * Fired on a touch long-press with the element's bounding rect. Use it to
	 * open the same affordance a right-click would (e.g. a context menu). Pair
	 * with `longPressMouseEvent` to hand the rect to a mouse-oriented handler.
	 */
	onLongPress: (rect: DOMRect) => void;
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

export function LongPressable({ onLongPress, onClick, children, ...rest }: LongPressableProps) {
	// A long-press that opens a menu is usually followed by a synthesized click
	// on touch; swallow that one click so the element's own click action does
	// not also fire.
	const suppressNextClickRef = useRef(false);

	const { elementRef, handlers } = useLongPress({
		onLongPress: (rect) => {
			suppressNextClickRef.current = true;
			onLongPress(rect);
		},
	});

	const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
		if (suppressNextClickRef.current) {
			suppressNextClickRef.current = false;
			return;
		}
		onClick?.(e);
	};

	return (
		<div
			{...rest}
			ref={elementRef as React.RefObject<HTMLDivElement>}
			onClick={handleClick}
			{...handlers}
		>
			{children}
		</div>
	);
}
