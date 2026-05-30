import { describe, expect, it, vi } from 'vitest';
import { addStagedImageIfUnique } from '../../../../../renderer/components/InputArea/utils/stagedImages';

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
