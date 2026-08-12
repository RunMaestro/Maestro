import MarkdownIt from 'markdown-it';

/**
 * Single source of truth for the markdown-it instance used by the Fast tier.
 *
 * Options chosen to roughly match the Rich-path's behavior:
 * - `html: true` mirrors `rehype-raw` (raw HTML passthrough).
 *   Sanitization happens downstream in `sanitize.ts`, so this is safe.
 * - `linkify: true` auto-detects bare URLs in text.
 * - `breaks: false` matches commonmark line-break semantics (rich path also
 *   uses commonmark-compatible breaks).
 * - `typographer: false` keeps output predictable and stable across themes.
 *
 * Creating fresh instances per parse is intentional - markdown-it is cheap to
 * construct (sub-millisecond) and per-instance state would otherwise need to
 * be reset between parses.
 */
export function createParser(): MarkdownIt {
	return new MarkdownIt({
		html: true,
		linkify: true,
		breaks: false,
		typographer: false,
	});
}

export type ParserInstance = MarkdownIt;
export type ParserToken = ReturnType<MarkdownIt['parse']>[number];
