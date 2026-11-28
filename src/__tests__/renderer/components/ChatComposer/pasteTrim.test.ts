import { describe, expect, it } from 'vitest';
import { clipboardHasImage } from '../../../../renderer/components/ChatComposer/pasteTrim';

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
