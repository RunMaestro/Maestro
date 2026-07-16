/**
 * Integration test for the Giant tier preview shell.
 *
 * Focus areas:
 *   - CM6 mounts in the host DOM with the document the caller provided
 *   - findInContent enumerates real matches via the headless search engine
 *   - scrollToMatch dispatches a CM6 selection + scrollIntoView transaction
 *   - destroy/cleanup on unmount; re-render with new content rebuilds the view
 *
 * Pure modules (languageLoader, themeAdapter, extensions, searchEngine) are
 * exhaustively unit-tested in sibling files.
 */

import React from 'react';
import { describe, it, expect, vi, afterAll } from 'vitest';
import { render } from '@testing-library/react';
import { mockTheme } from '../../../../helpers/mockTheme';

// CodeMirror 6 constructs MutationObserver / ResizeObserver / IntersectionObserver
// inside its internal DOMObserver. The default test setup mocks
// IntersectionObserver as a non-constructable vi.fn(), which crashes CM6. Swap
// in a real class so `new IntersectionObserver(cb)` succeeds in jsdom, then
// restore the original in teardown so the swap doesn't leak into other
// test files that share the worker.
class StubIntersectionObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
	takeRecords() {
		return [];
	}
}
const ioGlobal = globalThis as typeof globalThis & {
	IntersectionObserver: typeof IntersectionObserver;
};
const originalIntersectionObserver = ioGlobal.IntersectionObserver;
ioGlobal.IntersectionObserver = StubIntersectionObserver as unknown as typeof IntersectionObserver;

afterAll(() => {
	ioGlobal.IntersectionObserver = originalIntersectionObserver;
});

// Mock the lazy language loader: skip the dynamic imports so the test
// stays deterministic. We only need to verify the component doesn't crash
// when the loader resolves to null vs an extension.
vi.mock('../../../../../renderer/components/FilePreview/giantPreview/languageLoader', () => ({
	loadLanguageExtension: vi.fn(async () => null),
	hasLanguageSupport: (lang: string) => lang === 'markdown' || lang === 'typescript',
}));

import {
	GiantPreview,
	type GiantPreviewHandle,
} from '../../../../../renderer/components/FilePreview/giantPreview';

function renderGiant(opts: { content: string; language?: string }) {
	const containerRef = { current: null } as React.MutableRefObject<HTMLDivElement | null>;
	const ref = { current: null } as React.MutableRefObject<GiantPreviewHandle | null>;
	const result = render(
		<GiantPreview
			ref={ref}
			content={opts.content}
			language={opts.language ?? 'text'}
			theme={mockTheme}
			containerRef={containerRef}
		/>
	);
	return { ...result, containerRef, ref };
}

describe('GiantPreview', () => {
	describe('mount + content', () => {
		it('renders a host element with the giant-preview-root testid', () => {
			const { container } = renderGiant({ content: 'hello\nworld' });
			const root = container.querySelector('[data-testid="giant-preview-root"]');
			expect(root).not.toBeNull();
		});

		it('mounts a CodeMirror editor inside the host element', () => {
			const { container } = renderGiant({ content: 'cm6 doc body' });
			// CM6 mounts its .cm-editor inside our host. jsdom layout is broken
			// for measurements but the DOM structure still gets created.
			expect(container.querySelector('.cm-editor')).not.toBeNull();
		});

		it('places the document text inside the editor', () => {
			const { container } = renderGiant({ content: 'distinctive-marker-string' });
			expect(container.textContent).toContain('distinctive-marker-string');
		});

		it('writes the host element to the parent containerRef', () => {
			const { containerRef } = renderGiant({ content: 'x' });
			expect(containerRef.current).not.toBeNull();
			expect(containerRef.current).toBeInstanceOf(HTMLDivElement);
		});
	});

	describe('imperative handle', () => {
		it('findInContent enumerates every match in the loaded doc', () => {
			const { ref } = renderGiant({ content: 'alpha beta alpha beta alpha' });
			const hits = ref.current!.findInContent('alpha');
			expect(hits.length).toBe(3);
			expect(hits.map((h) => h.sourceOffset)).toEqual([0, 11, 22]);
			expect(hits.every((h) => h.length === 5)).toBe(true);
		});

		it('findInContent returns [] for an empty query', () => {
			const { ref } = renderGiant({ content: 'anything' });
			expect(ref.current!.findInContent('')).toEqual([]);
		});

		it('findInContent returns [] when the query is not present', () => {
			const { ref } = renderGiant({ content: 'hello world' });
			expect(ref.current!.findInContent('nope')).toEqual([]);
		});

		it('scrollToMatch dispatches a CM6 selection at the matched range', () => {
			const { container, ref } = renderGiant({ content: 'find the needle in haystack' });
			// "needle" starts at offset 9 in the doc, length 6.
			expect(() =>
				ref.current!.scrollToMatch({
					sourceOffset: 9,
					length: 6,
					blockIndex: 0,
					offsetWithinBlock: 9,
				})
			).not.toThrow();
			// CM6 paints selection on the .cm-content surface; we can't reliably
			// inspect the selected range in jsdom (no layout), but we can verify
			// the editor element still exists and didn't crash.
			expect(container.querySelector('.cm-editor')).not.toBeNull();
		});

		it('scrollToMatch clamps offsets that fall past the doc end', () => {
			const { ref } = renderGiant({ content: 'short' });
			// Pass a huge sourceOffset - must not throw or dispatch an invalid
			// selection; impl clamps to docLength before calling EditorSelection.
			expect(() =>
				ref.current!.scrollToMatch({
					sourceOffset: 9999,
					length: 10,
					blockIndex: 0,
					offsetWithinBlock: 9999,
				})
			).not.toThrow();
		});
	});

	describe('content + language updates', () => {
		it('replaces the editor when content changes', () => {
			const { container, rerender, containerRef } = renderGiant({ content: 'first marker' });
			expect(container.textContent).toContain('first marker');

			rerender(
				<GiantPreview
					content="second marker"
					language="text"
					theme={mockTheme}
					containerRef={containerRef}
				/>
			);
			expect(container.textContent).toContain('second marker');
			expect(container.textContent).not.toContain('first marker');
		});

		it('handles language changes without throwing', () => {
			const { rerender, containerRef } = renderGiant({
				content: 'const x = 1;',
				language: 'typescript',
			});
			expect(() =>
				rerender(
					<GiantPreview
						content="const x = 1;"
						language="markdown"
						theme={mockTheme}
						containerRef={containerRef}
					/>
				)
			).not.toThrow();
		});
	});

	describe('unmount cleanup', () => {
		it('cleans up the editor view on unmount', () => {
			const { unmount, container } = renderGiant({ content: 'x' });
			expect(container.querySelector('.cm-editor')).not.toBeNull();
			unmount();
			// After unmount, the host div + everything inside is gone from the
			// test container (testing-library detaches).
			expect(container.querySelector('.cm-editor')).toBeNull();
		});
	});
});
