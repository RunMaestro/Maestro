import { describe, expect, it } from 'vitest';
import {
	clampModalSize,
	DEFAULT_MODAL_SIZE,
	getModalMaxSize,
	normalizeModalSize,
	resolveModalSize,
	sanitizeModalSizes,
} from '../../../renderer/utils/modalSizing';

describe('modalSizing', () => {
	it('normalizes finite positive width and height values', () => {
		expect(normalizeModalSize({ width: 420.4, height: 320.6 })).toEqual({
			width: 420,
			height: 321,
		});
	});

	it('rejects invalid persisted modal sizes', () => {
		expect(normalizeModalSize(null)).toBeNull();
		expect(normalizeModalSize({ width: 400, height: 0 })).toBeNull();
		expect(normalizeModalSize({ width: Number.POSITIVE_INFINITY, height: 400 })).toBeNull();
		expect(normalizeModalSize({ width: '400', height: 300 })).toBeNull();
	});

	it('sanitizes a persisted modal size map', () => {
		expect(
			sanitizeModalSizes({
				settings: { width: 900, height: 700 },
				bad: { width: -1, height: 300 },
				alsoBad: null,
			})
		).toEqual({
			settings: { width: 900, height: 700 },
		});
	});

	it('resolves max size from the 90vw and 90vh ceiling with padding', () => {
		expect(getModalMaxSize({ viewport: { width: 1000, height: 800 } })).toEqual({
			width: 900,
			height: 720,
		});

		expect(
			getModalMaxSize({
				viewport: { width: 500, height: 400 },
				viewportPadding: 40,
			})
		).toEqual({
			width: 420,
			height: 320,
		});
	});

	it('clamps size between defaults and viewport max', () => {
		expect(
			clampModalSize({ width: 1200, height: 900 }, { viewport: { width: 1000, height: 800 } })
		).toEqual({
			width: 900,
			height: 720,
		});

		expect(
			clampModalSize({ width: 10, height: 12 }, { viewport: { width: 1000, height: 800 } })
		).toEqual({
			width: 320,
			height: 240,
		});
	});

	it('honors explicit min and max bounds before viewport clamping', () => {
		expect(
			clampModalSize(
				{ width: 700, height: 700 },
				{
					minSize: { width: 420, height: 300 },
					maxSize: { width: 640, height: 520 },
					viewport: { width: 1200, height: 900 },
				}
			)
		).toEqual({
			width: 640,
			height: 520,
		});
	});

	it('reduces minimum size when the viewport is smaller than the default minimum', () => {
		expect(
			clampModalSize(
				{ width: 100, height: 80 },
				{
					viewport: { width: 200, height: 160 },
				}
			)
		).toEqual({
			width: 136,
			height: 96,
		});
	});

	it('ignores non-finite developer-supplied maxSize bounds instead of propagating NaN', () => {
		expect(
			getModalMaxSize({
				maxSize: { width: NaN, height: -1 },
				viewport: { width: 1000, height: 800 },
			})
		).toEqual({
			width: 900,
			height: 720,
		});
	});

	it('ignores non-finite developer-supplied minSize bounds instead of propagating NaN', () => {
		expect(
			clampModalSize(
				{ width: 500, height: 400 },
				{
					minSize: { width: NaN, height: 0 },
					viewport: { width: 1000, height: 800 },
				}
			)
		).toEqual({
			width: 500,
			height: 400,
		});
	});

	it('ignores non-finite developer-supplied defaultSize bounds instead of propagating NaN', () => {
		expect(
			resolveModalSize({
				defaultSize: { width: NaN, height: Number.POSITIVE_INFINITY },
				viewport: { width: 1000, height: 800 },
			})
		).toEqual(DEFAULT_MODAL_SIZE);
	});

	it('prefers a valid saved size and falls back to defaults for invalid data', () => {
		expect(
			resolveModalSize({
				savedSize: { width: 520, height: 340 },
				defaultSize: { width: 800, height: 600 },
				viewport: { width: 1000, height: 800 },
			})
		).toEqual({
			width: 520,
			height: 340,
		});

		expect(
			resolveModalSize({
				savedSize: { width: NaN, height: 340 },
				defaultSize: { width: 800, height: 600 },
				viewport: { width: 1000, height: 800 },
			})
		).toEqual({
			width: 800,
			height: 600,
		});
	});
});
