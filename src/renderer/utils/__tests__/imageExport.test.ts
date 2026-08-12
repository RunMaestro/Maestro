/**
 * Tests for imageExport utility (serialize, save, and clipboard export of the
 * images rendered in chat).
 *
 * The canvas/Image rasterization path (svgToPngDataUrl / the PNG branch of
 * copyImageElementToClipboard) is intentionally not covered here: jsdom does not
 * render <canvas> or fire Image.onload, so it can't be exercised meaningfully.
 * We cover the deterministic DOM-string, routing, and dialog logic instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	serializeSvg,
	downloadSvg,
	dataUrlExtension,
	isSvgElement,
	imgToDataUrl,
	saveImageElementToDisk,
} from '../imageExport';

const SVG_NS = 'http://www.w3.org/2000/svg';

function makeSvg(): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
	svg.setAttribute('viewBox', '0 0 10 10');
	const circle = document.createElementNS(SVG_NS, 'circle');
	circle.setAttribute('cx', '5');
	circle.setAttribute('cy', '5');
	circle.setAttribute('r', '4');
	svg.appendChild(circle);
	return svg;
}

describe('serializeSvg', () => {
	it('injects the svg xmlns so the output is standalone', () => {
		const out = serializeSvg(makeSvg());
		expect(out).toContain(`xmlns="${SVG_NS}"`);
		expect(out).toContain('<circle');
	});

	it('does not mutate the source element', () => {
		const svg = makeSvg();
		expect(svg.getAttribute('xmlns')).toBeNull();
		serializeSvg(svg);
		// Serialization works on a clone; the live element stays untouched.
		expect(svg.getAttribute('xmlns')).toBeNull();
	});

	it('does not inject an extra xmlns when one already exists', () => {
		const svg = makeSvg();
		svg.setAttribute('xmlns', SVG_NS);
		// serializeSvg must add nothing when the namespace is already declared.
		// Compare against a raw serialize of the same element: the counts must
		// match (jsdom emits the SVG-namespaced element's declaration twice, a
		// serializer quirk Chromium dedupes - so assert equality, not "== 1").
		const countXmlns = (s: string) => s.match(new RegExp(`xmlns="${SVG_NS}"`, 'g'))?.length ?? 0;
		const viaHelper = serializeSvg(svg);
		const viaRaw = new XMLSerializer().serializeToString(svg.cloneNode(true));
		expect(countXmlns(viaHelper)).toBe(countXmlns(viaRaw));
		expect(countXmlns(viaHelper)).toBeGreaterThanOrEqual(1);
	});
});

describe('downloadSvg', () => {
	beforeEach(() => {
		vi.stubGlobal('URL', {
			...URL,
			createObjectURL: vi.fn(() => 'blob:mock'),
			revokeObjectURL: vi.fn(),
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('creates an anchor with the given filename and clicks it', () => {
		const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

		downloadSvg(makeSvg(), 'diagram.svg');

		expect(clickSpy).toHaveBeenCalledTimes(1);
		const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement;
		expect(anchor.download).toBe('diagram.svg');
		expect(anchor.href).toContain('blob:mock');
		// Anchor is removed from the DOM after the click.
		expect(document.querySelector('a[download]')).toBeNull();
	});

	it('revokes the object URL after the download starts', () => {
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
		downloadSvg(makeSvg());
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		vi.runAllTimers();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
	});
});

describe('isSvgElement', () => {
	it('tells an inline diagram apart from a raster image', () => {
		expect(isSvgElement(makeSvg())).toBe(true);
		expect(isSvgElement(document.createElement('img'))).toBe(false);
	});
});

describe('dataUrlExtension', () => {
	it.each([
		['data:image/png;base64,AAAA', 'png'],
		['data:image/jpeg;base64,AAAA', 'jpg'],
		['data:image/gif;base64,AAAA', 'gif'],
		['data:image/webp;base64,AAAA', 'webp'],
		// `image/svg+xml` must not become the nonsense extension `svg+xml`.
		['data:image/svg+xml;charset=utf-8,<svg/>', 'svg'],
		// Anything unrecognizable saves as PNG rather than an extensionless file.
		['not-a-data-url', 'png'],
	])('maps %s to .%s', (dataUrl, ext) => {
		expect(dataUrlExtension(dataUrl)).toBe(ext);
	});
});

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

function makeImg(src: string): HTMLImageElement {
	const img = document.createElement('img');
	// jsdom does not resolve custom protocols, so set the attribute directly and
	// let the `src` getter report it back verbatim.
	img.setAttribute('src', src);
	Object.defineProperty(img, 'src', { value: src, configurable: true });
	return img;
}

describe('imgToDataUrl', () => {
	it('passes a data URL straight through', async () => {
		await expect(imgToDataUrl(makeImg(PNG_DATA_URL))).resolves.toBe(PNG_DATA_URL);
	});

	it('resolves a maestro-image store reference back to its bytes', async () => {
		const resolve = vi.fn().mockResolvedValue(PNG_DATA_URL);
		const bridge = window.maestro as unknown as Record<string, unknown>;
		const previous = bridge.images;
		bridge.images = { resolve };

		try {
			await expect(imgToDataUrl(makeImg('maestro-image://store/abc.png'))).resolves.toBe(
				PNG_DATA_URL
			);
			expect(resolve).toHaveBeenCalledWith('maestro-image://store/abc.png');
		} finally {
			bridge.images = previous;
		}
	});
});

describe('saveImageElementToDisk', () => {
	beforeEach(() => {
		// The bridge mocks live in the global setup and are shared across tests in
		// this file, so call counts have to be reset per test.
		vi.mocked(window.maestro.dialog.saveFile).mockClear();
		vi.mocked(window.maestro.fs.writeFile).mockClear().mockResolvedValue({ success: true });
		vi.mocked(window.maestro.fs.writeImageFile).mockClear().mockResolvedValue({ success: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('writes an SVG target as markup when the user keeps the .svg extension', async () => {
		vi.mocked(window.maestro.dialog.saveFile).mockResolvedValue('/tmp/diagram.svg');

		const result = await saveImageElementToDisk(makeSvg());

		expect(result).toEqual({ saved: true, path: '/tmp/diagram.svg' });
		expect(window.maestro.fs.writeFile).toHaveBeenCalledWith(
			'/tmp/diagram.svg',
			expect.stringContaining('<circle')
		);
		expect(window.maestro.fs.writeImageFile).not.toHaveBeenCalled();
	});

	it('writes a raster target through the binary path, not the UTF-8 one', async () => {
		vi.mocked(window.maestro.dialog.saveFile).mockResolvedValue('/tmp/shot.png');

		const result = await saveImageElementToDisk(makeImg(PNG_DATA_URL));

		expect(result).toEqual({ saved: true, path: '/tmp/shot.png' });
		// writeFile would encode the base64 payload as text and corrupt the image.
		expect(window.maestro.fs.writeImageFile).toHaveBeenCalledWith('/tmp/shot.png', PNG_DATA_URL);
		expect(window.maestro.fs.writeFile).not.toHaveBeenCalled();
	});

	it('offers the source extension first and PNG as the alternative', async () => {
		vi.mocked(window.maestro.dialog.saveFile).mockResolvedValue(null);

		await saveImageElementToDisk(makeImg('data:image/jpeg;base64,AAAA'));

		expect(window.maestro.dialog.saveFile).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultPath: 'maestro-image.jpg',
				filters: [
					{ name: 'Image', extensions: ['jpg'] },
					{ name: 'PNG Image', extensions: ['png'] },
				],
			})
		);
	});

	it('reports a cancelled dialog as not-saved with no error', async () => {
		vi.mocked(window.maestro.dialog.saveFile).mockResolvedValue(null);

		await expect(saveImageElementToDisk(makeSvg())).resolves.toEqual({ saved: false });
		expect(window.maestro.fs.writeFile).not.toHaveBeenCalled();
	});

	it('surfaces a write failure instead of claiming success', async () => {
		vi.mocked(window.maestro.dialog.saveFile).mockResolvedValue('/tmp/diagram.svg');
		vi.mocked(window.maestro.fs.writeFile).mockRejectedValue(new Error('EACCES'));

		await expect(saveImageElementToDisk(makeSvg())).resolves.toEqual({
			saved: false,
			error: 'EACCES',
		});
	});

	it('reports unreadable image data rather than opening an empty dialog', async () => {
		const img = makeImg('');

		await expect(saveImageElementToDisk(img)).resolves.toEqual({
			saved: false,
			error: 'Could not read the image data',
		});
		expect(window.maestro.dialog.saveFile).not.toHaveBeenCalled();
	});
});
