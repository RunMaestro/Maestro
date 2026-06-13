/**
 * preprocessMarkdown - text-level rewrites applied to raw markdown before it
 * reaches react-markdown. Centralized so every surface preprocesses identically.
 *
 * Pipeline (order matters):
 *   1. fixMarkdownLinkSpaces - rewrite link destinations containing spaces so
 *      CommonMark can parse them (AI agents emit `[x](/path/with spaces/f.ts)`).
 *   2. normalizeChatDisplayMath - (chat only) put `$$...$$` delimiters on their
 *      own lines so remark-math doesn't break the block fence (#622).
 *   3. DOMPurify.sanitize - (raw-HTML surfaces only) strip script tags, event
 *      handlers, and other XSS vectors before parsing.
 */

import DOMPurify from 'dompurify';
import { normalizeChatDisplayMath } from '../../../shared/normalizeChatDisplayMath';

// ============================================================================
// fixMarkdownLinkSpaces - pre-process markdown so CommonMark can parse links
// whose URL destinations contain spaces.
//
// CommonMark rejects spaces in link destinations, but AI agents (e.g. Codex)
// often emit links like [file.ts](/path/with spaces/file.ts).
//
// Strategy: walk the text looking for [label]( patterns, then find the balanced
// closing ), and if the URL portion contains spaces, rewrite to CommonMark's
// angle-bracket destination syntax: [label](<url>).
//
// This handles:
//   - Nested brackets in labels:  [src/[id].tsx](path with spaces)
//   - Balanced parens in URLs:    [file](path (copy)/file.ts)
//   - Multiple links per line:    [a](x y) and [b](z w)
//   - No-op for URLs without spaces
// ============================================================================

// Matches a markdown link label (with one level of nested brackets) followed
// by the opening paren of the URL destination.
const LINK_LABEL_REGEX = /\[((?:[^\[\]]|\[[^\]]*\])*)\]\(/g;

export function fixMarkdownLinkSpaces(text: string): string {
	let result = '';
	let lastEnd = 0;
	let m;

	LINK_LABEL_REGEX.lastIndex = 0;
	while ((m = LINK_LABEL_REGEX.exec(text)) !== null) {
		const label = m[1];
		const urlStart = m.index + m[0].length;

		// Walk forward to find the closing ) with balanced parens
		let depth = 1;
		let i = urlStart;
		while (i < text.length && depth > 0) {
			if (text[i] === '(') depth++;
			else if (text[i] === ')') depth--;
			i++;
		}

		if (depth !== 0) continue; // Unbalanced - skip

		const url = text.slice(urlStart, i - 1); // Exclude closing )

		if (url.includes(' ')) {
			result += text.slice(lastEnd, m.index);
			if (url.includes('<') || url.includes('>')) {
				// Angle brackets in URL would break <url> syntax - fall back to %20
				result += `[${label}](${url.replace(/ /g, '%20')})`;
			} else {
				result += `[${label}](<${url}>)`;
			}
			lastEnd = i;
			LINK_LABEL_REGEX.lastIndex = i;
		}
	}

	result += text.slice(lastEnd);
	return result;
}

export interface PreprocessMarkdownOptions {
	/** Chat surfaces normalize multi-line `$$...$$` before remark-math parses. */
	chatMath?: boolean;
	/** Sanitize raw HTML with DOMPurify (defense-in-depth before markdown parse). */
	allowRawHtml?: boolean;
}

export function preprocessMarkdown(
	content: string,
	options: PreprocessMarkdownOptions = {}
): string {
	let processed = fixMarkdownLinkSpaces(content);
	if (options.chatMath) {
		processed = normalizeChatDisplayMath(processed);
	}
	// allowRawHtml means "accept raw HTML input, but sanitize it first": when a
	// surface opts into raw HTML (rehype-raw), DOMPurify strips script tags,
	// event handlers, and other XSS vectors before parsing (defense-in-depth).
	if (options.allowRawHtml) {
		processed = DOMPurify.sanitize(processed);
	}
	return processed;
}
