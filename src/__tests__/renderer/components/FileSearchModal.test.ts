/**
 * @file FileSearchModal.test.ts
 * @description Tests for FileSearchModal's flattenPreviewableFiles helper
 *
 * Covers the visible-files-vs-all-files filtering logic:
 * - Full flattening (no expandedSet) returns all previewable files
 * - Expanded set filtering only returns files in expanded folders
 * - Non-previewable files are excluded in both modes
 * - Nested folder expansion requires all ancestor folders to be expanded
 */

import { describe, it, expect } from 'vitest';
import { flattenPreviewableFiles } from '../../../renderer/components/FileSearchModal';
import type { FileNode } from '../../../renderer/types/fileTree';

// Reusable test tree:
// src/
//   components/
//     App.tsx
//     Modal.tsx
//   utils/
//     helpers.ts
//   index.ts
// docs/
//   README.md
// package.json
// image.png
// binary.exe  (not previewable)
const testTree: FileNode[] = [
	{
		name: 'src',
		type: 'folder',
		children: [
			{
				name: 'components',
				type: 'folder',
				children: [
					{ name: 'App.tsx', type: 'file' },
					{ name: 'Modal.tsx', type: 'file' },
				],
			},
			{
				name: 'utils',
				type: 'folder',
				children: [{ name: 'helpers.ts', type: 'file' }],
			},
			{ name: 'index.ts', type: 'file' },
		],
	},
	{
		name: 'docs',
		type: 'folder',
		children: [{ name: 'README.md', type: 'file' }],
	},
	{ name: 'package.json', type: 'file' },
	{ name: 'image.png', type: 'file' },
	{ name: 'binary.exe', type: 'file' },
];

describe('flattenPreviewableFiles', () => {
	it('returns all previewable files when no expandedSet is provided', () => {
		const result = flattenPreviewableFiles(testTree);
		const paths = result.map((f) => f.fullPath);

		expect(paths).toContain('src/components/App.tsx');
		expect(paths).toContain('src/components/Modal.tsx');
		expect(paths).toContain('src/utils/helpers.ts');
		expect(paths).toContain('src/index.ts');
		expect(paths).toContain('docs/README.md');
		expect(paths).toContain('package.json');
		expect(paths).toContain('image.png');
		// binary.exe is not previewable
		expect(paths).not.toContain('binary.exe');
		expect(result).toHaveLength(7);
	});

	it('excludes non-previewable files', () => {
		const tree: FileNode[] = [
			{ name: 'readme.md', type: 'file' },
			{ name: 'program.exe', type: 'file' },
			{ name: 'data.bin', type: 'file' },
			{ name: 'archive.tar.gz', type: 'file' },
		];
		const result = flattenPreviewableFiles(tree);
		expect(result).toHaveLength(1);
		expect(result[0].fullPath).toBe('readme.md');
	});

	it('returns only files in expanded folders when expandedSet is provided', () => {
		// Only src is expanded (not its subfolders)
		const expandedSet = new Set(['src']);
		const result = flattenPreviewableFiles(testTree, '', 0, expandedSet);
		const paths = result.map((f) => f.fullPath);

		// src/index.ts is directly in src (expanded)
		expect(paths).toContain('src/index.ts');
		// src/components/ and src/utils/ are not expanded, so their children are excluded
		expect(paths).not.toContain('src/components/App.tsx');
		expect(paths).not.toContain('src/utils/helpers.ts');
		// docs/ is not expanded
		expect(paths).not.toContain('docs/README.md');
		// Root-level files are always included (not inside any folder)
		expect(paths).toContain('package.json');
		expect(paths).toContain('image.png');
	});

	it('includes nested files when all ancestor folders are expanded', () => {
		const expandedSet = new Set(['src', 'src/components']);
		const result = flattenPreviewableFiles(testTree, '', 0, expandedSet);
		const paths = result.map((f) => f.fullPath);

		expect(paths).toContain('src/index.ts');
		expect(paths).toContain('src/components/App.tsx');
		expect(paths).toContain('src/components/Modal.tsx');
		// src/utils is not expanded
		expect(paths).not.toContain('src/utils/helpers.ts');
		// docs/ is not expanded
		expect(paths).not.toContain('docs/README.md');
	});

	it('returns only root-level files when expandedSet is empty', () => {
		const expandedSet = new Set<string>();
		const result = flattenPreviewableFiles(testTree, '', 0, expandedSet);
		const paths = result.map((f) => f.fullPath);

		// Only root-level previewable files
		expect(paths).toEqual(['package.json', 'image.png']);
	});

	it('returns all files when every folder is expanded', () => {
		const expandedSet = new Set(['src', 'src/components', 'src/utils', 'docs']);
		const result = flattenPreviewableFiles(testTree, '', 0, expandedSet);
		const noExpand = flattenPreviewableFiles(testTree);

		// Should match the no-expandedSet result
		expect(result.length).toBe(noExpand.length);
		expect(result.map((f) => f.fullPath).sort()).toEqual(noExpand.map((f) => f.fullPath).sort());
	});

	it('sets correct depth values', () => {
		const result = flattenPreviewableFiles(testTree);
		const appFile = result.find((f) => f.fullPath === 'src/components/App.tsx');
		const indexFile = result.find((f) => f.fullPath === 'src/index.ts');
		const rootFile = result.find((f) => f.fullPath === 'package.json');

		expect(rootFile?.depth).toBe(0);
		expect(indexFile?.depth).toBe(1);
		expect(appFile?.depth).toBe(2);
	});
});
