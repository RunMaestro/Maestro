import { describe, it, expect } from 'vitest';
import {
	buildSlotRemap,
	moveStagedImage,
	renumberScreenshotReferences,
	screenshotReferenceLabel,
} from '../../../renderer/utils/stagedImageOrder';

describe('moveStagedImage', () => {
	it('moves an item forward using splice semantics', () => {
		expect(moveStagedImage(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
	});

	it('moves an item backward', () => {
		expect(moveStagedImage(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
	});

	it('returns a copy unchanged for no-op and out-of-range moves', () => {
		const items = ['a', 'b'];
		expect(moveStagedImage(items, 1, 1)).toEqual(['a', 'b']);
		expect(moveStagedImage(items, -1, 0)).toEqual(['a', 'b']);
		expect(moveStagedImage(items, 0, 5)).toEqual(['a', 'b']);
		expect(moveStagedImage(items, 0, 1)).not.toBe(items);
	});
});

describe('buildSlotRemap', () => {
	it('maps 1-based slots for a swap', () => {
		// [A, B] -> [B, A]: old slot 1 is now slot 2 and vice versa.
		const remap = buildSlotRemap(2, 0, 1);
		expect(remap.get(1)).toBe(2);
		expect(remap.get(2)).toBe(1);
		expect(remap.size).toBe(2);
	});

	it('omits slots the move did not disturb', () => {
		// [A, B, C, D] -> [B, A, C, D]: C and D keep their numbers.
		const remap = buildSlotRemap(4, 0, 1);
		expect(remap.has(3)).toBe(false);
		expect(remap.has(4)).toBe(false);
	});

	it('is empty for a no-op move', () => {
		expect(buildSlotRemap(3, 1, 1).size).toBe(0);
	});

	it('shifts the whole run when an item jumps to the end', () => {
		// [A, B, C] -> [B, C, A]
		const remap = buildSlotRemap(3, 0, 2);
		expect(remap.get(1)).toBe(3);
		expect(remap.get(2)).toBe(1);
		expect(remap.get(3)).toBe(2);
	});
});

describe('renumberScreenshotReferences', () => {
	it('rewrites references simultaneously rather than sequentially', () => {
		// A sequential pass would turn "1" into "2" and then back into "1".
		const remap = buildSlotRemap(2, 0, 1);
		expect(renumberScreenshotReferences('compare Screenshot 1 with Screenshot 2', remap)).toBe(
			'compare Screenshot 2 with Screenshot 1'
		);
	});

	it('preserves the writer casing and spacing', () => {
		const remap = buildSlotRemap(2, 0, 1);
		expect(renumberScreenshotReferences('screenshot 1 and SCREENSHOT  2', remap)).toBe(
			'screenshot 2 and SCREENSHOT  1'
		);
	});

	it('handles the plural form', () => {
		const remap = buildSlotRemap(2, 0, 1);
		expect(renumberScreenshotReferences('see screenshots 2', remap)).toBe('see screenshots 1');
	});

	it('leaves numbers outside the remap alone', () => {
		const remap = buildSlotRemap(4, 0, 1);
		expect(renumberScreenshotReferences('Screenshot 3 and Screenshot 9', remap)).toBe(
			'Screenshot 3 and Screenshot 9'
		);
	});

	it('does not touch other nouns that carry numbers', () => {
		const remap = buildSlotRemap(2, 0, 1);
		expect(renumberScreenshotReferences('image 1 and picture 2 and Phase 1', remap)).toBe(
			'image 1 and picture 2 and Phase 1'
		);
	});

	it('is a no-op for an empty remap or empty text', () => {
		expect(renumberScreenshotReferences('Screenshot 1', new Map())).toBe('Screenshot 1');
		expect(renumberScreenshotReferences('', buildSlotRemap(2, 0, 1))).toBe('');
	});

	it('renumbers the reference the drag affordance inserts', () => {
		const label = screenshotReferenceLabel(0);
		expect(label).toBe('Screenshot 1');
		expect(renumberScreenshotReferences(label, buildSlotRemap(3, 0, 2))).toBe('Screenshot 3');
	});
});
