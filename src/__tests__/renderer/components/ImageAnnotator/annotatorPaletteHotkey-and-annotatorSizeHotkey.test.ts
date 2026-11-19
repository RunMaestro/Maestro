// Source: src/__tests__/renderer/components/ImageAnnotator/annotatorPaletteHotkey.test.ts
// Source: src/__tests__/renderer/components/ImageAnnotator/annotatorSizeHotkey.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { ANNOTATOR_PALETTE } from '../../../../renderer/components/ImageAnnotator/annotatorConstants';
import { paletteHotkeyIndex } from '../../../../renderer/components/ImageAnnotator/annotatorConstants';
import { nudgeSize } from '../../../../renderer/components/ImageAnnotator/annotatorSizeHotkey';
import { sizeHotkeyDirection } from '../../../../renderer/components/ImageAnnotator/annotatorSizeHotkey';
import { PEN_SIZE_MAX } from '../../../../renderer/components/ImageAnnotator/annotatorConstants';
import { PEN_SIZE_MIN } from '../../../../renderer/components/ImageAnnotator/annotatorConstants';
import { PEN_SIZE_STEP } from '../../../../renderer/components/ImageAnnotator/annotatorConstants';
import { TEXT_SIZE_MAX } from '../../../../renderer/components/ImageAnnotator/annotatorConstants';
import { TEXT_SIZE_MIN } from '../../../../renderer/components/ImageAnnotator/annotatorConstants';
import { TEXT_SIZE_STEP } from '../../../../renderer/components/ImageAnnotator/annotatorConstants';
describeSourceSuite('annotatorPaletteHotkey', () => {
	describe('paletteHotkeyIndex', () => {
		it('maps 1 to the first swatch and the last digit to the last swatch', () => {
			expect(paletteHotkeyIndex('1')).toBe(0);
			expect(paletteHotkeyIndex(String(ANNOTATOR_PALETTE.length))).toBe(
				ANNOTATOR_PALETTE.length - 1
			);
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
});
describeSourceSuite('annotatorSizeHotkey', () => {
	describe('sizeHotkeyDirection', () => {
		it('grows on + and its unshifted face', () => {
			expect(sizeHotkeyDirection('+')).toBe(1);
			expect(sizeHotkeyDirection('=')).toBe(1);
		});

		it('shrinks on - and its shifted face', () => {
			expect(sizeHotkeyDirection('-')).toBe(-1);
			expect(sizeHotkeyDirection('_')).toBe(-1);
		});

		it('ignores every other key', () => {
			for (const key of ['a', '0', 'ArrowUp', 'Shift', 'f', ' ']) {
				expect(sizeHotkeyDirection(key)).toBeNull();
			}
		});
	});

	describe('nudgeSize', () => {
		it('steps in the given direction', () => {
			expect(nudgeSize(10, 1, PEN_SIZE_STEP, PEN_SIZE_MIN, PEN_SIZE_MAX)).toBe(10 + PEN_SIZE_STEP);
			expect(nudgeSize(10, -1, PEN_SIZE_STEP, PEN_SIZE_MIN, PEN_SIZE_MAX)).toBe(10 - PEN_SIZE_STEP);
			expect(nudgeSize(24, 1, TEXT_SIZE_STEP, TEXT_SIZE_MIN, TEXT_SIZE_MAX)).toBe(
				24 + TEXT_SIZE_STEP
			);
		});

		it('clamps to the slider bounds instead of running past them', () => {
			expect(nudgeSize(PEN_SIZE_MAX, 1, PEN_SIZE_STEP, PEN_SIZE_MIN, PEN_SIZE_MAX)).toBe(
				PEN_SIZE_MAX
			);
			expect(nudgeSize(PEN_SIZE_MIN, -1, PEN_SIZE_STEP, PEN_SIZE_MIN, PEN_SIZE_MAX)).toBe(
				PEN_SIZE_MIN
			);
			expect(nudgeSize(TEXT_SIZE_MAX, 1, TEXT_SIZE_STEP, TEXT_SIZE_MIN, TEXT_SIZE_MAX)).toBe(
				TEXT_SIZE_MAX
			);
			expect(nudgeSize(TEXT_SIZE_MIN, -1, TEXT_SIZE_STEP, TEXT_SIZE_MIN, TEXT_SIZE_MAX)).toBe(
				TEXT_SIZE_MIN
			);
		});

		it('pulls an out-of-range value back inside the bounds', () => {
			expect(nudgeSize(500, 1, PEN_SIZE_STEP, PEN_SIZE_MIN, PEN_SIZE_MAX)).toBe(PEN_SIZE_MAX);
			expect(nudgeSize(-5, -1, PEN_SIZE_STEP, PEN_SIZE_MIN, PEN_SIZE_MAX)).toBe(PEN_SIZE_MIN);
		});
	});
});
