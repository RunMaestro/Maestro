/**
 * Tests for the lazy code highlighter. We can't easily run real Shiki in
 * jsdom (WASM + grammar fetches), so we mock the `shiki` import and assert
 * the orchestration logic: which elements get observed, when highlight()
 * runs, that already-highlighted elements are skipped, and that disconnect
 * tears down the IntersectionObserver.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	createCodeHighlighter,
	HIGHLIGHTED_ATTR,
} from '../../../../../renderer/components/FilePreview/markdownFast/codeHighlighter';
import { __resetForTests } from '../../../../../renderer/utils/shiki/highlighterManager';
import { mockTheme } from '../../../../helpers/mockTheme';

// Capture the most recently created IntersectionObserver so tests can trigger
// intersections deterministically.
class FakeIntersectionObserver implements IntersectionObserver {
	static instances: FakeIntersectionObserver[] = [];
	callback: IntersectionObserverCallback;
	observed: Element[] = [];
	disconnected = false;
	root = null;
	rootMargin = '';
	thresholds = [];

	constructor(cb: IntersectionObserverCallback) {
		this.callback = cb;
		FakeIntersectionObserver.instances.push(this);
	}

	observe(el: Element) {
		this.observed.push(el);
	}
	unobserve(el: Element) {
		this.observed = this.observed.filter((o) => o !== el);
	}
	disconnect() {
		this.disconnected = true;
	}
	takeRecords() {
		return [];
	}

	/** Synthesize an intersection event for tests. */
	trigger(targets: Element[]) {
		const entries = targets.map(
			(target) =>
				({
					target,
					isIntersecting: true,
					intersectionRatio: 1,
					boundingClientRect: target.getBoundingClientRect(),
					intersectionRect: target.getBoundingClientRect(),
					rootBounds: null,
					time: 0,
				}) as IntersectionObserverEntry
		);
		this.callback(entries, this);
	}
}

vi.mock('shiki', () => {
	const loaded = new Set<string>([
		'javascript',
		'typescript',
		'tsx',
		'jsx',
		'json',
		'python',
		'bash',
		'shell',
		'sh',
		'html',
		'css',
		'scss',
		'markdown',
		'md',
		'yaml',
		'yml',
		'rust',
		'go',
		'java',
		'c',
		'cpp',
		'sql',
		'xml',
	]);
	return {
		createHighlighter: vi.fn(async () => ({
			codeToHtml: (code: string, opts: { lang: string }) =>
				`<pre class="shiki"><code class="language-${opts.lang}">HL:${code}</code></pre>`,
			getLoadedLanguages: () => Array.from(loaded),
			loadLanguage: async (lang: string) => {
				loaded.add(lang);
			},
		})),
		bundledLanguagesInfo: [],
		bundledLanguagesAlias: {},
	};
});

beforeEach(() => {
	(
		globalThis as typeof globalThis & { IntersectionObserver: typeof IntersectionObserver }
	).IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
	FakeIntersectionObserver.instances.length = 0;
	__resetForTests();
});

function makeBlock(html: string): HTMLDivElement {
	const root = document.createElement('div');
	root.innerHTML = html;
	document.body.appendChild(root);
	return root;
}

describe('createCodeHighlighter', () => {
	it('observes pre > code.language-X elements inside the root', () => {
		const root = makeBlock(
			'<pre><code class="language-ts">const x = 1;</code></pre>' +
				'<p>not code</p>' +
				'<pre><code class="language-python">print(1)</code></pre>'
		);
		const handle = createCodeHighlighter({ theme: mockTheme });
		handle.observe(root);

		const observer = FakeIntersectionObserver.instances[0];
		expect(observer.observed.length).toBe(2);
		const langs = observer.observed.map((el) => el.getAttribute('class'));
		expect(langs).toEqual(['language-ts', 'language-python']);
	});

	it('ignores pre > code without a language class', () => {
		const root = makeBlock('<pre><code>plain</code></pre>');
		const handle = createCodeHighlighter({ theme: mockTheme });
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		expect(observer.observed.length).toBe(0);
	});

	it('replaces innerHTML with highlighted markup when an element intersects', async () => {
		const root = makeBlock('<pre><code class="language-ts">const x = 1;</code></pre>');
		const handle = createCodeHighlighter({ theme: mockTheme });
		handle.observe(root);

		const observer = FakeIntersectionObserver.instances[0];
		const codeEl = root.querySelector('code')!;
		observer.trigger([codeEl]);

		// highlight() is async; flush microtasks.
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(codeEl.innerHTML).toContain('HL:const x = 1;');
		expect(codeEl.getAttribute(HIGHLIGHTED_ATTR)).toBe('true');
	});

	it('does not re-highlight an already-highlighted element', async () => {
		const root = makeBlock('<pre><code class="language-ts">const x = 1;</code></pre>');
		const codeEl = root.querySelector('code')!;
		codeEl.setAttribute(HIGHLIGHTED_ATTR, 'true');
		codeEl.innerHTML = 'previously-highlighted';

		const handle = createCodeHighlighter({ theme: mockTheme });
		handle.observe(root);

		// Already-highlighted elements are filtered out before observation,
		// so the observer should see nothing.
		const observer = FakeIntersectionObserver.instances[0];
		expect(observer.observed.length).toBe(0);
		expect(codeEl.innerHTML).toBe('previously-highlighted');
	});

	it('skips elements whose language is not supported', async () => {
		const root = makeBlock('<pre><code class="language-brainfuck">+++</code></pre>');
		const handle = createCodeHighlighter({ theme: mockTheme });
		handle.observe(root);

		const observer = FakeIntersectionObserver.instances[0];
		const codeEl = root.querySelector('code')!;
		observer.trigger([codeEl]);
		await new Promise((resolve) => setTimeout(resolve, 0));

		// detectLanguage returns null → highlight bails before touching innerHTML.
		expect(codeEl.innerHTML).toBe('+++');
	});

	it('disconnect() tears down the IntersectionObserver', () => {
		const root = makeBlock('<pre><code class="language-ts">x</code></pre>');
		const handle = createCodeHighlighter({ theme: mockTheme });
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		handle.disconnect();
		expect(observer.disconnected).toBe(true);
	});

	it('observe() filters out already-highlighted elements on subsequent calls', () => {
		const root = makeBlock(
			'<pre><code class="language-ts">x</code></pre><pre><code class="language-python">y</code></pre>'
		);
		const handle = createCodeHighlighter({ theme: mockTheme });
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		expect(observer.observed.length).toBe(2);

		// Mark one block highlighted; a re-observe call must NOT re-observe it.
		root.querySelectorAll<HTMLElement>('code')[0].setAttribute(HIGHLIGHTED_ATTR, 'true');

		// Simulate Virtuoso recycling: unobserve the still-pending block so a
		// re-observe call sees a clean slate, then observe again. Only the
		// unhighlighted block should re-attach.
		observer.observed = [];
		handle.observe(root);
		expect(observer.observed.length).toBe(1);
		expect(observer.observed[0].getAttribute('class')).toBe('language-python');
	});

	it('no-ops gracefully when IntersectionObserver is unavailable', () => {
		// @ts-expect-error - simulate older environment.
		delete globalThis.IntersectionObserver;
		const root = makeBlock('<pre><code class="language-ts">x</code></pre>');
		const handle = createCodeHighlighter({ theme: mockTheme });
		expect(() => handle.observe(root)).not.toThrow();
		expect(() => handle.disconnect()).not.toThrow();
	});
});
