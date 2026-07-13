/**
 * serializeSvg has to produce a *standalone* SVG. The tricky case is a diagram
 * that sizes itself with CSS (Mermaid emits width="100%" plus a max-width style):
 * serialized as-is it has no intrinsic size, so a browser renders it at the
 * 300x150 default and the rasterized PNG comes out cropped.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { serializeSvg } from '../../../renderer/utils/svgExport';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build an <svg> in the document with a stubbed rendered box. */
function mountSvg(attrs: Record<string, string>, box = { width: 400, height: 220 }): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
	svg.getBoundingClientRect = () => ({ width: box.width, height: box.height }) as DOMRect;
	document.body.appendChild(svg);
	return svg;
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('serializeSvg', () => {
	it('stamps the measured size onto a CSS-sized (Mermaid-style) diagram', () => {
		const svg = mountSvg({ id: 'mermaid-1', width: '100%', viewBox: '0 0 400 220' });
		svg.style.maxWidth = '400px';

		const out = serializeSvg(svg);

		expect(out).toContain('width="400"');
		expect(out).toContain('height="220"');
		// The viewBox is what turns the stamped size into a scale, not a crop.
		expect(out).toContain('viewBox="0 0 400 220"');
		expect(out).not.toContain('max-width');
	});

	it('synthesizes a viewBox when the source has neither size nor viewBox', () => {
		const svg = mountSvg({}, { width: 120, height: 60 });

		const out = serializeSvg(svg);

		expect(out).toContain('viewBox="0 0 120 60"');
		expect(out).toContain('width="120"');
		expect(out).toContain('height="60"');
	});

	it('leaves an explicitly sized SVG alone and adds the namespace', () => {
		const svg = mountSvg({ width: '100', height: '40', viewBox: '0 0 100 40' });
		svg.removeAttribute('xmlns');

		const out = serializeSvg(svg);

		expect(out).toContain('width="100"');
		expect(out).toContain('height="40"');
		expect(out).toContain(SVG_NS);
	});
});
