/**
 * useLongPressMenu - Long-press gesture hook for mobile touch interactions
 *
 * Detects long-press on the send button and triggers the command palette.
 *
 * Features:
 * - Configurable long-press duration (default 500ms)
 * - Touch event handlers (start, end, move)
 * - Automatic timer cleanup on touch move/end
 * - Haptic feedback integration
 * - Proper cleanup on unmount
 *
 * @module useLongPressMenu
 */

import { useRef, useCallback, useEffect, useState } from 'react';

/** Default duration in ms to trigger long-press for quick actions menu */
const DEFAULT_LONG_PRESS_DURATION = 500;

/**
 * Trigger haptic feedback using the Vibration API
 */
export function triggerHapticFeedback(
	pattern: 'light' | 'medium' | 'strong' | number = 'medium'
): void {
	if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
		const duration =
			pattern === 'light' ? 10 : pattern === 'medium' ? 25 : pattern === 'strong' ? 50 : pattern;

		try {
			navigator.vibrate(duration);
		} catch {
			// Silently fail if vibration is not allowed
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
	/** Callback to open the command palette */
	onOpenCommandPalette?: () => void;
}

/** Return value from useLongPressMenu hook */
export interface UseLongPressMenuReturn {
	/** Ref for the send button element */
	sendButtonRef: React.RefObject<HTMLButtonElement>;
	/** Whether the quick-action menu is open */
	isMenuOpen: boolean;
	/** Anchor point for the quick-action menu */
	menuAnchor: { x: number; y: number } | null;
	/** Handler for touch start event */
	handleTouchStart: (e: React.TouchEvent<HTMLButtonElement>) => void;
	/** Handler for touch end event */
	handleTouchEnd: (e: React.TouchEvent<HTMLButtonElement>) => void;
	/** Handler for touch move event */
	handleTouchMove: () => void;
	/** Handle a quick-action selection */
	handleQuickAction: (action: 'switch_mode') => void;
	/** Close the quick-action menu */
	closeMenu: () => void;
}

/**
 * Hook for long-press gesture on send button
 *
 * On long-press, opens the command palette via the onOpenCommandPalette callback.
 */
export function useLongPressMenu({
	inputMode,
	longPressDuration = DEFAULT_LONG_PRESS_DURATION,
	disabled = false,
	value = '',
	onModeToggle,
	onOpenCommandPalette,
}: UseLongPressMenuOptions): UseLongPressMenuReturn {
	const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const sendButtonRef = useRef<HTMLButtonElement>(null);
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);

	const clearLongPressTimer = useCallback(() => {
		if (longPressTimerRef.current) {
			clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
	}, []);

	const handleTouchStart = useCallback(
		(e: React.TouchEvent<HTMLButtonElement>) => {
			clearLongPressTimer();
			if (disabled || !value.trim()) return;

			longPressTimerRef.current = setTimeout(() => {
				const button = sendButtonRef.current;
				if (!button) {
					longPressTimerRef.current = null;
					return;
				}
				const rect = button.getBoundingClientRect();
				setMenuAnchor({ x: rect.left + rect.width / 2, y: rect.top });
				setIsMenuOpen(true);
				triggerHapticFeedback('medium');
				onOpenCommandPalette?.();
				longPressTimerRef.current = null;
			}, longPressDuration);

			// Scale down slightly on touch for tactile feedback
			if (!disabled && value.trim()) {
				e.currentTarget.style.transform = 'scale(0.95)';
			}
		},
		[clearLongPressTimer, disabled, value, longPressDuration, onOpenCommandPalette]
	);

	const handleTouchEnd = useCallback(
		(e: React.TouchEvent<HTMLButtonElement>) => {
			e.currentTarget.style.transform = 'scale(1)';
			clearLongPressTimer();
		},
		[clearLongPressTimer]
	);

	const handleTouchMove = useCallback(() => {
		clearLongPressTimer();
	}, [clearLongPressTimer]);

	const closeMenu = useCallback(() => {
		setIsMenuOpen(false);
		setMenuAnchor(null);
	}, []);

	const handleQuickAction = useCallback(
		(action: 'switch_mode') => {
			if (action !== 'switch_mode') return;
			onModeToggle?.(inputMode === 'ai' ? 'terminal' : 'ai');
			closeMenu();
		},
		[closeMenu, inputMode, onModeToggle]
	);

	// Cleanup timers on unmount
	useEffect(() => {
		return () => {
			if (longPressTimerRef.current) {
				clearTimeout(longPressTimerRef.current);
			}
		};
	}, []);

	return {
		sendButtonRef,
		isMenuOpen,
		menuAnchor,
		handleTouchStart,
		handleTouchEnd,
		handleTouchMove,
		handleQuickAction,
		closeMenu,
	};
}

export default useLongPressMenu;
