import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	createMermaidRenderer,
	MERMAID_RENDERED_ATTR,
} from '../../../../../renderer/components/FilePreview/markdownFast/mermaidRenderer';
import { mockTheme } from '../../../../helpers/mockTheme';
import { FakeIntersectionObserver } from '../../../../helpers/fakeIntersectionObserver';

vi.mock('mermaid', () => ({
	default: {
		initialize: vi.fn(),
		render: vi.fn(async (id: string, source: string) => ({
			svg: `<svg data-id="${id}" data-source="${source}"><g/></svg>`,
		})),
	},
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

describe('createMermaidRenderer', () => {
	it('observes pre > code.language-mermaid elements', () => {
		const root = makeRoot(
			'<pre><code class="language-mermaid">graph TD;\nA-->B</code></pre>' +
				'<pre><code class="language-ts">not mermaid</code></pre>'
		);
		const handle = createMermaidRenderer({ theme: mockTheme });
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		expect(observer.observed.length).toBe(1);
		expect((observer.observed[0] as HTMLElement).getAttribute('class')).toBe('language-mermaid');
	});

	it('replaces the <pre> wrapper with rendered SVG on intersection', async () => {
		const root = makeRoot('<pre><code class="language-mermaid">graph TD;\nA-->B</code></pre>');
		const handle = createMermaidRenderer({ theme: mockTheme });
		handle.observe(root);

		const observer = FakeIntersectionObserver.instances[0];
		const codeEl = root.querySelector('code')!;
		observer.trigger([codeEl]);
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(root.querySelector('pre')).toBeNull();
		expect(root.querySelector('.markdown-fast-mermaid')).not.toBeNull();
		expect(root.querySelector('svg')).not.toBeNull();
	});

	it('passes the diagram source to mermaid.render', async () => {
		const mermaid = (await import('mermaid')).default;
		const renderSpy = vi.mocked(mermaid.render);
		renderSpy.mockClear();

		const root = makeRoot('<pre><code class="language-mermaid">graph LR;\nX-->Y</code></pre>');
		const handle = createMermaidRenderer({ theme: mockTheme });
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		observer.trigger([root.querySelector('code')!]);
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(renderSpy).toHaveBeenCalled();
		const [, source] = renderSpy.mock.calls[0];
		expect(source).toContain('graph LR;');
		expect(source).toContain('X-->Y');
	});

	it('does not re-render an already-rendered diagram', () => {
		const root = makeRoot(
			'<pre><code class="language-mermaid" data-mermaid-rendered="true">graph TD;A</code></pre>'
		);
		const handle = createMermaidRenderer({ theme: mockTheme });
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		expect(observer.observed.length).toBe(0);
	});

	it('initializes mermaid with the dark theme for dark mode', async () => {
		const mermaid = (await import('mermaid')).default;
		const initSpy = vi.mocked(mermaid.initialize);
		initSpy.mockClear();

		const root = makeRoot('<pre><code class="language-mermaid">graph;A</code></pre>');
		const handle = createMermaidRenderer({
			theme: { ...mockTheme, mode: 'dark' },
		});
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		observer.trigger([root.querySelector('code')!]);
		await new Promise((r) => setTimeout(r, 0));

		expect(initSpy).toHaveBeenCalledWith(
			expect.objectContaining({ theme: 'dark', startOnLoad: false })
		);
	});

	it('disconnect() tears down the observer', () => {
		const root = makeRoot('<pre><code class="language-mermaid">graph;A</code></pre>');
		const handle = createMermaidRenderer({ theme: mockTheme });
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		handle.disconnect();
		expect(observer.disconnected).toBe(true);
	});

	it('marks rendered diagrams with the idempotency attribute', async () => {
		const root = makeRoot('<pre><code class="language-mermaid">graph;A</code></pre>');
		const handle = createMermaidRenderer({ theme: mockTheme });
		handle.observe(root);
		const observer = FakeIntersectionObserver.instances[0];
		const code = root.querySelector('code')!;
		observer.trigger([code]);
		// The marker is set synchronously before await; check immediately.
		expect(code.getAttribute(MERMAID_RENDERED_ATTR)).toBe('true');
	});

	it('no-ops gracefully when IntersectionObserver is unavailable', () => {
		// @ts-expect-error - simulate older environment.
		delete globalThis.IntersectionObserver;
		const root = makeRoot('<pre><code class="language-mermaid">graph;A</code></pre>');
		const handle = createMermaidRenderer({ theme: mockTheme });
		expect(() => handle.observe(root)).not.toThrow();
		expect(() => handle.disconnect()).not.toThrow();
	});
});
