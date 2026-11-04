// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/linkRouter.test.ts
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/mermaidRenderer.test.ts
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/parser.test.ts
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/pipeline.test.ts
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/proseStyles.test.ts
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/sanitize.test.ts
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/searchHits.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveLinkAction } from '../../../../../renderer/components/FilePreview/markdownFast/linkRouter';
import type {
	ClickModifiers,
	LinkAction,
	LinkDescriptor,
} from '../../../../../renderer/components/FilePreview/markdownFast/types';
import {
	createMermaidRenderer,
	MERMAID_RENDERED_ATTR,
} from '../../../../../renderer/components/FilePreview/markdownFast/mermaidRenderer';
import { mockTheme } from '../../../../helpers/mockTheme';
import { AA_CONTRAST, contrastRatio, cssColorToHex } from '../../../../../shared/colorContrast';
import { createParser } from '../../../../../renderer/components/FilePreview/markdownFast/parser';
import { buildBlocks } from '../../../../../renderer/components/FilePreview/markdownFast/pipeline';
import {
	FAST_BLOCK_CLASS,
	generateProseCss,
} from '../../../../../renderer/components/FilePreview/markdownFast/proseStyles';
import { createMockTheme } from '../../../../helpers/mockTheme';
import type { ThemeColors } from '../../../../../shared/theme-types';
import { sanitizeBlock } from '../../../../../renderer/components/FilePreview/markdownFast/sanitize';
import {
	blockIndexAtOffset,
	findHits,
	type BlockRange,
} from '../../../../../renderer/components/FilePreview/markdownFast/searchHits';
vi.mock('mermaid', () => ({
	default: {
		initialize: vi.fn(),
		render: vi.fn(async (id: string, source: string) => ({
			svg: `<svg data-id="${id}" data-source="${source}"><g/></svg>`,
		})),
	},
}));
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/linkRouter.test.ts
describe('', () => {
	const NO_MODIFIERS: ClickModifiers = { metaKey: false, ctrlKey: false, button: 0 };
	const META_DOWN: ClickModifiers = { metaKey: true, ctrlKey: false, button: 0 };
	const CTRL_DOWN: ClickModifiers = { metaKey: false, ctrlKey: true, button: 0 };
	const MIDDLE_CLICK: ClickModifiers = { metaKey: false, ctrlKey: false, button: 1 };
	function link(href: string, dataMaestroFile: string | null = null): LinkDescriptor {
		return { href, dataMaestroFile };
	}
	describe('resolveLinkAction', () => {
		it('returns none for an empty href without data attribute', () => {
			const action = resolveLinkAction(link(''), NO_MODIFIERS);
			expect(action.kind).toBe('none');
		});
		describe('maestro-file routing', () => {
			it('routes via data-maestro-file attribute when present', () => {
				const action = resolveLinkAction(link('#ignored', 'docs/file.md'), NO_MODIFIERS);
				expect(action).toEqual({
					kind: 'maestro-file',
					path: 'docs/file.md',
					openInNewTab: false,
				});
			});
			it('prefers data-maestro-file over href even when both are present', () => {
				const action = resolveLinkAction(
					link('https://example.com', 'docs/file.md'),
					NO_MODIFIERS
				) as Extract<
					LinkAction,
					{
						kind: 'maestro-file';
					}
				>;
				expect(action.kind).toBe('maestro-file');
				expect(action.path).toBe('docs/file.md');
			});
			it('routes maestro-file:// URLs in the href', () => {
				const action = resolveLinkAction(
					link('maestro-file://docs/readme.md'),
					NO_MODIFIERS
				) as Extract<
					LinkAction,
					{
						kind: 'maestro-file';
					}
				>;
				expect(action.kind).toBe('maestro-file');
				expect(action.path).toBe('docs/readme.md');
			});
			it('marks openInNewTab when meta key is held', () => {
				const action = resolveLinkAction(link('maestro-file://x.md'), META_DOWN) as Extract<
					LinkAction,
					{
						kind: 'maestro-file';
					}
				>;
				expect(action.openInNewTab).toBe(true);
			});
			it('marks openInNewTab when ctrl key is held', () => {
				const action = resolveLinkAction(link('maestro-file://x.md'), CTRL_DOWN) as Extract<
					LinkAction,
					{
						kind: 'maestro-file';
					}
				>;
				expect(action.openInNewTab).toBe(true);
			});
			it('marks openInNewTab on middle-click', () => {
				const action = resolveLinkAction(link('maestro-file://x.md'), MIDDLE_CLICK) as Extract<
					LinkAction,
					{
						kind: 'maestro-file';
					}
				>;
				expect(action.openInNewTab).toBe(true);
			});
			it('handles maestro-file paths containing slashes and special chars', () => {
				const action = resolveLinkAction(
					link('maestro-file://docs/sub folder/My File.md'),
					NO_MODIFIERS
				) as Extract<
					LinkAction,
					{
						kind: 'maestro-file';
					}
				>;
				expect(action.path).toBe('docs/sub folder/My File.md');
			});
		});
		describe('maestro deep-link routing', () => {
			it('routes maestro:// URLs to the deep-link kind', () => {
				const action = resolveLinkAction(
					link('maestro://session/abc/tab/xyz'),
					NO_MODIFIERS
				) as Extract<
					LinkAction,
					{
						kind: 'maestro-deep-link';
					}
				>;
				expect(action).toEqual({
					kind: 'maestro-deep-link',
					href: 'maestro://session/abc/tab/xyz',
				});
			});
			it('routes group deep links', () => {
				const action = resolveLinkAction(link('maestro://group/grp1'), NO_MODIFIERS);
				expect(action.kind).toBe('maestro-deep-link');
			});
		});
		describe('anchor routing', () => {
			it('returns anchor action for hash hrefs', () => {
				expect(resolveLinkAction(link('#section'), NO_MODIFIERS)).toEqual({
					kind: 'anchor',
					hash: '#section',
				});
			});
			it('ignores modifiers for anchor links', () => {
				expect(resolveLinkAction(link('#x'), META_DOWN)).toEqual({
					kind: 'anchor',
					hash: '#x',
				});
			});
		});
		describe('external routing', () => {
			it('routes http(s) URLs as external', () => {
				expect(resolveLinkAction(link('https://example.com'), NO_MODIFIERS)).toEqual({
					kind: 'external',
					href: 'https://example.com',
					openInNewTab: false,
				});
				expect(resolveLinkAction(link('http://example.com'), NO_MODIFIERS).kind).toBe('external');
			});
			it('routes mailto links as external', () => {
				expect(resolveLinkAction(link('mailto:a@b.com'), NO_MODIFIERS).kind).toBe('external');
			});
			it('routes tel links as external', () => {
				expect(resolveLinkAction(link('tel:+1234'), NO_MODIFIERS).kind).toBe('external');
			});
			it('routes file:// URLs as external', () => {
				expect(resolveLinkAction(link('file:///Users/x/a.txt'), NO_MODIFIERS).kind).toBe(
					'external'
				);
			});
			it('marks openInNewTab when ctrl is held', () => {
				const action = resolveLinkAction(link('https://example.com'), CTRL_DOWN) as Extract<
					LinkAction,
					{
						kind: 'external';
					}
				>;
				expect(action.openInNewTab).toBe(true);
			});
		});
		describe('non-routed links', () => {
			it('returns none for relative-path hrefs (Fast tier does not resolve these in Phase 1)', () => {
				expect(resolveLinkAction(link('relative/path.md'), NO_MODIFIERS).kind).toBe('none');
				expect(resolveLinkAction(link('./sibling.md'), NO_MODIFIERS).kind).toBe('none');
				expect(resolveLinkAction(link('../parent.md'), NO_MODIFIERS).kind).toBe('none');
			});
			it('returns none for unknown protocols', () => {
				expect(resolveLinkAction(link('chrome-extension://x'), NO_MODIFIERS).kind).toBe('none');
				expect(resolveLinkAction(link('ftp://example.com'), NO_MODIFIERS).kind).toBe('none');
			});
			it('returns none for hrefs that look like protocols but are not whitelisted', () => {
				expect(resolveLinkAction(link('javascript:alert(1)'), NO_MODIFIERS).kind).toBe('none');
			});
		});
		describe('boundary conditions', () => {
			it('does not openInNewTab when neither modifier is held and button is 0', () => {
				const action = resolveLinkAction(link('https://example.com'), NO_MODIFIERS) as Extract<
					LinkAction,
					{
						kind: 'external';
					}
				>;
				expect(action.openInNewTab).toBe(false);
			});
			it('treats data-maestro-file as the source of truth even if href is empty', () => {
				const action = resolveLinkAction(link('', 'path/to.md'), NO_MODIFIERS);
				expect(action.kind).toBe('maestro-file');
			});
			it('falls back to href when dataMaestroFile is the empty string', () => {
				// An empty data attribute is falsy and should not short-circuit the
				// router. The href branch should still execute.
				const action = resolveLinkAction(link('https://example.com', ''), NO_MODIFIERS);
				expect(action.kind).toBe('external');
			});
		});
	});
});
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/mermaidRenderer.test.ts
describe('', () => {
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
	beforeEach(() => {
		(
			globalThis as typeof globalThis & {
				IntersectionObserver: typeof IntersectionObserver;
			}
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
		it('repairs an unreadable author-set node label once the SVG is attached', async () => {
			const mermaid = (await import('mermaid')).default;
			vi.mocked(mermaid.render).mockResolvedValueOnce({
				svg:
					'<svg><g class="node"><rect style="fill:#f9e79f"></rect>' +
					'<g class="label"><foreignObject><div><p style="color:#f8f8f2">S4</p></div></foreignObject></g></g></svg>',
			} as Awaited<ReturnType<typeof mermaid.render>>);
			const root = makeRoot('<pre><code class="language-mermaid">graph TD;\nA-->B</code></pre>');
			const handle = createMermaidRenderer({ theme: mockTheme });
			handle.observe(root);
			FakeIntersectionObserver.instances[0].trigger([root.querySelector('code')!]);
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
			const label = root.querySelector('.markdown-fast-mermaid p') as HTMLElement;
			const color = cssColorToHex(getComputedStyle(label).color)!;
			expect(contrastRatio(color, '#f9e79f')).toBeGreaterThanOrEqual(AA_CONTRAST);
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
		it('escapes @ in a label before handing the source to mermaid', async () => {
			// Mermaid's edge-id lexer rule swallows `-->|@`, so the label arrives
			// escaped as `#64;` (which mermaid decodes back to `@` when it draws).
			const mermaid = (await import('mermaid')).default;
			const renderSpy = vi.mocked(mermaid.render);
			renderSpy.mockClear();
			const root = makeRoot(
				'<pre><code class="language-mermaid">flowchart LR\n  A --&gt;|@bob| B</code></pre>'
			);
			const handle = createMermaidRenderer({ theme: mockTheme });
			handle.observe(root);
			FakeIntersectionObserver.instances[0].trigger([root.querySelector('code')!]);
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
			const [, source] = renderSpy.mock.calls[0];
			expect(source).toContain('|#64;bob|');
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
});
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/parser.test.ts
describe('', () => {
	describe('createParser', () => {
		it('returns a markdown-it instance', () => {
			const md = createParser();
			expect(typeof md.parse).toBe('function');
			expect(typeof md.render).toBe('function');
		});
		it('configures html: true so raw HTML passes through', () => {
			const md = createParser();
			const html = md.render('<span class="x">raw</span>');
			expect(html).toContain('<span class="x">raw</span>');
		});
		it('configures linkify: true so bare URLs become anchors', () => {
			const md = createParser();
			const html = md.render('see https://example.com for details');
			expect(html).toContain('<a href="https://example.com"');
		});
		it('configures breaks: false so single newlines are not <br>', () => {
			const md = createParser();
			const html = md.render('line one\nline two');
			// commonmark: single \n is just a space, not <br>
			expect(html).not.toContain('<br');
		});
		it('configures typographer: false so smart-quotes are not transformed', () => {
			const md = createParser();
			const html = md.render('"hello" -- world');
			// With typographer enabled markdown-it would emit curly quotes and an em dash
			expect(html).toContain('&quot;hello&quot;');
			expect(html).toContain('--');
			expect(html).not.toContain('\u2014');
		});
		it('returns fresh instances on each call (no shared state)', () => {
			const a = createParser();
			const b = createParser();
			expect(a).not.toBe(b);
		});
		it('parses a standard markdown document into a token array', () => {
			const md = createParser();
			const tokens = md.parse('# heading\n\nparagraph', {});
			expect(Array.isArray(tokens)).toBe(true);
			expect(tokens.length).toBeGreaterThan(0);
			expect(tokens.some((t) => t.type === 'heading_open')).toBe(true);
			expect(tokens.some((t) => t.type === 'paragraph_open')).toBe(true);
		});
		it('parses GFM-style tables', () => {
			const md = createParser();
			const html = md.render('| a | b |\n| - | - |\n| 1 | 2 |');
			expect(html).toContain('<table>');
			expect(html).toContain('<th>a</th>');
			expect(html).toContain('<td>1</td>');
		});
		it('parses fenced code blocks', () => {
			const md = createParser();
			const html = md.render('```js\nconst x = 1;\n```');
			expect(html).toContain('<pre>');
			expect(html).toContain('<code class="language-js">');
			expect(html).toContain('const x = 1;');
		});
		it('parses inline code', () => {
			const md = createParser();
			const html = md.render('use `npm test` here');
			expect(html).toContain('<code>npm test</code>');
		});
		it('parses task list checkboxes', () => {
			const md = createParser();
			// Plain markdown-it doesn't render checkboxes specially; they appear as
			// literal text inside list items. The Fast tier intentionally relies on
			// CSS to style these the same way the Rich path does.
			const html = md.render('- [x] done\n- [ ] todo');
			expect(html).toContain('<ul>');
			expect(html).toContain('<li>');
		});
	});
});
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/pipeline.test.ts
describe('', () => {
	describe('buildBlocks', () => {
		it('returns an empty array for empty input', () => {
			expect(buildBlocks('')).toEqual([]);
		});
		it('returns one block per top-level paragraph', () => {
			const blocks = buildBlocks('first\n\nsecond\n\nthird');
			expect(blocks.length).toBe(3);
			expect(blocks.map((b) => b.html)).toEqual([
				expect.stringContaining('first'),
				expect.stringContaining('second'),
				expect.stringContaining('third'),
			]);
		});
		it('prepends a frontmatter block when YAML frontmatter is present', () => {
			const blocks = buildBlocks('---\ntitle: Doc\n---\n# Heading\n\nbody');
			expect(blocks.length).toBe(3);
			expect(blocks[0].html).toContain('<em>Document metadata:</em>');
			expect(blocks[0].html).toContain('title');
			// Heading carries an id from the slugger plugin in addition to its text.
			expect(blocks[1].html).toMatch(/<h1[^>]*>Heading<\/h1>/);
			expect(blocks[2].html).toContain('<p>body</p>');
		});
		it('does not prepend a frontmatter block when no frontmatter exists', () => {
			const blocks = buildBlocks('# Heading\n\nbody');
			expect(blocks.length).toBe(2);
			expect(blocks[0].html).toMatch(/<h1[^>]*>/);
		});
		it('does not prepend a frontmatter block when YAML is empty', () => {
			const blocks = buildBlocks('---\n\n---\nbody');
			expect(blocks.length).toBe(1);
			expect(blocks[0].html).toContain('<p>body</p>');
		});
		it('assigns sequential ids across frontmatter + body blocks', () => {
			const blocks = buildBlocks('---\ntitle: x\n---\n# A\n\n# B');
			expect(blocks.map((b) => b.id)).toEqual([0, 1, 2]);
		});
		it('handles GFM tables as a single block', () => {
			const source = ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n');
			const blocks = buildBlocks(source);
			expect(blocks.length).toBe(1);
			expect(blocks[0].html).toContain('<table>');
		});
		it('handles fenced code blocks as their own block', () => {
			const blocks = buildBlocks('# h\n\n```ts\nconst x = 1;\n```\n\nafter');
			expect(blocks.length).toBe(3);
			expect(blocks[1].html).toContain('<pre>');
			expect(blocks[1].html).toContain('language-ts');
		});
		it('emits one block per heading in a document with many headings', () => {
			const source = Array.from({ length: 50 }, (_, i) => `# Heading ${i}`).join('\n\n');
			const blocks = buildBlocks(source);
			expect(blocks.length).toBe(50);
			blocks.forEach((b, i) => {
				expect(b.html).toContain(`Heading ${i}`);
			});
		});
		it('handles a realistic mixed document', () => {
			const source = [
				'---',
				'title: Mixed',
				'---',
				'',
				'# Section A',
				'',
				'Intro **bold** _italic_.',
				'',
				'- item 1',
				'- item 2',
				'',
				'```',
				'code',
				'```',
				'',
				'| h1 | h2 |',
				'| - | - |',
				'| a | b |',
				'',
				'> quote',
				'',
				'---',
				'',
				'# Section B',
			].join('\n');
			const blocks = buildBlocks(source);
			// frontmatter, h1, paragraph, list, code, table, blockquote, hr, h1
			expect(blocks.length).toBeGreaterThanOrEqual(9);
			expect(blocks[0].html).toContain('Document metadata');
			expect(blocks.find((b) => /<h1[^>]*>Section A<\/h1>/.test(b.html))).toBeDefined();
			expect(blocks.find((b) => b.html.includes('<table>'))).toBeDefined();
			expect(blocks.find((b) => b.html.includes('<blockquote>'))).toBeDefined();
			expect(blocks.find((b) => b.html.includes('<hr'))).toBeDefined();
			expect(blocks.find((b) => /<h1[^>]*>Section B<\/h1>/.test(b.html))).toBeDefined();
		});
		it('handles a 5,000-line input without throwing', () => {
			const source = Array.from({ length: 5000 }, (_, i) => `Line ${i}`).join('\n\n');
			const blocks = buildBlocks(source);
			expect(blocks.length).toBe(5000);
		});
		it('output is deterministic - same input produces identical blocks twice', () => {
			const source = '# A\n\nparagraph\n\n```\ncode\n```';
			const first = buildBlocks(source);
			const second = buildBlocks(source);
			expect(first).toEqual(second);
		});
		describe('heading slug propagation', () => {
			it('annotates heading blocks with headingSlug', () => {
				const blocks = buildBlocks('# Hello World\n\nbody');
				expect(blocks[0].headingSlug).toBe('hello-world');
			});
			it('emits id="<slug>" inside the rendered HTML of heading blocks', () => {
				const blocks = buildBlocks('# Section A');
				expect(blocks[0].html).toContain('id="section-a"');
			});
			it('skips slugging on non-heading blocks', () => {
				const blocks = buildBlocks('Paragraph.\n\n- list');
				expect(blocks.every((b) => b.headingSlug === undefined)).toBe(true);
			});
			it('disambiguates duplicate headings across the full pipeline', () => {
				const blocks = buildBlocks('# A\n\n# A\n\n# A');
				expect(blocks.map((b) => b.headingSlug)).toEqual(['a', 'a-1', 'a-2']);
			});
			it('keeps slugs stable across runs', () => {
				const src = '# alpha\n\n# beta';
				const a = buildBlocks(src).map((b) => b.headingSlug);
				const b = buildBlocks(src).map((b) => b.headingSlug);
				expect(a).toEqual(b);
			});
		});
		describe('React fences (reactFenceLanguages)', () => {
			const DATAVIEW = new Set(['dataview']);
			it('tags a top-level fence of a listed language with its body and 1-based line', () => {
				const blocks = buildBlocks('# Title\n\n```dataview\nLIST\nFROM "People"\n```\n', {
					reactFenceLanguages: DATAVIEW,
				});
				const fence = blocks.find((b) => b.fence);
				expect(fence?.fence).toEqual({
					language: 'dataview',
					content: 'LIST\nFROM "People"',
					line: 3,
				});
				// The HTML stays as the fallback when the renderer goes away.
				expect(fence?.html).toContain('<pre');
			});
			it('counts the frontmatter lines into the fence line', () => {
				const blocks = buildBlocks('---\ntitle: Doc\n---\n```dataview\nLIST\n```\n', {
					reactFenceLanguages: DATAVIEW,
				});
				expect(blocks.find((b) => b.fence)?.fence?.line).toBe(4);
			});
			it('matches the first info word exactly', () => {
				const blocks = buildBlocks(
					'```dataview extra\nLIST\n```\n\n```dataviewjs\ndv.list([])\n```\n\n```js\nx\n```\n',
					{ reactFenceLanguages: DATAVIEW }
				);
				expect(blocks.filter((b) => b.fence).map((b) => b.fence?.content)).toEqual(['LIST']);
			});
			it('leaves a fence nested in a list as HTML', () => {
				const blocks = buildBlocks('- item\n\n  ```dataview\n  LIST\n  ```\n', {
					reactFenceLanguages: DATAVIEW,
				});
				expect(blocks.some((b) => b.fence)).toBe(false);
			});
			it('tags nothing without the option', () => {
				expect(buildBlocks('```dataview\nLIST\n```\n').some((b) => b.fence)).toBe(false);
			});
		});
	});
});
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/proseStyles.test.ts
describe('', () => {
	const makeTheme = (colorOverrides: Partial<ThemeColors> = {}) =>
		createMockTheme({ colors: colorOverrides });
	describe('FAST_BLOCK_CLASS', () => {
		it('exports a stable class name used by both the component and the stylesheet', () => {
			expect(FAST_BLOCK_CLASS).toBe('markdown-fast-block');
		});
	});
	describe('generateProseCss', () => {
		it('returns a non-empty CSS string', () => {
			const css = generateProseCss(makeTheme());
			expect(css).toBeTypeOf('string');
			expect(css.length).toBeGreaterThan(0);
		});
		it('scopes every rule to the FAST_BLOCK_CLASS class', () => {
			const css = generateProseCss(makeTheme());
			// Every non-empty, non-comment line should reference our class
			const ruleLines = css.split('\n').filter((line) => line.trim() && line.includes('{'));
			for (const line of ruleLines) {
				expect(line).toContain(`.${FAST_BLOCK_CLASS}`);
			}
		});
		// The Fast tier reads the zoom from a CSS variable the host sets, so a font
		// change repaints instead of re-running the parse pipeline.
		it('bases the block font size on the file-preview font-scale variable', () => {
			const css = generateProseCss(makeTheme());
			expect(css).toContain('font-size: calc(0.875rem * var(--fp-font-scale, 1))');
		});
		it('embeds theme accent in h1', () => {
			const css = generateProseCss(makeTheme({ accent: '#deadbe' }));
			expect(css).toContain('color: #deadbe');
			expect(css).toMatch(/h1\s*\{[^}]*#deadbe/);
		});
		it('embeds theme success in h2', () => {
			const css = generateProseCss(makeTheme({ success: '#abcabc' }));
			expect(css).toMatch(/h2\s*\{[^}]*#abcabc/);
		});
		it('embeds theme warning in h3', () => {
			const css = generateProseCss(makeTheme({ warning: '#fed0fe' }));
			expect(css).toMatch(/h3\s*\{[^}]*#fed0fe/);
		});
		it('uses theme bgActivity for code and pre backgrounds', () => {
			const css = generateProseCss(makeTheme({ bgActivity: '#101010' }));
			expect(css).toMatch(/code\s*\{[^}]*background-color:\s*#101010/);
			expect(css).toMatch(/pre\s*\{[^}]*background-color:\s*#101010/);
		});
		it('uses theme border in table cells and hr', () => {
			const css = generateProseCss(makeTheme({ border: '#445566' }));
			expect(css).toContain('#445566');
			expect(css).toMatch(/th,\s*\.markdown-fast-block td\s*\{[^}]*#445566/);
		});
		it('produces different output for different themes', () => {
			const dark = generateProseCss(makeTheme({ accent: '#fff' }));
			const light = generateProseCss(makeTheme({ accent: '#000' }));
			expect(dark).not.toBe(light);
		});
		it('includes table styles', () => {
			const css = generateProseCss(makeTheme());
			expect(css).toContain('table');
			expect(css).toContain('border-collapse');
		});
		it('includes blockquote styles', () => {
			const css = generateProseCss(makeTheme());
			expect(css).toContain('blockquote');
		});
		it('contains styles for all six heading levels', () => {
			const css = generateProseCss(makeTheme());
			for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
				expect(css).toMatch(new RegExp(`\\.markdown-fast-block ${tag}\\s*\\{`));
			}
		});
		it('contains styles for list checkbox special-case', () => {
			const css = generateProseCss(makeTheme());
			// `:has(> input[type="checkbox"])` selector for task lists
			expect(css).toContain('input[type="checkbox"]');
		});
	});
});
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/sanitize.test.ts
describe('', () => {
	describe('sanitizeBlock', () => {
		it('passes safe HTML through unchanged', () => {
			const out = sanitizeBlock('<p>hello <strong>world</strong></p>');
			expect(out).toBe('<p>hello <strong>world</strong></p>');
		});
		it('strips <script> tags', () => {
			const out = sanitizeBlock('<p>x</p><script>alert(1)</script>');
			expect(out).not.toContain('<script');
			expect(out).not.toContain('alert');
			expect(out).toContain('<p>x</p>');
		});
		it('strips inline event handlers', () => {
			const out = sanitizeBlock('<a href="https://example.com" onclick="alert(1)">click</a>');
			expect(out).not.toContain('onclick');
			expect(out).toContain('href="https://example.com"');
		});
		it('strips javascript: URLs', () => {
			const out = sanitizeBlock('<a href="javascript:alert(1)">x</a>');
			expect(out).not.toContain('javascript:');
		});
		it('preserves http(s) URLs', () => {
			expect(sanitizeBlock('<a href="https://example.com">x</a>')).toContain(
				'href="https://example.com"'
			);
			expect(sanitizeBlock('<a href="http://example.com">x</a>')).toContain(
				'href="http://example.com"'
			);
		});
		it('preserves the maestro-file:// protocol', () => {
			const out = sanitizeBlock('<a href="maestro-file://path/to/file.md">x</a>');
			expect(out).toContain('href="maestro-file://path/to/file.md"');
		});
		it('preserves the maestro:// deep link protocol', () => {
			const out = sanitizeBlock('<a href="maestro://session/abc/tab/xyz">x</a>');
			expect(out).toContain('href="maestro://session/abc/tab/xyz"');
		});
		it('preserves mailto: and tel: URIs', () => {
			expect(sanitizeBlock('<a href="mailto:a@b.com">x</a>')).toContain('mailto:a@b.com');
			expect(sanitizeBlock('<a href="tel:+1234">x</a>')).toContain('tel:+1234');
		});
		it('preserves data-maestro-file data attributes', () => {
			const out = sanitizeBlock('<a data-maestro-file="docs/readme.md">link</a>');
			expect(out).toContain('data-maestro-file="docs/readme.md"');
		});
		it('preserves data-maestro-image data attributes', () => {
			const out = sanitizeBlock('<img data-maestro-image="path.png" src="path.png" alt="x">');
			expect(out).toContain('data-maestro-image="path.png"');
		});
		it('preserves target attributes on anchors', () => {
			const out = sanitizeBlock('<a href="https://example.com" target="_blank">x</a>');
			expect(out).toContain('target="_blank"');
		});
		it('preserves GFM-style tables', () => {
			const html = '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>';
			const out = sanitizeBlock(html);
			expect(out).toContain('<table>');
			expect(out).toContain('<th>a</th>');
			expect(out).toContain('<td>1</td>');
		});
		it('preserves code blocks with language classes', () => {
			const out = sanitizeBlock('<pre><code class="language-ts">x</code></pre>');
			expect(out).toContain('<pre>');
			expect(out).toContain('class="language-ts"');
		});
		it('strips <iframe> tags', () => {
			const out = sanitizeBlock('<p>x</p><iframe src="https://evil.com"></iframe>');
			expect(out).not.toContain('<iframe');
		});
		it('strips <object> and <embed> tags', () => {
			expect(sanitizeBlock('<object data="x"></object>')).not.toContain('<object');
			expect(sanitizeBlock('<embed src="x">')).not.toContain('<embed');
		});
		it('strips <form> + <input> combos but leaves benign content', () => {
			const out = sanitizeBlock('<form><input name="x"></form><p>safe</p>');
			expect(out).toContain('<p>safe</p>');
			expect(out).not.toContain('<form');
			expect(out).not.toContain('<input');
		});
		it('strips <button>, <select>, <textarea> (phishing-surface tags)', () => {
			expect(sanitizeBlock('<button>x</button>')).not.toContain('<button');
			expect(sanitizeBlock('<select><option>y</option></select>')).not.toContain('<select');
			expect(sanitizeBlock('<textarea>z</textarea>')).not.toContain('<textarea');
		});
		it('handles empty input', () => {
			expect(sanitizeBlock('')).toBe('');
		});
		it('handles malformed HTML without throwing', () => {
			expect(() => sanitizeBlock('<p>unterminated <strong>')).not.toThrow();
		});
		it('is idempotent - sanitizing already-clean HTML twice yields the same result', () => {
			const first = sanitizeBlock('<p>hello <a href="https://example.com">x</a></p>');
			const second = sanitizeBlock(first);
			expect(second).toBe(first);
		});
	});
});
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/searchHits.test.ts
describe('', () => {
	const RANGES: BlockRange[] = [
		{ start: 0, end: 10 },
		{ start: 10, end: 30 },
		{ start: 30, end: 60 },
	];
	describe('blockIndexAtOffset', () => {
		it('returns 0 when ranges are empty', () => {
			expect(blockIndexAtOffset([], 5)).toBe(0);
		});
		it('returns the first block for offset 0', () => {
			expect(blockIndexAtOffset(RANGES, 0)).toBe(0);
		});
		it('returns the correct block for an offset in the middle of a range', () => {
			expect(blockIndexAtOffset(RANGES, 5)).toBe(0);
			expect(blockIndexAtOffset(RANGES, 15)).toBe(1);
			expect(blockIndexAtOffset(RANGES, 50)).toBe(2);
		});
		it('treats range.end as exclusive (start of next range)', () => {
			expect(blockIndexAtOffset(RANGES, 10)).toBe(1);
			expect(blockIndexAtOffset(RANGES, 30)).toBe(2);
		});
		it('clamps to the last block when offset is past the end', () => {
			expect(blockIndexAtOffset(RANGES, 100)).toBe(2);
		});
		it('clamps to the first block for negative offset (defensive)', () => {
			expect(blockIndexAtOffset(RANGES, -5)).toBe(0);
		});
		it('works correctly with a single range', () => {
			const single: BlockRange[] = [{ start: 0, end: 100 }];
			expect(blockIndexAtOffset(single, 50)).toBe(0);
			expect(blockIndexAtOffset(single, 100)).toBe(0);
		});
	});
	describe('findHits', () => {
		const content = 'Hello world, hello again, HELLO upper';
		const ranges: BlockRange[] = [
			{ start: 0, end: 12 }, // "Hello world,"
			{ start: 12, end: 25 }, // " hello again,"
			{ start: 25, end: content.length }, // " HELLO upper"
		];
		it('returns no hits for an empty query', () => {
			expect(findHits(content, '', ranges)).toEqual([]);
		});
		it('returns no hits when the query is not in the content', () => {
			expect(findHits(content, 'nope', ranges)).toEqual([]);
		});
		it('case-insensitive by default', () => {
			const hits = findHits(content, 'hello', ranges);
			expect(hits.length).toBe(3);
			expect(hits[0]).toEqual({
				sourceOffset: 0,
				length: 5,
				blockIndex: 0,
				offsetWithinBlock: 0,
			});
			expect(hits[1].sourceOffset).toBe(13);
			expect(hits[2].sourceOffset).toBe(26);
		});
		it('annotates each hit with its offset relative to the containing block', () => {
			const hits = findHits(content, 'hello', ranges);
			// Block 0 starts at 0 → match at 0 is offset 0.
			// Block 1 starts at 12 → match at 13 is offset 1.
			// Block 2 starts at 25 → match at 26 is offset 1.
			expect(hits.map((h) => h.offsetWithinBlock)).toEqual([0, 1, 1]);
		});
		it('clamps offsetWithinBlock to 0 when match precedes the resolved block start', () => {
			// Defensive: if blockIndexAtOffset clamps a hit before block 0's start
			// (theoretically impossible with sorted ranges starting at 0, but the
			// helper is structurally robust), offsetWithinBlock must not go negative.
			const hits = findHits('hello', 'hello', [{ start: 10, end: 20 }]);
			expect(hits[0].offsetWithinBlock).toBe(0);
		});
		it('case-sensitive when explicitly requested', () => {
			const hits = findHits(content, 'hello', ranges, { caseSensitive: true });
			expect(hits.length).toBe(1);
			expect(hits[0].sourceOffset).toBe(13);
		});
		it('annotates each hit with the block it falls inside', () => {
			const hits = findHits(content, 'hello', ranges);
			expect(hits.map((h) => h.blockIndex)).toEqual([0, 1, 2]);
		});
		it('reports length equal to the original query (preserves case for downstream display)', () => {
			const hits = findHits(content, 'Hello', ranges);
			expect(hits.every((h) => h.length === 5)).toBe(true);
		});
		it('finds overlapping-ish matches by advancing past each match', () => {
			const hits = findHits('aaaa', 'aa', [{ start: 0, end: 4 }]);
			// Greedy-non-overlapping: starts at 0 and 2.
			expect(hits.map((h) => h.sourceOffset)).toEqual([0, 2]);
		});
		it('does not infinite-loop on empty content', () => {
			expect(findHits('', 'x', ranges)).toEqual([]);
		});
		it('clamps blockIndex to the last block when content extends past the last range', () => {
			const hits = findHits(content, 'upper', [
				{ start: 0, end: 5 },
				{ start: 5, end: 10 },
			]);
			expect(hits.length).toBe(1);
			expect(hits[0].blockIndex).toBe(1);
		});
		it('returns hits in source order even when the query repeats many times', () => {
			const haystack = 'x'.repeat(100);
			const hits = findHits(haystack, 'x', [{ start: 0, end: 100 }]);
			expect(hits.length).toBe(100);
			for (let i = 1; i < hits.length; i++) {
				expect(hits[i].sourceOffset).toBeGreaterThan(hits[i - 1].sourceOffset);
			}
		});
	});
});
