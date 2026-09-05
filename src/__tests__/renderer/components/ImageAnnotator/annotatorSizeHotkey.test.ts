import { describe, expect, it } from 'vitest';
import {
	nudgeSize,
	sizeHotkeyDirection,
} from '../../../../renderer/components/ImageAnnotator/annotatorSizeHotkey';
import {
	PEN_SIZE_MAX,
	PEN_SIZE_MIN,
	PEN_SIZE_STEP,
	TEXT_SIZE_MAX,
	TEXT_SIZE_MIN,
	TEXT_SIZE_STEP,
} from '../../../../renderer/components/ImageAnnotator/annotatorConstants';

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
