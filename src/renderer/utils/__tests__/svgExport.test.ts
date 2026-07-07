/**
 * Tests for svgExport utility (serialize + download of inline chat SVGs).
 *
 * The canvas/Image rasterization path (svgToPngDataUrl / copySvgToClipboard PNG
 * branch) is intentionally not covered here: jsdom does not render <canvas> or
 * fire Image.onload, so it can't be exercised meaningfully. We cover the
 * deterministic DOM-string logic instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { serializeSvg, downloadSvg } from '../svgExport';

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
