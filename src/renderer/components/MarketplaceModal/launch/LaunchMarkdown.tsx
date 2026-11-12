/**
 * LaunchMarkdown - a block of the playbook author's markdown inside a launch dialog.
 *
 * The introduction at the top of the launch dialog (`launch.intro`), and the verdict, summary and
 * next steps of the outro, are all drawn the same way: the document preset the Exchange's own
 * previews use (`MarkdownPreviewPane`). The text is the author's, or the run's, so a person can
 * select and copy it even though the launch dialog around it is click-driven.
 */

import { useMemo } from 'react';
import type { Theme } from '../../../types';
import { generateProseStyles } from '../../../utils/markdownConfig';
import { openUrl } from '../../../utils/openUrl';
import { Markdown } from '../../Markdown';

export interface LaunchMarkdownProps {
	theme: Theme;
	/** Markdown. */
	content: string;
	/** Names the block for tests. A dialog that draws several of them gives each its own. */
	testId?: string;
}

export function LaunchMarkdown({
	theme,
	content,
	testId = 'launch-markdown',
}: LaunchMarkdownProps) {
	const proseStyles = useMemo(
		() =>
			generateProseStyles({
				theme,
				coloredHeadings: true,
				compactSpacing: true,
				includeCheckboxStyles: false,
				scopeSelector: '.launch-markdown',
			}),
		[theme]
	);

	return (
		<div className="launch-markdown select-text" data-testid={testId}>
			<style>{proseStyles}</style>
			<div className="prose prose-sm max-w-none" style={{ color: theme.colors.textMain }}>
				<Markdown
					preset="document"
					frontmatter={false}
					theme={theme}
					content={content}
					onExternalLinkClick={openUrl}
				/>
			</div>
		</div>
	);
}
