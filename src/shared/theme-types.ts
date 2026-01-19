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
