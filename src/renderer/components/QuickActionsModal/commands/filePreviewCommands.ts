import type { Session } from '../../../types';
import type { QuickAction } from '../types';
import { extractHeadings, getLanguageFromFilename } from '../../FilePreview/filePreviewUtils';
import { requestHeadingPalette } from '../../../services/headingPalette';

interface BuildFilePreviewCommandsArgs {
	activeSession: Session | undefined;
	setQuickActionOpen: (open: boolean) => void;
}

/**
 * Commands that only mean anything while a markdown file is open in the
 * preview.
 *
 * Unlike most entries here, these are OMITTED rather than listed-and-disabled
 * when unavailable. A "Jump to Heading" row is not a feature a user has to
 * discover exists - it is one step of a document they are already reading - so
 * offering it over a terminal tab or a PNG describes a jump with no document to
 * make it in. The `#` key it mirrors is gated identically, and a palette entry
 * that appears under different conditions than its own shortcut is worse than
 * no entry.
 */
export function buildFilePreviewCommands({
	activeSession,
	setQuickActionOpen,
}: BuildFilePreviewCommandsArgs): QuickAction[] {
	const activeFileTab = activeSession?.activeFileTabId
		? activeSession.filePreviewTabs?.find((tab) => tab.id === activeSession.activeFileTabId)
		: undefined;
	if (!activeFileTab) return [];

	// `name` is the filename WITHOUT its extension, so rejoin before asking what
	// language this is - matching how FilePreview itself decides `isMarkdown`.
	const language = getLanguageFromFilename(`${activeFileTab.name}${activeFileTab.extension}`);
	// The editor shows raw source with no rendered headings to jump to, and the
	// preview's own `#` handler stands down there so the character can be typed.
	if (language !== 'markdown' || activeFileTab.editMode) return [];

	// A document with no headings has nothing to list. This parse is the same one
	// the preview runs for its Table of Contents, and it only happens while the
	// palette is building its list over a markdown tab.
	const headingCount = extractHeadings(activeFileTab.content).length;
	if (headingCount === 0) return [];

	return [
		{
			id: 'jumpToHeading',
			label: 'Jump to Heading',
			subtext: `Search the ${headingCount} heading${headingCount === 1 ? '' : 's'} in ${activeFileTab.name}${activeFileTab.extension}`,
			action: () => {
				setQuickActionOpen(false);
				// Deferred so the command palette finishes unmounting first: both are
				// modals that focus their own search box on mount, and the one closing
				// restores focus on its way out, which would otherwise land on top of
				// the heading palette's input.
				setTimeout(requestHeadingPalette, 50);
			},
		},
	];
}
