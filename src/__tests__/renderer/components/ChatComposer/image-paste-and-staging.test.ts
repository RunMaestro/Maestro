// Source: src/__tests__/renderer/components/ChatComposer/pasteTrim.test.ts
// Source: src/__tests__/renderer/components/InputArea/utils/stagedImages.test.ts
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { clipboardHasImage } from '../../../../renderer/components/ChatComposer/pasteTrim';
import { vi } from 'vitest';
import { addStagedImageIfUnique } from '../../../../renderer/components/InputArea/utils/stagedImages';
describe('pasteTrim', () => {
	function clipboard(text: string, types: string[] = ['text/plain']) {
		return {
			items: types.map((type) => ({ type })),
			getData: (format: string) => (format === 'text/plain' ? text : ''),
		} as unknown as DataTransfer;
	}

	describe('clipboardHasImage', () => {
		it('is true when any item is an image', () => {
			expect(clipboardHasImage(clipboard('', ['text/plain', 'image/png']))).toBe(true);
		});

		it('is false for a text-only paste', () => {
			expect(clipboardHasImage(clipboard('hi'))).toBe(false);
		});
	});
});
describe('stagedImages', () => {
	describe('InputArea stagedImages util', () => {
		it('adds unique image data', () => {
			expect(addStagedImageIfUnique(['a'], 'b')).toEqual(['a', 'b']);
		});

		it('keeps duplicate images and notifies', () => {
			const notify = vi.fn();

			expect(addStagedImageIfUnique(['a'], 'a', notify)).toEqual(['a']);
			expect(notify).toHaveBeenCalledWith('Duplicate image ignored');
		});
	});
});
