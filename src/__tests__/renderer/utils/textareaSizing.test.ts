import { beforeEach, describe, expect, it } from 'vitest';
import {
	clampTextareaHeight,
	normalizeTextareaHeight,
	resolveTextareaHeight,
	resizeTextareaToContent,
	sanitizeTextareaHeights,
	scrollTextareaToCaretEnd,
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

describe('resizeTextareaToContent', () => {
	it('resizes to content height capped by max height', () => {
		const textarea = document.createElement('textarea');
		Object.defineProperty(textarea, 'scrollHeight', { value: 220, configurable: true });

		resizeTextareaToContent(textarea, 176);

		expect(textarea.style.height).toBe('176px');
	});

	it('resizes to exact content height below cap', () => {
		const textarea = document.createElement('textarea');
		Object.defineProperty(textarea, 'scrollHeight', { value: 80, configurable: true });

		resizeTextareaToContent(textarea, 176);

		expect(textarea.style.height).toBe('80px');
	});

	it('preserves scroll position across the auto-height toggle', () => {
		const textarea = document.createElement('textarea');
		Object.defineProperty(textarea, 'scrollHeight', { value: 300, configurable: true });
		textarea.scrollTop = 120;

		resizeTextareaToContent(textarea, 176);

		expect(textarea.scrollTop).toBe(120);
	});
});

describe('scrollTextareaToCaretEnd', () => {
	it('scrolls the textarea to the bottom when the caret is at the end', () => {
		const textarea = document.createElement('textarea');
		textarea.value = 'hello';
		textarea.scrollTop = 12;
		Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', {
			value: textarea.value.length,
			configurable: true,
		});

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(240);
	});

	it('leaves scroll untouched when the caret is mid-way through the final logical line', () => {
		const textarea = document.createElement('textarea');
		// Regression for the soft-wrap edge case: a long final logical line can wrap
		// across several visual rows past the height cap. A caret before the trailing
		// characters (e.g. an inserted mention) belongs to an earlier visual row, so
		// snapping to scrollHeight would scroll it out of view. The gate keys off the
		// true end of the value, not the final logical line, precisely to avoid that.
		textarea.value = 'first\nsecond\nlast line';
		textarea.scrollTop = 12;
		Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', {
			value: textarea.value.indexOf('last line') + 4,
			configurable: true,
		});

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(12);
	});

	it('leaves scroll untouched for mid-text typing', () => {
		const textarea = document.createElement('textarea');
		textarea.value = 'hello world';
		textarea.scrollTop = 30;
		Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', { value: 2, configurable: true });

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(30);
	});
});
