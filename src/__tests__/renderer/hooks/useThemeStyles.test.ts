/**
 * Tests for useThemeStyles hook.
 *
 * The hook is the single bridge between the React theme system and CSS
 * variables consumed by global stylesheets (notably scrollbar styling in
 * src/renderer/index.css). These tests pin the contract: which CSS variables
 * are set, what they map to, and that they update when the theme changes.
 *
 * Without this pinning, future refactors of useThemeStyles could silently
 * break the app-wide themed scrollbars without any test failure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useThemeStyles, type ThemeColors } from '../../../renderer/hooks/ui/useThemeStyles';

const DARK_COLORS: ThemeColors = {
	accent: '#bd93f9',
	border: '#44475a',
	textDim: '#6272a4',
	bgActivity: '#343746',
	textMain: '#f8f8f2',
	bgMain: '#282a36',
	bgSidebar: '#21222c',
	accentText: '#ff79c6',
	accentForeground: '#282a36',
	success: '#50fa7b',
	warning: '#f1fa8c',
	error: '#ff5555',
};

const LIGHT_COLORS: ThemeColors = {
	accent: '#0969da',
	border: '#d0d7de',
	textDim: '#656d76',
	bgActivity: '#f6f8fa',
	textMain: '#1f2328',
	bgMain: '#ffffff',
	bgSidebar: '#f6f8fa',
	accentText: '#0969da',
	accentForeground: '#ffffff',
	success: '#1a7f37',
	warning: '#9a6700',
	error: '#cf222e',
};

/**
 * Every custom property the hook owns. Cleared around each test so a var left
 * behind by an earlier case cannot make a later assertion pass on a value this
 * render never wrote.
 */
const THEME_CSS_VARS = [
	'--accent-color',
	'--highlight-color',
	'--scrollbar-thumb',
	'--scrollbar-thumb-hover',
	'--scrollbar-thumb-active',
	'--scrollbar-track',
	'--fx-quiet',
	'--sheen-rgb',
	'--bg-main',
	'--bg-sidebar',
	'--bg-activity',
	'--border',
	'--text-main',
	'--text-dim',
	'--accent-text',
	'--accent-fg',
	'--success',
	'--warning',
	'--error',
	'--accent-rgb',
];

function clearThemeCssVars(): void {
	const root = document.documentElement.style;
	for (const name of THEME_CSS_VARS) {
		root.removeProperty(name);
	}
}

function getCssVar(name: string): string {
	return document.documentElement.style.getPropertyValue(name);
}

describe('useThemeStyles', () => {
	beforeEach(() => {
		// Clean slate - clear any previously set vars from other tests.
		clearThemeCssVars();
	});

	afterEach(() => {
		// Same cleanup, in case a test errored before the next beforeEach.
		clearThemeCssVars();
	});

	describe('CSS variable injection', () => {
		it('sets all expected CSS variables from theme colors on mount', () => {
			renderHook(() =>
				useThemeStyles({ themeColors: DARK_COLORS, themeMode: 'dark', glossLevel: 'off' })
			);

			expect(getCssVar('--accent-color')).toBe('#bd93f9');
			expect(getCssVar('--highlight-color')).toBe('#bd93f9');
			expect(getCssVar('--scrollbar-thumb')).toBe('#44475a');
			expect(getCssVar('--scrollbar-thumb-hover')).toBe('#6272a4');
			expect(getCssVar('--scrollbar-thumb-active')).toBe('#bd93f9');
			expect(getCssVar('--scrollbar-track')).toBe('#343746');
		});

		it('maps accent to both --accent-color and --highlight-color', () => {
			// --highlight-color is a legacy alias kept for backwards compat with
			// older CSS rules that reference it (e.g. animations in index.css).
			// Both must point to the same color.
			renderHook(() =>
				useThemeStyles({ themeColors: DARK_COLORS, themeMode: 'dark', glossLevel: 'off' })
			);
			expect(getCssVar('--accent-color')).toBe(getCssVar('--highlight-color'));
		});

		it('maps border to --scrollbar-thumb (idle thumb is theme-aware)', () => {
			// Regression: previously the idle thumb was hardcoded
			// rgba(255,255,255,0.15) which was invisible on light themes. Using
			// the theme `border` token makes it work on both light and dark.
			renderHook(() =>
				useThemeStyles({ themeColors: LIGHT_COLORS, themeMode: 'light', glossLevel: 'off' })
			);
			expect(getCssVar('--scrollbar-thumb')).toBe('#d0d7de');
		});

		it('updates CSS variables when theme colors change', () => {
			const { rerender } = renderHook(
				({ colors }) =>
					useThemeStyles({ themeColors: colors, themeMode: 'dark', glossLevel: 'off' }),
				{
					initialProps: { colors: DARK_COLORS },
				}
			);
			expect(getCssVar('--scrollbar-thumb')).toBe('#44475a');
			expect(getCssVar('--accent-color')).toBe('#bd93f9');

			rerender({ colors: LIGHT_COLORS });

			expect(getCssVar('--scrollbar-thumb')).toBe('#d0d7de');
			expect(getCssVar('--scrollbar-thumb-hover')).toBe('#656d76');
			expect(getCssVar('--scrollbar-thumb-active')).toBe('#0969da');
			expect(getCssVar('--scrollbar-track')).toBe('#f6f8fa');
			expect(getCssVar('--accent-color')).toBe('#0969da');
		});

		it('does not re-set unchanged variables when an unrelated theme field changes', () => {
			// Sanity: the effect's dependency array lists every consumed field.
			// If we add a new CSS var, its source field must be in the deps.
			const { rerender } = renderHook(
				({ colors }) =>
					useThemeStyles({ themeColors: colors, themeMode: 'dark', glossLevel: 'off' }),
				{
					initialProps: { colors: DARK_COLORS },
				}
			);

			rerender({ colors: { ...DARK_COLORS, accent: '#ff0000' } });

			expect(getCssVar('--accent-color')).toBe('#ff0000');
			expect(getCssVar('--scrollbar-thumb-active')).toBe('#ff0000');
			// Other vars stay at their previous values
			expect(getCssVar('--scrollbar-thumb')).toBe('#44475a');
			expect(getCssVar('--scrollbar-thumb-hover')).toBe('#6272a4');
		});
	});

	describe('the full palette bridge', () => {
		it('publishes every palette token as its own custom property', () => {
			// The bridge publishes the whole theme rather than only the tokens a
			// rule needs today, so a new themed CSS rule needs no TypeScript
			// change. That is what forced earlier themed effects to hard-code one
			// theme's hex.
			renderHook(() =>
				useThemeStyles({ themeColors: DARK_COLORS, themeMode: 'dark', glossLevel: 'off' })
			);

			expect(getCssVar('--bg-main')).toBe('#282a36');
			expect(getCssVar('--bg-sidebar')).toBe('#21222c');
			expect(getCssVar('--bg-activity')).toBe('#343746');
			expect(getCssVar('--border')).toBe('#44475a');
			expect(getCssVar('--text-main')).toBe('#f8f8f2');
			expect(getCssVar('--text-dim')).toBe('#6272a4');
			expect(getCssVar('--accent-text')).toBe('#ff79c6');
			expect(getCssVar('--accent-fg')).toBe('#282a36');
			expect(getCssVar('--success')).toBe('#50fa7b');
			expect(getCssVar('--warning')).toBe('#f1fa8c');
			expect(getCssVar('--error')).toBe('#ff5555');
		});

		it('repoints every palette var when the theme changes', () => {
			// Each source field is in the effect's dependency array; a missing one
			// leaves the previous theme's colour on <html> with nothing in a diff
			// to show it.
			const { rerender } = renderHook(
				({ colors }) =>
					useThemeStyles({ themeColors: colors, themeMode: 'dark', glossLevel: 'off' }),
				{ initialProps: { colors: DARK_COLORS } }
			);

			rerender({ colors: LIGHT_COLORS });

			expect(getCssVar('--bg-main')).toBe('#ffffff');
			expect(getCssVar('--bg-sidebar')).toBe('#f6f8fa');
			expect(getCssVar('--bg-activity')).toBe('#f6f8fa');
			expect(getCssVar('--border')).toBe('#d0d7de');
			expect(getCssVar('--text-main')).toBe('#1f2328');
			expect(getCssVar('--text-dim')).toBe('#656d76');
			expect(getCssVar('--accent-text')).toBe('#0969da');
			expect(getCssVar('--accent-fg')).toBe('#ffffff');
			expect(getCssVar('--success')).toBe('#1a7f37');
			expect(getCssVar('--warning')).toBe('#9a6700');
			expect(getCssVar('--error')).toBe('#cf222e');
		});
	});

	describe('--accent-rgb (the accent as a bare triple)', () => {
		it('publishes the accent comma separated for the legacy rgba() form', () => {
			// Comma separated on purpose, unlike --sheen-rgb: this one feeds rules
			// written as rgba(var(--accent-rgb), a).
			renderHook(() =>
				useThemeStyles({ themeColors: DARK_COLORS, themeMode: 'dark', glossLevel: 'off' })
			);
			expect(getCssVar('--accent-rgb')).toBe('189, 147, 249');
		});

		it('tracks the accent across a theme change', () => {
			const { rerender } = renderHook(
				({ colors }) =>
					useThemeStyles({ themeColors: colors, themeMode: 'dark', glossLevel: 'off' }),
				{ initialProps: { colors: DARK_COLORS } }
			);
			expect(getCssVar('--accent-rgb')).toBe('189, 147, 249');

			rerender({ colors: LIGHT_COLORS });

			expect(getCssVar('--accent-rgb')).toBe('9, 105, 218');
		});

		it('clears the property when the palette carries a non-hex accent', () => {
			// Clearing lets every var(--accent-rgb, ...) fall back to its own
			// literal, which is a colour someone chose. Leaving the previous
			// theme's triple behind would tint the new theme with the old accent.
			const { rerender } = renderHook(
				({ colors }) =>
					useThemeStyles({ themeColors: colors, themeMode: 'dark', glossLevel: 'off' }),
				{ initialProps: { colors: DARK_COLORS } }
			);
			expect(getCssVar('--accent-rgb')).toBe('189, 147, 249');

			rerender({ colors: { ...DARK_COLORS, accent: 'rgb(200, 200, 200)' } });

			expect(getCssVar('--accent-rgb')).toBe('');
		});
	});

	describe('--sheen-rgb (the gloss light source)', () => {
		it('publishes textMain as an R G B triple, not a hex', () => {
			// The gloss rules mix it as `rgb(var(--sheen-rgb) / 7%)`, so the alpha
			// stays in index.css where the levels live and only the hue crosses.
			renderHook(() =>
				useThemeStyles({ themeColors: DARK_COLORS, themeMode: 'dark', glossLevel: 'sheen' })
			);
			expect(getCssVar('--sheen-rgb')).toBe('248 248 242');
		});

		it('tracks textMain rather than any inherited color', () => {
			// It replaced `currentColor`, which made the sheen strength depend on
			// whatever text color each chrome root happened to inherit.
			const { rerender } = renderHook(
				({ colors }) =>
					useThemeStyles({ themeColors: colors, themeMode: 'dark', glossLevel: 'sheen' }),
				{ initialProps: { colors: DARK_COLORS } }
			);
			expect(getCssVar('--sheen-rgb')).toBe('248 248 242');

			rerender({ colors: { ...DARK_COLORS, textMain: '#c5c8c6' } });

			expect(getCssVar('--sheen-rgb')).toBe('197 200 198');
		});

		it('falls back to white when the palette carries a non-hex color', () => {
			// A custom theme may use any CSS color. White is the right failure:
			// gloss is dark-theme only and every dark theme's textMain is near it.
			renderHook(() =>
				useThemeStyles({
					themeColors: { ...DARK_COLORS, textMain: 'rgb(200, 200, 200)' },
					themeMode: 'dark',
					glossLevel: 'sheen',
				})
			);
			expect(getCssVar('--sheen-rgb')).toBe('255 255 255');
		});
	});

	describe('theme attributes on <html>', () => {
		it('publishes the theme mode and the gloss level together', () => {
			renderHook(() =>
				useThemeStyles({ themeColors: DARK_COLORS, themeMode: 'dark', glossLevel: 'strong' })
			);

			expect(document.documentElement.dataset.themeMode).toBe('dark');
			expect(document.documentElement.dataset.gloss).toBe('strong');
		});

		it('updates both attributes when the theme changes', () => {
			// They are written in one effect on purpose: the gloss rules in
			// index.css opt out on light themes, so a build that updated the mode
			// without the level could paint a light theme with dark highlights.
			const { rerender } = renderHook(
				({ colors, mode }: { colors: ThemeColors; mode: 'dark' | 'light' }) =>
					useThemeStyles({ themeColors: colors, themeMode: mode, glossLevel: 'max' }),
				{ initialProps: { colors: DARK_COLORS, mode: 'dark' as 'dark' | 'light' } }
			);
			expect(document.documentElement.dataset.themeMode).toBe('dark');

			rerender({ colors: LIGHT_COLORS, mode: 'light' });

			expect(document.documentElement.dataset.themeMode).toBe('light');
			expect(document.documentElement.dataset.gloss).toBe('max');
		});

		it('writes the level verbatim when gloss is off, rather than omitting the attribute', () => {
			// `off` is a real level with no rules behind it, not an absent value.
			// Leaving the attribute unset would leave a stale level on <html>
			// after the user slid back down to Off.
			const { rerender } = renderHook(
				({ level }: { level: 'off' | 'sheen' }) =>
					useThemeStyles({ themeColors: DARK_COLORS, themeMode: 'dark', glossLevel: level }),
				{ initialProps: { level: 'sheen' as 'off' | 'sheen' } }
			);
			expect(document.documentElement.dataset.gloss).toBe('sheen');

			rerender({ level: 'off' });

			expect(document.documentElement.dataset.gloss).toBe('off');
		});
	});

	describe('return value', () => {
		it('returns an empty object (all functionality is via side effects)', () => {
			const { result } = renderHook(() =>
				useThemeStyles({ themeColors: DARK_COLORS, themeMode: 'dark', glossLevel: 'off' })
			);
			expect(result.current).toEqual({});
		});
	});
});
