import { describe, it, expect } from 'vitest';
import { clampFontScale, clampScale, FONT_SCALE_RANGE, stepScale } from '../../shared/scaleRange';

describe('scaleRange', () => {
	it('clamps into the range and rounds away float drift', () => {
		expect(clampScale(1.0000000000000002, FONT_SCALE_RANGE)).toBe(1);
		expect(clampScale(5, FONT_SCALE_RANGE)).toBe(2);
		expect(clampScale(0.1, FONT_SCALE_RANGE)).toBe(0.7);
		expect(clampScale(NaN, FONT_SCALE_RANGE)).toBe(1);
	});

	it('steps one increment, stopping at the ends', () => {
		expect(stepScale(1, 1, FONT_SCALE_RANGE)).toBe(1.1);
		expect(stepScale(1.1, 1, FONT_SCALE_RANGE)).toBe(1.2);
		expect(stepScale(2, 1, FONT_SCALE_RANGE)).toBe(2);
		expect(stepScale(0.7, -1, FONT_SCALE_RANGE)).toBe(0.7);
	});

	it('clampFontScale uses the text zoom range', () => {
		expect(clampFontScale(1.234)).toBe(1.23);
		expect(clampFontScale(3)).toBe(2);
	});
});
