import { splitFrontmatter } from './frontmatter';
import { createParser } from './parser';
import { tokensToBlocks, buildLineOffsets } from './blocks';
import { applyHeadingSlugs } from './headingSlugger';
import { applyFileLinks } from '../../../utils/fileLinks/markdownItAdapter';
import type { FileTreeIndices } from '../../../utils/fileLinks/matcher';
import type { MarkdownBlock } from './types';

/**
 * Options accepted by the orchestrator. `fileLinks` mirrors the Rich-path
 * remarkFileLinks config so cross-file references resolve identically.
 */
export interface BuildBlocksOptions {
	fileLinks?: {
		indices?: FileTreeIndices;
		cwd?: string;
		projectRoot?: string;
		homeDir?: string;
	};
}

/**
 * Top-level orchestrator: takes a raw markdown source string and returns the
 * ordered block array that the virtualizer will render.
 *
 * Pure (no DOM, no React) - fully unit-testable.
 *
 * Pipeline stages:
 *   1. Strip and render YAML frontmatter (frontmatter.ts).
 *   2. Tokenize the body with markdown-it (parser.ts).
 *   3. Group tokens into top-level blocks (blocks.ts).
 *   4. Prepend the frontmatter block (if any) and renumber ids so the array
 *      is a single contiguous sequence.
 */
export function buildBlocks(source: string, options: BuildBlocksOptions = {}): MarkdownBlock[] {
	const { frontmatterHtml, body } = splitFrontmatter(source);
	const frontmatterByteLength = source.length - body.length;

	const md = createParser();
	const tokens = md.parse(body, {});
	applyHeadingSlugs(md, tokens);
	if (options.fileLinks) {
		applyFileLinks(md, tokens, options.fileLinks);
	}
	const lineOffsets = buildLineOffsets(body);
	const bodyBlocks = tokensToBlocks(md, tokens, { lineOffsets });

	const all: MarkdownBlock[] = [];
	let id = 0;
	if (frontmatterHtml) {
		// Synthesized block - covers the stripped frontmatter region in the
		// source. Marking its range lets Fast-tier search land a match inside
		// frontmatter on this block.
		all.push({
			id: id++,
			html: frontmatterHtml,
			sourceStart: 0,
			sourceEnd: frontmatterByteLength,
		});
	}
	for (const block of bodyBlocks) {
		// Shift body-relative offsets into source coordinates.
		const sourceStart =
			block.sourceStart !== undefined ? block.sourceStart + frontmatterByteLength : undefined;
		const sourceEnd =
			block.sourceEnd !== undefined ? block.sourceEnd + frontmatterByteLength : undefined;
		all.push({ ...block, id: id++, sourceStart, sourceEnd });
	}
	return all;
}
