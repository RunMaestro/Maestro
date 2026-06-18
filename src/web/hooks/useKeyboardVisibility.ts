/**
 * useKeyboardVisibility - Mobile keyboard visibility detection hook
 *
 * Detects when the mobile virtual keyboard appears/disappears using
 * the Visual Viewport API. Provides the keyboard offset for proper
 * positioning of fixed elements above the keyboard.
 *
 * Features:
 * - Uses modern Visual Viewport API for accurate detection
 * - Tracks keyboard offset for positioning calculations
 * - Boolean flag for simple keyboard visibility checks
 * - Handles viewport scroll events to maintain proper positioning
 * - Proper cleanup on unmount
 *
 * @example
 * ```tsx
 * const { keyboardOffset, isKeyboardVisible } = useKeyboardVisibility();
 *
 * return (
 *   <div style={{
 *     position: 'fixed',
 *     bottom: keyboardOffset,
 *     transition: isKeyboardVisible ? 'none' : 'bottom 0.15s ease-out',
 *   }}>
 *     Input bar content
 *   </div>
 * );
 * ```
 */

import { useState, useEffect, useCallback, useRef } from 'react';

/** Minimum offset (in pixels) to consider keyboard visible */
const KEYBOARD_VISIBILITY_THRESHOLD = 50;

/** Return value from useKeyboardVisibility hook */
export interface UseKeyboardVisibilityReturn {
	/** Current keyboard offset in pixels (0 when keyboard is hidden) */
	keyboardOffset: number;
	/** Whether the keyboard is currently visible */
	isKeyboardVisible: boolean;
}

/**
 * Hook for detecting mobile keyboard visibility
 *
 * Uses the Visual Viewport API to detect when the mobile virtual keyboard
 * appears. This is the modern, reliable way to handle keyboard appearance
 * on mobile devices.
 *
 * The Visual Viewport API reports the actual visible area of the viewport,
 * which shrinks when the keyboard appears. By comparing the visual viewport
 * height to the window inner height, we can detect the keyboard.
 *
 * @returns Keyboard visibility state and offset
 */
export function useKeyboardVisibility(): UseKeyboardVisibilityReturn {
	const [keyboardOffset, setKeyboardOffset] = useState(0);
	const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

	// Use ref to track isKeyboardVisible for scroll handler to avoid stale closure
	const isKeyboardVisibleRef = useRef(isKeyboardVisible);
	isKeyboardVisibleRef.current = isKeyboardVisible;

	/**
	 * Calculate keyboard offset from viewport dimensions
	 */
	const calculateOffset = useCallback(() => {
		if (typeof window === 'undefined') return;
		const viewport = window.visualViewport;
		if (!viewport) return;

		// Calculate the offset caused by keyboard
		// windowHeight - viewportHeight - offsetTop = space taken by keyboard
		const windowHeight = window.innerHeight;
		const viewportHeight = viewport.height;
		const offset = windowHeight - viewportHeight - viewport.offsetTop;

		// Only update if there's a significant change (keyboard appearing/disappearing)
		if (offset > KEYBOARD_VISIBILITY_THRESHOLD) {
			setKeyboardOffset(offset);
			setIsKeyboardVisible(true);
		} else {
			setKeyboardOffset(0);
			setIsKeyboardVisible(false);
		}
	}, []);

	useEffect(() => {
		if (typeof window === 'undefined') return;
		const viewport = window.visualViewport;
		if (!viewport) return;

		const handleResize = () => {
			calculateOffset();
		};

		const handleScroll = () => {
			// Re-adjust on scroll to keep elements in view when keyboard is visible
			if (isKeyboardVisibleRef.current) {
				calculateOffset();
			}
		};

		viewport.addEventListener('resize', handleResize);
		viewport.addEventListener('scroll', handleScroll);

		// Initial check
		calculateOffset();

		return () => {
			viewport.removeEventListener('resize', handleResize);
			viewport.removeEventListener('scroll', handleScroll);
		};
	}, [calculateOffset]);

	return {
		keyboardOffset,
		isKeyboardVisible,
	};
}

export default useKeyboardVisibility;
