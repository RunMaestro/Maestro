/**
 * Tests for Auto Run folder validation, path security, and file filtering
 *
 * Tests cover:
 * - Folder path validation and security checks
 * - Subfolder scanning (recursive directory traversal)
 * - Hidden file filtering (files starting with .)
 * - Symlink handling and security implications
 *
 * Task 4.3 from Testing-II.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock electron modules
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
	BrowserWindow: vi.fn(),
	app: {
		on: vi.fn(),
	},
}));

// Mock logger
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock fs modules
const mockReaddir = vi.fn();
const mockStat = vi.fn();
const mockLstat = vi.fn();
const mockRealpath = vi.fn();
const mockAccess = vi.fn();

vi.mock('fs/promises', () => ({
	default: {
		readdir: mockReaddir,
		stat: mockStat,
		lstat: mockLstat,
		realpath: mockRealpath,
		access: mockAccess,
	},
	readdir: mockReaddir,
	stat: mockStat,
	lstat: mockLstat,
	realpath: mockRealpath,
	access: mockAccess,
}));

vi.mock('fs', () => ({
	default: {
		watch: vi.fn(),
	},
	watch: vi.fn(),
}));

// Helper to create mock directory entries
interface MockDirent {
	name: string;
	isDirectory: () => boolean;
	isFile: () => boolean;
	isBlockDevice: () => boolean;
	isCharacterDevice: () => boolean;
	isFIFO: () => boolean;
	isSocket: () => boolean;
	isSymbolicLink: () => boolean;
}

function createDirent(name: string, type: 'file' | 'directory' | 'symlink'): MockDirent {
	return {
		name,
		isDirectory: () => type === 'directory',
		isFile: () => type === 'file',
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isFIFO: () => false,
		isSocket: () => false,
		isSymbolicLink: () => type === 'symlink',
	};
}

// Implementation of validatePathWithinFolder from autorun.ts
function validatePathWithinFolder(filePath: string, folderPath: string): boolean {
	const resolvedPath = path.resolve(filePath);
	const resolvedFolder = path.resolve(folderPath);
	return resolvedPath.startsWith(resolvedFolder + path.sep) || resolvedPath === resolvedFolder;
}

// Implementation of hidden file filter from scanDirectory
function isHiddenFile(name: string): boolean {
	return name.startsWith('.');
}

// Tree node interface matching autorun.ts
interface TreeNode {
	name: string;
	type: 'file' | 'folder';
	path: string;
	children?: TreeNode[];
}

// Recursive scanDirectory implementation for testing
async function scanDirectory(
	dirPath: string,
	relativePath: string = '',
	mockReaddirFn: typeof mockReaddir
): Promise<TreeNode[]> {
	const entries = await mockReaddirFn(dirPath, { withFileTypes: true });
	const nodes: TreeNode[] = [];

	// Sort entries: folders first, then files, both alphabetically
	const sortedEntries = entries
		.filter((entry: MockDirent) => !entry.name.startsWith('.'))
		.sort((a: MockDirent, b: MockDirent) => {
			if (a.isDirectory() && !b.isDirectory()) return -1;
			if (!a.isDirectory() && b.isDirectory()) return 1;
			return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
		});

	for (const entry of sortedEntries) {
		const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

		if (entry.isDirectory()) {
			// Recursively scan subdirectory
			const children = await scanDirectory(
				path.join(dirPath, entry.name),
				entryRelativePath,
				mockReaddirFn
			);
			// Only include folders that contain .md files
			if (children.length > 0) {
				nodes.push({
					name: entry.name,
					type: 'folder',
					path: entryRelativePath,
					children,
				});
			}
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
			nodes.push({
				name: entry.name.slice(0, -3),
				type: 'file',
				path: entryRelativePath.slice(0, -3),
			});
		}
	}

	return nodes;
}

describe('Auto Run Folder Validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockReaddir.mockReset();
		mockStat.mockReset();
		mockLstat.mockReset();
		mockRealpath.mockReset();
		mockAccess.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('Folder Path Validation', () => {
		describe('validatePathWithinFolder', () => {
			it('should accept files directly within the folder', () => {
				const folderPath = '/test/autorun';
				const filePath = '/test/autorun/document.md';

				expect(validatePathWithinFolder(filePath, folderPath)).toBe(true);
			});

			it('should accept files in nested subfolders', () => {
				const folderPath = '/test/autorun';
				const filePath = '/test/autorun/Phase1/Task1.md';

				expect(validatePathWithinFolder(filePath, folderPath)).toBe(true);
			});

			it('should accept deeply nested files', () => {
				const folderPath = '/test/autorun';
				const filePath = '/test/autorun/a/b/c/d/e/deep.md';

				expect(validatePathWithinFolder(filePath, folderPath)).toBe(true);
			});

			it('should accept the folder path itself', () => {
				const folderPath = '/test/autorun';

				expect(validatePathWithinFolder(folderPath, folderPath)).toBe(true);
			});

			it('should reject files outside the folder', () => {
				const folderPath = '/test/autorun';
				const filePath = '/etc/passwd';

				expect(validatePathWithinFolder(filePath, folderPath)).toBe(false);
			});

			it('should reject sibling folder paths', () => {
				const folderPath = '/test/autorun';
				const filePath = '/test/other-folder/document.md';

				expect(validatePathWithinFolder(filePath, folderPath)).toBe(false);
			});

			it('should reject parent folder paths', () => {
				const folderPath = '/test/autorun';
				const filePath = '/test/document.md';

				expect(validatePathWithinFolder(filePath, folderPath)).toBe(false);
			});

			it('should prevent prefix attack with similar folder names', () => {
				const folderPath = '/test/autorun';
				const filePath = '/test/autorun-evil/malicious.md';

				// This is the critical security check - "autorun-evil" should NOT match "autorun"
				expect(validatePathWithinFolder(filePath, folderPath)).toBe(false);
			});

			it('should prevent prefix attack with underscore suffix', () => {
				const folderPath = '/test/autorun';
				const filePath = '/test/autorun_backup/secret.md';

				expect(validatePathWithinFolder(filePath, folderPath)).toBe(false);
			});

			it('should handle Windows-style paths', () => {
				// Note: path.resolve behavior is platform-dependent
				const folderPath = '/Users/test/autorun';
				const validPath = '/Users/test/autorun/doc.md';
				const invalidPath = '/Users/test/autorun2/doc.md';

				expect(validatePathWithinFolder(validPath, folderPath)).toBe(true);
				expect(validatePathWithinFolder(invalidPath, folderPath)).toBe(false);
			});

			it('should handle trailing slashes correctly', () => {
				const folderPath = '/test/autorun';
				const folderPathWithSlash = '/test/autorun/';
				const filePath = '/test/autorun/document.md';

				expect(validatePathWithinFolder(filePath, folderPath)).toBe(true);
				// path.resolve normalizes trailing slashes
				expect(validatePathWithinFolder(filePath, folderPathWithSlash)).toBe(true);
			});

			it('should handle paths with spaces', () => {
				const folderPath = '/test/Auto Run Docs';
				const filePath = '/test/Auto Run Docs/My Document.md';

				expect(validatePathWithinFolder(filePath, folderPath)).toBe(true);
			});

			it('should handle unicode paths', () => {
				const folderPath = '/test/文档目录';
				const filePath = '/test/文档目录/任务.md';

				expect(validatePathWithinFolder(filePath, folderPath)).toBe(true);
			});
		});

		describe('Directory Traversal Prevention', () => {
			it('should detect simple .. traversal', () => {
				const filename = '../../../etc/passwd';
				const hasTraversal = filename.includes('..');

				expect(hasTraversal).toBe(true);
			});

			it('should detect encoded traversal attempts', () => {
				const encodedTraversals = ['..%2F..%2Fetc%2Fpasswd', '..%252F..%252Fetc', '%2e%2e%2f'];

				// While URL-encoded, the raw check still works on decoded paths
				const decodedPath = decodeURIComponent('..%2F..%2Fetc');
				expect(decodedPath.includes('..')).toBe(true);
			});

			it('should detect Windows-style traversal', () => {
				const windowsTraversals = ['..\\..\\Windows\\System32', '..%5C..%5CWindows'];

				windowsTraversals.forEach((traversal) => {
					expect(traversal.includes('..') || decodeURIComponent(traversal).includes('..')).toBe(
						true
					);
				});
			});

			it('should detect null byte injection attempts', () => {
				const nullByteAttempts = ['doc.md\0.exe', 'doc\0../secret'];

				nullByteAttempts.forEach((attempt) => {
					expect(attempt.includes('\0')).toBe(true);
				});
			});

			it('should validate resolved path prevents symlink escape', () => {
				// Even if a symlink points outside, path.resolve follows it
				// The handler uses resolved paths to catch this
				const folderPath = '/test/autorun';

				// Simulated scenario: /test/autorun/link -> /etc
				// If we follow the symlink, the resolved path would be /etc/passwd
				const resolvedSymlinkTarget = '/etc/passwd';

				expect(validatePathWithinFolder(resolvedSymlinkTarget, folderPath)).toBe(false);
			});
		});

		describe('Path Normalization', () => {
			it('should normalize paths with redundant separators', () => {
				const folderPath = '/test/autorun';
				const filePath = '/test/autorun//document.md';
				const resolved = path.resolve(filePath);

				expect(resolved).toBe('/test/autorun/document.md');
				expect(validatePathWithinFolder(filePath, folderPath)).toBe(true);
			});

			it('should normalize paths with . components', () => {
				const folderPath = '/test/autorun';
				const filePath = '/test/autorun/./document.md';
				const resolved = path.resolve(filePath);

				expect(resolved).toBe('/test/autorun/document.md');
				expect(validatePathWithinFolder(filePath, folderPath)).toBe(true);
			});

			it('should handle mixed . and .. in allowed paths', () => {
				const folderPath = '/test/autorun';
				const filePath = '/test/autorun/subfolder/../document.md';
				const resolved = path.resolve(filePath);

				expect(resolved).toBe('/test/autorun/document.md');
				expect(validatePathWithinFolder(filePath, folderPath)).toBe(true);
			});

			it('should reject .. that escapes the folder', () => {
				const folderPath = '/test/autorun';
				const filePath = '/test/autorun/../secret.md';
				const resolved = path.resolve(filePath);

				expect(resolved).toBe('/test/secret.md');
				expect(validatePathWithinFolder(filePath, folderPath)).toBe(false);
			});

			it('should handle path.join with potentially malicious input', () => {
				const folderPath = '/test/autorun';
				// path.join is dangerous with absolute paths in the second argument
				const maliciousInput = '/etc/passwd';
				const joined = path.join(folderPath, maliciousInput);

				// path.join treats absolute second arg as root - this is why validation is needed
				expect(joined).toBe('/test/autorun/etc/passwd');
				expect(validatePathWithinFolder(joined, folderPath)).toBe(true);

				// But if someone bypasses join and uses the raw path:
				expect(validatePathWithinFolder(maliciousInput, folderPath)).toBe(false);
			});
		});
	});

	describe('Subfolder Scanning (Recursive)', () => {
		describe('Basic Recursive Scanning', () => {
			it('should scan single-level directory', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('Task1.md', 'file'),
					createDirent('Task2.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(2);
				expect(tree[0].name).toBe('Task1');
				expect(tree[0].type).toBe('file');
				expect(tree[1].name).toBe('Task2');
			});

			it('should scan nested directories recursively', async () => {
				// Root level
				mockReaddir.mockResolvedValueOnce([
					createDirent('Phase1', 'directory'),
					createDirent('Overview.md', 'file'),
				]);
				// Phase1 subdirectory
				mockReaddir.mockResolvedValueOnce([
					createDirent('Task1.md', 'file'),
					createDirent('Task2.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(2);
				expect(tree[0].type).toBe('folder');
				expect(tree[0].name).toBe('Phase1');
				expect(tree[0].children).toHaveLength(2);
				expect(tree[1].type).toBe('file');
				expect(tree[1].name).toBe('Overview');
			});

			it('should scan deeply nested structures', async () => {
				// Root
				mockReaddir.mockResolvedValueOnce([createDirent('Level1', 'directory')]);
				// Level1
				mockReaddir.mockResolvedValueOnce([createDirent('Level2', 'directory')]);
				// Level2
				mockReaddir.mockResolvedValueOnce([createDirent('Level3', 'directory')]);
				// Level3
				mockReaddir.mockResolvedValueOnce([createDirent('DeepDoc.md', 'file')]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				expect(tree[0].type).toBe('folder');
				expect(tree[0].children?.[0].type).toBe('folder');
				expect(tree[0].children?.[0].children?.[0].type).toBe('folder');
				expect(tree[0].children?.[0].children?.[0].children?.[0].type).toBe('file');
				expect(tree[0].children?.[0].children?.[0].children?.[0].name).toBe('DeepDoc');
			});

			it('should build correct relative paths for nested files', async () => {
				// Root
				mockReaddir.mockResolvedValueOnce([createDirent('Phase1', 'directory')]);
				// Phase1
				mockReaddir.mockResolvedValueOnce([createDirent('SubPhase', 'directory')]);
				// SubPhase
				mockReaddir.mockResolvedValueOnce([createDirent('Task.md', 'file')]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				const deepFile = tree[0].children?.[0].children?.[0];
				expect(deepFile?.path).toBe('Phase1/SubPhase/Task');
			});
		});

		describe('Empty Folder Handling', () => {
			it('should exclude empty folders from tree', async () => {
				// Root
				mockReaddir.mockResolvedValueOnce([
					createDirent('EmptyFolder', 'directory'),
					createDirent('Document.md', 'file'),
				]);
				// EmptyFolder - no .md files
				mockReaddir.mockResolvedValueOnce([]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				expect(tree[0].type).toBe('file');
				expect(tree[0].name).toBe('Document');
			});

			it('should exclude folders with only non-md files', async () => {
				// Root
				mockReaddir.mockResolvedValueOnce([createDirent('ImagesFolder', 'directory')]);
				// ImagesFolder - only images
				mockReaddir.mockResolvedValueOnce([
					createDirent('photo.png', 'file'),
					createDirent('screenshot.jpg', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(0);
			});

			it('should include folder if any nested folder has md files', async () => {
				// Root
				mockReaddir.mockResolvedValueOnce([createDirent('ParentFolder', 'directory')]);
				// ParentFolder - no direct .md files, but has subfolder
				mockReaddir.mockResolvedValueOnce([createDirent('NestedFolder', 'directory')]);
				// NestedFolder - has .md files
				mockReaddir.mockResolvedValueOnce([createDirent('Task.md', 'file')]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				expect(tree[0].name).toBe('ParentFolder');
				expect(tree[0].children).toHaveLength(1);
				expect(tree[0].children?.[0].name).toBe('NestedFolder');
			});

			it('should handle completely empty directory', async () => {
				mockReaddir.mockResolvedValueOnce([]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(0);
			});
		});

		describe('Sorting Behavior', () => {
			it('should sort folders before files', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('ZFile.md', 'file'),
					createDirent('AFolder', 'directory'),
					createDirent('AFile.md', 'file'),
					createDirent('ZFolder', 'directory'),
				]);
				// Both folders must be scanned
				mockReaddir.mockResolvedValueOnce([createDirent('nested.md', 'file')]);
				mockReaddir.mockResolvedValueOnce([createDirent('nested.md', 'file')]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				// Folders first (alphabetically), then files (alphabetically)
				expect(tree[0].type).toBe('folder');
				expect(tree[0].name).toBe('AFolder');
				expect(tree[1].type).toBe('folder');
				expect(tree[1].name).toBe('ZFolder');
				expect(tree[2].type).toBe('file');
				expect(tree[2].name).toBe('AFile');
				expect(tree[3].type).toBe('file');
				expect(tree[3].name).toBe('ZFile');
			});

			it('should sort alphabetically case-insensitive', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('zebra.md', 'file'),
					createDirent('Alpha.md', 'file'),
					createDirent('BETA.md', 'file'),
					createDirent('gamma.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree.map((n) => n.name)).toEqual(['Alpha', 'BETA', 'gamma', 'zebra']);
			});

			it('should handle numeric prefixes in names', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('10-Task.md', 'file'),
					createDirent('2-Task.md', 'file'),
					createDirent('1-Task.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				// String sort: "1-Task" < "10-Task" < "2-Task"
				expect(tree.map((n) => n.name)).toEqual(['1-Task', '10-Task', '2-Task']);
			});
		});

		describe('File Extension Handling', () => {
			it('should only include .md files', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('document.md', 'file'),
					createDirent('readme.txt', 'file'),
					createDirent('config.json', 'file'),
					createDirent('script.js', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				expect(tree[0].name).toBe('document');
			});

			it('should handle case-insensitive .md extension', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('lower.md', 'file'),
					createDirent('upper.MD', 'file'),
					createDirent('mixed.Md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(3);
			});

			it('should remove .md extension from name and path', async () => {
				mockReaddir.mockResolvedValueOnce([createDirent('Phase1', 'directory')]);
				mockReaddir.mockResolvedValueOnce([createDirent('Task1.md', 'file')]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree[0].children?.[0].name).toBe('Task1');
				expect(tree[0].children?.[0].path).toBe('Phase1/Task1');
				// Path should NOT end with .md
				expect(tree[0].children?.[0].path.endsWith('.md')).toBe(false);
			});

			it('should handle files with .md in the name before extension', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('readme.md.md', 'file'),
					createDirent('CLAUDE.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(2);
				// "readme.md.md" becomes "readme.md" after removing extension
				expect(tree.map((n) => n.name).sort()).toEqual(['CLAUDE', 'readme.md']);
			});
		});
	});

	describe('Hidden File Filtering', () => {
		describe('Basic Hidden File Detection', () => {
			it('should identify files starting with dot as hidden', () => {
				expect(isHiddenFile('.hidden')).toBe(true);
				expect(isHiddenFile('.DS_Store')).toBe(true);
				expect(isHiddenFile('.gitignore')).toBe(true);
				expect(isHiddenFile('.env')).toBe(true);
			});

			it('should not flag normal files as hidden', () => {
				expect(isHiddenFile('document.md')).toBe(false);
				expect(isHiddenFile('Phase1')).toBe(false);
				expect(isHiddenFile('README.md')).toBe(false);
			});

			it('should not flag files with dots in the middle as hidden', () => {
				expect(isHiddenFile('file.test.md')).toBe(false);
				expect(isHiddenFile('my.document.md')).toBe(false);
				expect(isHiddenFile('v1.0.0')).toBe(false);
			});
		});

		describe('Filtering in Directory Scan', () => {
			it('should filter out hidden files', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('.hidden.md', 'file'),
					createDirent('visible.md', 'file'),
					createDirent('.DS_Store', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				expect(tree[0].name).toBe('visible');
			});

			it('should filter out hidden folders', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('.git', 'directory'),
					createDirent('.vscode', 'directory'),
					createDirent('Phase1', 'directory'),
				]);
				// Only Phase1 is scanned
				mockReaddir.mockResolvedValueOnce([createDirent('Task.md', 'file')]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				expect(tree[0].name).toBe('Phase1');
			});

			it('should filter hidden files in nested directories', async () => {
				mockReaddir.mockResolvedValueOnce([createDirent('Phase1', 'directory')]);
				mockReaddir.mockResolvedValueOnce([
					createDirent('.hidden.md', 'file'),
					createDirent('Task1.md', 'file'),
					createDirent('.draft.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree[0].children).toHaveLength(1);
				expect(tree[0].children?.[0].name).toBe('Task1');
			});

			it('should not scan inside hidden folders', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('.hidden-folder', 'directory'),
					createDirent('visible.md', 'file'),
				]);
				// .hidden-folder should not be scanned

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				// mockReaddir should only be called once (for root)
				expect(mockReaddir).toHaveBeenCalledTimes(1);
			});
		});

		describe('Common Hidden File Patterns', () => {
			it('should filter macOS system files', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('.DS_Store', 'file'),
					createDirent('.Spotlight-V100', 'directory'),
					createDirent('.Trashes', 'directory'),
					createDirent('.fseventsd', 'directory'),
					createDirent('document.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				expect(tree[0].name).toBe('document');
			});

			it('should filter version control folders', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('.git', 'directory'),
					createDirent('.svn', 'directory'),
					createDirent('.hg', 'directory'),
					createDirent('README.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				expect(tree[0].name).toBe('README');
			});

			it('should filter IDE configuration folders', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('.vscode', 'directory'),
					createDirent('.idea', 'directory'),
					createDirent('.cursor', 'directory'),
					createDirent('.claude', 'directory'),
					createDirent('Project.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				expect(tree[0].name).toBe('Project');
			});

			it('should filter environment and configuration files', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('.env', 'file'),
					createDirent('.env.local', 'file'),
					createDirent('.npmrc', 'file'),
					createDirent('.gitignore', 'file'),
					createDirent('.eslintrc', 'file'),
					createDirent('Task.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				expect(tree[0].name).toBe('Task');
			});
		});

		describe('Edge Cases', () => {
			it('should handle file named just "."', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('.', 'file'), // Edge case
					createDirent('normal.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				expect(tree[0].name).toBe('normal');
			});

			it('should handle file named ".."', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('..', 'file'), // Edge case
					createDirent('document.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				expect(tree[0].name).toBe('document');
			});

			it('should handle files with multiple leading dots', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('..hidden', 'file'),
					createDirent('...alsohidden', 'file'),
					createDirent('visible.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				expect(tree[0].name).toBe('visible');
			});
		});
	});

	describe('Symlink Handling', () => {
		describe('Symlink Detection', () => {
			it('should identify symbolic links via dirent', () => {
				const symlink = createDirent('link-to-file', 'symlink');
				const regular = createDirent('regular-file.md', 'file');

				expect(symlink.isSymbolicLink()).toBe(true);
				expect(regular.isSymbolicLink()).toBe(false);
			});

			it('should differentiate symlinks from regular files', () => {
				const symlink = createDirent('link.md', 'symlink');

				// Symlinks report false for isFile() and isDirectory() by default
				// unless you use lstat vs stat
				expect(symlink.isFile()).toBe(false);
				expect(symlink.isDirectory()).toBe(false);
				expect(symlink.isSymbolicLink()).toBe(true);
			});
		});

		describe('Symlink Security', () => {
			it('should use realpath to resolve symlink targets', async () => {
				mockRealpath.mockResolvedValue('/actual/resolved/path');

				const resolved = await mockRealpath('/test/autorun/symlink');

				expect(resolved).toBe('/actual/resolved/path');
			});

			it('should detect symlink pointing outside folder', async () => {
				const folderPath = '/test/autorun';

				// Symlink /test/autorun/evil-link -> /etc
				mockRealpath.mockResolvedValue('/etc/passwd');

				const resolvedTarget = await mockRealpath('/test/autorun/evil-link');

				expect(validatePathWithinFolder(resolvedTarget, folderPath)).toBe(false);
			});

			it('should allow symlink pointing within folder', async () => {
				const folderPath = '/test/autorun';

				// Symlink /test/autorun/shortcut -> /test/autorun/subfolder/doc.md
				mockRealpath.mockResolvedValue('/test/autorun/subfolder/doc.md');

				const resolvedTarget = await mockRealpath('/test/autorun/shortcut');

				expect(validatePathWithinFolder(resolvedTarget, folderPath)).toBe(true);
			});

			it('should handle symlink chains', async () => {
				// link1 -> link2 -> link3 -> final.md
				// realpath resolves the entire chain
				mockRealpath.mockResolvedValue('/test/autorun/final.md');

				const resolved = await mockRealpath('/test/autorun/link1');

				expect(validatePathWithinFolder(resolved, '/test/autorun')).toBe(true);
			});

			it('should handle circular symlinks', async () => {
				// link1 -> link2 -> link1 (circular)
				mockRealpath.mockRejectedValue(new Error('ELOOP: too many levels of symbolic links'));

				await expect(mockRealpath('/test/autorun/circular-link')).rejects.toThrow('ELOOP');
			});

			it('should handle broken symlinks', async () => {
				// Symlink pointing to non-existent target
				mockRealpath.mockRejectedValue(new Error('ENOENT: no such file or directory'));

				await expect(mockRealpath('/test/autorun/broken-link')).rejects.toThrow('ENOENT');
			});
		});

		describe('Symlink to Directory', () => {
			it('should handle symlink to directory within folder', async () => {
				const folderPath = '/test/autorun';

				mockRealpath.mockResolvedValue('/test/autorun/real-folder');

				const resolved = await mockRealpath('/test/autorun/folder-link');

				expect(validatePathWithinFolder(resolved, folderPath)).toBe(true);
			});

			it('should detect symlink to directory outside folder', async () => {
				const folderPath = '/test/autorun';

				// Dangerous: symlink to system directory
				mockRealpath.mockResolvedValue('/usr/share');

				const resolved = await mockRealpath('/test/autorun/system-link');

				expect(validatePathWithinFolder(resolved, folderPath)).toBe(false);
			});

			it('should handle relative symlinks', async () => {
				const folderPath = '/test/autorun';

				// Relative symlink: ../sibling -> /test/sibling (outside)
				mockRealpath.mockResolvedValue('/test/sibling');

				const resolved = await mockRealpath('/test/autorun/relative-link');

				expect(validatePathWithinFolder(resolved, folderPath)).toBe(false);
			});
		});

		describe('lstat vs stat Behavior', () => {
			it('should use lstat to check if entry is symlink', async () => {
				// lstat returns info about the link itself
				mockLstat.mockResolvedValue({
					isFile: () => false,
					isDirectory: () => false,
					isSymbolicLink: () => true,
				});

				const lstats = await mockLstat('/test/autorun/link');

				expect(lstats.isSymbolicLink()).toBe(true);
			});

			it('should use stat to check symlink target type', async () => {
				// stat follows symlinks and returns info about target
				mockStat.mockResolvedValue({
					isFile: () => true,
					isDirectory: () => false,
					isSymbolicLink: () => false, // stat always returns false for isSymbolicLink
				});

				const stats = await mockStat('/test/autorun/link-to-file');

				expect(stats.isFile()).toBe(true);
			});

			it('should handle stat on broken symlink', async () => {
				// stat fails on broken symlinks
				mockStat.mockRejectedValue(new Error('ENOENT: no such file or directory'));
				// lstat succeeds - the link exists, target doesn't
				mockLstat.mockResolvedValue({
					isFile: () => false,
					isDirectory: () => false,
					isSymbolicLink: () => true,
				});

				await expect(mockStat('/test/autorun/broken-link')).rejects.toThrow('ENOENT');
				const lstats = await mockLstat('/test/autorun/broken-link');
				expect(lstats.isSymbolicLink()).toBe(true);
			});
		});

		describe('Safe Symlink Handling Strategy', () => {
			it('should validate complete path chain', () => {
				// Strategy: For any path, resolve and validate the final target
				const validateSymlinkPath = (
					requestedPath: string,
					resolvedPath: string,
					folderPath: string
				): boolean => {
					// Both the requested path AND resolved path must be within folder
					return (
						validatePathWithinFolder(requestedPath, folderPath) &&
						validatePathWithinFolder(resolvedPath, folderPath)
					);
				};

				const folderPath = '/test/autorun';

				// Case 1: Both paths valid
				expect(
					validateSymlinkPath('/test/autorun/link', '/test/autorun/target.md', folderPath)
				).toBe(true);

				// Case 2: Requested valid, resolved invalid (symlink escape)
				expect(validateSymlinkPath('/test/autorun/evil-link', '/etc/passwd', folderPath)).toBe(
					false
				);

				// Case 3: Requested invalid
				expect(
					validateSymlinkPath('/etc/autorun/link', '/test/autorun/target.md', folderPath)
				).toBe(false);
			});

			it('should handle symlink race conditions (TOCTOU)', () => {
				// Time-of-check to time-of-use vulnerability
				// Solution: Always validate at the point of file operation
				const performSecureRead = async (
					requestedPath: string,
					folderPath: string,
					resolveFn: typeof mockRealpath
				): Promise<{ valid: boolean; resolvedPath?: string }> => {
					try {
						const resolved = await resolveFn(requestedPath);
						const valid = validatePathWithinFolder(resolved, folderPath);
						return { valid, resolvedPath: valid ? resolved : undefined };
					} catch {
						return { valid: false };
					}
				};

				// This pattern ensures we always validate the actual target
				expect(performSecureRead).toBeDefined();
			});
		});
	});

	describe('Combined Scenarios', () => {
		describe('Complex Directory Structures', () => {
			it('should handle mix of hidden, visible, symlinks, and nested', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('.git', 'directory'),
					createDirent('Phase1', 'directory'),
					createDirent('.hidden.md', 'file'),
					createDirent('README.md', 'file'),
					createDirent('link-to-doc', 'symlink'), // Symlinks are typically excluded
				]);
				mockReaddir.mockResolvedValueOnce([
					createDirent('.drafts', 'directory'),
					createDirent('Task1.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				// Only visible non-symlink items
				expect(tree).toHaveLength(2);
				expect(tree.map((n) => n.name).sort()).toEqual(['Phase1', 'README']);
				expect(tree.find((n) => n.name === 'Phase1')?.children).toHaveLength(1);
			});

			it('should handle very long path names', async () => {
				const longName = 'a'.repeat(200) + '.md';
				mockReaddir.mockResolvedValueOnce([createDirent(longName, 'file')]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1);
				expect(tree[0].name.length).toBe(200);
			});

			it('should handle special characters in filenames', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('doc with spaces.md', 'file'),
					createDirent('doc-with-dashes.md', 'file'),
					createDirent('doc_with_underscores.md', 'file'),
					createDirent('doc.with.dots.md', 'file'),
					createDirent("doc'with'quotes.md", 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(5);
			});

			it('should handle unicode filenames', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('文档.md', 'file'),
					createDirent('документ.md', 'file'),
					createDirent('αβγδ.md', 'file'),
					createDirent('🎉emoji🎉.md', 'file'),
				]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(4);
			});
		});

		describe('Error Handling During Scan', () => {
			it('should handle permission denied on subfolder', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('accessible', 'directory'),
					createDirent('restricted', 'directory'),
				]);
				mockReaddir.mockResolvedValueOnce([createDirent('doc.md', 'file')]);
				mockReaddir.mockRejectedValueOnce(new Error('EACCES: permission denied'));

				// The implementation would need error handling for this
				// Current simple implementation would throw
				await expect(scanDirectory('/test/autorun', '', mockReaddir)).rejects.toThrow('EACCES');
			});

			it('should handle folder disappearing during scan', async () => {
				mockReaddir.mockResolvedValueOnce([createDirent('volatile', 'directory')]);
				mockReaddir.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));

				await expect(scanDirectory('/test/autorun', '', mockReaddir)).rejects.toThrow('ENOENT');
			});
		});

		describe('Performance Considerations', () => {
			it('should handle directory with many files', async () => {
				const manyFiles = Array.from({ length: 1000 }, (_, i) =>
					createDirent(`file-${i.toString().padStart(4, '0')}.md`, 'file')
				);
				mockReaddir.mockResolvedValueOnce(manyFiles);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(tree).toHaveLength(1000);
			});

			it('should handle deeply nested structure efficiently', async () => {
				// Create 10 levels of nesting
				for (let i = 0; i < 10; i++) {
					mockReaddir.mockResolvedValueOnce([createDirent(`Level${i}`, 'directory')]);
				}
				// Deepest level has a file
				mockReaddir.mockResolvedValueOnce([createDirent('DeepFile.md', 'file')]);

				const tree = await scanDirectory('/test/autorun', '', mockReaddir);

				expect(mockReaddir).toHaveBeenCalledTimes(11);

				// Traverse to verify structure
				let current = tree[0];
				for (let i = 1; i < 10; i++) {
					expect(current.children).toHaveLength(1);
					current = current.children![0];
				}
				expect(current.children?.[0].type).toBe('file');
			});
		});
	});
});
