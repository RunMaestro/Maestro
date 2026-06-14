/**
 * editClipboardImage - Open the image annotator on the current clipboard image,
 * writing the edited PNG back to the clipboard on save.
 *
 * Shared by the "Edit Image from Clipboard" command-palette action and its
 * configurable hotkey (default Alt+Cmd+E) so both routes behave identically.
 * Flashes when the clipboard holds no image.
 */

import { useImageAnnotatorStore } from './imageAnnotatorStore';
import { safeClipboardReadImage, safeClipboardWriteImage } from '../../utils/clipboard';
import { notifyCenterFlash } from '../../stores/centerFlashStore';

export async function editClipboardImage(): Promise<void> {
	const dataUrl = await safeClipboardReadImage();
	if (!dataUrl) {
		notifyCenterFlash({ message: 'No image found in the clipboard.', color: 'theme' });
		return;
	}
	useImageAnnotatorStore.getState().openAnnotator(dataUrl, async (newDataUrl) => {
		const ok = await safeClipboardWriteImage(newDataUrl);
		notifyCenterFlash({
			message: ok ? 'Copied edited image to clipboard' : 'Failed to copy image to clipboard',
			color: ok ? 'green' : 'red',
		});
	});
}
