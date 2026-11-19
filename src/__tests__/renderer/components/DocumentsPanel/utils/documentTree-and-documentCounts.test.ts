// Source: src/__tests__/renderer/components/DocumentsPanel/utils/documentTree.test.ts
// Source: src/__tests__/renderer/components/DocumentsPanel/utils/documentCounts.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { getFilesInNode } from '../../../../../renderer/components/DocumentsPanel/utils/documentTree';
import { getFolderTaskCount } from '../../../../../renderer/components/DocumentsPanel/utils/documentTree';
import { isFolderFullySelected } from '../../../../../renderer/components/DocumentsPanel/utils/documentTree';
import { isFolderPartiallySelected } from '../../../../../renderer/components/DocumentsPanel/utils/documentTree';
import type { DocTreeNode } from '../../../../../renderer/components/DocumentsPanel';
import { canDisableReset } from '../../../../../renderer/components/DocumentsPanel/utils/documentCounts';
import { getAllDocumentsTaskCount } from '../../../../../renderer/components/DocumentsPanel/utils/documentCounts';
import { getDocumentTaskCount } from '../../../../../renderer/components/DocumentsPanel/utils/documentCounts';
import { getMissingDocumentCount } from '../../../../../renderer/components/DocumentsPanel/utils/documentCounts';
import { getSelectedTaskCount } from '../../../../../renderer/components/DocumentsPanel/utils/documentCounts';
import { getTotalDocumentTaskCount } from '../../../../../renderer/components/DocumentsPanel/utils/documentCounts';
import { hasDuplicateFilename } from '../../../../../renderer/components/DocumentsPanel/utils/documentCounts';
import type { BatchDocumentEntry } from '../../../../../renderer/types';
describeSourceSuite('documentTree', () => {
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
});
describeSourceSuite('documentCounts', () => {
	const docs: BatchDocumentEntry[] = [
		{ id: '1', filename: 'alpha', resetOnCompletion: false },
		{ id: '2', filename: 'beta', resetOnCompletion: true },
		{ id: '3', filename: 'missing', resetOnCompletion: false, isMissing: true },
		{ id: '4', filename: 'beta', resetOnCompletion: true, isDuplicate: true },
	];

	describe('DocumentsPanel documentCounts utils', () => {
		it('returns zero for missing task-count entries', () => {
			expect(getDocumentTaskCount({ alpha: 2 }, 'none')).toBe(0);
		});

		it('sums selected documents by filename', () => {
			expect(getSelectedTaskCount(new Set(['alpha', 'beta']), { alpha: 2, beta: 4 })).toBe(6);
		});

		it('sums all available document task counts without selected-list missing docs', () => {
			expect(getTotalDocumentTaskCount(docs, { alpha: 2, beta: 4, missing: 99 })).toBe(10);
		});

		it('sums the selector document list', () => {
			expect(getAllDocumentsTaskCount(['alpha', 'gamma'], { alpha: 2, gamma: 7 })).toBe(9);
		});

		it('counts missing docs and duplicate filenames', () => {
			expect(getMissingDocumentCount(docs)).toBe(1);
			expect(hasDuplicateFilename(docs, 'beta')).toBe(true);
			expect(hasDuplicateFilename(docs, 'alpha')).toBe(false);
		});

		it('only allows reset disable when no duplicate filename exists', () => {
			expect(canDisableReset(docs, 'alpha')).toBe(true);
			expect(canDisableReset(docs, 'beta')).toBe(false);
		});
	});
});
