import GithubSlugger from 'github-slugger';
import type { ParserInstance, ParserToken } from './parser';

/**
 * Inject `id="<slug>"` attributes onto heading tokens so:
 *   1. The TOC can find a heading's block by scanning rendered HTML.
 *   2. In-document `#anchor` links work once a block is mounted.
 *   3. Slugs are stable / unique across a document (the slugger appends
 *      `-1`, `-2`, ... for duplicates, matching `extractHeadings`).
 *
 * markdown-it's tokenizer represents headings as a `heading_open` token
 * followed by an `inline` token (whose children carry the heading text)
 * followed by a `heading_close`. We extract the inline text, slugify it,
 * and add an `id` attribute on the `heading_open` token.
 *
 * Lives in its own module so the slugging strategy can be unit-tested
 * without involving markdown-it's full rendering pipeline.
 */
export function applyHeadingSlugs(md: ParserInstance, tokens: ParserToken[]): void {
	const slugger = new GithubSlugger();

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok.type !== 'heading_open') continue;

		const inline = tokens[i + 1];
		if (!inline || inline.type !== 'inline') continue;

		const text = (inline.content ?? '').trim();
		if (!text) continue;

		const slug = slugger.slug(text);
		// markdown-it's Token.attrSet adds or replaces an attribute.
		tok.attrSet('id', slug);
	}

	// Mark md as used so this stays a single-responsibility plugin even if we
	// later need parser options. (Currently we only need the tokens themselves.)
	void md;
}
