/**
 * Where a browser tab puts a page shown at a viewport preset: the viewport the
 * page sees, how far it is scaled down, and the box the scaled page fills.
 */

import { describe, expect, it } from 'vitest';
import { computeBrowserViewportBox } from '../../../renderer/utils/browserViewport';

describe('computeBrowserViewportBox', () => {
	it('has no box for fit: the page fills the tab', () => {
		expect(computeBrowserViewportBox('fit', { width: 1000, height: 600 })).toBeNull();
	});

	it('has no box before the tab has been measured', () => {
		expect(computeBrowserViewportBox('phone', { width: 0, height: 0 })).toBeNull();
		expect(computeBrowserViewportBox('phone', { width: 1000, height: 0 })).toBeNull();
		expect(computeBrowserViewportBox('phone', { width: 0, height: 600 })).toBeNull();
	});

	describe('in a tab wider than the preset', () => {
		it('keeps the page at its own size, full height, centered', () => {
			expect(computeBrowserViewportBox('phone', { width: 1000, height: 600 })).toEqual({
				width: 390,
				height: 600,
				scale: 1,
				frame: { left: 305, width: 390 },
			});
		});

		it('rounds the left edge down to a whole pixel, so the page is not resampled blurry', () => {
			expect(computeBrowserViewportBox('phone', { width: 1001, height: 600 })?.frame.left).toBe(
				305
			);
			expect(computeBrowserViewportBox('tablet', { width: 1001, height: 600 })?.frame.left).toBe(
				116
			);
		});

		it('takes the whole tab when the tab is exactly as wide as the preset', () => {
			expect(computeBrowserViewportBox('laptop', { width: 1280, height: 700 })).toEqual({
				width: 1280,
				height: 700,
				scale: 1,
				frame: { left: 0, width: 1280 },
			});
		});
	});

	describe('in a tab narrower than the preset', () => {
		it('shows the page at the preset width, scaled down to the tab', () => {
			const box = computeBrowserViewportBox('desktop', { width: 900, height: 500 });
			expect(box).toMatchObject({
				width: 1440,
				scale: 0.625,
				frame: { left: 0, width: 900 },
			});
			// The page is taller by the same factor, so the scaled page is as tall as the tab.
			expect(box?.height).toBe(800);
		});

		it('never makes the page wider than the tab', () => {
			for (const preset of ['desktop', 'laptop', 'tablet', 'phone'] as const) {
				for (const width of [280, 390, 500, 767, 1000, 1440, 1920]) {
					const box = computeBrowserViewportBox(preset, { width, height: 600 });
					expect(box?.frame.width).toBeLessThanOrEqual(width);
					expect(box!.frame.left + box!.frame.width).toBeLessThanOrEqual(width);
				}
			}
		});

		it('keeps the page exactly as tall as the ratio says, with no stray pixel from rounding the scale', () => {
			// 200 / (200 / 390) is 390.00000000000006 in floating point and would round
			// up to 391; the ratio 200 * 390 / 200 is exactly 390.
			expect(computeBrowserViewportBox('phone', { width: 200, height: 200 })?.height).toBe(390);
			// Likewise 230 / (207 / 1440) is 1600.0000000000002.
			expect(computeBrowserViewportBox('desktop', { width: 207, height: 230 })?.height).toBe(1600);
			expect(computeBrowserViewportBox('desktop', { width: 1000, height: 600 })?.height).toBe(864);
		});

		it('makes the scaled page reach the bottom edge of the tab, never fall short of it', () => {
			for (const preset of ['desktop', 'laptop', 'tablet', 'phone'] as const) {
				for (const host of [
					{ width: 280, height: 333 },
					{ width: 701, height: 487 },
					{ width: 999, height: 611 },
					{ width: 1279, height: 800 },
				]) {
					const box = computeBrowserViewportBox(preset, host);
					if (!box || box.scale === 1) continue;
					const shown = box.height * box.scale;
					expect(shown).toBeGreaterThanOrEqual(host.height - 1e-6);
					// Overshoot is under one CSS pixel of the page: the stage clips it.
					expect(shown).toBeLessThan(host.height + box.scale + 1e-6);
				}
			}
		});

		it('scales a phone page down in a tab narrower than the phone', () => {
			const box = computeBrowserViewportBox('phone', { width: 300, height: 500 });
			expect(box?.width).toBe(390);
			expect(box?.scale).toBeCloseTo(300 / 390, 10);
			expect(box?.frame).toEqual({ left: 0, width: 300 });
		});
	});
});
