import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * Custom hook for managing hover tooltips with a delay on close.
 * This pattern is common for tooltips that need to stay open while
 * the user moves their mouse from the trigger to the tooltip content.
 *
 * @param closeDelay - Delay in ms before closing the tooltip after mouse leave (default: 150)
 * @returns Object with isOpen state and event handlers for trigger and content
 */
export function useHoverTooltip(closeDelay = 150) {
	const [isOpen, setIsOpen] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Clear timeout helper
	const clearCloseTimeout = useCallback(() => {
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}
	}, []);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			clearCloseTimeout();
		};
	}, [clearCloseTimeout]);

	// Handlers for the trigger element
	const triggerHandlers = {
		onMouseEnter: useCallback(() => {
			clearCloseTimeout();
			setIsOpen(true);
		}, [clearCloseTimeout]),
		onMouseLeave: useCallback(() => {
			timeoutRef.current = setTimeout(() => {
				setIsOpen(false);
			}, closeDelay);
		}, [closeDelay]),
	};

	// Handlers for the tooltip content (including bridge element)
	const contentHandlers = {
		onMouseEnter: useCallback(() => {
			clearCloseTimeout();
			setIsOpen(true);
		}, [clearCloseTimeout]),
		onMouseLeave: useCallback(() => {
			timeoutRef.current = setTimeout(() => {
				setIsOpen(false);
			}, closeDelay);
		}, [closeDelay]),
	};

	// Handler for closing explicitly
	const close = useCallback(() => {
		clearCloseTimeout();
		setIsOpen(false);
	}, [clearCloseTimeout]);

	return {
		isOpen,
		triggerHandlers,
		contentHandlers,
		close,
	};
}
