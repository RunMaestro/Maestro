/**
 * Behavior tests for `useFilePreviewSearch` focused on the count-vs-navigate
 * effect split (B1 of the search-hardening plan).
 *
 * Why: before the split, both effects lived in one. Listing `currentMatchIndex`
 * in the deps meant every prev/next press re-ran `findHits` and re-walked the
 * DOM, producing the "wobble" the user reported. These tests assert:
 *   - `findHits` is called once per query, not per navigation
 *   - `totalMatches` is stable across navigation
 *   - `currentMatchIndex` resets to 0 on query change
 *   - the CSS Highlight "search-current" swaps without re-counting
 */

import React, { useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useFilePreviewSearch } from '../../../../renderer/hooks/file/useFilePreviewSearch';
import type {
	FilePreviewSearchAdapter,
	SearchHit,
} from '../../../../renderer/components/FilePreview/search/types';
import type { MarkdownEditorHandle } from '../../../../renderer/components/FilePreview/markdownEditor';

// jsdom doesn't ship the CSS Custom Highlight API. Polyfill enough surface so
// the hook's `'highlights' in CSS` branch executes and we can introspect what
// was registered.
class FakeHighlight {
	ranges: Range[];
	constructor(...ranges: Range[]) {
		this.ranges = ranges;
	}
}
const fakeHighlightStore = new Map<string, FakeHighlight>();
const fakeHighlightsApi = {
	set: vi.fn((name: string, hl: FakeHighlight) => {
		fakeHighlightStore.set(name, hl);
	}),
	delete: vi.fn((name: string) => {
		fakeHighlightStore.delete(name);
	}),
	clear: vi.fn(() => fakeHighlightStore.clear()),
};

interface HostHandle {
	setSearchQuery: (q: string) => void;
	goToNextMatch: () => void;
	goToPrevMatch: () => void;
	getTotalMatches: () => number;
	getCurrentMatchIndex: () => number;
}

function makeAdapter(
	hits: SearchHit[],
	findHitsSpy?: ReturnType<typeof vi.fn>
): FilePreviewSearchAdapter {
	const spy =
		findHitsSpy ??
		vi.fn((q: string) => {
			if (!q) return [];
			return hits;
		});
	return {
		findHits: spy as unknown as FilePreviewSearchAdapter['findHits'],
		scrollToMatch: vi.fn(),
	};
}

function Host(props: {
	adapter?: FilePreviewSearchAdapter;
	fileContent?: string;
	expose: (h: HostHandle) => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const codeRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const editorRef = useRef<MarkdownEditorHandle>(null);

	const hook = useFilePreviewSearch({
		codeContainerRef: codeRef,
		markdownContainerRef: containerRef,
		contentRef,
		editorRef,
		isMarkdown: true,
		isReadableText: false,
		isImage: false,
		isCsv: false,
		isJsonl: false,
		isJson: false,
		isEditableText: false,
		markdownEditMode: false,
		editContent: '',
		fileContent: props.fileContent ?? 'Hello world hello again hello upper',
		searchMode: 'text',
		searchAdapter: props.adapter,
	});

	// Expose the imperative bits to the test.
	props.expose({
		setSearchQuery: hook.setSearchQuery,
		goToNextMatch: hook.goToNextMatch,
		goToPrevMatch: hook.goToPrevMatch,
		getTotalMatches: () => hook.totalMatches,
		getCurrentMatchIndex: () => hook.currentMatchIndex,
	});

	return (
		<div>
			<div ref={contentRef} style={{ height: 200, overflow: 'auto' }}>
				<div ref={containerRef}>
					<p>Hello world</p>
					<p>hello again</p>
					<p>hello upper</p>
				</div>
			</div>
			<div ref={codeRef} />
		</div>
	);
}

beforeEach(() => {
	fakeHighlightStore.clear();
	fakeHighlightsApi.set.mockClear();
	fakeHighlightsApi.delete.mockClear();
	// Patch jsdom's CSS object with our Custom Highlight stub.
	(globalThis as { CSS: typeof CSS }).CSS = {
		...(globalThis.CSS ?? {}),
		highlights: fakeHighlightsApi,
	} as unknown as typeof CSS;
	(globalThis as { Highlight: typeof FakeHighlight }).Highlight = FakeHighlight;
	(window as unknown as { Highlight: typeof FakeHighlight }).Highlight = FakeHighlight;
});

// NOTE: don't delete globalThis.CSS / Highlight here. React schedules effect
// cleanups asynchronously and they may run *after* afterEach; deleting the
// globals first crashes the cleanup path. beforeEach reassigns both fresh.

function renderHost(props: Omit<Parameters<typeof Host>[0], 'expose'>) {
	// Mutable holder so the test sees the LATEST hook state after re-renders.
	// (Destructuring a `handle` value captures the first render only and goes
	// stale once setState triggers re-renders.)
	const ref: { current: HostHandle | undefined } = { current: undefined };
	const utils = render(
		<Host
			{...props}
			expose={(h) => {
				ref.current = h;
			}}
		/>
	);
	if (!ref.current) throw new Error('Host failed to expose handle');
	const handle: HostHandle = {
		setSearchQuery: (q) => ref.current!.setSearchQuery(q),
		goToNextMatch: () => ref.current!.goToNextMatch(),
		goToPrevMatch: () => ref.current!.goToPrevMatch(),
		getTotalMatches: () => ref.current!.getTotalMatches(),
		getCurrentMatchIndex: () => ref.current!.getCurrentMatchIndex(),
	};
	return { ...utils, handle };
}

describe('useFilePreviewSearch - count vs navigate split', () => {
	it('calls adapter.findHits exactly once per query change, not per navigation', async () => {
		const findHits = vi.fn((): SearchHit[] => [
			{ sourceOffset: 0, length: 5, blockIndex: 0, offsetWithinBlock: 0 },
			{ sourceOffset: 12, length: 5, blockIndex: 1, offsetWithinBlock: 0 },
			{ sourceOffset: 24, length: 5, blockIndex: 2, offsetWithinBlock: 0 },
		]);
		const adapter = makeAdapter([], findHits);
		const { handle } = renderHost({ adapter });

		await act(async () => {
			handle.setSearchQuery('hello');
		});
		// First call: count effect on query change.
		expect(findHits).toHaveBeenCalledTimes(1);

		// Three nav presses must NOT trigger any additional findHits calls.
		await act(async () => {
			handle.goToNextMatch();
		});
		await act(async () => {
			handle.goToNextMatch();
		});
		await act(async () => {
			handle.goToPrevMatch();
		});

		expect(findHits).toHaveBeenCalledTimes(1);
	});

	it('keeps totalMatches stable across prev/next navigation', async () => {
		const adapter = makeAdapter([
			{ sourceOffset: 0, length: 5, blockIndex: 0, offsetWithinBlock: 0 },
			{ sourceOffset: 12, length: 5, blockIndex: 1, offsetWithinBlock: 0 },
			{ sourceOffset: 24, length: 5, blockIndex: 2, offsetWithinBlock: 0 },
		]);
		const { handle } = renderHost({ adapter });

		await act(async () => {
			handle.setSearchQuery('hello');
		});
		expect(handle.getTotalMatches()).toBe(3);

		for (let i = 0; i < 5; i++) {
			await act(async () => {
				handle.goToNextMatch();
			});
			expect(handle.getTotalMatches()).toBe(3);
		}
	});

	it('resets currentMatchIndex to 0 when a new query produces matches', async () => {
		const adapter = makeAdapter([
			{ sourceOffset: 0, length: 5, blockIndex: 0, offsetWithinBlock: 0 },
			{ sourceOffset: 12, length: 5, blockIndex: 1, offsetWithinBlock: 0 },
		]);
		const { handle } = renderHost({ adapter });

		await act(async () => {
			handle.setSearchQuery('hello');
		});
		expect(handle.getCurrentMatchIndex()).toBe(0);

		// Navigate forward so the index is non-zero before the next query.
		await act(async () => {
			handle.goToNextMatch();
		});
		expect(handle.getCurrentMatchIndex()).toBe(1);

		// Change query → count effect re-runs and bumps index back to 0.
		await act(async () => {
			handle.setSearchQuery('world');
		});
		expect(handle.getCurrentMatchIndex()).toBe(0);
	});

	it('sets currentMatchIndex to -1 and total to 0 when the new query has no matches', async () => {
		const adapter = makeAdapter([]);
		const { handle } = renderHost({ adapter });

		await act(async () => {
			handle.setSearchQuery('nothing');
		});
		expect(handle.getTotalMatches()).toBe(0);
		expect(handle.getCurrentMatchIndex()).toBe(-1);
	});

	it('calls adapter.scrollToMatch on every navigation with the right hit', async () => {
		const hits: SearchHit[] = [
			{ sourceOffset: 0, length: 5, blockIndex: 0, offsetWithinBlock: 0 },
			{ sourceOffset: 12, length: 5, blockIndex: 1, offsetWithinBlock: 0 },
			{ sourceOffset: 24, length: 5, blockIndex: 2, offsetWithinBlock: 0 },
		];
		const adapter = makeAdapter(hits);
		const { handle } = renderHost({ adapter });

		await act(async () => {
			handle.setSearchQuery('hello');
		});
		// Count effect already triggered one scroll (to hit 0).
		expect(adapter.scrollToMatch).toHaveBeenLastCalledWith(hits[0]);

		await act(async () => {
			handle.goToNextMatch();
		});
		expect(adapter.scrollToMatch).toHaveBeenLastCalledWith(hits[1]);

		await act(async () => {
			handle.goToNextMatch();
		});
		expect(adapter.scrollToMatch).toHaveBeenLastCalledWith(hits[2]);

		await act(async () => {
			handle.goToPrevMatch();
		});
		expect(adapter.scrollToMatch).toHaveBeenLastCalledWith(hits[1]);
	});

	it('does not crash when the new query shrinks hits below currentMatchIndex', async () => {
		// Reproduces the race that crashed FilePreview with
		// "Cannot read properties of undefined (reading 'blockIndex')":
		// 1. Old query returned many hits, user navigated to index N.
		// 2. New query returns fewer hits (< N+1). The count effect updates
		//    hitsRef + dispatches setCurrentMatchIndex(0) in the same render,
		//    but the navigate effect still reads the OLD currentMatchIndex
		//    before React commits the new one. `hits[OLD_INDEX]` is undefined.
		// The hook must guard this without crashing.
		const manyHits: SearchHit[] = Array.from({ length: 10 }, (_, i) => ({
			sourceOffset: i,
			length: 3,
			blockIndex: 0,
			offsetWithinBlock: i,
		}));
		const oneHit: SearchHit[] = [
			{ sourceOffset: 0, length: 3, blockIndex: 0, offsetWithinBlock: 0 },
		];
		// findHits return depends on the active query - flip the array when
		// the query changes to simulate a shrinking result set.
		const findHitsSpy = vi.fn((q: string) => {
			if (q === 'aaa') return manyHits;
			if (q === 'bbb') return oneHit;
			return [];
		});
		const adapter = makeAdapter([], findHitsSpy);
		const { handle } = renderHost({ adapter });

		// Get to a high index against the long results.
		await act(async () => {
			handle.setSearchQuery('aaa');
		});
		for (let i = 0; i < 9; i++) {
			await act(async () => {
				handle.goToNextMatch();
			});
		}
		expect(handle.getCurrentMatchIndex()).toBe(9);

		// Switch to a query with only one hit. The navigate effect may fire
		// once with the old index against the new hits array; it must NOT
		// throw. The next render commits index 0 and recovers.
		await act(async () => {
			handle.setSearchQuery('bbb');
		});
		expect(handle.getTotalMatches()).toBe(1);
		expect(handle.getCurrentMatchIndex()).toBe(0);
	});

	it('clears Highlights when the query is cleared', async () => {
		const hits: SearchHit[] = [{ sourceOffset: 0, length: 5, blockIndex: 0, offsetWithinBlock: 0 }];
		const adapter = makeAdapter(hits);
		const { handle } = renderHost({ adapter });

		await act(async () => {
			handle.setSearchQuery('hello');
		});
		expect(fakeHighlightStore.has('search-results') || fakeHighlightStore.size === 0).toBe(true);

		await act(async () => {
			handle.setSearchQuery('');
		});
		// After clearing, neither Highlight should be registered (either deleted
		// or never reapplied).
		expect(fakeHighlightStore.has('search-results')).toBe(false);
		expect(fakeHighlightStore.has('search-current')).toBe(false);
		expect(handle.getTotalMatches()).toBe(0);
		expect(handle.getCurrentMatchIndex()).toBe(-1);
	});

	it('registers both search-results AND search-current Highlights on initial count + navigate', async () => {
		const hits: SearchHit[] = [
			{ sourceOffset: 0, length: 5, blockIndex: 0, offsetWithinBlock: 0 },
			{ sourceOffset: 12, length: 5, blockIndex: 0, offsetWithinBlock: 12 },
		];
		const adapter = makeAdapter(hits);
		const { handle } = renderHost({ adapter });

		await act(async () => {
			handle.setSearchQuery('hello');
		});
		// Wait one rAF for the navigate effect's post-scroll DOM walk to apply
		// the current-match Highlight (adapter-driven tier path).
		await act(async () => {
			await new Promise((r) => requestAnimationFrame(() => r(undefined)));
		});

		expect(fakeHighlightStore.has('search-results')).toBe(true);
		expect(fakeHighlightStore.has('search-current')).toBe(true);
	});
});

describe('useFilePreviewSearch - gutter exclusion (B5)', () => {
	it('skips text inside .text-fast-gutter and .cm-gutters elements', async () => {
		// Rich-tier path (no adapter): count comes from the DOM walker. A
		// container with a gutter line-number "42" and a body "42" must count
		// only the body one - the search bar should never highlight gutter
		// chrome.
		function GutterHost(props: { expose: (h: HostHandle) => void }) {
			const containerRef = React.useRef<HTMLDivElement>(null);
			const codeRef = React.useRef<HTMLDivElement>(null);
			const contentRef = React.useRef<HTMLDivElement>(null);
			const editorRef = React.useRef<MarkdownEditorHandle>(null);
			const hook = useFilePreviewSearch({
				codeContainerRef: codeRef,
				markdownContainerRef: containerRef,
				contentRef,
				editorRef,
				isMarkdown: false,
				isReadableText: true,
				isImage: false,
				isCsv: false,
				isJsonl: false,
				isJson: false,
				isEditableText: false,
				markdownEditMode: false,
				editContent: '',
				fileContent: '42 in body\nline 42',
				searchMode: 'text',
			});
			props.expose({
				setSearchQuery: hook.setSearchQuery,
				goToNextMatch: hook.goToNextMatch,
				goToPrevMatch: hook.goToPrevMatch,
				getTotalMatches: () => hook.totalMatches,
				getCurrentMatchIndex: () => hook.currentMatchIndex,
			});
			return (
				<div ref={contentRef}>
					<div ref={containerRef}>
						<div className="text-fast-gutter">42</div>
						<div>body text 42 here</div>
					</div>
				</div>
			);
		}

		const ref: { current: HostHandle | undefined } = { current: undefined };
		render(<GutterHost expose={(h) => (ref.current = h)} />);
		const handle: HostHandle = {
			setSearchQuery: (q) => ref.current!.setSearchQuery(q),
			goToNextMatch: () => ref.current!.goToNextMatch(),
			goToPrevMatch: () => ref.current!.goToPrevMatch(),
			getTotalMatches: () => ref.current!.getTotalMatches(),
			getCurrentMatchIndex: () => ref.current!.getCurrentMatchIndex(),
		};

		await act(async () => {
			handle.setSearchQuery('42');
		});

		// Gutter "42" is excluded → only the body "42" counts.
		expect(handle.getTotalMatches()).toBe(1);
	});
});

describe('useFilePreviewSearch - search kind (text / regex / line)', () => {
	interface KindHandle extends HostHandle {
		setSearchKind: (k: 'text' | 'regex' | 'line') => void;
		getSearchKind: () => string;
	}

	function KindHost(props: {
		adapter: FilePreviewSearchAdapter;
		supportsLineSearch: boolean;
		expose: (h: KindHandle) => void;
	}) {
		const containerRef = useRef<HTMLDivElement>(null);
		const codeRef = useRef<HTMLDivElement>(null);
		const contentRef = useRef<HTMLDivElement>(null);
		const editorRef = useRef<MarkdownEditorHandle>(null);
		const hook = useFilePreviewSearch({
			codeContainerRef: codeRef,
			markdownContainerRef: containerRef,
			contentRef,
			editorRef,
			isMarkdown: true,
			isReadableText: false,
			isImage: false,
			isCsv: false,
			isJsonl: false,
			isJson: false,
			isEditableText: false,
			markdownEditMode: false,
			editContent: '',
			fileContent: 'axb a.b\nline three',
			searchMode: 'text',
			supportsLineSearch: props.supportsLineSearch,
			searchAdapter: props.adapter,
		});
		props.expose({
			setSearchQuery: hook.setSearchQuery,
			goToNextMatch: hook.goToNextMatch,
			goToPrevMatch: hook.goToPrevMatch,
			getTotalMatches: () => hook.totalMatches,
			getCurrentMatchIndex: () => hook.currentMatchIndex,
			setSearchKind: hook.setSearchKind,
			getSearchKind: () => hook.searchKind,
		});
		return (
			<div>
				<div ref={contentRef}>
					<div ref={containerRef}>
						<p>axb a.b</p>
						<p>line three</p>
					</div>
				</div>
				<div ref={codeRef} />
			</div>
		);
	}

	function renderKindHost(adapter: FilePreviewSearchAdapter, supportsLineSearch = true) {
		const ref: { current: KindHandle | undefined } = { current: undefined };
		render(
			<KindHost
				adapter={adapter}
				supportsLineSearch={supportsLineSearch}
				expose={(h) => (ref.current = h)}
			/>
		);
		if (!ref.current) throw new Error('KindHost failed to expose handle');
		return ref.current;
	}

	it('forwards { regex: true } to the adapter in regex mode', async () => {
		const findHits = vi.fn((): SearchHit[] => []);
		const adapter: FilePreviewSearchAdapter = {
			findHits: findHits as unknown as FilePreviewSearchAdapter['findHits'],
			scrollToMatch: vi.fn(),
		};
		const handle = renderKindHost(adapter);

		await act(async () => {
			handle.setSearchKind('regex');
		});
		await act(async () => {
			handle.setSearchQuery('a.b');
		});

		expect(findHits).toHaveBeenLastCalledWith('a.b', { regex: true });
	});

	it('jumps via adapter.scrollToLine in line mode and reports no text matches', async () => {
		const scrollToLine = vi.fn();
		const adapter: FilePreviewSearchAdapter = {
			findHits: vi.fn(() => [{ sourceOffset: 0, length: 3, blockIndex: 0, offsetWithinBlock: 0 }]),
			scrollToMatch: vi.fn(),
			scrollToLine,
		};
		const handle = renderKindHost(adapter);

		await act(async () => {
			handle.setSearchKind('line');
		});
		await act(async () => {
			handle.setSearchQuery('2');
		});

		expect(scrollToLine).toHaveBeenLastCalledWith(2);
		// Line mode shows no match count / navigation chrome.
		expect(handle.getTotalMatches()).toBe(0);
	});

	it('ignores a non-numeric query in line mode (no jump)', async () => {
		const scrollToLine = vi.fn();
		const adapter: FilePreviewSearchAdapter = {
			findHits: vi.fn(() => []),
			scrollToMatch: vi.fn(),
			scrollToLine,
		};
		const handle = renderKindHost(adapter);

		await act(async () => {
			handle.setSearchKind('line');
		});
		await act(async () => {
			handle.setSearchQuery('not-a-line');
		});

		expect(scrollToLine).not.toHaveBeenCalled();
	});

	it('collapses to plain text when the view does not support line search', async () => {
		const findHits = vi.fn((): SearchHit[] => []);
		const adapter: FilePreviewSearchAdapter = {
			findHits: findHits as unknown as FilePreviewSearchAdapter['findHits'],
			scrollToMatch: vi.fn(),
		};
		const handle = renderKindHost(adapter, /* supportsLineSearch */ false);

		await act(async () => {
			handle.setSearchKind('regex');
		});
		// Even after requesting regex, an unsupported view reports plain 'text'.
		expect(handle.getSearchKind()).toBe('text');

		await act(async () => {
			handle.setSearchQuery('a.b');
		});
		expect(findHits).toHaveBeenLastCalledWith('a.b', { regex: false });
	});
});

/**
 * Regression: the syntax-highlighted code tier used to wrap every match in an
 * injected `<mark>` via `replaceChild`, mutating DOM that React owns. When the
 * highlighter later re-rendered a token that now sat under one of those
 * wrappers, Chromium threw
 * `NotFoundError: Failed to execute 'removeChild' on 'Node'` and the app-level
 * error boundary took the whole window down. Reported live from a file preview.
 *
 * The tier now paints through the CSS Custom Highlight API instead, so these
 * tests assert the DOM is left byte-identical and the highlight registry does
 * the work.
 */
describe('useFilePreviewSearch - code tier does not mutate React-owned DOM', () => {
	interface CodeHandle {
		setSearchQuery: (q: string) => void;
		goToNextMatch: () => void;
		getTotalMatches: () => number;
		getCurrentMatchIndex: () => number;
	}

	function CodeHost(props: { expose: (h: CodeHandle) => void }) {
		const containerRef = useRef<HTMLDivElement>(null);
		const codeRef = useRef<HTMLDivElement>(null);
		const contentRef = useRef<HTMLDivElement>(null);
		const editorRef = useRef<MarkdownEditorHandle>(null);

		const hook = useFilePreviewSearch({
			codeContainerRef: codeRef,
			markdownContainerRef: containerRef,
			contentRef,
			editorRef,
			isMarkdown: false,
			isReadableText: false,
			isImage: false,
			isCsv: false,
			isJsonl: false,
			isJson: false,
			isEditableText: true,
			markdownEditMode: false,
			editContent: '',
			fileContent: 'const alpha = 1;\nconst beta = alpha + alpha;',
			searchMode: 'text',
		});

		props.expose({
			setSearchQuery: hook.setSearchQuery,
			goToNextMatch: hook.goToNextMatch,
			getTotalMatches: () => hook.totalMatches,
			getCurrentMatchIndex: () => hook.currentMatchIndex,
		});

		return (
			<div>
				<div ref={contentRef} style={{ height: 200, overflow: 'auto' }}>
					{/* Mimics the highlighter's nested token tree. */}
					<div ref={codeRef}>
						<pre>
							<code>
								<span>const alpha = 1;</span>
								<span>const beta = alpha + alpha;</span>
							</code>
						</pre>
					</div>
				</div>
				<div ref={containerRef} />
			</div>
		);
	}

	function renderCodeHost() {
		const ref: { current: CodeHandle | undefined } = { current: undefined };
		const utils = render(
			<CodeHost
				expose={(h) => {
					ref.current = h;
				}}
			/>
		);
		if (!ref.current) throw new Error('CodeHost failed to expose handle');
		// Indirect through the holder, same reason as `renderHost` above: a
		// captured handle goes stale the moment setState re-renders.
		const handle: CodeHandle = {
			setSearchQuery: (q) => ref.current!.setSearchQuery(q),
			goToNextMatch: () => ref.current!.goToNextMatch(),
			getTotalMatches: () => ref.current!.getTotalMatches(),
			getCurrentMatchIndex: () => ref.current!.getCurrentMatchIndex(),
		};
		return { ...utils, handle };
	}

	it('leaves the code container untouched while highlighting matches', async () => {
		const { handle, container } = renderCodeHost();
		const codeEl = container.querySelector('pre') as HTMLElement;
		const before = codeEl.innerHTML;

		await act(async () => {
			handle.setSearchQuery('alpha');
		});

		// The defect: any `<mark>` here means the crash path is back.
		expect(codeEl.querySelectorAll('mark').length).toBe(0);
		expect(codeEl.innerHTML).toBe(before);
		// And the search still works: 3 occurrences of "alpha".
		expect(handle.getTotalMatches()).toBe(3);
		expect(fakeHighlightStore.get('search-results')?.ranges).toHaveLength(3);
	});

	it('swaps the current-match highlight without touching the DOM', async () => {
		const { handle, container } = renderCodeHost();
		const codeEl = container.querySelector('pre') as HTMLElement;

		await act(async () => {
			handle.setSearchQuery('alpha');
		});
		const afterQuery = codeEl.innerHTML;
		const first = fakeHighlightStore.get('search-current')?.ranges[0];

		await act(async () => {
			handle.goToNextMatch();
		});

		expect(handle.getCurrentMatchIndex()).toBe(1);
		expect(fakeHighlightStore.get('search-current')?.ranges[0]).not.toBe(first);
		expect(codeEl.querySelectorAll('mark').length).toBe(0);
		expect(codeEl.innerHTML).toBe(afterQuery);
	});

	it('clears its highlights when the query is emptied', async () => {
		const { handle } = renderCodeHost();

		await act(async () => {
			handle.setSearchQuery('alpha');
		});
		expect(fakeHighlightStore.has('search-results')).toBe(true);

		await act(async () => {
			handle.setSearchQuery('');
		});
		expect(fakeHighlightStore.has('search-results')).toBe(false);
		expect(fakeHighlightStore.has('search-current')).toBe(false);
		expect(handle.getTotalMatches()).toBe(0);
	});
});

/**
 * Replace in the code editor. The hook computes the edits from the same
 * pattern that paints the matches and hands them to the editor in one
 * `replaceRanges` call, which is what makes Replace All a single undo step.
 */
describe('useFilePreviewSearch - replace (edit mode)', () => {
	interface ReplaceHandle {
		setSearchQuery: (q: string) => void;
		cycleSearchKind: () => void;
		replaceCurrent: (r: string) => boolean;
		replaceAll: (r: string) => number;
		canReplace: () => boolean;
		currentMatchIndex: () => number;
		content: () => string;
	}

	function makeEditor(apply: (next: (prev: string) => string) => void) {
		const replaceRanges = vi.fn((changes: { from: number; to: number; insert: string }[]) => {
			apply((prev) =>
				[...changes]
					.sort((a, b) => b.from - a.from)
					.reduce((text, c) => text.slice(0, c.from) + c.insert + text.slice(c.to), prev)
			);
		});
		const editor = {
			setSearchMatches: vi.fn(),
			setSelection: vi.fn(),
			replaceRanges,
		} as unknown as MarkdownEditorHandle;
		return { editor, replaceRanges, setSelection: editor.setSelection as ReturnType<typeof vi.fn> };
	}

	function renderReplaceHost(initial: string, opts: { markdownEditMode?: boolean } = {}) {
		const ref: { current: ReplaceHandle | undefined } = { current: undefined };
		let editorParts: ReturnType<typeof makeEditor> | undefined;

		function ReplaceHost() {
			const [content, setContent] = React.useState(initial);
			const containerRef = useRef<HTMLDivElement>(null);
			const codeRef = useRef<HTMLDivElement>(null);
			const contentRef = useRef<HTMLDivElement>(null);
			const editorRef = useRef<MarkdownEditorHandle | null>(null);
			if (!editorRef.current) {
				editorParts = makeEditor((next) => setContent(next));
				editorRef.current = editorParts.editor;
			}
			const hook = useFilePreviewSearch({
				codeContainerRef: codeRef,
				markdownContainerRef: containerRef,
				contentRef,
				editorRef,
				isMarkdown: false,
				isImage: false,
				isCsv: false,
				isJsonl: false,
				isJson: false,
				isEditableText: true,
				markdownEditMode: opts.markdownEditMode ?? true,
				editContent: content,
				fileContent: initial,
				searchMode: 'text',
				supportsLineSearch: true,
			});
			ref.current = {
				setSearchQuery: hook.setSearchQuery,
				cycleSearchKind: hook.cycleSearchKind,
				replaceCurrent: hook.replaceCurrent,
				replaceAll: hook.replaceAll,
				canReplace: () => hook.canReplace,
				currentMatchIndex: () => hook.currentMatchIndex,
				content: () => content,
			};
			return (
				<div>
					<div ref={contentRef} />
					<div ref={codeRef} />
					<div ref={containerRef} />
				</div>
			);
		}

		render(<ReplaceHost />);
		const handle = new Proxy({} as ReplaceHandle, {
			get: (_t, key: keyof ReplaceHandle) => ref.current![key],
		});
		return { handle, editor: editorParts! };
	}

	it('replaces every match in ONE editor call (one undo step)', async () => {
		const { handle, editor } = renderReplaceHost('foo bar Foo baz foo');
		await act(async () => handle.setSearchQuery('foo'));

		let replaced = 0;
		await act(async () => {
			replaced = handle.replaceAll('qux');
		});

		expect(replaced).toBe(3);
		expect(editor.replaceRanges).toHaveBeenCalledTimes(1);
		expect(handle.content()).toBe('qux bar qux baz qux');
	});

	it('replaces the current match and reveals the next one', async () => {
		const { handle, editor } = renderReplaceHost('a1 a2 a3');
		await act(async () => handle.setSearchQuery('a'));
		expect(handle.currentMatchIndex()).toBe(0);

		await act(async () => {
			handle.replaceCurrent('b');
		});

		expect(handle.content()).toBe('b1 a2 a3');
		// The index stays at 0, which now names "a2": selected and scrolled to.
		expect(editor.setSelection).toHaveBeenLastCalledWith(3, 4, true);
	});

	it('expands capture groups in regex mode', async () => {
		const { handle } = renderReplaceHost('key=value');
		await act(async () => handle.cycleSearchKind()); // text -> regex
		await act(async () => handle.setSearchQuery('(\\w+)=(\\w+)'));

		await act(async () => {
			handle.replaceAll('$2=$1');
		});

		expect(handle.content()).toBe('value=key');
	});

	it('treats a text-mode query and replacement literally', async () => {
		const { handle } = renderReplaceHost('a.b axb');
		await act(async () => handle.setSearchQuery('a.b'));

		await act(async () => {
			handle.replaceAll('$1');
		});

		expect(handle.content()).toBe('$1 axb');
	});

	it('cannot replace outside the editor, or in line mode', async () => {
		const preview = renderReplaceHost('foo', { markdownEditMode: false });
		await act(async () => preview.handle.setSearchQuery('foo'));
		expect(preview.handle.canReplace()).toBe(false);
		expect(preview.handle.replaceAll('x')).toBe(0);

		const editing = renderReplaceHost('foo');
		await act(async () => editing.handle.setSearchQuery('foo'));
		expect(editing.handle.canReplace()).toBe(true);
		await act(async () => editing.handle.cycleSearchKind()); // regex
		await act(async () => editing.handle.cycleSearchKind()); // line
		expect(editing.handle.canReplace()).toBe(false);
	});
});
