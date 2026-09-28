/**
 * remarkStripHtmlComments - keep HTML comments invisible on surfaces that do
 * not parse raw HTML.
 *
 * react-markdown v9 turns every hast `raw` node into a plain TEXT node unless
 * `rehype-raw` already rewrote it into real elements (see `transform()` in
 * `react-markdown/lib/index.js`). On a surface with raw HTML off, that makes an
 * HTML comment the one thing it is never supposed to be: visible. A document
 * carrying `<!-- reminders:edit-boundary -->` renders the escaped comment as
 * body text, and the reader has no idea why.
 *
 * Chat and File Preview never showed this because they run `rehype-raw`, which
 * parses the comment into a real comment node that React then drops. The Auto
 * Run panel, the wizard's document editor, and mobile chat build their own
 * plugin lists without it, so they leaked.
 *
 * Only comment-ONLY nodes are removed. Any other raw HTML keeps rendering as
 * escaped text, which is the existing - and deliberate - behavior for a surface
 * that opted out of HTML passthrough: showing `<div>` as text is honest, while
 * silently deleting it would hide content the author wrote.
 *
 * ORDERING: this must run AFTER `remarkMaestroMarkers`, which turns Auto Run
 * marker comments (`MAESTRO:HITL`, `maestro:halt`, `MAESTRO:MODEL`) into pill
 * nodes. Run it first and the pills are stripped instead of rendered.
 */

import { visit, SKIP } from 'unist-util-visit';
import type { Root, Html, Parent } from 'mdast';

const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * True when the node is nothing but complete comments (plus whitespace between
 * them). An unterminated `<!--` leaves a remainder and is left alone - it is
 * malformed source, and showing it is more useful than swallowing the rest of
 * the block.
 */
function isCommentOnly(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed.startsWith('<!--')) return false;
	return trimmed.replace(HTML_COMMENT, '').trim() === '';
}

export function remarkStripHtmlComments() {
	return (tree: Root) => {
		visit(tree, 'html', (node: Html, index: number | undefined, parent: Parent | undefined) => {
			if (parent === undefined || index === undefined) return;
			if (!isCommentOnly(node.value)) return;

			parent.children.splice(index, 1);
			// The splice shifts every later sibling down one slot, so hand the
			// visitor back the same index to re-examine whatever moved into it.
			return [SKIP, index];
		});
	};
}
