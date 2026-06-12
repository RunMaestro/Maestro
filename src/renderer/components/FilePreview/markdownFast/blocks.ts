import type { MarkdownBlock } from './types';
import type { ParserInstance, ParserToken } from './parser';

/**
 * Compute the byte offset of the start of each line in `source`. Returns an
 * array where `lineOffsets[i]` is the offset of the first char of line `i`
 * (0-indexed). The last entry is `source.length` for safety on out-of-range
 * line numbers from markdown-it's `map: [start, end]` tokens.
 */
export function buildLineOffsets(source: string): number[] {
	const out: number[] = [0];
	for (let i = 0; i < source.length; i++) {
		if (source.charCodeAt(i) === 10) {
			out.push(i + 1);
		}
	}
	out.push(source.length);
	return out;
}

export interface TokensToBlocksOptions {
	/**
	 * Optional line-offset table for the source string. Required to populate
	 * `sourceStart` / `sourceEnd` on each emitted block (used by Fast tier
	 * search). Build via `buildLineOffsets(body)`.
	 */
	lineOffsets?: number[];
}

/**
 * Group a markdown-it token stream into top-level blocks for virtualization.
 *
 * markdown-it emits a flat token stream where nesting is tracked by a `level`
 * field. Top-level blocks live at `level === 0`; anything between an opening
 * token (e.g. `paragraph_open`) and its matching `paragraph_close` at the
 * same level is one logical block.
 *
 * Standalone block-level tokens (`fence`, `hr`, `html_block`, `code_block`)
 * have no matching close and become their own block.
 *
 * Why blocks instead of nodes:
 *   - Virtuoso can mount/unmount blocks as they scroll into view without
 *     splitting inline content (a paragraph with 50 inline spans still
 *     mounts/unmounts atomically).
 *   - Layout is stable: heading + paragraph + list + table are the natural
 *     scroll units.
 *   - Rendering one block at a time is cheap (markdown-it's renderer is
 *     pure and stateless).
 */
export function tokensToBlocks(
	md: ParserInstance,
	tokens: ParserToken[],
	options: TokensToBlocksOptions = {}
): MarkdownBlock[] {
	const { lineOffsets } = options;
	const blocks: MarkdownBlock[] = [];
	let i = 0;
	let nextId = 0;

	const sourceRange = (tok: ParserToken): { sourceStart?: number; sourceEnd?: number } => {
		if (!lineOffsets || !tok.map) return {};
		const [startLine, endLine] = tok.map;
		const sourceStart = lineOffsets[startLine] ?? undefined;
		const sourceEnd = lineOffsets[endLine] ?? undefined;
		return { sourceStart, sourceEnd };
	};

	while (i < tokens.length) {
		const tok = tokens[i];

		// Skip nested tokens; their containing block will render them.
		if (tok.level !== 0) {
			i++;
			continue;
		}

		// Standalone block-level token (no matching close).
		if (!tok.type.endsWith('_open')) {
			const html = md.renderer.render([tok], md.options, {});
			blocks.push({ id: nextId++, html, ...sourceRange(tok) });
			i++;
			continue;
		}

		// Opening token at level 0; walk forward to its matching close.
		const openType = tok.type;
		const closeType = openType.replace(/_open$/, '_close');
		let depth = 1;
		let j = i + 1;
		while (j < tokens.length && depth > 0) {
			const t = tokens[j];
			if (t.type === openType && t.level === 0) depth++;
			else if (t.type === closeType && t.level === 0) depth--;
			if (depth === 0) break;
			j++;
		}

		const slice = tokens.slice(i, Math.min(j + 1, tokens.length));
		const html = md.renderer.render(slice, md.options, {});
		// If this block IS a heading, remember its slug so the TOC can later
		// map a clicked heading to this block's index via scrollToIndex.
		const headingSlug = openType === 'heading_open' ? (tok.attrGet('id') ?? undefined) : undefined;
		blocks.push({ id: nextId++, html, headingSlug, ...sourceRange(tok) });
		i = j + 1;
	}

	return blocks;
}
