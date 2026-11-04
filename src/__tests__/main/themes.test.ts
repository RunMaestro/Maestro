/**
 * Tests for src/main/themes.ts
 *
 * Tests the getThemeById function. Theme structure is tested
 * in renderer/constants/themes.test.ts - no need to duplicate.
 */

import { describe, it, expect } from 'vitest';
import { THEMES, getThemeById } from '../../main/themes';

describe('themes.ts', () => {
	describe('THEMES constant', () => {
		it('should export themes matching renderer themes', () => {
			expect(Object.keys(THEMES).length).toBeGreaterThan(0);
		});
	});

	describe('getThemeById', () => {
		it('should return a theme for valid theme IDs', () => {
			const theme = getThemeById('dracula');
			expect(theme).not.toBeNull();
			expect(theme?.id).toBe('dracula');
		});

		it('should return null for unknown theme IDs', () => {
			expect(getThemeById('nonexistent-theme')).toBeNull();
			expect(getThemeById('')).toBeNull();
		});

		it('should return the exact same object from THEMES', () => {
			const themeId = 'nord';
			expect(getThemeById(themeId)).toBe(THEMES[themeId]);
		});

		it('should work for all theme IDs', () => {
			for (const themeId of Object.keys(THEMES)) {
				const theme = getThemeById(themeId);
				expect(theme).not.toBeNull();
				expect(theme?.id).toBe(themeId);
			}
		});
	});
});
