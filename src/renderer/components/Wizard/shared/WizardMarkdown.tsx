/**
 * WizardMarkdown - renders an agent reply in either wizard conversation
 * (onboarding ConversationScreen and the inline /wizard).
 *
 * It is the chat preset with the chat transcript's own flags, on purpose: the
 * wizard is where the user asks for mockups, flows, and data models, so it must
 * render everything regular chat does (Mermaid, inline SVG, local images, KaTeX,
 * tables, callouts). A wizard-only preset used to strip all of that down to
 * plain GFM, and asked-for mockups arrived as raw source or nothing at all.
 * Both wizards route through this one component so they cannot drift apart.
 */

import { memo } from 'react';
import type { Theme } from '../../../types';
import { Markdown } from '../../Markdown';

export const WizardMarkdown = memo(function WizardMarkdown({
	content,
	theme,
}: {
	content: string;
	theme: Theme;
}) {
	return <Markdown preset="chat" theme={theme} content={content} chatLineBreaks chatMath />;
});
