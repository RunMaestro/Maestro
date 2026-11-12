/**
 * LaunchIntro - the playbook author's introduction at the top of the launch dialog.
 *
 * Markdown from the playbook's `launch.intro`, drawn with the document preset the Exchange's own
 * previews use (`MarkdownPreviewPane`). The text is the author's, so a person can select and
 * copy it even though the rest of the dialog is click-driven.
 */

import { useMemo } from 'react';
import type { Theme } from '../../../types';
import { generateProseStyles } from '../../../utils/markdownConfig';
import { openUrl } from '../../../utils/openUrl';
import { Markdown } from '../../Markdown';

export interface LaunchIntroProps {
	theme: Theme;
	/** Markdown. */
	content: string;
}

export function LaunchIntro({ theme, content }: LaunchIntroProps) {
	const proseStyles = useMemo(
		() =>
			generateProseStyles({
				theme,
				coloredHeadings: true,
				compactSpacing: true,
				includeCheckboxStyles: false,
				scopeSelector: '.launch-intro',
			}),
		[theme]
	);

	return (
		<div className="launch-intro select-text" data-testid="launch-intro">
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
