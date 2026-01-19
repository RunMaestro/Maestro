import { useState, useEffect } from 'react';

/**
 * Detects if the device is a mobile phone (not tablet/iPad) in landscape orientation.
 * Used to provide a focused reading view that hides all UI except message history.
 *
 * Detection criteria:
 * - Screen height <= 500px (typical phone in landscape, excludes tablets)
 * - Screen width > height (landscape orientation)
 * - Touch device (has touch capability)
 */
export function useMobileLandscape(): boolean {
	const [isMobileLandscape, setIsMobileLandscape] = useState(false);

	useEffect(() => {
		const checkMobileLandscape = () => {
			const width = window.innerWidth;
			const height = window.innerHeight;

			// Check if it's a touch device
			const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

			// Mobile phone in landscape: narrow height (<=500px), wider than tall, touch device
			// This excludes iPads (which have height > 500px even in landscape)
			// and desktops (which typically don't have touch)
			const isLandscape = width > height;
			const isMobileHeight = height <= 500;

			setIsMobileLandscape(isTouchDevice && isLandscape && isMobileHeight);
		};

		// Check on mount
		checkMobileLandscape();

		// Listen for resize and orientation changes
		window.addEventListener('resize', checkMobileLandscape);
		window.addEventListener('orientationchange', checkMobileLandscape);

		return () => {
			window.removeEventListener('resize', checkMobileLandscape);
			window.removeEventListener('orientationchange', checkMobileLandscape);
		};
	}, []);

	return isMobileLandscape;
}
