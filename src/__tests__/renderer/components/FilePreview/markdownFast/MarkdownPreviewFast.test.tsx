/**
 * Component-level integration test for the Fast tier markdown preview.
 *
 * The pure modules (pipeline, sanitize, linkRouter, proseStyles, frontmatter,
 * blocks, parser, escapeHtml) are exhaustively unit-tested in sibling files.
 * This test focuses on the React wiring:
 *   - the loading skeleton appears for content above the sync-parse threshold
 *   - all parsed blocks are rendered (via a stubbed Virtuoso) once parse
 *     completes
 *   - the delegated click handler routes link kinds to the right callback
 *   - parent ref bridging works
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockTheme } from '../../../../helpers/mockTheme';

// Stub Virtuoso so we get a synchronous, predictable render of every item.
// The real react-virtuoso requires a layout engine that jsdom doesn't fully
// emulate; for behavior tests we only need to know that each block is
// mounted and a click on the container can find an <a> via event.target.
// Captures scrollToIndex calls so tests can assert the Fast tier's TOC
// integration without depending on a real virtualizer layout.
const scrollToIndexSpy = vi.fn();

vi.mock('react-virtuoso', () => ({
	Virtuoso: React.forwardRef(function MockVirtuoso(
		props: {
			data: Array<{ id: number; html: string }>;
			itemContent: (index: number, item: { id: number; html: string }) => React.ReactNode;
			style?: React.CSSProperties;
		},
		ref: React.Ref<{ scrollToIndex: (arg: unknown) => void }>
	) {
		React.useImperativeHandle(ref, () => ({
			scrollToIndex: scrollToIndexSpy,
		}));
		return (
			<div data-testid="mock-virtuoso" style={props.style}>
				{props.data.map((item, idx) => (
					<div key={item.id} data-virtuoso-item={idx}>
						{props.itemContent(idx, item)}
					</div>
				))}
			</div>
		);
	}),
}));

import {
	MarkdownPreviewFast,
	type MarkdownPreviewFastHandle,
} from '../../../../../renderer/components/FilePreview/markdownFast';

type FileClickHandler = (filePath: string, opts?: { openInNewTab?: boolean }) => void;
type ExternalClickHandler = (href: string, opts?: { ctrlKey?: boolean }) => void;

function renderPreview(options: {
	content: string;
	onFileClick?: FileClickHandler;
	onExternalLinkClick?: ExternalClickHandler;
}) {
	const containerRef = { current: null } as React.MutableRefObject<HTMLDivElement | null>;
	const result = render(
		<MarkdownPreviewFast
			content={options.content}
			theme={mockTheme}
			markdownContainerRef={containerRef}
			onFileClick={options.onFileClick}
			onExternalLinkClick={options.onExternalLinkClick}
		/>
	);
	return { ...result, containerRef };
}

describe('MarkdownPreviewFast', () => {
	beforeEach(() => {
		vi.useRealTimers();
		scrollToIndexSpy.mockReset();
	});

	describe('parse + render lifecycle', () => {
		it('renders blocks synchronously for small input', () => {
			renderPreview({ content: '# Hello\n\nworld' });
			expect(screen.getByTestId('mock-virtuoso')).toBeTruthy();
			expect(screen.queryByTestId('markdown-fast-skeleton')).toBeNull();
			expect(screen.getByText('Hello')).toBeTruthy();
		});

		it('shows the parsing skeleton for large input, then renders blocks', async () => {
			// Just above the 64 KB sync-parse threshold so the component takes the
			// deferred-parse path. Use one long paragraph (no `\n\n` boundaries
			// inside the filler) so markdown-it emits a single block - keeps the
			// parse cheap so the test isn't flaky on CPU-contended CI runners.
			const SYNC_PARSE_BYTES = 64 * 1024;
			const filler = 'paragraph body text '.repeat(Math.ceil(SYNC_PARSE_BYTES / 20) + 10);
			const content = '# Heading\n\n' + filler;
			expect(content.length).toBeGreaterThan(SYNC_PARSE_BYTES);

			renderPreview({ content });

			// Initial frame shows the skeleton; Virtuoso is not yet mounted.
			expect(screen.getByTestId('markdown-fast-skeleton')).toBeTruthy();
			expect(screen.queryByTestId('mock-virtuoso')).toBeNull();

			// After the setTimeout(0) microtask the parse runs and blocks render.
			await waitFor(
				() => {
					expect(screen.queryByTestId('markdown-fast-skeleton')).toBeNull();
					expect(screen.getByTestId('mock-virtuoso')).toBeTruthy();
				},
				{ timeout: 15_000 }
			);
		}, 30_000);

		it('re-parses when content changes', () => {
			const { rerender, containerRef } = renderPreview({ content: '# First' });
			expect(screen.getByText('First')).toBeTruthy();

			rerender(
				<MarkdownPreviewFast
					content="# Second"
					theme={mockTheme}
					markdownContainerRef={containerRef}
				/>
			);
			expect(screen.queryByText('First')).toBeNull();
			expect(screen.getByText('Second')).toBeTruthy();
		});
	});

	describe('parent ref bridging', () => {
		it('writes the scroll container to the provided markdownContainerRef', () => {
			const ref = { current: null } as React.MutableRefObject<HTMLDivElement | null>;
			render(<MarkdownPreviewFast content="# x" theme={mockTheme} markdownContainerRef={ref} />);
			expect(ref.current).not.toBeNull();
			expect(ref.current).toBeInstanceOf(HTMLDivElement);
		});
	});

	describe('delegated link click handling', () => {
		it('routes data-maestro-file links via onFileClick', () => {
			const onFileClick = vi.fn();
			const { container } = renderPreview({
				content: 'no links here',
				onFileClick,
			});
			// Inject an anchor matching what a rewritten link would look like.
			// We can't easily get a maestro link via plain markdown-it, so we
			// inject one into the rendered DOM to exercise the click path.
			const block = container.querySelector('.markdown-fast-block')!;
			const a = document.createElement('a');
			a.setAttribute('data-maestro-file', 'docs/readme.md');
			a.textContent = 'link';
			block.appendChild(a);

			fireEvent.click(a);

			expect(onFileClick).toHaveBeenCalledWith('docs/readme.md', { openInNewTab: false });
		});

		it('marks openInNewTab when meta key is held during click', () => {
			const onFileClick = vi.fn();
			const { container } = renderPreview({ content: 'x', onFileClick });
			const block = container.querySelector('.markdown-fast-block')!;
			const a = document.createElement('a');
			a.setAttribute('data-maestro-file', 'x.md');
			a.textContent = 'link';
			block.appendChild(a);

			fireEvent.click(a, { metaKey: true });
			expect(onFileClick).toHaveBeenCalledWith('x.md', { openInNewTab: true });
		});

		it('routes external https links via onExternalLinkClick', () => {
			const onExternalLinkClick = vi.fn();
			renderPreview({
				content: 'See [example](https://example.com) for more.',
				onExternalLinkClick,
			});
			const anchor = screen.getByText('example') as HTMLAnchorElement;
			fireEvent.click(anchor);
			expect(onExternalLinkClick).toHaveBeenCalledWith('https://example.com', {
				ctrlKey: false,
			});
		});

		it('does not call onFileClick for external links', () => {
			const onFileClick = vi.fn();
			const onExternalLinkClick = vi.fn();
			renderPreview({
				content: '[ext](https://example.com)',
				onFileClick,
				onExternalLinkClick,
			});
			const anchor = screen.getByText('ext') as HTMLAnchorElement;
			fireEvent.click(anchor);
			expect(onFileClick).not.toHaveBeenCalled();
			expect(onExternalLinkClick).toHaveBeenCalled();
		});

		it('does nothing for clicks outside any anchor', () => {
			const onFileClick = vi.fn();
			const onExternalLinkClick = vi.fn();
			const { container } = renderPreview({
				content: 'plain text',
				onFileClick,
				onExternalLinkClick,
			});
			fireEvent.click(container.querySelector('.markdown-fast-block')!);
			expect(onFileClick).not.toHaveBeenCalled();
			expect(onExternalLinkClick).not.toHaveBeenCalled();
		});

		it('does nothing for # anchor clicks (Phase 1 limitation)', () => {
			const onFileClick = vi.fn();
			const onExternalLinkClick = vi.fn();
			renderPreview({
				content: '[anchor](#section)',
				onFileClick,
				onExternalLinkClick,
			});
			const anchor = screen.getByText('anchor') as HTMLAnchorElement;
			fireEvent.click(anchor);
			expect(onFileClick).not.toHaveBeenCalled();
			expect(onExternalLinkClick).not.toHaveBeenCalled();
		});
	});

	describe('block rendering output', () => {
		it('emits a block per heading from buildBlocks', () => {
			const { container } = renderPreview({ content: '# A\n\n# B\n\n# C' });
			const blocks = container.querySelectorAll('.markdown-fast-block');
			expect(blocks.length).toBe(3);
		});

		it('embeds the generated prose CSS', () => {
			const { container } = renderPreview({ content: '# x' });
			const style = container.querySelector('style');
			expect(style?.textContent).toContain('.markdown-fast-block');
		});

		it('renders a frontmatter table when YAML is present', () => {
			const { container } = renderPreview({
				content: '---\ntitle: Doc\n---\n# Body',
			});
			expect(container.textContent).toContain('Document metadata');
			expect(container.textContent).toContain('title');
		});

		it('renders GFM tables', () => {
			const { container } = renderPreview({
				content: ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n'),
			});
			expect(container.querySelector('table')).toBeTruthy();
			expect(container.querySelector('th')?.textContent).toBe('a');
		});

		it('sanitizes raw HTML in the rendered markdown', () => {
			const { container } = renderPreview({
				content: '<script>alert(1)</script>\n\n<p>safe</p>',
			});
			expect(container.innerHTML).not.toContain('<script');
			expect(container.textContent).toContain('safe');
		});

		it('handles empty content without throwing', () => {
			expect(() => renderPreview({ content: '' })).not.toThrow();
		});

		it('emits id attributes on rendered heading blocks', () => {
			const { container } = renderPreview({ content: '# Hello World' });
			expect(container.querySelector('#hello-world')).toBeTruthy();
		});
	});

	describe('scrollToHeading imperative handle', () => {
		it('scrolls Virtuoso to the matching heading block', () => {
			const ref = { current: null } as React.MutableRefObject<MarkdownPreviewFastHandle | null>;
			const containerRef = { current: null } as React.MutableRefObject<HTMLDivElement | null>;
			const content = ['# Alpha', '', 'body', '', '# Beta', '', 'more body', '', '# Gamma'].join(
				'\n'
			);
			render(
				<MarkdownPreviewFast
					ref={ref}
					content={content}
					theme={mockTheme}
					markdownContainerRef={containerRef}
				/>
			);

			const found = ref.current?.scrollToHeading('beta');
			expect(found).toBe(true);
			expect(scrollToIndexSpy).toHaveBeenCalledOnce();
			// Blocks: [alpha, body, beta, more body, gamma] → 'beta' is at index 2.
			const call = scrollToIndexSpy.mock.calls[0][0];
			expect(call.index).toBe(2);
			expect(call.align).toBe('start');
		});

		it('returns false when no heading matches the given slug', () => {
			const ref = { current: null } as React.MutableRefObject<MarkdownPreviewFastHandle | null>;
			const containerRef = { current: null } as React.MutableRefObject<HTMLDivElement | null>;
			const content = ['# Alpha', '', '# Beta'].join('\n');
			render(
				<MarkdownPreviewFast
					ref={ref}
					content={content}
					theme={mockTheme}
					markdownContainerRef={containerRef}
				/>
			);

			const found = ref.current?.scrollToHeading('nonexistent');
			expect(found).toBe(false);
			expect(scrollToIndexSpy).not.toHaveBeenCalled();
		});

		it('disambiguates duplicate heading slugs (same, same-1, same-2)', () => {
			const ref = { current: null } as React.MutableRefObject<MarkdownPreviewFastHandle | null>;
			const containerRef = { current: null } as React.MutableRefObject<HTMLDivElement | null>;
			const content = ['# Same', '', '# Same', '', '# Same'].join('\n');
			render(
				<MarkdownPreviewFast
					ref={ref}
					content={content}
					theme={mockTheme}
					markdownContainerRef={containerRef}
				/>
			);

			ref.current?.scrollToHeading('same-1');
			expect(scrollToIndexSpy).toHaveBeenCalledOnce();
			// Blocks: [same, same-1, same-2] → 'same-1' is at index 1.
			expect(scrollToIndexSpy.mock.calls[0][0].index).toBe(1);
		});

		it('returns false on a document with no headings', () => {
			const ref = { current: null } as React.MutableRefObject<MarkdownPreviewFastHandle | null>;
			const containerRef = { current: null } as React.MutableRefObject<HTMLDivElement | null>;
			render(
				<MarkdownPreviewFast
					ref={ref}
					content="just a paragraph"
					theme={mockTheme}
					markdownContainerRef={containerRef}
				/>
			);
			expect(ref.current?.scrollToHeading('whatever')).toBe(false);
		});
	});

	describe('scrollToMatch precision (B2)', () => {
		// rAF doesn't fire synchronously in jsdom; flush by polling task queue.
		function flushRaf(): Promise<void> {
			return new Promise((resolve) => requestAnimationFrame(() => resolve()));
		}

		it('scrolls Virtuoso to the matched block AND nudges the matched word into view', async () => {
			const ref = { current: null } as React.MutableRefObject<MarkdownPreviewFastHandle | null>;
			const containerRef = { current: null } as React.MutableRefObject<HTMLDivElement | null>;
			// Two blocks, each with a distinct word so we can verify scrollIntoView
			// targets the right block.
			const twoBlocks = ['first block alpha', '', 'second block beta'].join('\n');
			render(
				<MarkdownPreviewFast
					ref={ref}
					content={twoBlocks}
					theme={mockTheme}
					markdownContainerRef={containerRef}
				/>
			);

			// Stub scrollIntoView on every element so we can detect the precision
			// scroll firing without depending on layout.
			const scrollIntoViewSpy = vi.fn();
			Element.prototype.scrollIntoView = scrollIntoViewSpy;

			// Find the offsetWithinBlock for "beta" - the second block has text
			// "second block beta", so "beta" starts at character 13.
			ref.current?.scrollToMatch({
				sourceOffset: 0, // not used by handle
				length: 4,
				blockIndex: 1,
				offsetWithinBlock: 13,
			});

			expect(scrollToIndexSpy).toHaveBeenCalledWith(
				expect.objectContaining({ index: 1, align: 'center' })
			);

			// Let the post-scroll rAF fire.
			await flushRaf();
			await flushRaf();

			// scrollIntoView should have been called for the word's parent element.
			expect(scrollIntoViewSpy).toHaveBeenCalled();
			// The last call must use {block: 'nearest', behavior: 'auto'} per the
			// scrollRangeIntoView contract.
			const lastCall = scrollIntoViewSpy.mock.calls.at(-1);
			expect(lastCall?.[0]).toEqual({ block: 'nearest', behavior: 'auto' });
		});

		it('no-ops when blockIndex is out of range', () => {
			const ref = { current: null } as React.MutableRefObject<MarkdownPreviewFastHandle | null>;
			const containerRef = { current: null } as React.MutableRefObject<HTMLDivElement | null>;
			render(
				<MarkdownPreviewFast
					ref={ref}
					content="only one block"
					theme={mockTheme}
					markdownContainerRef={containerRef}
				/>
			);

			ref.current?.scrollToMatch({
				sourceOffset: 0,
				length: 4,
				blockIndex: 99,
				offsetWithinBlock: 0,
			});
			expect(scrollToIndexSpy).not.toHaveBeenCalled();
		});

		it('renders blocks with data-block-index so scrollToMatch can find them', () => {
			const ref = { current: null } as React.MutableRefObject<MarkdownPreviewFastHandle | null>;
			const containerRef = { current: null } as React.MutableRefObject<HTMLDivElement | null>;
			const threeParagraphs = ['alpha', '', 'beta', '', 'gamma'].join('\n');
			const { container } = render(
				<MarkdownPreviewFast
					ref={ref}
					content={threeParagraphs}
					theme={mockTheme}
					markdownContainerRef={containerRef}
				/>
			);
			const blocks = container.querySelectorAll('[data-block-index]');
			expect(blocks.length).toBe(3);
			expect(blocks[0].getAttribute('data-block-index')).toBe('0');
			expect(blocks[1].getAttribute('data-block-index')).toBe('1');
			expect(blocks[2].getAttribute('data-block-index')).toBe('2');
		});
	});
});
