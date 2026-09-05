import React, { useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilePreviewToc } from '../../../../renderer/components/FilePreview/FilePreviewToc';
import { mockTheme } from '../../../helpers/mockTheme';
import type { TocEntry } from '../../../../renderer/components/FilePreview/types';

const SAMPLE_ENTRIES: TocEntry[] = [
	{ level: 1, text: 'Section A', slug: 'section-a' },
	{ level: 2, text: 'Sub of A', slug: 'sub-of-a' },
	{ level: 1, text: 'Section B', slug: 'section-b' },
];

function renderToc(
	opts: {
		tocEntries?: TocEntry[];
		onJumpToHeading?: (entry: TocEntry, behavior: ScrollBehavior) => void;
		isMarkdown?: boolean;
		markdownEditMode?: boolean;
	} = {}
) {
	const Wrapper: React.FC = () => {
		const tocButtonRef = useRef<HTMLButtonElement>(null);
		const tocOverlayRef = useRef<HTMLDivElement>(null);
		return (
			<FilePreviewToc
				theme={mockTheme}
				tocEntries={opts.tocEntries ?? SAMPLE_ENTRIES}
				tocWidth={250}
				showTocOverlay={true}
				setShowTocOverlay={() => {}}
				scrollMarkdownToBoundary={() => {}}
				tocButtonRef={tocButtonRef}
				tocOverlayRef={tocOverlayRef}
				isMarkdown={opts.isMarkdown ?? true}
				markdownEditMode={opts.markdownEditMode ?? false}
				onJumpToHeading={opts.onJumpToHeading ?? (() => {})}
			/>
		);
	};
	return render(<Wrapper />);
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

	describe('discoverability', () => {
		it('advertises the # heading palette in the header', () => {
			renderToc({});
			expect(screen.getByTitle('Press # to search these headings')).toBeTruthy();
		});
	});
});
