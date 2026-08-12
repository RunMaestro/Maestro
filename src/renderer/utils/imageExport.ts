/**
 * imageExport.ts - helpers for exporting an image rendered in chat to the
 * clipboard or to disk.
 *
 * Two kinds of image show up in the AI chat and both need the same two actions:
 *  - Inline `<svg>` (agent-authored SVG, mermaid diagrams), exported as a raster
 *    PNG for the clipboard and as either `.svg` or `.png` on disk.
 *  - Raster `<img>` (markdown image embeds, pasted transcript attachments),
 *    whose source may be a data URL, a `maestro-image://` store reference, or a
 *    remote URL.
 *
 * Used by ImageContextMenu (right-click on any chat image). Kept as a shared
 * util so any surface that renders an image can offer the same two actions.
 */

import { safeClipboardWrite, safeClipboardWriteImage } from './clipboard';

/** Anything the right-click menu can copy or save. */
export type ExportableImage = SVGSVGElement | HTMLImageElement;

export function isSvgElement(el: ExportableImage): el is SVGSVGElement {
	return el.tagName.toLowerCase() === 'svg';
}

/**
 * Serialize an SVG DOM element to a standalone, namespaced SVG string that opens
 * on its own in a browser or image editor.
 */
export function serializeSvg(svg: SVGSVGElement): string {
	const clone = svg.cloneNode(true) as SVGSVGElement;
	// Ensure the namespaces are present so the file is a valid standalone SVG.
	if (!clone.getAttribute('xmlns')) {
		clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	}
	if (!clone.getAttribute('xmlns:xlink')) {
		clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
	}
	return new XMLSerializer().serializeToString(clone);
}

/** Intrinsic pixel dimensions of an SVG, from its rendered box or viewBox. */
function svgDimensions(svg: SVGSVGElement): { width: number; height: number } {
	const rect = svg.getBoundingClientRect();
	if (rect.width > 0 && rect.height > 0) {
		return { width: rect.width, height: rect.height };
	}
	const vb = svg.viewBox?.baseVal;
	if (vb && vb.width > 0 && vb.height > 0) {
		return { width: vb.width, height: vb.height };
	}
	return { width: 512, height: 512 };
}

/** Draw an already-loaded image source onto a canvas and read it back as PNG. */
function rasterize(source: CanvasImageSource, width: number, height: number): string {
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(width));
	canvas.height = Math.max(1, Math.round(height));
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Canvas 2D context unavailable');
	ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL('image/png');
}

/**
 * Rasterize an SVG element to a PNG data URL at `scale`x the rendered size so it
 * stays crisp on high-DPI displays.
 */
export async function svgToPngDataUrl(svg: SVGSVGElement, scale = 2): Promise<string> {
	const source = serializeSvg(svg);
	const { width, height } = svgDimensions(svg);
	const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

	const img = new Image();
	img.decoding = 'async';
	await new Promise<void>((resolve, reject) => {
		img.onload = () => resolve();
		img.onerror = () => reject(new Error('Failed to load SVG for rasterization'));
		img.src = svgUrl;
	});

	return rasterize(img, width * scale, height * scale);
}

/** Rasterize a loaded `<img>` to a PNG data URL at its intrinsic size. */
export function imgToPngDataUrl(img: HTMLImageElement): string {
	const width = img.naturalWidth || img.width;
	const height = img.naturalHeight || img.height;
	return rasterize(img, width, height);
}

/**
 * Resolve an `<img>` to a data URL holding its bytes.
 *
 * The three sources that reach chat need three different routes: data URLs pass
 * through, `maestro-image://` store references go back through IPC for their
 * bytes, and anything else (http(s), custom protocols) is re-read via fetch,
 * with a canvas rasterization as the last resort. Returns null when the bytes
 * cannot be recovered.
 */
export async function imgToDataUrl(img: HTMLImageElement): Promise<string | null> {
	const src = img.currentSrc || img.src;
	if (!src) return null;
	if (src.startsWith('data:')) return src;

	if (src.startsWith('maestro-image://')) {
		const resolved = await window.maestro?.images?.resolve(src);
		if (resolved) return resolved;
	}

	try {
		const response = await fetch(src);
		const blob = await response.blob();
		return await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(blob);
		});
	} catch {
		// Fetch can fail on custom protocols or a restrictive CSP - fall back to
		// reading the pixels the browser already painted.
	}

	try {
		return imgToPngDataUrl(img);
	} catch {
		// Tainted canvas (cross-origin image without CORS) - nothing left to try.
		return null;
	}
}

/** File extension implied by a data URL's mime type, defaulting to `png`. */
export function dataUrlExtension(dataUrl: string): string {
	const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1]?.toLowerCase();
	if (!mime) return 'png';
	if (mime === 'image/jpeg') return 'jpg';
	if (mime === 'image/svg+xml') return 'svg';
	const subtype = mime.split('/')[1];
	return subtype ? subtype.replace(/\+.*$/, '') : 'png';
}

/**
 * Copy a chat image to the clipboard as a raster PNG so it can be pasted into
 * other apps. Falls back to copying the SVG markup (or the image URL) as text
 * when the pixels cannot be recovered. Returns true on success.
 */
export async function copyImageElementToClipboard(el: ExportableImage): Promise<boolean> {
	if (isSvgElement(el)) {
		try {
			const png = await svgToPngDataUrl(el);
			if (await safeClipboardWriteImage(png)) return true;
		} catch {
			// Rasterization failed (e.g. tainted canvas) - fall through to text copy.
		}
		return safeClipboardWrite(serializeSvg(el));
	}

	const dataUrl = await imgToDataUrl(el);
	if (dataUrl && (await safeClipboardWriteImage(dataUrl))) return true;
	const src = el.currentSrc || el.src;
	return src ? safeClipboardWrite(src) : false;
}

/** Trigger a browser download of a data URL - the fallback when no native save dialog exists. */
function downloadDataUrl(dataUrl: string, filename: string): void {
	const link = document.createElement('a');
	link.href = dataUrl;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
}

/** Trigger a browser download of an SVG element as a standalone .svg file. */
export function downloadSvg(svg: SVGSVGElement, filename = 'maestro-diagram.svg'): void {
	const source = serializeSvg(svg);
	const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	// Revoke on the next tick so the download has time to start.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface SaveImageResult {
	/** True when bytes reached disk (or a browser download started). */
	saved: boolean;
	/** Absolute path written, when the native dialog was used. */
	path?: string;
	/** Present only when the save was attempted and failed. */
	error?: string;
}

/**
 * Save a chat image to disk, asking the user where via the native save dialog.
 *
 * SVG targets default to `.svg` and are written as markup; picking `.png` in the
 * dialog rasterizes instead. Raster targets keep their original encoding unless
 * the user renames to `.png`. Falls back to a browser download when the native
 * dialog is unavailable (web/mobile renderer). A cancelled dialog reports
 * `{ saved: false }` with no error.
 */
export async function saveImageElementToDisk(el: ExportableImage): Promise<SaveImageResult> {
	const svg = isSvgElement(el) ? el : null;
	const img = svg ? null : (el as HTMLImageElement);
	const sourceDataUrl = img ? await imgToDataUrl(img) : null;

	if (!svg && !sourceDataUrl) {
		return { saved: false, error: 'Could not read the image data' };
	}

	const sourceExt = svg ? 'svg' : dataUrlExtension(sourceDataUrl!);
	const defaultName = svg ? 'maestro-diagram.svg' : `maestro-image.${sourceExt}`;

	const saveFile = window.maestro?.dialog?.saveFile;
	if (!saveFile) {
		// No native dialog (web renderer): fall back to a plain browser download.
		if (svg) downloadSvg(svg, defaultName);
		else downloadDataUrl(sourceDataUrl!, defaultName);
		return { saved: true };
	}

	const filters = svg
		? [
				{ name: 'SVG Image', extensions: ['svg'] },
				{ name: 'PNG Image', extensions: ['png'] },
			]
		: [
				{ name: 'Image', extensions: [sourceExt] },
				{ name: 'PNG Image', extensions: ['png'] },
			];

	const filePath = await saveFile({ defaultPath: defaultName, filters, title: 'Save Image' });
	if (!filePath) return { saved: false };

	const wantsPng = filePath.toLowerCase().endsWith('.png');

	try {
		if (svg && !wantsPng) {
			await window.maestro.fs.writeFile(filePath, serializeSvg(svg));
		} else if (svg) {
			await window.maestro.fs.writeImageFile(filePath, await svgToPngDataUrl(svg));
		} else {
			const bytes = wantsPng && sourceExt !== 'png' ? imgToPngDataUrl(img!) : sourceDataUrl!;
			await window.maestro.fs.writeImageFile(filePath, bytes);
		}
	} catch (err) {
		return { saved: false, error: err instanceof Error ? err.message : 'Failed to write the file' };
	}

	return { saved: true, path: filePath };
}
