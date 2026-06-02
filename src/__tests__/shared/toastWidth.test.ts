import { describe, it, expect } from 'vitest';
import {
	TOAST_VIEWPORT_GUTTER,
	TOAST_WIDTHS,
	TOAST_WIDTH_DIMENSIONS,
	getToastWidthDimensions,
	isToastWidth,
	type StaticToastWidth,
	type ToastWidth,
} from '../../shared/toastWidth';

/** The fixed presets - everything except the runtime-computed 'dynamic'. */
const STATIC_WIDTHS: StaticToastWidth[] = ['small', 'medium', 'large'];

describe('toastWidth', () => {
	describe('isToastWidth', () => {
		it.each(TOAST_WIDTHS)('accepts the valid preset "%s"', (preset) => {
			expect(isToastWidth(preset)).toBe(true);
		});

		it('accepts the dynamic preset', () => {
			expect(isToastWidth('dynamic')).toBe(true);
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
		it('defines dimensions for every fixed preset', () => {
			for (const preset of STATIC_WIDTHS) {
				expect(TOAST_WIDTH_DIMENSIONS[preset]).toBeDefined();
			}
		});

		it('preserves the legacy 320-400px sizing for "small" (the default)', () => {
			expect(TOAST_WIDTH_DIMENSIONS.small).toEqual({ minWidth: 320, maxWidth: 400 });
		});

		it('scales min and max monotonically up across the fixed presets', () => {
			for (let i = 1; i < STATIC_WIDTHS.length; i++) {
				const prev = TOAST_WIDTH_DIMENSIONS[STATIC_WIDTHS[i - 1]];
				const curr = TOAST_WIDTH_DIMENSIONS[STATIC_WIDTHS[i]];
				expect(curr.minWidth).toBeGreaterThan(prev.minWidth);
				expect(curr.maxWidth).toBeGreaterThan(prev.maxWidth);
			}
		});

		it('keeps minWidth <= maxWidth for every fixed preset', () => {
			for (const preset of STATIC_WIDTHS) {
				const { minWidth, maxWidth } = TOAST_WIDTH_DIMENSIONS[preset];
				expect(minWidth).toBeLessThanOrEqual(maxWidth);
			}
		});
	});

	describe('getToastWidthDimensions', () => {
		it('returns the fixed dimensions for static presets, ignoring the panel width', () => {
			for (const preset of STATIC_WIDTHS) {
				expect(getToastWidthDimensions(preset, 999)).toEqual(TOAST_WIDTH_DIMENSIONS[preset]);
			}
		});

		it('pins both bounds to the right-panel width less the corner gutter for "dynamic"', () => {
			const expected = 384 - TOAST_VIEWPORT_GUTTER;
			expect(getToastWidthDimensions('dynamic', 384)).toEqual({
				minWidth: expected,
				maxWidth: expected,
			});
		});

		it('tracks a resized right panel for "dynamic"', () => {
			expect(getToastWidthDimensions('dynamic', 360).minWidth).toBe(360 - TOAST_VIEWPORT_GUTTER);
			expect(getToastWidthDimensions('dynamic', 640).maxWidth).toBe(640 - TOAST_VIEWPORT_GUTTER);
		});

		it('insets the dynamic width so the left edge does not overflow the panel column', () => {
			// Full panel width would push the left edge past the column by the
			// corner gutter; subtracting it keeps the toast inside the column.
			expect(getToastWidthDimensions('dynamic', 400).maxWidth).toBeLessThan(400);
		});

		it('produces an exact (non-flexible) width for "dynamic" so the toast fills the column', () => {
			const dims = getToastWidthDimensions('dynamic', 512);
			expect(dims.minWidth).toBe(dims.maxWidth);
		});

		it('never returns a negative width for an absurdly narrow panel', () => {
			expect(getToastWidthDimensions('dynamic', 8).minWidth).toBe(0);
		});
	});

	it('lists dynamic as the final width option', () => {
		const widths: readonly ToastWidth[] = TOAST_WIDTHS;
		expect(widths[widths.length - 1]).toBe('dynamic');
	});
});
