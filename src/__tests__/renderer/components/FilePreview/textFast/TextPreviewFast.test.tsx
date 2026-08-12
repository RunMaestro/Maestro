/**
 * Integration test for the Fast tier text preview component.
 *
 * Pure modules (pagination, proseStyles, codeHighlighter, searchHits) are
 * exhaustively unit-tested in sibling files. This test covers the React
 * wiring: parse lifecycle, virtualizer integration (via a stubbed
 * @tanstack/react-virtual), imperative handle, parent-ref bridging.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { mockTheme } from '../../../../helpers/mockTheme';

// Stub TanStack Virtual so the test environment returns predictable virtual
// items regardless of layout state.
vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: (opts: { count: number; estimateSize: () => number }) => {
		const items = Array.from({ length: opts.count }, (_, index) => ({
			index,
			key: index,
			start: index * opts.estimateSize(),
			size: opts.estimateSize(),
		}));
		return {
			getTotalSize: () => opts.count * opts.estimateSize(),
			getVirtualItems: () => items,
			scrollToIndex: vi.fn(),
		};
	},
}));

import {
	TextPreviewFast,
	type TextPreviewFastHandle,
} from '../../../../../renderer/components/FilePreview/textFast';

function renderPreview(opts: { content: string; language?: string }) {
	const containerRef = { current: null } as React.MutableRefObject<HTMLDivElement | null>;
	const ref = { current: null } as React.MutableRefObject<TextPreviewFastHandle | null>;
	const result = render(
		<TextPreviewFast
			ref={ref}
			content={opts.content}
			language={opts.language ?? 'text'}
			theme={mockTheme}
			containerRef={containerRef}
		/>
	);
	return { ...result, containerRef, ref };
}

describe('TextPreviewFast', () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	describe('parse + render lifecycle', () => {
		it('renders pages synchronously for small input', () => {
			const content = ['line 1', 'line 2', 'line 3'].join('\n');
			const { container } = renderPreview({ content });
			expect(screen.getByTestId('text-fast-root')).toBeTruthy();
			expect(screen.queryByTestId('text-fast-skeleton')).toBeNull();
			// testing-library normalizes whitespace in queries; use textContent
			// directly to keep newlines for the assertion.
			const contentCol = container.querySelector('.text-fast-content');
			expect(contentCol?.textContent).toBe('line 1\nline 2\nline 3');
		});

		it('shows the parse skeleton for large input then renders pages', async () => {
			// Just above the 64 KB sync-parse threshold so the deferred path runs.
			const SYNC_PARSE_BYTES = 64 * 1024;
			const line = 'abcdefghij\n';
			const content = line.repeat(Math.ceil(SYNC_PARSE_BYTES / line.length) + 100);
			expect(content.length).toBeGreaterThan(SYNC_PARSE_BYTES);

			renderPreview({ content });
			expect(screen.getByTestId('text-fast-skeleton')).toBeTruthy();

			await waitFor(
				() => {
					expect(screen.queryByTestId('text-fast-skeleton')).toBeNull();
				},
				{ timeout: 5_000 }
			);
		});

		it('re-parses when content changes', () => {
			const { rerender, containerRef } = renderPreview({ content: 'first line' });
			expect(screen.getByText('first line')).toBeTruthy();

			rerender(
				<TextPreviewFast
					content="second line"
					language="text"
					theme={mockTheme}
					containerRef={containerRef}
				/>
			);
			expect(screen.queryByText('first line')).toBeNull();
			expect(screen.getByText('second line')).toBeTruthy();
		});
	});

	describe('plain-text rendering', () => {
		it('emits a line-number gutter for every page', () => {
			const content = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');
			const { container } = renderPreview({ content });
			const gutter = container.querySelector('.text-fast-gutter');
			expect(gutter).not.toBeNull();
			// 5 lines → gutter shows "1\n2\n3\n4\n5"
			expect(gutter!.textContent).toBe('1\n2\n3\n4\n5');
		});

		it('does NOT wrap plain text in a <pre><code> (no Shiki path)', () => {
			const { container } = renderPreview({ content: 'plain text only' });
			expect(container.querySelector('pre')).toBeNull();
		});

		it('embeds the prose stylesheet', () => {
			const { container } = renderPreview({ content: 'x' });
			const style = container.querySelector('style');
			expect(style?.textContent).toContain('.text-fast-page');
		});
	});

	describe('code rendering', () => {
		it('wraps code lines in <pre><code class="language-X">', () => {
			const { container } = renderPreview({
				content: 'const x = 1;\nconst y = 2;',
				language: 'typescript',
			});
			const code = container.querySelector('pre > code');
			expect(code).not.toBeNull();
			expect(code!.getAttribute('class')).toBe('language-typescript');
		});

		it('escapes special HTML characters in the source', () => {
			const { container } = renderPreview({
				content: '<script>alert("hi")</script>',
				language: 'javascript',
			});
			const code = container.querySelector('pre > code');
			expect(code).not.toBeNull();
			// Raw script tag must not appear as parsed HTML.
			expect(code!.innerHTML).toContain('&lt;script&gt;');
			expect(container.querySelector('script')).toBeNull();
		});
	});

	describe('parent ref bridging', () => {
		it('writes the scroll container to the parent containerRef', () => {
			const ref = { current: null } as React.MutableRefObject<HTMLDivElement | null>;
			render(<TextPreviewFast content="x" language="text" theme={mockTheme} containerRef={ref} />);
			expect(ref.current).not.toBeNull();
			expect(ref.current).toBeInstanceOf(HTMLDivElement);
		});
	});

	describe('imperative handle', () => {
		it('exposes getPageCount returning the number of pages', () => {
			const lines = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n');
			const { ref } = renderPreview({ content: lines });
			// Default 80 lines per page → 200 lines = 3 pages
			expect(ref.current?.getPageCount()).toBe(3);
		});

		it('findInContent reports matches with correct page indices', () => {
			const content = ['needle one', 'something', 'needle two', 'last'].join('\n');
			const { ref } = renderPreview({ content });
			const hits = ref.current!.findInContent('needle');
			expect(hits.length).toBe(2);
			expect(hits.every((h) => h.blockIndex === 0)).toBe(true);
		});

		it('findInContent returns empty for missing query', () => {
			const { ref } = renderPreview({ content: 'hello world' });
			expect(ref.current!.findInContent('nope')).toEqual([]);
		});

		it('findInContent returns empty for empty query', () => {
			const { ref } = renderPreview({ content: 'hello world' });
			expect(ref.current!.findInContent('')).toEqual([]);
		});

		it('scrollToMatch is a no-op for out-of-range block index', () => {
			const { ref } = renderPreview({ content: 'a\nb\nc' });
			expect(() => ref.current!.scrollToMatch({ blockIndex: 9999 })).not.toThrow();
			expect(() => ref.current!.scrollToMatch({ blockIndex: -1 })).not.toThrow();
		});

		it('scrollToMatch calls the virtualizer for an in-range index', () => {
			const content = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n');
			const { ref } = renderPreview({ content });
			expect(() =>
				ref.current!.scrollToMatch({
					blockIndex: 1,
					sourceOffset: 0,
					length: 1,
					offsetWithinBlock: 0,
				})
			).not.toThrow();
		});
	});

	describe('scrollToMatch precision (B3)', () => {
		function flushRaf(): Promise<void> {
			return new Promise((resolve) => requestAnimationFrame(() => resolve()));
		}

		it('nudges the matched word inside the page into view after virtualizer scroll', async () => {
			// Two pages: first page "alpha…", second page "needle in haystack".
			// Default page size is 80 lines, so we generate 81 lines to force 2 pages.
			const lines = [
				...Array.from({ length: 80 }, (_, i) => `alpha line ${i}`),
				'needle in haystack',
			];
			const content = lines.join('\n');
			const { ref } = renderPreview({ content });

			const scrollIntoViewSpy = vi.fn();
			Element.prototype.scrollIntoView = scrollIntoViewSpy;

			// Page 1 sourceStart is end-of-page-0. The hit for "needle" lives
			// at offset 0 within page 1 (the page begins with that line).
			ref.current!.scrollToMatch({
				sourceOffset: 0,
				length: 6,
				blockIndex: 1,
				offsetWithinBlock: 0,
			});

			await flushRaf();
			await flushRaf();

			// Precision scroll should fire - either the page's parent element or
			// a child text-node parent gets scrollIntoView.
			expect(scrollIntoViewSpy).toHaveBeenCalled();
			const last = scrollIntoViewSpy.mock.calls.at(-1);
			expect(last?.[0]).toEqual({ block: 'nearest', behavior: 'auto' });
		});
	});
});
