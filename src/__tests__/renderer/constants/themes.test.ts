import { describe, it, expect } from 'vitest';
import { DARK_ANSI_COLORS, LIGHT_ANSI_COLORS, THEMES } from '../../../renderer/constants/themes';
import type { ThemeColors } from '../../../shared/theme-types';
import { isValidThemeId } from '../../../shared/theme-types';

/**
 * Tests for the THEMES constant
 *
 * These tests verify structural integrity of the themes object,
 * not specific color values (which change during design iterations).
 */

// Required color properties that every theme must have
const REQUIRED_COLORS: (keyof ThemeColors)[] = [
	'bgMain',
	'bgSidebar',
	'bgActivity',
	'border',
	'textMain',
	'textDim',
	'accent',
	'accentDim',
	'accentText',
	'accentForeground',
	'success',
	'warning',
	'error',
];

const REQUIRED_ANSI_COLORS: (keyof ThemeColors)[] = [
	'ansiBlack',
	'ansiRed',
	'ansiGreen',
	'ansiYellow',
	'ansiBlue',
	'ansiMagenta',
	'ansiCyan',
	'ansiWhite',
	'ansiBrightBlack',
	'ansiBrightRed',
	'ansiBrightGreen',
	'ansiBrightYellow',
	'ansiBrightBlue',
	'ansiBrightMagenta',
	'ansiBrightCyan',
	'ansiBrightWhite',
	'selection',
];

// Hex color regex
const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{6})$/;
const RGBA_COLOR_REGEX =
	/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+))?\s*\)$/;

function isValidCssColor(color: string): boolean {
	return HEX_COLOR_REGEX.test(color) || RGBA_COLOR_REGEX.test(color);
}

describe('THEMES constant', () => {
	const themeIds = Object.keys(THEMES);
	const themes = Object.values(THEMES);

	describe('structure', () => {
		it('should contain at least one theme', () => {
			expect(themeIds.length).toBeGreaterThan(0);
		});

		it('should have valid theme IDs matching isValidThemeId', () => {
			for (const key of themeIds) {
				expect(isValidThemeId(key)).toBe(true);
			}
		});

		it('should have exactly 17 themes (sync check with ThemeId type)', () => {
			// This count should match the number of IDs in ThemeId union type.
			// If a new theme is added to THEMES without updating ThemeId, TypeScript errors.
			// If ThemeId is updated without adding to isValidThemeId array, other tests fail.
			// This test serves as an explicit reminder when themes are added/removed.
			expect(themeIds.length).toBe(17);
		});

		it('should have theme.id matching its key', () => {
			for (const [key, theme] of Object.entries(THEMES)) {
				expect(theme.id).toBe(key);
			}
		});

		it('should have unique theme names', () => {
			const names = themes.map((t) => t.name);
			expect(new Set(names).size).toBe(names.length);
		});

		it('should have valid mode for each theme', () => {
			for (const theme of themes) {
				expect(['light', 'dark', 'vibe']).toContain(theme.mode);
			}
		});
	});

	describe('color properties', () => {
		it('should have all required color properties', () => {
			for (const theme of themes) {
				for (const colorKey of REQUIRED_COLORS) {
					expect(theme.colors[colorKey]).toBeDefined();
				}
			}
		});

		it('should include ANSI color overrides for every theme', () => {
			for (const theme of themes) {
				for (const colorKey of REQUIRED_ANSI_COLORS) {
					expect(theme.colors[colorKey], `${theme.id}.${colorKey} should be defined`).toBeDefined();
				}
			}
		});

		it('should have valid CSS color values', () => {
			for (const theme of themes) {
				for (const [colorName, colorValue] of Object.entries(theme.colors)) {
					expect(
						isValidCssColor(colorValue),
						`${theme.id}.${colorName}: "${colorValue}" is not a valid CSS color`
					).toBe(true);
				}
			}
		});

		it('should have accentDim as rgba with transparency', () => {
			for (const theme of themes) {
				expect(theme.colors.accentDim.startsWith('rgba(')).toBe(true);
			}
		});
	});

	describe('theme modes', () => {
		it('should have at least one dark theme', () => {
			expect(themes.some((t) => t.mode === 'dark')).toBe(true);
		});

		it('should have at least one light theme', () => {
			expect(themes.some((t) => t.mode === 'light')).toBe(true);
		});
	});

	describe('ANSI palette defaults', () => {
		it('should define all required dark ANSI colors', () => {
			for (const colorKey of REQUIRED_ANSI_COLORS) {
				expect(DARK_ANSI_COLORS[colorKey]).toBeDefined();
				expect(isValidCssColor(DARK_ANSI_COLORS[colorKey] as string)).toBe(true);
			}
		});

		it('should define all required light ANSI colors', () => {
			for (const colorKey of REQUIRED_ANSI_COLORS) {
				expect(LIGHT_ANSI_COLORS[colorKey]).toBeDefined();
				expect(isValidCssColor(LIGHT_ANSI_COLORS[colorKey] as string)).toBe(true);
			}
		});

		it('should use distinctive ANSI palettes for selected dark themes', () => {
			expect(THEMES.dracula.colors.ansiBlue).toBe('#bd93f9');
			expect(THEMES.dracula.colors.ansiMagenta).toBe('#ff79c6');
			expect(THEMES.dracula.colors.selection).toBe('rgba(189, 147, 249, 0.3)');

			expect(THEMES.nord.colors.ansiBlue).toBe('#81a1c1');
			expect(THEMES.nord.colors.ansiBrightCyan).toBe('#8fbcbb');
			expect(THEMES.nord.colors.selection).toBe('rgba(136, 192, 208, 0.3)');

			expect(THEMES['gruvbox-dark'].colors.ansiBlue).toBe('#458588');
			expect(THEMES['gruvbox-dark'].colors.ansiBrightGreen).toBe('#b8bb26');
			expect(THEMES['gruvbox-dark'].colors.selection).toBe('rgba(69, 133, 136, 0.3)');
		});

		it('should keep distinctive ANSI palettes separate from generic dark defaults', () => {
			expect(THEMES.dracula.colors.ansiBlue).not.toBe(DARK_ANSI_COLORS.ansiBlue);
			expect(THEMES.nord.colors.ansiBlue).not.toBe(DARK_ANSI_COLORS.ansiBlue);
			expect(THEMES['gruvbox-dark'].colors.ansiBlue).not.toBe(DARK_ANSI_COLORS.ansiBlue);
		});
	});
});
