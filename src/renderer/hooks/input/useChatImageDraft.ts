import { useCallback, useState, type RefObject } from 'react';
import {
	dragCarriesStagedImage,
	useStagedImageDnd,
} from '../../components/InputArea/components/stagedImageDrag';
import { moveStagedImage } from '../../utils/stagedImageOrder';
import { imageFilesIn, readBlobAsDataUrl } from '../../utils/imageData';

/** Shared image draft, paste, drop and reorder behavior for compact chat composers. */
export function useChatImageDraft(
	textareaRef: RefObject<HTMLTextAreaElement>,
	setError: (message: string) => void
) {
	const [images, setImages] = useState<string[]>([]);
	// Images reach the agent the way a paste into the main composer does: staged
	// here, then sent with the message to its tab.
	const stageImageFiles = useCallback(
		(files: File[]) => {
			if (files.length === 0) return;
			void Promise.all(files.map((file) => readBlobAsDataUrl(file).catch(() => null))).then(
				(read) => {
					const added = read.filter((image): image is string => image !== null);
					if (added.length < read.length) setError('Could not read an image');
					// The same image twice is staged once, as in the main composer.
					setImages((prev) => [
						...prev,
						...added.filter((image, i) => !prev.includes(image) && added.indexOf(image) === i),
					]);
				}
			);
		},
		[setError]
	);
	const reorderImages = useCallback(
		(from: number, to: number) => setImages((prev) => moveStagedImage(prev, from, to)),
		[]
	);
	const imageDnd = useStagedImageDnd(images.length, reorderImages);
	const onPaste = useCallback(
		(e: React.ClipboardEvent) => {
			const files = imageFilesIn(e.clipboardData);
			if (files.length === 0) return;
			e.preventDefault();
			stageImageFiles(files);
		},
		[stageImageFiles]
	);
	const onDragOver = useCallback((e: React.DragEvent) => {
		if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
	}, []);
	const onDrop = useCallback(
		(e: React.DragEvent) => {
			// A staged thumbnail dragged out of its strip is a reorder that missed.
			if (dragCarriesStagedImage(e.dataTransfer)) return;
			if (!Array.from(e.dataTransfer.types).includes('Files')) return;
			e.preventDefault();
			const files = imageFilesIn(e.dataTransfer);
			if (files.length === 0) {
				setError('Only images can be attached to a chat message');
				return;
			}
			stageImageFiles(files);
			textareaRef.current?.focus();
		},
		[stageImageFiles, textareaRef, setError]
	);
	return { images, setImages, stageImageFiles, imageDnd, onPaste, onDragOver, onDrop };
}
