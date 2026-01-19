/**
 * useDeviceColorScheme hook for Maestro web interface
 *
 * Detects and tracks the device's preferred color scheme (dark/light mode).
 * Uses the `prefers-color-scheme` media query to determine user preference.
 * Listens for changes so the UI can update dynamically if the user changes
 * their device settings.
 */

import { useState, useEffect } from 'react';

/**
 * Device color scheme preferences
 */
export type ColorSchemePreference = 'light' | 'dark';

/**
 * Return value from useDeviceColorScheme hook
 */
export interface UseDeviceColorSchemeReturn {
	/** The device's current color scheme preference */
	colorScheme: ColorSchemePreference;
	/** Whether the device prefers dark mode */
	prefersDark: boolean;
	/** Whether the device prefers light mode */
	prefersLight: boolean;
}

/**
 * Detect the initial color scheme from the media query
 */
function getInitialColorScheme(): ColorSchemePreference {
	// Check if window and matchMedia are available (SSR safety)
	if (typeof window === 'undefined' || !window.matchMedia) {
		return 'dark'; // Default to dark when we can't detect
	}

	// Check if the user prefers dark mode
	const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
	return prefersDark ? 'dark' : 'light';
}

/**
 * Hook to detect and track the device's preferred color scheme
 *
 * @example
 * ```tsx
 * function App() {
 *   const { prefersDark, colorScheme } = useDeviceColorScheme();
 *
 *   return (
 *     <ThemeProvider
 *       theme={prefersDark ? darkTheme : lightTheme}
 *     >
 *       <Content />
 *     </ThemeProvider>
 *   );
 * }
 * ```
 */
export function useDeviceColorScheme(): UseDeviceColorSchemeReturn {
	const [colorScheme, setColorScheme] = useState<ColorSchemePreference>(getInitialColorScheme);

	useEffect(() => {
		// Check if matchMedia is available
		if (typeof window === 'undefined' || !window.matchMedia) {
			return;
		}

		// Create media query for dark mode preference
		const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');

		// Handler for when the preference changes
		const handleChange = (event: MediaQueryListEvent) => {
			setColorScheme(event.matches ? 'dark' : 'light');
		};

		// Add event listener for changes
		// Use addEventListener if available (modern browsers), otherwise use deprecated addListener
		if (darkModeQuery.addEventListener) {
			darkModeQuery.addEventListener('change', handleChange);
		} else if (darkModeQuery.addListener) {
			// Fallback for older Safari versions
			darkModeQuery.addListener(handleChange);
		}

		// Cleanup
		return () => {
			if (darkModeQuery.removeEventListener) {
				darkModeQuery.removeEventListener('change', handleChange);
			} else if (darkModeQuery.removeListener) {
				// Fallback for older Safari versions
				darkModeQuery.removeListener(handleChange);
			}
		};
	}, []);

	return {
		colorScheme,
		prefersDark: colorScheme === 'dark',
		prefersLight: colorScheme === 'light',
	};
}

export default useDeviceColorScheme;
