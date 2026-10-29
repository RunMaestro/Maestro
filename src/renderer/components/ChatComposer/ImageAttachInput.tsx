/**
 * ImageAttachInput - the hidden `<input type="file">` behind a composer's
 * Attach Image button, and the read that stages what the user picked.
 *
 * Shared by the AI composer and the Group Chat composer. The attach button
 * reaches the input through the forwarded ref, never by element id: a surface
 * that draws its button in two places (the AI toolbar's phone and desktop rows)
 * still owns exactly one input, and two composers on screen cannot collide on
 * an id. `id` is accepted only as a stable hook for tests.
 */

import { forwardRef, type Dispatch, type SetStateAction } from 'react';
import { addStagedImageIfUnique } from '../InputArea/utils/stagedImages';
import { captureException } from '../../utils/sentry';

export interface StageImageFilesOptions {
	setStagedImages: Dispatch<SetStateAction<string[]>>;
	showFlashNotification?: (message: string) => void;
	/** Names the surface in error reports (`extra.component`). */
	reportComponent: string;
	/**
	 * Refuses a file before it is read. Return the message to flash, or null to
	 * accept it. Without it every picked file is read.
	 */
	checkFile?: (file: File) => string | null;
}

/**
 * Read each picked file as a data URL and stage it, skipping a duplicate with
 * the shared "Duplicate image ignored" flash. A read that fails or is aborted
 * is reported and flashed rather than vanishing silently.
 */
export function stageImageFiles(files: File[], options: StageImageFilesOptions): void {
	const { setStagedImages, showFlashNotification, reportComponent, checkFile } = options;
	files.forEach((file) => {
		const refusal = checkFile?.(file);
		if (refusal) {
			showFlashNotification?.(refusal);
			return;
		}
		const reader = new FileReader();
		reader.onload = (event) => {
			if (event.target?.result) {
				const imageData = event.target.result as string;
				setStagedImages((prev) => addStagedImageIfUnique(prev, imageData, showFlashNotification));
			}
		};
		reader.onerror = (event) => {
			captureException(reader.error ?? event, {
				extra: {
					component: reportComponent,
					action: 'attachImage.readError',
					fileName: file.name,
					fileType: file.type,
					fileSize: file.size,
				},
			});
			showFlashNotification?.('Failed to attach image');
		};
		reader.onabort = (event) => {
			captureException(new Error('Image attachment read aborted'), {
				extra: {
					component: reportComponent,
					action: 'attachImage.readAbort',
					fileName: file.name,
					fileType: file.type,
					fileSize: file.size,
					eventType: event.type,
				},
			});
			showFlashNotification?.('Image attachment canceled');
		};
		reader.readAsDataURL(file);
	});
}

export interface ImageAttachInputProps extends StageImageFilesOptions {
	id?: string;
}

export const ImageAttachInput = forwardRef<HTMLInputElement, ImageAttachInputProps>(
	function ImageAttachInput({ id, ...options }, ref) {
		return (
			<input
				ref={ref}
				id={id}
				type="file"
				accept="image/*"
				multiple
				className="hidden"
				onChange={(e) => {
					stageImageFiles(Array.from(e.target.files || []), options);
					e.target.value = '';
				}}
			/>
		);
	}
);
