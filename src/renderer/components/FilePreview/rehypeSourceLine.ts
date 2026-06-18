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
		});
	};
}
