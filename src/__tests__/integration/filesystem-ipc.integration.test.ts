import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerFilesystemHandlers } from '../../main/ipc/handlers/filesystem';
import { getSshRemoteById } from '../../main/stores';
import {
	countItemsRemote,
	deleteRemote,
	directorySizeRemote,
	readImageFileRemoteAsBase64,
	readDirRemote,
	readFileRemote,
	renameRemote,
	statRemote,
	writeFileRemote,
} from '../../main/utils/remote-fs';
import type { SshRemoteConfig } from '../../shared/types';

const state = vi.hoisted(() => ({
	handlers: new Map<string, Function>(),
	homeDir: '',
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: Function) => {
			state.handlers.set(channel, handler);
		}),
	},
}));

vi.mock('os', () => ({
	default: {
		homedir: vi.fn(() => state.homeDir),
	},
	homedir: vi.fn(() => state.homeDir),
}));

vi.mock('../../main/stores', () => ({
	getSshRemoteById: vi.fn(),
}));

vi.mock('../../main/utils/logger', () => ({
	logger: state.logger,
}));

vi.mock('../../main/utils/remote-fs', () => ({
	readDirRemote: vi.fn(),
	readFileRemote: vi.fn(),
	readImageFileRemoteAsBase64: vi.fn(),
	writeFileRemote: vi.fn(),
	statRemote: vi.fn(),
	directorySizeRemote: vi.fn(),
	renameRemote: vi.fn(),
	deleteRemote: vi.fn(),
	countItemsRemote: vi.fn(),
}));

async function invoke(channel: string, ...args: unknown[]) {
	const handler = state.handlers.get(channel);
	expect(handler).toBeDefined();
	return handler?.({}, ...args);
}

describe('filesystem IPC integration', () => {
	let tempRoot: string;
	let sshConfig: SshRemoteConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		state.handlers.clear();
		tempRoot = fsSync.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'maestro-fs-ipc-'));
		state.homeDir = path.join(tempRoot, 'home');
		fsSync.mkdirSync(state.homeDir, { recursive: true });
		sshConfig = {
			id: 'remote-1',
			name: 'Remote One',
			host: 'remote.example.com',
			port: 22,
			username: 'octavia',
			privateKeyPath: '',
			enabled: true,
		};
		vi.mocked(getSshRemoteById).mockReturnValue(sshConfig);
		registerFilesystemHandlers();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		fsSync.rmSync(tempRoot, { recursive: true, force: true });
	});

	it('routes local filesystem handlers through real temporary files', async () => {
		const workspace = path.join(tempRoot, 'workspace');
		const nested = path.join(workspace, 'nested');
		await fs.mkdir(path.join(workspace, 'node_modules'), { recursive: true });
		await fs.mkdir(nested, { recursive: true });
		await fs.writeFile(path.join(workspace, 'alpha.txt'), 'alpha text', 'utf-8');
		await fs.writeFile(path.join(workspace, 'README'), 'readme text', 'utf-8');
		await fs.writeFile(path.join(workspace, 'trailing.'), 'trailing dot', 'utf-8');
		await fs.writeFile(path.join(workspace, 'vector.svg'), '<svg />', 'utf-8');
		await fs.writeFile(path.join(workspace, 'pixel.png'), Buffer.from([1, 2, 3]));
		await fs.writeFile(path.join(nested, 'beta.txt'), 'beta', 'utf-8');
		await fs.writeFile(path.join(workspace, 'node_modules', 'ignored.txt'), 'ignored', 'utf-8');

		const home = await invoke('fs:homeDir');
		const entries = await invoke('fs:readDir', workspace);
		const text = await invoke('fs:readFile', path.join(workspace, 'alpha.txt'));
		const noExtensionText = await invoke('fs:readFile', path.join(workspace, 'README'));
		const trailingDotText = await invoke('fs:readFile', path.join(workspace, 'trailing.'));
		const localSvg = await invoke('fs:readFile', path.join(workspace, 'vector.svg'));
		const image = await invoke('fs:readFile', path.join(workspace, 'pixel.png'));
		const missing = await invoke('fs:readFile', path.join(workspace, 'missing.txt'));
		const directoryRead = await invoke('fs:readFile', nested);
		const stat = await invoke('fs:stat', path.join(workspace, 'alpha.txt'));
		const size = await invoke('fs:directorySize', workspace);
		const count = await invoke('fs:countItems', workspace);
		const writtenPath = path.join(workspace, 'written.txt');
		const renamedPath = path.join(workspace, 'renamed.txt');

		await expect(invoke('fs:writeFile', writtenPath, 'written')).resolves.toEqual({
			success: true,
		});
		await expect(invoke('fs:rename', writtenPath, renamedPath)).resolves.toEqual({ success: true });
		await expect(invoke('fs:delete', renamedPath)).resolves.toEqual({ success: true });
		await expect(invoke('fs:delete', nested, { recursive: true })).resolves.toEqual({
			success: true,
		});

		expect(home).toBe(state.homeDir);
		expect(entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'alpha.txt',
					isDirectory: false,
					isFile: true,
					path: path.join(workspace, 'alpha.txt'),
				}),
				expect.objectContaining({
					name: 'nested',
					isDirectory: true,
					isFile: false,
					path: nested,
				}),
			])
		);
		expect(text).toBe('alpha text');
		expect(noExtensionText).toBe('readme text');
		expect(trailingDotText).toBe('trailing dot');
		expect(localSvg).toBe(`data:image/svg+xml;base64,${Buffer.from('<svg />').toString('base64')}`);
		expect(image).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
		expect(missing).toBeNull();
		expect(directoryRead).toBeNull();
		expect(stat).toMatchObject({
			size: 10,
			isDirectory: false,
			isFile: true,
		});
		expect(size).toMatchObject({
			totalSize: 47,
			fileCount: 6,
			folderCount: 1,
		});
		expect(count).toMatchObject({
			fileCount: 7,
			folderCount: 2,
		});
		await expect(fs.stat(renamedPath)).rejects.toThrow();
		await expect(fs.stat(nested)).rejects.toThrow();
	});

	it('routes SSH filesystem handlers through remote-fs boundaries and remote lookup errors', async () => {
		vi.mocked(readDirRemote).mockResolvedValue({
			success: true,
			data: [
				{ name: 'remote.txt', isDirectory: false },
				{ name: 'folder', isDirectory: true },
			],
		});
		vi.mocked(readFileRemote)
			.mockResolvedValueOnce({ success: true, data: 'remote text' })
			.mockResolvedValueOnce({ success: true, data: 'no extension text' })
			.mockResolvedValueOnce({ success: true, data: 'trailing dot text' });
		vi.mocked(readImageFileRemoteAsBase64)
			.mockResolvedValueOnce({
				success: true,
				data: Buffer.from('<svg />', 'binary').toString('base64'),
			})
			.mockResolvedValueOnce({
				success: true,
				data: Buffer.from('jpg-bytes', 'binary').toString('base64'),
			});
		vi.mocked(statRemote).mockResolvedValue({
			success: true,
			data: {
				size: 42,
				mtime: new Date('2026-05-25T12:00:00.000Z').getTime(),
				isDirectory: false,
			},
		});
		vi.mocked(directorySizeRemote).mockResolvedValue({ success: true, data: 123 });
		vi.mocked(countItemsRemote)
			.mockResolvedValueOnce({ success: true, data: { fileCount: 4, folderCount: 2 } })
			.mockResolvedValueOnce({ success: true, data: { fileCount: 5, folderCount: 3 } });
		vi.mocked(writeFileRemote).mockResolvedValue({ success: true });
		vi.mocked(renameRemote).mockResolvedValue({ success: true });
		vi.mocked(deleteRemote).mockResolvedValue({ success: true });

		await expect(invoke('fs:readDir', '/remote/path/', 'remote-1')).resolves.toEqual([
			{
				name: 'remote.txt',
				isDirectory: false,
				isFile: true,
				path: '/remote/path/remote.txt',
			},
			{
				name: 'folder',
				isDirectory: true,
				isFile: false,
				path: '/remote/path/folder',
			},
		]);
		await expect(invoke('fs:readDir', '/remote/path', 'remote-1')).resolves.toEqual([
			{
				name: 'remote.txt',
				isDirectory: false,
				isFile: true,
				path: '/remote/path/remote.txt',
			},
			{
				name: 'folder',
				isDirectory: true,
				isFile: false,
				path: '/remote/path/folder',
			},
		]);
		await expect(invoke('fs:readFile', '/remote/path/remote.txt', 'remote-1')).resolves.toBe(
			'remote text'
		);
		await expect(invoke('fs:readFile', '/remote/path/icon.svg', 'remote-1')).resolves.toBe(
			`data:image/svg+xml;base64,${Buffer.from('<svg />', 'binary').toString('base64')}`
		);
		await expect(invoke('fs:readFile', '/remote/path/README', 'remote-1')).resolves.toBe(
			'no extension text'
		);
		await expect(invoke('fs:readFile', '/remote/path/trailing.', 'remote-1')).resolves.toBe(
			'trailing dot text'
		);
		await expect(invoke('fs:readFile', '/remote/path/photo.jpg', 'remote-1')).resolves.toBe(
			`data:image/jpg;base64,${Buffer.from('jpg-bytes', 'binary').toString('base64')}`
		);
		await expect(invoke('fs:stat', '/remote/path/remote.txt', 'remote-1')).resolves.toMatchObject({
			size: 42,
			createdAt: '2026-05-25T12:00:00.000Z',
			modifiedAt: '2026-05-25T12:00:00.000Z',
			isFile: true,
		});
		await expect(invoke('fs:directorySize', '/remote/path', 'remote-1')).resolves.toEqual({
			totalSize: 123,
			fileCount: 4,
			folderCount: 2,
		});
		await expect(
			invoke('fs:writeFile', '/remote/path/write.txt', 'remote', 'remote-1')
		).resolves.toEqual({
			success: true,
		});
		await expect(
			invoke('fs:rename', '/remote/path/write.txt', '/remote/path/renamed.txt', 'remote-1')
		).resolves.toEqual({
			success: true,
		});
		await expect(
			invoke('fs:delete', '/remote/path/renamed.txt', {
				recursive: false,
				sshRemoteId: 'remote-1',
			})
		).resolves.toEqual({ success: true });
		await expect(invoke('fs:countItems', '/remote/path', 'remote-1')).resolves.toEqual({
			fileCount: 5,
			folderCount: 3,
		});

		vi.mocked(getSshRemoteById).mockReturnValueOnce(undefined);
		await expect(invoke('fs:readDir', '/remote/path', 'missing-remote')).rejects.toThrow(
			'SSH remote not found: missing-remote'
		);
	});

	it('normalizes SSH filesystem operation failures', async () => {
		vi.mocked(readDirRemote).mockResolvedValueOnce({ success: false, error: 'remote dir denied' });
		await expect(invoke('fs:readDir', '/remote/path', 'remote-1')).rejects.toThrow(
			'remote dir denied'
		);

		vi.mocked(getSshRemoteById).mockReturnValueOnce(undefined);
		await expect(invoke('fs:readFile', '/remote/path/file.txt', 'missing-remote')).rejects.toThrow(
			'Failed to read file: Error: SSH remote not found: missing-remote'
		);

		vi.mocked(readFileRemote).mockResolvedValueOnce({
			success: false,
			error: 'remote read denied',
		});
		await expect(invoke('fs:readFile', '/remote/path/file.txt', 'remote-1')).rejects.toThrow(
			'Failed to read file: Error: remote read denied'
		);

		vi.mocked(getSshRemoteById).mockReturnValueOnce(undefined);
		await expect(invoke('fs:stat', '/remote/path/file.txt', 'missing-remote')).rejects.toThrow(
			'Failed to get file stats: Error: SSH remote not found: missing-remote'
		);

		vi.mocked(statRemote).mockResolvedValueOnce({ success: false, error: 'stat denied' });
		await expect(invoke('fs:stat', '/remote/path/file.txt', 'remote-1')).rejects.toThrow(
			'Failed to get file stats: Error: stat denied'
		);

		vi.mocked(getSshRemoteById).mockReturnValueOnce(undefined);
		await expect(invoke('fs:directorySize', '/remote/path', 'missing-remote')).rejects.toThrow(
			'SSH remote not found: missing-remote'
		);

		vi.mocked(directorySizeRemote).mockResolvedValueOnce({
			success: false,
			error: 'size denied',
		});
		vi.mocked(countItemsRemote).mockResolvedValueOnce({
			success: true,
			data: { fileCount: 1, folderCount: 1 },
		});
		await expect(invoke('fs:directorySize', '/remote/path', 'remote-1')).rejects.toThrow(
			'size denied'
		);

		vi.mocked(directorySizeRemote).mockResolvedValueOnce({ success: true, data: 99 });
		vi.mocked(countItemsRemote).mockResolvedValueOnce({ success: false, error: 'count denied' });
		await expect(invoke('fs:directorySize', '/remote/path', 'remote-1')).resolves.toEqual({
			totalSize: 99,
			fileCount: 0,
			folderCount: 0,
		});

		vi.mocked(getSshRemoteById).mockReturnValueOnce(undefined);
		await expect(
			invoke('fs:writeFile', '/remote/path/file.txt', 'content', 'missing-remote')
		).rejects.toThrow('Failed to write file: Error: SSH remote not found: missing-remote');

		vi.mocked(writeFileRemote).mockResolvedValueOnce({
			success: false,
			error: 'write denied',
		});
		await expect(
			invoke('fs:writeFile', '/remote/path/file.txt', 'content', 'remote-1')
		).rejects.toThrow('Failed to write file: Error: write denied');

		vi.mocked(getSshRemoteById).mockReturnValueOnce(undefined);
		await expect(
			invoke('fs:rename', '/remote/path/old.txt', '/remote/path/new.txt', 'missing-remote')
		).rejects.toThrow('Failed to rename: Error: SSH remote not found: missing-remote');

		vi.mocked(renameRemote).mockResolvedValueOnce({
			success: false,
			error: 'rename denied',
		});
		await expect(
			invoke('fs:rename', '/remote/path/old.txt', '/remote/path/new.txt', 'remote-1')
		).rejects.toThrow('Failed to rename: Error: rename denied');

		vi.mocked(getSshRemoteById).mockReturnValueOnce(undefined);
		await expect(
			invoke('fs:delete', '/remote/path/file.txt', { sshRemoteId: 'missing-remote' })
		).rejects.toThrow('Failed to delete: Error: SSH remote not found: missing-remote');

		vi.mocked(deleteRemote).mockResolvedValueOnce({
			success: false,
			error: 'delete denied',
		});
		await expect(
			invoke('fs:delete', '/remote/path/file.txt', { sshRemoteId: 'remote-1' })
		).rejects.toThrow('Failed to delete: Error: delete denied');

		vi.mocked(getSshRemoteById).mockReturnValueOnce(undefined);
		await expect(invoke('fs:countItems', '/remote/path', 'missing-remote')).rejects.toThrow(
			'Failed to count items: Error: SSH remote not found: missing-remote'
		);

		vi.mocked(countItemsRemote).mockResolvedValueOnce({
			success: false,
			error: 'remote count denied',
		});
		await expect(invoke('fs:countItems', '/remote/path', 'remote-1')).rejects.toThrow(
			'Failed to count items: Error: remote count denied'
		);
	});

	it('uses default remote failure messages when helpers omit errors', async () => {
		vi.mocked(readDirRemote).mockResolvedValueOnce({ success: false });
		await expect(invoke('fs:readDir', '/remote/path', 'remote-1')).rejects.toThrow(
			'Failed to read remote directory'
		);

		vi.mocked(readFileRemote).mockResolvedValueOnce({ success: false });
		await expect(invoke('fs:readFile', '/remote/path/file.txt', 'remote-1')).rejects.toThrow(
			'Failed to read file: Error: Failed to read remote file'
		);

		vi.mocked(statRemote).mockResolvedValueOnce({ success: false });
		await expect(invoke('fs:stat', '/remote/path/file.txt', 'remote-1')).rejects.toThrow(
			'Failed to get file stats: Error: Failed to get remote file stats'
		);

		vi.mocked(directorySizeRemote).mockResolvedValueOnce({ success: false });
		vi.mocked(countItemsRemote).mockResolvedValueOnce({ success: false });
		await expect(invoke('fs:directorySize', '/remote/path', 'remote-1')).rejects.toThrow(
			'Failed to get remote directory size'
		);

		vi.mocked(writeFileRemote).mockResolvedValueOnce({ success: false });
		await expect(
			invoke('fs:writeFile', '/remote/path/file.txt', 'content', 'remote-1')
		).rejects.toThrow('Failed to write file: Error: Failed to write remote file');

		vi.mocked(renameRemote).mockResolvedValueOnce({ success: false });
		await expect(
			invoke('fs:rename', '/remote/path/old.txt', '/remote/path/new.txt', 'remote-1')
		).rejects.toThrow('Failed to rename: Error: Failed to rename remote file');

		vi.mocked(deleteRemote).mockResolvedValueOnce({ success: false });
		await expect(
			invoke('fs:delete', '/remote/path/file.txt', { sshRemoteId: 'remote-1' })
		).rejects.toThrow('Failed to delete: Error: Failed to delete remote file');

		vi.mocked(countItemsRemote).mockResolvedValueOnce({ success: false });
		await expect(invoke('fs:countItems', '/remote/path', 'remote-1')).rejects.toThrow(
			'Failed to count items: Error: Failed to count remote items'
		);
	});

	it('covers local filesystem failure and recursion edge paths', async () => {
		const workspace = path.join(tempRoot, 'local-edge');
		await fs.mkdir(workspace, { recursive: true });
		await fs.writeFile(path.join(workspace, 'kept.txt'), 'kept', 'utf-8');
		await fs.symlink(path.join(workspace, 'kept.txt'), path.join(workspace, 'kept-link'));
		await fs.mkdir(path.join(workspace, '__pycache__'), { recursive: true });
		await fs.writeFile(path.join(workspace, '__pycache__', 'ignored.pyc'), 'ignored', 'utf-8');
		const defaultDeleteDir = path.join(workspace, 'delete-default-recursive');
		await fs.mkdir(defaultDeleteDir);

		let current = workspace;
		for (let depth = 0; depth < 11; depth += 1) {
			current = path.join(current, `level-${depth}`);
			await fs.mkdir(current);
		}
		await fs.writeFile(path.join(current, 'too-deep.txt'), 'too deep', 'utf-8');

		await expect(invoke('fs:directorySize', workspace)).resolves.toEqual({
			totalSize: 4,
			fileCount: 1,
			folderCount: 11,
		});
		await expect(invoke('fs:delete', defaultDeleteDir)).resolves.toEqual({ success: true });

		await expect(invoke('fs:stat', path.join(workspace, 'missing.txt'))).resolves.toBeNull();
		await expect(
			invoke('fs:writeFile', path.join(workspace, 'missing', 'file.txt'), 'x')
		).rejects.toThrow('Failed to write file:');
		await expect(
			invoke('fs:rename', path.join(workspace, 'missing.txt'), path.join(workspace, 'renamed.txt'))
		).rejects.toThrow('Failed to rename:');
		await expect(invoke('fs:delete', path.join(workspace, 'missing.txt'))).rejects.toThrow(
			'Failed to delete:'
		);
		await expect(invoke('fs:countItems', path.join(workspace, 'missing'))).rejects.toThrow(
			'Failed to count items:'
		);
	});

	it('fetches allowed image URLs and blocks invalid or private image requests', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			headers: {
				get: vi.fn(() => 'image/png'),
			},
			arrayBuffer: vi.fn(async () => Uint8Array.from([4, 5, 6]).buffer),
		});
		vi.stubGlobal('fetch', fetchMock);

		await expect(invoke('fs:fetchImageAsBase64', 'https://example.com/image.png')).resolves.toBe(
			`data:image/png;base64,${Buffer.from([4, 5, 6]).toString('base64')}`
		);
		await expect(invoke('fs:fetchImageAsBase64', 'file:///tmp/image.png')).resolves.toBeNull();
		await expect(invoke('fs:fetchImageAsBase64', 'http://127.0.0.1/image.png')).resolves.toBeNull();

		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: {
				get: vi.fn(() => 'text/plain'),
			},
			arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
		});
		await expect(
			invoke('fs:fetchImageAsBase64', 'https://example.com/not-image.txt')
		).resolves.toBeNull();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(state.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Requests to private/internal addresses are not allowed'),
			'fs:fetchImageAsBase64'
		);
	});

	it('rejects malformed, metadata, private-range, and failed image fetches', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(invoke('fs:fetchImageAsBase64', 'not a url')).resolves.toBeNull();
		await expect(
			invoke('fs:fetchImageAsBase64', 'https://metadata.google.internal/image.png')
		).resolves.toBeNull();

		for (const url of [
			'http://10.0.0.8/image.png',
			'http://172.20.0.8/image.png',
			'http://192.168.1.8/image.png',
			'http://169.254.1.8/image.png',
			'http://0.1.2.3/image.png',
		]) {
			await expect(invoke('fs:fetchImageAsBase64', url)).resolves.toBeNull();
		}

		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 500,
			headers: { get: vi.fn(() => 'image/png') },
			arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
		});
		await expect(
			invoke('fs:fetchImageAsBase64', 'https://example.com/fail.png')
		).resolves.toBeNull();

		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: { get: vi.fn(() => null) },
			arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
		});
		await expect(invoke('fs:fetchImageAsBase64', 'http://8.8.8.8/image.png')).resolves.toBeNull();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(state.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Invalid URL: not a url'),
			'fs:fetchImageAsBase64'
		);
		expect(state.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('HTTP 500'),
			'fs:fetchImageAsBase64'
		);
		expect(state.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Response is not an image:'),
			'fs:fetchImageAsBase64'
		);
	});
});
