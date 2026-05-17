import { escapeHtml } from './escapeHtml';
import {
	parseYamlKeyValues as sharedParseYamlKeyValues,
	type FrontmatterEntry,
} from '../../../utils/frontmatterYamlParser';

/**
 * Frontmatter handling for the Fast tier.
 *
 * Maps to the Rich-path stack of `remark-frontmatter` + `remarkFrontmatterTable`:
 * given a YAML block at the head of a markdown document, we strip it out of
 * the source and render it as a small "Document metadata:" HTML table that
 * gets prepended to the block list.
 *
 * markdown-it has no native frontmatter support, so the split + render happen
 * before markdown-it sees the body.
 */

/** Matches a YAML frontmatter block at the very start of a document. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export type { FrontmatterEntry };

/**
 * Re-exported for callers (and tests) that depended on the previous location.
 * Delegates to the shared parser used by the Rich tier so both stay in lockstep.
 */
export const parseYamlKeyValues = sharedParseYamlKeyValues;

/** A YAML value is treated as a URL when it begins with http:// or https://. */
function isUrl(value: string): boolean {
	return /^https?:\/\//.test(value);
}

/** Escape HTML, then convert newlines into <br> so multi-line block scalars render. */
function escapeMultiline(value: string): string {
	return escapeHtml(value).replace(/\n/g, '<br>');
}

/**
 * Render an array of frontmatter entries as a "Document metadata" HTML
 * fragment (paragraph header + 2-column table). Returns `null` when the
 * entries array is empty so callers can drop the frontmatter section entirely.
 */
export function renderFrontmatterHtml(entries: FrontmatterEntry[]): string | null {
	if (entries.length === 0) return null;

	const rows = entries
		.map(({ key, value }) => {
			let valueCell: string;
			if (isUrl(value)) {
				const display = value.length > 50 ? value.slice(0, 47) + '...' : value;
				valueCell = `<a href="${escapeHtml(value)}" title="${escapeHtml(value)}">${escapeHtml(
					display
				)}</a>`;
			} else {
				valueCell = escapeMultiline(value);
			}
			return `<tr><td><strong>${escapeHtml(key)}</strong></td><td>${valueCell}</td></tr>`;
		})
		.join('');

	return `<p><em>Document metadata:</em></p><table>${rows}</table>`;
}

export interface SplitFrontmatterResult {
	/** Rendered HTML for the frontmatter, or null when there is none / it was empty. */
	frontmatterHtml: string | null;
	/** Document body with the frontmatter block removed. */
	body: string;
}

/**
 * Split a markdown source into its frontmatter and body. Frontmatter is
 * parsed, rendered to HTML, and returned alongside the body that should be
 * handed to markdown-it.
 */
export function splitFrontmatter(content: string): SplitFrontmatterResult {
	const match = FRONTMATTER_RE.exec(content);
	if (!match) return { frontmatterHtml: null, body: content };
	const entries = parseYamlKeyValues(match[1]);
	return {
		frontmatterHtml: renderFrontmatterHtml(entries),
		body: content.slice(match[0].length),
	};
}
