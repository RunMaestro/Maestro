/**
 * Tests for editClipboardImage: the shared entry point behind the
 * "Edit Image from Clipboard" command and its hotkey. Covers the no-image
 * flash branch and the open + save-callback flow (success and failure).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadImage = vi.fn();
const mockWriteImage = vi.fn();
vi.mock('../../../../renderer/utils/clipboard', () => ({
	safeClipboardReadImage: (...args: unknown[]) => mockReadImage(...args),
	safeClipboardWriteImage: (...args: unknown[]) => mockWriteImage(...args),
}));

const mockFlash = vi.fn();
vi.mock('../../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: (...args: unknown[]) => mockFlash(...args),
}));

const mockOpenAnnotator = vi.fn();
vi.mock('../../../../renderer/components/ImageAnnotator/imageAnnotatorStore', () => ({
	useImageAnnotatorStore: { getState: () => ({ openAnnotator: mockOpenAnnotator }) },
}));

import { editClipboardImage } from '../../../../renderer/components/ImageAnnotator/editClipboardImage';

type SaveCallback = (dataUrl: string) => Promise<void>;

describe('editClipboardImage', () => {
	beforeEach(() => {
		mockReadImage.mockReset();
		mockWriteImage.mockReset();
		mockFlash.mockReset();
		mockOpenAnnotator.mockReset();
	});

	it('flashes and skips the annotator when the clipboard has no image', async () => {
		mockReadImage.mockResolvedValue(null);

		await editClipboardImage();

		expect(mockFlash).toHaveBeenCalledWith({
			message: 'No image found in the clipboard.',
			color: 'theme',
		});
		expect(mockOpenAnnotator).not.toHaveBeenCalled();
	});

	it('opens the annotator on the current clipboard image', async () => {
		mockReadImage.mockResolvedValue('data:image/png;base64,AAA');

		await editClipboardImage();

		expect(mockOpenAnnotator).toHaveBeenCalledTimes(1);
		expect(mockOpenAnnotator.mock.calls[0][0]).toBe('data:image/png;base64,AAA');
	});

	it('writes the edited image back and flashes success on save', async () => {
		mockReadImage.mockResolvedValue('data:image/png;base64,AAA');
		mockWriteImage.mockResolvedValue(true);

		await editClipboardImage();
		const onSave = mockOpenAnnotator.mock.calls[0][1] as SaveCallback;
		await onSave('data:image/png;base64,BBB');

		expect(mockWriteImage).toHaveBeenCalledWith('data:image/png;base64,BBB');
		expect(mockFlash).toHaveBeenCalledWith({
			message: 'Copied edited image to clipboard',
			color: 'green',
		});
	});

	it('flashes failure when writing the edited image back fails', async () => {
		mockReadImage.mockResolvedValue('data:image/png;base64,AAA');
		mockWriteImage.mockResolvedValue(false);

		await editClipboardImage();
		const onSave = mockOpenAnnotator.mock.calls[0][1] as SaveCallback;
		await onSave('data:image/png;base64,BBB');

		expect(mockFlash).toHaveBeenCalledWith({
			message: 'Failed to copy image to clipboard',
			color: 'red',
		});
	});
});
