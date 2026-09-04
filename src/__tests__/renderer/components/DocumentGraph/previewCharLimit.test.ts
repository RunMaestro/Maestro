/**
 * The Document Graph's preview-length ladder, behind the `P` shortcut.
 *
 * The rule worth pinning is that `0` is a real mode ("previews off", nodes draw
 * as filename pills) rather than an invalid length to clamp away. Anything that
 * treated it as a floor violation would silently snap the graph back to full
 * cards - on every launch, since the value round-trips through settings.
 */

import { describe, expect, it } from 'vitest';
import {
	clampPreviewCharLimit,
	formatPreviewCharLimit,
	isPreviewOff,
	nextPreviewCharLimit,
	PREVIEW_CHAR_LIMIT_CYCLE,
	PREVIEW_CHAR_LIMIT_MAX,
	PREVIEW_CHAR_LIMIT_OFF,
} from '../../../../renderer/components/DocumentGraph/previewCharLimit';

describe('nextPreviewCharLimit', () => {
	it('lengthens the preview one stop per step', () => {
		expect(nextPreviewCharLimit(PREVIEW_CHAR_LIMIT_OFF)).toBe(50);
		expect(nextPreviewCharLimit(50)).toBe(100);
		expect(nextPreviewCharLimit(100)).toBe(200);
	});

	it('wraps from the longest preview back to Off', () => {
		expect(nextPreviewCharLimit(PREVIEW_CHAR_LIMIT_MAX)).toBe(PREVIEW_CHAR_LIMIT_OFF);
	});

	it('completes a full cycle back to where it started', () => {
		let limit = PREVIEW_CHAR_LIMIT_OFF;
		const seen = [limit];
		for (let i = 0; i < PREVIEW_CHAR_LIMIT_CYCLE.length - 1; i++) {
			limit = nextPreviewCharLimit(limit);
			seen.push(limit);
		}
		expect(seen).toEqual([...PREVIEW_CHAR_LIMIT_CYCLE]);
		expect(nextPreviewCharLimit(limit)).toBe(PREVIEW_CHAR_LIMIT_OFF);
	});

	it('advances a between-stops slider value forwards, not backwards', () => {
		// The slider steps by 50, so values the cycle does not list are reachable.
		expect(nextPreviewCharLimit(150)).toBe(200);
		expect(nextPreviewCharLimit(450)).toBe(500);
	});

	it('recovers from an out-of-range or non-numeric limit', () => {
		expect(nextPreviewCharLimit(-40)).toBe(50);
		expect(nextPreviewCharLimit(9999)).toBe(PREVIEW_CHAR_LIMIT_OFF);
		expect(nextPreviewCharLimit(Number.NaN)).toBe(PREVIEW_CHAR_LIMIT_OFF);
	});
});

describe('clampPreviewCharLimit', () => {
	it('keeps Off rather than treating 0 as a floor violation', () => {
		expect(clampPreviewCharLimit(0)).toBe(PREVIEW_CHAR_LIMIT_OFF);
		expect(clampPreviewCharLimit(-10)).toBe(PREVIEW_CHAR_LIMIT_OFF);
	});

	it('caps at the longest preview the slider offers', () => {
		expect(clampPreviewCharLimit(9999)).toBe(PREVIEW_CHAR_LIMIT_MAX);
		expect(clampPreviewCharLimit(250)).toBe(250);
	});
});

describe('isPreviewOff', () => {
	it('is true only at or below the sentinel', () => {
		expect(isPreviewOff(0)).toBe(true);
		expect(isPreviewOff(-1)).toBe(true);
		expect(isPreviewOff(50)).toBe(false);
		expect(isPreviewOff(Number.NaN)).toBe(true);
	});
});

describe('formatPreviewCharLimit', () => {
	it('names the sentinel rather than printing 0', () => {
		expect(formatPreviewCharLimit(PREVIEW_CHAR_LIMIT_OFF)).toBe('Off');
		expect(formatPreviewCharLimit(200)).toBe('200');
	});
});
