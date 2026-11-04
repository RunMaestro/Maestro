import { describe, it, expect } from 'vitest';
import { isValidCssColor } from '../../shared/cssColor';

describe('isValidCssColor', () => {
	describe('hex colors', () => {
		it('accepts 6- and 8-digit hex', () => {
			expect(isValidCssColor('#282a36')).toBe(true);
			expect(isValidCssColor('#bd93f9')).toBe(true);
			expect(isValidCssColor('#282a36ff')).toBe(true);
		});

		it('accepts 3- and 4-digit hex', () => {
			expect(isValidCssColor('#abc')).toBe(true);
			expect(isValidCssColor('#abcd')).toBe(true);
		});

		it('rejects malformed hex', () => {
			expect(isValidCssColor('#12')).toBe(false);
			expect(isValidCssColor('#xyzxyz')).toBe(false);
			expect(isValidCssColor('282a36')).toBe(false);
		});
	});

	describe('functional notations', () => {
		it('accepts rgb() and rgba()', () => {
			expect(isValidCssColor('rgb(26, 26, 46)')).toBe(true);
			expect(isValidCssColor('rgba(189, 147, 249, 0.2)')).toBe(true);
		});

		it('accepts hsl() and hsla()', () => {
			expect(isValidCssColor('hsl(262, 83%, 58%)')).toBe(true);
			expect(isValidCssColor('hsla(262, 83%, 58%, 0.5)')).toBe(true);
		});
	});

	describe('named colors', () => {
		it('accepts CSS named colors (case-insensitive)', () => {
			expect(isValidCssColor('darkblue')).toBe(true);
			expect(isValidCssColor('rebeccapurple')).toBe(true);
			expect(isValidCssColor('Transparent')).toBe(true);
		});

		it('rejects arbitrary words that are not named colors', () => {
			expect(isValidCssColor('not-a-color')).toBe(false);
			expect(isValidCssColor('bluish')).toBe(false);
		});
	});

	describe('invalid input', () => {
		it('rejects empty and whitespace-only strings', () => {
			expect(isValidCssColor('')).toBe(false);
			expect(isValidCssColor('   ')).toBe(false);
		});

		it('rejects non-string input', () => {
			expect(isValidCssColor(null)).toBe(false);
			expect(isValidCssColor(undefined)).toBe(false);
			expect(isValidCssColor(42)).toBe(false);
		});
	});
});
