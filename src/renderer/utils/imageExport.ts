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
import { DIAGRAMS_DIR } from '../../shared/maestro-paths';
import { joinPath, isAbsolutePath, fileTimestampSlug } from '../../shared/formatters';
import { requestFileTreeRefresh } from './fileTreeRefresh';

/** Anything the right-click menu can copy or save. */
export type ExportableImage = SVGSVGElement | HTMLImageElement;

export function isSvgElement(el: ExportableImage): el is SVGSVGElement {
	return el.tagName.toLowerCase() === 'svg';
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

/** True when an attribute is missing or sized in CSS-relative units (e.g. "100%"). */
function lacksIntrinsicSize(value: string | null): boolean {
	return !value || value.trim().endsWith('%');
}

/**
 * Serialize an SVG DOM element to a standalone, namespaced SVG string that opens
 * on its own in a browser or image editor.
 *
 * Mermaid sizes its charts with CSS (`width="100%"` plus a `max-width` style) and
 * agent-authored SVG often carries only a viewBox, so the serialized markup can
 * have no intrinsic size. A browser renders that at its 300x150 default and an
 * <img> rasterization comes out cropped, so stamp the measured size onto the
 * clone.
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

	if (
		lacksIntrinsicSize(clone.getAttribute('width')) ||
		lacksIntrinsicSize(clone.getAttribute('height'))
	) {
		const { width, height } = svgDimensions(svg);
		clone.setAttribute('width', String(Math.round(width)));
		clone.setAttribute('height', String(Math.round(height)));
		// A viewBox is what makes the stamped size a scale rather than a crop.
		if (!clone.getAttribute('viewBox')) {
			clone.setAttribute('viewBox', `0 0 ${Math.round(width)} ${Math.round(height)}`);
		}
	}
	// A CSS max-width from the host page would shrink the standalone render.
	clone.style.removeProperty('max-width');

	return new XMLSerializer().serializeToString(clone);
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
 * What actually landed on the clipboard, so the caller can be honest about it.
 * `text` means the pixels could not be recovered and the clipboard holds SVG
 * markup or the image URL instead - pasting it into an image editor won't work,
 * so the UI must not claim an image was copied.
 */
export type ImageCopyResult = 'image' | 'text' | 'failed';

/**
 * Copy a chat image to the clipboard as a raster PNG so it can be pasted into
 * other apps. Falls back to copying the SVG markup (or the image URL) as text
 * when the pixels cannot be recovered.
 */
export async function copyImageElementToClipboard(el: ExportableImage): Promise<ImageCopyResult> {
	if (isSvgElement(el)) {
		try {
			const png = await svgToPngDataUrl(el);
			if (await safeClipboardWriteImage(png)) return 'image';
		} catch {
			// Rasterization failed (e.g. tainted canvas) - fall through to text copy.
		}
		return (await safeClipboardWrite(serializeSvg(el))) ? 'text' : 'failed';
	}

	const dataUrl = await imgToDataUrl(el);
	if (dataUrl && (await safeClipboardWriteImage(dataUrl))) return 'image';

	// The native clipboard only decodes PNG and JPEG, so a webp/gif/bmp source
	// gets repainted through a canvas to become PNG bytes. Skipped for anything
	// the browser could not load (naturalWidth 0), which would rasterize blank.
	if (el.naturalWidth > 0) {
		try {
			if (await safeClipboardWriteImage(imgToPngDataUrl(el))) return 'image';
		} catch {
			// Tainted canvas (cross-origin image without CORS) - fall through to text.
		}
	}

	const src = el.currentSrc || el.src;
	if (!src) return 'failed';
	return (await safeClipboardWrite(src)) ? 'text' : 'failed';
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

/** Formats the save modal can write. SVG is offered only for `<svg>` targets. */
export type ImageSaveFormat = 'svg' | 'png' | 'original';

/** The project a saved image belongs to, and how to reach its filesystem. */
export interface ImageSaveTarget {
	/** Project root of the agent whose view the image was rendered in. */
	projectRoot: string;
	/** Set when the project lives on an SSH remote. */
	sshRemoteId?: string;
	/** Project-relative folder to write into. Defaults to `.maestro/diagrams`. */
	relativeDir?: string;
	/** File name including extension. Defaults to a timestamped suggestion. */
	fileName?: string;
	/**
	 * Agent whose Files panel should pick the new file up. Optional because a
	 * surface can render an image before any agent exists (the wizard); when it
	 * is absent the tree simply refreshes on its own timer.
	 */
	sessionId?: string;
}

export interface ImageSaveToProjectResult {
	/** Absolute path the file was written to. */
	path: string;
	/** Project-relative path, for display (e.g. `.maestro/diagrams/diagram-…svg`). */
	relativePath: string;
}

/**
 * Default extension for a target: SVG keeps its markup, raster keeps its
 * encoding. Without a resolved data URL the encoding is guessed from the
 * element's own `src` so a JPEG is not seeded as `.png`; the guess only seeds
 * the save modal, since `saveImageToProject` re-derives the extension from the
 * bytes it actually writes.
 */
export function defaultExtensionFor(el: ExportableImage, sourceDataUrl?: string | null): string {
	if (isSvgElement(el)) return 'svg';
	if (sourceDataUrl) return dataUrlExtension(sourceDataUrl);

	const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || '';
	if (src.startsWith('data:')) return dataUrlExtension(src);
	// Strip the query/fragment before looking at the extension, or a URL like
	// `photo.jpg?w=64` yields "jpg?w=64".
	const ext = /\.([a-z0-9]+)$/i.exec(src.split(/[?#]/)[0])?.[1]?.toLowerCase();
	if (ext === 'jpeg') return 'jpg';
	return ext && ext.length <= 4 ? ext : 'png';
}

/**
 * A timestamped file name to seed the save modal with, e.g.
 * `diagram-20260713-142530.svg` or `image-20260713-142530.png`.
 */
export function suggestImageFileName(el: ExportableImage, extension: string): string {
	const kind = isSvgElement(el) ? 'diagram' : 'image';
	return `${kind}-${fileTimestampSlug()}.${extension}`;
}

/** Encode a target in the requested format, as markup or a data URL. */
async function encodeForSave(
	el: ExportableImage,
	format: ImageSaveFormat
): Promise<{ markup: string } | { dataUrl: string }> {
	if (isSvgElement(el)) {
		if (format === 'png') return { dataUrl: await svgToPngDataUrl(el) };
		return { markup: serializeSvg(el) };
	}
	const img = el as HTMLImageElement;
	if (format === 'png') return { dataUrl: imgToPngDataUrl(img) };
	const dataUrl = await imgToDataUrl(img);
	if (!dataUrl) throw new Error('Could not read the image data');
	return { dataUrl };
}

/**
 * Reject a folder that would escape the project root.
 *
 * The folder is free text in the save modal and `joinPath` preserves `..`, so
 * `../../secrets` would otherwise write anywhere on the filesystem (or the SSH
 * remote). The whole contract of this function is "inside the project", so an
 * escape is refused rather than clamped - silently rewriting the user's path
 * would save the file somewhere they did not ask for.
 */
function assertSafeRelativeDir(relativeDir: string): void {
	if (isAbsolutePath(relativeDir)) {
		throw new Error('Folder must be relative to the project, not an absolute path');
	}
	if (relativeDir.split(/[/\\]/).some((segment) => segment === '..')) {
		throw new Error('Folder cannot step outside the project with ".."');
	}
}

/** Reject a file name that is really a path, for the same reason as the folder. */
function assertSafeFileName(fileName: string): void {
	if (/[/\\]/.test(fileName)) {
		throw new Error('File name cannot contain a path separator');
	}
	if (fileName === '.' || fileName === '..') {
		throw new Error('File name is not valid');
	}
}

/** Force `name` to carry `ext`, so the extension never lies about the bytes. */
function forceExtension(name: string, ext: string): string {
	const dot = name.lastIndexOf('.');
	const base = dot > 0 ? name.slice(0, dot) : name;
	return `${base}.${ext}`;
}

/**
 * Save an image into the project it was rendered in, under
 * `.maestro/diagrams/` by default.
 *
 * This is the single in-project destination for every "Save Image" surface: a
 * diagram or screenshot an agent produced belongs with that agent's project
 * (and shows up in the File Explorer, which always keeps `.maestro` visible),
 * not in a global downloads folder under a colliding generic name. Works over
 * SSH because the write goes through the same `fs` IPC the rest of the app uses.
 *
 * A name collision gets a `-2`, `-3`, … suffix rather than overwriting.
 *
 * Throws when the destination would escape `projectRoot`, when the image cannot
 * be read, or when every candidate name is taken.
 */
export async function saveImageToProject(
	el: ExportableImage,
	target: ImageSaveTarget,
	format: ImageSaveFormat = 'original'
): Promise<ImageSaveToProjectResult> {
	const relativeDir = target.relativeDir?.trim() || DIAGRAMS_DIR;
	assertSafeRelativeDir(relativeDir);

	const encoded = await encodeForSave(el, format);
	// The extension is derived from what was actually encoded, never from the
	// requested name: saving a JPEG as "original" must not produce a .png, and
	// asking for PNG output must not keep a .svg. Anything downstream that picks
	// a decoder by extension would otherwise reject the file.
	const ext = 'markup' in encoded ? 'svg' : dataUrlExtension(encoded.dataUrl);

	const requested = target.fileName?.trim() || suggestImageFileName(el, ext);
	assertSafeFileName(requested);

	const dir = joinPath(target.projectRoot, relativeDir);
	await window.maestro.fs.mkdir(dir, target.sshRemoteId);

	const withExt = forceExtension(requested, ext);
	const base = withExt.slice(0, withExt.length - ext.length - 1);

	// Every candidate is checked, including the last: picking a name without
	// testing it is how a `-100` file would get silently overwritten.
	let filename = '';
	for (let n = 1; n <= 100; n++) {
		const candidate = n === 1 ? withExt : `${base}-${n}.${ext}`;
		if (!(await window.maestro.fs.stat(joinPath(dir, candidate), target.sshRemoteId))) {
			filename = candidate;
			break;
		}
	}
	if (!filename) {
		throw new Error(`Too many files named like ${withExt} already exist`);
	}

	const path = joinPath(dir, filename);
	// fs.writeFile is UTF-8 and would corrupt raster bytes - binary goes through
	// writeImageFile, which decodes the data URL on the main side.
	const result =
		'markup' in encoded
			? await window.maestro.fs.writeFile(path, encoded.markup, target.sshRemoteId)
			: await window.maestro.fs.writeImageFile(path, encoded.dataUrl, target.sshRemoteId);
	if (!result?.success) throw new Error(`Failed to write ${path}`);

	// A file just appeared in the project. The Files panel would not show it
	// until its next timed refresh, and the toast this save raises offers to
	// open it - so a tree that has not caught up reads as the save having
	// failed. Fired here rather than in the caller because this function is the
	// single in-project destination every "Save Image" surface goes through.
	requestFileTreeRefresh(target.sessionId);

	return { path, relativePath: joinPath(relativeDir, filename) };
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
