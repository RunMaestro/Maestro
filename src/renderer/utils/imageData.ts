/**
 * imageData - read pasted or dropped images as data URLs, and shrink them.
 *
 * A composer stages an image as a data URL: that is what a queued message
 * carries and what the main process relocates into the image store. These are
 * the steps every composer repeats to get one from a paste or a drop.
 */

import { loadImageElement } from './loadImage';

/** Read a Blob (a pasted or dropped file) as a `data:` URL. */
export function readBlobAsDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'));
		reader.readAsDataURL(blob);
	});
}

/**
 * The image files a paste or a drop carries, in order. Clipboard data lists a
 * pasted image under `items`; a drop lists its files under `files` as well.
 */
export function imageFilesIn(transfer: DataTransfer | null): File[] {
	if (!transfer) return [];
	const fromItems = Array.from(transfer.items ?? [])
		.filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
		.map((item) => item.getAsFile())
		.filter((file): file is File => file !== null);
	if (fromItems.length > 0) return fromItems;
	return Array.from(transfer.files ?? []).filter((file) => file.type.startsWith('image/'));
}

/**
 * A copy of an image no larger than `maxEdge` on its longer side, as a data
 * URL. An image already that small, or one the canvas cannot draw, comes back
 * as it was: a preview that is too big is better than none.
 */
export async function downscaleImageDataUrl(src: string, maxEdge: number): Promise<string> {
	const img = await loadImageElement(src);
	const longest = Math.max(img.naturalWidth, img.naturalHeight);
	if (longest <= maxEdge || longest === 0) return src;
	const scale = maxEdge / longest;
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
	canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
	const ctx = canvas.getContext('2d');
	if (!ctx) return src;
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	// WebP keeps transparency (a pasted UI snippet) at a fraction of PNG's size.
	return canvas.toDataURL('image/webp', 0.85);
}
