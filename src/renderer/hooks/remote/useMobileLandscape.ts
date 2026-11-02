import { useState, useEffect } from 'react';

/**
 * Detects if the device is a mobile phone (not tablet/iPad) in landscape orientation.
 * Used to provide a focused reading view that hides all UI except message history.
 *
 * Detection criteria:
 * - Screen height <= 500px (typical phone in landscape, excludes tablets)
 * - The DEVICE is in landscape (see isDeviceLandscape)
 * - Touch device (has touch capability)
 */
/**
 * Orientation of the device, not of the viewport.
 *
 * Firefox for Android shrinks the LAYOUT viewport when the soft keyboard opens
 * (Chrome 108+ and iOS Safari shrink only the visual viewport), so a portrait
 * phone with the keyboard up reports `innerWidth > innerHeight`. Read as
 * landscape, that hid the composer the moment it was tapped: the textarea
 * unmounted, the keyboard closed, the viewport grew back, and the tap appeared
 * to do nothing. `screen.orientation` does not move with the keyboard. Where it
 * is missing (older iOS, jsdom) the viewport comparison stands, and iOS never
 * resizes the layout viewport for its keyboard.
 */
function isDeviceLandscape(): boolean {
	const type = window.screen?.orientation?.type;
	if (type) return type.startsWith('landscape');
	return window.innerWidth > window.innerHeight;
}

export function useMobileLandscape(): boolean {
	const [isMobileLandscape, setIsMobileLandscape] = useState(false);

	useEffect(() => {
		const checkMobileLandscape = () => {
			const height = window.innerHeight;

			// Check if it's a touch device
			const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

			// Mobile phone in landscape: narrow height (<=500px), wider than tall, touch device
			// This excludes iPads (which have height > 500px even in landscape)
			// and desktops (which typically don't have touch)
			const isLandscape = isDeviceLandscape();
			const isMobileHeight = height <= 500;

			setIsMobileLandscape(isTouchDevice && isLandscape && isMobileHeight);
		};

		// Check on mount
		checkMobileLandscape();

		// Listen for resize and orientation changes
		window.addEventListener('resize', checkMobileLandscape);
		window.addEventListener('orientationchange', checkMobileLandscape);
		const screenOrientation = window.screen?.orientation;
		screenOrientation?.addEventListener?.('change', checkMobileLandscape);

		return () => {
			window.removeEventListener('resize', checkMobileLandscape);
			window.removeEventListener('orientationchange', checkMobileLandscape);
			screenOrientation?.removeEventListener?.('change', checkMobileLandscape);
		};
	}, []);

	return isMobileLandscape;
}
