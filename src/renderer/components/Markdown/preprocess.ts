/**
 * preprocessMarkdown - text-level rewrites applied to raw markdown before it
 * reaches react-markdown. Centralized so every surface preprocesses identically.
 *
 * Pipeline (order matters):
 *   1. fixMarkdownLinkSpaces - rewrite link destinations containing spaces so
 *      CommonMark can parse them (AI agents emit `[x](/path/with spaces/f.ts)`).
 *   2. convertBracketMath - (chat only) rewrite LaTeX `\(...\)` / `\[...\]`
 *      delimiters to `$$...$$` so inline/display math renders without enabling
 *      single-dollar math (which would misparse `$5` / `$HOME`).
 *   3. normalizeChatDisplayMath - (chat only) put `$$...$$` delimiters on their
 *      own lines so remark-math doesn't break the block fence (#622).
 *   4. hardBreakInlineFields - keep a block of Dataview-style `Key:: value`
 *      lines on separate lines instead of collapsing into one paragraph.
 *
 * Raw-HTML sanitization is intentionally NOT done here. It happens at the HAST
 * level via rehype-sanitize (see sanitizeSchema.ts), after remark has tokenized
 * code fences and inline code into text nodes. Sanitizing the raw markdown
 * string instead (the old DOMPurify pass) corrupted ordinary content -
 * `List<int>` collapsed to `List`, generics in code fences were eaten, and
 * `a < b` lost its operand.
 */

import { normalizeChatDisplayMath } from '../../../shared/normalizeChatDisplayMath';
import { convertBracketMath } from '../../../shared/convertBracketMath';
import { forEachMarkdownLine } from '../../../shared/markdownTaskScan';

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

// ============================================================================
// hardBreakInlineFields - keep Dataview-style inline fields on their own lines.
//
// Obsidian notes open with a run of `Key:: value` lines:
//
//   Type:: Briefing
//   Period:: AM
//   Date:: 2026-08-28
//
// CommonMark folds consecutive lines into one paragraph, so the preview renders
// that header as a single run-on sentence. Appending a hard break (two trailing
// spaces) to each line keeps the source shape without touching the text.
//
// A single field line is NOT enough to trigger this: prose that happens to
// contain `::` would break mid-paragraph. Only a RUN of two or more adjacent
// field lines counts as a field block, and the break also extends to the plain
// line immediately above or below the block so the block stays separated from
// surrounding prose.
// ============================================================================

/** `Key:: value` at the start of a line. The name may not contain a colon. */
const INLINE_FIELD_REGEX = /^ {0,3}[A-Za-z0-9_][A-Za-z0-9 _()/-]{0,40}::(?:\s|$)/;

/** Already ends in a hard break (two spaces or a trailing backslash). */
const HARD_BREAK_SUFFIX_REGEX = / {2,}$|\\$/;

export function hardBreakInlineFields(text: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');

	// Fence-aware: a code fence documenting `Key:: value` must not be rewritten.
	const isField: boolean[] = new Array(lines.length).fill(false);
	forEachMarkdownLine(text, (line, index) => {
		isField[index] = INLINE_FIELD_REGEX.test(line);
	});

	const inFieldBlock = isField.map(
		(field, i) => field && (isField[i - 1] === true || isField[i + 1] === true)
	);

	let changed = false;
	for (let i = 0; i < lines.length - 1; i++) {
		if (!inFieldBlock[i] && !inFieldBlock[i + 1]) continue;
		if (lines[i].trim() === '' || lines[i + 1].trim() === '') continue;
		if (HARD_BREAK_SUFFIX_REGEX.test(lines[i])) continue;
		lines[i] += '  ';
		changed = true;
	}

	return changed ? lines.join('\n') : text;
}

export interface PreprocessMarkdownOptions {
	/** Chat surfaces normalize multi-line `$$...$$` before remark-math parses. */
	chatMath?: boolean;
}

export function preprocessMarkdown(
	content: string,
	options: PreprocessMarkdownOptions = {}
): string {
	let processed = fixMarkdownLinkSpaces(content);
	if (options.chatMath) {
		// Bracket conversion first: it emits `$$...$$` that the normalizer tidies.
		processed = convertBracketMath(processed);
		processed = normalizeChatDisplayMath(processed);
	}
	return hardBreakInlineFields(processed);
}
