/**
 * Shared theme type definitions for Maestro
 *
 * This file contains theme types used across:
 * - Main process (Electron)
 * - Renderer process (Desktop React app)
 * - Web interface (Mobile and Desktop web builds)
 *
 * Keep this file dependency-free to ensure it can be imported anywhere.
 */

/**
 * Available theme identifiers
 */
export type ThemeId =
	| 'dracula'
	| 'monokai'
	| 'github-light'
	| 'solarized-light'
	| 'nord'
	| 'tokyo-night'
	| 'one-light'
	| 'gruvbox-light'
	| 'catppuccin-mocha'
	| 'gruvbox-dark'
	| 'catppuccin-latte'
	| 'ayu-light'
	| 'pedurple'
	| 'maestros-choice'
	| 'dre-synth'
	| 'inquest'
	| 'custom';

/**
 * Theme mode indicating the overall brightness/style
 */
export type ThemeMode = 'light' | 'dark' | 'vibe';

/**
 * Color palette for a theme
 * Each color serves a specific purpose in the UI
 */
export interface ThemeColors {
	/** Main background color for primary content areas */
	bgMain: string;
	/** Sidebar background color */
	bgSidebar: string;
	/** Background for interactive/activity elements */
	bgActivity: string;
	/** Border color for dividers and outlines */
	border: string;
	/** Primary text color */
	textMain: string;
	/** Dimmed/secondary text color */
	textDim: string;
	/** Accent color for highlights and interactive elements */
	accent: string;
	/** Dimmed accent (typically with alpha transparency) */
	accentDim: string;
	/** Text color for accent contexts */
	accentText: string;
	/** Text color for use ON accent backgrounds (contrasting color) */
	accentForeground: string;
	/** Success state color (green tones) */
	success: string;
	/** Warning state color (yellow/orange tones) */
	warning: string;
	/** Error state color (red tones) */
	error: string;

	/** ANSI black color for terminal rendering (optional override) */
	ansiBlack?: string;
	/** ANSI red color for terminal rendering (optional override) */
	ansiRed?: string;
	/** ANSI green color for terminal rendering (optional override) */
	ansiGreen?: string;
	/** ANSI yellow color for terminal rendering (optional override) */
	ansiYellow?: string;
	/** ANSI blue color for terminal rendering (optional override) */
	ansiBlue?: string;
	/** ANSI magenta color for terminal rendering (optional override) */
	ansiMagenta?: string;
	/** ANSI cyan color for terminal rendering (optional override) */
	ansiCyan?: string;
	/** ANSI white color for terminal rendering (optional override) */
	ansiWhite?: string;
	/** ANSI bright black color for terminal rendering (optional override) */
	ansiBrightBlack?: string;
	/** ANSI bright red color for terminal rendering (optional override) */
	ansiBrightRed?: string;
	/** ANSI bright green color for terminal rendering (optional override) */
	ansiBrightGreen?: string;
	/** ANSI bright yellow color for terminal rendering (optional override) */
	ansiBrightYellow?: string;
	/** ANSI bright blue color for terminal rendering (optional override) */
	ansiBrightBlue?: string;
	/** ANSI bright magenta color for terminal rendering (optional override) */
	ansiBrightMagenta?: string;
	/** ANSI bright cyan color for terminal rendering (optional override) */
	ansiBrightCyan?: string;
	/** ANSI bright white color for terminal rendering (optional override) */
	ansiBrightWhite?: string;

	/** Selection background color for terminal rendering (optional override) */
	selection?: string;
}

/**
 * Complete theme definition
 */
export interface Theme {
	/** Unique identifier for the theme */
	id: ThemeId;
	/** Human-readable display name */
	name: string;
	/** Theme mode (light, dark, or vibe) */
	mode: ThemeMode;
	/** Color palette */
	colors: ThemeColors;
}

/**
 * Type guard to check if a string is a valid ThemeId
 */
export function isValidThemeId(id: string): id is ThemeId {
	const validIds: ThemeId[] = [
		'dracula',
		'monokai',
		'github-light',
		'solarized-light',
		'nord',
		'tokyo-night',
		'one-light',
		'gruvbox-light',
		'catppuccin-mocha',
		'gruvbox-dark',
		'catppuccin-latte',
		'ayu-light',
		'pedurple',
		'maestros-choice',
		'dre-synth',
		'inquest',
		'custom',
	];
	return validIds.includes(id as ThemeId);
}
