import { beforeEach, describe, expect, it } from 'vitest';
import {
	clampTextareaHeight,
	normalizeTextareaHeight,
	resolveTextareaHeight,
	sanitizeTextareaHeights,
} from '../../../renderer/utils/textareaSizing';

function setViewportHeight(height: number) {
	Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

describe('textareaSizing', () => {
	beforeEach(() => {
		setViewportHeight(900);
	});

	describe('normalizeTextareaHeight', () => {
		it('rounds finite positive numbers', () => {
			expect(normalizeTextareaHeight(120.4)).toBe(120);
			expect(normalizeTextareaHeight(120.6)).toBe(121);
		});

		it('rejects junk values', () => {
			for (const value of [0, -10, NaN, Infinity, '200', null, undefined, {}]) {
				expect(normalizeTextareaHeight(value)).toBeNull();
			}
		});
	});

	describe('sanitizeTextareaHeights', () => {
		it('keeps valid entries and drops the rest', () => {
			expect(
				sanitizeTextareaHeights({
					good: 240,
					rounded: 199.7,
					zero: 0,
					negative: -5,
					text: '300',
				})
			).toEqual({ good: 240, rounded: 200 });
		});

		it('returns an empty map for non-objects', () => {
			expect(sanitizeTextareaHeights(null)).toEqual({});
			expect(sanitizeTextareaHeights([240])).toEqual({});
			expect(sanitizeTextareaHeights('240')).toEqual({});
		});
	});

	describe('clampTextareaHeight', () => {
		it('honors the declared minimum', () => {
			expect(clampTextareaHeight(40, { minHeight: 100 })).toBe(100);
		});

		it('caps at the declared maximum', () => {
			expect(clampTextareaHeight(900, { minHeight: 100, maxHeight: 400 })).toBe(400);
		});

		it('caps at the viewport even without a declared maximum', () => {
			setViewportHeight(600);
			// Viewport minus padding on both sides is the tighter of the two caps.
			expect(clampTextareaHeight(5000, { minHeight: 100 })).toBe(536);
		});

		it('never returns a minimum larger than the viewport allows', () => {
			setViewportHeight(300);
			expect(clampTextareaHeight(10, { minHeight: 5000 })).toBe(236);
		});
	});

	describe('resolveTextareaHeight', () => {
		it('prefers the saved height', () => {
			expect(resolveTextareaHeight({ savedHeight: 250, defaultHeight: 100 })).toBe(250);
		});

		it('falls back to the default when nothing is saved', () => {
			expect(resolveTextareaHeight({ savedHeight: undefined, defaultHeight: 100 })).toBe(100);
		});

		it('ignores a corrupt saved height', () => {
			expect(resolveTextareaHeight({ savedHeight: -20, defaultHeight: 100 })).toBe(100);
		});

		it('returns null when nothing is saved and no default is declared', () => {
			expect(resolveTextareaHeight({ savedHeight: undefined })).toBeNull();
		});

		it('clamps a saved height that no longer fits the viewport', () => {
			setViewportHeight(500);
			expect(resolveTextareaHeight({ savedHeight: 2000, minHeight: 100 })).toBe(436);
		});
	});
});
