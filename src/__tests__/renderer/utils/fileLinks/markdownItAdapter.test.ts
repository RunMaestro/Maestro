import { describe, it, expect } from 'vitest';
import MarkdownIt from 'markdown-it';
import { applyFileLinks } from '../../../../renderer/utils/fileLinks/markdownItAdapter';
import {
	buildFileTreeIndices,
	type FileTreeIndices,
} from '../../../../renderer/utils/fileLinks/matcher';
import type { FileNode } from '../../../../renderer/types/fileTree';

function indicesFor(paths: string[]): FileTreeIndices {
	const root: FileNode[] = [];
	for (const p of paths) {
		const parts = p.split('/');
		let cursor = root;
		for (let i = 0; i < parts.length; i++) {
			const seg = parts[i];
			const isLast = i === parts.length - 1;
			let node = cursor.find((n) => n.name === seg);
			if (!node) {
				node = {
					name: seg,
					type: isLast ? 'file' : 'folder',
					children: isLast ? undefined : [],
				};
				cursor.push(node);
			}
			if (!isLast) {
				cursor = node.children ?? (node.children = []);
			}
		}
	}
	return buildFileTreeIndices(root);
}

function render(source: string, opts: { indices?: FileTreeIndices; cwd?: string } = {}): string {
	const md = new MarkdownIt({ html: true, linkify: true });
	const tokens = md.parse(source, {});
	applyFileLinks(md, tokens, {
		indices: opts.indices,
		cwd: opts.cwd ?? '',
	});
	return md.renderer.render(tokens, md.options, {});
}

describe('applyFileLinks - standard markdown link rewriting', () => {
	it('rewrites a relative href that resolves in the tree', () => {
		const indices = indicesFor(['docs/Notes.md']);
		const html = render('[click](docs/Notes.md)', { indices });
		expect(html).toContain('href="maestro-file://docs/Notes.md"');
		expect(html).toContain('data-maestro-file="docs/Notes.md"');
	});

	it('leaves external https links untouched', () => {
		const html = render('[ext](https://example.com)');
		expect(html).toContain('href="https://example.com"');
		expect(html).not.toContain('maestro-file://');
	});

	it('leaves mailto / tel URIs untouched', () => {
		// (markdown-it's default validateLink rejects file:// links so they
		// never become anchor tokens - no rewrite path to assert against.)
		expect(render('[m](mailto:a@b.com)')).toContain('href="mailto:a@b.com"');
		expect(render('[t](tel:+1234)')).toContain('href="tel:+1234"');
	});

	it('leaves bare anchor links untouched', () => {
		const html = render('[anchor](#section)');
		expect(html).toContain('href="#section"');
		expect(html).not.toContain('maestro-file://');
	});

	it('does not rewrite a relative href that does not resolve', () => {
		const indices = indicesFor(['docs/Notes.md']);
		const html = render('[broken](does/not/exist.md)', { indices });
		expect(html).not.toContain('maestro-file://');
		expect(html).toContain('href="does/not/exist.md"');
	});

	it('decodes URL-encoded paths before resolving', () => {
		const indices = indicesFor(['docs/My Note.md']);
		const html = render('[doc](docs/My%20Note.md)', { indices });
		expect(html).toContain('maestro-file://docs/My Note.md');
	});

	it('does not rewrite already-rewritten maestro-file:// hrefs', () => {
		const html = render('[doc](maestro-file://docs/Notes.md)');
		expect(html).toContain('href="maestro-file://docs/Notes.md"');
	});
});

describe('applyFileLinks - wiki-style [[references]]', () => {
	it('resolves [[Note]] to its full path when unique', () => {
		const indices = indicesFor(['notes/Hello.md']);
		const html = render('See [[Hello]] for context.', { indices });
		expect(html).toContain('href="maestro-file://notes/Hello.md"');
		expect(html).toContain('>Hello</a>');
	});

	it('honors the |alias suffix for display text', () => {
		const indices = indicesFor(['notes/Hello World.md']);
		const html = render('See [[Hello World|the intro]] for context.', { indices });
		expect(html).toContain('maestro-file://notes/Hello World.md');
		expect(html).toContain('>the intro</a>');
	});

	it('leaves unresolved wiki references as plain text', () => {
		const indices = indicesFor(['notes/Hello.md']);
		const html = render('[[Missing]] should not link.', { indices });
		expect(html).toContain('[[Missing]]');
		expect(html).not.toContain('maestro-file://');
	});

	it('disambiguates duplicate basenames using cwd proximity', () => {
		const indices = indicesFor(['a/README.md', 'b/README.md']);
		const html = render('Read [[README]].', { indices, cwd: 'b' });
		expect(html).toContain('maestro-file://b/README.md');
		expect(html).not.toContain('maestro-file://a/README.md');
	});

	it('does not double-process when the same wiki link appears in two paragraphs', () => {
		const indices = indicesFor(['notes/Hello.md']);
		const html = render('[[Hello]] in para 1.\n\n[[Hello]] in para 2.', { indices });
		const matches = html.match(/maestro-file:\/\/notes\/Hello\.md/g) || [];
		expect(matches.length).toBe(2);
	});
});

describe('applyFileLinks - ![[image]] embeds', () => {
	it('rewrites image embeds to <img> tokens pointing at the resolved path', () => {
		const indices = indicesFor(['assets/diagram.png']);
		const html = render('See ![[diagram.png]] below.', { indices });
		expect(html).toContain('src="maestro-file://assets/diagram.png"');
	});

	it('preserves the width suffix when present', () => {
		const indices = indicesFor(['assets/wide.png']);
		const html = render('![[wide.png|420]]', { indices });
		expect(html).toContain('src="maestro-file://assets/wide.png"');
		expect(html).toContain('width="420"');
	});

	it('falls back to _attachments/<file> when the image is not in the tree', () => {
		const indices = indicesFor([]);
		const html = render('![[orphan.png]]', { indices });
		expect(html).toContain('src="maestro-file://_attachments/orphan.png"');
	});

	it('uses the bare filename as the alt text', () => {
		const indices = indicesFor(['assets/x.png']);
		const html = render('![[x.png]]', { indices });
		expect(html).toMatch(/alt="x\.png"/);
	});

	it('image embeds prevent the contained [[…]] from also matching as a wiki link', () => {
		const indices = indicesFor(['notes/x.png']);
		const html = render('![[x.png]]', { indices });
		// Should be exactly one src and no <a> link
		expect((html.match(/<img/g) || []).length).toBe(1);
		expect(html).not.toContain('<a ');
	});
});

describe('applyFileLinks - plain path references in running text', () => {
	it('rewrites a path-style reference when the path exists', () => {
		const indices = indicesFor(['src/utils/helpers.ts']);
		const html = render('See src/utils/helpers.ts.', { indices });
		expect(html).toContain('maestro-file://src/utils/helpers.ts');
	});

	it('does not rewrite a path-style reference that does not exist', () => {
		const indices = indicesFor(['src/utils/helpers.ts']);
		const html = render('See src/nope/missing.ts.', { indices });
		expect(html).not.toContain('maestro-file://');
	});

	it('does not rewrite single-word identifiers', () => {
		const indices = indicesFor(['x.md']);
		const html = render('Just word here.', { indices });
		expect(html).not.toContain('maestro-file://');
	});
});

describe('applyFileLinks - bare maestro:// deep links', () => {
	it('auto-linkifies a bare maestro:// URL in running text', () => {
		const html = render('See maestro://session/abc/tab/xyz now.');
		expect(html).toContain('href="maestro://session/abc/tab/xyz"');
		expect(html).toContain('>maestro://session/abc/tab/xyz</a>');
	});

	it('does not rewrite an existing markdown link with a maestro:// href', () => {
		const html = render('[label](maestro://group/grp1)');
		// Should leave the href unchanged (not turned into maestro-file://)
		expect(html).toContain('href="maestro://group/grp1"');
		expect(html).not.toContain('maestro-file://');
	});
});

describe('applyFileLinks - edge cases', () => {
	it('is safe to call with no fileLinks options at all', () => {
		const md = new MarkdownIt({ html: true });
		const tokens = md.parse('[a](b.md) and [[c]]', {});
		expect(() => applyFileLinks(md, tokens, {})).not.toThrow();
	});

	it('is a no-op when indices are empty', () => {
		const html = render('[a](docs/x.md) and [[y]]', { indices: indicesFor([]) });
		expect(html).not.toContain('maestro-file://');
	});

	it('does not mutate the token stream when no patterns match', () => {
		const md = new MarkdownIt({ html: true });
		const before = md.parse('just words', {});
		const cloned = JSON.parse(JSON.stringify(before, (k, v) => (k === 'meta' ? null : v)));
		applyFileLinks(md, before, { indices: indicesFor(['x.md']) });
		const after = JSON.parse(JSON.stringify(before, (k, v) => (k === 'meta' ? null : v)));
		expect(after).toEqual(cloned);
	});
});
