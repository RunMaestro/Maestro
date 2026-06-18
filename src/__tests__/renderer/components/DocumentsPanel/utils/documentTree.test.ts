import { describe, expect, it } from 'vitest';
import {
	getFilesInNode,
	getFolderTaskCount,
	isFolderFullySelected,
	isFolderPartiallySelected,
} from '../../../../../renderer/components/DocumentsPanel/utils/documentTree';
import type { DocTreeNode } from '../../../../../renderer/components/DocumentsPanel';

const tree: DocTreeNode = {
	name: 'docs',
	type: 'folder',
	path: 'docs',
	children: [
		{ name: 'setup', type: 'file', path: 'docs/setup' },
		{
			name: 'nested',
			type: 'folder',
			path: 'docs/nested',
			children: [{ name: 'ship', type: 'file', path: 'custom/path/ship' }],
		},
	],
};

describe('DocumentsPanel documentTree utils', () => {
	it('collects files using node.path, including custom file paths', () => {
		expect(getFilesInNode(tree)).toEqual(['docs/setup', 'custom/path/ship']);
	});

	it('returns one path for a file node', () => {
		expect(getFilesInNode({ name: 'readme', type: 'file', path: 'readme' })).toEqual(['readme']);
	});

	it('reports full and partial folder selection', () => {
		expect(isFolderFullySelected(tree, new Set(['docs/setup', 'custom/path/ship']))).toBe(true);
		expect(isFolderPartiallySelected(tree, new Set(['docs/setup']))).toBe(true);
		expect(isFolderFullySelected(tree, new Set(['docs/setup']))).toBe(false);
	});

	it('does not treat empty folders as fully or partially selected', () => {
		const empty: DocTreeNode = { name: 'empty', type: 'folder', path: 'empty', children: [] };
		expect(isFolderFullySelected(empty, new Set(['empty']))).toBe(false);
		expect(isFolderPartiallySelected(empty, new Set(['empty']))).toBe(false);
	});

	it('sums task counts for files under a folder', () => {
		expect(getFolderTaskCount(tree, { 'docs/setup': 2, 'custom/path/ship': 3 })).toBe(5);
	});
});
