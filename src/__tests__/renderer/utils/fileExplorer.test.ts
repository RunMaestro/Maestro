import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	shouldOpenExternally,
	loadFileTree,
	getAllFolderPaths,
	flattenTree,
	compareFileTrees,
	FileTreeNode,
} from '../../../renderer/utils/fileExplorer';

describe('fileExplorer utils', () => {
	// ============================================================================
	// shouldOpenExternally
	// ============================================================================
	describe('shouldOpenExternally', () => {
		describe('document files', () => {
			it('returns true for PDF files', () => {
				expect(shouldOpenExternally('report.pdf')).toBe(true);
				expect(shouldOpenExternally('document.PDF')).toBe(true);
			});

			it('returns true for Word documents', () => {
				expect(shouldOpenExternally('document.doc')).toBe(true);
				expect(shouldOpenExternally('document.docx')).toBe(true);
			});

			it('returns true for Excel spreadsheets', () => {
				expect(shouldOpenExternally('data.xls')).toBe(true);
				expect(shouldOpenExternally('data.xlsx')).toBe(true);
			});

			it('returns true for PowerPoint presentations', () => {
				expect(shouldOpenExternally('slides.ppt')).toBe(true);
				expect(shouldOpenExternally('slides.pptx')).toBe(true);
			});
		});

		describe('archive files', () => {
			it('returns true for zip files', () => {
				expect(shouldOpenExternally('archive.zip')).toBe(true);
			});

			it('returns true for tar files', () => {
				expect(shouldOpenExternally('archive.tar')).toBe(true);
			});

			it('returns true for gz files', () => {
				expect(shouldOpenExternally('archive.gz')).toBe(true);
			});

			it('returns true for rar files', () => {
				expect(shouldOpenExternally('archive.rar')).toBe(true);
			});

			it('returns true for 7z files', () => {
				expect(shouldOpenExternally('archive.7z')).toBe(true);
			});
		});

		describe('executable/installer files', () => {
			it('returns true for exe files', () => {
				expect(shouldOpenExternally('installer.exe')).toBe(true);
			});

			it('returns true for dmg files', () => {
				expect(shouldOpenExternally('installer.dmg')).toBe(true);
			});

			it('returns true for app files', () => {
				expect(shouldOpenExternally('MyApp.app')).toBe(true);
			});

			it('returns true for deb files', () => {
				expect(shouldOpenExternally('package.deb')).toBe(true);
			});

			it('returns true for rpm files', () => {
				expect(shouldOpenExternally('package.rpm')).toBe(true);
			});
		});

		describe('media files', () => {
			it('returns true for video files', () => {
				expect(shouldOpenExternally('video.mp4')).toBe(true);
				expect(shouldOpenExternally('video.avi')).toBe(true);
				expect(shouldOpenExternally('video.mov')).toBe(true);
				expect(shouldOpenExternally('video.mkv')).toBe(true);
			});

			it('returns true for audio files', () => {
				expect(shouldOpenExternally('audio.mp3')).toBe(true);
				expect(shouldOpenExternally('audio.wav')).toBe(true);
				expect(shouldOpenExternally('audio.flac')).toBe(true);
			});
		});

		describe('image files (previewable inline)', () => {
			it('returns false for PNG files (previewable)', () => {
				expect(shouldOpenExternally('image.png')).toBe(false);
				expect(shouldOpenExternally('screenshot.PNG')).toBe(false);
			});

			it('returns false for SVG files (previewable)', () => {
				expect(shouldOpenExternally('icon.svg')).toBe(false);
				expect(shouldOpenExternally('logo.SVG')).toBe(false);
			});

			it('returns false for JPEG files (previewable)', () => {
				expect(shouldOpenExternally('photo.jpg')).toBe(false);
				expect(shouldOpenExternally('photo.jpeg')).toBe(false);
				expect(shouldOpenExternally('photo.JPEG')).toBe(false);
			});

			it('returns false for other previewable image formats', () => {
				expect(shouldOpenExternally('image.gif')).toBe(false);
				expect(shouldOpenExternally('image.webp')).toBe(false);
				expect(shouldOpenExternally('image.bmp')).toBe(false);
				expect(shouldOpenExternally('favicon.ico')).toBe(false);
			});

			it('returns true for non-previewable image formats', () => {
				expect(shouldOpenExternally('photo.tiff')).toBe(true);
				expect(shouldOpenExternally('photo.tif')).toBe(true);
				expect(shouldOpenExternally('photo.heic')).toBe(true);
				expect(shouldOpenExternally('photo.heif')).toBe(true);
			});
		});

		describe('code and text files', () => {
			it('returns false for TypeScript files', () => {
				expect(shouldOpenExternally('app.ts')).toBe(false);
				expect(shouldOpenExternally('app.tsx')).toBe(false);
			});

			it('returns false for JavaScript files', () => {
				expect(shouldOpenExternally('app.js')).toBe(false);
				expect(shouldOpenExternally('app.jsx')).toBe(false);
			});

			it('returns false for markdown files', () => {
				expect(shouldOpenExternally('README.md')).toBe(false);
			});

			it('returns false for text files', () => {
				expect(shouldOpenExternally('notes.txt')).toBe(false);
			});

			it('returns false for JSON files', () => {
				expect(shouldOpenExternally('package.json')).toBe(false);
			});

			it('returns false for CSS files', () => {
				expect(shouldOpenExternally('styles.css')).toBe(false);
			});

			it('returns false for HTML files', () => {
				expect(shouldOpenExternally('index.html')).toBe(false);
			});
		});

		describe('edge cases', () => {
			it('returns false for files without extension', () => {
				expect(shouldOpenExternally('Makefile')).toBe(false);
				expect(shouldOpenExternally('Dockerfile')).toBe(false);
			});

			it('handles uppercase extensions', () => {
				expect(shouldOpenExternally('video.MP4')).toBe(true);
				expect(shouldOpenExternally('archive.ZIP')).toBe(true);
				expect(shouldOpenExternally('code.TS')).toBe(false);
			});

			it('handles filenames with multiple dots', () => {
				expect(shouldOpenExternally('archive.backup.zip')).toBe(true);
				expect(shouldOpenExternally('file.test.ts')).toBe(false);
				expect(shouldOpenExternally('report.2024.pdf')).toBe(true);
			});

			it('returns false for empty filename', () => {
				expect(shouldOpenExternally('')).toBe(false);
			});
		});
	});

	// ============================================================================
	// loadFileTree
	// ============================================================================
	describe('loadFileTree', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('returns empty array when maxDepth is reached', async () => {
			const result = await loadFileTree('/some/path', 5, 5);
			expect(result).toEqual([]);
			// Should not call readDir when depth is reached
			expect(window.maestro.fs.readDir).not.toHaveBeenCalled();
		});

		it('loads files and folders from directory', async () => {
			// First call returns the directory contents, second call for src folder returns empty
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: 'src', isFile: false, isDirectory: true },
					{ name: 'README.md', isFile: true, isDirectory: false },
					{ name: 'package.json', isFile: true, isDirectory: false },
				])
				.mockResolvedValue([]); // Empty children for src folder

			const result = await loadFileTree('/project');

			// Should pass undefined for sshRemoteId when no SSH context is provided
			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/project', undefined);
			expect(result).toHaveLength(3);
			expect(result[0]).toEqual({
				name: 'src',
				type: 'folder',
				children: [],
			});
			expect(result[1]).toEqual({ name: 'package.json', type: 'file' });
			expect(result[2]).toEqual({ name: 'README.md', type: 'file' });
		});

		it('includes hidden files and directories (starting with .)', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: '.git', isFile: false, isDirectory: true },
					{ name: '.gitignore', isFile: true, isDirectory: false },
					{ name: '.env', isFile: true, isDirectory: false },
					{ name: 'src', isFile: false, isDirectory: true },
					{ name: 'README.md', isFile: true, isDirectory: false },
				])
				.mockResolvedValue([]); // Empty for recursive folder calls

			const result = await loadFileTree('/project');

			expect(result).toHaveLength(5);
			expect(result.find((n) => n.name === '.git')).toBeDefined();
			expect(result.find((n) => n.name === '.gitignore')).toBeDefined();
			expect(result.find((n) => n.name === '.env')).toBeDefined();
			expect(result.find((n) => n.name === 'src')).toBeDefined();
			expect(result.find((n) => n.name === 'README.md')).toBeDefined();
		});

		it('skips node_modules directory', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: 'node_modules', isFile: false, isDirectory: true },
					{ name: 'src', isFile: false, isDirectory: true },
				])
				.mockResolvedValue([]); // Empty for src folder recursion

			const result = await loadFileTree('/project');

			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('src');
		});

		it('skips __pycache__ directory', async () => {
			vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([
				{ name: '__pycache__', isFile: false, isDirectory: true },
				{ name: 'main.py', isFile: true, isDirectory: false },
			]);
			// No further calls needed - __pycache__ is skipped and main.py is a file

			const result = await loadFileTree('/project');

			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('main.py');
		});

		it('sorts folders before files', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: 'zebra.txt', isFile: true, isDirectory: false },
					{ name: 'alpha', isFile: false, isDirectory: true },
					{ name: 'apple.js', isFile: true, isDirectory: false },
					{ name: 'beta', isFile: false, isDirectory: true },
				])
				.mockResolvedValue([]); // Empty for folder recursion

			const result = await loadFileTree('/project');

			expect(result[0].name).toBe('alpha');
			expect(result[0].type).toBe('folder');
			expect(result[1].name).toBe('beta');
			expect(result[1].type).toBe('folder');
			expect(result[2].name).toBe('apple.js');
			expect(result[2].type).toBe('file');
			expect(result[3].name).toBe('zebra.txt');
			expect(result[3].type).toBe('file');
		});

		it('sorts alphabetically within same type', async () => {
			vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([
				{ name: 'zebra.txt', isFile: true, isDirectory: false },
				{ name: 'apple.js', isFile: true, isDirectory: false },
				{ name: 'banana.ts', isFile: true, isDirectory: false },
			]);
			// No further calls - all files, no recursion

			const result = await loadFileTree('/project');

			expect(result[0].name).toBe('apple.js');
			expect(result[1].name).toBe('banana.ts');
			expect(result[2].name).toBe('zebra.txt');
		});

		it('recursively loads children of folders', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([{ name: 'src', isFile: false, isDirectory: true }])
				.mockResolvedValueOnce([
					{ name: 'index.ts', isFile: true, isDirectory: false },
					{ name: 'components', isFile: false, isDirectory: true },
				])
				.mockResolvedValueOnce([{ name: 'App.tsx', isFile: true, isDirectory: false }]);

			const result = await loadFileTree('/project');

			expect(window.maestro.fs.readDir).toHaveBeenCalledTimes(3);
			expect(result[0].name).toBe('src');
			expect(result[0].children).toHaveLength(2);
			expect(result[0].children![0].name).toBe('components');
			expect(result[0].children![0].children).toHaveLength(1);
			expect(result[0].children![0].children![0].name).toBe('App.tsx');
		});

		it('propagates errors from readDir', async () => {
			const error = new Error('Permission denied');
			vi.mocked(window.maestro.fs.readDir).mockRejectedValue(error);

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			await expect(loadFileTree('/restricted')).rejects.toThrow('Permission denied');
			consoleSpy.mockRestore();
		});

		it('respects default maxDepth of 10', async () => {
			// Setup recursive structure
			const setupMocks = () => {
				vi.mocked(window.maestro.fs.readDir).mockResolvedValue([
					{ name: 'deep', isFile: false, isDirectory: true },
				]);
			};
			setupMocks();

			await loadFileTree('/project');

			// Should be called maxDepth times (10) for each level, then stop
			expect(window.maestro.fs.readDir).toHaveBeenCalledTimes(10);
		});

		it('handles entries that are neither file nor directory', async () => {
			vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([
				{ name: 'regular.txt', isFile: true, isDirectory: false },
				{ name: 'symlink', isFile: false, isDirectory: false }, // Neither file nor directory
			]);
			// No further calls - regular.txt is a file, symlink is skipped

			const result = await loadFileTree('/project');

			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('regular.txt');
		});

		it('passes SSH context to readDir for remote file operations', async () => {
			vi.mocked(window.maestro.fs.readDir)
				.mockResolvedValueOnce([
					{ name: 'src', isFile: false, isDirectory: true },
					{ name: 'README.md', isFile: true, isDirectory: false },
				])
				.mockResolvedValue([]); // Empty children for src folder

			const sshContext = { sshRemoteId: 'remote-1', remoteCwd: '/home/user' };
			const result = await loadFileTree('/project', 10, 0, sshContext);

			// Verify SSH remote ID is passed to all readDir calls
			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/project', 'remote-1');
			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/project/src', 'remote-1');
			expect(result).toHaveLength(2);
		});

		it('passes undefined to readDir when no SSH context is provided', async () => {
			vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([
				{ name: 'file.txt', isFile: true, isDirectory: false },
			]);

			await loadFileTree('/project');

			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/project', undefined);
		});
	});

	// ============================================================================
	// getAllFolderPaths
	// ============================================================================
	describe('getAllFolderPaths', () => {
		it('returns empty array for empty tree', () => {
			expect(getAllFolderPaths([])).toEqual([]);
		});

		it('returns empty array for tree with only files', () => {
			const tree: FileTreeNode[] = [
				{ name: 'file1.txt', type: 'file' },
				{ name: 'file2.js', type: 'file' },
			];

			expect(getAllFolderPaths(tree)).toEqual([]);
		});

		it('returns folder paths for flat structure', () => {
			const tree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'tests', type: 'folder', children: [] },
				{ name: 'README.md', type: 'file' },
			];

			expect(getAllFolderPaths(tree)).toEqual(['src', 'tests']);
		});

		it('returns nested folder paths', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{ name: 'components', type: 'folder', children: [] },
						{ name: 'utils', type: 'folder', children: [] },
					],
				},
			];

			const paths = getAllFolderPaths(tree);
			expect(paths).toContain('src');
			expect(paths).toContain('src/components');
			expect(paths).toContain('src/utils');
			expect(paths).toHaveLength(3);
		});

		it('handles multiple levels of nesting', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'level1',
					type: 'folder',
					children: [
						{
							name: 'level2',
							type: 'folder',
							children: [
								{
									name: 'level3',
									type: 'folder',
									children: [],
								},
							],
						},
					],
				},
			];

			const paths = getAllFolderPaths(tree);
			expect(paths).toEqual(['level1', 'level1/level2', 'level1/level2/level3']);
		});

		it('excludes file entries at all levels', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{ name: 'index.ts', type: 'file' },
						{ name: 'components', type: 'folder', children: [] },
					],
				},
				{ name: 'package.json', type: 'file' },
			];

			const paths = getAllFolderPaths(tree);
			expect(paths).toEqual(['src', 'src/components']);
			expect(paths).not.toContain('src/index.ts');
		});

		it('uses provided currentPath prefix', () => {
			const tree: FileTreeNode[] = [{ name: 'subdir', type: 'folder', children: [] }];

			const paths = getAllFolderPaths(tree, 'root');
			expect(paths).toEqual(['root/subdir']);
		});
	});

	// ============================================================================
	// flattenTree
	// ============================================================================
	describe('flattenTree', () => {
		it('returns empty array for empty tree', () => {
			expect(flattenTree([], new Set())).toEqual([]);
		});

		it('flattens single file', () => {
			const tree: FileTreeNode[] = [{ name: 'file.txt', type: 'file' }];

			const result = flattenTree(tree, new Set());

			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({
				name: 'file.txt',
				type: 'file',
				fullPath: 'file.txt',
				isFolder: false,
			});
		});

		it('flattens single folder (collapsed)', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [{ name: 'index.ts', type: 'file' }],
				},
			];

			const result = flattenTree(tree, new Set());

			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({
				name: 'src',
				type: 'folder',
				children: [{ name: 'index.ts', type: 'file' }],
				fullPath: 'src',
				isFolder: true,
			});
		});

		it('includes children when folder is expanded', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [{ name: 'index.ts', type: 'file' }],
				},
			];

			const expanded = new Set(['src']);
			const result = flattenTree(tree, expanded);

			expect(result).toHaveLength(2);
			expect(result[0].fullPath).toBe('src');
			expect(result[1].fullPath).toBe('src/index.ts');
		});

		it('excludes children when folder is collapsed', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{ name: 'index.ts', type: 'file' },
						{ name: 'app.ts', type: 'file' },
					],
				},
			];

			const result = flattenTree(tree, new Set());

			expect(result).toHaveLength(1);
			expect(result[0].fullPath).toBe('src');
		});

		it('sets correct fullPath for nested items', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{
							name: 'components',
							type: 'folder',
							children: [{ name: 'App.tsx', type: 'file' }],
						},
					],
				},
			];

			const expanded = new Set(['src', 'src/components']);
			const result = flattenTree(tree, expanded);

			expect(result).toHaveLength(3);
			expect(result[0].fullPath).toBe('src');
			expect(result[1].fullPath).toBe('src/components');
			expect(result[2].fullPath).toBe('src/components/App.tsx');
		});

		it('sets isFolder correctly', () => {
			const tree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'file.txt', type: 'file' },
			];

			const result = flattenTree(tree, new Set());

			expect(result[0].isFolder).toBe(true);
			expect(result[1].isFolder).toBe(false);
		});

		it('handles deeply nested expanded folders', () => {
			const tree: FileTreeNode[] = [
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
									children: [{ name: 'file.txt', type: 'file' }],
								},
							],
						},
					],
				},
			];

			const expanded = new Set(['a', 'a/b', 'a/b/c']);
			const result = flattenTree(tree, expanded);

			expect(result).toHaveLength(4);
			expect(result.map((n) => n.fullPath)).toEqual(['a', 'a/b', 'a/b/c', 'a/b/c/file.txt']);
		});

		it('only expands folders in expanded set', () => {
			const tree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{
							name: 'components',
							type: 'folder',
							children: [{ name: 'App.tsx', type: 'file' }],
						},
						{
							name: 'utils',
							type: 'folder',
							children: [{ name: 'helper.ts', type: 'file' }],
						},
					],
				},
			];

			// Only expand src and components, not utils
			const expanded = new Set(['src', 'src/components']);
			const result = flattenTree(tree, expanded);

			expect(result).toHaveLength(4);
			const paths = result.map((n) => n.fullPath);
			expect(paths).toContain('src');
			expect(paths).toContain('src/components');
			expect(paths).toContain('src/components/App.tsx');
			expect(paths).toContain('src/utils');
			expect(paths).not.toContain('src/utils/helper.ts'); // Not expanded
		});

		it('uses provided currentPath prefix', () => {
			const tree: FileTreeNode[] = [{ name: 'file.txt', type: 'file' }];

			const result = flattenTree(tree, new Set(), 'prefix');

			expect(result[0].fullPath).toBe('prefix/file.txt');
		});

		it('handles folders without children array', () => {
			const tree: FileTreeNode[] = [
				{ name: 'empty', type: 'folder' }, // No children property
			];

			const expanded = new Set(['empty']);
			const result = flattenTree(tree, expanded);

			expect(result).toHaveLength(1);
			expect(result[0].fullPath).toBe('empty');
		});
	});

	// ============================================================================
	// compareFileTrees
	// ============================================================================
	describe('compareFileTrees', () => {
		it('returns all zeros for identical trees', () => {
			const tree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'file.txt', type: 'file' },
			];

			const result = compareFileTrees(tree, tree);

			expect(result).toEqual({
				totalChanges: 0,
				newFiles: 0,
				newFolders: 0,
				removedFiles: 0,
				removedFolders: 0,
			});
		});

		it('detects new files', () => {
			const oldTree: FileTreeNode[] = [{ name: 'file1.txt', type: 'file' }];

			const newTree: FileTreeNode[] = [
				{ name: 'file1.txt', type: 'file' },
				{ name: 'file2.txt', type: 'file' },
			];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.newFiles).toBe(1);
			expect(result.removedFiles).toBe(0);
		});

		it('detects new folders', () => {
			const oldTree: FileTreeNode[] = [{ name: 'src', type: 'folder', children: [] }];

			const newTree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'tests', type: 'folder', children: [] },
			];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.newFolders).toBe(1);
			expect(result.removedFolders).toBe(0);
		});

		it('detects removed files', () => {
			const oldTree: FileTreeNode[] = [
				{ name: 'file1.txt', type: 'file' },
				{ name: 'file2.txt', type: 'file' },
			];

			const newTree: FileTreeNode[] = [{ name: 'file1.txt', type: 'file' }];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.removedFiles).toBe(1);
			expect(result.newFiles).toBe(0);
		});

		it('detects removed folders', () => {
			const oldTree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'tests', type: 'folder', children: [] },
			];

			const newTree: FileTreeNode[] = [{ name: 'src', type: 'folder', children: [] }];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.removedFolders).toBe(1);
			expect(result.newFolders).toBe(0);
		});

		it('calculates totalChanges correctly', () => {
			const oldTree: FileTreeNode[] = [
				{ name: 'old.txt', type: 'file' },
				{ name: 'oldFolder', type: 'folder', children: [] },
			];

			const newTree: FileTreeNode[] = [
				{ name: 'new.txt', type: 'file' },
				{ name: 'newFolder', type: 'folder', children: [] },
			];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.totalChanges).toBe(4); // 1 new file + 1 new folder + 1 removed file + 1 removed folder
			expect(result.newFiles).toBe(1);
			expect(result.newFolders).toBe(1);
			expect(result.removedFiles).toBe(1);
			expect(result.removedFolders).toBe(1);
		});

		it('handles empty old tree (all new)', () => {
			const newTree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'file.txt', type: 'file' },
			];

			const result = compareFileTrees([], newTree);

			expect(result.newFiles).toBe(1);
			expect(result.newFolders).toBe(1);
			expect(result.removedFiles).toBe(0);
			expect(result.removedFolders).toBe(0);
			expect(result.totalChanges).toBe(2);
		});

		it('handles empty new tree (all removed)', () => {
			const oldTree: FileTreeNode[] = [
				{ name: 'src', type: 'folder', children: [] },
				{ name: 'file.txt', type: 'file' },
			];

			const result = compareFileTrees(oldTree, []);

			expect(result.removedFiles).toBe(1);
			expect(result.removedFolders).toBe(1);
			expect(result.newFiles).toBe(0);
			expect(result.newFolders).toBe(0);
			expect(result.totalChanges).toBe(2);
		});

		it('handles both empty trees', () => {
			const result = compareFileTrees([], []);

			expect(result).toEqual({
				totalChanges: 0,
				newFiles: 0,
				newFolders: 0,
				removedFiles: 0,
				removedFolders: 0,
			});
		});

		it('detects changes in nested structures', () => {
			const oldTree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{ name: 'index.ts', type: 'file' },
						{
							name: 'components',
							type: 'folder',
							children: [{ name: 'App.tsx', type: 'file' }],
						},
					],
				},
			];

			const newTree: FileTreeNode[] = [
				{
					name: 'src',
					type: 'folder',
					children: [
						{ name: 'index.ts', type: 'file' },
						{ name: 'main.ts', type: 'file' }, // New file
						{
							name: 'utils',
							type: 'folder',
							children: [],
						}, // New folder (components removed)
					],
				},
			];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.newFiles).toBe(1); // main.ts
			expect(result.newFolders).toBe(1); // utils
			expect(result.removedFiles).toBe(1); // App.tsx
			expect(result.removedFolders).toBe(1); // components
			expect(result.totalChanges).toBe(4);
		});

		it('correctly identifies files vs folders with same name', () => {
			const oldTree: FileTreeNode[] = [{ name: 'test', type: 'file' }];

			const newTree: FileTreeNode[] = [{ name: 'test', type: 'folder', children: [] }];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.removedFiles).toBe(1);
			expect(result.newFolders).toBe(1);
			expect(result.totalChanges).toBe(2);
		});

		it('handles deeply nested additions', () => {
			const oldTree: FileTreeNode[] = [
				{
					name: 'a',
					type: 'folder',
					children: [],
				},
			];

			const newTree: FileTreeNode[] = [
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
									children: [{ name: 'deep.txt', type: 'file' }],
								},
							],
						},
					],
				},
			];

			const result = compareFileTrees(oldTree, newTree);

			expect(result.newFolders).toBe(2); // b and c
			expect(result.newFiles).toBe(1); // deep.txt
			expect(result.totalChanges).toBe(3);
		});
	});
});
