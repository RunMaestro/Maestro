import { describe, it, expect } from 'vitest';
import {
	remarkDataviewWikiLinks,
	remarkUnwrapSoleParagraph,
} from '../../../../renderer/components/Markdown/remarkDataviewCell';

function paragraph(...children: any[]) {
	return { type: 'paragraph', children };
}

function text(value: string) {
	return { type: 'text', value };
}

function root(...children: any[]) {
	return { type: 'root', children };
}

describe('remarkDataviewWikiLinks', () => {
	it('turns wiki links into maestro-file links that carry the raw target', () => {
		const tree: any = root(paragraph(text('Met [[Grace|Grace H]] and [[People/Alan]].')));
		remarkDataviewWikiLinks()(tree);

		const children = tree.children[0].children;
		expect(children.map((node: any) => node.type)).toEqual([
			'text',
			'link',
			'text',
			'link',
			'text',
		]);
		expect(children[1]).toMatchObject({
			url: 'maestro-file://Grace',
			data: { hProperties: { 'data-maestro-file': 'Grace' } },
			children: [{ type: 'text', value: 'Grace H' }],
		});
		expect(children[3].children[0].value).toBe('People/Alan');
		expect(children[4].value).toBe('.');
	});

	it('links an embed to its file, dropping the bang', () => {
		const tree: any = root(paragraph(text('see ![[diagram.png]]')));
		remarkDataviewWikiLinks()(tree);

		const children = tree.children[0].children;
		expect(children[0].value).toBe('see ');
		expect(children[1].url).toBe('maestro-file://diagram.png');
	});

	it('leaves text inside an existing link and text without links alone', () => {
		const link = { type: 'link', url: 'https://x', children: [text('[[not]]')] };
		const tree: any = root(paragraph(text('plain'), link));
		remarkDataviewWikiLinks()(tree);

		expect(tree.children[0].children).toEqual([text('plain'), link]);
	});
});

describe('remarkUnwrapSoleParagraph', () => {
	it('drops the paragraph around a one-paragraph string', () => {
		const tree: any = root(paragraph(text('inline')));
		remarkUnwrapSoleParagraph()(tree);
		expect(tree.children).toEqual([text('inline')]);
	});

	it('keeps block structure when there is more than one block', () => {
		const tree: any = root(paragraph(text('a')), paragraph(text('b')));
		remarkUnwrapSoleParagraph()(tree);
		expect(tree.children).toHaveLength(2);
	});
});
