import { describe, it, expect } from 'vitest';
import {
	TOAST_WIDTHS,
	TOAST_WIDTH_DIMENSIONS,
	isToastWidth,
	type ToastWidth,
} from '../../shared/toastWidth';

describe('toastWidth', () => {
	describe('isToastWidth', () => {
		it.each(TOAST_WIDTHS)('accepts the valid preset "%s"', (preset) => {
			expect(isToastWidth(preset)).toBe(true);
		});

		it('rejects unknown strings', () => {
			expect(isToastWidth('huge')).toBe(false);
			expect(isToastWidth('')).toBe(false);
		});

		it('rejects non-string values', () => {
			expect(isToastWidth(undefined)).toBe(false);
			expect(isToastWidth(null)).toBe(false);
			expect(isToastWidth(400)).toBe(false);
			expect(isToastWidth({ minWidth: 320 })).toBe(false);
		});
	});

	describe('TOAST_WIDTH_DIMENSIONS', () => {
		it('defines dimensions for every preset', () => {
			for (const preset of TOAST_WIDTHS) {
				expect(TOAST_WIDTH_DIMENSIONS[preset]).toBeDefined();
			}
		});

		it('preserves the legacy 320–400px sizing for "small" (the default)', () => {
			expect(TOAST_WIDTH_DIMENSIONS.small).toEqual({ minWidth: 320, maxWidth: 400 });
		});

		it('scales min and max monotonically up across presets', () => {
			const order: ToastWidth[] = ['small', 'medium', 'large'];
			for (let i = 1; i < order.length; i++) {
				const prev = TOAST_WIDTH_DIMENSIONS[order[i - 1]];
				const curr = TOAST_WIDTH_DIMENSIONS[order[i]];
				expect(curr.minWidth).toBeGreaterThan(prev.minWidth);
				expect(curr.maxWidth).toBeGreaterThan(prev.maxWidth);
			}
		});

		it('keeps minWidth <= maxWidth for every preset', () => {
			for (const preset of TOAST_WIDTHS) {
				const { minWidth, maxWidth } = TOAST_WIDTH_DIMENSIONS[preset];
				expect(minWidth).toBeLessThanOrEqual(maxWidth);
			}
		});
	});
});
