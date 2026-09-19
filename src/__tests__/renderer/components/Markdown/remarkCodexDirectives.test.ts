/**
 * The thing under test is a rewrite that edits a message in place, so every
 * case here is really one question: did anything the user wrote go missing?
 *
 * These run the real remark -> rehype pipeline rather than asserting on mdast,
 * because the failure being guarded against is "the plugin rebuilt the
 * paragraph and the renderer dropped it anyway". Text is read back as the
 * ordered list of text nodes, which is what makes a lost character or a
 * reordered run visible where a substring check would not be.
 */

import { describe, it, expect } from 'vitest';
import { unified, type PluggableList } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { toHtml } from 'hast-util-to-html';
import { visit } from 'unist-util-visit';
import type { Root as HastRoot, Element } from 'hast';
import {
	remarkCodexDirectives,
	CODEX_DIRECTIVE_DATA_ATTRIBUTES,
} from '../../../../renderer/components/Markdown/remarkCodexDirectives';
import { buildMarkdownPlugins } from '../../../../renderer/components/Markdown/plugins';

function transform(
	markdown: string,
	remarkPlugins: PluggableList = [remarkGfm, remarkCodexDirectives],
	rehypePlugins?: PluggableList
): HastRoot {
	const processor = unified().use(remarkParse).use(remarkPlugins).use(remarkRehype);
	if (rehypePlugins) processor.use(rehypePlugins);
	// The source string is what the plugin reads back off the VFile to line the
	// directives up against the tree's positions, so it has to be the same one.
	return processor.runSync(processor.parse(markdown), markdown) as unknown as HastRoot;
}

/** Every text node, in document order. */
function textNodes(tree: HastRoot): string[] {
	const values: string[] = [];
	visit(tree, 'text', (node: { value: string }) => {
		values.push(node.value);
	});
	return values;
}

interface RenderedDirective {
	name: unknown;
	label: unknown;
	attributes: Record<string, string>;
	element: Element;
}

function directives(tree: HastRoot): RenderedDirective[] {
	const found: RenderedDirective[] = [];
	visit(tree, 'element', (node: Element) => {
		const properties = (node.properties ?? {}) as Record<string, unknown>;
		const name = properties[CODEX_DIRECTIVE_DATA_ATTRIBUTES.name];
		if (name === undefined) return;
		found.push({
			name,
			label: properties[CODEX_DIRECTIVE_DATA_ATTRIBUTES.label],
			attributes: JSON.parse(String(properties[CODEX_DIRECTIVE_DATA_ATTRIBUTES.payload])) as Record<
				string,
				string
			>,
			element: node,
		});
	});
	return found;
}

describe('remarkCodexDirectives', () => {
	it('turns a followup list item into one element carrying its label and prompt', () => {
		const tree = transform('- :codex-followup[Label]{prompt="Do the thing"}');

		const [directive, ...rest] = directives(tree);
		expect(rest).toHaveLength(0);
		expect(directive.name).toBe('codex-followup');
		expect(directive.label).toBe('Label');
		expect(directive.attributes).toEqual({ prompt: 'Do the thing' });

		// The wire format must not survive anywhere in the output. `[Label]` and
		// `{prompt=` are the two halves remark tokenizes apart, so a rewrite that
		// stitched only one of them back would leave the other on screen.
		const html = toHtml(tree);
		expect(html).not.toContain('[Label]');
		expect(html).not.toContain('{prompt=');
		// Nothing but the newlines remark-rehype lays between list elements.
		expect(textNodes(tree).join('').trim()).toBe('');

		// The directive is the whole list item, and it stays one.
		expect(html).toMatch(/<li><span/);
	});

	it('survives the label being tokenized into a linkReference', () => {
		// THE trap. A matching link definition anywhere in the message makes
		// remark read `[Label]` as a shortcut reference, which splits one
		// directive across three sibling nodes before any plugin runs.
		const tree = transform(
			['- :codex-followup[Label]{prompt="Do the thing"}', '', '[label]: https://example.com'].join(
				'\n'
			)
		);

		const [directive, ...rest] = directives(tree);
		expect(rest).toHaveLength(0);
		expect(directive.label).toBe('Label');
		expect(directive.attributes).toEqual({ prompt: 'Do the thing' });
		const html = toHtml(tree);
		expect(html).not.toContain('[Label]');
		expect(html).not.toContain('{prompt=');
		// Specifically: no half-rewritten anchor left where the label used to be.
		expect(html).not.toContain('example.com');
	});

	it('renders three consecutive followups as three elements', () => {
		const tree = transform(
			[
				'- :codex-followup[One]{prompt="First"}',
				'- :codex-followup[Two]{prompt="Second"}',
				'- :codex-followup[Three]{prompt="Third"}',
			].join('\n')
		);

		const found = directives(tree);
		expect(found.map((entry) => entry.label)).toEqual(['One', 'Two', 'Three']);
		expect(found.map((entry) => entry.attributes.prompt)).toEqual(['First', 'Second', 'Third']);
	});

	it('keeps the prose on both sides of a directive, in order', () => {
		const tree = transform('Before :codex-followup[Mid]{prompt="M"} after.');

		expect(directives(tree)).toHaveLength(1);
		// Two runs, still in order, and between them exactly the characters the
		// directive occupied - nothing more, nothing less.
		expect(textNodes(tree)).toEqual(['Before ', ' after.']);
	});

	it('carries a source citation through as its path and purpose', () => {
		const tree = transform(
			'See :codex-file-citation{path="/repo/src/index.ts" purpose="source"} for the entry point.'
		);

		const [directive, ...rest] = directives(tree);
		expect(rest).toHaveLength(0);
		expect(directive.name).toBe('codex-file-citation');
		expect(directive.attributes).toEqual({
			path: '/repo/src/index.ts',
			purpose: 'source',
		});
		// The absolute path is the whole reason this one is unreadable raw: it
		// must not survive as prose beside the chip that replaced it.
		expect(textNodes(tree)).toEqual(['See ', ' for the entry point.']);
	});

	it('carries an output citation through with its artifact kind', () => {
		const tree = transform(
			'Wrote :codex-file-citation{path="/repo/out/report.md" purpose="output" artifact_kind="report"}.'
		);

		const [directive] = directives(tree);
		expect(directive.attributes).toEqual({
			path: '/repo/out/report.md',
			purpose: 'output',
			artifact_kind: 'report',
		});
		expect(toHtml(tree)).not.toContain('codex-file-citation{');
	});

	it('keeps a page number on a citation', () => {
		const tree = transform(
			':codex-file-citation{path="/repo/docs/spec.pdf" purpose="source" page_number="12"}'
		);

		const [directive] = directives(tree);
		// The wire carries a string and so does the attribute payload - a page
		// number is printed, never counted with.
		expect(directive.attributes.page_number).toBe('12');
		expect(directive.attributes.path).toBe('/repo/docs/spec.pdf');
	});

	it('keeps a code comment body that holds an escaped quote and a literal brace', () => {
		// `body` is the one attribute that legitimately carries both. The quote
		// arrives escaped (the grammar's `backslash` mode, which is what
		// `findCodexDirectives` defaults to), and a `}` inside a quoted value is
		// an ordinary character - only the one that closes the attribute set
		// counts. Getting either wrong truncates an agent's review comment
		// mid-sentence.
		const tree = transform(
			'::code-comment{title="Off-by-one" body="The guard says \\"len\\" but the block } never closes." file="/repo/src/loop.ts" start=10 end=11 priority=2}'
		);

		const [directive, ...rest] = directives(tree);
		expect(rest).toHaveLength(0);
		expect(directive.name).toBe('code-comment');
		expect(directive.attributes.body).toBe('The guard says "len" but the block } never closes.');
		expect(directive.attributes).toEqual({
			title: 'Off-by-one',
			body: 'The guard says "len" but the block } never closes.',
			file: '/repo/src/loop.ts',
			start: '10',
			end: '11',
			priority: '2',
		});
		// Nothing of the wire format survives beside the card that replaced it.
		expect(textNodes(tree).join('').trim()).toBe('');
	});

	it('keeps a directive inside a fenced code block as literal text', () => {
		// Maestro's own docs quote this syntax. Drawing a chip on an example
		// would offer the reader an action nobody is offering.
		const tree = transform(
			['```markdown', '- :codex-followup[Label]{prompt="Do the thing"}', '```'].join('\n')
		);

		expect(directives(tree)).toHaveLength(0);
		expect(textNodes(tree).join('')).toContain(':codex-followup[Label]{prompt="Do the thing"}');
	});

	it('keeps a directive inside inline backticks as literal text', () => {
		const tree = transform('Write `:codex-followup[Label]{prompt="Do the thing"}` to offer one.');

		expect(directives(tree)).toHaveLength(0);
		expect(textNodes(tree).join('')).toBe(
			'Write :codex-followup[Label]{prompt="Do the thing"} to offer one.'
		);
	});

	it('leaves an unknown directive name byte for byte alone', () => {
		const tree = transform('Here is ::not-a-real-thing{a="b"} in a sentence.');

		expect(directives(tree)).toHaveLength(0);
		expect(textNodes(tree)).toEqual(['Here is ::not-a-real-thing{a="b"} in a sentence.']);
	});

	it('leaves a CSS selector alone', () => {
		// The grammar is permissive enough that prose about CSS parses as a
		// directive; the allowlist is what keeps this paragraph intact.
		const tree = transform('Style it with a::before{color:red} and be done.');

		expect(directives(tree)).toHaveLength(0);
		expect(textNodes(tree)).toEqual(['Style it with a::before{color:red} and be done.']);
	});

	it('keeps its attributes through the chat surface sanitizer', () => {
		// Chat defaults `allowRawHtml` on, which puts rehype-sanitize over ALL of
		// its markdown rather than just raw HTML - and the GitHub default schema
		// strips every data attribute. Without the allow-list entry the chip still
		// renders, as an empty span carrying nothing, which is the whole feature
		// silently doing nothing on the one surface it is enabled for.
		const { remarkPlugins, rehypePlugins } = buildMarkdownPlugins({
			codexDirectives: true,
			allowRawHtml: true,
		});
		const tree = transform(
			'- :codex-followup[Label]{prompt="Do the thing"}',
			remarkPlugins,
			rehypePlugins
		);

		const [directive] = directives(tree);
		expect(directive?.label).toBe('Label');
		expect(directive?.attributes).toEqual({ prompt: 'Do the thing' });
	});

	it('does nothing when the option is off, and everything when it is on', () => {
		const markdown = '- :codex-followup[Label]{prompt="Do the thing"}';

		const off = buildMarkdownPlugins({});
		expect(directives(transform(markdown, off.remarkPlugins, off.rehypePlugins))).toHaveLength(0);

		// The other half of the same assertion: without it, an option that never
		// reaches the plugin list would still pass the check above.
		const on = buildMarkdownPlugins({ codexDirectives: true });
		expect(directives(transform(markdown, on.remarkPlugins, on.rehypePlugins))).toHaveLength(1);
	});
});
