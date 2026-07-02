/**
 * svgExport.ts - helpers for exporting an inline <svg> element rendered in chat
 * markdown to the clipboard (as a raster PNG) or to disk (as a standalone .svg
 * file).
 *
 * Used by SvgContextMenu (right-click on AI-generated SVG diagrams). Kept as a
 * shared util so the same serialize/rasterize logic can be reused by any future
 * surface that needs to export an SVG.
 */

import { safeClipboardWrite, safeClipboardWriteImage } from './clipboard';

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

/**
 * Copy an SVG to the clipboard as a raster PNG image so it can be pasted into
 * other apps. Falls back to copying the raw SVG markup as text if rasterization
 * fails. Returns true on success.
 */
export async function copySvgToClipboard(svg: SVGSVGElement): Promise<boolean> {
	try {
		const png = await svgToPngDataUrl(svg);
		if (await safeClipboardWriteImage(png)) return true;
	} catch {
		// Rasterization failed (e.g. tainted canvas) - fall through to text copy.
	}
	return safeClipboardWrite(serializeSvg(svg));
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
