// Source: src/__tests__/renderer/components/Markdown/remarkDataviewCell.test.ts
// Source: src/__tests__/renderer/components/Markdown/remarkAlert.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { remarkDataviewWikiLinks } from '../../../../renderer/components/Markdown/remarkDataviewCell';
import { remarkUnwrapSoleParagraph } from '../../../../renderer/components/Markdown/remarkDataviewCell';
import { remarkAlert } from '../../../../renderer/components/Markdown/remarkAlert';
import { alertTypeFromClassName } from '../../../../renderer/components/Markdown/remarkAlert';
describeSourceSuite('remarkDataviewCell', () => {
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
});
describeSourceSuite('remarkAlert', () => {
	// Build the mdast shape remark produces for `> [!TYPE]\n> body`: a blockquote
	// whose first paragraph's first child is a text node holding the marker and the
	// body separated by a newline (remark-breaks runs later).
	function blockquote(text: string) {
		return {
			type: 'root',
			children: [
				{
					type: 'blockquote',
					children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
				},
			],
		} as any;
	}

	function runAlert(tree: any) {
		remarkAlert()(tree);
		return tree.children[0];
	}

	describe('remarkAlert', () => {
		it('tags a [!NOTE] blockquote with the alert classes and strips the marker', () => {
			const bq = runAlert(blockquote('[!NOTE]\nBody text here.'));
			expect(bq.data?.hProperties?.className).toEqual(['markdown-alert', 'markdown-alert-note']);
			// Marker removed; body preserved.
			expect(bq.children[0].children[0].value).toBe('Body text here.');
		});

		it('recognizes all five alert types case-insensitively', () => {
			const types = [
				['[!TIP]\nx', 'tip'],
				['[!IMPORTANT]\nx', 'important'],
				['[!WARNING]\nx', 'warning'],
				['[!CAUTION]\nx', 'caution'],
				['[!note]\nx', 'note'], // lowercase marker still matches
			] as const;
			for (const [text, expected] of types) {
				const bq = runAlert(blockquote(text));
				expect(bq.data?.hProperties?.className).toEqual([
					'markdown-alert',
					`markdown-alert-${expected}`,
				]);
			}
		});

		it('leaves an ordinary blockquote untouched', () => {
			const bq = runAlert(blockquote('just a normal quote\nsecond line'));
			expect(bq.data).toBeUndefined();
			expect(bq.children[0].children[0].value).toBe('just a normal quote\nsecond line');
		});

		it('does NOT convert a marker with a trailing inline title (matches GitHub)', () => {
			const bq = runAlert(blockquote('[!WARNING] danger title\nbody'));
			expect(bq.data).toBeUndefined();
			expect(bq.children[0].children[0].value).toBe('[!WARNING] danger title\nbody');
		});

		it('drops the empty paragraph for a marker-only blockquote (no blank first line)', () => {
			const bq = runAlert(blockquote('[!CAUTION]'));
			expect(bq.data?.hProperties?.className).toEqual(['markdown-alert', 'markdown-alert-caution']);
			expect(bq.children.length).toBe(0);
		});

		it('ignores an unknown bracket marker', () => {
			const bq = runAlert(blockquote('[!INFO]\nnot a real type'));
			expect(bq.data).toBeUndefined();
		});
	});

	describe('alertTypeFromClassName', () => {
		it('extracts the type from an array className', () => {
			expect(alertTypeFromClassName(['markdown-alert', 'markdown-alert-warning'])).toBe('warning');
		});

		it('extracts the type from a space-joined string className', () => {
			expect(alertTypeFromClassName('markdown-alert markdown-alert-tip')).toBe('tip');
		});

		it('returns null for a non-alert className or nullish input', () => {
			expect(alertTypeFromClassName('prose text-sm')).toBeNull();
			expect(alertTypeFromClassName(undefined)).toBeNull();
			expect(alertTypeFromClassName(null)).toBeNull();
		});
	});
});
