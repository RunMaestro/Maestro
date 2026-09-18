import { describe, it, expect } from 'vitest';
import { estimateLabelWidth, widestLabelWidth } from '../../../renderer/utils/labelWidth';

describe('estimateLabelWidth', () => {
	it('scales with both the character count and the font size', () => {
		const small = estimateLabelWidth('abcdefghij', { fontSizePx: 12 });
		const large = estimateLabelWidth('abcdefghij', { fontSizePx: 24 });

		expect(small).toBe(66); // 10 chars * 12px * 0.55
		expect(large).toBe(small * 2);
	});

	it('adds chrome on top of the text', () => {
		expect(estimateLabelWidth('abcdefghij', { fontSizePx: 12, chromePx: 40 })).toBe(106);
	});

	it('rounds up, so a fractional estimate never clips the label', () => {
		// 5 chars * 12 * 0.55 = 33.0 exactly; 7 chars = 46.2 and must not floor to 46.
		expect(estimateLabelWidth('abcde', { fontSizePx: 12 })).toBe(33);
		expect(estimateLabelWidth('abcdefg', { fontSizePx: 12 })).toBe(47);
	});

	it('honors a floor and a ceiling', () => {
		const options = { fontSizePx: 12, minPx: 100, maxPx: 200 };

		expect(estimateLabelWidth('a', options)).toBe(100);
		expect(estimateLabelWidth('x'.repeat(500), options)).toBe(200);
	});

	it('prefers the floor when a caller passes a floor above its ceiling', () => {
		expect(estimateLabelWidth('a', { fontSizePx: 12, minPx: 300, maxPx: 200 })).toBe(300);
	});
});

describe('widestLabelWidth', () => {
	it('sizes to the longest label, whatever its position', () => {
		const expected = estimateLabelWidth('a longer label', { fontSizePx: 12 });

		expect(widestLabelWidth(['a', 'a longer label', 'b'], { fontSizePx: 12 })).toBe(expected);
		expect(widestLabelWidth(['a longer label', 'a', 'b'], { fontSizePx: 12 })).toBe(expected);
	});

	it('falls back to chrome and the floor for an empty list', () => {
		expect(widestLabelWidth([], { fontSizePx: 12, chromePx: 40 })).toBe(40);
		expect(widestLabelWidth([], { fontSizePx: 12, chromePx: 40, minPx: 120 })).toBe(120);
	});
});
