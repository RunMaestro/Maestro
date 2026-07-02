import { memo } from 'react';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import ASTRenderer from './ast-renderer';
import type { MarkdownProps } from './types';
import { getKeyFromMarkdown, resolveReference } from './utils';

const Markdown = memo(
	({
		markdown,
		debug,
		renderRules,
		listBulletStyle,
		styles,
		mergeStyle,
		customBulletElement,
		onLinkPress,
		extensions = [],
	}: MarkdownProps) => {
		const tree = fromMarkdown(markdown, {
			extensions: [gfmTable()],
			mdastExtensions: [
				gfmTableFromMarkdown(),
				resolveReference(),
				getKeyFromMarkdown(),
				...extensions,
			],
		});

		const renderer = new ASTRenderer({
			renderRules,
			debug,
			styles,
			mergeStyle,
			listBulletStyle,
			customBulletElement,
			onLinkPress,
		});

		return renderer.render(tree);
	}
);

Markdown.displayName = 'Markdown';
export default Markdown;
