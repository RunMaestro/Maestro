/**
 * useLongPressMenu - Long-press menu hook for mobile touch interactions
 *
 * Provides long-press gesture detection to show a quick actions menu.
 * Used for send button long-press to open mode switching menu.
 *
 * Features:
 * - Configurable long-press duration (default 500ms)
 * - Touch event handlers (start, end, move)
 * - Automatic timer cleanup on touch move/end
 * - Menu anchor position calculation
 * - Haptic feedback integration
 * - Proper cleanup on unmount
 *
 * @module useLongPressMenu
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import type { QuickAction } from '../mobile/QuickActionsMenu';

/** Default duration in ms to trigger long-press for quick actions menu */
const DEFAULT_LONG_PRESS_DURATION = 500;

/**
 * Trigger haptic feedback using the Vibration API
 * Uses short vibrations for tactile confirmation on mobile devices
 *
 * @param pattern - Vibration pattern in milliseconds or single duration
 *   - 'light' (10ms) - subtle tap for button presses
 *   - 'medium' (25ms) - standard confirmation feedback
 *   - 'strong' (50ms) - important action confirmation
 *   - number - custom duration in milliseconds
 */
function triggerHapticFeedback(pattern: 'light' | 'medium' | 'strong' | number = 'medium'): void {
	if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
		const duration =
			pattern === 'light' ? 10 : pattern === 'medium' ? 25 : pattern === 'strong' ? 50 : pattern;

		try {
			navigator.vibrate(duration);
		} catch {
			// Silently fail if vibration is not allowed (e.g., permissions, battery saver)
		}
	}
}

/** Options for configuring long-press menu behavior */
export interface UseLongPressMenuOptions {
	/** Current input mode (AI or terminal) */
	inputMode: 'ai' | 'terminal';
	/** Callback when input mode should be toggled */
	onModeToggle?: (mode: 'ai' | 'terminal') => void;
	/** Long-press duration in milliseconds (default: 500ms) */
	longPressDuration?: number;
	/** Whether the input is disabled */
	disabled?: boolean;
	/** Current input value (to check if send should be disabled) */
	value?: string;
}

/** Return value from useLongPressMenu hook */
export interface UseLongPressMenuReturn {
	/** Whether the quick actions menu is open */
	isMenuOpen: boolean;
	/** Anchor position for the menu (relative to viewport) */
	menuAnchor: { x: number; y: number } | null;
	/** Ref for the send button element */
	sendButtonRef: React.RefObject<HTMLButtonElement>;
	/** Handler for touch start event */
	handleTouchStart: (e: React.TouchEvent<HTMLButtonElement>) => void;
	/** Handler for touch end event */
	handleTouchEnd: (e: React.TouchEvent<HTMLButtonElement>) => void;
	/** Handler for touch move event */
	handleTouchMove: () => void;
	/** Handler for quick action selection */
	handleQuickAction: (action: QuickAction) => void;
	/** Close the quick actions menu */
	closeMenu: () => void;
}

/**
 * Hook for long-press menu on send button
 *
 * @param options - Configuration options
 * @returns Long-press menu state and handlers
 *
 * @example
 * ```tsx
 * const {
 *   isMenuOpen,
 *   menuAnchor,
 *   sendButtonRef,
 *   handleTouchStart,
 *   handleTouchEnd,
 *   handleTouchMove,
 *   handleQuickAction,
 *   closeMenu,
 * } = useLongPressMenu({
 *   inputMode,
 *   onModeToggle,
 * });
 *
 * return (
 *   <>
 *     <button
 *       ref={sendButtonRef}
 *       onTouchStart={handleTouchStart}
 *       onTouchEnd={handleTouchEnd}
 *       onTouchMove={handleTouchMove}
 *     >
 *       Send
 *     </button>
 *     <QuickActionsMenu
 *       isOpen={isMenuOpen}
 *       onClose={closeMenu}
 *       onSelectAction={handleQuickAction}
 *       anchorPosition={menuAnchor}
 *     />
 *   </>
 * );
 * ```
 */
export function useLongPressMenu({
	inputMode,
	onModeToggle,
	longPressDuration = DEFAULT_LONG_PRESS_DURATION,
	disabled = false,
	value = '',
}: UseLongPressMenuOptions): UseLongPressMenuReturn {
	// Quick actions menu state
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
	const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const sendButtonRef = useRef<HTMLButtonElement>(null);

	/**
	 * Clear long-press timer (used when touch ends or moves)
	 */
	const clearLongPressTimer = useCallback(() => {
		if (longPressTimerRef.current) {
			clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
	}, []);

	/**
	 * Handle long-press start on send button
	 * Starts a timer that will show the quick actions menu
	 */
	const handleTouchStart = useCallback(
		(e: React.TouchEvent<HTMLButtonElement>) => {
			// Clear any existing timer
			clearLongPressTimer();

			// Get the button position for menu anchor
			const button = sendButtonRef.current;
			if (button) {
				const rect = button.getBoundingClientRect();
				const anchor = {
					x: rect.left + rect.width / 2,
					y: rect.top,
				};

				// Start long-press timer
				longPressTimerRef.current = setTimeout(() => {
					// Trigger haptic feedback for long-press activation
					triggerHapticFeedback('medium');

					// Show quick actions menu
					setMenuAnchor(anchor);
					setIsMenuOpen(true);

					// Prevent the normal touch behavior
					longPressTimerRef.current = null;
				}, longPressDuration);
			}

			// Scale down slightly on touch for tactile feedback
			if (!disabled && value.trim()) {
				e.currentTarget.style.transform = 'scale(0.95)';
			}
		},
		[clearLongPressTimer, disabled, value, longPressDuration]
	);

	/**
	 * Handle touch end on send button
	 * Clears the long-press timer and handles normal tap
	 */
	const handleTouchEnd = useCallback(
		(e: React.TouchEvent<HTMLButtonElement>) => {
			e.currentTarget.style.transform = 'scale(1)';

			// If quick actions menu is not open and timer was running, this was a normal tap
			// The form onSubmit will handle the actual submission
			clearLongPressTimer();
		},
		[clearLongPressTimer]
	);

	/**
	 * Handle touch move on send button
	 * Cancels long-press if user moves finger
	 */
	const handleTouchMove = useCallback(() => {
		clearLongPressTimer();
	}, [clearLongPressTimer]);

	/**
	 * Handle quick action selection from menu
	 */
	const handleQuickAction = useCallback(
		(action: QuickAction) => {
			// Trigger haptic feedback
			triggerHapticFeedback('medium');

			if (action === 'switch_mode') {
				// Toggle to the opposite mode
				const newMode = inputMode === 'ai' ? 'terminal' : 'ai';
				onModeToggle?.(newMode);
			}
		},
		[inputMode, onModeToggle]
	);

	/**
	 * Close quick actions menu
	 */
	const closeMenu = useCallback(() => {
		setIsMenuOpen(false);
	}, []);

	/**
	 * Cleanup timers on unmount
	 */
	useEffect(() => {
		return () => {
			// Clean up long-press timer
			if (longPressTimerRef.current) {
				clearTimeout(longPressTimerRef.current);
			}
		};
	}, []);

	return {
		isMenuOpen,
		menuAnchor,
		sendButtonRef,
		handleTouchStart,
		handleTouchEnd,
		handleTouchMove,
		handleQuickAction,
		closeMenu,
	};
}

export default useLongPressMenu;
