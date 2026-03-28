import { visit } from 'unist-util-visit';

/**
 * Remark plugin to support ==highlighted text== syntax.
 * Converts ==text== to <mark> HTML elements.
 */
export function remarkHighlight() {
	return (tree: any) => {
		visit(tree, 'text', (node: any, index: number | null | undefined, parent: any) => {
			const text = node.value;
			const regex = /==([\s\S]+?)==/g;

			if (!regex.test(text)) return;
			if (index === null || index === undefined || !parent) return;

			const parts: any[] = [];
			let lastIndex = 0;
			const matches = text.matchAll(/==([\s\S]+?)==/g);

			for (const match of matches) {
				const matchIndex = match.index!;

				// Add text before match
				if (matchIndex > lastIndex) {
					parts.push({
						type: 'text',
						value: text.slice(lastIndex, matchIndex),
					});
				}

				// Add highlighted text
				parts.push({
					type: 'html',
					value: `<mark style="background-color: #ffd700; color: #000; padding: 0 4px; border-radius: 2px;">${match[1]}</mark>`,
				});

				lastIndex = matchIndex + match[0].length;
			}

			// Add remaining text
			if (lastIndex < text.length) {
				parts.push({
					type: 'text',
					value: text.slice(lastIndex),
				});
			}

			// Replace the text node with the parts
			if (parts.length > 0) {
				parent.children.splice(index, 1, ...parts);
			}
		});
	};
}
