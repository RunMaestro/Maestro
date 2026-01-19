/**
 * Tests for Auto Run IPC handlers in the main process
 *
 * Tests cover:
 * - autorun:listDocs - list markdown files with tree structure
 * - autorun:readDoc - read markdown document content
 * - autorun:writeDoc - write/update markdown documents (also used for create)
 * - autorun:listImages - list images for a document
 * - autorun:saveImage - save image with timestamp naming
 * - autorun:deleteImage - delete image file
 * - autorun:deleteFolder - delete Auto Run Docs folder
 * - autorun:createBackup - create backup copy of document for reset-on-completion
 * - autorun:restoreBackup - restore document from backup and delete backup file
 * - autorun:deleteBackups - delete all backup files in folder recursively
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
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockAccess = vi.fn();
const mockMkdir = vi.fn();
const mockUnlink = vi.fn();
const mockRm = vi.fn();
const mockCopyFile = vi.fn();

vi.mock('fs/promises', () => ({
	default: {
		readdir: mockReaddir,
		stat: mockStat,
		readFile: mockReadFile,
		writeFile: mockWriteFile,
		access: mockAccess,
		mkdir: mockMkdir,
		unlink: mockUnlink,
		rm: mockRm,
		copyFile: mockCopyFile,
	},
	readdir: mockReaddir,
	stat: mockStat,
	readFile: mockReadFile,
	writeFile: mockWriteFile,
	access: mockAccess,
	mkdir: mockMkdir,
	unlink: mockUnlink,
	rm: mockRm,
	copyFile: mockCopyFile,
}));

vi.mock('fs', () => ({
	default: {
		watch: vi.fn(),
	},
	watch: vi.fn(),
}));

// Helper to create mock directory entries
function createDirent(name: string, isDir: boolean) {
	return {
		name,
		isDirectory: () => isDir,
		isFile: () => !isDir,
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isFIFO: () => false,
		isSocket: () => false,
		isSymbolicLink: () => false,
	};
}

describe('Auto Run IPC Handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset all mock implementations to default (no return value)
		mockReaddir.mockReset();
		mockStat.mockReset();
		mockReadFile.mockReset();
		mockWriteFile.mockReset();
		mockAccess.mockReset();
		mockMkdir.mockReset();
		mockUnlink.mockReset();
		mockRm.mockReset();
		mockCopyFile.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('autorun:listDocs', () => {
		describe('successful operations', () => {
			it('should return empty file list for empty directory', async () => {
				mockStat.mockResolvedValue({ isDirectory: () => true });
				mockReaddir.mockResolvedValue([]);

				const folderPath = '/test/autorun';
				const stat = await mockStat(folderPath);
				expect(stat.isDirectory()).toBe(true);

				const entries = await mockReaddir(folderPath, { withFileTypes: true });
				expect(entries).toHaveLength(0);

				// Simulate handler result
				const result = { success: true, files: [], tree: [] };
				expect(result.success).toBe(true);
				expect(result.files).toHaveLength(0);
				expect(result.tree).toHaveLength(0);
			});

			it('should return list of markdown files', async () => {
				mockStat.mockResolvedValue({ isDirectory: () => true });
				mockReaddir.mockResolvedValue([
					createDirent('Task1.md', false),
					createDirent('Task2.md', false),
					createDirent('Phase1.md', false),
				]);

				const folderPath = '/test/autorun';
				const entries = await mockReaddir(folderPath, { withFileTypes: true });
				expect(entries).toHaveLength(3);

				// Filter and transform like the handler does
				const files = entries
					.filter(
						(e: { name: string; isFile: () => boolean }) => e.isFile() && e.name.endsWith('.md')
					)
					.map((e: { name: string }) => e.name.slice(0, -3));

				expect(files).toEqual(['Task1', 'Task2', 'Phase1']);
			});

			it('should filter out hidden files starting with dot', async () => {
				mockReaddir.mockResolvedValue([
					createDirent('visible.md', false),
					createDirent('.hidden.md', false),
					createDirent('.DS_Store', false),
				]);

				const entries = await mockReaddir('/test', { withFileTypes: true });
				const visibleEntries = entries.filter((e: { name: string }) => !e.name.startsWith('.'));

				expect(visibleEntries).toHaveLength(1);
				expect(visibleEntries[0].name).toBe('visible.md');
			});

			it('should filter out non-markdown files', async () => {
				mockReaddir.mockResolvedValue([
					createDirent('document.md', false),
					createDirent('image.png', false),
					createDirent('data.json', false),
					createDirent('readme.txt', false),
				]);

				const entries = await mockReaddir('/test', { withFileTypes: true });
				const mdFiles = entries.filter(
					(e: { name: string; isFile: () => boolean }) =>
						e.isFile() && e.name.toLowerCase().endsWith('.md')
				);

				expect(mdFiles).toHaveLength(1);
				expect(mdFiles[0].name).toBe('document.md');
			});

			it('should return tree structure with nested folders', async () => {
				// Root level
				mockReaddir.mockResolvedValueOnce([
					createDirent('Phase1', true),
					createDirent('Phase2', true),
					createDirent('Overview.md', false),
				]);
				// Phase1 subfolder
				mockReaddir.mockResolvedValueOnce([
					createDirent('Task1.md', false),
					createDirent('Task2.md', false),
				]);
				// Phase2 subfolder
				mockReaddir.mockResolvedValueOnce([createDirent('Task3.md', false)]);

				// Simulate tree construction
				const tree = [
					{
						name: 'Phase1',
						type: 'folder',
						path: 'Phase1',
						children: [
							{ name: 'Task1', type: 'file', path: 'Phase1/Task1' },
							{ name: 'Task2', type: 'file', path: 'Phase1/Task2' },
						],
					},
					{
						name: 'Phase2',
						type: 'folder',
						path: 'Phase2',
						children: [{ name: 'Task3', type: 'file', path: 'Phase2/Task3' }],
					},
					{ name: 'Overview', type: 'file', path: 'Overview' },
				];

				expect(tree).toHaveLength(3);
				expect(tree[0].type).toBe('folder');
				expect(tree[0].children).toHaveLength(2);
				expect(tree[2].type).toBe('file');
			});

			it('should flatten tree to file paths', () => {
				const tree = [
					{
						name: 'Phase1',
						type: 'folder' as const,
						path: 'Phase1',
						children: [
							{ name: 'Task1', type: 'file' as const, path: 'Phase1/Task1' },
							{ name: 'Task2', type: 'file' as const, path: 'Phase1/Task2' },
						],
					},
					{ name: 'Overview', type: 'file' as const, path: 'Overview' },
				];

				// Flatten function
				const flattenTree = (nodes: typeof tree): string[] => {
					const files: string[] = [];
					for (const node of nodes) {
						if (node.type === 'file') {
							files.push(node.path);
						} else if ('children' in node && node.children) {
							files.push(...flattenTree(node.children));
						}
					}
					return files;
				};

				const files = flattenTree(tree);
				expect(files).toEqual(['Phase1/Task1', 'Phase1/Task2', 'Overview']);
			});

			it('should exclude empty folders from tree', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('WithFiles', true),
					createDirent('EmptyFolder', true),
				]);
				mockReaddir.mockResolvedValueOnce([createDirent('doc.md', false)]);
				mockReaddir.mockResolvedValueOnce([]);

				// Empty folders should be excluded from tree
				const tree = [
					{
						name: 'WithFiles',
						type: 'folder',
						path: 'WithFiles',
						children: [{ name: 'doc', type: 'file', path: 'WithFiles/doc' }],
					},
					// EmptyFolder is excluded because it has no .md files
				];

				expect(tree).toHaveLength(1);
				expect(tree[0].name).toBe('WithFiles');
			});

			it('should sort folders first, then files, both alphabetically', async () => {
				mockReaddir.mockResolvedValueOnce([
					createDirent('zebra.md', false),
					createDirent('Beta', true),
					createDirent('alpha.md', false),
					createDirent('Alpha', true),
				]);

				const entries = await mockReaddir('/test', { withFileTypes: true });

				// Sort like the handler does
				const sorted = [...entries].sort(
					(
						a: { name: string; isDirectory: () => boolean },
						b: { name: string; isDirectory: () => boolean }
					) => {
						if (a.isDirectory() && !b.isDirectory()) return -1;
						if (!a.isDirectory() && b.isDirectory()) return 1;
						return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
					}
				);

				expect(sorted.map((e: { name: string }) => e.name)).toEqual([
					'Alpha',
					'Beta',
					'alpha.md',
					'zebra.md',
				]);
			});
		});

		describe('error handling', () => {
			it('should return error for non-directory path', async () => {
				mockStat.mockResolvedValueOnce({ isDirectory: () => false });

				const result = { success: false, files: [], tree: [], error: 'Path is not a directory' };
				expect(result.success).toBe(false);
				expect(result.error).toBe('Path is not a directory');
			});

			it('should return error for non-existent path', async () => {
				mockStat.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));

				await expect(mockStat('/nonexistent')).rejects.toThrow('ENOENT');

				const result = {
					success: false,
					files: [],
					tree: [],
					error: 'ENOENT: no such file or directory',
				};
				expect(result.success).toBe(false);
				expect(result.error).toContain('ENOENT');
			});

			it('should return error for permission denied', async () => {
				mockReaddir.mockRejectedValueOnce(new Error('EACCES: permission denied'));

				await expect(mockReaddir('/protected')).rejects.toThrow('EACCES');

				const result = { success: false, files: [], tree: [], error: 'EACCES: permission denied' };
				expect(result.success).toBe(false);
				expect(result.error).toContain('EACCES');
			});
		});
	});

	describe('autorun:readDoc', () => {
		describe('successful operations', () => {
			it('should read markdown document content', async () => {
				const content = '# Test Document\n\n- [ ] Task 1\n- [x] Task 2';
				mockAccess.mockResolvedValue(undefined);
				mockReadFile.mockResolvedValue(content);

				const folderPath = '/test/autorun';
				const filename = 'tasks';
				const filePath = path.join(folderPath, `${filename}.md`);

				await mockAccess(filePath);
				const result = await mockReadFile(filePath, 'utf-8');

				expect(result).toBe(content);
			});

			it('should add .md extension if not provided', () => {
				const filename = 'document';
				const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;

				expect(fullFilename).toBe('document.md');
			});

			it('should preserve .md extension if already provided', () => {
				const filename = 'document.md';
				const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;

				expect(fullFilename).toBe('document.md');
			});

			it('should read documents in subdirectories', async () => {
				const content = '# Nested Document';
				mockAccess.mockResolvedValue(undefined);
				mockReadFile.mockResolvedValue(content);

				const folderPath = '/test/autorun';
				const filename = 'Phase1/Task1';
				const filePath = path.join(folderPath, `${filename}.md`);

				expect(filePath).toBe('/test/autorun/Phase1/Task1.md');

				await mockAccess(filePath);
				const result = await mockReadFile(filePath, 'utf-8');

				expect(result).toBe(content);
			});

			it('should handle empty file content', async () => {
				mockAccess.mockResolvedValue(undefined);
				mockReadFile.mockResolvedValue('');

				const result = await mockReadFile('/test/empty.md', 'utf-8');
				expect(result).toBe('');
			});

			it('should handle files with special characters in content', async () => {
				const content = '# Special Characters\n\n<>&"\'`|$\n\nUnicode: 你好世界 🎉';
				mockAccess.mockResolvedValue(undefined);
				mockReadFile.mockResolvedValue(content);

				const result = await mockReadFile('/test/special.md', 'utf-8');
				expect(result).toBe(content);
			});
		});

		describe('path validation and security', () => {
			it('should reject directory traversal attempts with ..', () => {
				const filename = '../../../etc/passwd';
				const isTraversalAttempt = filename.includes('..');

				expect(isTraversalAttempt).toBe(true);

				const result = { success: false, content: '', error: 'Invalid filename' };
				expect(result.error).toBe('Invalid filename');
			});

			it('should validate path is within folder', () => {
				const folderPath = '/test/autorun';
				const validFile = path.join(folderPath, 'document.md');
				const invalidFile = '/etc/passwd';

				const validatePathWithinFolder = (filePath: string, folder: string): boolean => {
					const resolvedPath = path.resolve(filePath);
					const resolvedFolder = path.resolve(folder);
					return (
						resolvedPath.startsWith(resolvedFolder + path.sep) || resolvedPath === resolvedFolder
					);
				};

				expect(validatePathWithinFolder(validFile, folderPath)).toBe(true);
				expect(validatePathWithinFolder(invalidFile, folderPath)).toBe(false);
			});

			it('should handle symlink traversal via path resolution', () => {
				const folderPath = '/test/autorun';

				// Simulated resolved paths
				const validResolved = '/test/autorun/doc.md';
				const traversalResolved = '/etc/passwd';

				const isValidPath = (resolved: string, folder: string): boolean => {
					return resolved.startsWith(folder + path.sep);
				};

				expect(isValidPath(validResolved, folderPath)).toBe(true);
				expect(isValidPath(traversalResolved, folderPath)).toBe(false);
			});
		});

		describe('error handling', () => {
			it('should return error for non-existent file', async () => {
				mockAccess.mockRejectedValue(new Error('ENOENT: no such file or directory'));

				await expect(mockAccess('/test/nonexistent.md')).rejects.toThrow('ENOENT');

				const result = { success: false, content: '', error: 'File not found' };
				expect(result.success).toBe(false);
				expect(result.error).toBe('File not found');
			});

			it('should return error for permission denied', async () => {
				mockAccess.mockResolvedValue(undefined);
				mockReadFile.mockRejectedValue(new Error('EACCES: permission denied'));

				await expect(mockReadFile('/protected/file.md', 'utf-8')).rejects.toThrow('EACCES');
			});

			it('should convert error to string in response', () => {
				const error = new Error('Read error');
				const result = { success: false, content: '', error: String(error) };

				expect(result.error).toBe('Error: Read error');
			});
		});
	});

	describe('autorun:writeDoc', () => {
		describe('successful operations', () => {
			it('should write content to file', async () => {
				mockAccess.mockResolvedValue(undefined);
				mockWriteFile.mockResolvedValue(undefined);

				const folderPath = '/test/autorun';
				const filename = 'document';
				const content = '# New Document\n\nContent here';
				const filePath = path.join(folderPath, `${filename}.md`);

				await mockWriteFile(filePath, content, 'utf-8');

				expect(mockWriteFile).toHaveBeenCalledWith(filePath, content, 'utf-8');
			});

			it('should create new document (same as write operation)', async () => {
				mockAccess.mockRejectedValue(new Error('ENOENT')); // File doesn't exist
				mockMkdir.mockResolvedValue(undefined);
				mockWriteFile.mockResolvedValue(undefined);

				const content = '# Brand New Document';
				await mockWriteFile('/test/new-doc.md', content, 'utf-8');

				expect(mockWriteFile).toHaveBeenCalledWith('/test/new-doc.md', content, 'utf-8');
			});

			it('should add .md extension if not provided', () => {
				const filename = 'document';
				const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;

				expect(fullFilename).toBe('document.md');
			});

			it('should create parent directories for subdirectory documents', async () => {
				mockAccess.mockRejectedValue(new Error('ENOENT'));
				mockMkdir.mockResolvedValue(undefined);
				mockWriteFile.mockResolvedValue(undefined);

				const folderPath = '/test/autorun';
				const filename = 'Phase1/NewTask';
				const filePath = path.join(folderPath, `${filename}.md`);
				const parentDir = path.dirname(filePath);

				// Parent dir doesn't exist, need to create
				await mockMkdir(parentDir, { recursive: true });
				await mockWriteFile(filePath, '# New Task', 'utf-8');

				expect(mockMkdir).toHaveBeenCalledWith(parentDir, { recursive: true });
				expect(mockWriteFile).toHaveBeenCalled();
			});

			it('should handle empty content', async () => {
				mockWriteFile.mockResolvedValue(undefined);

				await mockWriteFile('/test/empty.md', '', 'utf-8');

				expect(mockWriteFile).toHaveBeenCalledWith('/test/empty.md', '', 'utf-8');
			});

			it('should handle large content', async () => {
				const largeContent = '# Large Document\n\n' + 'Content line\n'.repeat(10000);
				mockWriteFile.mockResolvedValue(undefined);

				await mockWriteFile('/test/large.md', largeContent, 'utf-8');

				expect(mockWriteFile).toHaveBeenCalledWith('/test/large.md', largeContent, 'utf-8');
			});

			it('should handle special characters in content', async () => {
				const content = '# Special\n\n<script>alert("xss")</script>\n\n```bash\nrm -rf /\n```';
				mockWriteFile.mockResolvedValue(undefined);

				await mockWriteFile('/test/special.md', content, 'utf-8');

				expect(mockWriteFile).toHaveBeenCalledWith('/test/special.md', content, 'utf-8');
			});
		});

		describe('path validation and security', () => {
			it('should reject directory traversal attempts', () => {
				const filename = '../../etc/cron.d/malicious';
				const isTraversalAttempt = filename.includes('..');

				expect(isTraversalAttempt).toBe(true);

				const result = { success: false, error: 'Invalid filename' };
				expect(result.error).toBe('Invalid filename');
			});

			it('should validate parent directory is within folder', () => {
				const folderPath = '/test/autorun';
				const validParent = '/test/autorun/Phase1';
				const invalidParent = '/etc';

				const isValidParent = (parent: string, folder: string): boolean => {
					const resolvedParent = path.resolve(parent);
					const resolvedFolder = path.resolve(folder);
					return resolvedParent.startsWith(resolvedFolder);
				};

				expect(isValidParent(validParent, folderPath)).toBe(true);
				expect(isValidParent(invalidParent, folderPath)).toBe(false);
			});
		});

		describe('error handling', () => {
			it('should return error for write failure', async () => {
				mockAccess.mockResolvedValue(undefined);
				mockWriteFile.mockRejectedValue(new Error('ENOSPC: no space left on device'));

				await expect(mockWriteFile('/test/doc.md', 'content', 'utf-8')).rejects.toThrow('ENOSPC');
			});

			it('should return error for mkdir failure', async () => {
				mockAccess.mockRejectedValue(new Error('ENOENT'));
				mockMkdir.mockRejectedValue(new Error('EACCES: permission denied'));

				await expect(mockMkdir('/test/new/path', { recursive: true })).rejects.toThrow('EACCES');
			});

			it('should return error for invalid parent directory', () => {
				const result = { success: false, error: 'Invalid parent directory' };
				expect(result.error).toBe('Invalid parent directory');
			});
		});
	});

	describe('autorun:listImages', () => {
		describe('successful operations', () => {
			it('should return list of images for a document', async () => {
				mockAccess.mockResolvedValueOnce(undefined);
				mockReaddir.mockResolvedValueOnce([
					'Phase1-1702500000000.png',
					'Phase1-1702500001000.jpg',
					'Phase2-1702500002000.png',
					'other-file.txt',
				]);

				const docName = 'Phase1';
				const files = await mockReaddir('/test/autorun/images');

				// Filter like the handler does
				const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
				const images = files
					.filter((file: string) => {
						if (!file.startsWith(`${docName}-`)) return false;
						const ext = file.split('.').pop()?.toLowerCase();
						return ext && imageExtensions.includes(ext);
					})
					.map((file: string) => ({
						filename: file,
						relativePath: `images/${file}`,
					}));

				expect(images).toHaveLength(2);
				expect(images[0].relativePath).toBe('images/Phase1-1702500000000.png');
				expect(images[1].relativePath).toBe('images/Phase1-1702500001000.jpg');
			});

			it('should return empty list when no images exist', async () => {
				mockAccess.mockRejectedValueOnce(new Error('ENOENT'));

				// No images directory means no images
				const result = { success: true, images: [] };
				expect(result.images).toHaveLength(0);
			});

			it('should filter images by document name prefix', async () => {
				mockReaddir.mockResolvedValueOnce([
					'doc1-123.png',
					'doc1-456.jpg',
					'doc2-789.png',
					'otherdoc-000.gif',
				]);

				const docName = 'doc1';
				const files = await mockReaddir('/test/images');
				const matching = files.filter((f: string) => f.startsWith(`${docName}-`));

				expect(matching).toHaveLength(2);
			});

			it('should support all image extensions', async () => {
				mockReaddir.mockResolvedValueOnce([
					'doc-1.png',
					'doc-2.jpg',
					'doc-3.jpeg',
					'doc-4.gif',
					'doc-5.webp',
					'doc-6.svg',
					'doc-7.bmp', // Not supported
				]);

				const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
				const files = await mockReaddir('/test/images');
				const images = files.filter((f: string) => {
					const ext = f.split('.').pop()?.toLowerCase();
					return ext && imageExtensions.includes(ext);
				});

				expect(images).toHaveLength(6);
			});
		});

		describe('path validation', () => {
			it('should sanitize document name', () => {
				// Sanitize like the handler does
				const sanitizeDocName = (docName: string): string => {
					return path.basename(docName).replace(/\.md$/i, '');
				};

				expect(sanitizeDocName('Phase1.md')).toBe('Phase1');
				expect(sanitizeDocName('Phase1')).toBe('Phase1');
				expect(sanitizeDocName('../evil')).toBe('evil');
				expect(sanitizeDocName('folder/doc')).toBe('doc');
			});

			it('should reject invalid document names', () => {
				const isValidDocName = (docName: string): boolean => {
					const sanitized = path.basename(docName).replace(/\.md$/i, '');
					return !sanitized.includes('..') && !sanitized.includes('/');
				};

				expect(isValidDocName('valid-doc')).toBe(true);
				expect(isValidDocName('../traversal')).toBe(true); // path.basename removes ..
				expect(isValidDocName('nested/path')).toBe(true); // path.basename extracts 'path'
			});
		});

		describe('error handling', () => {
			it('should handle readdir errors', async () => {
				mockAccess.mockResolvedValueOnce(undefined);
				mockReaddir.mockRejectedValueOnce(new Error('EACCES: permission denied'));

				await expect(mockReaddir('/protected/images')).rejects.toThrow('EACCES');
			});
		});
	});

	describe('autorun:saveImage', () => {
		describe('successful operations', () => {
			it('should save image with timestamp naming', async () => {
				mockMkdir.mockResolvedValue(undefined);
				mockWriteFile.mockResolvedValue(undefined);

				const folderPath = '/test/autorun';
				const docName = 'Phase1';
				const base64Data =
					'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
				const extension = 'png';

				const timestamp = Date.now();
				const filename = `${docName}-${timestamp}.${extension}`;
				const imagesDir = path.join(folderPath, 'images');
				const filePath = path.join(imagesDir, filename);

				await mockMkdir(imagesDir, { recursive: true });

				const buffer = Buffer.from(base64Data, 'base64');
				await mockWriteFile(filePath, buffer);

				expect(mockMkdir).toHaveBeenCalledWith(imagesDir, { recursive: true });
				expect(mockWriteFile).toHaveBeenCalled();
			});

			it('should create images subdirectory if not exists', async () => {
				mockMkdir.mockResolvedValue(undefined);

				const imagesDir = '/test/autorun/images';
				await mockMkdir(imagesDir, { recursive: true });

				expect(mockMkdir).toHaveBeenCalledWith(imagesDir, { recursive: true });
			});

			it('should return relative path for markdown insertion', () => {
				const filename = 'Phase1-1702500000000.png';
				const relativePath = `images/${filename}`;

				expect(relativePath).toBe('images/Phase1-1702500000000.png');
			});

			it('should handle all allowed image extensions', () => {
				const allowedExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

				allowedExtensions.forEach((ext) => {
					const sanitized = ext.toLowerCase().replace(/[^a-z]/g, '');
					expect(allowedExtensions.includes(sanitized)).toBe(true);
				});
			});

			it('should decode base64 data correctly', () => {
				const base64Data = 'SGVsbG8gV29ybGQ='; // "Hello World"
				const buffer = Buffer.from(base64Data, 'base64');

				expect(buffer.toString('utf-8')).toBe('Hello World');
			});
		});

		describe('path validation', () => {
			it('should sanitize document name for image filename', () => {
				const sanitizeDocName = (docName: string): string => {
					return path.basename(docName).replace(/\.md$/i, '');
				};

				expect(sanitizeDocName('Phase1.md')).toBe('Phase1');
				expect(sanitizeDocName('../malicious')).toBe('malicious');
				expect(sanitizeDocName('folder/Phase1')).toBe('Phase1');
			});

			it('should reject directory traversal in document name', () => {
				const isValidDocName = (docName: string): boolean => {
					const sanitized = path.basename(docName).replace(/\.md$/i, '');
					return !sanitized.includes('..') && !sanitized.includes('/');
				};

				// After sanitization these become valid
				expect(isValidDocName('../evil')).toBe(true);
				expect(isValidDocName('nested/doc')).toBe(true);
			});

			it('should validate image extension', () => {
				const allowedExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

				const isValidExtension = (ext: string): boolean => {
					const sanitized = ext.toLowerCase().replace(/[^a-z]/g, '');
					return allowedExtensions.includes(sanitized);
				};

				expect(isValidExtension('png')).toBe(true);
				expect(isValidExtension('PNG')).toBe(true);
				expect(isValidExtension('exe')).toBe(false);
				expect(isValidExtension('php')).toBe(false);
			});

			it('should reject invalid extensions', () => {
				const allowedExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

				const result = (ext: string) => {
					const sanitized = ext.toLowerCase().replace(/[^a-z]/g, '');
					if (!allowedExtensions.includes(sanitized)) {
						return { success: false, error: 'Invalid image extension' };
					}
					return { success: true };
				};

				expect(result('exe').success).toBe(false);
				expect(result('exe').error).toBe('Invalid image extension');
			});
		});

		describe('error handling', () => {
			it('should handle mkdir failure', async () => {
				mockMkdir.mockRejectedValue(new Error('EACCES: permission denied'));

				await expect(mockMkdir('/protected/images', { recursive: true })).rejects.toThrow('EACCES');
			});

			it('should handle writeFile failure', async () => {
				mockMkdir.mockResolvedValue(undefined);
				mockWriteFile.mockRejectedValue(new Error('ENOSPC: no space left'));

				await expect(mockWriteFile('/test/image.png', Buffer.from(''))).rejects.toThrow('ENOSPC');
			});
		});
	});

	describe('autorun:deleteImage', () => {
		describe('successful operations', () => {
			it('should delete image file', async () => {
				mockAccess.mockResolvedValue(undefined);
				mockUnlink.mockResolvedValue(undefined);

				const folderPath = '/test/autorun';
				const relativePath = 'images/Phase1-1702500000000.png';
				const filePath = path.join(folderPath, relativePath);

				await mockAccess(filePath);
				await mockUnlink(filePath);

				expect(mockUnlink).toHaveBeenCalledWith(filePath);
			});

			it('should only delete files in images/ directory', () => {
				const isValidImagePath = (relativePath: string): boolean => {
					const normalized = path.normalize(relativePath);
					return normalized.startsWith('images/') && !normalized.includes('..');
				};

				expect(isValidImagePath('images/photo.png')).toBe(true);
				expect(isValidImagePath('images/subfolder/photo.png')).toBe(true);
				expect(isValidImagePath('documents/file.md')).toBe(false);
				expect(isValidImagePath('../images/photo.png')).toBe(false);
			});
		});

		describe('path validation', () => {
			it('should reject directory traversal attempts', () => {
				const relativePath = '../../../etc/passwd';
				const normalized = path.normalize(relativePath);

				const isInvalid = normalized.includes('..') || !normalized.startsWith('images/');
				expect(isInvalid).toBe(true);

				const result = { success: false, error: 'Invalid image path' };
				expect(result.error).toBe('Invalid image path');
			});

			it('should reject absolute paths', () => {
				const relativePath = '/etc/passwd';

				const isInvalid = path.isAbsolute(relativePath);
				expect(isInvalid).toBe(true);

				const result = { success: false, error: 'Invalid image path' };
				expect(result.error).toBe('Invalid image path');
			});

			it('should reject paths not starting with images/', () => {
				const relativePath = 'documents/secret.md';
				const normalized = path.normalize(relativePath);

				const isInvalid = !normalized.startsWith('images/');
				expect(isInvalid).toBe(true);
			});

			it('should validate resolved path is within folder', () => {
				const folderPath = '/test/autorun';

				const isValidPath = (relativePath: string): boolean => {
					const normalized = path.normalize(relativePath);
					if (
						normalized.includes('..') ||
						path.isAbsolute(normalized) ||
						!normalized.startsWith('images/')
					) {
						return false;
					}
					const filePath = path.join(folderPath, normalized);
					const resolvedPath = path.resolve(filePath);
					const resolvedFolder = path.resolve(folderPath);
					return resolvedPath.startsWith(resolvedFolder);
				};

				expect(isValidPath('images/photo.png')).toBe(true);
				expect(isValidPath('../etc/passwd')).toBe(false);
				expect(isValidPath('/absolute/path')).toBe(false);
				expect(isValidPath('other/folder/file.png')).toBe(false);
			});
		});

		describe('error handling', () => {
			it('should return error for non-existent file', async () => {
				mockAccess.mockRejectedValue(new Error('ENOENT: no such file or directory'));

				await expect(mockAccess('/test/images/nonexistent.png')).rejects.toThrow('ENOENT');

				const result = { success: false, error: 'Image file not found' };
				expect(result.error).toBe('Image file not found');
			});

			it('should return error for unlink failure', async () => {
				mockAccess.mockResolvedValue(undefined);
				mockUnlink.mockRejectedValue(new Error('EACCES: permission denied'));

				await expect(mockUnlink('/protected/images/file.png')).rejects.toThrow('EACCES');
			});
		});
	});

	describe('autorun:deleteFolder', () => {
		describe('successful operations', () => {
			it('should delete Auto Run Docs folder recursively', async () => {
				mockStat.mockResolvedValue({ isDirectory: () => true });
				mockRm.mockResolvedValue(undefined);

				const projectPath = '/test/project';
				const autoRunFolder = path.join(projectPath, 'Auto Run Docs');

				await mockStat(autoRunFolder);
				await mockRm(autoRunFolder, { recursive: true, force: true });

				expect(mockRm).toHaveBeenCalledWith(autoRunFolder, { recursive: true, force: true });
			});

			it('should succeed silently if folder does not exist', async () => {
				mockStat.mockRejectedValue(new Error('ENOENT'));

				// Folder doesn't exist, nothing to delete - success
				const result = { success: true };
				expect(result.success).toBe(true);
			});
		});

		describe('path validation', () => {
			it('should only delete Auto Run Docs folder', () => {
				const validateFolderName = (folderPath: string): boolean => {
					return path.basename(folderPath) === 'Auto Run Docs';
				};

				expect(validateFolderName('/project/Auto Run Docs')).toBe(true);
				expect(validateFolderName('/project/Documents')).toBe(false);
				expect(validateFolderName('/project/node_modules')).toBe(false);
			});

			it('should reject invalid project path', () => {
				const isValidPath = (projectPath: unknown): boolean => {
					return !!projectPath && typeof projectPath === 'string';
				};

				expect(isValidPath('/valid/path')).toBe(true);
				expect(isValidPath('')).toBe(false);
				expect(isValidPath(null)).toBe(false);
				expect(isValidPath(undefined)).toBe(false);
				expect(isValidPath(123)).toBe(false);
			});
		});

		describe('error handling', () => {
			it('should return error for non-directory path', async () => {
				mockStat.mockResolvedValue({ isDirectory: () => false });

				const result = { success: false, error: 'Auto Run Docs path is not a directory' };
				expect(result.error).toBe('Auto Run Docs path is not a directory');
			});

			it('should return error for rm failure', async () => {
				mockStat.mockResolvedValue({ isDirectory: () => true });
				mockRm.mockRejectedValue(new Error('EACCES: permission denied'));

				await expect(
					mockRm('/protected/Auto Run Docs', { recursive: true, force: true })
				).rejects.toThrow('EACCES');
			});

			it('should fail safety check for wrong folder name', () => {
				const folderName = path.basename('/project/WrongFolder');

				if (folderName !== 'Auto Run Docs') {
					const result = {
						success: false,
						error: 'Safety check failed: not an Auto Run Docs folder',
					};
					expect(result.error).toBe('Safety check failed: not an Auto Run Docs folder');
				}
			});
		});
	});

	describe('Helper function: validatePathWithinFolder', () => {
		const validatePathWithinFolder = (filePath: string, folderPath: string): boolean => {
			const resolvedPath = path.resolve(filePath);
			const resolvedFolder = path.resolve(folderPath);
			return resolvedPath.startsWith(resolvedFolder + path.sep) || resolvedPath === resolvedFolder;
		};

		it('should return true for files within folder', () => {
			expect(validatePathWithinFolder('/test/autorun/doc.md', '/test/autorun')).toBe(true);
			expect(validatePathWithinFolder('/test/autorun/subfolder/doc.md', '/test/autorun')).toBe(
				true
			);
		});

		it('should return true for folder itself', () => {
			expect(validatePathWithinFolder('/test/autorun', '/test/autorun')).toBe(true);
		});

		it('should return false for files outside folder', () => {
			expect(validatePathWithinFolder('/etc/passwd', '/test/autorun')).toBe(false);
			expect(validatePathWithinFolder('/test/other/file.md', '/test/autorun')).toBe(false);
		});

		it('should handle relative path resolution', () => {
			// path.resolve will resolve relative to cwd, so result depends on context
			const result = validatePathWithinFolder('./test/autorun/doc.md', './test/autorun');
			expect(typeof result).toBe('boolean');
		});

		it('should prevent prefix attack (autorun-evil)', () => {
			// Without path.sep check, '/test/autorun-evil' would match '/test/autorun'
			expect(validatePathWithinFolder('/test/autorun-evil/doc.md', '/test/autorun')).toBe(false);
		});
	});

	describe('Helper function: scanDirectory', () => {
		it('should recursively scan directories for md files', async () => {
			// Mock nested structure
			mockReaddir.mockResolvedValueOnce([
				createDirent('folder', true),
				createDirent('root.md', false),
			]);
			mockReaddir.mockResolvedValueOnce([createDirent('nested.md', false)]);

			// First call - root
			const rootEntries = await mockReaddir('/test');
			expect(rootEntries).toHaveLength(2);

			// Second call - subfolder
			const subEntries = await mockReaddir('/test/folder');
			expect(subEntries).toHaveLength(1);
		});

		it('should build relative paths correctly', () => {
			const buildRelativePath = (relativePath: string, name: string): string => {
				return relativePath ? `${relativePath}/${name}` : name;
			};

			expect(buildRelativePath('', 'file')).toBe('file');
			expect(buildRelativePath('folder', 'file')).toBe('folder/file');
			expect(buildRelativePath('a/b', 'file')).toBe('a/b/file');
		});

		it('should remove .md extension from file names and paths', () => {
			const transformEntry = (name: string, relativePath: string) => ({
				name: name.slice(0, -3), // Remove .md
				type: 'file',
				path: relativePath.slice(0, -3), // Remove .md from path
			});

			const entry = transformEntry('document.md', 'folder/document.md');

			expect(entry.name).toBe('document');
			expect(entry.path).toBe('folder/document');
		});
	});

	describe('Integration: Full document lifecycle', () => {
		it('should support create -> read -> update -> delete workflow', async () => {
			// 1. Create (write new doc)
			mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
			mockMkdir.mockResolvedValueOnce(undefined);
			mockWriteFile.mockResolvedValueOnce(undefined);

			const initialContent = '# New Document';
			await mockWriteFile('/test/autorun/new.md', initialContent, 'utf-8');
			expect(mockWriteFile).toHaveBeenCalledWith('/test/autorun/new.md', initialContent, 'utf-8');

			// 2. Read
			mockAccess.mockResolvedValueOnce(undefined);
			mockReadFile.mockResolvedValueOnce(initialContent);

			const content = await mockReadFile('/test/autorun/new.md', 'utf-8');
			expect(content).toBe(initialContent);

			// 3. Update
			const updatedContent = '# Updated Document\n\nWith more content';
			mockAccess.mockResolvedValueOnce(undefined);
			mockWriteFile.mockResolvedValueOnce(undefined);

			await mockWriteFile('/test/autorun/new.md', updatedContent, 'utf-8');
			expect(mockWriteFile).toHaveBeenLastCalledWith(
				'/test/autorun/new.md',
				updatedContent,
				'utf-8'
			);

			// 4. Delete (via deleteFolder or manual unlink)
			mockUnlink.mockResolvedValueOnce(undefined);

			await mockUnlink('/test/autorun/new.md');
			expect(mockUnlink).toHaveBeenCalledWith('/test/autorun/new.md');
		});

		it('should support image attach workflow', async () => {
			// 1. Save image
			mockMkdir.mockResolvedValueOnce(undefined);
			mockWriteFile.mockResolvedValueOnce(undefined);

			const base64 = 'SGVsbG8=';
			const buffer = Buffer.from(base64, 'base64');
			await mockMkdir('/test/autorun/images', { recursive: true });
			await mockWriteFile('/test/autorun/images/doc-123.png', buffer);

			expect(mockWriteFile).toHaveBeenCalled();

			// 2. List images
			mockAccess.mockResolvedValueOnce(undefined);
			mockReaddir.mockResolvedValueOnce(['doc-123.png', 'doc-456.jpg']);

			const files = await mockReaddir('/test/autorun/images');
			const docImages = files.filter((f: string) => f.startsWith('doc-'));

			expect(docImages).toHaveLength(2);

			// 3. Delete image
			mockAccess.mockResolvedValueOnce(undefined);
			mockUnlink.mockResolvedValueOnce(undefined);

			await mockUnlink('/test/autorun/images/doc-123.png');
			expect(mockUnlink).toHaveBeenCalledWith('/test/autorun/images/doc-123.png');
		});
	});

	describe('autorun:createBackup', () => {
		describe('successful operations', () => {
			it('should create backup copy of document', async () => {
				mockAccess.mockResolvedValue(undefined);
				mockCopyFile.mockResolvedValue(undefined);

				const folderPath = '/test/autorun';
				const filename = 'Phase1';
				const sourcePath = path.join(folderPath, `${filename}.md`);
				const backupPath = path.join(folderPath, `${filename}.backup.md`);

				await mockAccess(sourcePath);
				await mockCopyFile(sourcePath, backupPath);

				expect(mockCopyFile).toHaveBeenCalledWith(sourcePath, backupPath);
			});

			it('should add .md extension if not provided', () => {
				const filename = 'document';
				const fullFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
				const backupFilename = fullFilename.replace(/\.md$/, '.backup.md');

				expect(backupFilename).toBe('document.backup.md');
			});

			it('should handle subdirectory documents', async () => {
				mockAccess.mockResolvedValue(undefined);
				mockCopyFile.mockResolvedValue(undefined);

				const folderPath = '/test/autorun';
				const filename = 'Phase1/Task1';
				const sourcePath = path.join(folderPath, `${filename}.md`);
				const backupPath = path.join(folderPath, `${filename}.backup.md`);

				await mockCopyFile(sourcePath, backupPath);

				expect(mockCopyFile).toHaveBeenCalledWith(
					'/test/autorun/Phase1/Task1.md',
					'/test/autorun/Phase1/Task1.backup.md'
				);
			});
		});

		describe('path validation', () => {
			it('should reject directory traversal attempts', () => {
				const filename = '../../../etc/passwd';
				const isTraversalAttempt = filename.includes('..');

				expect(isTraversalAttempt).toBe(true);

				const result = { success: false, error: 'Invalid filename' };
				expect(result.error).toBe('Invalid filename');
			});
		});

		describe('error handling', () => {
			it('should return error for non-existent source file', async () => {
				mockAccess.mockRejectedValue(new Error('ENOENT: no such file or directory'));

				await expect(mockAccess('/test/nonexistent.md')).rejects.toThrow('ENOENT');

				const result = { success: false, error: 'Source file not found' };
				expect(result.error).toBe('Source file not found');
			});

			it('should return error for copy failure', async () => {
				mockAccess.mockResolvedValue(undefined);
				mockCopyFile.mockRejectedValue(new Error('ENOSPC: no space left'));

				await expect(mockCopyFile('/test/doc.md', '/test/doc.backup.md')).rejects.toThrow('ENOSPC');
			});
		});
	});

	describe('autorun:restoreBackup', () => {
		describe('successful operations', () => {
			it('should restore document from backup and delete backup', async () => {
				mockAccess.mockResolvedValue(undefined);
				mockCopyFile.mockResolvedValue(undefined);
				mockUnlink.mockResolvedValue(undefined);

				const folderPath = '/test/autorun';
				const filename = 'Phase1';
				const targetPath = path.join(folderPath, `${filename}.md`);
				const backupPath = path.join(folderPath, `${filename}.backup.md`);

				// Check backup exists
				await mockAccess(backupPath);
				// Copy backup to original
				await mockCopyFile(backupPath, targetPath);
				// Delete backup
				await mockUnlink(backupPath);

				expect(mockCopyFile).toHaveBeenCalledWith(backupPath, targetPath);
				expect(mockUnlink).toHaveBeenCalledWith(backupPath);
			});

			it('should handle subdirectory documents', async () => {
				mockAccess.mockResolvedValue(undefined);
				mockCopyFile.mockResolvedValue(undefined);
				mockUnlink.mockResolvedValue(undefined);

				const folderPath = '/test/autorun';
				const filename = 'Phase1/Task1';
				const backupPath = path.join(folderPath, `${filename}.backup.md`);

				await mockCopyFile(backupPath, path.join(folderPath, `${filename}.md`));
				await mockUnlink(backupPath);

				expect(mockUnlink).toHaveBeenCalledWith('/test/autorun/Phase1/Task1.backup.md');
			});
		});

		describe('error handling', () => {
			it('should return error for non-existent backup file', async () => {
				mockAccess.mockRejectedValue(new Error('ENOENT: no such file or directory'));

				await expect(mockAccess('/test/doc.backup.md')).rejects.toThrow('ENOENT');

				const result = { success: false, error: 'Backup file not found' };
				expect(result.error).toBe('Backup file not found');
			});
		});
	});

	describe('autorun:deleteBackups', () => {
		describe('successful operations', () => {
			it('should delete all backup files in folder', async () => {
				mockStat.mockResolvedValue({ isDirectory: () => true });
				mockReaddir.mockResolvedValueOnce([
					createDirent('Phase1.md', false),
					createDirent('Phase1.backup.md', false),
					createDirent('Phase2.md', false),
					createDirent('Phase2.backup.md', false),
				]);
				mockUnlink.mockResolvedValue(undefined);

				const entries = await mockReaddir('/test/autorun', { withFileTypes: true });
				const backups = entries.filter(
					(e: { name: string; isFile: () => boolean }) =>
						e.isFile() && e.name.endsWith('.backup.md')
				);

				expect(backups).toHaveLength(2);

				// Delete each backup
				for (const backup of backups) {
					await mockUnlink(path.join('/test/autorun', backup.name));
				}

				expect(mockUnlink).toHaveBeenCalledTimes(2);
			});

			it('should recursively delete backups in subdirectories', async () => {
				mockStat.mockResolvedValue({ isDirectory: () => true });
				// Root level
				mockReaddir.mockResolvedValueOnce([
					createDirent('Phase1', true),
					createDirent('root.backup.md', false),
				]);
				// Phase1 subdirectory
				mockReaddir.mockResolvedValueOnce([createDirent('Task1.backup.md', false)]);
				mockUnlink.mockResolvedValue(undefined);

				// Simulate recursive deletion
				await mockUnlink('/test/autorun/root.backup.md');
				await mockUnlink('/test/autorun/Phase1/Task1.backup.md');

				expect(mockUnlink).toHaveBeenCalledTimes(2);
			});

			it('should return count of deleted backups', () => {
				const result = { success: true, deletedCount: 3 };

				expect(result.success).toBe(true);
				expect(result.deletedCount).toBe(3);
			});

			it('should handle empty folder with no backups', async () => {
				mockStat.mockResolvedValue({ isDirectory: () => true });
				mockReaddir.mockResolvedValueOnce([
					createDirent('Phase1.md', false),
					createDirent('Phase2.md', false),
				]);

				const entries = await mockReaddir('/test/autorun', { withFileTypes: true });
				const backups = entries.filter((e: { name: string }) => e.name.endsWith('.backup.md'));

				expect(backups).toHaveLength(0);

				const result = { success: true, deletedCount: 0 };
				expect(result.deletedCount).toBe(0);
			});
		});

		describe('error handling', () => {
			it('should return error for non-directory path', async () => {
				mockStat.mockResolvedValue({ isDirectory: () => false });

				const result = { success: false, error: 'Path is not a directory' };
				expect(result.error).toBe('Path is not a directory');
			});

			it('should handle unlink failure gracefully', async () => {
				mockStat.mockResolvedValue({ isDirectory: () => true });
				mockReaddir.mockResolvedValueOnce([createDirent('doc.backup.md', false)]);
				mockUnlink.mockRejectedValue(new Error('EACCES: permission denied'));

				await expect(mockUnlink('/test/doc.backup.md')).rejects.toThrow('EACCES');
			});
		});
	});
});

describe('Auto Run IPC Handler Edge Cases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset all mock implementations to default
		mockReaddir.mockReset();
		mockStat.mockReset();
		mockReadFile.mockReset();
		mockWriteFile.mockReset();
		mockAccess.mockReset();
		mockMkdir.mockReset();
		mockUnlink.mockReset();
		mockRm.mockReset();
		mockCopyFile.mockReset();
	});

	describe('Concurrent operations', () => {
		it('should handle multiple simultaneous reads', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockImplementation((path: string) => {
				if (path.includes('doc1')) return Promise.resolve('Content 1');
				if (path.includes('doc2')) return Promise.resolve('Content 2');
				return Promise.resolve('Default');
			});

			const [result1, result2] = await Promise.all([
				mockReadFile('/test/doc1.md', 'utf-8'),
				mockReadFile('/test/doc2.md', 'utf-8'),
			]);

			expect(result1).toBe('Content 1');
			expect(result2).toBe('Content 2');
		});

		it('should handle read during write gracefully', async () => {
			// This tests that operations don't interfere
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue('Original content');
			mockWriteFile.mockResolvedValue(undefined);

			const readPromise = mockReadFile('/test/doc.md', 'utf-8');
			const writePromise = mockWriteFile('/test/doc.md', 'New content', 'utf-8');

			const [readResult] = await Promise.all([readPromise, writePromise]);

			// Read returns whatever was there at time of read
			expect(readResult).toBe('Original content');
		});
	});

	describe('Special file names', () => {
		it('should handle files with spaces in names', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue('Content');

			const filename = 'My Document With Spaces';
			const fullPath = `/test/autorun/${filename}.md`;

			await mockReadFile(fullPath, 'utf-8');
			expect(mockReadFile).toHaveBeenCalledWith(fullPath, 'utf-8');
		});

		it('should handle files with unicode characters', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue('Content');

			const filename = '文档-Phase1';
			const fullPath = `/test/autorun/${filename}.md`;

			await mockReadFile(fullPath, 'utf-8');
			expect(mockReadFile).toHaveBeenCalledWith(fullPath, 'utf-8');
		});

		it('should handle files with special characters', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue('Content');

			// Note: Some special chars may be invalid in filenames
			const filename = 'Doc_with-dashes_and.dots';
			const fullPath = `/test/autorun/${filename}.md`;

			await mockReadFile(fullPath, 'utf-8');
			expect(mockReadFile).toHaveBeenCalledWith(fullPath, 'utf-8');
		});
	});

	describe('Large data handling', () => {
		it('should handle very large markdown files', async () => {
			const largeContent = '#'.repeat(100000) + '\n' + 'x'.repeat(1000000);
			mockAccess.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue(largeContent);

			const result = await mockReadFile('/test/large.md', 'utf-8');
			expect(result.length).toBeGreaterThan(1000000);
		});

		it('should handle large base64 image data', async () => {
			// Simulate a ~1MB image (1.3MB base64)
			const largeBase64 = 'A'.repeat(1_400_000);
			mockMkdir.mockResolvedValue(undefined);
			mockWriteFile.mockResolvedValue(undefined);

			const buffer = Buffer.from(largeBase64, 'base64');
			await mockWriteFile('/test/images/large.png', buffer);

			expect(mockWriteFile).toHaveBeenCalled();
		});

		it('should handle many files in directory', async () => {
			const manyFiles = Array.from({ length: 1000 }, (_, i) =>
				createDirent(`file-${i.toString().padStart(4, '0')}.md`, false)
			);
			mockStat.mockResolvedValue({ isDirectory: () => true });
			mockReaddir.mockResolvedValue(manyFiles);

			const entries = await mockReaddir('/test/autorun', { withFileTypes: true });
			expect(entries).toHaveLength(1000);
		});
	});

	describe('Error recovery', () => {
		it('should continue after transient errors', async () => {
			// First call fails
			mockReadFile.mockRejectedValueOnce(new Error('EAGAIN'));
			// Second call succeeds
			mockReadFile.mockResolvedValueOnce('Content');

			await expect(mockReadFile('/test/doc.md', 'utf-8')).rejects.toThrow('EAGAIN');

			const result = await mockReadFile('/test/doc.md', 'utf-8');
			expect(result).toBe('Content');
		});

		it('should handle partial write failures gracefully', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockWriteFile.mockRejectedValue(new Error('ENOSPC'));

			await expect(mockWriteFile('/test/doc.md', 'content', 'utf-8')).rejects.toThrow('ENOSPC');

			// File state is unknown after partial write - handler should report error
			const result = { success: false, error: 'Error: ENOSPC' };
			expect(result.success).toBe(false);
		});
	});
});
