/**
 * Tests for the autorun IPC handlers
 *
 * These tests verify the Auto Run document management API that provides:
 * - Document listing with tree structure
 * - Document read/write operations
 * - Image management (save, delete, list)
 * - Folder watching for external changes
 * - Backup and restore functionality
 *
 * Note: All handlers use createIpcHandler which catches errors and returns
 * { success: false, error: "..." } instead of throwing. Tests should check
 * for success: false rather than expect rejects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, BrowserWindow, App } from 'electron';
import { registerAutorunHandlers } from '../../../../main/ipc/handlers/autorun';
import fs from 'fs/promises';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	BrowserWindow: vi.fn(),
	App: vi.fn(),
}));

// Mock fs/promises - use named exports to match how vitest handles the module
vi.mock('fs/promises', () => ({
	readdir: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
	stat: vi.fn(),
	access: vi.fn(),
	mkdir: vi.fn(),
	unlink: vi.fn(),
	rm: vi.fn(),
	copyFile: vi.fn(),
	default: {
		readdir: vi.fn(),
		readFile: vi.fn(),
		writeFile: vi.fn(),
		stat: vi.fn(),
		access: vi.fn(),
		mkdir: vi.fn(),
		unlink: vi.fn(),
		rm: vi.fn(),
		copyFile: vi.fn(),
	},
}));

// Don't mock path - use the real Node.js implementation

// Mock chokidar
vi.mock('chokidar', () => ({
	default: {
		watch: vi.fn(() => ({
			on: vi.fn().mockReturnThis(),
			close: vi.fn(),
		})),
	},
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('autorun IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockMainWindow: Partial<BrowserWindow>;
	let mockApp: Partial<App>;
	let appEventHandlers: Map<string, Function>;

	beforeEach(() => {
		// Clear mocks
		vi.clearAllMocks();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Create mock BrowserWindow
		mockMainWindow = {
			isDestroyed: vi.fn().mockReturnValue(false),
			webContents: {
				send: vi.fn(),
			} as any,
		};

		// Create mock App and capture event handlers
		appEventHandlers = new Map();
		mockApp = {
			on: vi.fn((event: string, handler: Function) => {
				appEventHandlers.set(event, handler);
				return mockApp as App;
			}),
		};

		// Register handlers
		registerAutorunHandlers({
			mainWindow: mockMainWindow as BrowserWindow,
			getMainWindow: () => mockMainWindow as BrowserWindow,
			app: mockApp as App,
		});
	});

	afterEach(() => {
		handlers.clear();
		appEventHandlers.clear();
	});

	describe('registration', () => {
		it('should register all autorun handlers', () => {
			const expectedChannels = [
				'autorun:listDocs',
				'autorun:hasDocuments',
				'autorun:readDoc',
				'autorun:writeDoc',
				'autorun:saveImage',
				'autorun:deleteImage',
				'autorun:listImages',
				'autorun:deleteFolder',
				'autorun:watchFolder',
				'autorun:unwatchFolder',
				'autorun:createBackup',
				'autorun:restoreBackup',
				'autorun:deleteBackups',
				'autorun:createWorkingCopy',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel), `Handler ${channel} should be registered`).toBe(true);
			}
			expect(handlers.size).toBe(expectedChannels.length);
		});

		it('should register app before-quit event handler', () => {
			expect(appEventHandlers.has('before-quit')).toBe(true);
		});
	});

	describe('autorun:listDocs', () => {
		it('should return array of markdown files and tree structure', async () => {
			// Mock stat to return directory
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			// Mock readdir to return markdown files
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'doc1.md', isDirectory: () => false, isFile: () => true },
				{ name: 'doc2.md', isDirectory: () => false, isFile: () => true },
			] as any);

			const handler = handlers.get('autorun:listDocs');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.files).toEqual(['doc1', 'doc2']);
			expect(result.tree).toHaveLength(2);
			expect(result.tree[0].name).toBe('doc1');
			expect(result.tree[0].type).toBe('file');
		});

		it('should filter to only .md files', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'doc1.md', isDirectory: () => false, isFile: () => true },
				{ name: 'readme.txt', isDirectory: () => false, isFile: () => true },
				{ name: 'image.png', isDirectory: () => false, isFile: () => true },
				{ name: 'doc2.MD', isDirectory: () => false, isFile: () => true },
			] as any);

			const handler = handlers.get('autorun:listDocs');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.files).toEqual(['doc1', 'doc2']);
		});

		it('should handle empty folder', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			vi.mocked(fs.readdir).mockResolvedValue([]);

			const handler = handlers.get('autorun:listDocs');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.files).toEqual([]);
			expect(result.tree).toEqual([]);
		});

		it('should return error for non-existent folder', async () => {
			vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

			const handler = handlers.get('autorun:listDocs');
			const result = await handler!({} as any, '/test/nonexistent');

			expect(result.success).toBe(false);
			expect(result.error).toContain('ENOENT');
		});

		it('should return error if path is not a directory', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => false,
				isFile: () => true,
			} as any);

			const handler = handlers.get('autorun:listDocs');
			const result = await handler!({} as any, '/test/file.txt');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Path is not a directory');
		});

		it('should sort files alphabetically', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'zebra.md', isDirectory: () => false, isFile: () => true },
				{ name: 'alpha.md', isDirectory: () => false, isFile: () => true },
				{ name: 'Beta.md', isDirectory: () => false, isFile: () => true },
			] as any);

			const handler = handlers.get('autorun:listDocs');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.files).toEqual(['alpha', 'Beta', 'zebra']);
		});

		it('should include subfolders in tree when they contain .md files', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			// First call for root, second for subfolder
			vi.mocked(fs.readdir)
				.mockResolvedValueOnce([
					{ name: 'subfolder', isDirectory: () => true, isFile: () => false },
					{ name: 'root.md', isDirectory: () => false, isFile: () => true },
				] as any)
				.mockResolvedValueOnce([
					{ name: 'nested.md', isDirectory: () => false, isFile: () => true },
				] as any);

			const handler = handlers.get('autorun:listDocs');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.files).toContain('subfolder/nested');
			expect(result.files).toContain('root');
			expect(result.tree).toHaveLength(2);
		});

		it('should exclude dotfiles', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: '.hidden.md', isDirectory: () => false, isFile: () => true },
				{ name: 'visible.md', isDirectory: () => false, isFile: () => true },
			] as any);

			const handler = handlers.get('autorun:listDocs');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.files).toEqual(['visible']);
		});
	});

	describe('autorun:hasDocuments', () => {
		it('should return true when folder contains .md files', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'doc1.md', isDirectory: () => false, isFile: () => true },
			] as any);

			const handler = handlers.get('autorun:hasDocuments');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.hasDocuments).toBe(true);
		});

		it('should return false when folder is empty', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			vi.mocked(fs.readdir).mockResolvedValue([]);

			const handler = handlers.get('autorun:hasDocuments');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.hasDocuments).toBe(false);
		});

		it('should return false when folder contains no .md files', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'image.png', isDirectory: () => false, isFile: () => true },
				{ name: 'readme.txt', isDirectory: () => false, isFile: () => true },
			] as any);

			const handler = handlers.get('autorun:hasDocuments');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.hasDocuments).toBe(false);
		});

		it('should return false when folder does not exist', async () => {
			vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

			const handler = handlers.get('autorun:hasDocuments');
			const result = await handler!({} as any, '/test/nonexistent');

			expect(result.success).toBe(true);
			expect(result.hasDocuments).toBe(false);
		});

		it('should return false when path is not a directory', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => false,
				isFile: () => true,
			} as any);

			const handler = handlers.get('autorun:hasDocuments');
			const result = await handler!({} as any, '/test/file.txt');

			expect(result.success).toBe(true);
			expect(result.hasDocuments).toBe(false);
		});

		it('should find .md files in subdirectories', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			// First call for root (no .md), second for subfolder (has .md)
			vi.mocked(fs.readdir)
				.mockResolvedValueOnce([
					{ name: 'subfolder', isDirectory: () => true, isFile: () => false },
				] as any)
				.mockResolvedValueOnce([
					{ name: 'nested.md', isDirectory: () => false, isFile: () => true },
				] as any);

			const handler = handlers.get('autorun:hasDocuments');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.hasDocuments).toBe(true);
		});

		it('should skip dotfiles and dot directories', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: '.hidden.md', isDirectory: () => false, isFile: () => true },
				{ name: '.git', isDirectory: () => true, isFile: () => false },
			] as any);

			const handler = handlers.get('autorun:hasDocuments');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.hasDocuments).toBe(false);
		});

		it('should handle case-insensitive .md extension', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'doc1.MD', isDirectory: () => false, isFile: () => true },
			] as any);

			const handler = handlers.get('autorun:hasDocuments');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.hasDocuments).toBe(true);
		});

		it('should return early once first .md file is found', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			// Root has a .md file, so we shouldn't recurse into subfolder
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'first.md', isDirectory: () => false, isFile: () => true },
				{ name: 'subfolder', isDirectory: () => true, isFile: () => false },
			] as any);

			const handler = handlers.get('autorun:hasDocuments');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.hasDocuments).toBe(true);
			// readdir should only be called once (for root)
			expect(fs.readdir).toHaveBeenCalledTimes(1);
		});
	});

	describe('autorun:readDoc', () => {
		it('should return file content as string', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readFile).mockResolvedValue('# Test Document\n\nContent here');

			const handler = handlers.get('autorun:readDoc');
			const result = await handler!({} as any, '/test/folder', 'doc1');

			expect(result.success).toBe(true);
			expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('doc1.md'), 'utf-8');
			expect(result.content).toBe('# Test Document\n\nContent here');
		});

		it('should handle filename with or without .md extension', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readFile).mockResolvedValue('content');

			const handler = handlers.get('autorun:readDoc');

			// Without extension
			await handler!({} as any, '/test/folder', 'doc1');
			expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('doc1.md'), 'utf-8');

			// With extension
			await handler!({} as any, '/test/folder', 'doc2.md');
			expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('doc2.md'), 'utf-8');
		});

		it('should return error for missing file', async () => {
			vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

			const handler = handlers.get('autorun:readDoc');
			const result = await handler!({} as any, '/test/folder', 'nonexistent');

			expect(result.success).toBe(false);
			expect(result.error).toContain('File not found');
		});

		it('should return error for directory traversal attempts', async () => {
			const handler = handlers.get('autorun:readDoc');

			const result1 = await handler!({} as any, '/test/folder', '../etc/passwd');
			expect(result1.success).toBe(false);
			expect(result1.error).toContain('Invalid filename');

			const result2 = await handler!({} as any, '/test/folder', '../../secret');
			expect(result2.success).toBe(false);
			expect(result2.error).toContain('Invalid filename');
		});

		it('should handle UTF-8 content', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readFile).mockResolvedValue('Unicode: 日本語 한국어 🚀');

			const handler = handlers.get('autorun:readDoc');
			const result = await handler!({} as any, '/test/folder', 'unicode');

			expect(result.success).toBe(true);
			expect(result.content).toBe('Unicode: 日本語 한국어 🚀');
		});

		it('should support subdirectory paths', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readFile).mockResolvedValue('nested content');

			const handler = handlers.get('autorun:readDoc');
			const result = await handler!({} as any, '/test/folder', 'subdir/nested');

			expect(result.success).toBe(true);
			expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('subdir'), 'utf-8');
			expect(result.content).toBe('nested content');
		});
	});

	describe('autorun:writeDoc', () => {
		it('should write content to file', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:writeDoc');
			const result = await handler!({} as any, '/test/folder', 'doc1', '# New Content');

			expect(result.success).toBe(true);
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('doc1.md'),
				'# New Content',
				'utf-8'
			);
		});

		it('should create parent directories if needed', async () => {
			vi.mocked(fs.access).mockRejectedValueOnce(new Error('ENOENT'));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:writeDoc');
			const result = await handler!({} as any, '/test/folder', 'subdir/doc1', 'content');

			expect(result.success).toBe(true);
			expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining('subdir'), { recursive: true });
		});

		it('should return error for directory traversal attempts', async () => {
			const handler = handlers.get('autorun:writeDoc');

			const result = await handler!({} as any, '/test/folder', '../etc/passwd', 'content');
			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid filename');
		});

		it('should overwrite existing file', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:writeDoc');
			const result = await handler!({} as any, '/test/folder', 'existing', 'new content');

			expect(result.success).toBe(true);
			expect(fs.writeFile).toHaveBeenCalled();
		});

		it('should handle filename with or without .md extension', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:writeDoc');

			await handler!({} as any, '/test/folder', 'doc1', 'content');
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('doc1.md'),
				'content',
				'utf-8'
			);

			await handler!({} as any, '/test/folder', 'doc2.md', 'content');
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('doc2.md'),
				'content',
				'utf-8'
			);
		});
	});

	describe('autorun:deleteFolder', () => {
		it('should remove the Auto Run Docs folder', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
			} as any);
			vi.mocked(fs.rm).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:deleteFolder');
			const result = await handler!({} as any, '/test/project');

			expect(result.success).toBe(true);
			expect(fs.rm).toHaveBeenCalledWith('/test/project/Auto Run Docs', {
				recursive: true,
				force: true,
			});
		});

		it('should handle non-existent folder gracefully', async () => {
			const error = new Error('ENOENT');
			vi.mocked(fs.stat).mockRejectedValue(error);

			const handler = handlers.get('autorun:deleteFolder');
			const result = await handler!({} as any, '/test/project');

			expect(result.success).toBe(true);
			expect(fs.rm).not.toHaveBeenCalled();
		});

		it('should return error if path is not a directory', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => false,
			} as any);

			const handler = handlers.get('autorun:deleteFolder');
			const result = await handler!({} as any, '/test/project');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Auto Run Docs path is not a directory');
		});

		it('should return error for invalid project path', async () => {
			const handler = handlers.get('autorun:deleteFolder');

			const result1 = await handler!({} as any, '');
			expect(result1.success).toBe(false);
			expect(result1.error).toContain('Invalid project path');

			const result2 = await handler!({} as any, null);
			expect(result2.success).toBe(false);
			expect(result2.error).toContain('Invalid project path');
		});
	});

	describe('autorun:listImages', () => {
		it('should return array of image files for a document', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue([
				'doc1-1234567890.png',
				'doc1-1234567891.jpg',
				'other-9999.png',
			] as any);

			const handler = handlers.get('autorun:listImages');
			const result = await handler!({} as any, '/test/folder', 'doc1');

			expect(result.success).toBe(true);
			expect(result.images).toHaveLength(2);
			expect(result.images[0].filename).toBe('doc1-1234567890.png');
			expect(result.images[0].relativePath).toBe('images/doc1-1234567890.png');
		});

		it('should filter by valid image extensions', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue([
				'doc1-123.png',
				'doc1-124.jpg',
				'doc1-125.jpeg',
				'doc1-126.gif',
				'doc1-127.webp',
				'doc1-128.svg',
				'doc1-129.txt',
				'doc1-130.pdf',
			] as any);

			const handler = handlers.get('autorun:listImages');
			const result = await handler!({} as any, '/test/folder', 'doc1');

			expect(result.success).toBe(true);
			expect(result.images).toHaveLength(6);
			expect(result.images.map((i: any) => i.filename)).not.toContain('doc1-129.txt');
			expect(result.images.map((i: any) => i.filename)).not.toContain('doc1-130.pdf');
		});

		it('should handle empty images folder', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue([]);

			const handler = handlers.get('autorun:listImages');
			const result = await handler!({} as any, '/test/folder', 'doc1');

			expect(result.success).toBe(true);
			expect(result.images).toEqual([]);
		});

		it('should handle non-existent images folder', async () => {
			vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

			const handler = handlers.get('autorun:listImages');
			const result = await handler!({} as any, '/test/folder', 'doc1');

			expect(result.success).toBe(true);
			expect(result.images).toEqual([]);
		});

		it('should sanitize directory traversal in document name using basename', async () => {
			// The code uses path.basename() to sanitize the document name,
			// so '../etc' becomes 'etc' (safe) and 'path/to/doc' becomes 'doc' (safe)
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue([]);

			const handler = handlers.get('autorun:listImages');

			// ../etc gets sanitized to 'etc' by path.basename
			const result1 = await handler!({} as any, '/test/folder', '../etc');
			expect(result1.success).toBe(true);
			expect(result1.images).toEqual([]);

			// path/to/doc gets sanitized to 'doc' by path.basename
			const result2 = await handler!({} as any, '/test/folder', 'path/to/doc');
			expect(result2.success).toBe(true);
			expect(result2.images).toEqual([]);
		});
	});

	describe('autorun:saveImage', () => {
		it('should save image to images subdirectory', async () => {
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const base64Data = Buffer.from('fake image data').toString('base64');

			const handler = handlers.get('autorun:saveImage');
			const result = await handler!({} as any, '/test/folder', 'doc1', base64Data, 'png');

			expect(result.success).toBe(true);
			expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining('images'), { recursive: true });
			expect(fs.writeFile).toHaveBeenCalled();
			expect(result.relativePath).toMatch(/^images\/doc1-\d+\.png$/);
		});

		it('should return error for invalid image extension', async () => {
			const handler = handlers.get('autorun:saveImage');

			const result1 = await handler!({} as any, '/test/folder', 'doc1', 'data', 'exe');
			expect(result1.success).toBe(false);
			expect(result1.error).toContain('Invalid image extension');

			const result2 = await handler!({} as any, '/test/folder', 'doc1', 'data', 'php');
			expect(result2.success).toBe(false);
			expect(result2.error).toContain('Invalid image extension');
		});

		it('should accept valid image extensions', async () => {
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:saveImage');
			const validExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

			for (const ext of validExtensions) {
				const result = await handler!({} as any, '/test/folder', 'doc1', 'ZmFrZQ==', ext);
				expect(result.success).toBe(true);
				expect(result.relativePath).toContain(`.${ext}`);
			}
		});

		it('should sanitize directory traversal in document name using basename', async () => {
			// The code uses path.basename() to sanitize the document name,
			// so '../etc' becomes 'etc' (safe) and 'path/to/doc' becomes 'doc' (safe)
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:saveImage');

			// ../etc gets sanitized to 'etc' by path.basename
			const result1 = await handler!({} as any, '/test/folder', '../etc', 'ZmFrZQ==', 'png');
			expect(result1.success).toBe(true);
			expect(result1.relativePath).toMatch(/images\/etc-\d+\.png/);

			// path/to/doc gets sanitized to 'doc' by path.basename
			const result2 = await handler!({} as any, '/test/folder', 'path/to/doc', 'ZmFrZQ==', 'png');
			expect(result2.success).toBe(true);
			expect(result2.relativePath).toMatch(/images\/doc-\d+\.png/);
		});

		it('should generate unique filenames with timestamp', async () => {
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:saveImage');
			const result = await handler!({} as any, '/test/folder', 'doc1', 'ZmFrZQ==', 'png');

			expect(result.success).toBe(true);
			expect(result.relativePath).toMatch(/images\/doc1-\d+\.png/);
		});
	});

	describe('autorun:deleteImage', () => {
		it('should remove image file', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.unlink).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:deleteImage');
			const result = await handler!({} as any, '/test/folder', 'images/doc1-123.png');

			expect(result.success).toBe(true);
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('images'));
		});

		it('should return error for missing image', async () => {
			vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

			const handler = handlers.get('autorun:deleteImage');
			const result = await handler!({} as any, '/test/folder', 'images/nonexistent.png');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Image file not found');
		});

		it('should only allow deleting from images folder', async () => {
			const handler = handlers.get('autorun:deleteImage');

			const result1 = await handler!({} as any, '/test/folder', 'doc1.md');
			expect(result1.success).toBe(false);
			expect(result1.error).toContain('Invalid image path');

			const result2 = await handler!({} as any, '/test/folder', '../images/test.png');
			expect(result2.success).toBe(false);
			expect(result2.error).toContain('Invalid image path');

			const result3 = await handler!({} as any, '/test/folder', '/absolute/path.png');
			expect(result3.success).toBe(false);
			expect(result3.error).toContain('Invalid image path');
		});
	});

	describe('autorun:watchFolder', () => {
		it('should start watching a folder', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
			} as any);

			const chokidar = await import('chokidar');

			const handler = handlers.get('autorun:watchFolder');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(chokidar.default.watch).toHaveBeenCalledWith('/test/folder', expect.any(Object));
		});

		it('should create folder if it does not exist', async () => {
			vi.mocked(fs.stat)
				.mockRejectedValueOnce(new Error('ENOENT'))
				.mockResolvedValueOnce({ isDirectory: () => true } as any);
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:watchFolder');
			const result = await handler!({} as any, '/test/newfolder');

			expect(result.success).toBe(true);
			expect(fs.mkdir).toHaveBeenCalledWith('/test/newfolder', { recursive: true });
		});

		it('should return error if path is not a directory', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => false,
			} as any);

			const handler = handlers.get('autorun:watchFolder');
			const result = await handler!({} as any, '/test/file.txt');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Path is not a directory');
		});
	});

	describe('autorun:unwatchFolder', () => {
		it('should stop watching a folder', async () => {
			// First start watching
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
			} as any);

			const watchHandler = handlers.get('autorun:watchFolder');
			await watchHandler!({} as any, '/test/folder');

			// Then stop watching
			const unwatchHandler = handlers.get('autorun:unwatchFolder');
			const result = await unwatchHandler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
		});

		it('should handle unwatching a folder that was not being watched', async () => {
			const unwatchHandler = handlers.get('autorun:unwatchFolder');
			const result = await unwatchHandler!({} as any, '/test/other');

			expect(result.success).toBe(true);
		});
	});

	describe('autorun:createBackup', () => {
		it('should create backup copy of document', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.copyFile).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:createBackup');
			const result = await handler!({} as any, '/test/folder', 'doc1');

			expect(result.success).toBe(true);
			expect(fs.copyFile).toHaveBeenCalledWith(
				expect.stringContaining('doc1.md'),
				expect.stringContaining('doc1.backup.md')
			);
			expect(result.backupFilename).toBe('doc1.backup.md');
		});

		it('should return error for missing source file', async () => {
			vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

			const handler = handlers.get('autorun:createBackup');
			const result = await handler!({} as any, '/test/folder', 'nonexistent');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Source file not found');
		});

		it('should return error for directory traversal', async () => {
			const handler = handlers.get('autorun:createBackup');
			const result = await handler!({} as any, '/test/folder', '../etc/passwd');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid filename');
		});
	});

	describe('autorun:restoreBackup', () => {
		it('should restore document from backup', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.copyFile).mockResolvedValue(undefined);
			vi.mocked(fs.unlink).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:restoreBackup');
			const result = await handler!({} as any, '/test/folder', 'doc1');

			expect(result.success).toBe(true);
			expect(fs.copyFile).toHaveBeenCalledWith(
				expect.stringContaining('doc1.backup.md'),
				expect.stringContaining('doc1.md')
			);
			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('doc1.backup.md'));
		});

		it('should return error for missing backup file', async () => {
			vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

			const handler = handlers.get('autorun:restoreBackup');
			const result = await handler!({} as any, '/test/folder', 'nobkp');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Backup file not found');
		});

		it('should return error for directory traversal', async () => {
			const handler = handlers.get('autorun:restoreBackup');
			const result = await handler!({} as any, '/test/folder', '../etc/passwd');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid filename');
		});
	});

	describe('autorun:deleteBackups', () => {
		it('should delete all backup files in folder', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
			} as any);
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'doc1.backup.md', isDirectory: () => false, isFile: () => true },
				{ name: 'doc2.backup.md', isDirectory: () => false, isFile: () => true },
				{ name: 'doc3.md', isDirectory: () => false, isFile: () => true },
			] as any);
			vi.mocked(fs.unlink).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:deleteBackups');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(fs.unlink).toHaveBeenCalledTimes(2);
			expect(result.deletedCount).toBe(2);
		});

		it('should handle folder with no backups', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
			} as any);
			vi.mocked(fs.readdir).mockResolvedValue([
				{ name: 'doc1.md', isDirectory: () => false, isFile: () => true },
			] as any);

			const handler = handlers.get('autorun:deleteBackups');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(fs.unlink).not.toHaveBeenCalled();
			expect(result.deletedCount).toBe(0);
		});

		it('should recursively delete backups in subdirectories', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
			} as any);
			vi.mocked(fs.readdir)
				.mockResolvedValueOnce([
					{ name: 'doc1.backup.md', isDirectory: () => false, isFile: () => true },
					{ name: 'subfolder', isDirectory: () => true, isFile: () => false },
				] as any)
				.mockResolvedValueOnce([
					{ name: 'nested.backup.md', isDirectory: () => false, isFile: () => true },
				] as any);
			vi.mocked(fs.unlink).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:deleteBackups');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(fs.unlink).toHaveBeenCalledTimes(2);
			expect(result.deletedCount).toBe(2);
		});

		it('should return error if path is not a directory', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => false,
			} as any);

			const handler = handlers.get('autorun:deleteBackups');
			const result = await handler!({} as any, '/test/file.txt');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Path is not a directory');
		});
	});

	describe('app before-quit cleanup', () => {
		it('should clean up all watchers on app quit', async () => {
			// Start watching a folder
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
			} as any);

			const watchHandler = handlers.get('autorun:watchFolder');
			await watchHandler!({} as any, '/test/folder');

			// Trigger before-quit
			const quitHandler = appEventHandlers.get('before-quit');
			quitHandler!();

			// No error should be thrown
		});
	});
});
