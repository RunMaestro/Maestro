/**
 * Tests for shared tree traversal utilities
 */

import {
	TreeNode,
	walkTree,
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

	describe('walkTree', () => {
		it('returns empty array for empty tree', () => {
			const result = walkTree([], {
				onFile: (_, path) => path,
			});
			expect(result).toEqual([]);
		});

		it('collects all file paths', () => {
			const result = walkTree(sampleTree, {
				onFile: (_, path) => path,
			});
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

		it('collects all folder paths', () => {
			const result = walkTree(sampleTree, {
				onFolder: (_, path) => path,
			});
			expect(result).toEqual(['src', 'src/components', 'docs']);
		});

		it('collects both files and folders', () => {
			const result = walkTree(sampleTree, {
				onFile: (_, path) => ({ type: 'file', path }),
				onFolder: (_, path) => ({ type: 'folder', path }),
			});
			expect(result).toEqual([
				{ type: 'folder', path: 'src' },
				{ type: 'file', path: 'src/index.ts' },
				{ type: 'file', path: 'src/utils.ts' },
				{ type: 'folder', path: 'src/components' },
				{ type: 'file', path: 'src/components/Button.tsx' },
				{ type: 'file', path: 'src/components/Modal.tsx' },
				{ type: 'file', path: 'README.md' },
				{ type: 'file', path: 'package.json' },
				{ type: 'folder', path: 'docs' },
				{ type: 'file', path: 'docs/guide.md' },
			]);
		});

		it('respects basePath option', () => {
			const result = walkTree(sampleTree, {
				basePath: 'project',
				onFile: (_, path) => path,
			});
			expect(result).toContain('project/src/index.ts');
			expect(result).toContain('project/README.md');
		});

		it('filters undefined results', () => {
			const result = walkTree(sampleTree, {
				onFile: (node, path) => (node.name.endsWith('.tsx') ? path : undefined),
			});
			expect(result).toEqual(['src/components/Button.tsx', 'src/components/Modal.tsx']);
		});

		it('handles folders without children', () => {
			const tree: TreeNode[] = [
				{ name: 'empty-folder', type: 'folder' },
				{ name: 'file.txt', type: 'file' },
			];
			const result = walkTree(tree, {
				onFile: (_, path) => path,
				onFolder: (_, path) => path,
			});
			expect(result).toEqual(['empty-folder', 'file.txt']);
		});

		it('provides node to callback', () => {
			const fileNames: string[] = [];
			walkTree(sampleTree, {
				onFile: (node) => {
					fileNames.push(node.name);
				},
			});
			expect(fileNames).toContain('index.ts');
			expect(fileNames).toContain('Button.tsx');
			expect(fileNames).toContain('README.md');
		});

		it('handles deeply nested structures', () => {
			const deepTree: TreeNode[] = [
				{
					name: 'a',
					type: 'folder',
					children: [
						{
							name: 'b',
							type: 'folder',
							children: [
								{
									name: 'c',
									type: 'folder',
									children: [
										{
											name: 'd',
											type: 'folder',
											children: [{ name: 'deep.txt', type: 'file' }],
										},
									],
								},
							],
						},
					],
				},
			];
			const result = walkTree(deepTree, {
				onFile: (_, path) => path,
			});
			expect(result).toEqual(['a/b/c/d/deep.txt']);
		});

		it('handles tree with only files', () => {
			const flatTree: TreeNode[] = [
				{ name: 'file1.txt', type: 'file' },
				{ name: 'file2.txt', type: 'file' },
				{ name: 'file3.txt', type: 'file' },
			];
			const result = walkTree(flatTree, {
				onFile: (_, path) => path,
			});
			expect(result).toEqual(['file1.txt', 'file2.txt', 'file3.txt']);
		});

		it('handles tree with only folders', () => {
			const folderTree: TreeNode[] = [
				{ name: 'dir1', type: 'folder', children: [] },
				{ name: 'dir2', type: 'folder', children: [] },
			];
			const result = walkTree(folderTree, {
				onFolder: (_, path) => path,
			});
			expect(result).toEqual(['dir1', 'dir2']);
		});

		it('works with no callbacks', () => {
			const result = walkTree(sampleTree, {});
			expect(result).toEqual([]);
		});
	});

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

		it('walkTree works with extended node types', () => {
			const extTree: ExtendedNode[] = [
				{ name: 'file.txt', type: 'file', size: 1024 },
				{
					name: 'folder',
					type: 'folder',
					children: [{ name: 'nested.txt', type: 'file', size: 512 }],
				},
			];

			const result = walkTree<{ name: string; size?: number }, ExtendedNode>(extTree, {
				onFile: (node) => ({ name: node.name, size: node.size }),
			});

			expect(result).toEqual([
				{ name: 'file.txt', size: 1024 },
				{ name: 'nested.txt', size: 512 },
			]);
		});

		it('getAllFilePaths works with extended node types', () => {
			const extTree: ExtendedNode[] = [{ name: 'file.txt', type: 'file', size: 1024 }];
			const result = getAllFilePaths<ExtendedNode>(extTree);
			expect(result).toEqual(['file.txt']);
		});
	});
});
