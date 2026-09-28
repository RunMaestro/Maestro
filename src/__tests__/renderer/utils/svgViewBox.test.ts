import { describe, it, expect } from 'vitest';
import { expandSvgViewBoxToContent } from '../../../renderer/utils/svgViewBox';

/**
 * Build an SVG element with a stubbed `getBBox`. jsdom implements no SVG
 * geometry at all, so the content bounds have to be supplied by hand.
 */
function makeSvg(
	attrs: Record<string, string>,
	bbox: { x: number; y: number; width: number; height: number } | 'throws' | 'missing'
): SVGSVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);

	if (bbox === 'throws') {
		(svg as unknown as { getBBox: () => DOMRect }).getBBox = () => {
			throw new Error('Element not rendered');
		};
	} else if (bbox !== 'missing') {
		(svg as unknown as { getBBox: () => DOMRect }).getBBox = () => bbox as DOMRect;
	}

	return svg;
}

describe('expandSvgViewBoxToContent', () => {
	it('widens a quadrantChart viewBox around a title that overflows both sides', () => {
		// mermaid's quadrantChart: fixed 500x500 box, title centered at x=250.
		const svg = makeSvg(
			{ viewBox: '0 0 500 500', width: '100%', style: 'max-width: 500px;' },
			{ x: -120, y: 0, width: 740, height: 500 }
		);

		expect(expandSvgViewBoxToContent(svg, 4)).toBe(true);
		expect(svg.getAttribute('viewBox')).toBe('-124 0 748 500');
		// 748/500 = 1.496, so the diagram keeps its original scale.
		expect(svg.style.maxWidth).toBe('748px');
	});

	it('leaves a diagram alone when its content already fits', () => {
		const svg = makeSvg(
			{ viewBox: '0 0 500 500', style: 'max-width: 500px;' },
			{
				x: 10,
				y: 10,
				width: 480,
				height: 480,
			}
		);

		expect(expandSvgViewBoxToContent(svg)).toBe(false);
		expect(svg.getAttribute('viewBox')).toBe('0 0 500 500');
		expect(svg.style.maxWidth).toBe('500px');
	});

	it('scales explicit width/height attributes by the same factor', () => {
		const svg = makeSvg(
			{ viewBox: '0 0 100 200', width: '100', height: '200' },
			{
				x: 0,
				y: 0,
				width: 150,
				height: 200,
			}
		);

		expect(expandSvgViewBoxToContent(svg, 0)).toBe(true);
		expect(svg.getAttribute('viewBox')).toBe('0 0 150 200');
		expect(svg.getAttribute('width')).toBe('150');
		expect(svg.getAttribute('height')).toBe('300');
	});

	it('does nothing when getBBox is unavailable or throws', () => {
		const missing = makeSvg({ viewBox: '0 0 500 500' }, 'missing');
		expect(expandSvgViewBoxToContent(missing)).toBe(false);
		expect(missing.getAttribute('viewBox')).toBe('0 0 500 500');

		const throws = makeSvg({ viewBox: '0 0 500 500' }, 'throws');
		expect(expandSvgViewBoxToContent(throws)).toBe(false);
		expect(throws.getAttribute('viewBox')).toBe('0 0 500 500');
	});

	it('ignores a missing, malformed, or degenerate viewBox', () => {
		const bbox = { x: -50, y: -50, width: 900, height: 900 };

		const none = makeSvg({}, bbox);
		expect(expandSvgViewBoxToContent(none)).toBe(false);

		const malformed = makeSvg({ viewBox: '0 0 500' }, bbox);
		expect(expandSvgViewBoxToContent(malformed)).toBe(false);
		expect(malformed.getAttribute('viewBox')).toBe('0 0 500');

		const zeroWidth = makeSvg({ viewBox: '0 0 0 500' }, bbox);
		expect(expandSvgViewBoxToContent(zeroWidth)).toBe(false);
	});

	it('ignores an empty content box', () => {
		const svg = makeSvg({ viewBox: '0 0 500 500' }, { x: 0, y: 0, width: 0, height: 0 });
		expect(expandSvgViewBoxToContent(svg)).toBe(false);
		expect(svg.getAttribute('viewBox')).toBe('0 0 500 500');
	});
});
