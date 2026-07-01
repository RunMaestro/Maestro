/**
 * svgSanitizeSchema - the hast-util-sanitize schema used by rehype-sanitize when
 * a surface opts into raw HTML (`allowRawHtml`). It extends the GitHub default
 * schema to additionally permit inline `<svg>` and its presentation elements so
 * agents can render diagrams, badges, and illustrations directly in chat, while
 * still stripping XSS vectors (`<script>`, event handlers, `<foreignObject>`,
 * `javascript:` URLs, etc.).
 *
 * Because the chat preset defaults `allowRawHtml` on, this schema also runs over
 * ALL chat markdown - not just raw HTML - so it must be a superset of what
 * Maestro's own transforms emit: the `data-maestro-*` attributes that drive file
 * links / previews (remarkFileLinks), the `markdown-alert-*` classes (remarkAlert),
 * and Maestro's internal URL schemes (`maestro:`, `maestro-file:`, `file:`, `tel:`).
 * The GitHub default strips all of these, which silently breaks file links,
 * images, and callouts - so they are re-allowed below.
 *
 * Why sanitize at the HAST level (here) instead of on the raw markdown string:
 * running DOMPurify over the raw text mangles ordinary content - `List<int>`
 * becomes `List`, generics inside code fences get eaten, and `a < b` loses its
 * operand. rehype-sanitize runs AFTER remark has already tokenized code fences
 * and inline code into text nodes, so only genuine HTML elements are inspected.
 *
 * SVG/data attribute names use their hast (camelCased) forms because rehype-raw
 * parses markup through property-information's schema (e.g. `viewBox`,
 * `strokeWidth`, `stopColor`, `dataMaestroFile`). Adding the lowercase/dashed
 * HTML spellings would be a no-op.
 */

import { defaultSchema } from 'rehype-sanitize';
import type { Schema } from 'hast-util-sanitize';

/** SVG container + presentation element tag names (hast tagName form). */
const SVG_TAG_NAMES = [
	'svg',
	'g',
	'path',
	'rect',
	'circle',
	'ellipse',
	'line',
	'polyline',
	'polygon',
	'text',
	'tspan',
	'textPath',
	'defs',
	'linearGradient',
	'radialGradient',
	'stop',
	'clipPath',
	'mask',
	'pattern',
	'use',
	'symbol',
	'marker',
	'filter',
	'feGaussianBlur',
	'feOffset',
	'feMerge',
	'feMergeNode',
	'feColorMatrix',
	'feBlend',
	'feFlood',
	'feComposite',
	'title',
	'desc',
	// Not in the GitHub default schema, but common in agent output for inline
	// highlights.
	'mark',
];

/**
 * `data-maestro-*` attributes (hast camelCase form) that Maestro's own remark
 * transforms emit to drive behavior: file links / previews, image loading, and
 * inline-width hints. The GitHub default schema strips all data attributes, so
 * without these, clickable file links and local images silently break in chat.
 */
const MAESTRO_DATA_ATTRIBUTES = [
	'dataMaestroFile',
	'dataMaestroFromTree',
	'dataMaestroImage',
	'dataMaestroWidth',
];

/**
 * SVG presentation + geometry attributes allowed on any element. `href`/
 * `xlinkHref` are deliberately excluded here and instead governed by the
 * protocol allow-list below so `javascript:` links inside `<a>`/`<use>` are
 * stripped. `style` is deliberately NOT allowed: it's the classic inline-CSS
 * XSS vector (`background:url(javascript:...)`), and presentation attributes
 * (fill, stroke, etc.) cover legitimate SVG styling.
 */
const SVG_ATTRIBUTES = [
	'viewBox',
	'xmlns',
	'xmlnsXlink',
	'preserveAspectRatio',
	'fill',
	'fillOpacity',
	'fillRule',
	'stroke',
	'strokeWidth',
	'strokeLinecap',
	'strokeLinejoin',
	'strokeDasharray',
	'strokeDashoffset',
	'strokeOpacity',
	'strokeMiterlimit',
	'opacity',
	'transform',
	'gradientUnits',
	'gradientTransform',
	'spreadMethod',
	'offset',
	'stopColor',
	'stopOpacity',
	'd',
	'cx',
	'cy',
	'r',
	'rx',
	'ry',
	'x',
	'y',
	'x1',
	'y1',
	'x2',
	'y2',
	'fx',
	'fy',
	'points',
	'width',
	'height',
	'fontSize',
	'fontFamily',
	'fontWeight',
	'fontStyle',
	'textAnchor',
	'dominantBaseline',
	'letterSpacing',
	'clipPath',
	'clipRule',
	'mask',
	'markerStart',
	'markerMid',
	'markerEnd',
	'markerWidth',
	'markerHeight',
	'refX',
	'refY',
	'orient',
	'patternUnits',
	'patternContentUnits',
	'maskUnits',
	'maskContentUnits',
	'filterUnits',
	'result',
	'in',
	'in2',
	'stdDeviation',
	'dx',
	'dy',
	'mode',
	'values',
	'type',
	'id',
	'className',
	'role',
];

export const svgSanitizeSchema: Schema = {
	...defaultSchema,
	tagNames: [...(defaultSchema.tagNames ?? []), ...SVG_TAG_NAMES],
	attributes: {
		...defaultSchema.attributes,
		'*': [
			...(defaultSchema.attributes?.['*'] ?? []),
			...SVG_ATTRIBUTES,
			...MAESTRO_DATA_ATTRIBUTES,
		],
	},
	// Do not clobber (prefix) `id`. The GitHub default rewrites `id="g"` to
	// `id="user-content-g"` to prevent DOM clobbering, but it does NOT rewrite the
	// matching `url(#g)` reference in a fill/clip/mask attribute, so SVG gradients,
	// clip-paths, and markers break. We drop `id` from the clobber list (keeping
	// aria/name clobbering) so intra-SVG references resolve. Chat renders no code
	// that trusts user-content element ids, so the DOM-clobbering risk is moot.
	clobber: (defaultSchema.clobber ?? []).filter((name) => name !== 'id'),
	// Restrict SVG `<a>`/`<use>` linkable attributes to safe protocols (no
	// `javascript:`), while re-allowing Maestro's internal URL schemes on `href`/
	// `src` so `maestro:`, `maestro-file:`, `file:`, and `tel:` links + local
	// images survive (matching urlTransformAllowingMaestro). `#` keeps
	// `fill="url(#grad)"` targets and same-document anchors working.
	protocols: {
		...defaultSchema.protocols,
		href: [...(defaultSchema.protocols?.href ?? []), 'maestro', 'maestro-file', 'file', 'tel', '#'],
		src: [...(defaultSchema.protocols?.src ?? []), 'maestro', 'maestro-file', 'file'],
		xlinkHref: ['http', 'https', '#'],
	},
};
