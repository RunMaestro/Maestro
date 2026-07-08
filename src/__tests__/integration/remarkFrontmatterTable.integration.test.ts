import { describe, expect, it } from 'vitest';
import type { Root } from 'mdast';
import remarkFrontmatterTable, {
	remarkFrontmatterTable as createRemarkFrontmatterTable,
} from '../../renderer/utils/remarkFrontmatterTable';

function transform(tree: Root): Root {
	const plugin = createRemarkFrontmatterTable();
	plugin(tree);
	return tree;
}

describe('remarkFrontmatterTable', () => {
	it('exports the plugin as the default export', () => {
		expect(remarkFrontmatterTable).toBe(createRemarkFrontmatterTable);
	});

	it('transforms YAML frontmatter into a metadata marker and GFM table', () => {
		const tree = transform({
			type: 'root',
			children: [
				{
					type: 'yaml',
					value: `
# comment
title: "Launch Plan"
owner: 'Maestro'
share_note_link: https://example.com/shared-note
empty:
`,
				} as any,
				{
					type: 'paragraph',
					children: [{ type: 'text', value: 'Body' }],
				},
			],
		});

		expect(tree.children).toHaveLength(3);
		expect(tree.children[0]).toEqual({
			type: 'paragraph',
			children: [
				{
					type: 'emphasis',
					children: [{ type: 'text', value: 'Document metadata:' }],
				},
			],
		});
		expect(tree.children[1]).toMatchObject({
			type: 'table',
			align: ['left', 'left'],
			children: [
				{
					type: 'tableRow',
					children: [
						{ type: 'tableCell', children: [{ type: 'strong' }] },
						{ type: 'tableCell', children: [{ type: 'text', value: 'Launch Plan' }] },
					],
				},
				{
					type: 'tableRow',
					children: [
						{ type: 'tableCell', children: [{ type: 'strong' }] },
						{ type: 'tableCell', children: [{ type: 'text', value: 'Maestro' }] },
					],
				},
				{
					type: 'tableRow',
					children: [
						{ type: 'tableCell', children: [{ type: 'strong' }] },
						{
							type: 'tableCell',
							children: [
								{
									type: 'link',
									url: 'https://example.com/shared-note',
									title: 'https://example.com/shared-note',
									children: [{ type: 'text', value: 'https://example.com/shared-note' }],
								},
							],
						},
					],
				},
				{
					type: 'tableRow',
					children: [
						{ type: 'tableCell', children: [{ type: 'strong' }] },
						{ type: 'tableCell', children: [{ type: 'text', value: '' }] },
					],
				},
			],
		});
		expect(tree.children[2]).toMatchObject({
			type: 'paragraph',
			children: [{ type: 'text', value: 'Body' }],
		});
	});

	it('truncates long URLs for display while preserving the full href', () => {
		const longUrl = `https://example.com/${'a'.repeat(80)}`;
		const tree = transform({
			type: 'root',
			children: [{ type: 'yaml', value: `link: ${longUrl}` } as any],
		});

		const table = tree.children[1] as any;
		const link = table.children[0].children[1].children[0];

		expect(link).toMatchObject({
			type: 'link',
			url: longUrl,
			title: longUrl,
			children: [{ type: 'text', value: `${longUrl.substring(0, 47)}...` }],
		});
	});

	it('removes YAML nodes that contain no valid key-value entries', () => {
		const tree = transform({
			type: 'root',
			children: [
				{ type: 'yaml', value: '# only comments\n\n!negated' } as any,
				{ type: 'paragraph', children: [{ type: 'text', value: 'Body' }] },
			],
		});

		expect(tree.children).toEqual([
			{ type: 'paragraph', children: [{ type: 'text', value: 'Body' }] },
		]);
	});

	it('ignores malformed YAML nodes without a parent index', () => {
		const malformedTree = {
			type: 'yaml',
			value: 'title: Orphaned',
		} as unknown as Root;

		expect(() => transform(malformedTree)).not.toThrow();
		expect(malformedTree).toEqual({
			type: 'yaml',
			value: 'title: Orphaned',
		});
	});
});
