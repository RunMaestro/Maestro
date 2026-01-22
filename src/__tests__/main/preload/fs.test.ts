/**
 * Tests for filesystem preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createFsApi } from '../../../main/preload/fs';

describe('Filesystem Preload API', () => {
	let api: ReturnType<typeof createFsApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createFsApi();
	});

	describe('homeDir', () => {
		it('should invoke fs:homeDir', async () => {
			mockInvoke.mockResolvedValue('/home/user');

			const result = await api.homeDir();

			expect(mockInvoke).toHaveBeenCalledWith('fs:homeDir');
			expect(result).toBe('/home/user');
		});
	});

	describe('readDir', () => {
		it('should invoke fs:readDir with dirPath', async () => {
			const mockEntries = [
				{ name: 'file.txt', isDirectory: false, path: '/home/user/file.txt' },
				{ name: 'subdir', isDirectory: true, path: '/home/user/subdir' },
			];
			mockInvoke.mockResolvedValue(mockEntries);

			const result = await api.readDir('/home/user');

			expect(mockInvoke).toHaveBeenCalledWith('fs:readDir', '/home/user', undefined);
			expect(result).toEqual(mockEntries);
		});

		it('should invoke fs:readDir with SSH remote', async () => {
			mockInvoke.mockResolvedValue([]);

			await api.readDir('/home/user', 'remote-1');

			expect(mockInvoke).toHaveBeenCalledWith('fs:readDir', '/home/user', 'remote-1');
		});
	});

	describe('readFile', () => {
		it('should invoke fs:readFile with filePath', async () => {
			mockInvoke.mockResolvedValue('file contents');

			const result = await api.readFile('/home/user/file.txt');

			expect(mockInvoke).toHaveBeenCalledWith('fs:readFile', '/home/user/file.txt', undefined);
			expect(result).toBe('file contents');
		});

		it('should invoke fs:readFile with SSH remote', async () => {
			mockInvoke.mockResolvedValue('remote file contents');

			await api.readFile('/home/user/file.txt', 'remote-1');

			expect(mockInvoke).toHaveBeenCalledWith('fs:readFile', '/home/user/file.txt', 'remote-1');
		});
	});

	describe('writeFile', () => {
		it('should invoke fs:writeFile with filePath and content', async () => {
			mockInvoke.mockResolvedValue({ success: true });

			const result = await api.writeFile('/home/user/file.txt', 'new contents');

			expect(mockInvoke).toHaveBeenCalledWith(
				'fs:writeFile',
				'/home/user/file.txt',
				'new contents'
			);
			expect(result.success).toBe(true);
		});
	});

	describe('stat', () => {
		it('should invoke fs:stat with filePath', async () => {
			const mockStat = {
				size: 1024,
				createdAt: '2024-01-01T00:00:00Z',
				modifiedAt: '2024-01-02T00:00:00Z',
				isDirectory: false,
				isFile: true,
			};
			mockInvoke.mockResolvedValue(mockStat);

			const result = await api.stat('/home/user/file.txt');

			expect(mockInvoke).toHaveBeenCalledWith('fs:stat', '/home/user/file.txt', undefined);
			expect(result).toEqual(mockStat);
		});
	});

	describe('directorySize', () => {
		it('should invoke fs:directorySize with dirPath', async () => {
			const mockSize = {
				totalSize: 10240,
				fileCount: 10,
				folderCount: 2,
			};
			mockInvoke.mockResolvedValue(mockSize);

			const result = await api.directorySize('/home/user/project');

			expect(mockInvoke).toHaveBeenCalledWith('fs:directorySize', '/home/user/project', undefined);
			expect(result).toEqual(mockSize);
		});
	});

	describe('fetchImageAsBase64', () => {
		it('should invoke fs:fetchImageAsBase64 with url', async () => {
			mockInvoke.mockResolvedValue('base64encodedimage');

			const result = await api.fetchImageAsBase64('https://example.com/image.png');

			expect(mockInvoke).toHaveBeenCalledWith(
				'fs:fetchImageAsBase64',
				'https://example.com/image.png'
			);
			expect(result).toBe('base64encodedimage');
		});

		it('should return null for failed fetch', async () => {
			mockInvoke.mockResolvedValue(null);

			const result = await api.fetchImageAsBase64('https://example.com/notfound.png');

			expect(result).toBeNull();
		});
	});

	describe('rename', () => {
		it('should invoke fs:rename with oldPath and newPath', async () => {
			mockInvoke.mockResolvedValue({ success: true });

			const result = await api.rename('/home/user/old.txt', '/home/user/new.txt');

			expect(mockInvoke).toHaveBeenCalledWith(
				'fs:rename',
				'/home/user/old.txt',
				'/home/user/new.txt',
				undefined
			);
			expect(result.success).toBe(true);
		});

		it('should invoke fs:rename with SSH remote', async () => {
			mockInvoke.mockResolvedValue({ success: true });

			await api.rename('/home/user/old.txt', '/home/user/new.txt', 'remote-1');

			expect(mockInvoke).toHaveBeenCalledWith(
				'fs:rename',
				'/home/user/old.txt',
				'/home/user/new.txt',
				'remote-1'
			);
		});
	});

	describe('delete', () => {
		it('should invoke fs:delete with targetPath', async () => {
			mockInvoke.mockResolvedValue({ success: true });

			const result = await api.delete('/home/user/file.txt');

			expect(mockInvoke).toHaveBeenCalledWith('fs:delete', '/home/user/file.txt', undefined);
			expect(result.success).toBe(true);
		});

		it('should invoke fs:delete with options', async () => {
			mockInvoke.mockResolvedValue({ success: true });

			await api.delete('/home/user/dir', { recursive: true, sshRemoteId: 'remote-1' });

			expect(mockInvoke).toHaveBeenCalledWith('fs:delete', '/home/user/dir', {
				recursive: true,
				sshRemoteId: 'remote-1',
			});
		});
	});

	describe('countItems', () => {
		it('should invoke fs:countItems with dirPath', async () => {
			mockInvoke.mockResolvedValue({ fileCount: 5, folderCount: 2 });

			const result = await api.countItems('/home/user/project');

			expect(mockInvoke).toHaveBeenCalledWith('fs:countItems', '/home/user/project', undefined);
			expect(result.fileCount).toBe(5);
			expect(result.folderCount).toBe(2);
		});
	});
});
