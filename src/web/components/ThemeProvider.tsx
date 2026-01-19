/**
 * ThemeProvider component for Maestro web interface
 *
 * Provides theme context to web components. Accepts theme via props
 * (typically received from WebSocket connection to desktop app).
 * Automatically injects CSS custom properties for theme colors.
 *
 * Supports respecting device color scheme preference (dark/light mode)
 * when no explicit theme override is provided from the desktop app.
 */

import React, { createContext, useContext, useEffect, useMemo } from 'react';
import type { Theme, ThemeColors } from '../../shared/theme-types';
import { injectCSSProperties, removeCSSProperties } from '../utils/cssCustomProperties';
import { useDeviceColorScheme, type ColorSchemePreference } from '../hooks/useDeviceColorScheme';

/**
 * Context value containing the current theme and utility functions
 */
interface ThemeContextValue {
	/** Current theme object */
	theme: Theme;
	/** Whether the theme is a light theme */
	isLight: boolean;
	/** Whether the theme is a dark theme */
	isDark: boolean;
	/** Whether the theme is a vibe theme */
	isVibe: boolean;
	/** Whether the theme is based on device preference (not overridden by desktop app) */
	isDevicePreference: boolean;
}

/**
 * Default dark theme used when device prefers dark mode or when we can't detect
 * Matches the Dracula theme from the desktop app
 */
const defaultDarkTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#0b0b0d',
		bgSidebar: '#111113',
		bgActivity: '#1c1c1f',
		border: '#27272a',
		textMain: '#e4e4e7',
		textDim: '#a1a1aa',
		accent: '#6366f1',
		accentDim: 'rgba(99, 102, 241, 0.2)',
		accentText: '#a5b4fc',
		accentForeground: '#0b0b0d',
		success: '#22c55e',
		warning: '#eab308',
		error: '#ef4444',
	},
};

/**
 * Default light theme used when device prefers light mode
 * Matches the GitHub Light theme from the desktop app
 */
const defaultLightTheme: Theme = {
	id: 'github-light',
	name: 'GitHub',
	mode: 'light',
	colors: {
		bgMain: '#ffffff',
		bgSidebar: '#f6f8fa',
		bgActivity: '#eff2f5',
		border: '#d0d7de',
		textMain: '#24292f',
		textDim: '#57606a',
		accent: '#0969da',
		accentDim: 'rgba(9, 105, 218, 0.1)',
		accentText: '#0969da',
		accentForeground: '#ffffff',
		success: '#1a7f37',
		warning: '#9a6700',
		error: '#cf222e',
	},
};

/**
 * Get the default theme based on device color scheme preference
 */
function getDefaultThemeForScheme(colorScheme: ColorSchemePreference): Theme {
	return colorScheme === 'light' ? defaultLightTheme : defaultDarkTheme;
}

// Keep backwards compatibility - export defaultTheme as alias for defaultDarkTheme
const _defaultTheme = defaultDarkTheme;

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
	/**
	 * Theme object to provide to children.
	 * If not provided and useDevicePreference is true, uses theme based on device preference.
	 * If not provided and useDevicePreference is false, uses default dark theme.
	 */
	theme?: Theme;
	/**
	 * Whether to respect the device's color scheme preference (dark/light mode).
	 * When true and no theme prop is provided, the theme will automatically
	 * switch based on the user's device preference (prefers-color-scheme).
	 * When false, always uses the default dark theme if no theme is provided.
	 * @default false
	 */
	useDevicePreference?: boolean;
	/** Children components that will have access to the theme */
	children: React.ReactNode;
}

/**
 * ThemeProvider component that provides theme context to the component tree
 *
 * @example
 * ```tsx
 * // With theme from WebSocket
 * <ThemeProvider theme={themeFromServer}>
 *   <App />
 * </ThemeProvider>
 *
 * // With device preference support (mobile web)
 * <ThemeProvider useDevicePreference>
 *   <MobileApp />
 * </ThemeProvider>
 *
 * // Using the context in a child component
 * const { theme, isDark, isDevicePreference } = useTheme();
 * ```
 */
export function ThemeProvider({
	theme: themeProp,
	useDevicePreference = false,
	children,
}: ThemeProviderProps) {
	// Get device color scheme preference
	const { colorScheme } = useDeviceColorScheme();

	// Determine the active theme:
	// 1. If a theme prop is provided (from desktop app), use it (override)
	// 2. If useDevicePreference is true and no theme prop, use device preference
	// 3. Otherwise, use default dark theme
	const { activeTheme, isDevicePreference } = useMemo(() => {
		// Theme prop provided - this is an override from desktop app
		if (themeProp) {
			return { activeTheme: themeProp, isDevicePreference: false };
		}

		// No theme prop - check if we should use device preference
		if (useDevicePreference) {
			return {
				activeTheme: getDefaultThemeForScheme(colorScheme),
				isDevicePreference: true,
			};
		}

		// Default to dark theme
		return { activeTheme: defaultDarkTheme, isDevicePreference: false };
	}, [themeProp, useDevicePreference, colorScheme]);

	const contextValue = useMemo<ThemeContextValue>(
		() => ({
			theme: activeTheme,
			isLight: activeTheme.mode === 'light',
			isDark: activeTheme.mode === 'dark',
			isVibe: activeTheme.mode === 'vibe',
			isDevicePreference,
		}),
		[activeTheme, isDevicePreference]
	);

	// Inject CSS custom properties whenever the theme changes
	useEffect(() => {
		injectCSSProperties(activeTheme);

		// Cleanup on unmount
		return () => {
			removeCSSProperties();
		};
	}, [activeTheme]);

	return <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>;
}

/**
 * Hook to access the current theme context
 *
 * @throws Error if used outside of a ThemeProvider
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { theme, isDark } = useTheme();
 *   return (
 *     <div style={{ backgroundColor: theme.colors.bgMain }}>
 *       {isDark ? 'Dark mode' : 'Light mode'}
 *     </div>
 *   );
 * }
 * ```
 */
export function useTheme(): ThemeContextValue {
	const context = useContext(ThemeContext);
	if (!context) {
		throw new Error('useTheme must be used within a ThemeProvider');
	}
	return context;
}

/**
 * Hook to access just the theme colors for convenience
 *
 * @throws Error if used outside of a ThemeProvider
 *
 * @example
 * ```tsx
 * function Button() {
 *   const colors = useThemeColors();
 *   return (
 *     <button style={{
 *       backgroundColor: colors.accent,
 *       color: colors.accentText
 *     }}>
 *       Click me
 *     </button>
 *   );
 * }
 * ```
 */
export function useThemeColors(): ThemeColors {
	const { theme } = useTheme();
	return theme.colors;
}

export { ThemeContext };
export type { ThemeContextValue };
