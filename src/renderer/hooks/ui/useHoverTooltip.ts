import { useState, useRef, useCallback, useEffect, useMemo } from 'react';

/**
 * Custom hook for managing hover tooltips with a delay on close.
 * This pattern is common for tooltips that need to stay open while
 * the user moves their mouse from the trigger to the tooltip content.
 *
 * @param closeDelay - Delay in ms before closing after mouse leave (default: 150).
 *   Also covers the gap between trigger and content, so the pointer can travel
 *   across dead space without the content vanishing.
 * @param openDelay - Delay in ms before opening on mouse enter (default: 0,
 *   i.e. open immediately). Set this for surfaces big enough to be disruptive
 *   if they pop open while the pointer is merely passing through, such as the
 *   header git menu. Leaving the trigger before the delay elapses cancels the
 *   pending open.
 * @returns Object with isOpen state and event handlers for trigger and content
 */
export function useHoverTooltip(closeDelay = 150, openDelay = 0) {
	const [isOpen, setIsOpen] = useState(false);
	// One timer for both directions: entering cancels a pending close, leaving
	// cancels a pending open. Sharing it makes those two states mutually
	// exclusive by construction.
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearPendingTimeout = useCallback(() => {
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}
	}, []);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			clearPendingTimeout();
		};
	}, [clearPendingTimeout]);

	const scheduleOpen = useCallback(() => {
		clearPendingTimeout();
		if (openDelay <= 0) {
			setIsOpen(true);
			return;
		}
		timeoutRef.current = setTimeout(() => {
			timeoutRef.current = null;
			setIsOpen(true);
		}, openDelay);
	}, [clearPendingTimeout, openDelay]);

	const scheduleClose = useCallback(() => {
		clearPendingTimeout();
		timeoutRef.current = setTimeout(() => {
			timeoutRef.current = null;
			setIsOpen(false);
		}, closeDelay);
	}, [clearPendingTimeout, closeDelay]);

	const openNow = useCallback(() => {
		clearPendingTimeout();
		setIsOpen(true);
	}, [clearPendingTimeout]);

	// Handler objects are memoized, not rebuilt per render, so consumers can
	// spread them onto a memo()'d child without defeating its memoization.
	const triggerHandlers = useMemo(
		() => ({ onMouseEnter: scheduleOpen, onMouseLeave: scheduleClose }),
		[scheduleOpen, scheduleClose]
	);

	// Handlers for the tooltip content (including bridge element). Entering the
	// content always opens immediately - the pointer is already there, so any
	// open delay has been earned.
	const contentHandlers = useMemo(
		() => ({ onMouseEnter: openNow, onMouseLeave: scheduleClose }),
		[openNow, scheduleClose]
	);

	// Handler for closing explicitly
	const close = useCallback(() => {
		clearPendingTimeout();
		setIsOpen(false);
	}, [clearPendingTimeout]);

	return {
		isOpen,
		triggerHandlers,
		contentHandlers,
		/**
		 * Open right now, skipping any open delay. For deliberate triggers (a
		 * click or keyboard focus) where intent is already unambiguous.
		 */
		open: openNow,
		close,
	};
}
