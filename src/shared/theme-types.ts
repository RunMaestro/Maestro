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
	| 'solarized-dark'
	| 'nord'
	| 'tokyo-night'
	| 'one-light'
	| 'gruvbox-light'
	| 'catppuccin-mocha'
	| 'gruvbox-dark'
	| 'olive-nights'
	| 'indigo-blue'
	| 'deep-wine-red'
	| 'yellow-dark-mustard'
	| 'deep-purple'
	| 'catppuccin-latte'
	| 'ayu-light'
	| 'pedurple'
	| 'maestros-choice'
	| 'dre-synth'
	| 'inquest'
	| 'winamp'
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
	/**
	 * Background for the draggable window title bar (the top strip that holds
	 * the traffic-light buttons and the centered agent title). Optional: when
	 * unset the title bar renders transparent and shows `bgMain` behind it,
	 * which is the historical behavior. Built-in themes set it explicitly to
	 * their `bgMain` so existing themes look unchanged.
	 */
	bgTitleBar?: string;
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
	/**
	 * Background tint for a cross-agent (@mention) response bubble - a subtle
	 * wash of the theme accent that flags "this reply came from another agent."
	 * Optional: when unset the renderer derives a subtle accent tint via
	 * color-mix, so every theme (custom included) gets a correct tint for free.
	 */
	crossAgentBubbleBg?: string;
	/** Border color for a cross-agent response bubble. Optional; derived from the accent when unset. */
	crossAgentBubbleBorder?: string;
	/**
	 * `@file` / `@agent` mention-chip tokens. Chips appear frequently in dense
	 * input, so these are deliberately subtle: `Bg` a faint tint a touch off the
	 * input background, `Border` a slightly higher-contrast edge, `Text`
	 * contrast-safe against `Bg`. All optional - when unset the renderer derives
	 * them from the accent/border/text tokens via `getMentionChipColors`, so
	 * every theme (custom included) gets legible chips for free.
	 */
	mentionChipBg?: string;
	mentionChipBorder?: string;
	mentionChipText?: string;
	/** Success state color (green tones) */
	success: string;
	/** Warning state color (yellow/orange tones) */
	warning: string;
	/** Error state color (red tones) */
	error: string;

	/**
	 * ANSI 16-color palette for terminal emulation.
	 * Optional — XTerminal uses theme-appropriate defaults if not provided.
	 */
	ansiBlack?: string;
	ansiRed?: string;
	ansiGreen?: string;
	ansiYellow?: string;
	ansiBlue?: string;
	ansiMagenta?: string;
	ansiCyan?: string;
	ansiWhite?: string;
	ansiBrightBlack?: string;
	ansiBrightRed?: string;
	ansiBrightGreen?: string;
	ansiBrightYellow?: string;
	ansiBrightBlue?: string;
	ansiBrightMagenta?: string;
	ansiBrightCyan?: string;
	ansiBrightWhite?: string;
	/** Selection background color for terminal text selection */
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
		'solarized-dark',
		'nord',
		'tokyo-night',
		'one-light',
		'gruvbox-light',
		'catppuccin-mocha',
		'gruvbox-dark',
		'olive-nights',
		'indigo-blue',
		'deep-wine-red',
		'yellow-dark-mustard',
		'deep-purple',
		'catppuccin-latte',
		'ayu-light',
		'pedurple',
		'maestros-choice',
		'dre-synth',
		'inquest',
		'winamp',
		'custom',
	];
	return validIds.includes(id as ThemeId);
}
