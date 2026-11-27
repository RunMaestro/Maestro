import { createRef, type DragEvent } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useChatImageDraft } from '../../../renderer/hooks/input/useChatImageDraft';
import * as imageData from '../../../renderer/utils/imageData';
import { STAGED_IMAGE_MIME } from '../../../renderer/components/InputArea/components/stagedImageDrag';

afterEach(() => vi.restoreAllMocks());

describe('useChatImageDraft', () => {
	it('keeps readable images when another file fails and reports the failure', async () => {
		vi.spyOn(imageData, 'readBlobAsDataUrl')
			.mockResolvedValueOnce('data:image/png;base64,first')
			.mockRejectedValueOnce(new Error('Unreadable file'));
		const setError = vi.fn();
		const { result } = renderHook(() =>
			useChatImageDraft(createRef<HTMLTextAreaElement>(), setError)
		);

		await act(async () => {
			result.current.stageImageFiles([
				new File(['a'], 'first.png', { type: 'image/png' }),
				new File(['b'], 'broken.png', { type: 'image/png' }),
			]);
		});

		expect(result.current.images).toEqual(['data:image/png;base64,first']);
		expect(setError).toHaveBeenCalledWith('Could not read an image');
	});

	it('deduplicates images across file batches that finish together', async () => {
		vi.spyOn(imageData, 'readBlobAsDataUrl').mockResolvedValue('data:image/png;base64,same');
		const { result } = renderHook(() =>
			useChatImageDraft(createRef<HTMLTextAreaElement>(), vi.fn())
		);
		const image = new File(['a'], 'same.png', { type: 'image/png' });

		await act(async () => {
			result.current.stageImageFiles([image, image]);
			result.current.stageImageFiles([image]);
		});

		expect(result.current.images).toEqual(['data:image/png;base64,same']);
	});

	it('leaves a staged-image drag to the reorder control instead of attaching it again', () => {
		const readImage = vi.spyOn(imageData, 'readBlobAsDataUrl');
		const setError = vi.fn();
		const { result } = renderHook(() =>
			useChatImageDraft(createRef<HTMLTextAreaElement>(), setError)
		);
		const preventDefault = vi.fn();

		act(() => {
			result.current.onDrop({
				dataTransfer: {
					types: [STAGED_IMAGE_MIME, 'Files'],
					files: [new File(['a'], 'same.png', { type: 'image/png' })],
				},
				preventDefault,
			} as unknown as DragEvent);
		});

		expect(readImage).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
		expect(setError).not.toHaveBeenCalled();
		expect(result.current.images).toEqual([]);
	});
});
