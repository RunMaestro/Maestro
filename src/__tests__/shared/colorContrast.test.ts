import { describe, it, expect } from 'vitest';
import {
	AA_CONTRAST,
	AA_LARGE_CONTRAST,
	adjustBrightness,
	blendColors,
	contrastRatio,
	hexToRgb,
	isReadableOn,
	readableTextOn,
	relativeLuminance,
	transparentize,
} from '../../shared/colorContrast';

describe('colorContrast', () => {
	describe('hexToRgb', () => {
		it('parses 6-digit hex with and without the leading hash', () => {
			expect(hexToRgb('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
			expect(hexToRgb('ff8000')).toEqual({ r: 255, g: 128, b: 0 });
		});

		it('returns null for forms it cannot measure', () => {
			expect(hexToRgb('#fff')).toBeNull();
			expect(hexToRgb('rgb(255, 128, 0)')).toBeNull();
			expect(hexToRgb('rebeccapurple')).toBeNull();
		});
	});

	describe('relativeLuminance', () => {
		it('anchors black at 0 and white at 1', () => {
			expect(relativeLuminance('#000000')).toBe(0);
			expect(relativeLuminance('#ffffff')).toBe(1);
		});

		it('returns null for unparseable colors', () => {
			expect(relativeLuminance('not-a-color')).toBeNull();
		});
	});

	describe('contrastRatio', () => {
		it('reports 21:1 for black on white and 1:1 for a color on itself', () => {
			expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
			expect(contrastRatio('#bd93f9', '#bd93f9')).toBeCloseTo(1, 5);
		});

		it('is symmetric', () => {
			expect(contrastRatio('#282a36', '#f8f8f2')).toBeCloseTo(
				contrastRatio('#f8f8f2', '#282a36'),
				10
			);
		});

		it('treats an unmeasurable color as passing rather than guessing', () => {
			// A custom theme may ship rgb()/hsl()/named colors. We must not
			// "correct" a color we cannot actually evaluate.
			expect(contrastRatio('var(--whatever)', '#000000')).toBe(21);
		});
	});

	describe('adjustBrightness / blendColors / transparentize', () => {
		it('clamps at both ends of the channel range', () => {
			expect(adjustBrightness('#ffffff', 50)).toBe('#ffffff');
			expect(adjustBrightness('#000000', -50)).toBe('#000000');
		});

		it('leaves unparseable colors untouched', () => {
			expect(adjustBrightness('teal', 20)).toBe('teal');
			expect(blendColors('teal', '#ffffff', 0.5)).toBe('teal');
		});

		it('blends toward the second color by ratio', () => {
			expect(blendColors('#000000', '#ffffff', 0)).toBe('#000000');
			expect(blendColors('#000000', '#ffffff', 1)).toBe('#ffffff');
			expect(blendColors('#000000', '#ffffff', 0.5)).toBe('#808080');
		});

		it('flattens a tint over a background', () => {
			// 20% white over black is the same as blending black -> white at 0.2.
			expect(transparentize('#ffffff', '#000000', 0.2)).toBe(
				blendColors('#000000', '#ffffff', 0.2)
			);
		});
	});

	describe('readableTextOn', () => {
		it('returns the preferred color untouched when it already clears AA', () => {
			// Dracula foreground on Dracula background.
			expect(readableTextOn('#f8f8f2', ['#282a36'])).toBe('#f8f8f2');
		});

		it('is a no-op when there are no backgrounds to measure against', () => {
			expect(readableTextOn('#808080', [])).toBe('#808080');
		});

		it('rescues text placed on a near-identical background', () => {
			// The reported bug: near-white text on a near-white fill.
			const rescued = readableTextOn('#f8f8f2', ['#f2f2f2']);
			expect(contrastRatio(rescued, '#f2f2f2')).toBeGreaterThanOrEqual(AA_CONTRAST);
		});

		it('clears AA against every background, not just the first', () => {
			const backgrounds = ['#282a36', '#3a3f52', '#4a4f66'];
			const fg = readableTextOn('#6272a4', backgrounds);
			expect(isReadableOn(fg, backgrounds)).toBe(true);
		});

		it('nudges the theme color instead of snapping to pure black or white', () => {
			const rescued = readableTextOn('#839496', ['#7a8a8a']);
			expect(rescued).not.toBe('#ffffff');
			expect(rescued).not.toBe('#000000');
			expect(contrastRatio(rescued, '#7a8a8a')).toBeGreaterThanOrEqual(AA_CONTRAST);
		});

		it('falls back to the better endpoint when backgrounds span both extremes', () => {
			// No single color can clear AA against both near-black and near-white.
			const fg = readableTextOn('#808080', ['#111111', '#eeeeee']);
			expect(['#ffffff', '#000000']).toContain(fg);
		});

		it('honors a custom threshold', () => {
			// Large-text AA (3:1) accepts a pairing that normal-text AA rejects.
			const bg = '#8a8a8a';
			const preferred = '#ffffff';
			expect(contrastRatio(preferred, bg)).toBeGreaterThan(AA_LARGE_CONTRAST);
			expect(contrastRatio(preferred, bg)).toBeLessThan(AA_CONTRAST);
			expect(readableTextOn(preferred, [bg], AA_LARGE_CONTRAST)).toBe(preferred);
			expect(readableTextOn(preferred, [bg])).not.toBe(preferred);
		});
	});
});
