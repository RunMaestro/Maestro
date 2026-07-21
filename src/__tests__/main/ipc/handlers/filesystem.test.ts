import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';

// Track registered handlers
const registeredHandlers = new Map<string, Function>();
// Track fire-and-forget `ipcMain.on` listeners (e.g. fs:startDragOut)
const registeredListeners = new Map<string, Function>();

// Mock ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: Function) => {
			registeredHandlers.set(channel, handler);
		}),
		on: vi.fn((channel: string, handler: Function) => {
			registeredListeners.set(channel, handler);
		}),
	},
}));

// Mock the drag-out icon so the handler doesn't reach into Electron's nativeImage.
vi.mock('../../../../main/utils/drag-out-icon', () => ({
	getDragOutIcon: vi.fn(() => ({ __icon: true })),
}));

// Mock synchronous fs (existsSync) used by the drag-out handler's path filter.
vi.mock('fs', () => {
	const existsSync = vi.fn(() => true);
	return { existsSync, default: { existsSync } };
});

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
		mkdir: vi.fn(),
		rm: vi.fn(),
		unlink: vi.fn(),
		cp: vi.fn(),
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
	statRemote: vi.fn(),
	directorySizeRemote: vi.fn(),
	renameRemote: vi.fn(),
	mkdirRemote: vi.fn(),
	deleteRemote: vi.fn(),
	countItemsRemote: vi.fn(),
	writeFileRemote: vi.fn(),
	existsRemote: vi.fn(),
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
	statRemote,
	directorySizeRemote,
	countItemsRemote,
	renameRemote,
	mkdirRemote,
	deleteRemote,
	writeFileRemote,
	existsRemote,
} from '../../../../main/utils/remote-fs';
import { existsSync } from 'fs';

describe('filesystem handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();
		registeredListeners.clear();
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
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:writeImageFile', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:rename', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:copyPath', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:mkdir', expect.any(Function));
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

		it('should return null when a remote file is missing', async () => {
			// Remote not-found mirrors the local ENOENT path: return null instead of
			// throwing so the IPC promise does not reject and reach Sentry. (MAESTRO-MG/MF)
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(readFileRemote).mockResolvedValue({
				success: false,
				error: 'File not found: /remote/missing.md',
			});

			const handler = registeredHandlers.get('fs:readFile');
			await expect(handler!({}, '/remote/missing.md', 'remote-1')).resolves.toBeNull();
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
					mtime: Date.parse('2024-06-15T12:00:00.000Z'),
					isDirectory: false,
				},
			});

			const handler = registeredHandlers.get('fs:stat');
			const result = await handler!({}, '/remote/file.txt', 'remote-1');

			expect(statRemote).toHaveBeenCalledWith('/remote/file.txt', mockSshConfig);
			expect(result.size).toBe(2048);
			expect(result.isFile).toBe(true);
		});

		it('should return null for a missing path (ENOENT) instead of throwing', async () => {
			// Unresolved targets (e.g. the Document Graph following a [[wiki]] link
			// to a note that does not exist) must resolve cleanly to null, mirroring
			// the fs:readFile ENOENT contract.
			vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

			const handler = registeredHandlers.get('fs:stat');
			const result = await handler!({}, '/test/missing (Segment).md');

			expect(result).toBeNull();
		});

		it('should return null when a path component is not a directory (ENOTDIR)', async () => {
			vi.mocked(fs.stat).mockRejectedValue(
				Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' })
			);

			const handler = registeredHandlers.get('fs:stat');
			const result = await handler!({}, '/test/file.md/phantom-sub');

			expect(result).toBeNull();
		});

		it('should still throw for genuine stat errors (e.g. EACCES)', async () => {
			vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

			const handler = registeredHandlers.get('fs:stat');
			await expect(handler!({}, '/test/forbidden.txt')).rejects.toThrow('Failed to get file stats');
		});

		it('should return null when a local path is missing (ENOENT)', async () => {
			// Missing files return null instead of throwing so callers can handle
			// absence without an unhandled IPC rejection reaching Sentry. (MAESTRO-MH/ME)
			vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

			const handler = registeredHandlers.get('fs:stat');
			await expect(handler!({}, '/missing/file.txt')).resolves.toBeNull();
		});

		it('should return null when a remote path is missing', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(statRemote).mockResolvedValue({
				success: false,
				error: 'Path not found: /remote/missing.md',
			});

			const handler = registeredHandlers.get('fs:stat');
			await expect(handler!({}, '/remote/missing.md', 'remote-1')).resolves.toBeNull();
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
	});

	describe('fs:writeImageFile', () => {
		// A 1x1 transparent PNG as a data URL; the base64 payload after the comma
		// is what should be decoded and written as raw bytes.
		const PNG_BASE64 =
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
		const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

		it('decodes the data URL and writes raw bytes locally', async () => {
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('fs:writeImageFile');
			const result = await handler!({}, '/test/edited.png', PNG_DATA_URL);

			expect(fs.writeFile).toHaveBeenCalledTimes(1);
			const [path, buffer] = vi.mocked(fs.writeFile).mock.calls[0];
			expect(path).toBe('/test/edited.png');
			expect(Buffer.isBuffer(buffer)).toBe(true);
			// Buffer must be the decoded bytes, not the UTF-8 of the base64 string.
			expect((buffer as Buffer).equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);
			expect(result).toEqual({ success: true });
		});

		it('treats a bare base64 string (no data: prefix) as the payload', async () => {
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('fs:writeImageFile');
			await handler!({}, '/test/edited.png', PNG_BASE64);

			const [, buffer] = vi.mocked(fs.writeFile).mock.calls[0];
			expect((buffer as Buffer).equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);
		});

		it('writes remotely via SSH when a remote id is given', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(writeFileRemote).mockResolvedValue({ success: true });

			const handler = registeredHandlers.get('fs:writeImageFile');
			const result = await handler!({}, '/remote/edited.png', PNG_DATA_URL, 'remote-1');

			expect(fs.writeFile).not.toHaveBeenCalled();
			expect(writeFileRemote).toHaveBeenCalledTimes(1);
			const [path, buffer, config] = vi.mocked(writeFileRemote).mock.calls[0];
			expect(path).toBe('/remote/edited.png');
			expect((buffer as Buffer).equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);
			expect(config).toBe(mockSshConfig);
			expect(result).toEqual({ success: true });
		});

		it('throws when the SSH remote cannot be resolved', async () => {
			vi.mocked(getSshRemoteById).mockReturnValue(undefined);

			const handler = registeredHandlers.get('fs:writeImageFile');
			await expect(handler!({}, '/remote/edited.png', PNG_DATA_URL, 'missing')).rejects.toThrow(
				'Failed to write image file'
			);
		});

		it('throws when the remote write fails', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(writeFileRemote).mockResolvedValue({ success: false, error: 'disk full' });

			const handler = registeredHandlers.get('fs:writeImageFile');
			await expect(handler!({}, '/remote/edited.png', PNG_DATA_URL, 'remote-1')).rejects.toThrow(
				'Failed to write image file'
			);
		});

		it('throws on local write failure', async () => {
			vi.mocked(fs.writeFile).mockRejectedValue(new Error('Permission denied'));

			const handler = registeredHandlers.get('fs:writeImageFile');
			await expect(handler!({}, '/readonly/edited.png', PNG_DATA_URL)).rejects.toThrow(
				'Failed to write image file'
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
	});

	describe('fs:copyPath', () => {
		it('should copy a path recursively without overwriting by default', async () => {
			vi.mocked(fs.cp).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('fs:copyPath');
			const result = await handler!({}, '/external/photo.png', '/project/photo.png');

			expect(fs.cp).toHaveBeenCalledWith('/external/photo.png', '/project/photo.png', {
				recursive: true,
				force: false,
				errorOnExist: true,
			});
			expect(result).toEqual({ success: true });
		});

		it('should force overwrite when overwrite is true', async () => {
			vi.mocked(fs.cp).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('fs:copyPath');
			const result = await handler!({}, '/external/dir', '/project/dir', { overwrite: true });

			expect(fs.cp).toHaveBeenCalledWith('/external/dir', '/project/dir', {
				recursive: true,
				force: true,
				errorOnExist: false,
			});
			expect(result).toEqual({ success: true });
		});

		it('should throw when the copy fails (e.g. existing destination)', async () => {
			vi.mocked(fs.cp).mockRejectedValue(new Error('EEXIST'));

			const handler = registeredHandlers.get('fs:copyPath');

			await expect(handler!({}, '/external/x', '/project/x')).rejects.toThrow('Failed to copy');
		});

		it('should upload a local file to the remote host when sshRemoteId is set', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);
			vi.mocked(existsRemote).mockResolvedValue({ success: true, data: false });
			vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('hello') as any);
			vi.mocked(writeFileRemote).mockResolvedValue({ success: true });

			const handler = registeredHandlers.get('fs:copyPath');
			const result = await handler!({}, '/external/photo.png', '/remote/project/photo.png', {
				sshRemoteId: 'remote-1',
			});

			expect(fs.cp).not.toHaveBeenCalled();
			expect(writeFileRemote).toHaveBeenCalledWith(
				'/remote/project/photo.png',
				Buffer.from('hello'),
				mockSshConfig
			);
			expect(result).toEqual({ success: true });
		});

		it('should reject an SSH upload when the remote destination already exists (no overwrite)', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);
			vi.mocked(existsRemote).mockResolvedValue({ success: true, data: true });

			const handler = registeredHandlers.get('fs:copyPath');

			await expect(
				handler!({}, '/external/photo.png', '/remote/project/photo.png', {
					sshRemoteId: 'remote-1',
				})
			).rejects.toThrow('already exists');
			expect(writeFileRemote).not.toHaveBeenCalled();
		});

		it('should clear the remote destination first when overwriting on SSH', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);
			vi.mocked(deleteRemote).mockResolvedValue({ success: true });
			vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('data') as any);
			vi.mocked(writeFileRemote).mockResolvedValue({ success: true });

			const handler = registeredHandlers.get('fs:copyPath');
			const result = await handler!({}, '/external/x.ts', '/remote/project/x.ts', {
				overwrite: true,
				sshRemoteId: 'remote-1',
			});

			expect(deleteRemote).toHaveBeenCalledWith('/remote/project/x.ts', mockSshConfig, true);
			expect(existsRemote).not.toHaveBeenCalled();
			expect(writeFileRemote).toHaveBeenCalled();
			expect(result).toEqual({ success: true });
		});

		it('should throw when the SSH remote is not found', async () => {
			vi.mocked(getSshRemoteById).mockReturnValue(undefined);

			const handler = registeredHandlers.get('fs:copyPath');

			await expect(
				handler!({}, '/external/x', '/remote/x', { sshRemoteId: 'missing' })
			).rejects.toThrow('SSH remote not found');
		});
	});

	describe('fs:startDragOut', () => {
		it('registers a fire-and-forget listener', () => {
			expect(registeredListeners.get('fs:startDragOut')).toBeDefined();
		});

		it('starts a single-file drag with file + icon', () => {
			vi.mocked(existsSync).mockReturnValue(true);
			const startDrag = vi.fn();
			const listener = registeredListeners.get('fs:startDragOut');

			listener!({ sender: { startDrag } }, ['/tmp/report.pdf']);

			expect(startDrag).toHaveBeenCalledTimes(1);
			expect(startDrag).toHaveBeenCalledWith(
				expect.objectContaining({ file: '/tmp/report.pdf', icon: expect.anything() })
			);
		});

		it('starts a multi-file drag with a files array', () => {
			vi.mocked(existsSync).mockReturnValue(true);
			const startDrag = vi.fn();
			const listener = registeredListeners.get('fs:startDragOut');

			listener!({ sender: { startDrag } }, ['/tmp/a.txt', '/tmp/b.txt']);

			expect(startDrag).toHaveBeenCalledWith(
				expect.objectContaining({ files: ['/tmp/a.txt', '/tmp/b.txt'] })
			);
		});

		it('filters out paths that do not exist and skips startDrag when none remain', () => {
			vi.mocked(existsSync).mockReturnValue(false);
			const startDrag = vi.fn();
			const listener = registeredListeners.get('fs:startDragOut');

			listener!({ sender: { startDrag } }, ['/tmp/missing.txt']);

			expect(startDrag).not.toHaveBeenCalled();
		});

		it('ignores a non-array payload without throwing', () => {
			const startDrag = vi.fn();
			const listener = registeredListeners.get('fs:startDragOut');

			expect(() => listener!({ sender: { startDrag } }, undefined)).not.toThrow();
			expect(startDrag).not.toHaveBeenCalled();
		});
	});

	describe('fs:mkdir', () => {
		it('should create local directories recursively', async () => {
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('fs:mkdir');
			const result = await handler!({}, '/test/newdir');

			expect(fs.mkdir).toHaveBeenCalledWith('/test/newdir', { recursive: true });
			expect(result).toEqual({ success: true });
		});

		it('should create remote directories via SSH', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(mkdirRemote).mockResolvedValue({ success: true });

			const handler = registeredHandlers.get('fs:mkdir');
			const result = await handler!({}, '/remote/newdir', 'remote-1');

			expect(mkdirRemote).toHaveBeenCalledWith('/remote/newdir', mockSshConfig, true);
			expect(result).toEqual({ success: true });
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

		it('should delete remote files via SSH', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(deleteRemote).mockResolvedValue({ success: true });

			const handler = registeredHandlers.get('fs:delete');
			const result = await handler!({}, '/remote/file.txt', { sshRemoteId: 'remote-1' });

			expect(deleteRemote).toHaveBeenCalledWith('/remote/file.txt', mockSshConfig, true);
			expect(result).toEqual({ success: true });
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
	});

	describe('fs:directorySize', () => {
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

		it('should respect custom ignore patterns for local directories', async () => {
			const mockFs = (await import('fs/promises')).default;

			// Root has: src/ (dir), .git/ (dir), file.txt (file)
			vi.mocked(mockFs.readdir).mockImplementation(async (dirPath: any) => {
				const p = String(dirPath).replace(/\\/g, '/');
				if (p === '/project') {
					return [
						{ name: 'src', isDirectory: () => true, isFile: () => false },
						{ name: '.git', isDirectory: () => true, isFile: () => false },
						{ name: 'file.txt', isDirectory: () => false, isFile: () => true },
					] as any;
				}
				if (p.includes('/src')) {
					return [{ name: 'index.ts', isDirectory: () => false, isFile: () => true }] as any;
				}
				return [];
			});
			vi.mocked(mockFs.stat).mockResolvedValue({ size: 100 } as any);

			const handler = registeredHandlers.get('fs:directorySize');

			// Without ignore patterns - uses defaults (node_modules, __pycache__)
			// .git is NOT ignored by default
			const resultNoIgnore = await handler!({}, '/project');
			expect(resultNoIgnore.folderCount).toBe(2); // src + .git
			expect(resultNoIgnore.fileCount).toBe(2); // file.txt + index.ts

			// With .git in ignore patterns - .git is excluded
			vi.mocked(mockFs.readdir).mockImplementation(async (dirPath: any) => {
				const p = String(dirPath).replace(/\\/g, '/');
				if (p === '/project') {
					return [
						{ name: 'src', isDirectory: () => true, isFile: () => false },
						{ name: '.git', isDirectory: () => true, isFile: () => false },
						{ name: 'file.txt', isDirectory: () => false, isFile: () => true },
					] as any;
				}
				if (p.includes('/src')) {
					return [{ name: 'index.ts', isDirectory: () => false, isFile: () => true }] as any;
				}
				return [];
			});

			const resultWithIgnore = await handler!(
				{},
				'/project',
				undefined, // no SSH
				['.git', 'node_modules'], // custom ignore patterns
				false // no gitignore
			);
			expect(resultWithIgnore.folderCount).toBe(1); // only src
			expect(resultWithIgnore.fileCount).toBe(2); // file.txt + index.ts
		});

		it('should honor .gitignore when enabled', async () => {
			const mockFs = (await import('fs/promises')).default;

			// .gitignore contains "dist"
			vi.mocked(mockFs.readFile).mockImplementation(async (filePath: any) => {
				if (typeof filePath === 'string' && filePath.endsWith('.gitignore')) {
					return 'dist\n*.log\n';
				}
				throw new Error('ENOENT');
			});

			vi.mocked(mockFs.readdir).mockImplementation(async (dirPath: any) => {
				const p = String(dirPath).replace(/\\/g, '/');
				if (p === '/project') {
					return [
						{ name: 'src', isDirectory: () => true, isFile: () => false },
						{ name: 'dist', isDirectory: () => true, isFile: () => false },
						{ name: 'app.ts', isDirectory: () => false, isFile: () => true },
						{ name: 'debug.log', isDirectory: () => false, isFile: () => true },
					] as any;
				}
				if (p.includes('/src')) {
					return [{ name: 'index.ts', isDirectory: () => false, isFile: () => true }] as any;
				}
				return [];
			});
			vi.mocked(mockFs.stat).mockResolvedValue({ size: 50 } as any);

			const handler = registeredHandlers.get('fs:directorySize');
			const result = await handler!(
				{},
				'/project',
				undefined, // no SSH
				['node_modules'], // base patterns
				true // honor gitignore
			);

			// dist is ignored (from .gitignore), debug.log is ignored (from .gitignore *.log)
			expect(result.folderCount).toBe(1); // only src
			expect(result.fileCount).toBe(2); // app.ts + index.ts
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
			it('should block file:// protocol', async () => {
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');
				const result = await handler!({}, 'file:///etc/passwd');

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

			it('should block AWS metadata endpoint', async () => {
				global.fetch = vi.fn();
				const handler = registeredHandlers.get('fs:fetchImageAsBase64');

				const result = await handler!({}, 'http://169.254.169.254/latest/meta-data/');
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
		});
	});
});
