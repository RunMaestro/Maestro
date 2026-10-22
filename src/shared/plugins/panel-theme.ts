/** Host-owned, one-way visual contract for isolated plugin panels. */
import { isValidCssColor } from '../cssColor';
import type { Theme } from '../theme-types';

export const PANEL_THEME_CHANNEL = 'maestro:panelTheme';

/** Only these theme colors may cross into a panel guest. */
export const PANEL_THEME_COLOR_TOKENS = {
	'--maestro-bg-main': 'bgMain',
	'--maestro-bg-sidebar': 'bgSidebar',
	'--maestro-bg-activity': 'bgActivity',
	'--maestro-border': 'border',
	'--maestro-text-main': 'textMain',
	'--maestro-text-dim': 'textDim',
	'--maestro-accent': 'accent',
	'--maestro-accent-dim': 'accentDim',
	'--maestro-accent-foreground': 'accentForeground',
	'--maestro-success': 'success',
	'--maestro-warning': 'warning',
	'--maestro-error': 'error',
} as const;

export interface PanelThemePayload {
	colorScheme: 'light' | 'dark';
	colors: Record<string, string>;
}

/** Validate a single color without allowing references to guest-defined CSS. */
export function isPanelThemeColor(value: unknown): value is string {
	if (typeof value !== 'string' || value.length > 256) return false;
	if (
		/[;{}!\\]/.test(value) ||
		/\b(?:var|url|env|attr)\s*\(/i.test(value) ||
		/\bcurrentcolor\b/i.test(value)
	)
		return false;
	// Chromium understands modern color forms (oklch, color-mix, etc.) that the
	// deterministic theme-import validator intentionally does not. In non-DOM
	// tests, retain that validator's conservative behavior.
	const css = (globalThis as { CSS?: { supports?: (property: string, value: string) => boolean } })
		.CSS;
	return css?.supports ? css.supports('color', value) : isValidCssColor(value);
}

/** The root style an isolated guest's preload writes the theme to (`document.documentElement.style`). */
export interface PanelThemeStyleTarget {
	setProperty(name: string, value: string): void;
	removeProperty(name: string): void;
}

/**
 * Apply a theme payload a host sent into an isolated guest (plugin panels, the DataviewJS sandbox). Runs in
 * the guest preload's isolated world, so page scripts never see a bridge. Only the fixed color tokens are
 * written, each checked; a token the payload leaves out or spells badly is cleared, so a stale color never
 * lingers. A payload that is not a theme payload changes nothing.
 */
export function applyPanelThemePayload(style: PanelThemeStyleTarget, data: unknown): void {
	if (typeof data !== 'object' || data === null) return;
	const payload = data as Record<string, unknown>;
	if (payload.colorScheme !== 'light' && payload.colorScheme !== 'dark') return;
	if (typeof payload.colors !== 'object' || payload.colors === null) return;
	const colors = payload.colors as Record<string, unknown>;
	for (const token of Object.keys(PANEL_THEME_COLOR_TOKENS)) {
		const value = Object.prototype.hasOwnProperty.call(colors, token) ? colors[token] : null;
		if (isPanelThemeColor(value)) {
			style.setProperty(token, value);
		} else {
			style.removeProperty(token);
		}
	}
	const background = colors['--maestro-bg-main'];
	if (isPanelThemeColor(background)) {
		style.setProperty('background-color', background);
	} else {
		style.removeProperty('background-color');
	}
	style.setProperty('color-scheme', payload.colorScheme);
}

/** Builds a data-only snapshot from the active theme, never from stored plugin settings. */
export function buildPanelThemePayload(theme: Theme): PanelThemePayload {
	const colors: Record<string, string> = {};
	for (const [token, key] of Object.entries(PANEL_THEME_COLOR_TOKENS)) {
		const value = theme.colors[key as keyof typeof theme.colors];
		if (isPanelThemeColor(value)) colors[token] = value;
	}
	// Vibe palettes are dark surfaces; CSS color-scheme has no "vibe" value.
	return { colorScheme: theme.mode === 'light' ? 'light' : 'dark', colors };
}
