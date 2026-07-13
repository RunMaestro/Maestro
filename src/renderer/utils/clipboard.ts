/**
 * @file clipboard.ts
 * @description Safe clipboard operations that handle focus-related errors.
 *
 * The Clipboard API throws NotAllowedError when the document is not focused.
 * These utilities wrap clipboard operations with proper error handling to prevent
 * unhandled exceptions from reaching Sentry.
 *
 * In the web-desktop bundle (`isWebDesktop()`), the `window.maestro.shell.*`
 * clipboard bridge would operate on the HOST machine's clipboard rather than the
 * browser device the user is actually on. So there we prefer the browser-native
 * `navigator.clipboard` path first and only fall back to the host bridge when the
 * navigator API throws or is unavailable. Desktop (Electron) behavior is unchanged.
 *
 * Fixes MAESTRO-4Z
 */

import { isWebDesktop } from './runtimeContext';

/**
 * Legacy clipboard write via a hidden textarea + document.execCommand('copy').
 * The async Clipboard API (navigator.clipboard) is gated to secure contexts,
 * so it is undefined when web-desktop is served over plain HTTP (e.g. a
 * Tailscale/LAN IP without TLS). execCommand is deprecated but still works in
 * insecure contexts and is the only browser-side path left there.
 * Returns true on success.
 */
function legacyExecCommandCopy(text: string): boolean {
	// Remember what had focus so we can hand it back; selecting the hidden
	// textarea steals focus from the control that initiated the copy.
	const previouslyFocused = document.activeElement as HTMLElement | null;
	const textarea = document.createElement('textarea');
	textarea.value = text;
	// Keep it out of view and from scrolling/zooming the page.
	textarea.style.position = 'fixed';
	textarea.style.top = '0';
	textarea.style.left = '0';
	textarea.style.width = '1px';
	textarea.style.height = '1px';
	textarea.style.padding = '0';
	textarea.style.border = 'none';
	textarea.style.outline = 'none';
	textarea.style.boxShadow = 'none';
	textarea.style.background = 'transparent';
	textarea.setAttribute('readonly', '');
	document.body.appendChild(textarea);
	try {
		textarea.focus();
		textarea.select();
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		document.body.removeChild(textarea);
		// Restore focus to whatever held it before the copy so the next
		// keystroke returns to the originating control.
		if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
			previouslyFocused.focus();
		}
	}
}

/**
 * Safely write text to the clipboard.
 * Returns true on success, false if the document is not focused or clipboard is unavailable.
 *
 * In web-desktop mode the Electron IPC clipboard writes to the HOST machine
 * (where the Electron app runs), not the browser the user is on. Skip the IPC
 * path there and use the browser Clipboard API so the copy lands on the user's
 * own machine. When that browser API is unavailable (insecure context, e.g.
 * web-desktop over a plain-HTTP Tailscale/LAN IP), fall back to the legacy
 * execCommand copy so the copy still lands on the user's machine.
 */
export async function safeClipboardWrite(text: string): Promise<boolean> {
	if (isWebDesktop()) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Browser clipboard unavailable/denied - fall back below. In web-desktop
			// we keep the copy on the user's own machine via the legacy path rather
			// than routing to the host bridge.
		}
	}
	try {
		if (!isWebDesktop() && window.maestro?.shell?.copyTextToClipboard) {
			await window.maestro.shell.copyTextToClipboard(text);
			return true;
		}
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
		// Insecure context: navigator.clipboard is undefined. Use the legacy path.
		return legacyExecCommandCopy(text);
	} catch {
		// NotAllowedError when document not focused, or async API blocked in an
		// insecure context. Try the legacy path before giving up; the user can
		// retry when the window is focused if even that fails.
		return legacyExecCommandCopy(text);
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
	if (isWebDesktop()) {
		try {
			const response = await fetch(dataUrl);
			const blob = await response.blob();
			await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
			return true;
		} catch {
			// Browser clipboard unavailable/denied - fall back to the host bridge below.
		}
	}
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
	if (isWebDesktop()) {
		try {
			return await readImageViaNavigator();
		} catch {
			// Browser clipboard unavailable/denied - fall back to the host bridge below.
		}
	}
	try {
		if (window.maestro?.shell?.readImageFromClipboard) {
			return await window.maestro.shell.readImageFromClipboard();
		}
		return await readImageViaNavigator();
	} catch {
		return null;
	}
}

/**
 * Read a PNG data URL from the browser clipboard via the navigator API.
 * Returns null when the clipboard holds no image. Throws when the navigator
 * Clipboard API is unavailable or the read is denied, so callers can decide
 * whether to fall back to another path.
 */
async function readImageViaNavigator(): Promise<string | null> {
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
}
