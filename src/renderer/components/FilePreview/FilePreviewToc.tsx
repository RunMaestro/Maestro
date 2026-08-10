/**
 * FilePreviewToc - File Preview's adapter over the shared `TocOverlay`.
 *
 * The panel, its keyboard navigation, and its styling live in
 * `components/Toc/TocOverlay` so Director's Notes presents the identical
 * control. All this file adds is File Preview's own gating: the TOC only makes
 * sense for markdown, and never while the editor is open.
 */

import React, { RefObject } from 'react';
import { TocOverlay } from '../Toc';
import type { TocEntry } from './types';

interface FilePreviewTocProps {
	theme: any;
	tocEntries: TocEntry[];
	tocWidth: number;
	showTocOverlay: boolean;
	setShowTocOverlay: (v: boolean) => void;
	scrollMarkdownToBoundary: (direction: 'top' | 'bottom') => void;
	markdownContainerRef: RefObject<HTMLDivElement>;
	tocButtonRef: RefObject<HTMLButtonElement>;
	tocOverlayRef: RefObject<HTMLDivElement>;
	isMarkdown: boolean;
	markdownEditMode: boolean;
	/**
	 * Optional scroll-by-slug callback. Used by the Fast tier where headings
	 * are virtualized and most aren't in the DOM (so a plain querySelector
	 * fails). Should return true when the scroll was handled; false falls
	 * back to the default querySelector + scrollIntoView path.
	 */
	onSelectHeading?: (slug: string) => boolean;
}

export const FilePreviewToc = React.memo(function FilePreviewToc({
	theme,
	tocEntries,
	tocWidth,
	showTocOverlay,
	setShowTocOverlay,
	scrollMarkdownToBoundary,
	markdownContainerRef,
	tocButtonRef,
	tocOverlayRef,
	isMarkdown,
	markdownEditMode,
	onSelectHeading,
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
			containerRef={markdownContainerRef}
			buttonRef={tocButtonRef}
			overlayRef={tocOverlayRef}
			onSelectEntry={onSelectHeading ? (entry) => onSelectHeading(entry.slug) : undefined}
		/>
	);
});
