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
import {
	getAutoRunWatcherCount,
	registerAutorunHandlers,
} from '../../../../main/ipc/handlers/autorun';
import fs from 'fs/promises';
import path from 'path';
import chokidar from 'chokidar';
import Store from 'electron-store';
import type { SshRemoteConfig } from '../../../../shared/types';
import { logger } from '../../../../main/utils/logger';

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
} = vi.hoisted(() => ({
	mockReadDirRemote: vi.fn(),
	mockReadFileRemote: vi.fn(),
	mockWriteFileRemote: vi.fn(),
	mockExistsRemote: vi.fn(),
	mockMkdirRemote: vi.fn(),
	mockDeleteRemote: vi.fn(),
}));

vi.mock('../../../../main/utils/remote-fs', () => ({
	readDirRemote: mockReadDirRemote,
	readFileRemote: mockReadFileRemote,
	writeFileRemote: mockWriteFileRemote,
	existsRemote: mockExistsRemote,
	mkdirRemote: mockMkdirRemote,
	deleteRemote: mockDeleteRemote,
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
		appEventHandlers.get('before-quit')?.();
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

		it('should sort folders before files and omit folders without markdown files', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);
			vi.mocked(fs.readdir).mockImplementation(async (dirPath) => {
				if (dirPath === '/test/folder') {
					return [
						{
							name: 'z-file.md',
							isDirectory: () => false,
							isFile: () => true,
							isSymbolicLink: () => false,
						},
						{
							name: 'empty-folder',
							isDirectory: () => true,
							isFile: () => false,
							isSymbolicLink: () => false,
						},
					] as any;
				}
				return [] as any;
			});

			const handler = handlers.get('autorun:listDocs');
			const result = await handler!({} as any, '/test/folder');

			expect(result.success).toBe(true);
			expect(result.files).toEqual(['z-file']);
			expect(result.tree).toEqual([
				{
					name: 'z-file',
					type: 'file',
					path: 'z-file',
				},
			]);
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
						name: 'subfolder',
						isDirectory: () => true,
						isFile: () => false,
						isSymbolicLink: () => false,
					},
					{
						name: 'root.md',
						isDirectory: () => false,
						isFile: () => true,
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

		it('should keep scanning when a subdirectory contains no markdown files', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);
			vi.mocked(fs.readdir)
				.mockResolvedValueOnce([
					{
						name: 'empty',
						isDirectory: () => true,
						isFile: () => false,
						isSymbolicLink: () => false,
					},
					{
						name: 'notes.txt',
						isDirectory: () => false,
						isFile: () => true,
						isSymbolicLink: () => false,
					},
				] as any)
				.mockResolvedValueOnce([
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
			expect(fs.readdir).toHaveBeenCalledTimes(2);
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

		it('should reject resolved paths outside the Auto Run folder', async () => {
			const resolveSpy = vi
				.spyOn(path, 'resolve')
				.mockReturnValueOnce('/test/secret/doc.md')
				.mockReturnValueOnce('/test/folder');

			try {
				const handler = handlers.get('autorun:readDoc');
				const result = await handler!({} as any, '/test/folder', 'doc1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Invalid file path');
				expect(fs.access).not.toHaveBeenCalled();
			} finally {
				resolveSpy.mockRestore();
			}
		});
	});

	describe('autorun:writeDoc', () => {
		let consoleLogSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		});

		afterEach(() => {
			consoleLogSpy.mockRestore();
		});

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

		it('should still validate and write filenames that cannot be URL decoded', async () => {
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

		it('should reject resolved write paths outside the Auto Run folder', async () => {
			const resolveSpy = vi
				.spyOn(path, 'resolve')
				.mockReturnValueOnce('/test/secret/doc.md')
				.mockReturnValueOnce('/test/folder');

			try {
				const handler = handlers.get('autorun:writeDoc');
				const result = await handler!({} as any, '/test/folder', 'doc1', 'content');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Invalid file path');
				expect(fs.writeFile).not.toHaveBeenCalled();
			} finally {
				resolveSpy.mockRestore();
			}
		});

		it('should reject missing parent directories that resolve outside the Auto Run folder', async () => {
			vi.mocked(fs.access).mockRejectedValueOnce(new Error('ENOENT'));

			const resolveSpy = vi
				.spyOn(path, 'resolve')
				.mockReturnValueOnce('/test/folder/nested/doc.md')
				.mockReturnValueOnce('/test/folder')
				.mockReturnValueOnce('/test/secret/nested')
				.mockReturnValueOnce('/test/folder');

			try {
				const handler = handlers.get('autorun:writeDoc');
				const result = await handler!({} as any, '/test/folder', 'nested/doc1', 'content');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Invalid parent directory');
				expect(fs.mkdir).not.toHaveBeenCalled();
				expect(fs.writeFile).not.toHaveBeenCalled();
			} finally {
				resolveSpy.mockRestore();
			}
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
			expect(fs.rm).toHaveBeenCalledWith(path.join('/test/project', 'Auto Run Docs'), {
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

		it('should no-op when stat fails for a permission-style error', async () => {
			vi.mocked(fs.stat).mockRejectedValue(new Error('EACCES'));

			const handler = handlers.get('autorun:deleteFolder');
			const result = await handler!({} as any, '/test/project');

			expect(result.success).toBe(true);
			expect(fs.rm).not.toHaveBeenCalled();
		});

		it('should reject deletion when the safety folder name check fails', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
			} as any);

			const basenameSpy = vi.spyOn(path, 'basename').mockReturnValueOnce('Not Auto Run Docs');

			try {
				const handler = handlers.get('autorun:deleteFolder');
				const result = await handler!({} as any, '/test/project');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Safety check failed');
				expect(fs.rm).not.toHaveBeenCalled();
			} finally {
				basenameSpy.mockRestore();
			}
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

		it('should reject document names that remain invalid after basename sanitization', async () => {
			const handler = handlers.get('autorun:listImages');
			const result = await handler!({} as any, '/test/folder', '../../..');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid document name');
			expect(fs.readdir).not.toHaveBeenCalled();
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

		it('should reject document names that remain invalid after basename sanitization', async () => {
			const handler = handlers.get('autorun:saveImage');
			const result = await handler!({} as any, '/test/folder', '../../..', 'ZmFrZQ==', 'png');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid document name');
			expect(fs.writeFile).not.toHaveBeenCalled();
		});

		it('should reject local image paths that resolve outside the Auto Run folder', async () => {
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);

			const resolveSpy = vi
				.spyOn(path, 'resolve')
				.mockReturnValueOnce('/test/secret/images/doc1.png')
				.mockReturnValueOnce('/test/folder');

			try {
				const handler = handlers.get('autorun:saveImage');
				const result = await handler!({} as any, '/test/folder', 'doc1', 'ZmFrZQ==', 'png');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Invalid file path');
				expect(fs.writeFile).not.toHaveBeenCalled();
			} finally {
				resolveSpy.mockRestore();
			}
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

		it('should reject local image deletions that resolve outside the Auto Run folder', async () => {
			const resolveSpy = vi
				.spyOn(path, 'resolve')
				.mockReturnValueOnce('/test/secret/images/doc1.png')
				.mockReturnValueOnce('/test/folder');

			try {
				const handler = handlers.get('autorun:deleteImage');
				const result = await handler!({} as any, '/test/folder', 'images/doc1.png');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Invalid file path');
				expect(fs.access).not.toHaveBeenCalled();
			} finally {
				resolveSpy.mockRestore();
			}
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

		it('should return polling mode for SSH folders and create missing remote folders', async () => {
			mockExistsRemote.mockResolvedValue({ success: true, data: false });
			mockMkdirRemote.mockResolvedValue({ success: true });

			const handler = handlers.get('autorun:watchFolder');
			const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

			expect(result).toMatchObject({
				success: true,
				isRemote: true,
				message: expect.stringContaining('polling'),
			});
			expect(mockExistsRemote).toHaveBeenCalledWith('/remote/folder', sampleSshRemote);
			expect(mockMkdirRemote).toHaveBeenCalledWith('/remote/folder', sampleSshRemote, true);
			expect(chokidar.watch).not.toHaveBeenCalled();
		});

		it('should return polling mode for SSH folders that already exist', async () => {
			mockExistsRemote.mockResolvedValue({ success: true, data: true });

			const handler = handlers.get('autorun:watchFolder');
			const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

			expect(result).toMatchObject({
				success: true,
				isRemote: true,
			});
			expect(mockMkdirRemote).not.toHaveBeenCalled();
			expect(chokidar.watch).not.toHaveBeenCalled();
		});

		it('should fail SSH folder watching when the remote folder cannot be created', async () => {
			mockExistsRemote.mockResolvedValue({ success: true, data: false });
			mockMkdirRemote.mockResolvedValue({ success: false });

			const handler = handlers.get('autorun:watchFolder');
			const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to create remote Auto Run folder');
		});

		it('should return an error when watching with an unknown SSH remote', async () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'sshRemotes') return [];
				return defaultValue;
			});

			const handler = handlers.get('autorun:watchFolder');
			const result = await handler!({} as any, '/remote/folder', 'missing-remote');

			expect(result.success).toBe(false);
			expect(result.error).toContain('SSH remote not found: missing-remote');
		});

		it('should publish debounced markdown file change events', async () => {
			vi.useFakeTimers();
			try {
				const watcherHandlers = new Map<string, Function>();
				const watcher = {
					on: vi.fn((event: string, callback: Function) => {
						watcherHandlers.set(event, callback);
						return watcher;
					}),
					close: vi.fn(),
				};
				vi.mocked(chokidar.watch).mockReturnValue(watcher as any);
				vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);

				const handler = handlers.get('autorun:watchFolder');
				const result = await handler!({} as any, '/test/folder');

				expect(result.success).toBe(true);
				expect(getAutoRunWatcherCount()).toBe(1);

				watcherHandlers.get('change')!('/test/folder/notes.txt');
				vi.advanceTimersByTime(300);
				expect(mockMainWindow.webContents?.send).not.toHaveBeenCalled();

				watcherHandlers.get('change')!('/test/folder/Nested/Task.md');
				vi.advanceTimersByTime(300);

				expect(mockMainWindow.webContents?.send).toHaveBeenCalledWith('autorun:fileChanged', {
					folderPath: '/test/folder',
					filename: 'Nested/Task',
					eventType: 'change',
				});
			} finally {
				vi.useRealTimers();
			}
		});

		it('should debounce rapid markdown file changes and log watcher errors', async () => {
			vi.useFakeTimers();
			try {
				const watcherHandlers = new Map<string, Function>();
				const watcher = {
					on: vi.fn((event: string, callback: Function) => {
						watcherHandlers.set(event, callback);
						return watcher;
					}),
					close: vi.fn(),
				};
				vi.mocked(chokidar.watch).mockReturnValue(watcher as any);
				vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);

				const handler = handlers.get('autorun:watchFolder');
				await handler!({} as any, '/test/folder');

				watcherHandlers.get('add')!('/test/folder/first.md');
				watcherHandlers.get('unlink')!('/test/folder/second.md');
				vi.advanceTimersByTime(300);

				expect(mockMainWindow.webContents?.send).toHaveBeenCalledTimes(1);
				expect(mockMainWindow.webContents?.send).toHaveBeenCalledWith('autorun:fileChanged', {
					folderPath: '/test/folder',
					filename: 'second',
					eventType: 'rename',
				});

				const error = new Error('watch failed');
				watcherHandlers.get('error')!(error);
				expect(logger.error).toHaveBeenCalledWith(
					'Auto Run watcher error for /test/folder',
					'[AutoRun]',
					error
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it('should drop debounced file events when the renderer is unavailable', async () => {
			vi.useFakeTimers();
			try {
				const watcherHandlers = new Map<string, Function>();
				const watcher = {
					on: vi.fn((event: string, callback: Function) => {
						watcherHandlers.set(event, callback);
						return watcher;
					}),
					close: vi.fn(),
				};
				vi.mocked(chokidar.watch).mockReturnValue(watcher as any);
				vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
				vi.mocked(mockMainWindow.webContents!.isDestroyed).mockReturnValue(true);

				const handler = handlers.get('autorun:watchFolder');
				await handler!({} as any, '/test/folder');

				watcherHandlers.get('change')!('/test/folder/Task.md');
				vi.advanceTimersByTime(300);

				expect(mockMainWindow.webContents?.send).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it('should close an existing watcher before replacing it for the same folder', async () => {
			const firstWatcher = {
				on: vi.fn().mockReturnThis(),
				close: vi.fn(),
			};
			const secondWatcher = {
				on: vi.fn().mockReturnThis(),
				close: vi.fn(),
			};
			vi.mocked(chokidar.watch)
				.mockReturnValueOnce(firstWatcher as any)
				.mockReturnValueOnce(secondWatcher as any);
			vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);

			const handler = handlers.get('autorun:watchFolder');
			const firstResult = await handler!({} as any, '/test/folder');
			const secondResult = await handler!({} as any, '/test/folder');

			expect(firstResult.success).toBe(true);
			expect(secondResult.success).toBe(true);
			expect(firstWatcher.close).toHaveBeenCalledTimes(1);
			expect(getAutoRunWatcherCount()).toBe(1);
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

		it('should create backup copy when filename already has an md extension', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.copyFile).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:createBackup');
			const result = await handler!({} as any, '/test/folder', 'doc1.md');

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

		it('should reject backup paths that resolve outside the Auto Run folder', async () => {
			const resolveSpy = vi
				.spyOn(path, 'resolve')
				.mockReturnValueOnce('/test/secret/doc.md')
				.mockReturnValueOnce('/test/folder');

			try {
				const handler = handlers.get('autorun:createBackup');
				const result = await handler!({} as any, '/test/folder', 'doc1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Invalid file path');
				expect(fs.copyFile).not.toHaveBeenCalled();
			} finally {
				resolveSpy.mockRestore();
			}
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

		it('should restore document when filename already has an md extension', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.copyFile).mockResolvedValue(undefined);
			vi.mocked(fs.unlink).mockResolvedValue(undefined);

			const handler = handlers.get('autorun:restoreBackup');
			const result = await handler!({} as any, '/test/folder', 'doc1.md');

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

		it('should reject restore paths that resolve outside the Auto Run folder', async () => {
			const resolveSpy = vi
				.spyOn(path, 'resolve')
				.mockReturnValueOnce('/test/secret/doc.md')
				.mockReturnValueOnce('/test/folder');

			try {
				const handler = handlers.get('autorun:restoreBackup');
				const result = await handler!({} as any, '/test/folder', 'doc1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Invalid file path');
				expect(fs.copyFile).not.toHaveBeenCalled();
			} finally {
				resolveSpy.mockRestore();
			}
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
		describe('autorun document SSH operations', () => {
			let consoleLogSpy: ReturnType<typeof vi.spyOn>;

			beforeEach(() => {
				consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			});

			afterEach(() => {
				consoleLogSpy.mockRestore();
			});

			it('should recursively list remote markdown documents', async () => {
				mockReadDirRemote
					.mockResolvedValueOnce({
						success: true,
						data: [
							{ name: 'root.md', isDirectory: false, isSymlink: false },
							{ name: 'nested', isDirectory: true, isSymlink: false },
							{ name: '.hidden.md', isDirectory: false, isSymlink: false },
							{ name: 'linked.md', isDirectory: false, isSymlink: true },
							{ name: 'notes.txt', isDirectory: false, isSymlink: false },
						],
					})
					.mockResolvedValueOnce({
						success: true,
						data: [{ name: 'child.MD', isDirectory: false, isSymlink: false }],
					});

				const handler = handlers.get('autorun:listDocs');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.files).toEqual(['nested/child', 'linked', 'root']);
				expect(result.tree).toEqual([
					{
						name: 'nested',
						type: 'folder',
						path: 'nested',
						children: [{ name: 'child', type: 'file', path: 'nested/child' }],
					},
					{ name: 'linked', type: 'file', path: 'linked' },
					{ name: 'root', type: 'file', path: 'root' },
				]);
				expect(mockReadDirRemote).toHaveBeenCalledWith('/remote/folder', sampleSshRemote);
				expect(mockReadDirRemote).toHaveBeenCalledWith('/remote/folder/nested', sampleSshRemote);
				expect(fs.stat).not.toHaveBeenCalled();
			});

			it('should skip remote subfolders that contain no markdown files', async () => {
				mockReadDirRemote
					.mockResolvedValueOnce({
						success: true,
						data: [
							{ name: 'empty', isDirectory: true, isSymlink: false },
							{ name: 'root.md', isDirectory: false, isSymlink: false },
						],
					})
					.mockResolvedValueOnce({
						success: true,
						data: [{ name: 'notes.txt', isDirectory: false, isSymlink: false }],
					});

				const handler = handlers.get('autorun:listDocs');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.files).toEqual(['root']);
				expect(result.tree).toEqual([{ name: 'root', type: 'file', path: 'root' }]);
			});

			it('should return an empty remote document list when remote directory reading fails', async () => {
				mockReadDirRemote.mockResolvedValue({
					success: false,
					error: 'Permission denied',
				});

				const handler = handlers.get('autorun:listDocs');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.files).toEqual([]);
				expect(result.tree).toEqual([]);
				expect(logger.warn).toHaveBeenCalledWith(
					'[AutoRun] Failed to read remote directory: Permission denied',
					'[AutoRun]'
				);
			});

			it('should read remote markdown documents', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: true,
					data: '# Remote Doc',
				});

				const handler = handlers.get('autorun:readDoc');
				const result = await handler!({} as any, '/remote/folder', 'subdir/doc', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.content).toBe('# Remote Doc');
				expect(mockReadFileRemote).toHaveBeenCalledWith(
					'/remote/folder/subdir/doc.md',
					sampleSshRemote
				);
				expect(fs.readFile).not.toHaveBeenCalled();
			});

			it('should return an error when remote document reading fails', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: false,
					error: 'Remote file missing',
				});

				const handler = handlers.get('autorun:readDoc');
				const result = await handler!({} as any, '/remote/folder', 'doc', 'ssh-remote-1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Remote file missing');
			});

			it('should use a fallback error when remote document reading fails without details', async () => {
				mockReadFileRemote.mockResolvedValue({
					success: false,
				});

				const handler = handlers.get('autorun:readDoc');
				const result = await handler!({} as any, '/remote/folder', 'doc', 'ssh-remote-1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Failed to read remote file');
			});

			it('should create remote parent folders before writing nested documents', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: false });
				mockMkdirRemote.mockResolvedValue({ success: true });
				mockWriteFileRemote.mockResolvedValue({ success: true });

				const handler = handlers.get('autorun:writeDoc');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'nested/doc',
					'# Remote Content',
					'ssh-remote-1'
				);

				expect(result.success).toBe(true);
				expect(mockExistsRemote).toHaveBeenCalledWith('/remote/folder/nested', sampleSshRemote);
				expect(mockMkdirRemote).toHaveBeenCalledWith(
					'/remote/folder/nested',
					sampleSshRemote,
					true
				);
				expect(mockWriteFileRemote).toHaveBeenCalledWith(
					'/remote/folder/nested/doc.md',
					'# Remote Content',
					sampleSshRemote
				);
				expect(fs.writeFile).not.toHaveBeenCalled();
			});

			it('should write remote nested documents when parent folder already exists', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: true });
				mockWriteFileRemote.mockResolvedValue({ success: true });

				const handler = handlers.get('autorun:writeDoc');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'nested/doc',
					'# Remote Content',
					'ssh-remote-1'
				);

				expect(result.success).toBe(true);
				expect(mockMkdirRemote).not.toHaveBeenCalled();
				expect(mockWriteFileRemote).toHaveBeenCalledWith(
					'/remote/folder/nested/doc.md',
					'# Remote Content',
					sampleSshRemote
				);
			});

			it('should fail when remote parent folder creation fails', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: false });
				mockMkdirRemote.mockResolvedValue({
					success: false,
					error: 'Cannot create directory',
				});

				const handler = handlers.get('autorun:writeDoc');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'nested/doc',
					'# Remote Content',
					'ssh-remote-1'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('Cannot create directory');
				expect(mockWriteFileRemote).not.toHaveBeenCalled();
			});

			it('should use a fallback error when remote parent folder creation fails without details', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: false });
				mockMkdirRemote.mockResolvedValue({ success: false });

				const handler = handlers.get('autorun:writeDoc');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'nested/doc',
					'# Remote Content',
					'ssh-remote-1'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('Failed to create remote parent directory');
				expect(mockWriteFileRemote).not.toHaveBeenCalled();
			});

			it('should fail when a remote document write fails without details', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: true });
				mockWriteFileRemote.mockResolvedValue({ success: false });

				const handler = handlers.get('autorun:writeDoc');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'doc',
					'# Remote Content',
					'ssh-remote-1'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('Failed to write remote file');
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

			it('should fail when remote image directory creation or image writing fails without details', async () => {
				const base64Data = Buffer.from('fake image data').toString('base64');
				const handler = handlers.get('autorun:saveImage');

				mockExistsRemote.mockResolvedValueOnce({ success: true, data: false });
				mockMkdirRemote.mockResolvedValueOnce({ success: false });
				const mkdirResult = await handler!(
					{} as any,
					'/remote/folder',
					'doc1',
					base64Data,
					'png',
					'ssh-remote-1'
				);

				expect(mkdirResult.success).toBe(false);
				expect(mkdirResult.error).toContain('Failed to create remote images directory');

				mockExistsRemote.mockResolvedValueOnce({ success: true, data: true });
				mockWriteFileRemote.mockResolvedValueOnce({ success: false });
				const writeResult = await handler!(
					{} as any,
					'/remote/folder',
					'doc1',
					base64Data,
					'png',
					'ssh-remote-1'
				);

				expect(writeResult.success).toBe(false);
				expect(writeResult.error).toContain('Failed to write remote image file');
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

			it('should fail when remote image deletion fails without details', async () => {
				mockDeleteRemote.mockResolvedValue({ success: false });

				const handler = handlers.get('autorun:deleteImage');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'images/doc1-123.png',
					'ssh-remote-1'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('Failed to delete remote image file');
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

			it('should fail when reading remote images fails without details', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: true });
				mockReadDirRemote.mockResolvedValue({ success: false });

				const handler = handlers.get('autorun:listImages');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(result.success).toBe(false);
				expect(result.error).toContain('Failed to read remote images directory');
			});

			it('should ignore remote image directories and include symlinked image files', async () => {
				mockExistsRemote.mockResolvedValue({ success: true, data: true });
				mockReadDirRemote.mockResolvedValue({
					success: true,
					data: [
						{ name: 'doc1-folder.png', isDirectory: true, isSymlink: false },
						{ name: 'doc1-linked.png', isDirectory: false, isSymlink: true },
						{ name: 'doc1-real.webp', isDirectory: false, isSymlink: false },
					],
				});

				const handler = handlers.get('autorun:listImages');
				const result = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.images).toEqual([
					{ filename: 'doc1-linked.png', relativePath: 'images/doc1-linked.png' },
					{ filename: 'doc1-real.webp', relativePath: 'images/doc1-real.webp' },
				]);
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

			it('should fail when remote backup read or write fails without details', async () => {
				const handler = handlers.get('autorun:createBackup');

				mockReadFileRemote.mockResolvedValueOnce({ success: false });
				const readResult = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(readResult.success).toBe(false);
				expect(readResult.error).toContain('Source file not found');

				mockReadFileRemote.mockResolvedValueOnce({ success: true, data: '# Original Content' });
				mockWriteFileRemote.mockResolvedValueOnce({ success: false });
				const writeResult = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(writeResult.success).toBe(false);
				expect(writeResult.error).toContain('Failed to write backup file');
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

			it('should fail when remote backup read or restore write fails without details', async () => {
				const handler = handlers.get('autorun:restoreBackup');

				mockReadFileRemote.mockResolvedValueOnce({ success: false });
				const readResult = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(readResult.success).toBe(false);
				expect(readResult.error).toContain('Backup file not found');

				mockReadFileRemote.mockResolvedValueOnce({ success: true, data: '# Backup Content' });
				mockWriteFileRemote.mockResolvedValueOnce({ success: false });
				const writeResult = await handler!({} as any, '/remote/folder', 'doc1', 'ssh-remote-1');

				expect(writeResult.success).toBe(false);
				expect(writeResult.error).toContain('Failed to restore backup');
			});
		});

		describe('autorun:createWorkingCopy local', () => {
			it('should create a local working copy in the Runs folder', async () => {
				vi.mocked(fs.access).mockResolvedValue(undefined);
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.copyFile).mockResolvedValue(undefined);

				const handler = handlers.get('autorun:createWorkingCopy');
				const result = await handler!({} as any, '/test/folder', 'doc1', 3);

				expect(result.success).toBe(true);
				expect(result.workingCopyPath).toMatch(/^Runs\/doc1-\d+-loop-3$/);
				expect(result.originalPath).toBe('doc1');
				expect(fs.mkdir).toHaveBeenCalledWith('/test/folder/Runs', { recursive: true });
				expect(fs.copyFile).toHaveBeenCalledWith(
					'/test/folder/doc1.md',
					expect.stringMatching(/^\/test\/folder\/Runs\/doc1-\d+-loop-3\.md$/)
				);
			});

			it('should create local working copies for nested documents', async () => {
				vi.mocked(fs.access).mockResolvedValue(undefined);
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.copyFile).mockResolvedValue(undefined);

				const handler = handlers.get('autorun:createWorkingCopy');
				const result = await handler!({} as any, '/test/folder', 'nested/doc1.md', 4);

				expect(result.success).toBe(true);
				expect(result.workingCopyPath).toMatch(/^Runs\/nested\/doc1-\d+-loop-4$/);
				expect(result.originalPath).toBe('nested/doc1');
				expect(fs.mkdir).toHaveBeenCalledWith('/test/folder/Runs/nested', { recursive: true });
			});

			it('should reject local working copy traversal attempts and missing source files', async () => {
				const handler = handlers.get('autorun:createWorkingCopy');
				const traversalResult = await handler!({} as any, '/test/folder', '../doc1', 1);

				expect(traversalResult.success).toBe(false);
				expect(traversalResult.error).toContain('Invalid filename');

				vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
				const missingResult = await handler!({} as any, '/test/folder', 'missing', 1);

				expect(missingResult.success).toBe(false);
				expect(missingResult.error).toContain('Source file not found');
			});

			it('should reject local source paths that resolve outside the Auto Run folder', async () => {
				const resolveSpy = vi
					.spyOn(path, 'resolve')
					.mockReturnValueOnce('/test/secret/doc.md')
					.mockReturnValueOnce('/test/folder');

				try {
					const handler = handlers.get('autorun:createWorkingCopy');
					const result = await handler!({} as any, '/test/folder', 'doc1', 1);

					expect(result.success).toBe(false);
					expect(result.error).toContain('Invalid file path');
					expect(fs.access).not.toHaveBeenCalled();
				} finally {
					resolveSpy.mockRestore();
				}
			});

			it('should reject local working-copy paths that resolve outside the Auto Run folder', async () => {
				vi.mocked(fs.access).mockResolvedValue(undefined);
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);

				const resolveSpy = vi
					.spyOn(path, 'resolve')
					.mockReturnValueOnce('/test/folder/doc.md')
					.mockReturnValueOnce('/test/folder')
					.mockReturnValueOnce('/test/secret/Runs/doc.md')
					.mockReturnValueOnce('/test/folder');

				try {
					const handler = handlers.get('autorun:createWorkingCopy');
					const result = await handler!({} as any, '/test/folder', 'doc1', 1);

					expect(result.success).toBe(false);
					expect(result.error).toContain('Invalid working copy path');
					expect(fs.copyFile).not.toHaveBeenCalled();
				} finally {
					resolveSpy.mockRestore();
				}
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
				expect(result.workingCopyPath).toMatch(/^Runs\/doc1-\d+-loop-1$/);
				expect(result.originalPath).toBe('doc1');

				// Verify remote operations were called
				expect(mockReadFileRemote).toHaveBeenCalledWith('/remote/folder/doc1.md', sampleSshRemote);
				expect(mockMkdirRemote).toHaveBeenCalledWith('/remote/folder/Runs', sampleSshRemote, true);
				expect(mockWriteFileRemote).toHaveBeenCalledWith(
					expect.stringContaining('/remote/folder/Runs/doc1-'),
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
				expect(result.workingCopyPath).toMatch(/^Runs\/subdir\/nested-doc-\d+-loop-2$/);
				expect(result.originalPath).toBe('subdir/nested-doc');

				// Verify remote mkdir creates the correct subdirectory
				expect(mockMkdirRemote).toHaveBeenCalledWith(
					'/remote/folder/Runs/subdir',
					sampleSshRemote,
					true
				);
			});

			it('should fail when remote working-copy helpers fail without details', async () => {
				const handler = handlers.get('autorun:createWorkingCopy');

				mockReadFileRemote.mockResolvedValueOnce({ success: false });
				const readResult = await handler!({} as any, '/remote/folder', 'doc1', 1, 'ssh-remote-1');

				expect(readResult.success).toBe(false);
				expect(readResult.error).toContain('Source file not found');

				mockReadFileRemote.mockResolvedValueOnce({ success: true, data: '# Source Content' });
				mockMkdirRemote.mockResolvedValueOnce({ success: false });
				const mkdirResult = await handler!({} as any, '/remote/folder', 'doc1', 1, 'ssh-remote-1');

				expect(mkdirResult.success).toBe(false);
				expect(mkdirResult.error).toContain('Failed to create Runs directory');

				mockReadFileRemote.mockResolvedValueOnce({ success: true, data: '# Source Content' });
				mockMkdirRemote.mockResolvedValueOnce({ success: true });
				mockWriteFileRemote.mockResolvedValueOnce({ success: false });
				const writeResult = await handler!({} as any, '/remote/folder', 'doc1', 1, 'ssh-remote-1');

				expect(writeResult.success).toBe(false);
				expect(writeResult.error).toContain('Failed to write working copy');
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
				mockReadDirRemote.mockResolvedValue({ success: false, error: 'Permission denied' });

				const handler = handlers.get('autorun:deleteBackups');
				const result = await handler!({} as any, '/remote/folder', 'ssh-remote-1');

				expect(result.success).toBe(true);
				expect(result.deletedCount).toBe(0);
				expect(mockDeleteRemote).not.toHaveBeenCalled();
				expect(logger.debug).toHaveBeenCalledWith(
					'[AutoRun] Skipping remote directory: /remote/folder - Permission denied',
					'[AutoRun]'
				);
			});
		});

		describe('SSH remote lookup failure', () => {
			it('should throw error when SSH remote ID is not found', async () => {
				// Return empty array - no SSH remotes configured
				mockSettingsStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
					if (key === 'sshRemotes') return [];
					return defaultValue;
				});

				const handler = handlers.get('autorun:saveImage');
				const result = await handler!(
					{} as any,
					'/remote/folder',
					'doc1',
					'ZmFrZQ==',
					'png',
					'non-existent-ssh-remote'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('SSH remote not found');
			});

			it('should return missing SSH remote errors for every remote-capable handler', async () => {
				const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
				mockSettingsStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
					if (key === 'sshRemotes') return [];
					return defaultValue;
				});

				try {
					const cases: Array<[string, unknown[]]> = [
						['autorun:listDocs', ['/remote/folder', 'missing-remote']],
						['autorun:readDoc', ['/remote/folder', 'doc1', 'missing-remote']],
						['autorun:writeDoc', ['/remote/folder', 'doc1', '# Content', 'missing-remote']],
						['autorun:deleteImage', ['/remote/folder', 'images/doc1.png', 'missing-remote']],
						['autorun:listImages', ['/remote/folder', 'doc1', 'missing-remote']],
						['autorun:createBackup', ['/remote/folder', 'doc1', 'missing-remote']],
						['autorun:restoreBackup', ['/remote/folder', 'doc1', 'missing-remote']],
						['autorun:createWorkingCopy', ['/remote/folder', 'doc1', 1, 'missing-remote']],
						['autorun:deleteBackups', ['/remote/folder', 'missing-remote']],
					];

					for (const [channel, args] of cases) {
						const handler = handlers.get(channel);
						const result = await handler!({} as any, ...args);

						expect(result.success).toBe(false);
						expect(result.error).toContain('SSH remote not found: missing-remote');
					}
				} finally {
					consoleLogSpy.mockRestore();
				}
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
