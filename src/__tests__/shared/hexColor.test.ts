import { describe, it, expect } from 'vitest';
import { extractHexColor } from '../../shared/hexColor';

describe('extractHexColor', () => {
	it('should match 6-digit hex colors', () => {
		expect(extractHexColor('#FF0000')).toBe('#FF0000');
		expect(extractHexColor('#8B3FFC')).toBe('#8B3FFC');
		expect(extractHexColor('#000000')).toBe('#000000');
	});

	it('should match 3-digit hex colors', () => {
		expect(extractHexColor('#FFF')).toBe('#FFF');
		expect(extractHexColor('#abc')).toBe('#abc');
	});

	it('should match 4-digit hex colors (RGBA shorthand)', () => {
		expect(extractHexColor('#FFFA')).toBe('#FFFA');
	});

	it('should match 8-digit hex colors (RRGGBBAA)', () => {
		expect(extractHexColor('#FF000080')).toBe('#FF000080');
	});

	it('should trim whitespace', () => {
		expect(extractHexColor(' #FF0000 ')).toBe('#FF0000');
	});

	it('should return null for non-hex content', () => {
		expect(extractHexColor('hello')).toBeNull();
		expect(extractHexColor('#GGG')).toBeNull();
		expect(extractHexColor('#12345')).toBeNull();
		expect(extractHexColor('rgb(255,0,0)')).toBeNull();
		expect(extractHexColor('#FF0000 extra')).toBeNull();
	});

	it('should handle non-string children', () => {
		expect(extractHexColor(123)).toBeNull();
		expect(extractHexColor(null)).toBeNull();
		expect(extractHexColor(undefined)).toBeNull();
	});
});
