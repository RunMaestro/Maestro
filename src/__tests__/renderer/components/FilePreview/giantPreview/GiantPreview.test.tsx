/**
 * Integration test for the Giant tier preview shell.
 *
 * The pure modules (languageLoader, themeAdapter, extensions, searchBridge)
 * are unit-tested in sibling files. This test focuses on:
 *   - that CM6 mounts in the host DOM with the document the caller provided
 *   - that the imperative handle's openSearch / closeSearch route to the
 *     real searchBridge (which we mock for verification)
 *   - that destroy/cleanup happens on unmount
 *   - that re-rendering with new content rebuilds the view
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
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

// Mock the searchBridge so we can assert open/close routing without poking
// at CM6's real search panel (which would need a real layout).
const openSearchSpy = vi.fn();
const closeSearchSpy = vi.fn();
vi.mock('../../../../../renderer/components/FilePreview/giantPreview/searchBridge', () => ({
	openSearch: (...args: unknown[]) => openSearchSpy(...args),
	closeSearch: (...args: unknown[]) => closeSearchSpy(...args),
}));

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
	beforeEach(() => {
		openSearchSpy.mockReset();
		closeSearchSpy.mockReset();
	});

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
		it('openSearch routes to the searchBridge', () => {
			const { ref } = renderGiant({ content: 'x' });
			ref.current!.openSearch();
			expect(openSearchSpy).toHaveBeenCalled();
		});

		it('openSearch forwards an initial query', () => {
			const { ref } = renderGiant({ content: 'x' });
			ref.current!.openSearch('needle');
			expect(openSearchSpy).toHaveBeenCalledWith(expect.anything(), 'needle');
		});

		it('closeSearch routes to the searchBridge', () => {
			const { ref } = renderGiant({ content: 'x' });
			ref.current!.closeSearch();
			expect(closeSearchSpy).toHaveBeenCalled();
		});

		it('findInContent always returns an empty array (CM6 owns search)', () => {
			const { ref } = renderGiant({ content: 'hello hello hello' });
			expect(ref.current!.findInContent('hello')).toEqual([]);
		});

		it('scrollToMatch is a no-op (CM6 owns scrolling)', () => {
			const { ref } = renderGiant({ content: 'x' });
			expect(() => ref.current!.scrollToMatch({ blockIndex: 5 })).not.toThrow();
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
