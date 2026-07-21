/**
 * Tests for the shared lazy-Shiki observer factory. Both markdownFast and
 * textFast tier highlighters delegate to this module - testing it directly
 * keeps regression coverage in one place while the tier-specific tests stay
 * thin smoke tests of the wrapper contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	createLazyShikiObserver,
	HIGHLIGHTED_ATTR,
} from '../../../../../renderer/components/FilePreview/shared/lazyShikiObserver';
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
				`<pre class="shiki"><code class="language-${opts.lang}">SHIKI:${code}</code></pre>`,
			getLoadedLanguages: () => Array.from(loaded),
			loadLanguage: async (lang: string) => {
				loaded.add(lang);
			},
		})),
		bundledLanguagesInfo: [],
		bundledLanguagesAlias: {},
	};
});

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

describe('createLazyShikiObserver', () => {
	it('observes elements matching the default selector', () => {
		const root = makeRoot(
			'<pre><code class="language-ts">x</code></pre>' +
				'<pre><code class="language-python">y</code></pre>'
		);
		const handle = createLazyShikiObserver({
			theme: mockTheme,
			componentName: 'test/x',
		});
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		expect(observer.observed.length).toBe(2);
	});

	it('honors a custom selector', () => {
		const root = makeRoot('<pre><code class="lang-foo">x</code></pre>');
		const handle = createLazyShikiObserver({
			theme: mockTheme,
			componentName: 'test/x',
			selector: 'pre > code[class*="lang-"]',
		});
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		expect(observer.observed.length).toBe(1);
	});

	it('skips elements already marked as highlighted', () => {
		const root = makeRoot('<pre><code class="language-ts">x</code></pre>');
		root.querySelector('code')!.setAttribute(HIGHLIGHTED_ATTR, 'true');
		const handle = createLazyShikiObserver({
			theme: mockTheme,
			componentName: 'test/x',
		});
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		expect(observer.observed.length).toBe(0);
	});

	it('replaces innerHTML with highlighted markup on intersection', async () => {
		const root = makeRoot('<pre><code class="language-ts">const x = 1;</code></pre>');
		const handle = createLazyShikiObserver({
			theme: mockTheme,
			componentName: 'test/x',
		});
		handle.observe(root);
		const codeEl = root.querySelector('code')!;
		FakeIntersectionObserver.instances[0].trigger([codeEl]);
		await vi.waitFor(() => {
			expect(codeEl.innerHTML).toContain('SHIKI:const x = 1;');
		});
		expect(codeEl.getAttribute(HIGHLIGHTED_ATTR)).toBe('true');
	});

	it('resolves language aliases (ts → typescript)', async () => {
		const root = makeRoot('<pre><code class="language-ts">x</code></pre>');
		const handle = createLazyShikiObserver({
			theme: mockTheme,
			componentName: 'test/x',
		});
		handle.observe(root);
		FakeIntersectionObserver.instances[0].trigger([root.querySelector('code')!]);
		await vi.waitFor(() => {
			// Mock emits `language-${lang}` after alias resolution.
			expect(root.querySelector('code')!.innerHTML).toContain('SHIKI:x');
		});
	});

	it('bails when the language is unsupported', async () => {
		const root = makeRoot('<pre><code class="language-brainfuck">+++</code></pre>');
		const handle = createLazyShikiObserver({
			theme: mockTheme,
			componentName: 'test/x',
		});
		handle.observe(root);
		FakeIntersectionObserver.instances[0].trigger([root.querySelector('code')!]);
		// Yield one tick so any spurious continuation could flush. Negative
		// assertion - use setTimeout(0), NOT vi.waitFor (which would succeed
		// immediately since the innerHTML never changed).
		await new Promise((r) => setTimeout(r, 0));
		expect(root.querySelector('code')!.innerHTML).toBe('+++');
	});

	it('disconnect() tears down the observer', () => {
		const root = makeRoot('<pre><code class="language-ts">x</code></pre>');
		const handle = createLazyShikiObserver({
			theme: mockTheme,
			componentName: 'test/x',
		});
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		handle.disconnect();
		expect(observer.disconnected).toBe(true);
	});

	it('no-ops gracefully when IntersectionObserver is unavailable', () => {
		const originalIO = (
			globalThis as typeof globalThis & { IntersectionObserver: typeof IntersectionObserver }
		).IntersectionObserver;
		// @ts-expect-error - simulate old environment.
		delete globalThis.IntersectionObserver;
		try {
			const root = makeRoot('<pre><code class="language-ts">x</code></pre>');
			const handle = createLazyShikiObserver({
				theme: mockTheme,
				componentName: 'test/x',
			});
			expect(() => handle.observe(root)).not.toThrow();
			expect(() => handle.disconnect()).not.toThrow();
		} finally {
			(
				globalThis as typeof globalThis & { IntersectionObserver: typeof IntersectionObserver }
			).IntersectionObserver = originalIO;
		}
	});
});
