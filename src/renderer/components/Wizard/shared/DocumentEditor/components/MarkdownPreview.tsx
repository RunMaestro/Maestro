import type { KeyboardEvent, RefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import type { PluggableList } from 'unified';
import type { Theme } from '../../../../../types';
import { REMARK_GFM_PLUGINS } from '../../../../../utils/markdownConfig';
import { REHYPE_PLUGINS } from '../constants';

interface MarkdownPreviewProps {
	content: string;
	markdownComponents: Components;
	proseClassPrefix: string;
	proseStyles: string;
	previewRef: RefObject<HTMLDivElement>;
	theme: Theme;
	onEditShortcut: () => void;
}

export function MarkdownPreview({
	content,
	markdownComponents,
	proseClassPrefix,
	proseStyles,
	previewRef,
	theme,
	onEditShortcut,
}: MarkdownPreviewProps): JSX.Element {
	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if ((event.metaKey || event.ctrlKey) && event.key === 'e') {
			event.preventDefault();
			event.stopPropagation();
			onEditShortcut();
		}
	};

	return (
		<div
			ref={previewRef}
			className={`${proseClassPrefix} h-full overflow-y-auto border rounded p-4 outline-none`}
			tabIndex={0}
			onKeyDown={handleKeyDown}
			style={{
				borderColor: theme.colors.border,
				color: theme.colors.textMain,
				fontSize: '13px',
			}}
		>
			<style>{proseStyles}</style>
			<div className="prose prose-sm max-w-none">
				<ReactMarkdown
					remarkPlugins={REMARK_GFM_PLUGINS}
					rehypePlugins={REHYPE_PLUGINS as PluggableList}
					components={markdownComponents}
				>
					{content || '*No content yet.*'}
				</ReactMarkdown>
			</div>
		</div>
	);
}
