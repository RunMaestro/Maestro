/**
 * Grow a rendered SVG's viewBox so content that spills outside it stays visible.
 *
 * Most mermaid diagram types size their viewBox from the laid-out content
 * (`setupGraphViewbox` calls `getBBox()` and pads it), so nothing is ever
 * clipped. A few do not: `quadrantChart` hard-codes `viewBox="0 0 500 500"`
 * from `chartWidth`/`chartHeight` and then draws the title centered at x=250
 * and the point labels wherever the data puts them. A title longer than 500
 * user units, or a data point near x=1.0 with a long label, is painted outside
 * the viewport and the browser clips it at the SVG boundary: the visible damage
 * is a chart title that reads ":y leverage (NetworkChuck omitted, off the" with
 * both ends sliced off, and edge labels missing their last characters.
 *
 * The fix is not `overflow: visible` - that would let the diagram paint over
 * the surrounding chat text. Instead the viewBox is widened to the union of its
 * declared box and the real content bounds, and the size attributes are scaled
 * by the same factor so the diagram renders at its original scale rather than
 * shrinking to fit the new box.
 *
 * Diagrams whose content already fits are left completely untouched, so this is
 * a no-op for flowcharts, sequence diagrams, and everything else that sizes
 * itself correctly.
 */

/** Slack in user units before a difference counts as an overflow. */
const OVERFLOW_TOLERANCE = 0.5;

/** Extra user units of breathing room added around overflowing content. */
const DEFAULT_PADDING = 4;

/** Parse a plain px/unitless length. Returns null for `100%`, `auto`, or junk. */
function parseLength(value: string | null): number | null {
	if (!value) return null;
	const match = /^\s*(-?\d*\.?\d+)(px)?\s*$/.exec(value);
	if (!match) return null;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Expand `svg`'s viewBox to cover its actual content bounds.
 *
 * Must run after the element is in the document: `getBBox()` needs a layout.
 * Returns true when the viewBox was changed.
 */
export function expandSvgViewBoxToContent(
	svg: SVGSVGElement,
	padding: number = DEFAULT_PADDING
): boolean {
	const raw = svg.getAttribute('viewBox');
	if (!raw) return false;

	const parts = raw
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	if (parts.length !== 4 || !parts.every((n) => Number.isFinite(n))) return false;
	const [vx, vy, vw, vh] = parts;
	if (vw <= 0 || vh <= 0) return false;

	// jsdom has no getBBox at all, and a detached or display:none SVG throws.
	// Either way there is nothing to measure, so leave the diagram as mermaid
	// produced it.
	let box: DOMRect | null = null;
	try {
		box = typeof svg.getBBox === 'function' ? svg.getBBox() : null;
	} catch {
		return false;
	}
	if (!box) return false;
	if (![box.x, box.y, box.width, box.height].every((n) => Number.isFinite(n))) return false;
	if (box.width <= 0 || box.height <= 0) return false;

	// Pad only the sides that actually overflow. Padding unconditionally would
	// nudge every edge outward on a diagram whose content exactly fills its
	// box, which then trips the overflow check below and rescales a diagram
	// that was already correct.
	const boxRight = box.x + box.width;
	const boxBottom = box.y + box.height;
	const minX = box.x < vx ? box.x - padding : vx;
	const minY = box.y < vy ? box.y - padding : vy;
	const maxX = boxRight > vx + vw ? boxRight + padding : vx + vw;
	const maxY = boxBottom > vy + vh ? boxBottom + padding : vy + vh;
	const width = maxX - minX;
	const height = maxY - minY;

	if (width <= vw + OVERFLOW_TOLERANCE && height <= vh + OVERFLOW_TOLERANCE) return false;

	svg.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);

	// Scale the rendered size by the larger growth factor so the diagram keeps
	// its original on-screen scale instead of shrinking to fit the wider box.
	const scale = Math.max(width / vw, height / vh);

	const maxWidth = parseLength(svg.style.maxWidth);
	if (maxWidth !== null) svg.style.maxWidth = `${maxWidth * scale}px`;

	const widthAttr = parseLength(svg.getAttribute('width'));
	if (widthAttr !== null) svg.setAttribute('width', String(widthAttr * scale));

	const heightAttr = parseLength(svg.getAttribute('height'));
	if (heightAttr !== null) svg.setAttribute('height', String(heightAttr * scale));

	return true;
}
