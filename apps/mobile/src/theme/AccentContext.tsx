/**
 * AccentContext - Bridges accent color from Maestro desktop theme
 *
 * Per decision 5C: accent color comes from the Maestro desktop theme via WebSocket,
 * while surfaces/text remain chat-template's neutral light/dark system.
 *
 * The accent applies to:
 * - Drawer row active state
 * - Tab strip active pill
 * - Send button
 * - Link color
 * - Streaming cursor on in-flight assistant bubble
 *
 * Usage:
 *   const { accentColor } = useAccent();
 *   // accentColor is a hex string like '#6366f1'
 */

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { Theme } from '@maestro/shared/theme-types';

// ============================================================================
// Types
// ============================================================================

export interface AccentContextValue {
	/** The current accent color hex string from the Maestro theme */
	accentColor: string;
	/** Dimmed accent color (with alpha) for subtle backgrounds */
	accentColorDim: string;
	/** Text color to use ON accent backgrounds (contrasting) */
	accentForeground: string;
	/** The full theme object from Maestro (for advanced use cases) */
	theme: Theme | null;
	/** Update the theme (called by WebSocket handler) */
	setTheme: (theme: Theme) => void;
}

// ============================================================================
// Default accent color
// ============================================================================

/** Default accent color when no Maestro theme has been received yet (indigo-500) */
const DEFAULT_ACCENT = '#6366f1';
/** Default dimmed accent */
const DEFAULT_ACCENT_DIM = 'rgba(99, 102, 241, 0.2)';
/** Default accent foreground (white for good contrast) */
const DEFAULT_ACCENT_FOREGROUND = '#ffffff';

// ============================================================================
// Context
// ============================================================================

const AccentContext = createContext<AccentContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface AccentProviderProps {
	children: React.ReactNode;
}

export function AccentProvider({ children }: AccentProviderProps) {
	const [theme, setThemeState] = useState<Theme | null>(null);

	const setTheme = useCallback((newTheme: Theme) => {
		setThemeState(newTheme);
	}, []);

	const value = useMemo((): AccentContextValue => {
		const colors = theme?.colors;
		return {
			accentColor: colors?.accent || DEFAULT_ACCENT,
			accentColorDim: colors?.accentDim || DEFAULT_ACCENT_DIM,
			accentForeground: colors?.accentForeground || DEFAULT_ACCENT_FOREGROUND,
			theme,
			setTheme,
		};
	}, [theme, setTheme]);

	return <AccentContext.Provider value={value}>{children}</AccentContext.Provider>;
}

// ============================================================================
// Hook
// ============================================================================

export function useAccent(): AccentContextValue {
	const context = useContext(AccentContext);
	if (!context) {
		throw new Error('useAccent must be used within an AccentProvider');
	}
	return context;
}

export default AccentContext;
