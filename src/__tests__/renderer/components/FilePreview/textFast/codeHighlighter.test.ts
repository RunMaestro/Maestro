/**
 * Tests for the lazy code highlighter in the textFast tier. We can't run real
 * Shiki in jsdom (WASM + grammar fetches), so we mock the `shiki` import and
 * assert the orchestration: observed elements, highlight() execution,
 * idempotency, disconnect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	createTextCodeHighlighter,
	HIGHLIGHTED_ATTR,
} from '../../../../../renderer/components/FilePreview/textFast/codeHighlighter';
import { __resetForTests } from '../../../../../renderer/utils/shiki/highlighterManager';
import { mockTheme } from '../../../../helpers/mockTheme';
import { FakeIntersectionObserver } from '../../../../helpers/fakeIntersectionObserver';

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
				`<pre class="shiki"><code class="language-${opts.lang}">TXT-HL:${code}</code></pre>`,
			getLoadedLanguages: () => Array.from(loaded),
			loadLanguage: async (lang: string) => {
				loaded.add(lang);
			},
		})),
		bundledLanguagesInfo: [],
		bundledLanguagesAlias: {},
	};
});

// Track every root appended via makeRoot so afterEach can detach them and keep
// document.body clean between tests (prevents DOM leakage across the suite).
const createdRoots: HTMLDivElement[] = [];

beforeEach(() => {
	(
		globalThis as typeof globalThis & { IntersectionObserver: typeof IntersectionObserver }
	).IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
	FakeIntersectionObserver.instances.length = 0;
	__resetForTests();
});

afterEach(() => {
	while (createdRoots.length > 0) {
		createdRoots.pop()?.remove();
	}
});

function makeRoot(html: string): HTMLDivElement {
	const root = document.createElement('div');
	root.innerHTML = html;
	document.body.appendChild(root);
	createdRoots.push(root);
	return root;
}

describe('createTextCodeHighlighter', () => {
	it('observes pre > code.language-X elements', () => {
		const root = makeRoot(
			'<pre><code class="language-ts">const x = 1;</code></pre>' +
				'<pre><code class="language-python">print(1)</code></pre>'
		);
		const handle = createTextCodeHighlighter({ theme: mockTheme });
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		expect(observer.observed.length).toBe(2);
	});

	it('ignores pre > code without a language class', () => {
		const root = makeRoot('<pre><code>plain</code></pre>');
		const handle = createTextCodeHighlighter({ theme: mockTheme });
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		expect(observer.observed.length).toBe(0);
	});

	it('replaces innerHTML with highlighted markup on intersection', async () => {
		const root = makeRoot('<pre><code class="language-ts">const x = 1;</code></pre>');
		const handle = createTextCodeHighlighter({ theme: mockTheme });
		handle.observe(root);

		const observer = FakeIntersectionObserver.instances[0];
		const codeEl = root.querySelector('code')!;
		observer.trigger([codeEl]);

		// The highlight chain is async (`import('shiki')` → `createHighlighter`
		// → `codeToHtml` → set innerHTML). A fixed number of `setTimeout(0)`
		// flushes is flaky on CPU-contended CI; poll until the result appears.
		await vi.waitFor(() => {
			expect(codeEl.innerHTML).toContain('TXT-HL:const x = 1;');
		});
		expect(codeEl.getAttribute(HIGHLIGHTED_ATTR)).toBe('true');
	});

	it('resolves language aliases (ts → typescript)', async () => {
		const root = makeRoot('<pre><code class="language-ts">x</code></pre>');
		const handle = createTextCodeHighlighter({ theme: mockTheme });
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		observer.trigger([root.querySelector('code')!]);
		// Mock emits language-${opts.lang}, so we should see language-typescript
		// after alias resolution. Poll for the async highlight to complete.
		await vi.waitFor(() => {
			expect(root.querySelector('code')!.innerHTML).toContain('TXT-HL:x');
		});
	});

	it('skips elements with unsupported languages', async () => {
		const root = makeRoot('<pre><code class="language-brainfuck">+++</code></pre>');
		const handle = createTextCodeHighlighter({ theme: mockTheme });
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		observer.trigger([root.querySelector('code')!]);
		// Yield one microtask tick so any pending continuation can run. We use
		// setTimeout(0) here instead of vi.waitFor because this is a negative
		// assertion (innerHTML must stay '+++'); a polling waitFor would succeed
		// immediately without proving the highlight path didn't fire.
		await new Promise((r) => setTimeout(r, 0));
		// detectLanguage returns null → highlight bails before touching innerHTML.
		expect(root.querySelector('code')!.innerHTML).toBe('+++');
	});

	it('does not re-highlight an already-marked element', () => {
		const root = makeRoot('<pre><code class="language-ts">x</code></pre>');
		const codeEl = root.querySelector('code')!;
		codeEl.setAttribute(HIGHLIGHTED_ATTR, 'true');
		codeEl.innerHTML = 'preserved';

		const handle = createTextCodeHighlighter({ theme: mockTheme });
		handle.observe(root);

		const observer = FakeIntersectionObserver.instances[0];
		expect(observer.observed.length).toBe(0);
		expect(codeEl.innerHTML).toBe('preserved');
	});

	it('disconnect() tears down the observer', () => {
		const root = makeRoot('<pre><code class="language-ts">x</code></pre>');
		const handle = createTextCodeHighlighter({ theme: mockTheme });
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		handle.disconnect();
		expect(observer.disconnected).toBe(true);
	});

	it('no-ops gracefully when IntersectionObserver is unavailable', () => {
		// Preserve the global so we restore it even on failure - otherwise the
		// deleted constructor leaks into whatever test runs next in this worker.
		const originalIO = (
			globalThis as typeof globalThis & { IntersectionObserver: typeof IntersectionObserver }
		).IntersectionObserver;
		// @ts-expect-error - simulate older environment.
		delete globalThis.IntersectionObserver;
		try {
			const root = makeRoot('<pre><code class="language-ts">x</code></pre>');
			const handle = createTextCodeHighlighter({ theme: mockTheme });
			expect(() => handle.observe(root)).not.toThrow();
			expect(() => handle.disconnect()).not.toThrow();
		} finally {
			(
				globalThis as typeof globalThis & { IntersectionObserver: typeof IntersectionObserver }
			).IntersectionObserver = originalIO;
		}
	});
});
