import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, Image } from 'mdast';
import { visit } from 'unist-util-visit';
import { remarkWindowsImagePaths } from '../../../../renderer/components/Markdown/remarkWindowsImagePaths';
import { Markdown } from '../../../../renderer/components/Markdown/Markdown';
import { mockTheme } from '../../../helpers/mockTheme';

function imageUrls(markdown: string): string[] {
	const processor = unified().use(remarkParse).use(remarkWindowsImagePaths);
	const tree = processor.runSync(processor.parse(markdown)) as Root;
	const urls: string[] = [];
	visit(tree, 'image', (node: Image) => {
		urls.push(node.url);
	});
	return urls;
}

describe('remarkWindowsImagePaths', () => {
	it('rewrites a forward-slash drive path to a file:/// URL', () => {
		expect(imageUrls('![p](D:/work/shots/a.png)')).toEqual(['file:///D:/work/shots/a.png']);
	});

	it('rewrites a backslash drive path with forward slashes', () => {
		expect(imageUrls('![p](<C:\\Users\\me\\a.png>)')).toEqual(['file:///C:/Users/me/a.png']);
	});

	it('leaves POSIX paths, file URLs, and web URLs alone', () => {
		expect(
			imageUrls('![a](/Users/me/a.png) ![b](file:///D:/a.png) ![c](https://example.com/c.png)')
		).toEqual(['/Users/me/a.png', 'file:///D:/a.png', 'https://example.com/c.png']);
	});

	it('turns a reference image with a drive path into an inline image', () => {
		expect(imageUrls('![p][shot]\n\n[shot]: D:/work/a.png "Shot"')).toEqual([
			'file:///D:/work/a.png',
		]);
	});

	it('keeps the shared definition for a link that uses it', () => {
		const processor = unified().use(remarkParse).use(remarkWindowsImagePaths);
		const tree = processor.runSync(
			processor.parse('![p][shot] [l][shot]\n\n[shot]: D:/work/a.png')
		) as Root;
		const definitionUrls: string[] = [];
		visit(tree, 'definition', (node: { url: string }) => {
			definitionUrls.push(node.url);
		});
		const linkRefs: string[] = [];
		visit(tree, 'linkReference', (node: { identifier: string }) => {
			linkRefs.push(node.identifier);
		});
		expect(definitionUrls).toEqual(['D:/work/a.png']);
		expect(linkRefs).toEqual(['shot']);
	});

	it('does not touch link destinations', () => {
		const processor = unified().use(remarkParse).use(remarkWindowsImagePaths);
		const tree = processor.runSync(processor.parse('[a](D:/work/a.png)')) as Root;
		const urls: string[] = [];
		visit(tree, 'link', (node: { url: string }) => {
			urls.push(node.url);
		});
		expect(urls).toEqual(['D:/work/a.png']);
	});
});

// End to end through the chat preset: both forms from #2067 must reach the
// IPC read as a plain drive path, past react-markdown's URL transform and
// rehype-sanitize.
describe('chat preset with a Windows image path (#2067)', () => {
	const readFile = vi.fn().mockResolvedValue('data:image/png;base64,iVBORw0KGgo=');

	beforeEach(() => {
		readFile.mockClear();
		(window as any).maestro.fs = { ...(window as any).maestro.fs, readFile };
	});

	it.each([
		// Distinct files: LocalImage caches by path, so a shared one would skip the read.
		['a bare drive path', '![preview](D:/work/project/screenshots/a.png)', 'a.png'],
		['a file:/// URL', '![preview](file:///D:/work/project/screenshots/b.png)', 'b.png'],
		['a reference image', '![preview][shot]\n\n[shot]: D:/work/project/screenshots/c.png', 'c.png'],
	])('loads the image for %s', async (_label, content, file) => {
		const { container } = render(<Markdown preset="chat" content={content} theme={mockTheme} />);
		await waitFor(() =>
			expect(readFile).toHaveBeenCalledWith(`D:/work/project/screenshots/${file}`, undefined)
		);
		await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
	});
});
