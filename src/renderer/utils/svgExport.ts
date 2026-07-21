/**
 * svgExport.ts - helpers for exporting an inline <svg> element rendered in chat
 * markdown to the clipboard (as a raster PNG) or to disk (as a standalone .svg
 * file).
 *
 * Used by SvgContextMenu (right-click on AI-generated SVG diagrams and Mermaid
 * charts). Kept as a shared util so the same serialize/rasterize logic can be
 * reused by any future surface that needs to export an SVG.
 */

import { safeClipboardWrite, safeClipboardWriteImage } from './clipboard';
import { DIAGRAMS_DIR } from '../../shared/maestro-paths';
import { joinPath } from '../../shared/formatters';

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

	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(width * scale));
	canvas.height = Math.max(1, Math.round(height * scale));
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Canvas 2D context unavailable');
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL('image/png');
}

/** What actually landed on the clipboard, so the caller can be honest about it. */
export type SvgCopyResult = 'image' | 'markup' | 'failed';

/**
 * Copy an SVG to the clipboard as a raster PNG image so it can be pasted into
 * other apps. Falls back to copying the raw SVG markup as text if rasterization
 * fails (e.g. a tainted canvas, or an <img> that refuses the source).
 */
export async function copySvgToClipboard(svg: SVGSVGElement): Promise<SvgCopyResult> {
	try {
		const png = await svgToPngDataUrl(svg);
		if (await safeClipboardWriteImage(png)) return 'image';
	} catch {
		// Rasterization failed - fall through to the markup copy below.
	}
	return (await safeClipboardWrite(serializeSvg(svg))) ? 'markup' : 'failed';
}

/** The project a diagram belongs to, and how to reach its filesystem. */
export interface SvgSaveTarget {
	/** Project root of the agent whose view the diagram was rendered in. */
	projectRoot: string;
	/** Set when the project lives on an SSH remote. */
	sshRemoteId?: string;
}

export interface SvgSaveResult {
	/** Absolute path the file was written to. */
	path: string;
	/** Project-relative path, for display (e.g. `.maestro/diagrams/diagram-…svg`). */
	relativePath: string;
}

/** `20260713-142530` - sorts chronologically and is filesystem-safe everywhere. */
function timestampSlug(now: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
	);
}

/**
 * Save an SVG element into the project's `.maestro/diagrams/` folder.
 *
 * This is the single destination for every "Save Image" surface: a diagram an
 * agent produced belongs with that agent's project (and shows up in the File
 * Explorer, which always keeps `.maestro` visible), not in a global downloads
 * folder under a colliding generic name. Works over SSH because the write goes
 * through the same `fs` IPC the rest of the app uses.
 *
 * The name is timestamped; a same-second re-save gets a `-2`, `-3`, … suffix.
 */
export async function saveSvgToProject(
	svg: SVGSVGElement,
	target: SvgSaveTarget
): Promise<SvgSaveResult> {
	const dir = joinPath(target.projectRoot, DIAGRAMS_DIR);
	await window.maestro.fs.mkdir(dir, target.sshRemoteId);

	const base = `diagram-${timestampSlug(new Date())}`;
	let filename = `${base}.svg`;
	for (
		let n = 2;
		n <= 100 && (await window.maestro.fs.stat(joinPath(dir, filename), target.sshRemoteId));
		n++
	) {
		filename = `${base}-${n}.svg`;
	}

	const path = joinPath(dir, filename);
	const result = await window.maestro.fs.writeFile(path, serializeSvg(svg), target.sshRemoteId);
	if (!result?.success) throw new Error(`Failed to write ${path}`);

	return { path, relativePath: `${DIAGRAMS_DIR}/${filename}` };
}

/**
 * Trigger a browser download of an SVG element as a standalone .svg file.
 * Fallback for surfaces with no project to save into (e.g. the wizard preview);
 * prefer {@link saveSvgToProject} whenever a project root is known.
 */
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
