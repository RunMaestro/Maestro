import React, { useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FilePreviewToc } from '../../../../renderer/components/FilePreview/FilePreviewToc';
import { mockTheme } from '../../../helpers/mockTheme';
import type { TocEntry } from '../../../../renderer/components/FilePreview/types';

const SAMPLE_ENTRIES: TocEntry[] = [
	{ level: 1, text: 'Section A', slug: 'section-a' },
	{ level: 2, text: 'Sub of A', slug: 'sub-of-a' },
	{ level: 1, text: 'Section B', slug: 'section-b' },
];

interface TocOpts {
	tocEntries?: TocEntry[];
	onJumpToHeading?: (entry: TocEntry, behavior: ScrollBehavior) => void;
	isMarkdown?: boolean;
	markdownEditMode?: boolean;
	activeIndex?: number;
	showTocOverlay?: boolean;
}

const Wrapper: React.FC<TocOpts> = (opts) => {
	const tocButtonRef = useRef<HTMLButtonElement>(null);
	const tocOverlayRef = useRef<HTMLDivElement>(null);
	return (
		<FilePreviewToc
			theme={mockTheme}
			tocEntries={opts.tocEntries ?? SAMPLE_ENTRIES}
			tocWidth={250}
			showTocOverlay={opts.showTocOverlay ?? true}
			setShowTocOverlay={() => {}}
			scrollMarkdownToBoundary={() => {}}
			tocButtonRef={tocButtonRef}
			tocOverlayRef={tocOverlayRef}
			isMarkdown={opts.isMarkdown ?? true}
			markdownEditMode={opts.markdownEditMode ?? false}
			onJumpToHeading={opts.onJumpToHeading ?? (() => {})}
			activeIndex={opts.activeIndex ?? 0}
		/>
	);
};

function renderToc(opts: TocOpts = {}) {
	return render(<Wrapper {...opts} />);
}

/** An entry is "current" when it carries the inset accent rail. */
function isHighlighted(label: string): boolean {
	const button = screen.getByText(label).closest('button') as HTMLButtonElement;
	return button.style.boxShadow.includes('inset');
}

describe('FilePreviewToc', () => {
	describe('rendering visibility', () => {
		it('renders nothing for non-markdown files', () => {
			renderToc({ isMarkdown: false });
			expect(screen.queryByText('Section A')).toBeNull();
		});

		it('renders nothing in markdown edit mode', () => {
			renderToc({ markdownEditMode: true });
			expect(screen.queryByText('Section A')).toBeNull();
		});

		it('renders nothing when toc entries are empty', () => {
			renderToc({ tocEntries: [] });
			expect(screen.queryByText('Section A')).toBeNull();
		});

		it('renders all entries when markdown preview is active', () => {
			renderToc({});
			expect(screen.getByText('Section A')).toBeTruthy();
			expect(screen.getByText('Sub of A')).toBeTruthy();
			expect(screen.getByText('Section B')).toBeTruthy();
		});
	});

	describe('jump delegation', () => {
		it('asks the owner to jump to the clicked entry, smoothly', () => {
			const onJumpToHeading = vi.fn();
			renderToc({ onJumpToHeading });
			fireEvent.click(screen.getByText('Section B'));
			expect(onJumpToHeading).toHaveBeenCalledWith(SAMPLE_ENTRIES[2], 'smooth');
		});

		it('passes the sub-heading entry, not just its slug', () => {
			const onJumpToHeading = vi.fn();
			renderToc({ onJumpToHeading });
			fireEvent.click(screen.getByText('Sub of A'));
			expect(onJumpToHeading).toHaveBeenCalledWith(SAMPLE_ENTRIES[1], 'smooth');
		});

		it('jumps instantly on arrow-key navigation so key repeat stays responsive', () => {
			const onJumpToHeading = vi.fn();
			const { container } = renderToc({ onJumpToHeading });
			const list = container.querySelector('[data-testid="toc-top-button"]')
				?.nextElementSibling as HTMLElement;
			fireEvent.keyDown(list, { key: 'ArrowDown' });
			expect(onJumpToHeading).toHaveBeenCalledWith(SAMPLE_ENTRIES[1], 'auto');
		});
	});

	describe('following the scroll', () => {
		it('highlights the section the reader is standing in', () => {
			renderToc({ activeIndex: 2 });
			expect(isHighlighted('Section B')).toBe(true);
			expect(isHighlighted('Section A')).toBe(false);
		});

		it('moves the highlight when the reader scrolls into another section', () => {
			const { rerender } = renderToc({ activeIndex: 0 });
			expect(isHighlighted('Section A')).toBe(true);
			rerender(<Wrapper activeIndex={1} />);
			expect(isHighlighted('Sub of A')).toBe(true);
			expect(isHighlighted('Section A')).toBe(false);
		});

		it('lights the Top sash, and no entry, above the first heading', () => {
			const { container } = renderToc({ activeIndex: -1 });
			const top = container.querySelector('[data-testid="toc-top-button"]') as HTMLButtonElement;
			expect(top.style.boxShadow).toContain('inset');
			expect(isHighlighted('Section A')).toBe(false);
		});

		it('keeps arrow nav moving when the document can no longer scroll', () => {
			// At the bottom of a document the scroll clamps, so activeIndex stops
			// changing. The list must still step, or the last headings become
			// unreachable by keyboard.
			const onJumpToHeading = vi.fn();
			const { container } = renderToc({ activeIndex: 0, onJumpToHeading });
			const list = container.querySelector('[data-testid="toc-top-button"]')
				?.nextElementSibling as HTMLElement;
			fireEvent.keyDown(list, { key: 'ArrowDown' });
			fireEvent.keyDown(list, { key: 'ArrowDown' });
			expect(onJumpToHeading).toHaveBeenLastCalledWith(SAMPLE_ENTRIES[2], 'auto');
		});

		it('lights a clicked row at once, without waiting for the scroll to land', () => {
			renderToc({ activeIndex: 0 });
			fireEvent.click(screen.getByText('Section B'));
			expect(isHighlighted('Section B')).toBe(true);
			expect(isHighlighted('Section A')).toBe(false);
		});

		it('focuses the section the reader is in when the overlay opens', async () => {
			const { rerender } = renderToc({ showTocOverlay: false, activeIndex: 2 });
			rerender(<Wrapper showTocOverlay={true} activeIndex={2} />);
			await waitFor(() => {
				expect(document.activeElement).toBe(screen.getByText('Section B').closest('button'));
			});
		});
	});

	describe('discoverability', () => {
		it('advertises the # heading palette in the header', () => {
			renderToc({});
			expect(screen.getByTitle('Press # to search these headings')).toBeTruthy();
		});
	});
});
