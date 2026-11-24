/**
 * The viewport preset table is read by the toolbar control, the palette, tab
 * persistence and the CLI, so the widths, the order and what counts as a preset
 * are pinned here once.
 */

import { describe, expect, it } from 'vitest';
import {
	BROWSER_VIEWPORT_PRESETS,
	BROWSER_VIEWPORT_WIDTHS,
	DEFAULT_BROWSER_VIEWPORT_PRESET,
	browserViewportLabel,
	browserViewportWidth,
	describeBrowserViewport,
	parseBrowserViewportPreset,
} from '../../shared/browserViewport';

describe('browser viewport presets', () => {
	it('lists the presets in toolbar order, and fit is both first and the default', () => {
		expect([...BROWSER_VIEWPORT_PRESETS]).toEqual(['fit', 'desktop', 'laptop', 'tablet', 'phone']);
		expect(DEFAULT_BROWSER_VIEWPORT_PRESET).toBe('fit');
	});

	it('shows a fixed preset at the width the feedback asked for', () => {
		expect(BROWSER_VIEWPORT_WIDTHS).toEqual({
			desktop: 1440,
			laptop: 1280,
			tablet: 768,
			phone: 390,
		});
		expect(browserViewportWidth('desktop')).toBe(1440);
		expect(browserViewportWidth('laptop')).toBe(1280);
		expect(browserViewportWidth('tablet')).toBe(768);
		expect(browserViewportWidth('phone')).toBe(390);
	});

	it('gives fit no width: the page takes the width of the tab', () => {
		expect(browserViewportWidth('fit')).toBeNull();
	});

	it('gives every non-fit preset a width, widest first', () => {
		const widths = BROWSER_VIEWPORT_PRESETS.flatMap((preset) => browserViewportWidth(preset) ?? []);
		expect(widths).toHaveLength(BROWSER_VIEWPORT_PRESETS.length - 1);
		expect(widths).toEqual([...widths].sort((a, b) => b - a));
	});

	describe('parseBrowserViewportPreset', () => {
		it.each([...BROWSER_VIEWPORT_PRESETS])('reads %s by name', (preset) => {
			expect(parseBrowserViewportPreset(preset)).toBe(preset);
		});

		it('ignores case and surrounding space, as a typed CLI argument needs', () => {
			expect(parseBrowserViewportPreset('Phone')).toBe('phone');
			expect(parseBrowserViewportPreset('  TABLET ')).toBe('tablet');
		});

		it.each([
			['an empty string', ''],
			['a width', '390'],
			['a number', 390],
			['a made-up name', 'wide'],
			['two names', 'fit phone'],
			['null', null],
			['undefined', undefined],
			['an object', { preset: 'phone' }],
		])('rejects %s', (_label, value) => {
			expect(parseBrowserViewportPreset(value)).toBeNull();
		});
	});

	it('labels each preset with one word', () => {
		expect(BROWSER_VIEWPORT_PRESETS.map(browserViewportLabel)).toEqual([
			'Fit',
			'Desktop',
			'Laptop',
			'Tablet',
			'Phone',
		]);
	});

	it('describes a preset with what it means', () => {
		expect(describeBrowserViewport('fit')).toBe("Fit (the tab's width)");
		expect(describeBrowserViewport('phone')).toBe('Phone (390 px wide)');
		expect(describeBrowserViewport('desktop')).toBe('Desktop (1440 px wide)');
	});
});
