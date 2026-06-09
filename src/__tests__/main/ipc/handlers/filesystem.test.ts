import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';

// Track registered handlers
const registeredHandlers = new Map<string, Function>();

// Mock ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: Function) => {
			registeredHandlers.set(channel, handler);
		}),
	},
}));

// Mock os module
vi.mock('os', () => ({
	default: {
		homedir: vi.fn().mockReturnValue('/Users/testuser'),
	},
}));

// Mock fs/promises module
vi.mock('fs/promises', () => ({
	default: {
		readdir: vi.fn(),
		readFile: vi.fn(),
		stat: vi.fn(),
		writeFile: vi.fn(),
		rename: vi.fn(),
		rm: vi.fn(),
		unlink: vi.fn(),
	},
}));

// Mock logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock remote-fs utilities
vi.mock('../../../../main/utils/remote-fs', () => ({
	readDirRemote: vi.fn(),
	readFileRemote: vi.fn(),
	writeFileRemote: vi.fn(),
	statRemote: vi.fn(),
	directorySizeRemote: vi.fn(),
	renameRemote: vi.fn(),
	deleteRemote: vi.fn(),
	countItemsRemote: vi.fn(),
}));

// Mock stores
vi.mock('../../../../main/stores', () => ({
	getSshRemoteById: vi.fn(),
}));

import { registerFilesystemHandlers } from '../../../../main/ipc/handlers/filesystem';
import fs from 'fs/promises';
import { getSshRemoteById } from '../../../../main/stores';
import {
	readDirRemote,
	readFileRemote,
	writeFileRemote,
	statRemote,
	directorySizeRemote,
	countItemsRemote,
	renameRemote,
	deleteRemote,
} from '../../../../main/utils/remote-fs';

describe('filesystem handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();
		registerFilesystemHandlers();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('handler registration', () => {
		it('should register all filesystem handlers', () => {
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:homeDir', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:readDir', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:readFile', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:stat', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:directorySize', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:writeFile', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:rename', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:delete', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:countItems', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:fetchImageAsBase64', expect.any(Function));
		});
	});

	describe('fs:homeDir', () => {
		it('should return the home directory', async () => {
			const handler = registeredHandlers.get('fs:homeDir');
			expect(handler).toBeDefined();

			const result = await handler!({}, null);
			expect(result).toBe('/Users/testuser');
		});
	});

	describe('fs:readDir', () => {
		it('should read local directory entries', async () => {
			const mockEntries = [
				{
					name: 'file1.txt',
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
				{
					name: 'folder1',
					isDirectory: () => true,
					isFile: () => false,
					isSymbolicLink: () => false,
				},
			];
			vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);

			const handler = registeredHandlers.get('fs:readDir');
			const result = await handler!({}, '/test/path');

			expect(fs.readdir).toHaveBeenCalledWith('/test/path', { withFileTypes: true });
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				name: 'file1.txt',
				isDirectory: false,
				isFile: true,
				path: expect.stringContaining('file1.txt'),
			});
		});

		it('should read remote directory entries via SSH', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(readDirRemote).mockResolvedValue({
				success: true,
				data: [
					{ name: 'remote-file.txt', isDirectory: false, isSymlink: false },
					{ name: 'remote-folder', isDirectory: true, isSymlink: false },
				],
			});

			const handler = registeredHandlers.get('fs:readDir');
			const result = await handler!({}, '/remote/path', 'remote-1');

			expect(getSshRemoteById).toHaveBeenCalledWith('remote-1');
			expect(readDirRemote).toHaveBeenCalledWith('/remote/path', mockSshConfig);
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe('remote-file.txt');
			expect(result[0].isFile).toBe(true);
		});

		it('should map remote file symlinks as files and preserve trailing slash paths', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(readDirRemote).mockResolvedValue({
				success: true,
				data: [{ name: 'linked-file', isDirectory: false, isSymlink: true }],
			});

			const handler = registeredHandlers.get('fs:readDir');
			const result = await handler!({}, '/remote/path/', 'remote-1');

			expect(result[0]).toEqual({
				name: 'linked-file',
				isDirectory: false,
				isFile: true,
				path: '/remote/path/linked-file',
			});
		});

		it('should throw when remote directory read fails', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(readDirRemote).mockResolvedValue({ success: false, error: 'Permission denied' });

			const handler = registeredHandlers.get('fs:readDir');
			await expect(handler!({}, '/remote/private', 'remote-1')).rejects.toThrow(
				'Permission denied'
			);
		});

		it('should use fallback error when remote directory read fails without details', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(readDirRemote).mockResolvedValue({ success: false });

			const handler = registeredHandlers.get('fs:readDir');
			await expect(handler!({}, '/remote/private', 'remote-1')).rejects.toThrow(
				'Failed to read remote directory'
			);
		});

		it('should throw when SSH remote not found', async () => {
			vi.mocked(getSshRemoteById).mockReturnValue(undefined);

			const handler = registeredHandlers.get('fs:readDir');
			await expect(handler!({}, '/remote/path', 'invalid-remote')).rejects.toThrow(
				'SSH remote not found: invalid-remote'
			);
		});

		it('should resolve symlinks pointing to directories', async () => {
			const mockEntries = [
				{
					name: 'linked-folder',
					isDirectory: () => false,
					isFile: () => false,
					isSymbolicLink: () => true,
				},
			];
			vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			const handler = registeredHandlers.get('fs:readDir');
			const result = await handler!({}, '/test/path');

			expect(fs.stat).toHaveBeenCalledWith(expect.stringContaining('linked-folder'));
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('linked-folder');
			expect(result[0].isDirectory).toBe(true);
			expect(result[0].isFile).toBe(false);
		});

		it('should resolve symlinks pointing to regular files', async () => {
			const mockEntries = [
				{
					name: 'linked-doc.md',
					isDirectory: () => false,
					isFile: () => false,
					isSymbolicLink: () => true,
				},
			];
			vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => false,
				isFile: () => true,
			} as any);

			const handler = registeredHandlers.get('fs:readDir');
			const result = await handler!({}, '/test/path');

			expect(result[0].isDirectory).toBe(false);
			expect(result[0].isFile).toBe(true);
		});

		it('should surface broken symlinks as files so they remain visible', async () => {
			const mockEntries = [
				{
					name: 'broken-link',
					isDirectory: () => false,
					isFile: () => false,
					isSymbolicLink: () => true,
				},
			];
			vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
			vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

			const handler = registeredHandlers.get('fs:readDir');
			const result = await handler!({}, '/test/path');

			expect(result[0].isDirectory).toBe(false);
			expect(result[0].isFile).toBe(true);
		});

		it('should normalize local entry names to NFC Unicode form', async () => {
			const nfdName = 'caf\u00e9'.normalize('NFD');
			const nfcName = 'caf\u00e9'.normalize('NFC');
			// Verify precondition: the names are different byte sequences
			expect(nfdName).not.toBe(nfcName);

			const mockEntries = [
				{
					name: nfdName,
					isDirectory: () => false,
					isFile: () => true,
					isSymbolicLink: () => false,
				},
			];
			vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);

			const handler = registeredHandlers.get('fs:readDir');
			const result = await handler!({}, '/test/path');

			expect(result[0].name).toBe(nfcName);
			expect(result[0].name.normalize('NFC')).toBe(result[0].name);
		});

		it('should normalize remote entry names to NFC Unicode form', async () => {
			const nfdName = 'r\u00e9sum\u00e9.md'.normalize('NFD');
			const nfcName = 'r\u00e9sum\u00e9.md'.normalize('NFC');

			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(readDirRemote).mockResolvedValue({
				success: true,
				data: [{ name: nfdName, isDirectory: false, isSymlink: false }],
			});

			const handler = registeredHandlers.get('fs:readDir');
			const result = await handler!({}, '/remote/path', 'remote-1');

			expect(result[0].name).toBe(nfcName);
			expect(result[0].name.normalize('NFC')).toBe(result[0].name);
		});
	});

	describe('fs:readFile', () => {
		it('should read text files as UTF-8', async () => {
			vi.mocked(fs.readFile).mockResolvedValue('file content' as any);

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/test/file.txt');

			expect(fs.readFile).toHaveBeenCalledWith('/test/file.txt', 'utf-8');
			expect(result).toBe('file content');
		});

		it('should read extensionless local files as UTF-8 text', async () => {
			vi.mocked(fs.readFile).mockResolvedValue('script content' as any);

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/test/Makefile');

			expect(fs.readFile).toHaveBeenCalledWith('/test/Makefile', 'utf-8');
			expect(result).toBe('script content');
		});

		it('should treat local paths with empty extensions as UTF-8 text', async () => {
			vi.mocked(fs.readFile).mockResolvedValue('file content' as any);

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/test/file.');

			expect(fs.readFile).toHaveBeenCalledWith('/test/file.', 'utf-8');
			expect(result).toBe('file content');
		});

		it('should read image files as base64 data URL', async () => {
			const mockBuffer = Buffer.from('fake-image-data');
			vi.mocked(fs.readFile).mockResolvedValue(mockBuffer as any);

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/test/image.png');

			expect(fs.readFile).toHaveBeenCalledWith('/test/image.png');
			expect(result).toMatch(/^data:image\/png;base64,/);
		});

		it('should handle SVG files with correct mime type', async () => {
			const mockBuffer = Buffer.from('<svg></svg>');
			vi.mocked(fs.readFile).mockResolvedValue(mockBuffer as any);

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/test/icon.svg');

			expect(result).toMatch(/^data:image\/svg\+xml;base64,/);
		});

		it('should read remote text files via SSH', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(readFileRemote).mockResolvedValue({ success: true, data: 'remote notes' });

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/remote/README', 'remote-1');

			expect(readFileRemote).toHaveBeenCalledWith('/remote/README', mockSshConfig);
			expect(result).toBe('remote notes');
		});

		it('should encode remote image reads as data URLs', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(readFileRemote).mockResolvedValue({ success: true, data: 'remote-image-bytes' });

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/remote/image.png', 'remote-1');

			expect(result).toBe(
				`data:image/png;base64,${Buffer.from('remote-image-bytes', 'binary').toString('base64')}`
			);
		});

		it('should encode remote SVG reads with SVG mime type', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(readFileRemote).mockResolvedValue({ success: true, data: '<svg />' });

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/remote/icon.svg', 'remote-1');

			expect(result).toBe(
				`data:image/svg+xml;base64,${Buffer.from('<svg />', 'binary').toString('base64')}`
			);
		});

		it('should return remote text reads when the path has an empty extension', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(readFileRemote).mockResolvedValue({ success: true, data: 'remote notes' });

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/remote/README.', 'remote-1');

			expect(result).toBe('remote notes');
		});

		it('should throw for missing or failed remote file reads', async () => {
			const handler = registeredHandlers.get('fs:readFile');
			vi.mocked(getSshRemoteById).mockReturnValue(undefined);
			await expect(handler!({}, '/remote/file.txt', 'missing-remote')).rejects.toThrow(
				'Failed to read file: Error: SSH remote not found: missing-remote'
			);

			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(readFileRemote).mockResolvedValueOnce({
				success: false,
				error: 'Permission denied',
			});
			await expect(handler!({}, '/remote/private.txt', 'remote-1')).rejects.toThrow(
				'Failed to read file: Error: Permission denied'
			);

			vi.mocked(readFileRemote).mockResolvedValueOnce({ success: false });
			await expect(handler!({}, '/remote/private.txt', 'remote-1')).rejects.toThrow(
				'Failed to read file: Error: Failed to read remote file'
			);
		});

		it('should return null when path resolves to a directory (EISDIR)', async () => {
			// Caller may pass a path that turned out to be a folder. Returning
			// null instead of throwing keeps the IPC promise from rejecting and
			// surfacing as an unhandled rejection. Fixes MAESTRO-JP.
			vi.mocked(fs.readFile).mockRejectedValue(
				Object.assign(new Error('EISDIR'), { code: 'EISDIR' })
			);

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/test/some-folder');

			expect(result).toBeNull();
		});

		it('should return null for missing files and rethrow unexpected local read errors', async () => {
			const handler = registeredHandlers.get('fs:readFile');
			vi.mocked(fs.readFile).mockRejectedValueOnce(
				Object.assign(new Error('missing'), { code: 'ENOENT' })
			);
			await expect(handler!({}, '/missing/file.txt')).resolves.toBeNull();

			vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('Permission denied'));
			await expect(handler!({}, '/private/file.txt')).rejects.toThrow(
				'Failed to read file: Error: Permission denied'
			);
		});
	});

	describe('fs:stat', () => {
		it('should return file stats for local files', async () => {
			const mockStats = {
				size: 1024,
				birthtime: new Date('2024-01-01'),
				mtime: new Date('2024-06-01'),
				isDirectory: () => false,
				isFile: () => true,
			};
			vi.mocked(fs.stat).mockResolvedValue(mockStats as any);

			const handler = registeredHandlers.get('fs:stat');
			const result = await handler!({}, '/test/file.txt');

			expect(result).toEqual({
				size: 1024,
				createdAt: '2024-01-01T00:00:00.000Z',
				modifiedAt: '2024-06-01T00:00:00.000Z',
				isDirectory: false,
				isFile: true,
			});
		});

		it('should return stats for remote files via SSH', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(statRemote).mockResolvedValue({
				success: true,
				data: {
					size: 2048,
					mtime: '2024-06-15T12:00:00.000Z',
					isDirectory: false,
				},
			});

			const handler = registeredHandlers.get('fs:stat');
			const result = await handler!({}, '/remote/file.txt', 'remote-1');

			expect(statRemote).toHaveBeenCalledWith('/remote/file.txt', mockSshConfig);
			expect(result.size).toBe(2048);
			expect(result.isFile).toBe(true);
		});

		it('should throw when remote stat fails', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(statRemote).mockResolvedValue({ success: false, error: 'No such file' });

			const handler = registeredHandlers.get('fs:stat');
			await expect(handler!({}, '/remote/missing.txt', 'remote-1')).rejects.toThrow(
				'Failed to get file stats'
			);
		});

		it('should use fallback error when remote stat fails without details', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(statRemote).mockResolvedValue({ success: false });

			const handler = registeredHandlers.get('fs:stat');
			await expect(handler!({}, '/remote/missing.txt', 'remote-1')).rejects.toThrow(
				'Failed to get remote file stats'
			);
		});

		it('should throw when stat uses a missing SSH remote', async () => {
			vi.mocked(getSshRemoteById).mockReturnValue(undefined);

			const handler = registeredHandlers.get('fs:stat');
			await expect(handler!({}, '/remote/file.txt', 'missing-remote')).rejects.toThrow(
				'SSH remote not found: missing-remote'
			);
		});

		it('should throw when local stat fails', async () => {
			vi.mocked(fs.stat).mockRejectedValue(new Error('Permission denied'));

			const handler = registeredHandlers.get('fs:stat');
			await expect(handler!({}, '/private/file.txt')).rejects.toThrow('Failed to get file stats');
		});
	});

	describe('fs:writeFile', () => {
		it('should write content to file', async () => {
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('fs:writeFile');
			const result = await handler!({}, '/test/output.txt', 'new content');

			expect(fs.writeFile).toHaveBeenCalledWith('/test/output.txt', 'new content', 'utf-8');
			expect(result).toEqual({ success: true });
		});

		it('should throw on write failure', async () => {
			vi.mocked(fs.writeFile).mockRejectedValue(new Error('Permission denied'));

			const handler = registeredHandlers.get('fs:writeFile');
			await expect(handler!({}, '/readonly/file.txt', 'content')).rejects.toThrow(
				'Failed to write file'
			);
		});

		it('should write remote files via SSH', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(writeFileRemote).mockResolvedValue({ success: true });

			const handler = registeredHandlers.get('fs:writeFile');
			const result = await handler!({}, '/remote/output.txt', 'new content', 'remote-1');

			expect(writeFileRemote).toHaveBeenCalledWith(
				'/remote/output.txt',
				'new content',
				mockSshConfig
			);
			expect(result).toEqual({ success: true });
		});

		it('should throw when remote write fails', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(writeFileRemote).mockResolvedValue({ success: false, error: 'Disk full' });

			const handler = registeredHandlers.get('fs:writeFile');
			await expect(handler!({}, '/remote/output.txt', 'content', 'remote-1')).rejects.toThrow(
				'Failed to write file'
			);
		});

		it('should use fallback error when remote write fails without details', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(writeFileRemote).mockResolvedValue({ success: false });

			const handler = registeredHandlers.get('fs:writeFile');
			await expect(handler!({}, '/remote/output.txt', 'content', 'remote-1')).rejects.toThrow(
				'Failed to write remote file'
			);
		});

		it('should throw when writing via a missing SSH remote', async () => {
			vi.mocked(getSshRemoteById).mockReturnValue(undefined);

			const handler = registeredHandlers.get('fs:writeFile');
			await expect(handler!({}, '/remote/output.txt', 'content', 'missing-remote')).rejects.toThrow(
				'SSH remote not found: missing-remote'
			);
		});
	});

	describe('fs:rename', () => {
		it('should rename local files', async () => {
			vi.mocked(fs.rename).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('fs:rename');
			const result = await handler!({}, '/old/path.txt', '/new/path.txt');

			expect(fs.rename).toHaveBeenCalledWith('/old/path.txt', '/new/path.txt');
			expect(result).toEqual({ success: true });
		});

		it('should rename remote files via SSH', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(renameRemote).mockResolvedValue({ success: true });

			const handler = registeredHandlers.get('fs:rename');
			const result = await handler!({}, '/old/path.txt', '/new/path.txt', 'remote-1');

			expect(renameRemote).toHaveBeenCalledWith('/old/path.txt', '/new/path.txt', mockSshConfig);
			expect(result).toEqual({ success: true });
		});

		it('should throw when remote rename fails', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(renameRemote).mockResolvedValue({ success: false, error: 'Target exists' });

			const handler = registeredHandlers.get('fs:rename');
			await expect(handler!({}, '/old/path.txt', '/new/path.txt', 'remote-1')).rejects.toThrow(
				'Failed to rename'
			);
		});

		it('should use fallback error when remote rename fails without details', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(renameRemote).mockResolvedValue({ success: false });

			const handler = registeredHandlers.get('fs:rename');
			await expect(handler!({}, '/old/path.txt', '/new/path.txt', 'remote-1')).rejects.toThrow(
				'Failed to rename remote file'
			);
		});

		it('should throw when local rename fails', async () => {
			vi.mocked(fs.rename).mockRejectedValue(new Error('Permission denied'));

			const handler = registeredHandlers.get('fs:rename');
			await expect(handler!({}, '/old/path.txt', '/new/path.txt')).rejects.toThrow(
				'Failed to rename'
			);
		});

		it('should throw when rename uses a missing SSH remote', async () => {
			vi.mocked(getSshRemoteById).mockReturnValue(undefined);

			const handler = registeredHandlers.get('fs:rename');
			await expect(
				handler!({}, '/old/path.txt', '/new/path.txt', 'missing-remote')
			).rejects.toThrow('SSH remote not found: missing-remote');
		});
	});

	describe('fs:delete', () => {
		it('should delete files', async () => {
			vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);
			vi.mocked(fs.unlink).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('fs:delete');
			const result = await handler!({}, '/test/file.txt');

			expect(fs.unlink).toHaveBeenCalledWith('/test/file.txt');
			expect(result).toEqual({ success: true });
		});

		it('should delete directories recursively', async () => {
			vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
			vi.mocked(fs.rm).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('fs:delete');
			const result = await handler!({}, '/test/folder', { recursive: true });

			expect(fs.rm).toHaveBeenCalledWith('/test/folder', { recursive: true, force: true });
			expect(result).toEqual({ success: true });
		});

		it('should default local directory deletes to recursive mode', async () => {
			vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
			vi.mocked(fs.rm).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('fs:delete');
			const result = await handler!({}, '/test/folder');

			expect(fs.rm).toHaveBeenCalledWith('/test/folder', { recursive: true, force: true });
			expect(result).toEqual({ success: true });
		});

		it('should pass explicit recursive false to local directory delete', async () => {
			vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
			vi.mocked(fs.rm).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('fs:delete');
			const result = await handler!({}, '/test/folder', { recursive: false });

			expect(fs.rm).toHaveBeenCalledWith('/test/folder', { recursive: false, force: true });
			expect(result).toEqual({ success: true });
		});

		it('should delete remote files via SSH', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(deleteRemote).mockResolvedValue({ success: true });

			const handler = registeredHandlers.get('fs:delete');
			const result = await handler!({}, '/remote/file.txt', { sshRemoteId: 'remote-1' });

			expect(deleteRemote).toHaveBeenCalledWith('/remote/file.txt', mockSshConfig, true);
			expect(result).toEqual({ success: true });
		});

		it('should pass explicit recursive false to remote delete', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(deleteRemote).mockResolvedValue({ success: true });

			const handler = registeredHandlers.get('fs:delete');
			await handler!({}, '/remote/file.txt', { sshRemoteId: 'remote-1', recursive: false });

			expect(deleteRemote).toHaveBeenCalledWith('/remote/file.txt', mockSshConfig, false);
		});

		it('should throw when remote delete fails', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(deleteRemote).mockResolvedValue({ success: false, error: 'Permission denied' });

			const handler = registeredHandlers.get('fs:delete');
			await expect(handler!({}, '/remote/file.txt', { sshRemoteId: 'remote-1' })).rejects.toThrow(
				'Failed to delete'
			);
		});

		it('should use fallback error when remote delete fails without details', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(deleteRemote).mockResolvedValue({ success: false });

			const handler = registeredHandlers.get('fs:delete');
			await expect(handler!({}, '/remote/file.txt', { sshRemoteId: 'remote-1' })).rejects.toThrow(
				'Failed to delete remote file'
			);
		});

		it('should throw when local delete fails', async () => {
			vi.mocked(fs.stat).mockRejectedValue(new Error('No such file'));

			const handler = registeredHandlers.get('fs:delete');
			await expect(handler!({}, '/missing/file.txt')).rejects.toThrow('Failed to delete');
		});

		it('should throw when delete uses a missing SSH remote', async () => {
			vi.mocked(getSshRemoteById).mockReturnValue(undefined);

			const handler = registeredHandlers.get('fs:delete');
			await expect(
				handler!({}, '/remote/file.txt', { sshRemoteId: 'missing-remote' })
			).rejects.toThrow('SSH remote not found: missing-remote');
		});
	});

	describe('fs:countItems', () => {
		it('should count items in local directory', async () => {
			// Mock a simple directory structure
			vi.mocked(fs.readdir)
				.mockResolvedValueOnce([
					{
						name: 'file1.txt',
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
						name: 'file2.txt',
						isDirectory: () => false,
						isFile: () => true,
						isSymbolicLink: () => false,
					},
				] as any);

			const handler = registeredHandlers.get('fs:countItems');
			const result = await handler!({}, '/test/folder');

			expect(result).toEqual({ fileCount: 2, folderCount: 1 });
		});

		it('should count symlinked folders as folders and recurse into them', async () => {
			// Root: one file, one symlinked folder. Symlinked folder contains one file.
			vi.mocked(fs.readdir)
				.mockResolvedValueOnce([
					{
						name: 'file1.txt',
						isDirectory: () => false,
						isFile: () => true,
						isSymbolicLink: () => false,
					},
					{
						name: 'linked-folder',
						isDirectory: () => false,
						isFile: () => false,
						isSymbolicLink: () => true,
					},
				] as any)
				.mockResolvedValueOnce([
					{
						name: 'nested.txt',
						isDirectory: () => false,
						isFile: () => true,
						isSymbolicLink: () => false,
					},
				] as any);
			// fs.stat is only called for the symlink
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			const handler = registeredHandlers.get('fs:countItems');
			const result = await handler!({}, '/test/folder');

			expect(result).toEqual({ fileCount: 2, folderCount: 1 });
		});

		it('should count broken symlinks as files', async () => {
			vi.mocked(fs.readdir).mockResolvedValueOnce([
				{
					name: 'broken',
					isDirectory: () => false,
					isFile: () => false,
					isSymbolicLink: () => true,
				},
			] as any);
			vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

			const handler = registeredHandlers.get('fs:countItems');
			const result = await handler!({}, '/test/folder');

			expect(result).toEqual({ fileCount: 1, folderCount: 0 });
		});

		it('should count items in remote directory via SSH', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(countItemsRemote).mockResolvedValue({
				success: true,
				data: { fileCount: 10, folderCount: 3 },
			});

			const handler = registeredHandlers.get('fs:countItems');
			const result = await handler!({}, '/remote/folder', 'remote-1');

			expect(countItemsRemote).toHaveBeenCalledWith('/remote/folder', mockSshConfig);
			expect(result).toEqual({ fileCount: 10, folderCount: 3 });
		});

		it('should throw when remote count fails', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(countItemsRemote).mockResolvedValue({ success: false, error: 'Cannot count' });

			const handler = registeredHandlers.get('fs:countItems');
			await expect(handler!({}, '/remote/folder', 'remote-1')).rejects.toThrow(
				'Failed to count items'
			);
		});

		it('should use fallback error when remote count fails without details', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(countItemsRemote).mockResolvedValue({ success: false });

			const handler = registeredHandlers.get('fs:countItems');
			await expect(handler!({}, '/remote/folder', 'remote-1')).rejects.toThrow(
				'Failed to count remote items'
			);
		});

		it('should throw when local count traversal fails', async () => {
			vi.mocked(fs.readdir).mockRejectedValue(new Error('Permission denied'));

			const handler = registeredHandlers.get('fs:countItems');
			await expect(handler!({}, '/private/folder')).rejects.toThrow('Failed to count items');
		});

		it('should throw when count uses a missing SSH remote', async () => {
			vi.mocked(getSshRemoteById).mockReturnValue(undefined);

			const handler = registeredHandlers.get('fs:countItems');
			await expect(handler!({}, '/remote/folder', 'missing-remote')).rejects.toThrow(
				'SSH remote not found: missing-remote'
			);
		});
	});

	describe('fs:directorySize', () => {
		it('should calculate local directory size while skipping ignored folders and stat failures', async () => {
			vi.mocked(fs.readdir)
				.mockResolvedValueOnce([
					{ name: 'file1.txt', isDirectory: () => false, isFile: () => true },
					{ name: 'broken.txt', isDirectory: () => false, isFile: () => true },
					{ name: 'subfolder', isDirectory: () => true, isFile: () => false },
					{ name: 'node_modules', isDirectory: () => true, isFile: () => false },
					{ name: 'socket', isDirectory: () => false, isFile: () => false },
				] as any)
				.mockResolvedValueOnce([
					{ name: 'file2.txt', isDirectory: () => false, isFile: () => true },
					{ name: '__pycache__', isDirectory: () => true, isFile: () => false },
				] as any);
			vi.mocked(fs.stat)
				.mockResolvedValueOnce({ size: 100 } as any)
				.mockRejectedValueOnce(new Error('stat failed'))
				.mockResolvedValueOnce({ size: 250 } as any);

			const handler = registeredHandlers.get('fs:directorySize');
			const result = await handler!({}, '/test/folder');

			expect(result).toEqual({
				totalSize: 350,
				fileCount: 3,
				folderCount: 1,
			});
			expect(fs.readdir).toHaveBeenCalledTimes(2);
		});

		it('should stop local directory size traversal at depth ten', async () => {
			for (let depth = 0; depth < 10; depth++) {
				vi.mocked(fs.readdir).mockResolvedValueOnce([
					{ name: `level-${depth}`, isDirectory: () => true, isFile: () => false },
				] as any);
			}

			const handler = registeredHandlers.get('fs:directorySize');
			const result = await handler!({}, '/deep/folder');

			expect(result).toEqual({
				totalSize: 0,
				fileCount: 0,
				folderCount: 10,
			});
			expect(fs.readdir).toHaveBeenCalledTimes(10);
		});

		it('should return zero counts when local directory traversal cannot read the root', async () => {
			vi.mocked(fs.readdir).mockRejectedValue(new Error('Permission denied'));

			const handler = registeredHandlers.get('fs:directorySize');
			const result = await handler!({}, '/private/folder');

			expect(result).toEqual({
				totalSize: 0,
				fileCount: 0,
				folderCount: 0,
			});
		});

		it('should calculate directory size for remote via SSH', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(directorySizeRemote).mockResolvedValue({ success: true, data: 1024000 });
			vi.mocked(countItemsRemote).mockResolvedValue({
				success: true,
				data: { fileCount: 50, folderCount: 5 },
			});

			const handler = registeredHandlers.get('fs:directorySize');
			const result = await handler!({}, '/remote/folder', 'remote-1');

			expect(result).toEqual({
				totalSize: 1024000,
				fileCount: 50,
				folderCount: 5,
			});
		});

		it('should fall back to zero counts when remote count fails', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(directorySizeRemote).mockResolvedValue({ success: true, data: 4096 });
			vi.mocked(countItemsRemote).mockResolvedValue({ success: false, error: 'count failed' });

			const handler = registeredHandlers.get('fs:directorySize');
			const result = await handler!({}, '/remote/folder', 'remote-1');

			expect(result).toEqual({
				totalSize: 4096,
				fileCount: 0,
				folderCount: 0,
			});
		});

		it('should throw when remote directory size fails', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(directorySizeRemote).mockResolvedValue({ success: false, error: 'du failed' });
			vi.mocked(countItemsRemote).mockResolvedValue({
				success: true,
				data: { fileCount: 1, folderCount: 0 },
			});

			const handler = registeredHandlers.get('fs:directorySize');
			await expect(handler!({}, '/remote/folder', 'remote-1')).rejects.toThrow('du failed');
		});

		it('should use fallback error when remote directory size fails without details', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(directorySizeRemote).mockResolvedValue({ success: false });
			vi.mocked(countItemsRemote).mockResolvedValue({
				success: true,
				data: { fileCount: 1, folderCount: 0 },
			});

			const handler = registeredHandlers.get('fs:directorySize');
			await expect(handler!({}, '/remote/folder', 'remote-1')).rejects.toThrow(
				'Failed to get remote directory size'
			);
		});

		it('should throw when directory size uses a missing SSH remote', async () => {
			vi.mocked(getSshRemoteById).mockReturnValue(undefined);

			const handler = registeredHandlers.get('fs:directorySize');
			await expect(handler!({}, '/remote/folder', 'missing-remote')).rejects.toThrow(
				'SSH remote not found: missing-remote'
			);
		});
	});

	describe('fs:fetchImageAsBase64', () => {
		it('should fetch image and return base64 data URL', async () => {
			const mockArrayBuffer = new ArrayBuffer(8);
			const mockResponse = {
				ok: true,
				arrayBuffer: () => Promise.resolve(mockArrayBuffer),
				headers: {
					get: () => 'image/jpeg',
				},
			};
			global.fetch = vi.fn().mockResolvedValue(mockResponse);

			const handler = registeredHandlers.get('fs:fetchImageAsBase64');
			const result = await handler!({}, 'https://example.com/image.jpg');

			expect(global.fetch).toHaveBeenCalledWith('https://example.com/image.jpg');
			expect(result).toMatch(/^data:image\/jpeg;base64,/);
		});

		it('should return null on fetch failure', async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

			const handler = registeredHandlers.get('fs:fetchImageAsBase64');
			const result = await handler!({}, 'https://example.com/image.jpg');

			expect(result).toBeNull();
		});

		it('should return null on HTTP error', async () => {
			const mockResponse = { ok: false, status: 404 };
			global.fetch = vi.fn().mockResolvedValue(mockResponse);

			const handler = registeredHandlers.get('fs:fetchImageAsBase64');
			const result = await handler!({}, 'https://example.com/notfound.jpg');

			expect(result).toBeNull();
		});

		it('should return null for non-image content-type', async () => {
			const mockArrayBuffer = new ArrayBuffer(8);
			const mockResponse = {
				ok: true,
				arrayBuffer: () => Promise.resolve(mockArrayBuffer),
				headers: { get: () => 'text/html' },
			};
			global.fetch = vi.fn().mockResolvedValue(mockResponse);

			const handler = registeredHandlers.get('fs:fetchImageAsBase64');
			const result = await handler!({}, 'https://example.com/page.html');

			expect(result).toBeNull();
		});

		describe('SSRF protection', () => {
			it('should return null for malformed URLs', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'not a url');
				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block file:// protocol', async () => {
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');
				const result = await handler!({}, 'file:///etc/passwd');

				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block subdomains ending in .localhost', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'http://app.localhost/secret');
				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block metadata.google.internal', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'http://metadata.google.internal/computeMetadata/v1/');
				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block ftp:// protocol', async () => {
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');
				const result = await handler!({}, 'ftp://internal-server/data');

				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block localhost requests', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'http://localhost:8080/secret');
				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block 127.0.0.1 requests', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'http://127.0.0.1:9222/json');
				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block the full IPv4 loopback range', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'http://127.0.0.2:9222/json');
				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block AWS metadata endpoint', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'http://169.254.169.254/latest/meta-data/');
				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block generic link-local IPv4 addresses', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'http://169.254.1.1/internal');
				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block private RFC1918 ranges (10.x.x.x)', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'http://10.0.0.1/internal');
				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block private RFC1918 ranges (172.16.x.x)', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'http://172.16.0.1/internal');
				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block private RFC1918 ranges through 172.31.x.x', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'http://172.31.255.255/internal');
				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block private RFC1918 ranges (192.168.x.x)', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'http://192.168.1.1/internal');
				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block 0.0.0.0', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'http://0.0.0.0:3000/');
				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should block IPv6 loopback requests', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'http://[::1]/secret');
				expect(result).toBeNull();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			it('should return null when an image response omits content type', async () => {
				const mockResponse = {
					ok: true,
					arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
					headers: { get: () => null },
				};
				global.fetch = vi.fn().mockResolvedValue(mockResponse);

				const handler = registeredHandlers.get('fs:fetchImageAsBase64');
				const result = await handler!({}, 'https://cdn.example.com/image');

				expect(result).toBeNull();
			});

			it('should allow legitimate external HTTPS image URLs', async () => {
				const mockArrayBuffer = new ArrayBuffer(8);
				const mockResponse = {
					ok: true,
					arrayBuffer: () => Promise.resolve(mockArrayBuffer),
					headers: { get: () => 'image/png' },
				};
				global.fetch = vi.fn().mockResolvedValue(mockResponse);

				const handler = registeredHandlers.get('fs:fetchImageAsBase64');
				const result = await handler!({}, 'https://cdn.example.com/image.png');

				expect(global.fetch).toHaveBeenCalledWith('https://cdn.example.com/image.png');
				expect(result).toMatch(/^data:image\/png;base64,/);
			});

			it('should allow public IPv4 image URLs', async () => {
				const mockArrayBuffer = new ArrayBuffer(8);
				const mockResponse = {
					ok: true,
					arrayBuffer: () => Promise.resolve(mockArrayBuffer),
					headers: { get: () => 'image/png' },
				};
				global.fetch = vi.fn().mockResolvedValue(mockResponse);

				const handler = registeredHandlers.get('fs:fetchImageAsBase64');
				const result = await handler!({}, 'https://8.8.8.8/image.png');

				expect(global.fetch).toHaveBeenCalledWith('https://8.8.8.8/image.png');
				expect(result).toMatch(/^data:image\/png;base64,/);
			});
		});
	});
});
