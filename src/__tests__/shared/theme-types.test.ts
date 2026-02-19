/**
 * Tests for src/shared/theme-types.ts
 *
 * Tests the isValidThemeId type guard function.
 */

import { describe, it, expect } from 'vitest';
import { isValidThemeId, type ThemeColors, type ThemeId } from '../../shared/theme-types';

const BASE_THEME_COLORS: ThemeColors = {
	bgMain: '#282a36',
	bgSidebar: '#21222c',
	bgActivity: '#343746',
	border: '#44475a',
	textMain: '#f8f8f2',
	textDim: '#6272a4',
	accent: '#bd93f9',
	accentDim: 'rgba(189, 147, 249, 0.2)',
	accentText: '#ff79c6',
	accentForeground: '#282a36',
	success: '#50fa7b',
	warning: '#ffb86c',
	error: '#ff5555',
};

describe('isValidThemeId', () => {
	// Sample of valid theme IDs (not exhaustive - that would couple tests to implementation)
	const sampleValidIds = ['dracula', 'monokai', 'github-light', 'nord', 'pedurple'];

	it('should return true for valid theme IDs', () => {
		for (const id of sampleValidIds) {
			expect(isValidThemeId(id)).toBe(true);
		}
	});

	it('should return false for invalid theme IDs', () => {
		const invalidIds = ['', 'invalid', 'not-a-theme', 'Dracula', 'NORD'];
		for (const id of invalidIds) {
			expect(isValidThemeId(id)).toBe(false);
		}
	});

	it('should work as a type guard for filtering', () => {
		const mixedIds = ['dracula', 'invalid', 'nord', 'fake'];
		const validIds = mixedIds.filter(isValidThemeId);

		expect(validIds).toEqual(['dracula', 'nord']);
		// TypeScript should now know validIds is ThemeId[]
		const _typeCheck: ThemeId[] = validIds;
		expect(_typeCheck).toBe(validIds);
	});
});

describe('ThemeColors ANSI extensions', () => {
	it('supports existing themes without ANSI colors', () => {
		expect(BASE_THEME_COLORS.ansiBlack).toBeUndefined();
		expect(BASE_THEME_COLORS.selection).toBeUndefined();
	});

	it('supports optional ANSI and selection overrides', () => {
		const extendedColors: ThemeColors = {
			...BASE_THEME_COLORS,
			ansiBlack: '#282c34',
			ansiRed: '#e06c75',
			ansiGreen: '#98c379',
			ansiYellow: '#e5c07b',
			ansiBlue: '#61afef',
			ansiMagenta: '#c678dd',
			ansiCyan: '#56b6c2',
			ansiWhite: '#abb2bf',
			ansiBrightBlack: '#5c6370',
			ansiBrightRed: '#e06c75',
			ansiBrightGreen: '#98c379',
			ansiBrightYellow: '#e5c07b',
			ansiBrightBlue: '#61afef',
			ansiBrightMagenta: '#c678dd',
			ansiBrightCyan: '#56b6c2',
			ansiBrightWhite: '#ffffff',
			selection: 'rgba(97, 175, 239, 0.3)',
		};

		expect(extendedColors.ansiBrightWhite).toBe('#ffffff');
		expect(extendedColors.selection).toBe('rgba(97, 175, 239, 0.3)');
	});
});
