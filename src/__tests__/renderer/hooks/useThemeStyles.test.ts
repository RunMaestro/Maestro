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
};

const LIGHT_COLORS: ThemeColors = {
	accent: '#0969da',
	border: '#d0d7de',
	textDim: '#656d76',
	bgActivity: '#f6f8fa',
};

function getCssVar(name: string): string {
	return document.documentElement.style.getPropertyValue(name);
}

describe('useThemeStyles', () => {
	beforeEach(() => {
		// Clean slate - clear any previously set vars from other tests.
		const root = document.documentElement.style;
		root.removeProperty('--accent-color');
		root.removeProperty('--highlight-color');
		root.removeProperty('--scrollbar-thumb');
		root.removeProperty('--scrollbar-thumb-hover');
		root.removeProperty('--scrollbar-thumb-active');
		root.removeProperty('--scrollbar-track');
	});

	afterEach(() => {
		// Same cleanup, in case a test errored before the next beforeEach.
		const root = document.documentElement.style;
		root.removeProperty('--accent-color');
		root.removeProperty('--highlight-color');
		root.removeProperty('--scrollbar-thumb');
		root.removeProperty('--scrollbar-thumb-hover');
		root.removeProperty('--scrollbar-thumb-active');
		root.removeProperty('--scrollbar-track');
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
