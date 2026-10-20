/**
 * The Dataview blocks of a note (D8, DV-13): every `dataview` and `dataviewjs` fence, in document order.
 * `maestro-cli dataview query` runs them, and the renderer reuses the same scan.
 *
 * Fences come from markdown-it tokens (DEV-4), the parser M1 indexes with, so a fence nested in a list or
 * a blockquote counts, while a fence-shaped line inside another code block, an indented code block, or
 * the frontmatter does not.
 */

import { tokenizeMarkdownLines } from './metadata';

/** The fence languages Dataview renders. Matched exactly, as Obsidian matches a code block processor. */
export type DataviewBlockLanguage = 'dataview' | 'dataviewjs';

export interface DataviewBlock {
	language: DataviewBlockLanguage;
	/** The fence body without its trailing newline (list and quote markers already stripped). */
	source: string;
	/** 1-based line of the opening fence. */
	line: number;
}

function blockLanguage(info: string): DataviewBlockLanguage | null {
	const language = info.trim().split(/\s+/, 1)[0];
	return language === 'dataview' || language === 'dataviewjs' ? language : null;
}

/** Every `dataview` and `dataviewjs` fence in `markdown`, top to bottom. */
export function extractDataviewBlocks(markdown: string): DataviewBlock[] {
	const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
	const blocks: DataviewBlock[] = [];
	for (const token of tokenizeMarkdownLines(lines)) {
		if (token.type !== 'fence' || !token.map) continue;
		const language = blockLanguage(token.info);
		if (!language) continue;
		blocks.push({
			language,
			source: token.content.replace(/\n$/, ''),
			line: token.map[0] + 1,
		});
	}
	return blocks;
}
