/**
 * @file clipboard.ts
 * @description Safe clipboard operations that handle focus-related errors.
 *
 * The Clipboard API throws NotAllowedError when the document is not focused.
 * These utilities wrap clipboard operations with proper error handling to prevent
 * unhandled exceptions from reaching Sentry.
 *
 * Fixes MAESTRO-4Z
 */

/**
 * Safely write text to the clipboard.
 * Returns true on success, false if the document is not focused or clipboard is unavailable.
 */
export async function safeClipboardWrite(text: string): Promise<boolean> {
	try {
		if (window.maestro?.shell?.copyTextToClipboard) {
			await window.maestro.shell.copyTextToClipboard(text);
			return true;
		}
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// NotAllowedError when document not focused, or other clipboard failures.
		// Not actionable — the user can retry when the window is focused.
		return false;
	}
}

/**
 * Safely write binary data (e.g. images) to the clipboard.
 * Returns true on success, false if the document is not focused or clipboard is unavailable.
 */
export async function safeClipboardWriteBlob(items: ClipboardItem[]): Promise<boolean> {
	try {
		await navigator.clipboard.write(items);
		return true;
	} catch {
		return false;
	}
}

/**
 * Copy an image to the clipboard using Electron's native clipboard API.
 * Accepts a data URL (e.g. from a canvas or pasted image) OR a
 * `maestro-image://` reference from a persisted transcript image - refs are
 * resolved to a data URL first so copy works regardless of where the image
 * lives. Falls back to the browser Clipboard API if the Electron IPC is
 * unavailable.
 */
export async function safeClipboardWriteImage(dataUrl: string): Promise<boolean> {
	try {
		// Persisted transcript images are stored as refs, not data URLs; resolve
		// to bytes before handing off to the clipboard.
		if (dataUrl.startsWith('maestro-image://') && window.maestro?.images?.resolve) {
			const resolved = await window.maestro.images.resolve(dataUrl);
			if (!resolved) return false;
			dataUrl = resolved;
		}
		if (window.maestro?.shell?.copyImageToClipboard) {
			await window.maestro.shell.copyImageToClipboard(dataUrl);
			return true;
		}
		// Fallback: browser Clipboard API (may not work in all Electron contexts)
		const response = await fetch(dataUrl);
		const blob = await response.blob();
		return safeClipboardWriteBlob([new ClipboardItem({ [blob.type]: blob })]);
	} catch {
		return false;
	}
}

/**
 * Read an image from the system clipboard.
 * Returns a PNG data URL when the clipboard holds an image, or null when it
 * doesn't (or the read fails). Prefers Electron's native clipboard via IPC and
 * falls back to the browser Clipboard API when running outside Electron.
 */
export async function safeClipboardReadImage(): Promise<string | null> {
	try {
		if (window.maestro?.shell?.readImageFromClipboard) {
			return await window.maestro.shell.readImageFromClipboard();
		}
		const items = await navigator.clipboard.read();
		for (const item of items) {
			const imageType = item.types.find((t) => t.startsWith('image/'));
			if (!imageType) continue;
			const blob = await item.getType(imageType);
			return await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result as string);
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(blob);
			});
		}
		return null;
	} catch {
		return null;
	}
}
