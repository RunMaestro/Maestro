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
	// --- Core backgrounds ---
	/** Main background color for primary content areas */
	bgMain: string;
	/** Sidebar background color */
	bgSidebar: string;
	/** Background for interactive/activity elements */
	bgActivity: string;
	/** Border color for dividers and outlines */
	border: string;

	// --- Typography ---
	/** Primary text color */
	textMain: string;
	/** Dimmed/secondary text color */
	textDim: string;

	// --- Accent ---
	/** Accent color for highlights and interactive elements */
	accent: string;
	/** Dimmed accent (typically with alpha transparency) */
	accentDim: string;
	/** Text color for accent contexts */
	accentText: string;
	/** Text color for use ON accent backgrounds (contrasting color) */
	accentForeground: string;

	// --- Status colors ---
	/** Success state color (green tones) */
	success: string;
	/** Warning state color (yellow/orange tones) */
	warning: string;
	/** Error state color (red tones) */
	error: string;
	/** Info state color (blue tones) */
	info: string;

	// --- Status foregrounds (text ON status backgrounds) ---
	/** Text color for use ON success backgrounds */
	successForeground: string;
	/** Text color for use ON warning backgrounds */
	warningForeground: string;
	/** Text color for use ON error backgrounds */
	errorForeground: string;

	// --- Status dim backgrounds (subtle badges/tags) ---
	/** Dimmed success background for badges and tags */
	successDim: string;
	/** Dimmed warning background for badges and tags */
	warningDim: string;
	/** Dimmed error background for badges and tags */
	errorDim: string;
	/** Dimmed info background for badges and tags */
	infoDim: string;

	// --- Git diff colors ---
	/** Color for added lines/files in diffs */
	diffAddition: string;
	/** Background for added lines/files in diffs */
	diffAdditionBg: string;
	/** Color for deleted lines/files in diffs */
	diffDeletion: string;
	/** Background for deleted lines/files in diffs */
	diffDeletionBg: string;

	// --- Overlay and interactive states ---
	/** Modal/overlay backdrop color */
	overlay: string;
	/** Heavy overlay for wizard/fullscreen modals */
	overlayHeavy: string;
	/** Subtle hover state background */
	hoverBg: string;
	/** Selected/active state background */
	activeBg: string;
	/** Standard elevation shadow color */
	shadow: string;
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
