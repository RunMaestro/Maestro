import type { Theme } from '../../../constants/themes';

/** CSS class applied to each rendered page by the component. */
export const TEXT_PAGE_CLASS = 'text-fast-page';

/** CSS class applied to the line-number gutter inside each page. */
export const TEXT_PAGE_GUTTER_CLASS = 'text-fast-gutter';

/** CSS class applied to the line-content column inside each page. */
export const TEXT_PAGE_CONTENT_CLASS = 'text-fast-content';

/**
 * Generate the scoped stylesheet for the Fast tier text preview.
 *
 * Each page is a 2-column grid: a fixed-width line-number gutter on the left,
 * a flexible whitespace-pre content column on the right. Both columns share a
 * monospace font, theme-aware colors, and a fixed line-height so virtualizer
 * page heights are predictable.
 *
 * Lives in its own module so the styling decisions are independently
 * unit-testable (string-contains assertions against the generated CSS).
 */
export function generateTextProseCss(theme: Theme): string {
	const c = theme.colors;
	return `
		.${TEXT_PAGE_CLASS} {
			display: grid;
			grid-template-columns: auto 1fr;
			font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
			font-size: 13px;
			line-height: 1.6;
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
