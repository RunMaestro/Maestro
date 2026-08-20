/**
 * Rehype plugin that stamps `data-source-line` (1-based) onto rendered
 * block-level markdown elements, using the position info carried over from
 * the original source via remark → rehype.
 *
 * This is what makes the rendered-markdown preview ⇄ edit toggle land on the
 * same place: the rendered DOM has no inherent 1:1 mapping back to source
 * lines (a heading occupies a different height than its raw text), so we tag
 * each block with the line it came from and let `lineSync` walk those tags.
 *
 * Only block-level tags are tagged - inline marks (em, strong, code, a) sit
 * inside a block and would just add noise to the attribute query.
 *
 * The one exception is a GFM task-list checkbox: remark synthesizes that
 * `<input>` during mdast -> hast, so it carries no position of its own. It
 * inherits its list item's line, which is what lets the preview map a click on
 * the box back to the `- [ ]` marker in the source.
 */

import { visit } from 'unist-util-visit';
import type { Root, Element } from 'hast';

const BLOCK_TAGS = new Set([
	'p',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'ul',
	'ol',
	'li',
	'blockquote',
	'pre',
	'table',
	'thead',
	'tbody',
	'tr',
	'hr',
	'img',
	'div',
	'section',
]);

/**
 * The task-list checkbox of a list item, if it has one. remark places it as the
 * item's first child, or as the first child of the item's first paragraph when
 * the list is loose - anything else means this is an ordinary list item.
 */
function taskCheckbox(node: Element): Element | undefined {
	for (const child of node.children) {
		// Leading whitespace between the tags is not the checkbox; keep looking.
		if (child.type === 'text' && child.value.trim() === '') continue;
		if (child.type !== 'element') return undefined;
		if (child.tagName === 'input' && child.properties?.type === 'checkbox') return child;
		if (child.tagName === 'p') return taskCheckbox(child);
		return undefined;
	}
	return undefined;
}

export function rehypeSourceLine() {
	return (tree: Root) => {
		visit(tree, 'element', (node: Element) => {
			if (!BLOCK_TAGS.has(node.tagName)) return;
			const line = node.position?.start?.line;
			if (typeof line !== 'number') return;
			node.properties = node.properties ?? {};
			// hast camelCase → emitted as `data-source-line` by react-markdown.
			if (node.properties.dataSourceLine === undefined) {
				node.properties.dataSourceLine = line;
			}
			if (node.tagName === 'li') {
				const box = taskCheckbox(node);
				if (box) {
					box.properties = box.properties ?? {};
					box.properties.dataSourceLine = line;
				}
			}
		});
	};
}
