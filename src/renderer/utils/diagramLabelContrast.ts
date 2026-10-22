/**
 * Keep every node label in a rendered diagram legible against its OWN fill.
 *
 * `initMermaid` derives label colors against the fills it knows about (the
 * theme's node, palette, and section colors). It cannot know about fills the
 * diagram AUTHOR sets: `style A fill:#f9e79f` or `classDef warn fill:#f9e79f`
 * without a matching `color:` leaves the label on the theme's text color. On a
 * dark theme that is a near-white label on a pale yellow box, which is what an
 * agent emits every time it color-codes an attack chain or a status diagram.
 *
 * So after the SVG is in the document, each node and cluster is measured as
 * painted: the resolved fill of its shape against the resolved color of every
 * text element in its label. A pair that fails WCAG AA has the label rewritten
 * through `readableTextOn`, which nudges the existing color rather than snapping
 * to black or white. Pairs that already pass are untouched, so a diagram that
 * reads fine renders exactly as mermaid drew it.
 *
 * Runs on the live DOM because `classDef` fills arrive through the diagram's
 * own `<style>` block, which only `getComputedStyle` resolves. Inline `!important`
 * is required to beat mermaid's own `!important` label rules.
 */

import {
	AA_CONTRAST,
	contrastRatio,
	cssColorToHex,
	readableTextOn,
} from '../../shared/colorContrast';

/** Groups mermaid draws a filled shape plus a label for. */
const CONTAINER_SELECTOR = 'g.node, g.cluster';

/** Shapes that can carry a node's fill (rough/handDrawn shapes are paths). */
const SHAPE_SELECTOR = 'rect, polygon, circle, ellipse, path';

/** A label's own background box lives inside it and is never the node fill. */
const LABEL_SELECTOR = '.label, .cluster-label, foreignObject, text';

/**
 * HTML labels (htmlLabels: true) live under a foreignObject; SVG labels are
 * text/tspan. The HTML side is collected in two steps rather than through a
 * `foreignObject *` selector: jsdom's selector engine cannot match the
 * camelCase SVG tag in a descendant or `closest()` selector, so the one-step
 * form finds nothing there while working in Chromium.
 */
const HTML_LABEL_ROOT_SELECTOR = 'foreignObject';
const SVG_TEXT_SELECTOR = 'text, tspan';

function htmlLabelElements(container: Element): Element[] {
	return Array.from(container.querySelectorAll(HTML_LABEL_ROOT_SELECTOR)).flatMap((root) =>
		Array.from(root.querySelectorAll('*'))
	);
}

function ownedBy(el: Element, container: Element): boolean {
	return el.closest(CONTAINER_SELECTOR) === container;
}

function hasOwnText(el: Element): boolean {
	return Array.from(el.childNodes).some(
		(child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== ''
	);
}

/** The first opaque fill painted by the container's shape, or null. */
function resolveShapeFill(container: Element, view: Window): string | null {
	for (const shape of Array.from(container.querySelectorAll(SHAPE_SELECTOR))) {
		if (!ownedBy(shape, container)) continue;
		const labelAncestor = shape.parentElement?.closest(LABEL_SELECTOR);
		if (labelAncestor && container.contains(labelAncestor)) continue;
		const fill = cssColorToHex(view.getComputedStyle(shape).fill);
		if (fill) return fill;
	}
	return null;
}

function repairText(el: Element, property: 'color' | 'fill', fill: string, view: Window): boolean {
	const current = cssColorToHex(view.getComputedStyle(el).getPropertyValue(property));
	if (!current || contrastRatio(current, fill) >= AA_CONTRAST) return false;
	(el as HTMLElement | SVGElement).style.setProperty(
		property,
		readableTextOn(current, [fill]),
		'important'
	);
	return true;
}

/**
 * Rewrite any node or cluster label that fails WCAG AA against its own fill.
 * Must run after the SVG is attached to a document. Returns how many text
 * elements were recolored (0 when everything already reads).
 */
export function repairDiagramLabelContrast(svg: SVGSVGElement): number {
	const view = svg.ownerDocument?.defaultView;
	if (!view) return 0;

	let repaired = 0;
	for (const container of Array.from(svg.querySelectorAll(CONTAINER_SELECTOR))) {
		const fill = resolveShapeFill(container, view);
		if (!fill) continue;

		for (const el of htmlLabelElements(container)) {
			if (ownedBy(el, container) && hasOwnText(el) && repairText(el, 'color', fill, view)) {
				repaired++;
			}
		}
		for (const el of Array.from(container.querySelectorAll(SVG_TEXT_SELECTOR))) {
			if (ownedBy(el, container) && hasOwnText(el) && repairText(el, 'fill', fill, view)) {
				repaired++;
			}
		}
	}
	return repaired;
}
