/**
 * Tests for src/shared/theme-types.ts
 *
 * Tests the isValidThemeId type guard and the retired-theme resolver.
 */

import { describe, it, expect } from 'vitest';
import {
	isValidThemeId,
	resolveThemeId,
	RETIRED_THEME_IDS,
	type ThemeId,
} from '../../shared/theme-types';
import { THEMES } from '../../shared/themes';

describe('isValidThemeId', () => {
	// Sample of valid theme IDs (not exhaustive - that would couple tests to implementation)
	const sampleValidIds = ['dracula', 'monokai', 'github-light', 'nord', 'olive-nights', 'pedurple'];

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

describe('resolveThemeId', () => {
	it('passes a live theme id through untouched', () => {
		expect(resolveThemeId('nord')).toBe('nord');
		expect(resolveThemeId('winamp')).toBe('winamp');
	});

	// A user who picked a theme before it was retired still has that id on disk.
	// App.tsx looks the theme up bare, so an unmapped id renders the app unstyled.
	it('maps a retired theme id to its replacement', () => {
		expect(resolveThemeId('inquest')).toBe('dracula');
	});

	it('falls back for anything unrecognized, including non-strings', () => {
		expect(resolveThemeId('not-a-theme')).toBe('dracula');
		expect(resolveThemeId(undefined)).toBe('dracula');
		expect(resolveThemeId(null)).toBe('dracula');
		expect(resolveThemeId(42)).toBe('dracula');
		expect(resolveThemeId('not-a-theme', 'nord')).toBe('nord');
	});

	it('never maps a retired id onto another retired or missing theme', () => {
		for (const [retired, replacement] of Object.entries(RETIRED_THEME_IDS)) {
			expect(isValidThemeId(retired)).toBe(false);
			expect(THEMES[replacement]).toBeDefined();
		}
	});
});
