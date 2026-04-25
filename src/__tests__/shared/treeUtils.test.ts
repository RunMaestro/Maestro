/**
 * Tests for shared tree traversal utilities
 */

import {
	TreeNode,
	walkTreePartitioned,
	getAllFilePaths,
	getAllFolderPaths,
	buildFileIndex,
} from '../../shared/treeUtils';

describe('treeUtils', () => {
	// Sample tree structure for tests
	const sampleTree: TreeNode[] = [
		{
			name: 'src',
			type: 'folder',
			children: [
				{ name: 'index.ts', type: 'file' },
				{ name: 'utils.ts', type: 'file' },
				{
					name: 'components',
					type: 'folder',
					children: [
						{ name: 'Button.tsx', type: 'file' },
						{ name: 'Modal.tsx', type: 'file' },
					],
				},
			],
		},
		{ name: 'README.md', type: 'file' },
		{ name: 'package.json', type: 'file' },
		{
			name: 'docs',
			type: 'folder',
			children: [{ name: 'guide.md', type: 'file' }],
		},
	];

	describe('walkTreePartitioned', () => {
		it('returns empty sets for empty tree', () => {
			const result = walkTreePartitioned([]);
			expect(result.files.size).toBe(0);
			expect(result.folders.size).toBe(0);
		});

		it('separates files and folders correctly', () => {
			const result = walkTreePartitioned(sampleTree);

			// Check files
			expect(result.files.has('src/index.ts')).toBe(true);
			expect(result.files.has('src/utils.ts')).toBe(true);
			expect(result.files.has('src/components/Button.tsx')).toBe(true);
			expect(result.files.has('README.md')).toBe(true);
			expect(result.files.size).toBe(7);

			// Check folders
			expect(result.folders.has('src')).toBe(true);
			expect(result.folders.has('src/components')).toBe(true);
			expect(result.folders.has('docs')).toBe(true);
			expect(result.folders.size).toBe(3);
		});

		it('respects basePath', () => {
			const result = walkTreePartitioned(sampleTree, 'root');
			expect(result.files.has('root/src/index.ts')).toBe(true);
			expect(result.folders.has('root/src')).toBe(true);
		});

		it('files and folders are mutually exclusive', () => {
			const result = walkTreePartitioned(sampleTree);

			// No path should be in both sets
			for (const path of result.files) {
				expect(result.folders.has(path)).toBe(false);
			}
			for (const path of result.folders) {
				expect(result.files.has(path)).toBe(false);
			}
		});
	});

	describe('getAllFilePaths', () => {
		it('returns empty array for empty tree', () => {
			expect(getAllFilePaths([])).toEqual([]);
		});

		it('returns all file paths in order', () => {
			const result = getAllFilePaths(sampleTree);
			expect(result).toEqual([
				'src/index.ts',
				'src/utils.ts',
				'src/components/Button.tsx',
				'src/components/Modal.tsx',
				'README.md',
				'package.json',
				'docs/guide.md',
			]);
		});

		it('respects basePath', () => {
			const result = getAllFilePaths(sampleTree, 'prefix');
			expect(result[0]).toBe('prefix/src/index.ts');
		});

		it('excludes folders', () => {
			const result = getAllFilePaths(sampleTree);
			expect(result).not.toContain('src');
			expect(result).not.toContain('src/components');
			expect(result).not.toContain('docs');
		});
	});

	describe('getAllFolderPaths', () => {
		it('returns empty array for empty tree', () => {
			expect(getAllFolderPaths([])).toEqual([]);
		});

		it('returns all folder paths in order', () => {
			const result = getAllFolderPaths(sampleTree);
			expect(result).toEqual(['src', 'src/components', 'docs']);
		});

		it('respects basePath', () => {
			const result = getAllFolderPaths(sampleTree, 'prefix');
			expect(result[0]).toBe('prefix/src');
		});

		it('excludes files', () => {
			const result = getAllFolderPaths(sampleTree);
			expect(result).not.toContain('README.md');
			expect(result).not.toContain('src/index.ts');
		});

		it('returns empty array for tree with only files', () => {
			const flatTree: TreeNode[] = [
				{ name: 'file1.txt', type: 'file' },
				{ name: 'file2.txt', type: 'file' },
			];
			expect(getAllFolderPaths(flatTree)).toEqual([]);
		});
	});

	describe('buildFileIndex', () => {
		it('returns empty array for empty tree', () => {
			expect(buildFileIndex([])).toEqual([]);
		});

		it('returns entries with relativePath and filename', () => {
			const result = buildFileIndex(sampleTree);

			const indexEntry = result.find((e) => e.filename === 'index.ts');
			expect(indexEntry).toEqual({
				relativePath: 'src/index.ts',
				filename: 'index.ts',
			});

			const buttonEntry = result.find((e) => e.filename === 'Button.tsx');
			expect(buttonEntry).toEqual({
				relativePath: 'src/components/Button.tsx',
				filename: 'Button.tsx',
			});
		});

		it('respects basePath', () => {
			const result = buildFileIndex(sampleTree, 'project');
			const indexEntry = result.find((e) => e.filename === 'index.ts');
			expect(indexEntry?.relativePath).toBe('project/src/index.ts');
		});

		it('excludes folders', () => {
			const result = buildFileIndex(sampleTree);
			const folderEntry = result.find((e) => e.filename === 'src');
			expect(folderEntry).toBeUndefined();
		});

		it('can be used to build lookup sets', () => {
			const entries = buildFileIndex(sampleTree);
			const allPaths = new Set(entries.map((e) => e.relativePath));

			expect(allPaths.has('src/index.ts')).toBe(true);
			expect(allPaths.has('README.md')).toBe(true);
			expect(allPaths.has('src')).toBe(false); // folders not included
		});

		it('handles files with same name in different folders', () => {
			const tree: TreeNode[] = [
				{
					name: 'a',
					type: 'folder',
					children: [{ name: 'index.ts', type: 'file' }],
				},
				{
					name: 'b',
					type: 'folder',
					children: [{ name: 'index.ts', type: 'file' }],
				},
			];
			const result = buildFileIndex(tree);

			expect(result.length).toBe(2);
			expect(result.filter((e) => e.filename === 'index.ts').length).toBe(2);

			const paths = result.map((e) => e.relativePath);
			expect(paths).toContain('a/index.ts');
			expect(paths).toContain('b/index.ts');
		});
	});

	describe('generic type support', () => {
		interface ExtendedNode extends TreeNode {
			size?: number;
			lastModified?: Date;
		}

		it('getAllFilePaths works with extended node types', () => {
			const extTree: ExtendedNode[] = [{ name: 'file.txt', type: 'file', size: 1024 }];
			const result = getAllFilePaths<ExtendedNode>(extTree);
			expect(result).toEqual(['file.txt']);
		});
	});
});
