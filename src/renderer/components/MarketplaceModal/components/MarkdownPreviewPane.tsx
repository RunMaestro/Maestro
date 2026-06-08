import { useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import {
	REMARK_GFM_PLUGINS,
	createMarkdownComponents,
	generateProseStyles,
} from '../../../utils/markdownConfig';
import { openUrl } from '../../../utils/openUrl';
import { useEventListener } from '../../../hooks/utils/useEventListener';
import { Spinner } from '../../ui/Spinner';
import type { Theme } from '../../../types';

export interface MarkdownPreviewPaneProps {
	theme: Theme;
	readmeContent: string | null;
	selectedDocFilename: string | null;
	documentContent: string | null;
	isLoadingDocument: boolean;
}

export function MarkdownPreviewPane({
	theme,
	readmeContent,
	selectedDocFilename,
	documentContent,
	isLoadingDocument,
}: MarkdownPreviewPaneProps) {
	const previewScrollRef = useRef<HTMLDivElement>(null);

	useEventListener('keydown', (event: Event) => {
		const e = event as KeyboardEvent;
		const scrollContainer = previewScrollRef.current;
		if (!scrollContainer) return;

		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
			return;
		}

		const pageHeight = scrollContainer.clientHeight * 0.9;

		if (e.metaKey && !e.altKey && !e.shiftKey) {
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
			}
		} else if (e.altKey && !e.metaKey && !e.shiftKey) {
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				scrollContainer.scrollBy({ top: -pageHeight, behavior: 'smooth' });
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				scrollContainer.scrollBy({ top: pageHeight, behavior: 'smooth' });
			}
		}
	});

	const proseStyles = useMemo(
		() =>
			generateProseStyles({
				theme,
				coloredHeadings: true,
				compactSpacing: false,
				includeCheckboxStyles: true,
				scopeSelector: '.marketplace-preview',
			}),
		[theme]
	);

	const markdownComponents = useMemo(
		() =>
			createMarkdownComponents({
				theme,
				onExternalLinkClick: (href, opts) => openUrl(href, opts),
			}),
		[theme]
	);

	return (
		<div
			ref={previewScrollRef}
			className="marketplace-preview flex-1 min-h-0 overflow-y-auto p-4"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			<style>{proseStyles}</style>
			{isLoadingDocument ? (
				<div className="flex items-center justify-center h-32">
					<Spinner size={24} color={theme.colors.accent} />
				</div>
			) : (
				<div className="prose prose-sm max-w-none" style={{ color: theme.colors.textMain }}>
					<ReactMarkdown remarkPlugins={REMARK_GFM_PLUGINS} components={markdownComponents}>
						{selectedDocFilename
							? documentContent || '*Document not found*'
							: readmeContent || '*No README available*'}
					</ReactMarkdown>
				</div>
			)}
		</div>
	);
}
