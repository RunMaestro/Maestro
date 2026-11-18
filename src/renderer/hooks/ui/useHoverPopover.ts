import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useHoverTooltip } from './useHoverTooltip';

/**
 * How long a mouse must rest on the trigger before the menu opens. Long enough
 * that crossing the tab bar on the way somewhere else does not pop a menu open,
 * short enough to feel immediate when aimed at. Matches the header git menu.
 */
export const HOVER_POPOVER_OPEN_DELAY_MS = 150;

/**
 * Grace period after the pointer leaves the trigger or the menu. Covers the gap
 * between them so the menu survives the trip across it.
 */
export const HOVER_POPOVER_CLOSE_DELAY_MS = 250;

export interface UseHoverPopoverOptions {
	/** The button that opens the popover. Focus returns here on dismiss. */
	triggerRef: RefObject<HTMLElement | null>;
	/** The popover itself. Focused when the popover is pinned open. */
	contentRef: RefObject<HTMLElement | null>;
	/**
	 * Whether resting a mouse on the trigger opens the popover. Pass false when
	 * the trigger has no menu to show (its click acts directly). Touch input
	 * never opens on hover regardless: a tap is a click there.
	 */
	hoverEnabled?: boolean;
	openDelay?: number;
	closeDelay?: number;
}

/**
 * A trigger-plus-popover menu that opens on mouse hover and on click.
 *
 * Two ways open, kept apart on purpose:
 * - **Hover** (mouse or pen only) opens a PEEK. It never takes keyboard focus,
 *   so resting the pointer on the button while typing in the composer cannot
 *   steal the keystrokes, and it closes when the pointer leaves.
 * - **Click** (any pointer, and keyboard activation) PINS it open. A pinned
 *   popover takes focus so arrow keys and Escape work, survives the pointer
 *   leaving, and returns focus to the trigger when dismissed. Clicking a
 *   trigger whose popover is only peeking pins it instead of closing it, so
 *   "hover, then click" never flickers the menu shut.
 *
 * Touch is filtered by `pointerType`, not by viewport or `(pointer: coarse)`, so
 * a tablet tap still needs a press while a trackpad on the same tablet peeks.
 */
export function useHoverPopover({
	triggerRef,
	contentRef,
	hoverEnabled = true,
	openDelay = HOVER_POPOVER_OPEN_DELAY_MS,
	closeDelay = HOVER_POPOVER_CLOSE_DELAY_MS,
}: UseHoverPopoverOptions) {
	const hover = useHoverTooltip(closeDelay, openDelay);
	const [pinned, setPinned] = useState(false);
	const isOpen = pinned || (hoverEnabled && hover.isOpen);

	const closeHover = hover.close;
	const close = useCallback(() => {
		setPinned(false);
		closeHover();
	}, [closeHover]);

	// Set when a menu item is chosen: the item opens something that owns focus
	// (a modal, a new tab), so handing focus back to the trigger would leave the
	// user typing nowhere. Only meaningful while pinned - a peek never moved focus.
	const actionTakenRef = useRef(false);
	const closeForAction = useCallback(() => {
		if (pinned) actionTakenRef.current = true;
		close();
	}, [pinned, close]);

	const toggle = useCallback(() => {
		if (pinned) close();
		else setPinned(true);
	}, [pinned, close]);

	// Tracks whether the popover was ever pinned, so the restore branch below
	// cannot fire on mount and yank focus out of whatever the user was typing in.
	const wasPinnedRef = useRef(false);
	useEffect(() => {
		if (pinned) {
			wasPinnedRef.current = true;
			// Wait one frame for the portal to mount.
			const frame = requestAnimationFrame(() => contentRef.current?.focus());
			return () => cancelAnimationFrame(frame);
		}
		if (!wasPinnedRef.current) return;
		wasPinnedRef.current = false;
		if (actionTakenRef.current) {
			actionTakenRef.current = false;
			return;
		}
		triggerRef.current?.focus();
	}, [pinned, contentRef, triggerRef]);

	// Close on a press anywhere outside the trigger and the popover.
	useEffect(() => {
		if (!isOpen) return;
		const handler = (e: MouseEvent) => {
			const target = e.target as Node;
			if (triggerRef.current?.contains(target)) return;
			if (contentRef.current?.contains(target)) return;
			close();
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [isOpen, close, triggerRef, contentRef]);

	const { onMouseEnter: scheduleOpen, onMouseLeave: scheduleClose } = hover.triggerHandlers;
	const { onMouseEnter: keepOpen } = hover.contentHandlers;

	// Handler objects are memoized so they can be spread onto memo()'d children.
	const triggerHandlers = useMemo(
		() => ({
			onPointerEnter: (e: ReactPointerEvent) => {
				if (hoverEnabled && e.pointerType !== 'touch') scheduleOpen();
			},
			onPointerLeave: (e: ReactPointerEvent) => {
				if (e.pointerType !== 'touch') scheduleClose();
			},
		}),
		[hoverEnabled, scheduleOpen, scheduleClose]
	);

	const contentHandlers = useMemo(
		() => ({
			onPointerEnter: (e: ReactPointerEvent) => {
				if (e.pointerType !== 'touch') keepOpen();
			},
			onPointerLeave: (e: ReactPointerEvent) => {
				if (e.pointerType !== 'touch') scheduleClose();
			},
		}),
		[keepOpen, scheduleClose]
	);

	return {
		/** Whether the popover should render (pinned or peeking). */
		isOpen,
		/** Whether the popover was opened deliberately and owns focus. */
		pinned,
		/** Click / keyboard activation on the trigger. */
		toggle,
		/** Dismiss (Escape, outside press). Restores focus if it was pinned. */
		close,
		/** Dismiss because a menu item ran. Leaves focus where the action put it. */
		closeForAction,
		triggerHandlers,
		contentHandlers,
	};
}
