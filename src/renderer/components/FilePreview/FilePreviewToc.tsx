/**
 * FilePreviewToc - File Preview's adapter over the shared `TocOverlay`.
 *
 * The panel, its keyboard navigation, and its styling live in
 * `components/Toc/TocOverlay` so Director's Notes presents the identical
 * control. All this file adds is File Preview's own gating: the TOC only makes
 * sense for markdown, and never while the editor is open.
 *
 * It does NOT own a scroll path. `onJumpToHeading` comes from FilePreview and
 * is the same callback the `#` heading palette uses, so the two surfaces cannot
 * drift on how a jump works per preview tier - the virtualized Fast tier keeps
 * most headings out of the DOM, where a plain `querySelector` finds nothing.
 */

import React from 'react';
import { TocOverlay } from '../Toc';
import type { TocEntry } from './types';

interface FilePreviewTocProps {
	theme: any;
	tocEntries: TocEntry[];
	tocWidth: number;
	showTocOverlay: boolean;
	setShowTocOverlay: (v: boolean) => void;
	scrollMarkdownToBoundary: (direction: 'top' | 'bottom') => void;
	tocButtonRef: React.RefObject<HTMLButtonElement>;
	tocOverlayRef: React.RefObject<HTMLDivElement>;
	isMarkdown: boolean;
	markdownEditMode: boolean;
	/**
	 * Jump the preview to a heading. Owned by FilePreview so the ToC and the
	 * `#` heading palette cannot drift on how a jump works per preview tier.
	 */
	onJumpToHeading: (entry: TocEntry, behavior: ScrollBehavior) => void;
	/**
	 * Index of the heading the preview is currently scrolled under, or `-1` when
	 * the reader is above the first heading. Owned by FilePreview because only it
	 * can measure the document; the list follows it so the highlight is where the
	 * reader is standing rather than where they last clicked.
	 */
	activeIndex: number;
}

export const FilePreviewToc = React.memo(function FilePreviewToc({
	theme,
	tocEntries,
	tocWidth,
	showTocOverlay,
	setShowTocOverlay,
	scrollMarkdownToBoundary,
	tocButtonRef,
	tocOverlayRef,
	isMarkdown,
	markdownEditMode,
	onJumpToHeading,
	activeIndex,
}: FilePreviewTocProps) {
	if (!isMarkdown || markdownEditMode) {
		return null;
	}

	return (
		<TocOverlay
			theme={theme}
			entries={tocEntries}
			width={tocWidth}
			open={showTocOverlay}
			onOpenChange={setShowTocOverlay}
			onScrollToBoundary={scrollMarkdownToBoundary}
			buttonRef={tocButtonRef}
			overlayRef={tocOverlayRef}
			// Where the document is scrolled. The overlay keeps its own selection
			// on top of this - see TocOverlay - so a click or arrow press lights a
			// row immediately instead of waiting for the jump's scroll to land.
			activeIndex={activeIndex}
			// Always handled here: `onJumpToHeading` already covers every preview
			// tier, so the overlay's own `containerRef` fallback would be a second
			// jump path that only ever ran when this one was wrong.
			onSelectEntry={(entry, behavior) => {
				onJumpToHeading(entry, behavior);
				return true;
			}}
			// File Preview is the surface that binds `#` to the heading palette,
			// so it is the one that may advertise it.
			searchShortcutKey="#"
		/>
	);
});
