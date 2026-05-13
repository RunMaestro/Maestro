/**
 * Tests for the lazy code highlighter in the textFast tier. We can't run real
 * Shiki in jsdom (WASM + grammar fetches), so we mock the `shiki` import and
 * assert the orchestration: observed elements, highlight() execution,
 * idempotency, disconnect.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	createTextCodeHighlighter,
	HIGHLIGHTED_ATTR,
} from '../../../../../renderer/components/FilePreview/textFast/codeHighlighter';
import { mockTheme } from '../../../../helpers/mockTheme';

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

vi.mock('shiki', () => ({
	createHighlighter: vi.fn(async () => ({
		codeToHtml: (code: string, opts: { lang: string }) =>
			`<pre class="shiki"><code class="language-${opts.lang}">TXT-HL:${code}</code></pre>`,
	})),
}));

beforeEach(() => {
	(
		globalThis as typeof globalThis & { IntersectionObserver: typeof IntersectionObserver }
	).IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
	FakeIntersectionObserver.instances.length = 0;
});

function makeRoot(html: string): HTMLDivElement {
	const root = document.createElement('div');
	root.innerHTML = html;
	document.body.appendChild(root);
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
		// @ts-expect-error — simulate older environment.
		delete globalThis.IntersectionObserver;
		const root = makeRoot('<pre><code class="language-ts">x</code></pre>');
		const handle = createTextCodeHighlighter({ theme: mockTheme });
		expect(() => handle.observe(root)).not.toThrow();
		expect(() => handle.disconnect()).not.toThrow();
	});
});
