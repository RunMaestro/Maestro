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
		onSelectHeading?: (slug: string) => boolean;
		isMarkdown?: boolean;
		markdownEditMode?: boolean;
	} = {}
) {
	const Wrapper: React.FC = () => {
		const markdownContainerRef = useRef<HTMLDivElement>(null);
		const tocButtonRef = useRef<HTMLButtonElement>(null);
		const tocOverlayRef = useRef<HTMLDivElement>(null);
		return (
			<div>
				{/* Empty heading containers - text intentionally omitted so screen
				    queries against the TOC entry labels match only the TOC button,
				    not the fixture document. */}
				<div ref={markdownContainerRef} data-testid="markdown-container">
					<h1 id="section-a" />
					<h2 id="sub-of-a" />
					<h1 id="section-b" />
				</div>
				<FilePreviewToc
					theme={mockTheme}
					tocEntries={opts.tocEntries ?? SAMPLE_ENTRIES}
					tocWidth={250}
					showTocOverlay={true}
					setShowTocOverlay={() => {}}
					scrollMarkdownToBoundary={() => {}}
					markdownContainerRef={markdownContainerRef}
					tocButtonRef={tocButtonRef}
					tocOverlayRef={tocOverlayRef}
					isMarkdown={opts.isMarkdown ?? true}
					markdownEditMode={opts.markdownEditMode ?? false}
					onSelectHeading={opts.onSelectHeading}
				/>
			</div>
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

	describe('default (Rich-path) scroll', () => {
		it('uses querySelector + scrollIntoView when onSelectHeading is not provided', () => {
			renderToc({});
			const target = screen
				.getByTestId('markdown-container')
				.querySelector('#section-b') as HTMLElement;
			const spy = vi.spyOn(target, 'scrollIntoView');
			fireEvent.click(screen.getByText('Section B'));
			expect(spy).toHaveBeenCalled();
		});

		it('does nothing when querySelector fails to find the heading', () => {
			renderToc({
				tocEntries: [{ level: 1, text: 'Missing', slug: 'does-not-exist' }],
			});
			// Should not throw - silently no-op.
			expect(() => fireEvent.click(screen.getByText('Missing'))).not.toThrow();
		});
	});

	describe('Fast-tier callback override', () => {
		it('calls onSelectHeading with the entry slug', () => {
			const onSelectHeading = vi.fn().mockReturnValue(true);
			renderToc({ onSelectHeading });
			fireEvent.click(screen.getByText('Section B'));
			expect(onSelectHeading).toHaveBeenCalledWith('section-b');
		});

		it('does not throw if callback returns true and DOM element does not exist', () => {
			// When the Fast-tier callback claims the scroll, the DOM-fallback code
			// path is skipped entirely. This guards against accidental fall-through
			// when the DOM ref hasn't yet attached.
			const onSelectHeading = vi.fn().mockReturnValue(true);
			renderToc({
				onSelectHeading,
				// Slug that does not exist anywhere in the fixture; the DOM path
				// would silently no-op, but the Fast path should win first.
				tocEntries: [{ level: 1, text: 'Phantom', slug: 'phantom-section' }],
			});
			expect(() => fireEvent.click(screen.getByText('Phantom'))).not.toThrow();
			expect(onSelectHeading).toHaveBeenCalledWith('phantom-section');
		});

		it('falls back to DOM scroll when callback returns false', () => {
			const onSelectHeading = vi.fn().mockReturnValue(false);
			renderToc({ onSelectHeading });
			const target = screen
				.getByTestId('markdown-container')
				.querySelector('#section-b') as HTMLElement;
			const spy = vi.spyOn(target, 'scrollIntoView');
			fireEvent.click(screen.getByText('Section B'));
			expect(onSelectHeading).toHaveBeenCalledWith('section-b');
			expect(spy).toHaveBeenCalled();
		});

		it('passes the sub-heading slug correctly', () => {
			const onSelectHeading = vi.fn().mockReturnValue(true);
			renderToc({ onSelectHeading });
			fireEvent.click(screen.getByText('Sub of A'));
			expect(onSelectHeading).toHaveBeenCalledWith('sub-of-a');
		});
	});
});
