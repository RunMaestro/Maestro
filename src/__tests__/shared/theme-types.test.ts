/**
 * Tests for src/shared/theme-types.ts
 *
 * Tests the isValidThemeId type guard function.
 */

import { describe, it, expect } from 'vitest';
import { isValidThemeId, type ThemeId } from '../../shared/theme-types';

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
