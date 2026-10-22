/**
 * remark plugins for markdown inside a Dataview result (a string cell, a task's
 * text, a list item). Dataview renders those strings as compact markdown: one
 * line, no paragraph margins, and Obsidian links that work.
 *
 * - `remarkDataviewWikiLinks` turns every `[[target]]` / `[[target|display]]`
 *   left as text into a `maestro-file://` link carrying the RAW target. The
 *   preview's `remarkFileLinks` only links targets it finds in the agent's file
 *   tree; a vault note is resolved by Dataview's own resolver in main instead,
 *   when the link is clicked (see `DataviewValue`).
 * - `remarkUnwrapSoleParagraph` drops the paragraph around a one-paragraph
 *   string, so the cell renders inline instead of as a block `<p>`.
 */

import { visit } from 'unist-util-visit';
import { WIKI_LINK_PATTERN } from '../../../shared/fileLinkPatterns';

interface MdastNode {
	type: string;
	value?: string;
	url?: string;
	children?: MdastNode[];
	data?: { hProperties?: Record<string, string> };
}

function wikiLinkNode(target: string, display: string): MdastNode {
	return {
		type: 'link',
		url: `maestro-file://${target}`,
		data: { hProperties: { 'data-maestro-file': target } },
		children: [{ type: 'text', value: display }],
	};
}

/** Split one text value into text and wiki-link nodes, or null when it holds no link. */
function splitWikiLinks(value: string): MdastNode[] | null {
	const pattern = new RegExp(WIKI_LINK_PATTERN.source, 'g');
	const parts: MdastNode[] = [];
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(value)) !== null) {
		// An embed (`![[...]]`) renders as a link to the embedded file.
		const start = match.index > 0 && value[match.index - 1] === '!' ? match.index - 1 : match.index;
		if (start > lastIndex) parts.push({ type: 'text', value: value.slice(lastIndex, start) });
		const target = match[1].trim();
		parts.push(wikiLinkNode(target, (match[2] ?? match[1]).trim()));
		lastIndex = match.index + match[0].length;
	}
	if (parts.length === 0) return null;
	if (lastIndex < value.length) parts.push({ type: 'text', value: value.slice(lastIndex) });
	return parts;
}

export function remarkDataviewWikiLinks() {
	return (tree: MdastNode) => {
		visit(tree as any, 'text', (node: any, index: number | undefined, parent: any) => {
			if (!parent || index === undefined || parent.type === 'link') return;
			const parts = splitWikiLinks(node.value ?? '');
			if (!parts) return;
			parent.children.splice(index, 1, ...parts);
			// Continue after the inserted nodes; none of them needs another visit.
			return index + parts.length;
		});
	};
}

export function remarkUnwrapSoleParagraph() {
	return (tree: MdastNode) => {
		const only = tree.children?.length === 1 ? tree.children[0] : undefined;
		if (only?.type === 'paragraph') tree.children = only.children ?? [];
	};
}

/** The plugin list a Dataview value hands to `<Markdown>`. */
export const DATAVIEW_CELL_REMARK_PLUGINS = [remarkDataviewWikiLinks, remarkUnwrapSoleParagraph];
