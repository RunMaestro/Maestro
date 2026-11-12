import type { Theme } from '../../../constants/themes';

/** CSS class applied to each rendered page by the component. */
export const TEXT_PAGE_CLASS = 'text-fast-page';

/** CSS class applied to the line-number gutter inside each page. */
export const TEXT_PAGE_GUTTER_CLASS = 'text-fast-gutter';

/** CSS class applied to the line-content column inside each page. */
export const TEXT_PAGE_CONTENT_CLASS = 'text-fast-content';

/** Unzoomed page font size, in CSS pixels. */
export const TEXT_BASE_FONT_PX = 13;

/** Page line-height multiplier. Fixed so page heights stay predictable. */
export const TEXT_LINE_HEIGHT = 1.6;

/**
 * Generate the scoped stylesheet for the Fast tier text preview.
 *
 * Each page is a 2-column grid: a fixed-width line-number gutter on the left,
 * a flexible whitespace-pre content column on the right. Both columns share a
 * monospace font, theme-aware colors, and a fixed line-height so virtualizer
 * page heights are predictable.
 *
 * `fontScale` is the reader's font zoom. It multiplies the base size here and
 * the virtualizer's page height in the component - the two MUST use the same
 * number, or the fixed-size virtualization drifts against what is painted.
 *
 * The font is inherited from the pane rather than pinned here, so the File
 * Preview font setting reaches this tier the same way it reaches the markdown
 * tiers. The pane's own value already carries a monospace fallback chain, so an
 * unset setting still lands on monospace - it is now the interface font's
 * chain rather than a second copy of it that could drift.
 *
 * Lives in its own module so the styling decisions are independently
 * unit-testable (string-contains assertions against the generated CSS).
 */
export function generateTextProseCss(
	theme: Theme,
	fontScale = 1,
	baseFontPx: number = TEXT_BASE_FONT_PX
): string {
	const c = theme.colors;
	return `
		.${TEXT_PAGE_CLASS} {
			display: grid;
			grid-template-columns: auto 1fr;
			font-family: inherit;
			font-size: ${Math.round(baseFontPx * fontScale * 10) / 10}px;
			line-height: ${TEXT_LINE_HEIGHT};
			color: ${c.textMain};
		}
		.${TEXT_PAGE_GUTTER_CLASS} {
			user-select: none;
			padding: 0 12px 0 16px;
			text-align: right;
			color: ${c.textDim};
			opacity: 0.7;
			border-right: 1px solid ${c.border};
			background-color: ${c.bgActivity};
			white-space: pre;
		}
		.${TEXT_PAGE_CONTENT_CLASS} {
			padding: 0 16px;
			white-space: pre;
			overflow-x: auto;
		}
		.${TEXT_PAGE_CONTENT_CLASS} pre {
			margin: 0;
			padding: 0;
			background: transparent;
			color: inherit;
			font-family: inherit;
			font-size: inherit;
			line-height: inherit;
		}
		.${TEXT_PAGE_CONTENT_CLASS} pre code {
			background: transparent;
			padding: 0;
			font-family: inherit;
			font-size: inherit;
		}
	`;
}
