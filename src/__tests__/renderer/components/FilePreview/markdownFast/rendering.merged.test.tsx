// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/alertTagger.test.ts
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/blocks.test.ts
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/codeHighlighter.test.ts
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/escapeHtml.test.ts
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/frontmatter.test.ts
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/headingSlugger.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildBlocks } from '../../../../../renderer/components/FilePreview/markdownFast/pipeline';
import { sanitizeBlock } from '../../../../../renderer/components/FilePreview/markdownFast/sanitize';
import { createParser as s2_createParser } from '../../../../../renderer/components/FilePreview/markdownFast/parser';
import { tokensToBlocks } from '../../../../../renderer/components/FilePreview/markdownFast/blocks';
import { applyHeadingSlugs as s2_applyHeadingSlugs } from '../../../../../renderer/components/FilePreview/markdownFast/headingSlugger';
import {
	createCodeHighlighter,
	HIGHLIGHTED_ATTR,
} from '../../../../../renderer/components/FilePreview/markdownFast/codeHighlighter';
import { __resetForTests } from '../../../../../renderer/utils/shiki/highlighterManager';
import { mockTheme } from '../../../../helpers/mockTheme';
import { escapeHtml } from '../../../../../renderer/components/FilePreview/markdownFast/escapeHtml';
import {
	parseYamlKeyValues,
	renderFrontmatterHtml,
	splitFrontmatter,
} from '../../../../../renderer/components/FilePreview/markdownFast/frontmatter';
import { createParser as s6_createParser } from '../../../../../renderer/components/FilePreview/markdownFast/parser';
import { applyHeadingSlugs as s6_applyHeadingSlugs } from '../../../../../renderer/components/FilePreview/markdownFast/headingSlugger';
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
			codeToHtml: (
				code: string,
				opts: {
					lang: string;
				}
			) => `<pre class="shiki"><code class="language-${opts.lang}">HL:${code}</code></pre>`,
			getLoadedLanguages: () => Array.from(loaded),
			loadLanguage: async (lang: string) => {
				loaded.add(lang);
			},
		})),
		bundledLanguagesInfo: [],
		bundledLanguagesAlias: {},
	};
});
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/alertTagger.test.ts
describe('', () => {
	/**
	 * The Fast tier assembles HTML from a markdown-it token stream instead of
	 * rendering React, so it needs its own alert transform. Without it a large
	 * document showed a literal `[!WARNING]` while the same file rendered a styled
	 * callout on the Rich tier - the tier chip is supposed to change responsiveness,
	 * not content.
	 */
	const html = (source: string) =>
		buildBlocks(source)
			.map((block) => block.html)
			.join('\n');
	describe('Fast tier alert callouts', () => {
		it('tags the blockquote and injects the labeled header', () => {
			const out = html('> [!WARNING]\n> Mind the gap.\n');
			expect(out).toContain('markdown-alert markdown-alert-warning');
			expect(out).toContain('data-alert-type="warning"');
			expect(out).toContain('<span>Warning</span>');
			expect(out).toContain('<svg');
			expect(out).not.toContain('[!WARNING]');
			expect(out).toContain('Mind the gap.');
		});
		it('recognizes every type, case-insensitively', () => {
			for (const [marker, type] of [
				['NOTE', 'note'],
				['TIP', 'tip'],
				['Important', 'important'],
				['warning', 'warning'],
				['CAUTION', 'caution'],
			]) {
				expect(html(`> [!${marker}]\n> Body.\n`)).toContain(`markdown-alert-${type}`);
			}
		});
		// GitHub only treats the marker as an alert when it stands alone on the first
		// line, and remarkAlert matches that. The tiers must agree.
		it('leaves a marker with a trailing title as an ordinary blockquote', () => {
			const out = html('> [!NOTE] with a title\n> Body.\n');
			expect(out).not.toContain('markdown-alert');
			expect(out).toContain('[!NOTE] with a title');
		});
		it('leaves an ordinary blockquote alone', () => {
			const out = html('> Just a quote.\n');
			expect(out).not.toContain('markdown-alert');
			expect(out).toContain('Just a quote.');
		});
		it('does not leave a blank first line when the callout body starts on line two', () => {
			const out = html('> [!TIP]\n> First body line.\n');
			expect(out).not.toMatch(/<p>\s*<br>/);
			expect(out).toContain('First body line.');
		});
		// The injected header goes through DOMPurify at render time; an over-eager
		// policy would drop the icon and leave a label with no glyph.
		it('survives the block sanitizer', () => {
			const sanitized = sanitizeBlock(html('> [!CAUTION]\n> Careful.\n'));
			expect(sanitized).toContain('markdown-alert-caution');
			expect(sanitized).toContain('<span>Caution</span>');
			expect(sanitized).toContain('<svg');
		});
		it('keeps the callout in one block so virtualization cannot split it', () => {
			const blocks = buildBlocks('# Doc\n\n> [!NOTE]\n> Body.\n');
			expect(blocks).toHaveLength(2);
			expect(blocks[1].html).toContain('markdown-alert-note');
			expect(blocks[1].html).toContain('Body.');
		});
	});
});
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/blocks.test.ts
describe('', () => {
	function parseToBlocks(source: string) {
		const md = s2_createParser();
		const tokens = md.parse(source, {});
		return tokensToBlocks(md, tokens);
	}
	function parseToBlocksWithSlugs(source: string) {
		const md = s2_createParser();
		const tokens = md.parse(source, {});
		s2_applyHeadingSlugs(md, tokens);
		return tokensToBlocks(md, tokens);
	}
	describe('tokensToBlocks', () => {
		it('returns an empty array for empty input', () => {
			expect(parseToBlocks('')).toEqual([]);
		});
		it('groups a single paragraph into one block', () => {
			const blocks = parseToBlocks('hello world');
			expect(blocks.length).toBe(1);
			expect(blocks[0].html).toContain('<p>hello world</p>');
		});
		it('emits one block per heading', () => {
			const blocks = parseToBlocks('# A\n\n# B\n\n# C');
			expect(blocks.length).toBe(3);
			expect(blocks[0].html).toContain('<h1>A</h1>');
			expect(blocks[1].html).toContain('<h1>B</h1>');
			expect(blocks[2].html).toContain('<h1>C</h1>');
		});
		it('separates heading and paragraph into distinct blocks', () => {
			const blocks = parseToBlocks('# Heading\n\nA paragraph.');
			expect(blocks.length).toBe(2);
			expect(blocks[0].html).toContain('<h1>');
			expect(blocks[1].html).toContain('<p>A paragraph.</p>');
		});
		it('treats fenced code blocks as a single standalone block', () => {
			const blocks = parseToBlocks('```\nfoo\nbar\n```');
			expect(blocks.length).toBe(1);
			expect(blocks[0].html).toContain('<pre>');
			expect(blocks[0].html).toContain('foo');
		});
		it('treats horizontal rule as a single standalone block', () => {
			const blocks = parseToBlocks('---');
			expect(blocks.length).toBe(1);
			expect(blocks[0].html).toContain('<hr>');
		});
		it('keeps nested list items inside their containing list block', () => {
			// A list with nested items should be one block, not many - the inner
			// items live at level > 0 and are skipped by the outer walker.
			const blocks = parseToBlocks('- a\n  - a1\n  - a2\n- b');
			expect(blocks.length).toBe(1);
			expect(blocks[0].html).toContain('<ul>');
			expect(blocks[0].html).toContain('a1');
			expect(blocks[0].html).toContain('a2');
		});
		it('keeps a GFM table as a single block regardless of row count', () => {
			const source = ['| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |'].join('\n');
			const blocks = parseToBlocks(source);
			expect(blocks.length).toBe(1);
			expect(blocks[0].html).toContain('<table>');
			expect(blocks[0].html).toContain('<th>a</th>');
			expect(blocks[0].html).toContain('<td>5</td>');
		});
		it('treats blockquotes as a single block including nested content', () => {
			const blocks = parseToBlocks('> quoted\n>\n> more quote');
			expect(blocks.length).toBe(1);
			expect(blocks[0].html).toContain('<blockquote>');
		});
		it('assigns sequential ids starting at 0', () => {
			const blocks = parseToBlocks('# A\n\n# B\n\n# C');
			expect(blocks.map((b) => b.id)).toEqual([0, 1, 2]);
		});
		it('handles raw HTML blocks as standalone blocks', () => {
			const blocks = parseToBlocks('<div>raw</div>\n\nafter');
			expect(blocks.length).toBe(2);
			expect(blocks[0].html).toContain('<div>raw</div>');
			expect(blocks[1].html).toContain('<p>after</p>');
		});
		it('handles a mix of block types in document order', () => {
			const source = [
				'# Title',
				'',
				'Intro paragraph.',
				'',
				'```',
				'code',
				'```',
				'',
				'- list',
				'',
			].join('\n');
			const blocks = parseToBlocks(source);
			expect(blocks.length).toBe(4);
			expect(blocks[0].html).toContain('<h1>');
			expect(blocks[1].html).toContain('<p>');
			expect(blocks[2].html).toContain('<pre>');
			expect(blocks[3].html).toContain('<ul>');
		});
		it('does not emit any blocks for tokens that are nested (level > 0)', () => {
			// All emitted blocks should themselves wrap their nested content; we
			// should never see a stray inline or text token rendered alone.
			const blocks = parseToBlocks('**bold** *italic* text');
			expect(blocks.length).toBe(1);
			expect(blocks[0].html).toContain('<strong>bold</strong>');
			expect(blocks[0].html).toContain('<em>italic</em>');
		});
		it('produces blocks whose ids are unique', () => {
			const source = Array.from({ length: 20 }, (_, i) => `# Heading ${i}`).join('\n\n');
			const blocks = parseToBlocks(source);
			const ids = new Set(blocks.map((b) => b.id));
			expect(ids.size).toBe(blocks.length);
		});
		describe('headingSlug propagation', () => {
			it('does not attach a headingSlug when no slugger plugin runs', () => {
				const blocks = parseToBlocks('# A\n\nparagraph');
				expect(blocks[0].headingSlug).toBeUndefined();
				expect(blocks[1].headingSlug).toBeUndefined();
			});
			it('attaches headingSlug to heading blocks when slugger plugin runs', () => {
				const blocks = parseToBlocksWithSlugs('# Hello World');
				expect(blocks[0].headingSlug).toBe('hello-world');
			});
			it('leaves non-heading blocks with undefined headingSlug', () => {
				const blocks = parseToBlocksWithSlugs('# H\n\nparagraph\n\n- list');
				expect(blocks[0].headingSlug).toBe('h');
				expect(blocks[1].headingSlug).toBeUndefined();
				expect(blocks[2].headingSlug).toBeUndefined();
			});
			it('preserves slug uniqueness across duplicate headings', () => {
				const blocks = parseToBlocksWithSlugs('# Same\n\n# Same\n\n# Same');
				expect(blocks.map((b) => b.headingSlug)).toEqual(['same', 'same-1', 'same-2']);
			});
			it('handles a doc with no headings at all', () => {
				const blocks = parseToBlocksWithSlugs('just a paragraph\n\nand another');
				expect(blocks.every((b) => b.headingSlug === undefined)).toBe(true);
			});
		});
	});
});
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/codeHighlighter.test.ts
describe('', () => {
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
	beforeEach(() => {
		(
			globalThis as typeof globalThis & {
				IntersectionObserver: typeof IntersectionObserver;
			}
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
});
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/escapeHtml.test.ts
describe('', () => {
	describe('escapeHtml', () => {
		it('returns the input unchanged when no special characters are present', () => {
			expect(escapeHtml('hello world')).toBe('hello world');
		});
		it('escapes ampersands first to avoid double-encoding', () => {
			expect(escapeHtml('a & b')).toBe('a &amp; b');
			// Critical: when an entity-looking string is encoded, the leading & must
			// be escaped first so we don't end up with &amp;amp;.
			expect(escapeHtml('&amp;')).toBe('&amp;amp;');
		});
		it('escapes angle brackets', () => {
			expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
		});
		it('escapes double quotes', () => {
			expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
		});
		it('escapes single quotes using the numeric entity', () => {
			expect(escapeHtml("it's")).toBe('it&#39;s');
		});
		it('escapes all metacharacters in a single string', () => {
			expect(escapeHtml(`<a href="x" onclick='y'>&amp;</a>`)).toBe(
				'&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;'
			);
		});
		it('returns an empty string for empty input', () => {
			expect(escapeHtml('')).toBe('');
		});
		it('preserves unicode and emoji', () => {
			expect(escapeHtml('Привет 🚀')).toBe('Привет 🚀');
		});
		it('handles strings made entirely of special characters', () => {
			expect(escapeHtml('<<>>&&""')).toBe('&lt;&lt;&gt;&gt;&amp;&amp;&quot;&quot;');
		});
		it('does not break when the same character appears many times', () => {
			const input = '&'.repeat(1000);
			const escaped = escapeHtml(input);
			expect(escaped).toBe('&amp;'.repeat(1000));
		});
	});
});
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/frontmatter.test.ts
describe('', () => {
	describe('parseYamlKeyValues', () => {
		it('returns an empty array for empty input', () => {
			expect(parseYamlKeyValues('')).toEqual([]);
		});
		it('parses simple key/value pairs', () => {
			expect(parseYamlKeyValues('title: Hello\nauthor: Ada')).toEqual([
				{ key: 'title', value: 'Hello' },
				{ key: 'author', value: 'Ada' },
			]);
		});
		it('trims surrounding whitespace from keys and values', () => {
			// Leading whitespace on the line itself marks an indented continuation
			// (see the block-scalar tests below), so this only exercises trimming
			// around the colon and at the end of the value.
			expect(parseYamlKeyValues('title  :   Hello World  ')).toEqual([
				{ key: 'title', value: 'Hello World' },
			]);
		});
		it('strips matching double quotes from values', () => {
			expect(parseYamlKeyValues('title: "Quoted"')).toEqual([{ key: 'title', value: 'Quoted' }]);
		});
		it('strips matching single quotes from values', () => {
			expect(parseYamlKeyValues("title: 'Quoted'")).toEqual([{ key: 'title', value: 'Quoted' }]);
		});
		it('does not strip mismatched quotes', () => {
			expect(parseYamlKeyValues(`title: "Quoted'`)).toEqual([{ key: 'title', value: `"Quoted'` }]);
		});
		it('skips blank lines', () => {
			expect(parseYamlKeyValues('\ntitle: Hello\n\nauthor: Ada\n')).toEqual([
				{ key: 'title', value: 'Hello' },
				{ key: 'author', value: 'Ada' },
			]);
		});
		it('skips comment lines starting with #', () => {
			expect(parseYamlKeyValues('# top comment\ntitle: Hello\n# inline')).toEqual([
				{ key: 'title', value: 'Hello' },
			]);
		});
		it('skips lines without a colon', () => {
			expect(parseYamlKeyValues('orphan-line\ntitle: Hello')).toEqual([
				{ key: 'title', value: 'Hello' },
			]);
		});
		it('skips lines whose colon appears in position zero (no key)', () => {
			expect(parseYamlKeyValues(': no-key\ntitle: Hello')).toEqual([
				{ key: 'title', value: 'Hello' },
			]);
		});
		it('preserves colons inside values', () => {
			expect(parseYamlKeyValues('url: https://example.com')).toEqual([
				{ key: 'url', value: 'https://example.com' },
			]);
		});
		it('preserves whitespace inside quoted values', () => {
			expect(parseYamlKeyValues('title: "  spaced  "')).toEqual([
				{ key: 'title', value: '  spaced  ' },
			]);
		});
		it('captures literal block scalars (|) as a single multi-line value', () => {
			const yaml = ['notes: |', '  first line', '  second line', 'author: Ada'].join('\n');
			expect(parseYamlKeyValues(yaml)).toEqual([
				{ key: 'notes', value: 'first line\nsecond line' },
				{ key: 'author', value: 'Ada' },
			]);
		});
		it('does not treat indented "key:" lines inside a block scalar as new entries', () => {
			// Regression: prose containing colons inside a `notes: |` block was being
			// shredded into bogus key/value rows.
			const yaml = [
				'notes: |',
				'  Pedram-flagged 2026-05-13: "lot of people talking about conductor"',
				'  Parent: "I actually think AI wrappers capture value."',
				'tier: T3',
			].join('\n');
			expect(parseYamlKeyValues(yaml)).toEqual([
				{
					key: 'notes',
					value:
						'Pedram-flagged 2026-05-13: "lot of people talking about conductor"\nParent: "I actually think AI wrappers capture value."',
				},
				{ key: 'tier', value: 'T3' },
			]);
		});
		it('preserves blank lines between paragraphs inside a block scalar', () => {
			const yaml = ['notes: |', '  para one', '', '  para two'].join('\n');
			expect(parseYamlKeyValues(yaml)).toEqual([{ key: 'notes', value: 'para one\n\npara two' }]);
		});
		it('folds (>) block scalars into space-joined lines with blanks as paragraph breaks', () => {
			const yaml = ['summary: >', '  line one', '  line two', '', '  line three'].join('\n');
			expect(parseYamlKeyValues(yaml)).toEqual([
				{ key: 'summary', value: 'line one line two\n\nline three' },
			]);
		});
		it('skips indented continuation lines that are not part of a block scalar', () => {
			const yaml = ['title: Hello', '  stray-indented: ignored', 'author: Ada'].join('\n');
			expect(parseYamlKeyValues(yaml)).toEqual([
				{ key: 'title', value: 'Hello' },
				{ key: 'author', value: 'Ada' },
			]);
		});
	});
	describe('renderFrontmatterHtml', () => {
		it('returns null for empty entries', () => {
			expect(renderFrontmatterHtml([])).toBeNull();
		});
		it('renders a Document metadata header + table', () => {
			const html = renderFrontmatterHtml([{ key: 'title', value: 'Hello' }]);
			expect(html).toContain('<p><em>Document metadata:</em></p>');
			expect(html).toContain('<table>');
			expect(html).toContain('<tr>');
			expect(html).toContain('<strong>title</strong>');
			expect(html).toContain('Hello');
		});
		it('escapes user-supplied keys and values', () => {
			const html = renderFrontmatterHtml([{ key: '<key>', value: '<script>alert(1)</script>' }])!;
			expect(html).not.toContain('<script>');
			expect(html).toContain('&lt;key&gt;');
			expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		});
		it('renders URL values as anchor tags', () => {
			const html = renderFrontmatterHtml([{ key: 'home', value: 'https://example.com/page' }])!;
			expect(html).toContain('<a href="https://example.com/page"');
			expect(html).toContain('https://example.com/page</a>');
		});
		it('truncates long URLs for display but keeps full URL in href + title', () => {
			const long = 'https://example.com/' + 'a'.repeat(80);
			const html = renderFrontmatterHtml([{ key: 'home', value: long }])!;
			expect(html).toContain(`href="${long}"`);
			expect(html).toContain(`title="${long}"`);
			// Display text should be truncated to 50 chars (47 + '...')
			const displayMatch = html.match(/>([^<]+)<\/a>/);
			expect(displayMatch).not.toBeNull();
			expect(displayMatch![1].length).toBe(50);
			expect(displayMatch![1].endsWith('...')).toBe(true);
		});
		it('renders non-URL values as plain text, not links', () => {
			const html = renderFrontmatterHtml([{ key: 'title', value: 'My Doc' }])!;
			expect(html).not.toContain('<a ');
			expect(html).toContain('My Doc');
		});
		it('escapes special characters in URL display text', () => {
			// URLs with raw HTML chars shouldn't be common, but we still escape them
			const html = renderFrontmatterHtml([{ key: 'k', value: 'https://example.com/<x>' }])!;
			expect(html).toContain('&lt;x&gt;');
		});
		it('renders multi-line values with <br> between lines', () => {
			const html = renderFrontmatterHtml([
				{ key: 'notes', value: 'line one\nline two\nline three' },
			])!;
			expect(html).toContain('line one<br>line two<br>line three');
		});
		it('escapes multi-line values before inserting <br>', () => {
			const html = renderFrontmatterHtml([{ key: 'notes', value: '<script>\nalert(1)' }])!;
			expect(html).not.toContain('<script>');
			expect(html).toContain('&lt;script&gt;<br>alert(1)');
		});
		it('renders each entry as its own table row', () => {
			const html = renderFrontmatterHtml([
				{ key: 'a', value: '1' },
				{ key: 'b', value: '2' },
				{ key: 'c', value: '3' },
			])!;
			expect((html.match(/<tr>/g) || []).length).toBe(3);
		});
	});
	describe('splitFrontmatter', () => {
		it('returns null frontmatter and full body when no frontmatter is present', () => {
			expect(splitFrontmatter('# Title\n\nbody')).toEqual({
				frontmatterHtml: null,
				body: '# Title\n\nbody',
			});
		});
		it('strips frontmatter from the body when present', () => {
			const result = splitFrontmatter('---\ntitle: Hello\n---\n# Body');
			expect(result.body).toBe('# Body');
			expect(result.frontmatterHtml).toContain('<strong>title</strong>');
			expect(result.frontmatterHtml).toContain('Hello');
		});
		it('handles CRLF line endings', () => {
			const result = splitFrontmatter('---\r\ntitle: Hello\r\n---\r\n# Body');
			expect(result.body).toBe('# Body');
			expect(result.frontmatterHtml).toContain('Hello');
		});
		it('only strips frontmatter at the very start of the document', () => {
			// Frontmatter only counts when at position 0
			const result = splitFrontmatter('# Heading\n---\ntitle: x\n---\nbody');
			expect(result.frontmatterHtml).toBeNull();
			expect(result.body).toBe('# Heading\n---\ntitle: x\n---\nbody');
		});
		it('returns null frontmatter when the YAML block is empty', () => {
			const result = splitFrontmatter('---\n\n---\nbody');
			// Empty entries → renderFrontmatterHtml returns null
			expect(result.frontmatterHtml).toBeNull();
			expect(result.body).toBe('body');
		});
		it('does not consume trailing whitespace after the closing fence', () => {
			const result = splitFrontmatter('---\ntitle: x\n---\n  body  ');
			expect(result.body).toBe('  body  ');
		});
		it('handles documents that are just frontmatter with no body', () => {
			const result = splitFrontmatter('---\ntitle: x\n---\n');
			expect(result.body).toBe('');
			expect(result.frontmatterHtml).toContain('title');
		});
	});
});
// Source: src/__tests__/renderer/components/FilePreview/markdownFast/headingSlugger.test.ts
describe('', () => {
	function parseAndSlug(source: string) {
		const md = s6_createParser();
		const tokens = md.parse(source, {});
		s6_applyHeadingSlugs(md, tokens);
		return tokens;
	}
	describe('applyHeadingSlugs', () => {
		it('stamps an id attribute on heading_open tokens', () => {
			const tokens = parseAndSlug('# Hello World');
			const heading = tokens.find((t) => t.type === 'heading_open');
			expect(heading).toBeDefined();
			expect(heading!.attrGet('id')).toBe('hello-world');
		});
		it('produces lowercase, kebab-case slugs', () => {
			const tokens = parseAndSlug('# This Is A Heading');
			expect(tokens.find((t) => t.type === 'heading_open')!.attrGet('id')).toBe(
				'this-is-a-heading'
			);
		});
		it('disambiguates duplicate slugs with numeric suffixes', () => {
			const tokens = parseAndSlug('# Same\n\n# Same\n\n# Same');
			const headings = tokens.filter((t) => t.type === 'heading_open');
			expect(headings.length).toBe(3);
			expect(headings[0].attrGet('id')).toBe('same');
			expect(headings[1].attrGet('id')).toBe('same-1');
			expect(headings[2].attrGet('id')).toBe('same-2');
		});
		it('stamps slugs on headings of all levels', () => {
			const tokens = parseAndSlug('# One\n\n## Two\n\n### Three');
			const headings = tokens.filter((t) => t.type === 'heading_open');
			expect(headings.map((t) => t.attrGet('id'))).toEqual(['one', 'two', 'three']);
		});
		it('does not modify non-heading tokens', () => {
			const tokens = parseAndSlug('Paragraph text.\n\n> quote');
			expect(tokens.find((t) => t.type === 'paragraph_open')?.attrGet('id')).toBeNull();
			expect(tokens.find((t) => t.type === 'blockquote_open')?.attrGet('id')).toBeNull();
		});
		it('does not modify headings with empty content', () => {
			// A heading with empty content is unusual; we skip slugging it.
			const tokens = parseAndSlug('#');
			const heading = tokens.find((t) => t.type === 'heading_open');
			// markdown-it may not even emit a heading for "#" alone, but if it does,
			// it should not have an id (we skipped due to empty text).
			if (heading) {
				expect(heading.attrGet('id')).toBeNull();
			}
		});
		it('handles unicode and emoji in headings', () => {
			const tokens = parseAndSlug('# Привет 🚀 World');
			// GithubSlugger preserves unicode letters and strips emojis with replacement.
			const id = tokens.find((t) => t.type === 'heading_open')!.attrGet('id');
			expect(id).toBeTypeOf('string');
			expect(id!.length).toBeGreaterThan(0);
		});
		it('strips inline markdown markers from the slug source text', () => {
			// "**Bold**" → slugger should see "Bold" (markdown-it's inline.content keeps the literal **)
			// Confirm we still produce SOME slug - exact form depends on slugger, but
			// it must be deterministic.
			const a = parseAndSlug('# **Important** thing')
				.find((t) => t.type === 'heading_open')!
				.attrGet('id');
			const b = parseAndSlug('# **Important** thing')
				.find((t) => t.type === 'heading_open')!
				.attrGet('id');
			expect(a).toBe(b);
		});
		it('produces stable slugs across runs', () => {
			const src = '# A\n\n## B\n\n# A';
			const first = parseAndSlug(src)
				.filter((t) => t.type === 'heading_open')
				.map((t) => t.attrGet('id'));
			const second = parseAndSlug(src)
				.filter((t) => t.type === 'heading_open')
				.map((t) => t.attrGet('id'));
			expect(first).toEqual(second);
		});
		it('respects the order of headings in the document', () => {
			const src = '# Alpha\n\n# Beta\n\n# Gamma';
			const slugs = parseAndSlug(src)
				.filter((t) => t.type === 'heading_open')
				.map((t) => t.attrGet('id'));
			expect(slugs).toEqual(['alpha', 'beta', 'gamma']);
		});
	});
});
