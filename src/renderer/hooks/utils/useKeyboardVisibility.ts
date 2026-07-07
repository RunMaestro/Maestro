/**
 * useKeyboardVisibility - virtual-keyboard visibility detection
 *
 * Detects when the on-screen keyboard appears/disappears on phones and tablets
 * using the Visual Viewport API, and reports the pixel offset the keyboard eats
 * from the bottom of the layout viewport. Callers use that offset to lift fixed
 * bottom controls (the AI input + send buttons) above the keyboard.
 *
 * Ported verbatim (behavior-preserving) from the legacy mobile app at
 * `src/web/hooks/useKeyboardVisibility.ts`. It is pure Visual Viewport API with
 * zero app coupling, so it is a no-op on the Electron desktop app and anywhere
 * the Visual Viewport API is unavailable (both return `{ keyboardOffset: 0,
 * isKeyboardVisible: false }`).
 *
 * @example
 * ```tsx
 * const { keyboardOffset, isKeyboardVisible } = useKeyboardVisibility();
 *
 * return (
 *   <div style={{ '--keyboard-offset': `${isKeyboardVisible ? keyboardOffset : 0}px` }}>
 *     ...app shell...
 *   </div>
 * );
 * ```
 */

import { useState, useEffect, useCallback, useRef } from 'react';

/** Minimum offset (in pixels) to consider the keyboard visible. */
const KEYBOARD_VISIBILITY_THRESHOLD = 50;

/** Return value from useKeyboardVisibility. */
export interface UseKeyboardVisibilityReturn {
	/** Current keyboard offset in pixels (0 when the keyboard is hidden). */
	keyboardOffset: number;
	/** Whether the virtual keyboard is currently visible. */
	isKeyboardVisible: boolean;
}

/**
 * Hook for detecting virtual-keyboard visibility.
 *
 * The Visual Viewport API reports the actual visible area of the viewport,
 * which shrinks when the keyboard appears. Comparing the visual viewport height
 * to `window.innerHeight` (and subtracting the viewport's `offsetTop`) yields
 * the space the keyboard occupies.
 *
 * @returns Keyboard visibility state and offset.
 */
export function useKeyboardVisibility(): UseKeyboardVisibilityReturn {
	const [keyboardOffset, setKeyboardOffset] = useState(0);
	const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

	// Track isKeyboardVisible in a ref so the scroll handler avoids a stale closure.
	const isKeyboardVisibleRef = useRef(isKeyboardVisible);
	isKeyboardVisibleRef.current = isKeyboardVisible;

	/** Recompute the keyboard offset from the current viewport dimensions. */
	const calculateOffset = useCallback(() => {
		if (typeof window === 'undefined') return;
		const viewport = window.visualViewport;
		if (!viewport) return;

		// windowHeight - viewportHeight - offsetTop = space taken by the keyboard.
		const windowHeight = window.innerHeight;
		const viewportHeight = viewport.height;
		const offset = windowHeight - viewportHeight - viewport.offsetTop;

		// Only flag as visible past the threshold so small viewport jitters
		// (URL-bar collapse, etc.) don't read as a keyboard.
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
			// Re-adjust on scroll to keep elements in view while the keyboard is up.
			if (isKeyboardVisibleRef.current) {
				calculateOffset();
			}
		};

		viewport.addEventListener('resize', handleResize);
		viewport.addEventListener('scroll', handleScroll);

		// Initial check.
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
