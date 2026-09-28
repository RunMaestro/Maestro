import type { ParserInstance, ParserToken } from './parser';
import { ALERT_LABELS, alertIconMarkup } from '../../Markdown/alertMeta';
import type { AlertType } from '../../Markdown/remarkAlert';

/**
 * Fast-tier counterpart to `remarkAlert`: turns a blockquote whose first line is
 * `[!NOTE]` (or TIP, IMPORTANT, WARNING, CAUTION) into a styled callout.
 *
 * The Rich path tags the blockquote with a class and lets `<AlertCallout>` draw
 * the header. The Fast path has no React - it renders markdown-it tokens to HTML
 * strings - so it tags the same class AND injects the header markup as an
 * `html_block` token. Labels and icon geometry come from the shared
 * `alertMeta` module, so the two tiers cannot drift.
 *
 * Colors stay out of here: the header uses `currentColor` and the generated
 * stylesheet (`proseStyles.ts`) supplies the per-type accent, which keeps this
 * transform pure and theme-independent so `buildBlocks` stays cacheable.
 *
 * Matching mirrors GitHub and `remarkAlert`: the marker must stand alone on the
 * blockquote's first line, so `> [!NOTE] some title` stays a plain blockquote.
 */

/** Alert marker alone on the first line: `[!TYPE]` + optional trailing spaces. */
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i;

/** Class applied to the injected header row. */
export const ALERT_TITLE_CLASS = 'markdown-alert-title';

function headerHtml(type: AlertType): string {
	return `<div class="${ALERT_TITLE_CLASS}">${alertIconMarkup(type)}<span>${ALERT_LABELS[type]}</span></div>`;
}

/**
 * Strip the marker line from the paragraph's inline token, both from its
 * rendered `content` and from the text child the renderer actually emits.
 * Returns false when the token shape is unexpected, leaving the quote alone.
 */
function stripMarker(inline: ParserToken, markerLength: number): boolean {
	const child = inline.children?.[0];
	if (!child || child.type !== 'text') return false;

	// The marker and the first line of the body share one text child, so slicing
	// the matched prefix off both keeps content and children in agreement.
	child.content = child.content.slice(markerLength);
	inline.content = inline.content.slice(markerLength);

	// A marker-only first line leaves an empty text child followed by a softbreak
	// that would render as a blank line above the body.
	if (!child.content && inline.children?.[1]?.type === 'softbreak') {
		inline.children.splice(0, 2);
	}
	return true;
}

/**
 * Detect and tag alert blockquotes in place. Returns the number tagged (used by
 * tests; callers can ignore it).
 */
export function applyAlertCallouts(md: ParserInstance, tokens: ParserToken[]): number {
	let tagged = 0;

	for (let i = 0; i < tokens.length; i++) {
		const open = tokens[i];
		if (open.type !== 'blockquote_open') continue;
		if (tokens[i + 1]?.type !== 'paragraph_open') continue;

		const inline = tokens[i + 2];
		if (!inline || inline.type !== 'inline') continue;

		const match = inline.content.match(ALERT_RE);
		if (!match) continue;

		const type = match[1].toLowerCase() as AlertType;
		if (!stripMarker(inline, match[0].length)) continue;

		open.attrJoin('class', `markdown-alert markdown-alert-${type}`);
		open.attrSet('data-alert-type', type);

		// markdown-it does not export the Token class on the public surface, so
		// reuse the constructor from a token we already have. Every parser token
		// is an instance of the same class, so this is safe.
		const TokenCtor = open.constructor as new (
			type: string,
			tag: string,
			nesting: number
		) => ParserToken;
		const header = new TokenCtor('html_block', '', 0);
		header.content = headerHtml(type);
		header.level = open.level + 1;
		tokens.splice(i + 1, 0, header);
		i++;
		tagged++;
	}

	void md;
	return tagged;
}
