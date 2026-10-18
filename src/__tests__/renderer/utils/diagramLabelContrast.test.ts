import { afterEach, describe, expect, it } from 'vitest';
import { AA_CONTRAST, contrastRatio, cssColorToHex } from '../../../shared/colorContrast';
import { repairDiagramLabelContrast } from '../../../renderer/utils/diagramLabelContrast';

/**
 * Mount markup the way mermaid emits a flowchart node: a `g.node` holding the
 * shape and a `g.label` whose text lives in a foreignObject (htmlLabels) or in
 * an SVG `<text>`. jsdom has no layout, but it does resolve inline styles and
 * `<style>` rules through getComputedStyle, which is all the repair reads.
 * Colors sit on the text element itself because jsdom does not reliably
 * inherit `color`/`fill` the way Chromium does.
 */
function mountSvg(inner: string): SVGSVGElement {
	const host = document.createElement('div');
	host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
	document.body.appendChild(host);
	return host.querySelector('svg')!;
}

function htmlNode(fill: string, labelColor: string, text = 'artifactory · S4'): string {
	return `<g class="node default">
		<rect class="basic label-container" style="fill:${fill} !important"></rect>
		<g class="label"><rect></rect><foreignObject><div><span class="nodeLabel"><p style="color:${labelColor}">${text}</p></span></div></foreignObject></g>
	</g>`;
}

function measured(el: Element, property: 'color' | 'fill'): string {
	return cssColorToHex(getComputedStyle(el).getPropertyValue(property))!;
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('repairDiagramLabelContrast', () => {
	it('rescues a dark-theme label on an author-set pale fill (the reported regression)', () => {
		// `style S4 fill:#f9e79f` with no `color:` - the label kept the theme's
		// near-white text and read as yellow on yellow.
		const svg = mountSvg(htmlNode('#f9e79f', '#f8f8f2'));
		const p = svg.querySelector('p')!;

		expect(repairDiagramLabelContrast(svg)).toBe(1);
		expect(contrastRatio(measured(p, 'color'), '#f9e79f')).toBeGreaterThanOrEqual(AA_CONTRAST);
	});

	it('leaves a label alone when it already reads against its fill', () => {
		const svg = mountSvg(htmlNode('#282a36', '#f8f8f2'));
		const p = svg.querySelector('p')!;

		expect(repairDiagramLabelContrast(svg)).toBe(0);
		expect(p.getAttribute('style')).toBe('color:#f8f8f2');
	});

	it('measures each node against its OWN fill', () => {
		const svg = mountSvg(
			htmlNode('#f9e79f', '#f8f8f2', 'pale') +
				htmlNode('#1e1e2e', '#f8f8f2', 'dark') +
				htmlNode('#7cfc50', '#ffffff', 'green')
		);
		const [pale, dark, green] = Array.from(svg.querySelectorAll('p'));

		expect(repairDiagramLabelContrast(svg)).toBe(2);
		expect(contrastRatio(measured(pale, 'color'), '#f9e79f')).toBeGreaterThanOrEqual(AA_CONTRAST);
		expect(dark.getAttribute('style')).toBe('color:#f8f8f2');
		expect(contrastRatio(measured(green, 'color'), '#7cfc50')).toBeGreaterThanOrEqual(AA_CONTRAST);
	});

	it('resolves a classDef fill that only arrives through the diagram <style> block', () => {
		// Mermaid puts this rule in a `<style>` inside the `<svg>`. jsdom never
		// applies an SVG `<style>` (Chromium does), so the same rule goes in an
		// HTML `<style>`: the fill and color still reach the repair only through
		// getComputedStyle, never inline.
		const style = document.createElement('style');
		style.textContent = '.warn > rect { fill: #f9e79f; } .nodeLabel p { color: #eeeeee; }';
		document.body.appendChild(style);
		const svg = mountSvg(`<g class="node warn">
				<rect class="basic label-container"></rect>
				<g class="label"><foreignObject><div><span class="nodeLabel"><p>deploy-target host</p></span></div></foreignObject></g>
			</g>`);
		const p = svg.querySelector('p')!;

		expect(repairDiagramLabelContrast(svg)).toBe(1);
		expect(contrastRatio(measured(p, 'color'), '#f9e79f')).toBeGreaterThanOrEqual(AA_CONTRAST);
	});

	it('repairs SVG-text labels (htmlLabels: false) through fill', () => {
		const svg = mountSvg(`<g class="node">
			<polygon style="fill:#f9e79f"></polygon>
			<g class="label"><text><tspan style="fill:#f8f8f2">Z1 · impact</tspan></text></g>
		</g>`);
		const tspan = svg.querySelector('tspan')!;

		expect(repairDiagramLabelContrast(svg)).toBe(1);
		expect(contrastRatio(measured(tspan, 'fill'), '#f9e79f')).toBeGreaterThanOrEqual(AA_CONTRAST);
	});

	it('repairs subgraph (cluster) titles against the cluster fill', () => {
		const svg = mountSvg(`<g class="cluster">
			<rect style="fill:#fdebd0"></rect>
			<g class="cluster-label"><foreignObject><div><span class="nodeLabel"><p style="color:#f5f5f5">pivot</p></span></div></foreignObject></g>
		</g>`);
		const p = svg.querySelector('p')!;

		expect(repairDiagramLabelContrast(svg)).toBe(1);
		expect(contrastRatio(measured(p, 'color'), '#fdebd0')).toBeGreaterThanOrEqual(AA_CONTRAST);
	});

	it('ignores the label background box and skips fills it cannot measure', () => {
		// The label's own <rect> is transparent; a url() gradient has no single color.
		const svg = mountSvg(`<g class="node">
			<path style="fill:url(#grad)"></path>
			<g class="label"><rect style="fill:#ffffff"></rect><foreignObject><div><span><p style="color:#f8f8f2">x</p></span></div></foreignObject></g>
		</g>`);

		expect(repairDiagramLabelContrast(svg)).toBe(0);
		expect(svg.querySelector('p')!.getAttribute('style')).toBe('color:#f8f8f2');
	});
});
