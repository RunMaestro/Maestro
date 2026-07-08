/**
 * Tests for the autorun IPC handlers
 *
 * These tests verify the Auto Run document management API that provides:
 * - Document listing with tree structure
 * - Document read/write operations
 * - Image management (save, delete, list)
 * - Folder watching for external changes
 * - Backup and restore functionality
 * - SSH remote support for all operations
 *
 * Note: All handlers use createIpcHandler which catches errors and returns
 * { success: false, error: "..." } instead of throwing. Tests should check
 * for success: false rather than expect rejects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, BrowserWindow, App } from 'electron';
import { registerAutorunHandlers } from '../../../../main/ipc/handlers/autorun';
import fs from 'fs/promises';
import path from 'path';
import Store from 'electron-store';
import type { SshRemoteConfig } from '../../../../shared/types';

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

// Mock electron-store
vi.mock('electron-store', () => {
	return {
		default: vi.fn().mockImplementation(() => ({
			get: vi.fn(),
			set: vi.fn(),
		})),
	};
});

// Mock remote-fs for SSH operations using vi.hoisted for factory hoisting
const {
	mockReadDirRemote,
	mockReadFileRemote,
	mockWriteFileRemote,
	mockExistsRemote,
	mockMkdirRemote,
	mockDeleteRemote,
	mockStatRemote,
} = vi.hoisted(() => ({
	mockReadDirRemote: vi.fn(),
	mockReadFileRemote: vi.fn(),
	mockWriteFileRemote: vi.fn(),
	mockExistsRemote: vi.fn(),
	mockMkdirRemote: vi.fn(),
	mockDeleteRemote: vi.fn(),
	mockStatRemote: vi.fn(),
}));

vi.mock('../../../../main/utils/remote-fs', () => ({
	readDirRemote: mockReadDirRemote,
	readFileRemote: mockReadFileRemote,
	writeFileRemote: mockWriteFileRemote,
	existsRemote: mockExistsRemote,
	mkdirRemote: mockMkdirRemote,
	deleteRemote: mockDeleteRemote,
	statRemote: mockStatRemote,
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
	let mockSettingsStore: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };

	// Sample SSH remote configuration for testing
	const sampleSshRemote: SshRemoteConfig = {
		id: 'ssh-remote-1',
		label: 'Test Remote',
		host: 'testserver.example.com',
		username: 'testuser',
		enabled: true,
	};

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
				isDestroyed: vi.fn().mockReturnValue(false),
			} as any,
		};

		// Setup mock settings store for SSH remote lookup
		mockSettingsStore = {
			get: vi.fn().mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'sshRemotes') {
					return [sampleSshRemote];
				}
				return defaultValue;
			}),
			set: vi.fn(),
		};

		// Reset remote-fs mocks
		mockReadDirRemote.mockReset();
		mockReadFileRemote.mockReset();
		mockWriteFileRemote.mockReset();
		mockExistsRemote.mockReset();
		mockMkdirRemote.mockReset();
		mockDeleteRemote.mockReset();
		mockStatRemote.mockReset();

		// Create mock App and capture event handlers
		appEventHandlers = new Map();
		mockApp = {
			on: vi.fn((event: string, handler: Function) => {
				appEventHandlers.set(event, handler);
				return mockApp as App;
			}),
		};

		// Register handlers with settingsStore for SSH remote support
		registerAutorunHandlers({
			mainWindow: mockMainWindow as BrowserWindow,
			getMainWindow: () => mockMainWindow as BrowserWindow,
			app: mockApp as App,
			settingsStore: mockSettingsStore as unknown as Store,
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
				'autorun:replaceImage',
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
				{
					name: 'doc1.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
				{
					name: 'doc2.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
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
				{
					name: 'doc1.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
				{
					name: 'readme.txt',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
				{
					name: 'image.png',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
				{
					name: 'doc2.MD',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
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
				{
					name: 'zebra.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
				{
					name: 'alpha.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
				{
					name: 'Beta.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
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
					{
						name: 'root.md',
						isDirectory: () => false,
						isFile: () => true,
						isSymbolicLink: () => false,
					},
					{
						name: 'subfolder',
						isDirectory: () => true,
						isFile: () => false,
						isSymbolicLink: () => false,
					},
				] as any)
				.mockResolvedValueOnce([
					{
						name: 'nested.md',
						isDirectory: () => false,
						isFile: () => true,
						isSymbolicLink: () => false,
					},
				] as any);

			const handler = handlers.get('autorun:listDocs');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.files).toContain('subfolder/nested');
			expect(result.files).toContain('root');
			expect(result.tree).toHaveLength(2);
		});

		it('should include symlinked .md files as documents', async () => {
			vi.mocked(fs.stat).mockImplementation((p: any) => {
				// First call: the top-level folder. Subsequent calls: symlink resolution.
				if (p === '/test/folder') {
					return Promise.resolve({ isDirectory: () => true, isFile: () => false } as any);
				}
				// Symlink target is a file
				return Promise.resolve({ isDirectory: () => false, isFile: () => true } as any);
			});

			vi.mocked(fs.readdir).mockResolvedValue([
				{
					name: 'linked-doc.md',
					isDirectory: () => false,
					isFile: () => false,
					isSymbolicLink: () => true,
				},
				{
					name: 'real.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
			] as any);

			const handler = handlers.get('autorun:listDocs');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.files).toEqual(['linked-doc', 'real']);
		});

		it('should recurse into symlinked folders containing .md files', async () => {
			vi.mocked(fs.stat).mockImplementation((p: any) => {
				if (p === '/test/folder') {
					return Promise.resolve({ isDirectory: () => true, isFile: () => false } as any);
				}
				// Symlink target is a directory
				return Promise.resolve({ isDirectory: () => true, isFile: () => false } as any);
			});

			// Root contains a symlinked folder; the folder contains nested.md
			vi.mocked(fs.readdir)
				.mockResolvedValueOnce([
					{
						name: 'linked-folder',
						isDirectory: () => false,
						isFile: () => false,
						isSymbolicLink: () => true,
					},
				] as any)
				.mockResolvedValueOnce([
					{
						name: 'nested.md',
						isDirectory: () => false,
						isFile: () => true,
						isSymbolicLink: () => false,
					},
				] as any);

			const handler = handlers.get('autorun:listDocs');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.files).toContain('linked-folder/nested');
		});

		it('should avoid revisiting symlinked directory cycles by real path', async () => {
			(fs as any).realpath = vi.fn(async (p: string) => {
				if (p === '/test/folder') {
					throw new Error('realpath unavailable');
				}
				return path.resolve('/test/folder');
			});
			try {
				vi.mocked(fs.stat).mockImplementation((p: any) => {
					if (p === '/test/folder' || p === '/test/folder/loop') {
						return Promise.resolve({ isDirectory: () => true, isFile: () => false } as any);
					}
					return Promise.resolve({ isDirectory: () => false, isFile: () => true } as any);
				});

				vi.mocked(fs.readdir).mockResolvedValueOnce([
					{
						name: 'loop',
						isDirectory: () => false,
						isFile: () => false,
						isSymbolicLink: () => true,
					},
					{
						name: 'real.md',
						isDirectory: () => false,
						isFile: () => true,
						isSymbolicLink: () => false,
					},
				] as any);

				const handler = handlers.get('autorun:listDocs');
				const result = await handler!({} as any, '/test/folder');

				expect(result.success).toBe(true);
				expect(result.files).toEqual(['real']);
				expect(fs.readdir).toHaveBeenCalledTimes(1);
			} finally {
				delete (fs as any).realpath;
			}
		});

		it('should skip broken symlinks silently', async () => {
			vi.mocked(fs.stat).mockImplementation((p: any) => {
				if (p === '/test/folder') {
					return Promise.resolve({ isDirectory: () => true, isFile: () => false } as any);
				}
				return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
			});

			vi.mocked(fs.readdir).mockResolvedValue([
				{
					name: 'broken',
					isDirectory: () => false,
					isFile: () => false,
					isSymbolicLink: () => true,
				},
				{
					name: 'real.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
			] as any);

			const handler = handlers.get('autorun:listDocs');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.files).toEqual(['real']);
		});

		it('should exclude dotfiles', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			vi.mocked(fs.readdir).mockResolvedValue([
				{
					name: '.hidden.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
				{
					name: 'visible.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
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
				{
					name: 'doc1.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
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
				{
					name: 'image.png',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
				{
					name: 'readme.txt',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
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
					{
						name: 'subfolder',
						isDirectory: () => true,
						isFile: () => false,
						isSymbolicLink: () => false,
					},
				] as any)
				.mockResolvedValueOnce([
					{
						name: 'nested.md',
						isDirectory: () => false,
						isFile: () => true,
						isSymbolicLink: () => false,
					},
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
				{
					name: '.hidden.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
				{ name: '.git', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
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
				{
					name: 'doc1.MD',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
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
				{
					name: 'first.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
				{
					name: 'subfolder',
					isDirectory: () => true,
					isFile: () => false,
					isSymbolicLink: () => false,
				},
			] as any);

			const handler = handlers.get('autorun:hasDocuments');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.hasDocuments).toBe(true);
			// readdir should only be called once (for root)
			expect(fs.readdir).toHaveBeenCalledTimes(1);
		});

		it('should avoid revisiting symlinked directory cycles while checking documents', async () => {
			(fs as any).realpath = vi.fn(async (p: string) => {
				if (p === '/test/folder') {
					throw new Error('realpath unavailable');
				}
				return path.resolve('/test/folder');
			});
			try {
				vi.mocked(fs.stat).mockImplementation((p: any) => {
					if (p === '/test/folder' || p === '/test/folder/loop') {
						return Promise.resolve({ isDirectory: () => true, isFile: () => false } as any);
					}
					return Promise.resolve({ isDirectory: () => false, isFile: () => true } as any);
				});

				vi.mocked(fs.readdir).mockResolvedValueOnce([
					{
						name: 'loop',
						isDirectory: () => false,
						isFile: () => false,
						isSymbolicLink: () => true,
					},
				] as any);

				const handler = handlers.get('autorun:hasDocuments');
				const result = await handler!({} as any, '/test/folder');

				expect(result.success).toBe(true);
				expect(result.hasDocuments).toBe(false);
				expect(fs.readdir).toHaveBeenCalledTimes(1);
			} finally {
				delete (fs as any).realpath;
			}
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

		it('should return empty content with notFound flag for missing file', async () => {
			vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

			const handler = handlers.get('autorun:readDoc');
			const result = await handler!({} as any, '/test/folder', 'nonexistent');

			expect(result.success).toBe(true);
			expect(result.content).toBe('');
			expect(result.notFound).toBe(true);
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

		it('should fall back to the raw filename when URI decoding fails', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:writeDoc');
			const result = await handler!({} as any, '/test/folder', '%E0%A4%A', 'content');

			expect(result.success).toBe(true);
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('%E0%A4%A.md'),
				'content',
				'utf-8'
			);
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
		it('should remove the playbooks folder', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
			} as any);
			vi.mocked(fs.rm).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:deleteFolder');
			const result = await handler!({} as any, '/test/project');

			expect(result.success).toBe(true);
			expect(fs.rm).toHaveBeenCalledWith(path.join('/test/project', '.maestro/playbooks'), {
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

		it('should skip non-directory paths without error', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => false,
			} as any);

			const handler = handlers.get('autorun:deleteFolder');
			const result = await handler!({} as any, '/test/project');

			// Both canonical and legacy are non-directories, so nothing to delete
			expect(result.success).toBe(true);
			expect(fs.rm).not.toHaveBeenCalled();
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

		it('should remove the legacy Auto Run Docs folder when canonical playbooks is absent', async () => {
			vi.mocked(fs.stat)
				.mockRejectedValueOnce(new Error('ENOENT'))
				.mockResolvedValueOnce({
					isDirectory: () => true,
				} as any);
			vi.mocked(fs.rm).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:deleteFolder');
			const result = await handler!({} as any, '/test/project');

			expect(result.success).toBe(true);
			expect(fs.rm).toHaveBeenCalledWith(path.join('/test/project', 'Auto Run Docs'), {
				recursive: true,
				force: true,
			});
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

		it('should reject dot-dot as a listImages document name', async () => {
			const handler = handlers.get('autorun:listImages');
			const result = await handler!({} as any, '/test/folder', '..');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid document name');
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

		it('should reject dot-dot as an image document name', async () => {
			const handler = handlers.get('autorun:saveImage');
			const result = await handler!({} as any, '/test/folder', '..', 'ZmFrZQ==', 'png');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid document name');
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

	describe('autorun:replaceImage', () => {
		it('should overwrite an existing local image in place', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:replaceImage');
			const result = await handler!(
				{} as any,
				'/test/folder',
				'images/doc1-123.png',
				Buffer.from('updated image').toString('base64')
			);

			expect(result.success).toBe(true);
			expect(result.relativePath).toBe('images/doc1-123.png');
			expect(fs.access).toHaveBeenCalledWith(expect.stringContaining('images/doc1-123.png'));
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining('images/doc1-123.png'),
				expect.any(Buffer)
			);
		});

		it('should return an error when replacing a missing local image', async () => {
			vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

			const handler = handlers.get('autorun:replaceImage');
			const result = await handler!(
				{} as any,
				'/test/folder',
				'images/missing.png',
				Buffer.from('updated image').toString('base64')
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Image file not found');
			expect(fs.writeFile).not.toHaveBeenCalled();
		});

		it('should reject replacement paths outside the images folder', async () => {
			const handler = handlers.get('autorun:replaceImage');

			const result1 = await handler!(
				{} as any,
				'/test/folder',
				'doc1.png',
				Buffer.from('updated image').toString('base64')
			);
			expect(result1.success).toBe(false);
			expect(result1.error).toContain('Invalid image path');

			const result2 = await handler!(
				{} as any,
				'/test/folder',
				'../images/doc1.png',
				Buffer.from('updated image').toString('base64')
			);
			expect(result2.success).toBe(false);
			expect(result2.error).toContain('Invalid image path');
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

		it('should ignore non-markdown watcher events', async () => {
			vi.useFakeTimers();
			try {
				vi.mocked(fs.stat).mockResolvedValue({
					isDirectory: () => true,
				} as any);

				const callbacks = new Map<string, Function>();
				const watcher = {
					on: vi.fn((event: string, callback: Function) => {
						callbacks.set(event, callback);
						return watcher;
					}),
					close: vi.fn(),
				};
				const chokidar = await import('chokidar');
				vi.mocked(chokidar.default.watch).mockReturnValueOnce(watcher as any);

				const handler = handlers.get('autorun:watchFolder');
				const result = await handler!({} as any, '/test/folder');

				callbacks.get('change')?.('/test/folder/readme.txt');
				vi.advanceTimersByTime(301);

				expect(result.success).toBe(true);
				expect(mockMainWindow.webContents?.send).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it('should debounce and flush markdown watcher changes', async () => {
			vi.useFakeTimers();
			try {
				vi.mocked(fs.stat).mockResolvedValue({
					isDirectory: () => true,
				} as any);

				const callbacks = new Map<string, Function>();
				const watcher = {
					on: vi.fn((event: string, callback: Function) => {
						callbacks.set(event, callback);
						return watcher;
					}),
					close: vi.fn(),
				};
				const chokidar = await import('chokidar');
				vi.mocked(chokidar.default.watch).mockReturnValueOnce(watcher as any);

				const handler = handlers.get('autorun:watchFolder');
				const result = await handler!({} as any, '/test/folder');

				callbacks.get('add')?.('/test/folder/new-doc.md');
				callbacks.get('change')?.('/test/folder/new-doc.md');
				callbacks.get('error')?.(new Error('watch failed'));
				vi.advanceTimersByTime(301);

				expect(result.success).toBe(true);
				expect(mockMainWindow.webContents?.send).toHaveBeenCalledWith('autorun:fileChanged', {
					folderPath: '/test/folder',
					filename: 'new-doc',
					eventType: 'rename',
				});
			} finally {
				vi.useRealTimers();
			}
		});

		it('should drop debounced watcher changes when the window is unavailable', async () => {
			vi.useFakeTimers();
			try {
				vi.mocked(fs.stat).mockResolvedValue({
					isDirectory: () => true,
				} as any);

				const callbacks = new Map<string, Function>();
				const watcher = {
					on: vi.fn((event: string, callback: Function) => {
						callbacks.set(event, callback);
						return watcher;
					}),
					close: vi.fn(),
				};
				const chokidar = await import('chokidar');
				vi.mocked(chokidar.default.watch).mockReturnValueOnce(watcher as any);

				const handler = handlers.get('autorun:watchFolder');
				const result = await handler!({} as any, '/test/folder');

				vi.mocked(mockMainWindow.isDestroyed as any).mockReturnValue(true);
				callbacks.get('change')?.('/test/folder/new-doc.md');
				vi.advanceTimersByTime(301);

				expect(result.success).toBe(true);
				expect(mockMainWindow.webContents?.send).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
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

		it('should clear pending debounced change notifications when unwatching', async () => {
			vi.useFakeTimers();
			try {
				vi.mocked(fs.stat).mockResolvedValue({
					isDirectory: () => true,
				} as any);

				const callbacks = new Map<string, Function>();
				const watcher = {
					on: vi.fn((event: string, callback: Function) => {
						callbacks.set(event, callback);
						return watcher;
					}),
					close: vi.fn(),
				};
				const chokidar = await import('chokidar');
				vi.mocked(chokidar.default.watch).mockReturnValueOnce(watcher as any);

				const watchHandler = handlers.get('autorun:watchFolder');
				await watchHandler!({} as any, '/test/folder');

				callbacks.get('add')?.('/test/folder/new-doc.md');

				const unwatchHandler = handlers.get('autorun:unwatchFolder');
				const result = await unwatchHandler!({} as any, '/test/folder');

				vi.advanceTimersByTime(301);

				expect(result.success).toBe(true);
				expect(watcher.close).toHaveBeenCalled();
				expect(mockMainWindow.webContents?.send).not.toHaveBeenCalledWith(
					'autorun:fileChanged',
					expect.anything()
				);
			} finally {
				vi.useRealTimers();
			}
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

	describe('autorun:createWorkingCopy', () => {
		it('should create a local working copy for a document', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.copyFile).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:createWorkingCopy');
			const result = await handler!({} as any, '/test/folder', 'doc1', 3);

			expect(result.success).toBe(true);
			expect(result.workingCopyPath).toMatch(/^runs\/doc1-\d+-loop-3$/);
			expect(result.originalPath).toBe('doc1');
			expect(fs.mkdir).toHaveBeenCalledWith(path.join('/test/folder', 'runs'), {
				recursive: true,
			});
			expect(fs.copyFile).toHaveBeenCalledWith(
				expect.stringContaining('doc1.md'),
				expect.stringMatching(/doc1-\d+-loop-3\.md$/)
			);
		});

		it('should preserve subdirectory structure for local working copies', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.copyFile).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:createWorkingCopy');
			const result = await handler!({} as any, '/test/folder', 'phase/doc1.md', 4);

			expect(result.success).toBe(true);
			expect(result.workingCopyPath).toMatch(/^runs\/phase\/doc1-\d+-loop-4$/);
			expect(result.originalPath).toBe('phase/doc1');
			expect(fs.mkdir).toHaveBeenCalledWith(path.join('/test/folder', 'runs', 'phase'), {
				recursive: true,
			});
		});

		it('should return an error for missing local source documents', async () => {
			vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

			const handler = handlers.get('autorun:createWorkingCopy');
			const result = await handler!({} as any, '/test/folder', 'missing', 1);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Source file not found');
			expect(fs.copyFile).not.toHaveBeenCalled();
		});

		it('should reject traversal paths for local working copies', async () => {
			const handler = handlers.get('autorun:createWorkingCopy');
			const result = await handler!({} as any, '/test/folder', '../etc/passwd', 1);

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
				{
					name: 'doc1.backup.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
				{
					name: 'doc2.backup.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
				{
					name: 'doc3.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
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
				{
					name: 'doc1.md',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
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
					{
						name: 'doc1.backup.md',
						isDirectory: () => false,
						isFile: () => true,
						isSymbolicLink: () => false,
					},
					{
						name: 'subfolder',
						isDirectory: () => true,
						isFile: () => false,
						isSymbolicLink: () => false,
					},
				] as any)
				.mockResolvedValueOnce([
					{
						name: 'nested.backup.md',
						isDirectory: () => false,
						isFile: () => true,
						isSymbolicLink: () => false,
					},
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

	describe('SSH remote operations', () => {
		describe('autorun:listDocs SSH', () => {
			it('should list remote markdown files and resolve symlinked file entries', async () => {
				mockReadDirRemote.mockResolvedValue({
					success: true,
					data: [
						{ name: '.hidden.md', isDirectory: false, isSymlink: false },
						{ name: 'linked-folder', isDirectory: false, isSymlink: true },
						{ name: 'linked.md', isDirectory: false, isSymlink: true },
						{ name: 'real.md', isDirectory: false, isSymlink: false },
						{ name: 'notes.txt', isDirectory: false, isSymlink: false },
					],
				});
				mockStatRemote.mockImplementation(async (target: string) => ({
					success: true,
					data: { isDirectory: target.endsWith('linked-folder') },
				}));

				const handler = handlers.get('autorun:listDocs');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.files).toEqual(['linked', 'real']);
				expect(mockReadDirRemote).toHaveBeenCalledWith('/remote/folder', sampleSshRemote);
				expect(mockStatRemote).toHaveBeenCalledWith('/remote/folder/linked.md', sampleSshRemote);
				expect(mockStatRemote).toHaveBeenCalledWith(
					'/remote/folder/linked-folder',
					sampleSshRemote
				);
			});

			it('should include remote folders that contain markdown files', async () => {
				mockReadDirRemote
					.mockResolvedValueOnce({
						success: true,
						data: [
							{ name: 'root.md', isDirectory: false, isSymlink: false },
							{ name: 'subfolder', isDirectory: true, isSymlink: false },
						],
					})
					.mockResolvedValueOnce({
						success: true,
						data: [{ name: 'nested.md', isDirectory: false, isSymlink: false }],
					});

				const handler = handlers.get('autorun:listDocs');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.files).toEqual(['subfolder/nested', 'root']);
			});

			it('should skip remote symlinks that cannot be statted', async () => {
				mockReadDirRemote.mockResolvedValue({
					success: true,
					data: [{ name: 'broken.md', isDirectory: false, isSymlink: true }],
				});
				mockStatRemote.mockResolvedValue({
					success: false,
					error: 'ENOENT',
				});

				const handler = handlers.get('autorun:listDocs');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.files).toEqual([]);
			});

			it('should return an empty remote tree when the directory cannot be read', async () => {
				mockReadDirRemote.mockResolvedValue({
					success: false,
					error: 'Permission denied',
				});

				const handler = handlers.get('autorun:listDocs');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.files).toEqual([]);
				expect(result.tree).toEqual([]);
			});
		});

		describe('autorun:readDoc SSH', () => {
			it('should read a remote markdown document', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: true,
					data: '# Remote Doc',
				});

				const handler = handlers.get('autorun:readDoc');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.content).toBe('# Remote Doc');
				expect(mockReadFileRemote).toHaveBeenCalledWith('/remote/folder/doc1.md', sampleSshRemote);
				expect(fs.access).not.toHaveBeenCalled();
			});

			it('should return remote read errors', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: false,
					error: 'Read failed',
				});

				const handler = handlers.get('autorun:readDoc');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Read failed');
			});
		});

		describe('autorun:writeDoc SSH', () => {
			it('should create a missing remote parent directory before writing', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: false });
				mockMkdirRemote.mockResolvedValue({ success: true });
				mockWriteFileRemote.mockResolvedValue({ success: true });

				const handler = handlers.get('autorun:writeDoc');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'subdir/doc1',
					'# Remote Content',
					'ssh-remote-1'
				);

				expect(result.success).toBe(true);
				expect(mockExistsRemote).toHaveBeenCalledWith('/remote/folder/subdir', sampleSshRemote);
				expect(mockMkdirRemote).toHaveBeenCalledWith(
					'/remote/folder/subdir',
					sampleSshRemote,
					true
				);
				expect(mockWriteFileRemote).toHaveBeenCalledWith(
					'/remote/folder/subdir/doc1.md',
					'# Remote Content',
					sampleSshRemote
				);
			});

			it('should return remote parent directory creation errors', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: false });
				mockMkdirRemote.mockResolvedValue({
					success: false,
					error: 'mkdir failed',
				});

				const handler = handlers.get('autorun:writeDoc');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'subdir/doc1',
					'# Remote Content',
					'ssh-remote-1'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('mkdir failed');
				expect(mockWriteFileRemote).not.toHaveBeenCalled();
			});

			it('should return remote write errors', async () => {
				mockWriteFileRemote.mockResolvedValue({
					success: false,
					error: 'write failed',
				});

				const handler = handlers.get('autorun:writeDoc');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'doc1',
					'# Remote Content',
					'ssh-remote-1'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('write failed');
			});
		});

		describe('autorun:saveImage SSH', () => {
			it('should use mkdirRemote and writeFileRemote when sshRemoteId is provided', async () => {
				// Mock existsRemote to say images directory doesn't exist
				mockExistsRemote.mockResolvedValue({ success: true, data: false });
				mockMkdirRemote.mockResolvedValue({ success: true });
				mockWriteFileRemote.mockResolvedValue({ success: true });

				const base64Data = Buffer.from('fake image data').toString('base64');

				const handler = handlers.get('autorun:saveImage');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'doc1',
					base64Data,
					'png',
					'ssh-remote-1'
				);

				expect(result.success).toBe(true);
				expect(result.relativePath).toMatch(/^images\/doc1-\d+\.png$/);

				// Verify remote operations were called
				expect(mockExistsRemote).toHaveBeenCalledWith('/remote/folder/images', sampleSshRemote);
				expect(mockMkdirRemote).toHaveBeenCalledWith(
					'/remote/folder/images',
					sampleSshRemote,
					true
				);
				expect(mockWriteFileRemote).toHaveBeenCalledWith(
					expect.stringContaining('/remote/folder/images/doc1-'),
					expect.any(Buffer),
					sampleSshRemote
				);

				// Local fs should NOT be called
				expect(fs.mkdir).not.toHaveBeenCalled();
				expect(fs.writeFile).not.toHaveBeenCalled();
			});

			it('should return remote image directory creation errors', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: false });
				mockMkdirRemote.mockResolvedValue({
					success: false,
					error: 'image mkdir failed',
				});

				const handler = handlers.get('autorun:saveImage');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'doc1',
					Buffer.from('fake image data').toString('base64'),
					'png',
					'ssh-remote-1'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('image mkdir failed');
				expect(mockWriteFileRemote).not.toHaveBeenCalled();
			});

			it('should return remote image write errors', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: true });
				mockWriteFileRemote.mockResolvedValue({
					success: false,
					error: 'image write failed',
				});

				const handler = handlers.get('autorun:saveImage');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'doc1',
					Buffer.from('fake image data').toString('base64'),
					'png',
					'ssh-remote-1'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('image write failed');
			});

			it('should use local fs when sshRemoteId is not provided', async () => {
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);

				const base64Data = Buffer.from('fake image data').toString('base64');

				const handler = handlers.get('autorun:saveImage');
				const result = await handler!({} as any, '/test/folder', 'doc1', base64Data, 'png');

				expect(result.success).toBe(true);
				expect(fs.mkdir).toHaveBeenCalled();
				expect(fs.writeFile).toHaveBeenCalled();

				// Remote operations should NOT be called
				expect(mockExistsRemote).not.toHaveBeenCalled();
				expect(mockMkdirRemote).not.toHaveBeenCalled();
				expect(mockWriteFileRemote).not.toHaveBeenCalled();
			});
		});

		describe('autorun:deleteImage SSH', () => {
			it('should use deleteRemote when sshRemoteId is provided', async () => {
				mockDeleteRemote.mockResolvedValue({ success: true });

				const handler = handlers.get('autorun:deleteImage');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'images/doc1-123.png',
					'ssh-remote-1'
				);

				expect(result.success).toBe(true);
				expect(mockDeleteRemote).toHaveBeenCalledWith(
					'/remote/folder/images/doc1-123.png',
					sampleSshRemote,
					false
				);

				// Local fs should NOT be called
				expect(fs.access).not.toHaveBeenCalled();
				expect(fs.unlink).not.toHaveBeenCalled();
			});

			it('should return remote delete errors', async () => {
				mockDeleteRemote.mockResolvedValue({
					success: false,
					error: 'delete failed',
				});

				const handler = handlers.get('autorun:deleteImage');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'images/doc1-123.png',
					'ssh-remote-1'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('delete failed');
			});

			it('should use local fs when sshRemoteId is not provided', async () => {
				vi.mocked(fs.access).mockResolvedValue(undefined);
				vi.mocked(fs.unlink).mockResolvedValue(undefined);

				const handler = handlers.get('autorun:deleteImage');
				const result = await handler!({} as any, '/test/folder', 'images/doc1-123.png');

				expect(result.success).toBe(true);
				expect(fs.access).toHaveBeenCalled();
				expect(fs.unlink).toHaveBeenCalled();

				// Remote operations should NOT be called
				expect(mockDeleteRemote).not.toHaveBeenCalled();
			});
		});

		describe('autorun:replaceImage SSH', () => {
			it('should overwrite an existing remote image in place', async () => {
				mockStatRemote.mockResolvedValue({
					success: true,
					data: { isDirectory: false },
				});
				mockWriteFileRemote.mockResolvedValue({ success: true });

				const handler = handlers.get('autorun:replaceImage');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'images/doc1-123.png',
					Buffer.from('updated image').toString('base64'),
					'ssh-remote-1'
				);

				expect(result.success).toBe(true);
				expect(result.relativePath).toBe('images/doc1-123.png');
				expect(mockStatRemote).toHaveBeenCalledWith(
					'/remote/folder/images/doc1-123.png',
					sampleSshRemote
				);
				expect(mockWriteFileRemote).toHaveBeenCalledWith(
					'/remote/folder/images/doc1-123.png',
					expect.any(Buffer),
					sampleSshRemote
				);
			});

			it('should not create a missing remote image while replacing', async () => {
				mockStatRemote.mockResolvedValue({
					success: false,
					error: 'missing',
				});

				const handler = handlers.get('autorun:replaceImage');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'images/doc1-123.png',
					Buffer.from('updated image').toString('base64'),
					'ssh-remote-1'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('Image file not found');
				expect(mockWriteFileRemote).not.toHaveBeenCalled();
			});

			it('should return remote replace write errors', async () => {
				mockStatRemote.mockResolvedValue({
					success: true,
					data: { isDirectory: false },
				});
				mockWriteFileRemote.mockResolvedValue({
					success: false,
					error: 'replace failed',
				});

				const handler = handlers.get('autorun:replaceImage');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'images/doc1-123.png',
					Buffer.from('updated image').toString('base64'),
					'ssh-remote-1'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('replace failed');
			});
		});

		describe('autorun:listImages SSH', () => {
			it('should use existsRemote and readDirRemote when sshRemoteId is provided', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: true });
				mockReadDirRemote.mockResolvedValue({
					success: true,
					data: [
						{ name: 'doc1-123.png', isDirectory: false, isSymlink: false },
						{ name: 'doc1-456.jpg', isDirectory: false, isSymlink: false },
						{ name: 'doc1-directory.png', isDirectory: true, isSymlink: false },
						{ name: 'other-789.png', isDirectory: false, isSymlink: false },
					],
				});

				const handler = handlers.get('autorun:listImages');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.images).toHaveLength(2);
				expect(result.images[0].filename).toBe('doc1-123.png');
				expect(result.images[1].filename).toBe('doc1-456.jpg');

				// Verify remote operations were called
				expect(mockExistsRemote).toHaveBeenCalledWith('/remote/folder/images', sampleSshRemote);
				expect(mockReadDirRemote).toHaveBeenCalledWith('/remote/folder/images', sampleSshRemote);

				// Local fs should NOT be called
				expect(fs.access).not.toHaveBeenCalled();
				expect(fs.readdir).not.toHaveBeenCalled();
			});

			it('should return empty images when remote images directory does not exist', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: false });

				const handler = handlers.get('autorun:listImages');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.images).toEqual([]);
				expect(mockReadDirRemote).not.toHaveBeenCalled();
			});

			it('should return remote image directory read errors', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: true });
				mockReadDirRemote.mockResolvedValue({
					success: false,
					error: 'image read failed',
				});

				const handler = handlers.get('autorun:listImages');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('image read failed');
			});
		});

		describe('autorun:watchFolder SSH', () => {
			it('should return remote polling mode when the remote folder exists', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: true });

				const handler = handlers.get('autorun:watchFolder');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.isRemote).toBe(true);
				expect(result.message).toContain('polling');
				expect(mockMkdirRemote).not.toHaveBeenCalled();
			});

			it('should create a missing remote folder before returning polling mode', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: false });
				mockMkdirRemote.mockResolvedValue({ success: true });

				const handler = handlers.get('autorun:watchFolder');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.isRemote).toBe(true);
				expect(mockMkdirRemote).toHaveBeenCalledWith('/remote/folder', sampleSshRemote, true);
			});

			it('should return remote folder creation errors', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: false });
				mockMkdirRemote.mockResolvedValue({
					success: false,
					error: 'remote mkdir failed',
				});

				const handler = handlers.get('autorun:watchFolder');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('remote mkdir failed');
			});
		});

		describe('autorun:createBackup SSH', () => {
			it('should use readFileRemote and writeFileRemote when sshRemoteId is provided', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: true,
					data: '# Original Content',
				});
				mockWriteFileRemote.mockResolvedValue({ success: true });

				const handler = handlers.get('autorun:createBackup');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.backupFilename).toBe('doc1.backup.md');

				// Verify remote operations were called
				expect(mockReadFileRemote).toHaveBeenCalledWith('/remote/folder/doc1.md', sampleSshRemote);
				expect(mockWriteFileRemote).toHaveBeenCalledWith(
					'/remote/folder/doc1.backup.md',
					'# Original Content',
					sampleSshRemote
				);

				// Local fs should NOT be called
				expect(fs.access).not.toHaveBeenCalled();
				expect(fs.copyFile).not.toHaveBeenCalled();
			});

			it('should return remote source read errors', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: false,
					error: 'backup source missing',
				});

				const handler = handlers.get('autorun:createBackup');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('backup source missing');
				expect(mockWriteFileRemote).not.toHaveBeenCalled();
			});

			it('should return remote backup write errors', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: true,
					data: '# Original Content',
				});
				mockWriteFileRemote.mockResolvedValue({
					success: false,
					error: 'backup write failed',
				});

				const handler = handlers.get('autorun:createBackup');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('backup write failed');
			});

			it('should use local fs when sshRemoteId is not provided', async () => {
				vi.mocked(fs.access).mockResolvedValue(undefined);
				vi.mocked(fs.copyFile).mockResolvedValue(undefined);

				const handler = handlers.get('autorun:createBackup');
				const result = await handler!({} as any, '/test/folder', 'doc1');

				expect(result.success).toBe(true);
				expect(fs.access).toHaveBeenCalled();
				expect(fs.copyFile).toHaveBeenCalled();

				// Remote operations should NOT be called
				expect(mockReadFileRemote).not.toHaveBeenCalled();
				expect(mockWriteFileRemote).not.toHaveBeenCalled();
			});
		});

		describe('autorun:restoreBackup SSH', () => {
			it('should use remote utilities for read, write, and delete operations when sshRemoteId is provided', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: true,
					data: '# Backup Content',
				});
				mockWriteFileRemote.mockResolvedValue({ success: true });
				mockDeleteRemote.mockResolvedValue({ success: true });

				const handler = handlers.get('autorun:restoreBackup');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(result.success).toBe(true);

				// Verify remote operations were called in order
				expect(mockReadFileRemote).toHaveBeenCalledWith(
					'/remote/folder/doc1.backup.md',
					sampleSshRemote
				);
				expect(mockWriteFileRemote).toHaveBeenCalledWith(
					'/remote/folder/doc1.md',
					'# Backup Content',
					sampleSshRemote
				);
				expect(mockDeleteRemote).toHaveBeenCalledWith(
					'/remote/folder/doc1.backup.md',
					sampleSshRemote,
					false
				);

				// Local fs should NOT be called
				expect(fs.access).not.toHaveBeenCalled();
				expect(fs.copyFile).not.toHaveBeenCalled();
				expect(fs.unlink).not.toHaveBeenCalled();
			});

			it('should return remote missing backup errors', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: false,
					error: 'missing backup',
				});

				const handler = handlers.get('autorun:restoreBackup');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Backup file not found');
				expect(mockWriteFileRemote).not.toHaveBeenCalled();
			});

			it('should return remote restore write errors', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: true,
					data: '# Backup Content',
				});
				mockWriteFileRemote.mockResolvedValue({
					success: false,
					error: 'restore write failed',
				});

				const handler = handlers.get('autorun:restoreBackup');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('restore write failed');
				expect(mockDeleteRemote).not.toHaveBeenCalled();
			});

			it('should continue even if remote backup delete fails', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: true,
					data: '# Backup Content',
				});
				mockWriteFileRemote.mockResolvedValue({ success: true });
				mockDeleteRemote.mockResolvedValue({
					success: false,
					error: 'Delete failed',
				});

				const handler = handlers.get('autorun:restoreBackup');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				// Restore should still succeed even if backup delete fails
				expect(result.success).toBe(true);
			});
		});

		describe('autorun:createWorkingCopy SSH', () => {
			it('should use mkdirRemote and remote file copy when sshRemoteId is provided', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: true,
					data: '# Source Content',
				});
				mockMkdirRemote.mockResolvedValue({ success: true });
				mockWriteFileRemote.mockResolvedValue({ success: true });

				const handler = handlers.get('autorun:createWorkingCopy');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 1, 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.workingCopyPath).toMatch(/^runs\/doc1-\d+-loop-1$/);
				expect(result.originalPath).toBe('doc1');

				// Verify remote operations were called
				expect(mockReadFileRemote).toHaveBeenCalledWith('/remote/folder/doc1.md', sampleSshRemote);
				expect(mockMkdirRemote).toHaveBeenCalledWith('/remote/folder/runs', sampleSshRemote, true);
				expect(mockWriteFileRemote).toHaveBeenCalledWith(
					expect.stringContaining('/remote/folder/runs/doc1-'),
					'# Source Content',
					sampleSshRemote
				);

				// Local fs should NOT be called
				expect(fs.access).not.toHaveBeenCalled();
				expect(fs.mkdir).not.toHaveBeenCalled();
				expect(fs.copyFile).not.toHaveBeenCalled();
			});

			it('should handle subdirectory paths correctly with SSH', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: true,
					data: '# Nested Content',
				});
				mockMkdirRemote.mockResolvedValue({ success: true });
				mockWriteFileRemote.mockResolvedValue({ success: true });

				const handler = handlers.get('autorun:createWorkingCopy');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'subdir/nested-doc',
					2,
					'ssh-remote-1'
				);

				expect(result.success).toBe(true);
				expect(result.workingCopyPath).toMatch(/^runs\/subdir\/nested-doc-\d+-loop-2$/);
				expect(result.originalPath).toBe('subdir/nested-doc');

				// Verify remote mkdir creates the correct subdirectory
				expect(mockMkdirRemote).toHaveBeenCalledWith(
					'/remote/folder/runs/subdir',
					sampleSshRemote,
					true
				);
			});

			it('should return remote source read errors', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: false,
					error: 'Source missing',
				});

				const handler = handlers.get('autorun:createWorkingCopy');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 1, 'ssh-remote-1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Source missing');
				expect(mockMkdirRemote).not.toHaveBeenCalled();
				expect(mockWriteFileRemote).not.toHaveBeenCalled();
			});

			it('should return remote runs directory creation errors', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: true,
					data: '# Source Content',
				});
				mockMkdirRemote.mockResolvedValue({
					success: false,
					error: 'Cannot create runs',
				});

				const handler = handlers.get('autorun:createWorkingCopy');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 1, 'ssh-remote-1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Cannot create runs');
				expect(mockWriteFileRemote).not.toHaveBeenCalled();
			});

			it('should return remote working copy write errors', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: true,
					data: '# Source Content',
				});
				mockMkdirRemote.mockResolvedValue({ success: true });
				mockWriteFileRemote.mockResolvedValue({
					success: false,
					error: 'Cannot write copy',
				});

				const handler = handlers.get('autorun:createWorkingCopy');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 1, 'ssh-remote-1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Cannot write copy');
			});
		});

		describe('autorun:deleteBackups SSH', () => {
			it('should use readDirRemote and deleteRemote when sshRemoteId is provided', async () => {
				mockReadDirRemote.mockResolvedValue({
					success: true,
					data: [
						{ name: 'doc1.backup.md', isDirectory: false, isSymlink: false },
						{ name: 'doc2.backup.md', isDirectory: false, isSymlink: false },
						{ name: 'doc3.md', isDirectory: false, isSymlink: false },
					],
				});
				mockDeleteRemote.mockResolvedValue({ success: true });

				const handler = handlers.get('autorun:deleteBackups');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.deletedCount).toBe(2);

				// Verify remote operations were called
				expect(mockReadDirRemote).toHaveBeenCalledWith('/remote/folder', sampleSshRemote);
				expect(mockDeleteRemote).toHaveBeenCalledTimes(2);
				expect(mockDeleteRemote).toHaveBeenCalledWith(
					'/remote/folder/doc1.backup.md',
					sampleSshRemote,
					false
				);
				expect(mockDeleteRemote).toHaveBeenCalledWith(
					'/remote/folder/doc2.backup.md',
					sampleSshRemote,
					false
				);

				// Local fs should NOT be called
				expect(fs.stat).not.toHaveBeenCalled();
				expect(fs.readdir).not.toHaveBeenCalled();
				expect(fs.unlink).not.toHaveBeenCalled();
			});

			it('should recursively delete backups in subdirectories with SSH', async () => {
				// Root directory has one backup and one subdirectory
				mockReadDirRemote
					.mockResolvedValueOnce({
						success: true,
						data: [
							{ name: 'doc1.backup.md', isDirectory: false, isSymlink: false },
							{ name: 'subfolder', isDirectory: true, isSymlink: false },
						],
					})
					// Subdirectory has one backup
					.mockResolvedValueOnce({
						success: true,
						data: [{ name: 'nested.backup.md', isDirectory: false, isSymlink: false }],
					});
				mockDeleteRemote.mockResolvedValue({ success: true });

				const handler = handlers.get('autorun:deleteBackups');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.deletedCount).toBe(2);
				expect(mockDeleteRemote).toHaveBeenCalledTimes(2);
			});

			it('should handle delete failures gracefully with SSH', async () => {
				mockReadDirRemote.mockResolvedValue({
					success: true,
					data: [
						{ name: 'doc1.backup.md', isDirectory: false, isSymlink: false },
						{ name: 'doc2.backup.md', isDirectory: false, isSymlink: false },
					],
				});
				// First delete succeeds, second fails
				mockDeleteRemote
					.mockResolvedValueOnce({ success: true })
					.mockResolvedValueOnce({ success: false, error: 'Permission denied' });

				const handler = handlers.get('autorun:deleteBackups');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				// Should still succeed, just with fewer deletions
				expect(result.success).toBe(true);
				expect(result.deletedCount).toBe(1);
			});

			it('should skip unreadable remote backup directories', async () => {
				mockReadDirRemote.mockResolvedValue({
					success: false,
					error: 'Permission denied',
				});

				const handler = handlers.get('autorun:deleteBackups');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.deletedCount).toBe(0);
				expect(mockDeleteRemote).not.toHaveBeenCalled();
			});
		});

		describe('SSH remote lookup failure', () => {
			it.each([
				['autorun:listDocs', ['/remote/folder', 'non-existent-ssh-remote']],
				['autorun:readDoc', ['/remote/folder', 'doc1', 'non-existent-ssh-remote']],
				['autorun:writeDoc', ['/remote/folder', 'doc1', '# Content', 'non-existent-ssh-remote']],
				[
					'autorun:saveImage',
					[
						'/remote/folder',
						'doc1',
						Buffer.from('fake image data').toString('base64'),
						'png',
						'non-existent-ssh-remote',
					],
				],
				[
					'autorun:deleteImage',
					['/remote/folder', 'images/doc1-123.png', 'non-existent-ssh-remote'],
				],
				[
					'autorun:replaceImage',
					[
						'/remote/folder',
						'images/doc1-123.png',
						Buffer.from('updated image').toString('base64'),
						'non-existent-ssh-remote',
					],
				],
				['autorun:listImages', ['/remote/folder', 'doc1', 'non-existent-ssh-remote']],
				['autorun:watchFolder', ['/remote/folder', 'non-existent-ssh-remote']],
				['autorun:createBackup', ['/remote/folder', 'doc1', 'non-existent-ssh-remote']],
				['autorun:restoreBackup', ['/remote/folder', 'doc1', 'non-existent-ssh-remote']],
				['autorun:createWorkingCopy', ['/remote/folder', 'doc1', 1, 'non-existent-ssh-remote']],
				['autorun:deleteBackups', ['/remote/folder', 'non-existent-ssh-remote']],
			])('should return error when SSH remote ID is not found for %s', async (channel, args) => {
				mockSettingsStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
					if (key === 'sshRemotes') return [];
					return defaultValue;
				});

				const handler = handlers.get(channel);
				const result = await handler!({} as any, ...(args as unknown[]));

				expect(result.success).toBe(false);
				expect(result.error).toContain('SSH remote not found');
			});

			it('should still use disabled SSH remote (does not check enabled status)', async () => {
				// Return SSH remote that is disabled
				// Note: Unlike marketplace/git/agentSessions handlers, autorun handlers
				// do NOT filter by enabled status - they just look up by ID
				mockSettingsStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
					if (key === 'sshRemotes') return [{ ...sampleSshRemote, enabled: false }];
					return defaultValue;
				});

				// Mock remote operations - even disabled remotes will be used
				mockReadFileRemote.mockResolvedValue({
					success: true,
					data: '# Original Content',
				});
				mockWriteFileRemote.mockResolvedValue({ success: true });

				const handler = handlers.get('autorun:createBackup');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				// The handler uses the disabled remote (doesn't check enabled status)
				// Remote operations are called with the disabled remote config
				expect(result.success).toBe(true);
				expect(mockReadFileRemote).toHaveBeenCalled();
				expect(mockWriteFileRemote).toHaveBeenCalled();
			});

			it('should use local fs for all operations when settingsStore is not provided', async () => {
				// Clear handlers and re-register without settingsStore
				handlers.clear();
				vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
					handlers.set(channel, handler);
				});

				// Re-register handlers WITHOUT settingsStore
				registerAutorunHandlers({
					mainWindow: mockMainWindow as BrowserWindow,
					getMainWindow: () => mockMainWindow as BrowserWindow,
					app: mockApp as App,
					// Note: settingsStore is NOT provided
				});

				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);

				const base64Data = Buffer.from('fake image data').toString('base64');
				const handler = handlers.get('autorun:saveImage');

				// Passing sshRemoteId should fail when settingsStore is not available
				const result = await handler!(
					{} as any,
					'/test/folder',
					'doc1',
					base64Data,
					'png',
					'ssh-remote-1'
				);

				// Should fail because SSH remote lookup fails without settingsStore
				expect(result.success).toBe(false);
				expect(result.error).toContain('SSH remote not found');
			});
		});
	});
});
