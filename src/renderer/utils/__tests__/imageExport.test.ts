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
	saveImageToProject,
	suggestImageFileName,
	defaultExtensionFor,
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

describe('saveImageToProject', () => {
	beforeEach(() => {
		vi.mocked(window.maestro.fs.mkdir).mockClear().mockResolvedValue({ success: true });
		vi.mocked(window.maestro.fs.writeFile).mockClear().mockResolvedValue({ success: true });
		vi.mocked(window.maestro.fs.writeImageFile).mockClear().mockResolvedValue({ success: true });
		// stat() answering null means "no file there", so no de-duplication suffix.
		vi.mocked(window.maestro.fs.stat)
			.mockClear()
			.mockResolvedValue(null as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('writes an SVG into .maestro/diagrams under the project root', async () => {
		const result = await saveImageToProject(
			makeSvg(),
			{ projectRoot: '/home/me/proj', fileName: 'diagram.svg' },
			'svg'
		);

		expect(window.maestro.fs.mkdir).toHaveBeenCalledWith(
			'/home/me/proj/.maestro/diagrams',
			undefined
		);
		expect(window.maestro.fs.writeFile).toHaveBeenCalledWith(
			'/home/me/proj/.maestro/diagrams/diagram.svg',
			expect.stringContaining('<svg'),
			undefined
		);
		expect(result.relativePath).toBe('.maestro/diagrams/diagram.svg');
	});

	it('honors a custom folder', async () => {
		await saveImageToProject(
			makeSvg(),
			{ projectRoot: '/home/me/proj', relativeDir: 'docs/img', fileName: 'a.svg' },
			'svg'
		);

		expect(window.maestro.fs.mkdir).toHaveBeenCalledWith('/home/me/proj/docs/img', undefined);
	});

	it('suffixes rather than overwriting an existing name', async () => {
		// First two candidates exist, the third is free.
		vi.mocked(window.maestro.fs.stat)
			.mockResolvedValueOnce({ isFile: true } as never)
			.mockResolvedValueOnce({ isFile: true } as never)
			.mockResolvedValue(null as never);

		const result = await saveImageToProject(
			makeSvg(),
			{ projectRoot: '/p', fileName: 'diagram.svg' },
			'svg'
		);

		expect(result.relativePath).toBe('.maestro/diagrams/diagram-3.svg');
	});

	it('routes raster bytes through writeImageFile, never the UTF-8 writeFile', async () => {
		await saveImageToProject(
			makeImg(PNG_DATA_URL),
			{ projectRoot: '/p', fileName: 'shot.png' },
			'original'
		);

		expect(window.maestro.fs.writeImageFile).toHaveBeenCalledWith(
			'/p/.maestro/diagrams/shot.png',
			PNG_DATA_URL,
			undefined
		);
		expect(window.maestro.fs.writeFile).not.toHaveBeenCalled();
	});

	it('threads the SSH remote id through every filesystem call', async () => {
		await saveImageToProject(
			makeSvg(),
			{ projectRoot: '/remote/proj', sshRemoteId: 'box-1', fileName: 'd.svg' },
			'svg'
		);

		expect(window.maestro.fs.mkdir).toHaveBeenCalledWith('/remote/proj/.maestro/diagrams', 'box-1');
		expect(window.maestro.fs.writeFile).toHaveBeenCalledWith(
			'/remote/proj/.maestro/diagrams/d.svg',
			expect.any(String),
			'box-1'
		);
	});

	it('throws when the write reports failure instead of returning a path', async () => {
		vi.mocked(window.maestro.fs.writeFile).mockResolvedValue({ success: false });

		await expect(
			saveImageToProject(makeSvg(), { projectRoot: '/p', fileName: 'd.svg' }, 'svg')
		).rejects.toThrow(/Failed to write/);
	});
});

describe('suggestImageFileName', () => {
	it('names diagrams and images distinctly, with a sortable timestamp', () => {
		expect(suggestImageFileName(makeSvg(), 'svg')).toMatch(/^diagram-\d{8}-\d{6}\.svg$/);
		expect(suggestImageFileName(makeImg(PNG_DATA_URL), 'png')).toMatch(/^image-\d{8}-\d{6}\.png$/);
	});
});

describe('saveImageToProject path safety', () => {
	beforeEach(() => {
		vi.mocked(window.maestro.fs.mkdir).mockClear().mockResolvedValue({ success: true });
		vi.mocked(window.maestro.fs.writeFile).mockClear().mockResolvedValue({ success: true });
		vi.mocked(window.maestro.fs.writeImageFile).mockClear().mockResolvedValue({ success: true });
		vi.mocked(window.maestro.fs.stat)
			.mockClear()
			.mockResolvedValue(null as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each(['../escape', 'a/../../escape', '..'])(
		'refuses a folder that steps outside the project: %s',
		async (relativeDir) => {
			await expect(
				saveImageToProject(makeSvg(), { projectRoot: '/p', relativeDir, fileName: 'd.svg' }, 'svg')
			).rejects.toThrow(/outside the project/);
			// Nothing may touch the filesystem once the path is rejected.
			expect(window.maestro.fs.mkdir).not.toHaveBeenCalled();
			expect(window.maestro.fs.writeFile).not.toHaveBeenCalled();
		}
	);

	it('refuses an absolute folder', async () => {
		await expect(
			saveImageToProject(
				makeSvg(),
				{ projectRoot: '/p', relativeDir: '/etc', fileName: 'd.svg' },
				'svg'
			)
		).rejects.toThrow(/absolute path/);
		expect(window.maestro.fs.mkdir).not.toHaveBeenCalled();
	});

	it('refuses a file name carrying a path separator', async () => {
		await expect(
			saveImageToProject(makeSvg(), { projectRoot: '/p', fileName: '../../evil.svg' }, 'svg')
		).rejects.toThrow(/path separator/);
		expect(window.maestro.fs.writeFile).not.toHaveBeenCalled();
	});

	it('still allows an ordinary nested folder', async () => {
		await saveImageToProject(
			makeSvg(),
			{ projectRoot: '/p', relativeDir: 'docs/img/diagrams', fileName: 'd.svg' },
			'svg'
		);
		expect(window.maestro.fs.mkdir).toHaveBeenCalledWith('/p/docs/img/diagrams', undefined);
	});

	it('errors rather than overwriting when every candidate name is taken', async () => {
		// Including the final one: picking a name without testing it is the bug.
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({ isFile: true } as never);

		await expect(
			saveImageToProject(makeSvg(), { projectRoot: '/p', fileName: 'd.svg' }, 'svg')
		).rejects.toThrow(/Too many files/);
		expect(window.maestro.fs.writeFile).not.toHaveBeenCalled();
	});
});

describe('save extension matches the encoded bytes', () => {
	beforeEach(() => {
		vi.mocked(window.maestro.fs.mkdir).mockClear().mockResolvedValue({ success: true });
		vi.mocked(window.maestro.fs.writeFile).mockClear().mockResolvedValue({ success: true });
		vi.mocked(window.maestro.fs.writeImageFile).mockClear().mockResolvedValue({ success: true });
		vi.mocked(window.maestro.fs.stat)
			.mockClear()
			.mockResolvedValue(null as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('corrects a .png name when the original JPEG bytes are written', async () => {
		const jpeg = makeImg('data:image/jpeg;base64,/9j/AAAA');

		const result = await saveImageToProject(
			jpeg,
			{ projectRoot: '/p', fileName: 'shot.png' },
			'original'
		);

		expect(result.relativePath).toBe('.maestro/diagrams/shot.jpg');
	});

	// The SVG -> PNG direction can't be asserted here: it goes through
	// svgToPngDataUrl, and jsdom never fires <img> onload for an SVG data URL, so
	// the call hangs. Same reason the rasterizing helpers are uncovered above.
});

describe('defaultExtensionFor', () => {
	it('reads a raster encoding off its data URL rather than assuming png', () => {
		expect(defaultExtensionFor(makeImg('data:image/jpeg;base64,/9j/AAAA'))).toBe('jpg');
	});

	it('falls back to the src extension, ignoring the query string', () => {
		expect(defaultExtensionFor(makeImg('https://example.com/photo.webp?w=64'))).toBe('webp');
	});

	it('normalizes .jpeg to .jpg', () => {
		expect(defaultExtensionFor(makeImg('https://example.com/photo.jpeg'))).toBe('jpg');
	});

	it('defaults to png when the source says nothing useful', () => {
		expect(defaultExtensionFor(makeImg('https://example.com/render'))).toBe('png');
	});

	it('always calls an svg element svg', () => {
		expect(defaultExtensionFor(makeSvg())).toBe('svg');
	});
});
