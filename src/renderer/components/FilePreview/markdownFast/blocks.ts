import type { MarkdownBlock } from './types';
import type { ParserInstance, ParserToken } from './parser';

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
export function tokensToBlocks(md: ParserInstance, tokens: ParserToken[]): MarkdownBlock[] {
	const blocks: MarkdownBlock[] = [];
	let i = 0;
	let nextId = 0;

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
			blocks.push({ id: nextId++, html });
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
		blocks.push({ id: nextId++, html });
		i = j + 1;
	}

	return blocks;
}
