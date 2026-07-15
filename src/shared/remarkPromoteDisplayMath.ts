/**
 * remark plugin: promote lone inline math to display math.
 *
 * `remark-math` only recognizes `$$\n...\n$$` (multi-line) as a display-math
 * block. A single-line `$$x+y$$` - which is how most users write a centered
 * formula in a chat message - gets parsed as inline math and renders without
 * the centered, block-level KaTeX treatment.
 *
 * This plugin walks the full mdast tree (root + nested containers like
 * blockquote, listItem, tableCell) and replaces any Paragraph whose only
 * child is an `inlineMath` node with a `math` (display) node, matching the
 * user's visual intent for `$$...$$` on its own line (#622).
 *
 * Note: `remark-math` does not preserve whether the source used `$...$` or
 * `$$...$$` - both become `inlineMath`. We rely on the chat-surface config
 * pairing this plugin with `remarkMath({ singleDollarTextMath: false })`,
 * which only emits `inlineMath` for double-dollar sources, so promotion is
 * safe.
 *
 * Code blocks are unaffected because remark never produces `inlineMath` for
 * fenced or indented code.
 */

interface MdastNode {
	type: string;
	value?: string;
	children?: MdastNode[];
	data?: {
		hName?: string;
		hProperties?: Record<string, unknown>;
		hChildren?: Array<{ type: string; value: string }>;
	};
}

function promoteInPlace(nodes: MdastNode[]): void {
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		if (
			node.type === 'paragraph' &&
			node.children?.length === 1 &&
			node.children[0].type === 'inlineMath'
		) {
			const value = node.children[0].value ?? '';
			// Emit the same hast shape mdast-util-math uses for block math
			// (`<div class="math math-display">value</div>`), which
			// rehype-katex picks up and replaces with rendered KaTeX. We set
			// the hints explicitly rather than rely on a 'math' node type
			// because mdast-util-to-hast does not have a default handler
			// for the bare type when the node is synthesized by hand.
			nodes[i] = {
				type: 'math',
				value,
				data: {
					hName: 'div',
					hProperties: { className: ['math', 'math-display'] },
					hChildren: [{ type: 'text', value }],
				},
			};
		} else if (node.children) {
			promoteInPlace(node.children);
		}
	}
}

export function remarkPromoteDisplayMath() {
	return (tree: MdastNode) => {
		if (!tree.children) return;
		promoteInPlace(tree.children);
	};
}
