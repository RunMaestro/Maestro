/**
 * remark plugin: promote lone inline math to display math.
 *
 * `remark-math` only recognizes `$$\n...\n$$` (multi-line) as a display-math
 * block. A single-line `$$x+y$$` — which is how most users write a centered
 * formula in a chat message — gets parsed as inline math and renders without
 * the centered, block-level KaTeX treatment.
 *
 * This plugin walks the top-level mdast tree and replaces any Paragraph
 * whose only child is an `inlineMath` node with a `math` (display) node,
 * matching the user's visual intent for `$$...$$` on its own line (#622).
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

export function remarkPromoteDisplayMath() {
	return (tree: MdastNode) => {
		if (!tree.children) return;
		tree.children = tree.children.map((node) => {
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
				return {
					type: 'math',
					value,
					data: {
						hName: 'div',
						hProperties: { className: ['math', 'math-display'] },
						hChildren: [{ type: 'text', value }],
					},
				};
			}
			return node;
		});
	};
}
