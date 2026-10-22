/**
 * Tests for paletteHotkeyIndex - the bare digit keys that pick an annotator
 * color. The number each key maps to is the number drawn inside its swatch, so
 * the mapping has to stay 1-based and stop at the end of the palette.
 */
import { describe, it, expect } from 'vitest';
import {
	ANNOTATOR_PALETTE,
	paletteHotkeyIndex,
} from '../../../../renderer/components/ImageAnnotator/annotatorConstants';

describe('paletteHotkeyIndex', () => {
	it('maps 1 to the first swatch and the last digit to the last swatch', () => {
		expect(paletteHotkeyIndex('1')).toBe(0);
		expect(paletteHotkeyIndex(String(ANNOTATOR_PALETTE.length))).toBe(ANNOTATOR_PALETTE.length - 1);
	});

	it('ignores digits past the palette', () => {
		expect(paletteHotkeyIndex(String(ANNOTATOR_PALETTE.length + 1))).toBeNull();
	});

	it('leaves 0 to the canvas zoom reset', () => {
		expect(paletteHotkeyIndex('0')).toBeNull();
	});

	it('ignores non-digit keys', () => {
		for (const key of ['a', '+', 'Digit1', 'F1', '']) {
			expect(paletteHotkeyIndex(key)).toBeNull();
		}
	});
});
