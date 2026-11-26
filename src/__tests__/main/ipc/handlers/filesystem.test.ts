import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import {
	isParquetPreviewMarker,
	parseParquetPreviewMarker,
} from '../../../../shared/parquet/preview';
import { isSqlitePreviewMarker, parseSqlitePreviewMarker } from '../../../../shared/sqlite/preview';

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

// The write-back watcher of a remote copy: each test fires its events by hand.
const chokidarWatchers: Array<{ path: string; handlers: Map<string, Function>; close: Function }> =
	[];
vi.mock('chokidar', () => ({
	watch: vi.fn((watchedPath: string) => {
		const watcher = {
			path: watchedPath,
			handlers: new Map<string, Function>(),
			close: vi.fn(),
			on(event: string, handler: Function) {
				watcher.handlers.set(event, handler);
				return watcher;
			},
		};
		chokidarWatchers.push(watcher);
		return watcher;
	}),
}));

// Mock the drag-out icon so the handler doesn't reach into Electron's nativeImage.
vi.mock('../../../../main/utils/file-tree-walk', () => ({
	walkLocalFileTree: vi.fn(),
}));

vi.mock('../../../../main/utils/drag-out-icon', () => ({
	getDragOutIcon: vi.fn(() => ({ __icon: true })),
}));

// Mock synchronous fs (existsSync) used by the drag-out handler's path filter.
vi.mock('fs', () => {
	const existsSync = vi.fn(() => true);
	// The compress handler streams an archive to disk; a stub stream that fires
	// 'close' on the next tick stands in for the real write.
	const createWriteStream = vi.fn(() => ({
		on: (event: string, cb: () => void) => {
			if (event === 'close') setTimeout(cb, 0);
		},
	}));
	return { existsSync, createWriteStream, default: { existsSync, createWriteStream } };
});

// Mock archiver - the compress handler only needs pipe/directory/finalize.
const archiveMock = {
	on: vi.fn(),
	pipe: vi.fn(),
	directory: vi.fn(),
	finalize: vi.fn().mockResolvedValue(undefined),
};
vi.mock('archiver', () => ({
	default: vi.fn(() => archiveMock),
}));

// Mock os module
vi.mock('os', () => ({
	default: {
		homedir: vi.fn().mockReturnValue('/Users/testuser'),
		tmpdir: vi.fn().mockReturnValue('/tmp'),
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
	deleteManyRemote: vi.fn(),
	countItemsRemote: vi.fn(),
	compressFolderRemote: vi.fn(),
	writeFileRemote: vi.fn(),
	replaceFileRemoteIfUnchanged: vi.fn(),
	sha256FileRemote: vi.fn(),
	existsRemote: vi.fn(),
	readBinaryFileRemoteAsBase64: vi.fn(),
	listTreeRemote: vi.fn(),
}));

// The header sniff reads real bytes off disk; each test decides the verdict.
vi.mock('../../../../main/sqlite/sqlite-detect', () => ({
	isSqliteDatabaseFile: vi.fn().mockResolvedValue(false),
}));

// Mock stores
vi.mock('../../../../main/stores', () => ({
	getSshRemoteById: vi.fn(),
}));

import {
	DIRECTORY_SIZE_MAX_FILES,
	registerFilesystemHandlers,
	REMOTE_FOLDER_DOWNLOAD_MAX_BYTES,
	REMOTE_FOLDER_DOWNLOAD_MAX_DEPTH,
	REMOTE_FOLDER_DOWNLOAD_MAX_FILE_BYTES,
	remoteFolderTooLarge,
} from '../../../../main/ipc/handlers/filesystem';
import {
	REMOTE_COPY_WRITE_BACK_MAX_BYTES,
	remoteCopyTooLargeMessage,
} from '../../../../main/utils/remote-copy-write-back';
import { walkLocalFileTree } from '../../../../main/utils/file-tree-walk';
import fs from 'fs/promises';
import { getSshRemoteById } from '../../../../main/stores';
import { listTreeRemote, readBinaryFileRemoteAsBase64 } from '../../../../main/utils/remote-fs';
import { isSqliteDatabaseFile } from '../../../../main/sqlite/sqlite-detect';
import {
	readDirRemote,
	readFileRemote,
	statRemote,
	directorySizeRemote,
	countItemsRemote,
	renameRemote,
	mkdirRemote,
	deleteRemote,
	deleteManyRemote,
	writeFileRemote,
	replaceFileRemoteIfUnchanged,
	sha256FileRemote,
	existsRemote,
	compressFolderRemote,
} from '../../../../main/utils/remote-fs';
import { existsSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { withPlatform } from '../../../helpers/pathExpect';

/**
 * A temp download path: `<tmp>/maestro-remote-downloads/<12 hex>/<name>`. Read
 * through `path`, so it holds whichever separator this OS joins with.
 */
function expectTempDownloadPath(actual: string, name: string): void {
	const folder = path.dirname(actual);
	expect(path.basename(actual)).toBe(name);
	expect(path.basename(folder)).toMatch(/^[0-9a-f]{12}$/);
	expect(path.dirname(folder)).toBe(path.join('/tmp', 'maestro-remote-downloads'));
}

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
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:readDirTree', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:readFile', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:stat', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:directorySize', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:writeFile', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:writeImageFile', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:rename', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:copyPath', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:mkdir', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:delete', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:deleteMany', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:countItems', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('fs:fetchImageAsBase64', expect.any(Function));
		});
	});

	describe('fs:downloadRemoteFile', () => {
		beforeEach(() => {
			vi.mocked(getSshRemoteById).mockReturnValue({ id: 'r1' } as any);
			vi.mocked(readBinaryFileRemoteAsBase64).mockResolvedValue({
				success: true,
				data: Buffer.from('bytes').toString('base64'),
			} as any);
		});

		it('gives two same-named remote files in different folders different local copies', async () => {
			const handler = registeredHandlers.get('fs:downloadRemoteFile')!;
			const a = await handler({}, '/work/a/notes.pdf', 'r1');
			const b = await handler({}, '/work/b/notes.pdf', 'r1');
			const again = await handler({}, '/work/a/notes.pdf', 'r1');

			expectTempDownloadPath(a.path, 'notes.pdf');
			expect(b.path).not.toBe(a.path);
			expect(again.path).toBe(a.path);
		});

		it('writes the bytes beside the copy and renames them over it in one step', async () => {
			const handler = registeredHandlers.get('fs:downloadRemoteFile')!;
			const first = await handler({}, '/work/a/notes.pdf', 'r1');
			const second = await handler({}, '/work/a/notes.pdf', 'r1');
			expect(second.path).toBe(first.path);

			// The published path is never the one being written.
			const written = vi.mocked(fs.writeFile).mock.calls.map(([target]) => target as string);
			expect(written).toHaveLength(2);
			expect(written).not.toContain(first.path);
			expect(written[1]).not.toBe(written[0]);
			for (const staged of written) {
				expect(path.dirname(staged)).toBe(path.dirname(first.path));
			}
			expect(fs.writeFile).toHaveBeenCalledWith(written[0], Buffer.from('bytes'));
			expect(vi.mocked(fs.rename).mock.calls).toEqual([
				[written[0], first.path],
				[written[1], first.path],
			]);
		});

		it('leaves the earlier copy alone when the new bytes cannot be written', async () => {
			vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('ENOSPC'));
			const handler = registeredHandlers.get('fs:downloadRemoteFile')!;
			await expect(handler({}, '/work/a/notes.pdf', 'r1')).rejects.toThrow('ENOSPC');

			const staged = vi.mocked(fs.writeFile).mock.calls[0][0] as string;
			expect(fs.rename).not.toHaveBeenCalled();
			expect(fs.rm).toHaveBeenCalledWith(staged, { force: true });
		});

		it('writes to the chosen path when one is given', async () => {
			const handler = registeredHandlers.get('fs:downloadRemoteFile')!;
			const result = await handler({}, '/work/a/notes.pdf', 'r1', '/Users/me/notes.pdf');
			expect(result).toEqual({ success: true, path: '/Users/me/notes.pdf' });
			expect(fs.rename).toHaveBeenCalledWith(expect.any(String), '/Users/me/notes.pdf');
		});
	});

	describe('fs:watchRemoteCopy', () => {
		const safeSend = vi.fn();
		const fetched = Buffer.from('fetched');
		const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

		beforeEach(() => {
			chokidarWatchers.length = 0;
			registerFilesystemHandlers({ safeSend });
			vi.mocked(getSshRemoteById).mockReturnValue({ id: 'r1' } as any);
			vi.mocked(readBinaryFileRemoteAsBase64).mockResolvedValue({
				success: true,
				data: fetched.toString('base64'),
			} as any);
			vi.mocked(replaceFileRemoteIfUnchanged).mockResolvedValue({ success: true });
			vi.mocked(sha256FileRemote).mockResolvedValue({ success: true, data: sha(fetched) });
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		/** The app saves the copy as `text`; the watcher fires and the debounce runs out. */
		async function saveCopyAs(text: string): Promise<void> {
			vi.mocked(fs.readFile).mockResolvedValue(Buffer.from(text) as any);
			chokidarWatchers[0].handlers.get('change')!();
			await vi.advanceTimersByTimeAsync(1000);
		}

		it('watches the copy the download made, never a path the caller names', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(fetched as any);
			const download = await registeredHandlers.get('fs:downloadRemoteFile')!(
				{},
				'/work/a/notes.md',
				'r1'
			);
			const watched = await registeredHandlers.get('fs:watchRemoteCopy')!(
				{},
				'/work/a/notes.md',
				'r1'
			);
			expect(watched).toEqual({ path: download.path, savesBack: true });
			expect(chokidarWatchers.map((w) => w.path)).toEqual([download.path]);
		});

		it('does not watch a copy too large to send back, and says why', async () => {
			vi.mocked(fs.readFile).mockResolvedValue(
				Buffer.alloc(REMOTE_COPY_WRITE_BACK_MAX_BYTES + 1) as any
			);
			const watched = await registeredHandlers.get('fs:watchRemoteCopy')!(
				{},
				'/work/a/big.bin',
				'r1'
			);
			expect(watched).toMatchObject({
				savesBack: false,
				reason: remoteCopyTooLargeMessage(),
			});
			expect(chokidarWatchers).toEqual([]);
		});

		it('refuses an unknown remote', async () => {
			vi.mocked(getSshRemoteById).mockReturnValue(undefined as any);
			await expect(
				registeredHandlers.get('fs:watchRemoteCopy')!({}, '/work/a/notes.md', 'gone')
			).rejects.toThrow('SSH remote not found: gone');
		});

		it('writes a saved change back over the fetched bytes only, and flashes that it did', async () => {
			vi.useFakeTimers();
			vi.mocked(fs.readFile).mockResolvedValue(fetched as any);
			await registeredHandlers.get('fs:watchRemoteCopy')!({}, '/work/a/notes.md', 'r1');
			await saveCopyAs('edited');
			expect(replaceFileRemoteIfUnchanged).toHaveBeenCalledWith(
				'/work/a/notes.md',
				Buffer.from('edited'),
				sha(fetched),
				{ id: 'r1' }
			);
			expect(writeFileRemote).not.toHaveBeenCalled();
			expect(safeSend).toHaveBeenCalledWith(
				'remote:notifyCenterFlash',
				expect.objectContaining({ message: 'Saved to the remote host', detail: 'notes.md' })
			);
		});

		it('keeps the user version, never over an earlier one, when the remote file changed', async () => {
			vi.useFakeTimers();
			vi.mocked(fs.readFile).mockResolvedValue(fetched as any);
			await registeredHandlers.get('fs:watchRemoteCopy')!({}, '/work/a/notes.md', 'r1');
			vi.mocked(sha256FileRemote).mockResolvedValue({
				success: true,
				data: sha(Buffer.from('someone else')),
			});
			vi.mocked(replaceFileRemoteIfUnchanged).mockResolvedValue({
				success: false,
				changed: true,
				error: 'The remote file changed',
			});
			await saveCopyAs('edited');
			const kept = vi.mocked(fs.writeFile).mock.calls.at(-1)!;
			expect(path.basename(kept[0] as string)).toMatch(/^notes \(your version \d{8}-\d{6}\)\.md$/);
			expect(kept[1]).toEqual(Buffer.from('edited'));
			expect(kept[2]).toEqual({ flag: 'wx' });
			expect(safeSend).toHaveBeenCalledWith(
				'remote:notifyToast',
				expect.objectContaining({
					title: 'Not saved to the remote host',
					color: 'red',
					message: expect.stringContaining('Later changes to this copy are not saved back'),
				})
			);
			// A later save is not sent, and no second toast says so again.
			safeSend.mockClear();
			await saveCopyAs('edited again');
			expect(replaceFileRemoteIfUnchanged).toHaveBeenCalledTimes(1);
			expect(safeSend).not.toHaveBeenCalled();
		});

		it('sees a save by polling when no file event arrives, and says once when the watcher fails', async () => {
			vi.useFakeTimers();
			vi.mocked(fs.readFile).mockResolvedValue(fetched as any);
			vi.mocked(fs.stat).mockResolvedValue({ size: 7, mtimeMs: 1 } as any);
			await registeredHandlers.get('fs:watchRemoteCopy')!({}, '/work/a/notes.md', 'r1');
			// The app saves; the OS never reports it.
			vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('edited!') as any);
			vi.mocked(fs.stat).mockResolvedValue({ size: 7, mtimeMs: 2 } as any);
			await vi.advanceTimersByTimeAsync(5000);
			expect(replaceFileRemoteIfUnchanged).toHaveBeenCalledWith(
				'/work/a/notes.md',
				Buffer.from('edited!'),
				sha(fetched),
				{ id: 'r1' }
			);

			chokidarWatchers[0].handlers.get('error')!(new Error('EMFILE'));
			chokidarWatchers[0].handlers.get('error')!(new Error('EMFILE'));
			await vi.advanceTimersByTimeAsync(0);
			const notices = safeSend.mock.calls.filter(
				([channel, toast]) =>
					channel === 'remote:notifyToast' && toast.title === 'No longer saving to the remote host'
			);
			expect(notices).toHaveLength(1);
		});

		it('a second Open keeps a copy whose saved change has not reached the remote', async () => {
			vi.useFakeTimers();
			vi.mocked(fs.readFile).mockResolvedValue(fetched as any);
			const download = registeredHandlers.get('fs:downloadRemoteFile')!;
			await download({}, '/work/a/notes.md', 'r1');
			await registeredHandlers.get('fs:watchRemoteCopy')!({}, '/work/a/notes.md', 'r1');
			vi.mocked(replaceFileRemoteIfUnchanged).mockResolvedValue({
				success: false,
				error: 'Connection refused',
			});
			await saveCopyAs('edited');
			vi.mocked(fs.rename).mockClear();
			vi.mocked(readBinaryFileRemoteAsBase64).mockClear();

			await download({}, '/work/a/notes.md', 'r1');
			// The change was sent again first; it still failed, so the copy was not
			// replaced and nothing was fetched over it.
			expect(replaceFileRemoteIfUnchanged).toHaveBeenCalledTimes(2);
			expect(readBinaryFileRemoteAsBase64).not.toHaveBeenCalled();
			expect(fs.rename).not.toHaveBeenCalled();
			expect(replaceFileRemoteIfUnchanged).toHaveBeenLastCalledWith(
				'/work/a/notes.md',
				Buffer.from('edited'),
				sha(fetched),
				{ id: 'r1' }
			);
		});
	});

	describe('fs:downloadRemoteFolder', () => {
		beforeEach(() => {
			vi.mocked(getSshRemoteById).mockReturnValue({ id: 'r1' } as any);
			vi.mocked(readBinaryFileRemoteAsBase64).mockImplementation(async (remotePath) => ({
				success: true,
				data: Buffer.from(`bytes of ${remotePath}`).toString('base64'),
			}));
		});

		afterEach(() => {
			vi.mocked(fs.rename).mockReset();
		});

		/** The folder the tree was built in before it took the copy's place. */
		const stagingOf = (dest: string): string => {
			const swap = vi.mocked(fs.rename).mock.calls.find(([, to]) => to === dest);
			expect(swap, `no folder was renamed to ${dest}`).toBeDefined();
			return swap![0] as string;
		};

		it('copies the whole tree into a fresh temp folder named like the remote folder', async () => {
			vi.mocked(listTreeRemote).mockResolvedValue({
				success: true,
				data: { directories: ['lib'], files: ['a.ts', 'lib/b.ts'], truncated: false },
			});
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
			const result = await handler({}, '/work/src/', 'r1');

			expectTempDownloadPath(result.path, 'src');
			expect(result.fileCount).toBe(2);
			expect(listTreeRemote).toHaveBeenCalledWith(
				'/work/src/',
				expect.objectContaining({ maxFiles: 2000 }),
				{ id: 'r1' }
			);
			// The tree is built beside the copy, never inside it.
			const staging = stagingOf(result.path);
			expect(path.dirname(staging)).toBe(path.dirname(result.path));
			expect(staging).not.toBe(result.path);
			expect(fs.writeFile).toHaveBeenCalledWith(
				path.join(staging, 'lib', 'b.ts'),
				Buffer.from('bytes of /work/src/lib/b.ts')
			);
			expect(fs.writeFile).toHaveBeenCalledWith(
				path.join(staging, 'a.ts'),
				Buffer.from('bytes of /work/src/a.ts')
			);
			// A stale copy is replaced, never merged into: once the whole new tree is
			// written it moves aside whole, the new tree takes its name, and only
			// then is the earlier copy deleted. No reader meets a half-deleted folder.
			const order = (mock: unknown): number[] =>
				(mock as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder;
			const renames = vi.mocked(fs.rename).mock.calls;
			const asideAt = renames.findIndex(([from]) => from === result.path);
			const inAt = renames.findIndex(([from, to]) => from === staging && to === result.path);
			expect(asideAt).toBeGreaterThanOrEqual(0);
			expect(inAt).toBeGreaterThan(asideAt);
			const retired = renames[asideAt][1] as string;
			expect(path.dirname(retired)).toBe(path.dirname(result.path));
			expect(Math.max(...order(fs.writeFile))).toBeLessThan(order(fs.rename)[asideAt]);
			expect(fs.rm).not.toHaveBeenCalledWith(result.path, expect.anything());
			const removal = vi.mocked(fs.rm).mock.calls.findIndex(([target]) => target === retired);
			expect(removal).toBeGreaterThanOrEqual(0);
			expect(order(fs.rm)[removal]).toBeGreaterThan(order(fs.rename)[inAt]);
		});

		it('puts the earlier copy back when the new one cannot take its place', async () => {
			vi.mocked(listTreeRemote).mockResolvedValue({
				success: true,
				data: { directories: [], files: ['a.ts'], truncated: false },
			});
			vi.mocked(fs.rename).mockImplementation(async (from) => {
				if (
					String(from).includes('.maestro-part-') &&
					vi.mocked(fs.rename).mock.calls.length === 2
				) {
					throw Object.assign(new Error('EPERM: in use'), { code: 'EPERM' });
				}
			});
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
			await expect(handler({}, '/work/src', 'r1')).rejects.toThrow('EPERM: in use');
			const [aside, failedIn, restore] = vi.mocked(fs.rename).mock.calls;
			expect(failedIn[1]).toBe(aside[0]);
			// The earlier copy is back under its own name, and it was never deleted.
			expect(restore).toEqual([aside[1], aside[0]]);
			expect(fs.rm).not.toHaveBeenCalledWith(aside[0], expect.anything());
			expect(fs.rm).not.toHaveBeenCalledWith(aside[1], expect.anything());
		});

		it('swaps in a first copy when there is no earlier one', async () => {
			vi.mocked(listTreeRemote).mockResolvedValue({
				success: true,
				data: { directories: [], files: ['a.ts'], truncated: false },
			});
			vi.mocked(fs.rename).mockImplementationOnce(async () => {
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			});
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
			const result = await handler({}, '/work/src', 'r1');
			const renames = vi.mocked(fs.rename).mock.calls;
			expect(renames).toHaveLength(2);
			expect(renames[1][1]).toBe(result.path);
		});

		it('lists strictly: a subfolder it cannot read fails the copy, naming it, before any byte is fetched', async () => {
			const why =
				'Cannot read "private" in /work/src (Permission denied), so the folder cannot be copied whole';
			vi.mocked(listTreeRemote).mockResolvedValue({ success: false, error: why });
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
			await expect(handler({}, '/work/src', 'r1')).rejects.toThrow(why);
			expect(listTreeRemote).toHaveBeenCalledWith(
				'/work/src',
				expect.objectContaining({ strict: true }),
				{ id: 'r1' }
			);
			expect(readBinaryFileRemoteAsBase64).not.toHaveBeenCalled();
			expect(fs.rename).not.toHaveBeenCalled();
			expect(fs.rm).not.toHaveBeenCalled();
		});

		it('leaves the earlier copy alone when a file cannot be fetched', async () => {
			vi.mocked(listTreeRemote).mockResolvedValue({
				success: true,
				data: { directories: [], files: ['a.ts', 'b.ts', 'c.ts'], truncated: false },
			});
			vi.mocked(readBinaryFileRemoteAsBase64).mockImplementation(async (remotePath) =>
				remotePath.endsWith('/a.ts')
					? { success: false, error: 'Permission denied: a.ts' }
					: { success: true, data: Buffer.from('ok').toString('base64') }
			);
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
			await expect(handler({}, '/work/src', 'r1')).rejects.toThrow('Permission denied: a.ts');

			// Nothing was swapped in and the earlier copy was not removed. Only the
			// half-built folder beside it went.
			expect(fs.rename).not.toHaveBeenCalled();
			const removed = vi.mocked(fs.rm).mock.calls.map(([target]) => target as string);
			expect(removed).toHaveLength(1);
			expect(path.basename(path.dirname(removed[0]))).toMatch(/^[0-9a-f]{12}$/);
			expect(path.basename(removed[0])).not.toBe('src');
			expect(vi.mocked(fs.mkdir).mock.calls[0][0]).toBe(removed[0]);
		});

		it('builds one copy of a folder at a time when two downloads overlap', async () => {
			const listing = {
				success: true as const,
				data: { directories: [], files: ['a.ts'], truncated: false },
			};
			let releaseFirst!: () => void;
			vi.mocked(listTreeRemote)
				.mockImplementationOnce(
					() => new Promise((resolve) => (releaseFirst = () => resolve(listing)))
				)
				.mockResolvedValue(listing);
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
			const first = handler({}, '/work/src', 'r1');
			const second = handler({}, '/work/src', 'r1');
			await new Promise((resolve) => setTimeout(resolve, 0));

			// The second has not started: the first still owns the folder.
			expect(listTreeRemote).toHaveBeenCalledTimes(1);
			expect(fs.rename).not.toHaveBeenCalled();

			releaseFirst();
			const [a, b] = await Promise.all([first, second]);
			expect(b.path).toBe(a.path);
			expect(listTreeRemote).toHaveBeenCalledTimes(2);
			// Each download swaps in its own finished tree; the copy moved aside is not one.
			const swaps = vi
				.mocked(fs.rename)
				.mock.calls.filter(([from, to]) => to === a.path && from !== a.path);
			expect(swaps).toHaveLength(2);
			expect(swaps[0][0]).not.toBe(swaps[1][0]);
		});

		it('lists with sizes and refuses a folder over the byte budget before any byte is fetched', async () => {
			vi.mocked(listTreeRemote).mockResolvedValue({
				success: true,
				data: {
					directories: [],
					files: ['a.bin', 'b.bin'],
					truncated: false,
					fileSizes: [REMOTE_FOLDER_DOWNLOAD_MAX_BYTES, 1],
				},
			});
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
			const refusal = handler({}, '/work/src', 'r1');
			await expect(refusal).rejects.toThrow(/too large to copy to this computer \(500\.0 MB/);
			expect(listTreeRemote).toHaveBeenCalledWith(
				'/work/src',
				expect.objectContaining({ withSizes: true, strict: true }),
				{ id: 'r1' }
			);
			expect(readBinaryFileRemoteAsBase64).not.toHaveBeenCalled();
			expect(fs.writeFile).not.toHaveBeenCalled();
			expect(fs.rename).not.toHaveBeenCalled();
		});

		it('refuses a folder holding one file over the per-file cap, naming it, before any read', async () => {
			vi.mocked(listTreeRemote).mockResolvedValue({
				success: true,
				data: {
					directories: ['media'],
					files: ['notes.md', 'media/big.iso'],
					truncated: false,
					fileSizes: [10, REMOTE_FOLDER_DOWNLOAD_MAX_FILE_BYTES + 1],
				},
			});
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
			await expect(handler({}, '/work/src', 'r1')).rejects.toThrow(
				/too large to copy to this computer \(50\.0 MB\): media\/big\.iso alone is 50\.0 MB, over the 50\.0 MB limit for one file/
			);
			expect(readBinaryFileRemoteAsBase64).not.toHaveBeenCalled();
		});

		it('checks a file whose size the listing could not report once its bytes are here', async () => {
			vi.mocked(listTreeRemote).mockResolvedValue({
				success: true,
				data: {
					directories: [],
					files: ['small.md', 'unknown.bin'],
					truncated: false,
					fileSizes: [5, null],
				},
			});
			vi.mocked(readBinaryFileRemoteAsBase64).mockImplementation(async (remotePath) => ({
				success: true,
				data: remotePath.endsWith('unknown.bin')
					? Buffer.alloc(REMOTE_FOLDER_DOWNLOAD_MAX_FILE_BYTES + 1).toString('base64')
					: Buffer.from('small').toString('base64'),
			}));
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
			await expect(handler({}, '/work/src', 'r1')).rejects.toThrow(
				/too large to copy to this computer \(at least .*unknown\.bin alone is/
			);
			expect(fs.rename).not.toHaveBeenCalled();
		});

		it('checks a file that grew since the listing at its real size, before writing it', async () => {
			vi.mocked(listTreeRemote).mockResolvedValue({
				success: true,
				data: { directories: [], files: ['app.log'], truncated: false, fileSizes: [10] },
			});
			vi.mocked(readBinaryFileRemoteAsBase64).mockResolvedValue({
				success: true,
				data: Buffer.alloc(REMOTE_FOLDER_DOWNLOAD_MAX_FILE_BYTES + 1).toString('base64'),
			});
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
			await expect(handler({}, '/work/src', 'r1')).rejects.toThrow(
				/too large to copy to this computer \(50\.0 MB\): app\.log alone is 50\.0 MB/
			);
			expect(fs.writeFile).not.toHaveBeenCalled();
			expect(fs.rename).not.toHaveBeenCalled();
		});

		it('copies a folder within the budget', async () => {
			vi.mocked(listTreeRemote).mockResolvedValue({
				success: true,
				data: { directories: [], files: ['a.md'], truncated: false, fileSizes: [16] },
			});
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
			await expect(handler({}, '/work/src', 'r1')).resolves.toMatchObject({ fileCount: 1 });
		});

		it('refuses a folder too large to copy whole', async () => {
			vi.mocked(listTreeRemote).mockResolvedValue({
				success: true,
				data: { directories: [], files: ['a.ts'], truncated: true },
			});
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
			await expect(handler({}, '/work/src', 'r1')).rejects.toThrow(/more than 2000 files/);
			expect(fs.writeFile).not.toHaveBeenCalled();
		});

		it('refuses a folder nested as deep as the listing reaches, and copies one just short of it', async () => {
			const nested = (depth: number): string => Array.from({ length: depth }, () => 'd').join('/');
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;

			// The listing stops at the limit without saying so, so a folder that
			// deep may hold files it never listed.
			vi.mocked(listTreeRemote).mockResolvedValue({
				success: true,
				data: {
					directories: [nested(REMOTE_FOLDER_DOWNLOAD_MAX_DEPTH)],
					files: ['a.ts'],
					truncated: false,
				},
			});
			await expect(handler({}, '/work/src', 'r1')).rejects.toThrow(/too deep to copy/);
			expect(fs.rm).not.toHaveBeenCalled();
			expect(fs.mkdir).not.toHaveBeenCalled();
			expect(fs.writeFile).not.toHaveBeenCalled();

			vi.mocked(listTreeRemote).mockResolvedValue({
				success: true,
				data: {
					directories: [nested(REMOTE_FOLDER_DOWNLOAD_MAX_DEPTH - 1)],
					files: ['a.ts'],
					truncated: false,
				},
			});
			await expect(handler({}, '/work/src', 'r1')).resolves.toMatchObject({ fileCount: 1 });
		});

		it('refuses a listed path that would land outside the folder', async () => {
			vi.mocked(listTreeRemote).mockResolvedValue({
				success: true,
				data: { directories: [], files: ['../../etc/evil'], truncated: false },
			});
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
			await expect(handler({}, '/work/src', 'r1')).rejects.toThrow(/outside the folder/);
			expect(fs.rm).not.toHaveBeenCalled();
			expect(fs.writeFile).not.toHaveBeenCalled();
		});

		// A backslash is a separator on Windows only, so the native join below
		// cannot keep it in a name there.
		it.skipIf(process.platform === 'win32')(
			'reads a file whose name holds a backslash by its own name, apart from its look-alike',
			async () => {
				vi.mocked(listTreeRemote).mockResolvedValue({
					success: true,
					data: {
						directories: ['report'],
						files: ['report\\2026.txt', 'report/2026.txt'],
						truncated: false,
					},
				});
				const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
				const result = await handler({}, '/work/src', 'r1');
				const staging = stagingOf(result.path);

				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join(staging, 'report\\2026.txt'),
					Buffer.from('bytes of /work/src/report\\2026.txt')
				);
				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join(staging, 'report', '2026.txt'),
					Buffer.from('bytes of /work/src/report/2026.txt')
				);
			}
		);

		it('refuses a listed name Windows would read as another path, and never rewrites it', async () => {
			const handler = registeredHandlers.get('fs:downloadRemoteFolder')!;
			for (const hostile of ['report\\2026.txt', '..\\..\\evil', 'lib/C:evil', 'lib/.. /evil']) {
				vi.mocked(listTreeRemote).mockResolvedValue({
					success: true,
					data: { directories: [], files: ['a.ts', hostile], truncated: false },
				});
				await withPlatform('win32', async () => {
					await expect(handler({}, '/work/src', 'r1'), hostile).rejects.toThrow(
						/outside the folder/
					);
				});
			}
			expect(readBinaryFileRemoteAsBase64).not.toHaveBeenCalled();
			expect(fs.rm).not.toHaveBeenCalled();
			expect(fs.mkdir).not.toHaveBeenCalled();
			expect(fs.writeFile).not.toHaveBeenCalled();
		});
	});

	// The remote names the file or folder; this machine decides where the copy
	// goes. No remote name may put it outside the download folder.
	describe('a hostile remote name and the download folder', () => {
		const downloadRoot = path.join('/tmp', 'maestro-remote-downloads');
		const channels = ['fs:downloadRemoteFile', 'fs:downloadRemoteFolder'] as const;

		beforeEach(() => {
			vi.mocked(getSshRemoteById).mockReturnValue({ id: 'r1' } as any);
			vi.mocked(readBinaryFileRemoteAsBase64).mockResolvedValue({
				success: true,
				data: Buffer.from('bytes').toString('base64'),
			} as any);
			vi.mocked(listTreeRemote).mockResolvedValue({
				success: true,
				data: { directories: [], files: ['a.ts'], truncated: false },
			});
		});

		const expectNothingTouched = (): void => {
			expect(listTreeRemote).not.toHaveBeenCalled();
			expect(readBinaryFileRemoteAsBase64).not.toHaveBeenCalled();
			expect(fs.rm).not.toHaveBeenCalled();
			expect(fs.mkdir).not.toHaveBeenCalled();
			expect(fs.writeFile).not.toHaveBeenCalled();
			expect(fs.rename).not.toHaveBeenCalled();
		};

		it.each(['/srv/..', '/srv/.', '/', '/srv/a\0b'])(
			'refuses %j, which is not a name inside the folder on any platform',
			async (remotePath) => {
				for (const channel of channels) {
					const handler = registeredHandlers.get(channel)!;
					await expect(handler({}, remotePath, 'r1'), channel).rejects.toThrow(
						/not one file name on this computer/
					);
				}
				expectNothingTouched();
			}
		);

		it.each(['/srv/..\\..\\victim', '/srv/..\\victim', '/srv/a\\b', '/srv/C:victim', '/srv/.. '])(
			'refuses %j on Windows, where it would join to another path',
			async (remotePath) => {
				for (const channel of channels) {
					const handler = registeredHandlers.get(channel)!;
					await withPlatform('win32', async () => {
						await expect(handler({}, remotePath, 'r1'), channel).rejects.toThrow(
							/not one file name on this computer/
						);
					});
				}
				expectNothingTouched();
			}
		);

		// Off Windows a backslash is a character in a name, so these stay one
		// file inside the hashed folder. The `/` forms never leave it either:
		// only the last remote segment names the copy.
		it.skipIf(process.platform === 'win32')(
			'keeps every other name as one entry inside its own hashed folder',
			async () => {
				for (const [remotePath, name] of [
					['/srv/..\\..\\victim', '..\\..\\victim'],
					['/srv/a\\b', 'a\\b'],
					['/srv/../../victim', 'victim'],
					['/srv/sub/../../../etc/passwd', 'passwd'],
				]) {
					for (const channel of channels) {
						vi.mocked(fs.rm).mockClear();
						const result = await registeredHandlers.get(channel)!({}, remotePath, 'r1');
						expectTempDownloadPath(result.path, name);
						expect(path.relative(downloadRoot, result.path).split(path.sep)).toHaveLength(2);
						// Nothing outside the download folder is ever removed.
						for (const [removed] of vi.mocked(fs.rm).mock.calls) {
							expect(path.relative(downloadRoot, removed as string)).not.toMatch(/^\.\./);
						}
					}
				}
			}
		);
	});

	describe('fs:homeDir', () => {
		it('should return the home directory', async () => {
			const handler = registeredHandlers.get('fs:homeDir');
			expect(handler).toBeDefined();

			const result = await handler!({}, null);
			expect(result).toBe('/Users/testuser');
		});
	});

	describe('fs:readDirTree', () => {
		it('delegates to the shared walker and passes the scan options through', async () => {
			const scan = {
				tree: [{ name: 'a.txt', type: 'file' }],
				truncated: false,
				filesFound: 1,
				directoriesScanned: 1,
			};
			vi.mocked(walkLocalFileTree).mockResolvedValue(scan as never);

			const handler = registeredHandlers.get('fs:readDirTree');
			expect(handler).toBeDefined();

			const options = {
				maxDepth: 5,
				maxEntries: 100,
				ignorePatterns: ['.git'],
				honorGitignore: true,
			};
			const result = await handler!({}, '/test/path', options);

			expect(walkLocalFileTree).toHaveBeenCalledWith('/test/path', options);
			expect(result).toEqual(scan);
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

		it('short-circuits a parquet file to a marker instead of reading it as text', async () => {
			// Parquet is binary, columnar, and routinely larger than RAM. Reading
			// it as UTF-8 would corrupt it and blow up the IPC payload for a file
			// the viewer only ever reads a window of, so the handler hands back a
			// marker and the ParquetViewer queries it over `parquet:*` instead.
			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/data/events.parquet');

			expect(isParquetPreviewMarker(result)).toBe(true);
			expect(parseParquetPreviewMarker(result)).toBe('/data/events.parquet');
			// The whole point: the file is never opened here.
			expect(fs.readFile).not.toHaveBeenCalled();
		});

		it('short-circuits every parquet extension, including over SSH', async () => {
			const handler = registeredHandlers.get('fs:readFile');

			for (const path of ['/d/a.parquet', '/d/b.parq', '/d/c.pq', '/d/D.PARQUET']) {
				expect([path, isParquetPreviewMarker(await handler!({}, path))]).toEqual([path, true]);
			}

			// Remote parquet takes the same path: the reader fetches the file into
			// a local cache itself, so this must NOT fall through to the SSH text
			// read (which would mangle the binary through a `cat` over stdout).
			const remote = await handler!({}, '/remote/events.parquet', 'remote-7');
			expect(isParquetPreviewMarker(remote)).toBe(true);
			expect(fs.readFile).not.toHaveBeenCalled();
		});

		it('short-circuits a proven SQLite database to a marker instead of reading it', async () => {
			// A database is binary, can be far larger than RAM, and may be a live
			// app database, so the handler hands back a marker for the SQLite
			// viewer once the header sniff proves the file is SQLite.
			vi.mocked(isSqliteDatabaseFile).mockResolvedValueOnce(true);

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/data/app.db');

			expect(isSqlitePreviewMarker(result)).toBe(true);
			expect(parseSqlitePreviewMarker(result)).toBe('/data/app.db');
			expect(isSqliteDatabaseFile).toHaveBeenCalledWith('/data/app.db');
			expect(fs.readFile).not.toHaveBeenCalled();
		});

		it('lets a .db that fails the header fall through to the ordinary read', async () => {
			// `.db` is not a format: Berkeley DB, LevelDB, SQLCipher. A failed sniff
			// must leave the old path (and so the binary card) exactly as it was.
			vi.mocked(isSqliteDatabaseFile).mockResolvedValueOnce(false);
			vi.mocked(fs.readFile).mockResolvedValue('\u0000\u0001leveldb' as any);

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/data/cache.db');

			expect(isSqlitePreviewMarker(result)).toBe(false);
			expect(fs.readFile).toHaveBeenCalledWith('/data/cache.db', 'utf-8');
		});

		it('returns null when a .db vanished before its header could be sniffed', async () => {
			vi.mocked(isSqliteDatabaseFile).mockRejectedValueOnce(
				Object.assign(new Error('missing'), { code: 'ENOENT' })
			);

			const handler = registeredHandlers.get('fs:readFile');
			await expect(handler!({}, '/data/gone.db')).resolves.toBeNull();
		});

		it('never sniffs a remote file for a SQLite header', async () => {
			// Remote databases are out of scope: the sniff reads the LOCAL disk,
			// where a remote path either does not exist or names a different file.
			vi.mocked(getSshRemoteById).mockReturnValue({ id: 'remote-7' } as any);
			vi.mocked(readFileRemote).mockResolvedValue({ success: true, data: 'remote bytes' });

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/remote/app.db', 'remote-7');

			expect(result).toBe('remote bytes');
			expect(isSqliteDatabaseFile).not.toHaveBeenCalled();
		});

		it('does not mistake a file inside a .parquet directory for a parquet file', async () => {
			// Hive-style layouts are full of `.../table.parquet/part-0` paths, and
			// the file being opened there is the part, not the directory.
			vi.mocked(fs.readFile).mockResolvedValue('plain text' as any);

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/data/table.parquet/notes.txt');

			expect(result).toBe('plain text');
			expect(fs.readFile).toHaveBeenCalledWith('/data/table.parquet/notes.txt', 'utf-8');
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

		it('should hand back a stream URL for local media', async () => {
			vi.mocked(fs.stat).mockResolvedValue({ size: 4096 } as any);

			const handler = registeredHandlers.get('fs:readFile');
			const result = await handler!({}, '/test/song.mp3');

			expect(result).toMatch(/^maestro-media:\/\//);
			// Never inlined: the bytes come over the protocol, not the IPC payload.
			expect(fs.readFile).not.toHaveBeenCalled();
		});

		it('should return null for a missing media file instead of a dead stream URL', async () => {
			// Building the URL is pure string work, so without the stat a deleted
			// file handed back a valid-looking URL and the player blamed the codec.
			vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

			const handler = registeredHandlers.get('fs:readFile');
			await expect(handler!({}, '/test/gone.mp3')).resolves.toBeNull();
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

	describe('fs:compressFolder', () => {
		it('zips a folder into <name>.zip beside it, nesting under the folder name', async () => {
			vi.mocked(existsSync).mockReturnValue(false);

			const handler = registeredHandlers.get('fs:compressFolder');
			const result = await handler!({}, '/project/Competition');

			expect(archiveMock.directory).toHaveBeenCalledWith('/project/Competition', 'Competition');
			expect(result).toEqual({
				success: true,
				// The handler builds the destination with path.join, so the expected
				// separator is the host's. Hardcoding '/' fails on Windows even
				// though the product is correct.
				path: path.join('/project', 'Competition.zip'),
				name: 'Competition.zip',
			});
		});

		it('increments a numeric suffix until the archive name is free', async () => {
			// Competition.zip and Competition-1.zip are taken; -2 is free. The
			// candidates are path.join'd by the handler, so the mock has to match on
			// the host's separator or the collision is never seen and the suffix
			// never advances.
			const taken = [
				path.join('/project', 'Competition.zip'),
				path.join('/project', 'Competition-1.zip'),
			];
			vi.mocked(existsSync).mockImplementation((candidate) => taken.includes(candidate as string));

			const handler = registeredHandlers.get('fs:compressFolder');
			const result = await handler!({}, '/project/Competition');

			expect(result).toEqual({
				success: true,
				path: path.join('/project', 'Competition-2.zip'),
				name: 'Competition-2.zip',
			});
		});

		it('compresses over SSH when sshRemoteId is set', async () => {
			const sshConfig = { id: 'remote-1', host: 'example.com' };
			vi.mocked(getSshRemoteById).mockReturnValue(sshConfig as any);
			vi.mocked(existsRemote).mockResolvedValue({ success: true, data: false });
			vi.mocked(compressFolderRemote).mockResolvedValue({ success: true });

			const handler = registeredHandlers.get('fs:compressFolder');
			const result = await handler!({}, '/remote/project/docs', { sshRemoteId: 'remote-1' });

			expect(compressFolderRemote).toHaveBeenCalledWith(
				'/remote/project/docs',
				'/remote/project/docs.zip',
				sshConfig
			);
			expect(result).toEqual({
				success: true,
				path: '/remote/project/docs.zip',
				name: 'docs.zip',
			});
		});

		it('throws when the remote compress fails', async () => {
			vi.mocked(getSshRemoteById).mockReturnValue({ id: 'remote-1' } as any);
			vi.mocked(existsRemote).mockResolvedValue({ success: true, data: false });
			vi.mocked(compressFolderRemote).mockResolvedValue({
				success: false,
				error: 'zip not installed',
			});

			const handler = registeredHandlers.get('fs:compressFolder');
			await expect(handler!({}, '/remote/docs', { sshRemoteId: 'remote-1' })).rejects.toThrow(
				'zip not installed'
			);
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

	describe('fs:deleteMany', () => {
		it('deletes every local path in one call and reports each outcome', async () => {
			vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);
			vi.mocked(fs.unlink).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('fs:deleteMany');
			const result = await handler!({}, ['/test/a.txt', '/test/b.txt', '/test/c.txt']);

			expect(fs.unlink).toHaveBeenCalledTimes(3);
			expect(result).toEqual({
				results: [
					{ path: '/test/a.txt', success: true },
					{ path: '/test/b.txt', success: true },
					{ path: '/test/c.txt', success: true },
				],
			});
		});

		it('keeps deleting past a failure and attributes it to the right path', async () => {
			vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);
			vi.mocked(fs.unlink).mockImplementation(async (target) => {
				if (target === '/test/b.txt') throw new Error('EACCES: permission denied');
			});

			const handler = registeredHandlers.get('fs:deleteMany');
			const result = await handler!({}, ['/test/a.txt', '/test/b.txt', '/test/c.txt']);

			// One bad file must not sink the rest of the batch, and the caller
			// needs to know WHICH path failed to report it.
			expect(result.results).toEqual([
				{ path: '/test/a.txt', success: true },
				{ path: '/test/b.txt', success: false, error: 'EACCES: permission denied' },
				{ path: '/test/c.txt', success: true },
			]);
		});

		it('routes directories through rm and files through unlink', async () => {
			vi.mocked(fs.stat).mockImplementation(
				async (target) => ({ isDirectory: () => target === '/test/folder' }) as any
			);
			vi.mocked(fs.rm).mockResolvedValue(undefined);
			vi.mocked(fs.unlink).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('fs:deleteMany');
			await handler!({}, ['/test/folder', '/test/file.txt']);

			expect(fs.rm).toHaveBeenCalledWith('/test/folder', { recursive: true, force: true });
			expect(fs.unlink).toHaveBeenCalledWith('/test/file.txt');
		});

		it('sends the whole remote batch to deleteManyRemote in one go', async () => {
			const mockSshConfig = { id: 'remote-1', host: 'server.com', username: 'user' };
			vi.mocked(getSshRemoteById).mockReturnValue(mockSshConfig as any);
			vi.mocked(deleteManyRemote).mockResolvedValue([
				{ success: true },
				{ success: false, error: 'Permission denied: /remote/b.txt' },
			]);

			const handler = registeredHandlers.get('fs:deleteMany');
			const result = await handler!({}, ['/remote/a.txt', '/remote/b.txt'], {
				sshRemoteId: 'remote-1',
			});

			// One SSH round trip for the batch, not one handshake per file.
			expect(deleteManyRemote).toHaveBeenCalledTimes(1);
			expect(deleteManyRemote).toHaveBeenCalledWith(
				['/remote/a.txt', '/remote/b.txt'],
				mockSshConfig,
				true
			);
			expect(deleteRemote).not.toHaveBeenCalled();
			expect(result).toEqual({
				results: [
					{ path: '/remote/a.txt', success: true },
					{ path: '/remote/b.txt', success: false, error: 'Permission denied: /remote/b.txt' },
				],
			});
		});

		it('throws when the SSH remote cannot be resolved', async () => {
			vi.mocked(getSshRemoteById).mockReturnValue(undefined as any);

			const handler = registeredHandlers.get('fs:deleteMany');

			// A missing remote is a config failure for the whole call, not N
			// identical per-path errors - and it must never fall through to a
			// LOCAL delete of paths the user meant to remove on the remote host.
			await expect(handler!({}, ['/remote/a.txt'], { sshRemoteId: 'gone' })).rejects.toThrow(
				'SSH remote not found: gone'
			);
			expect(fs.unlink).not.toHaveBeenCalled();
		});

		it('short-circuits an empty batch without touching the filesystem', async () => {
			const handler = registeredHandlers.get('fs:deleteMany');
			const result = await handler!({}, []);

			expect(result).toEqual({ results: [] });
			expect(fs.unlink).not.toHaveBeenCalled();
			expect(deleteManyRemote).not.toHaveBeenCalled();
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
		// The same tree gives the same footer wherever the agent runs: the remote walk
		// applies the local walk's patterns, root .gitignore, and depth.
		describe('the same tree, local or on an SSH remote', () => {
			// project/: src/index.ts (10 B), .git/HEAD (5 B), dist/out.js (7 B), app.ts (3 B)
			const mockLocalTree = async () => {
				const mockFs = (await import('fs/promises')).default;
				vi.mocked(mockFs.readFile).mockImplementation(async (filePath: any) => {
					if (String(filePath).endsWith('.gitignore')) return 'dist\n';
					throw new Error('ENOENT');
				});
				vi.mocked(mockFs.readdir).mockImplementation(async (dirPath: any) => {
					const p = String(dirPath).replace(/\\/g, '/');
					const entry = (name: string, kind: 'dir' | 'file' | 'link') => ({
						name,
						isDirectory: () => kind === 'dir',
						isFile: () => kind === 'file',
						isSymbolicLink: () => kind === 'link',
					});
					const dir = (name: string) => entry(name, 'dir');
					const file = (name: string) => entry(name, 'file');
					if (p === '/srv/tree')
						return [
							dir('src'),
							dir('.git'),
							dir('dist'),
							file('app.ts'),
							// A link to a folder: counted as the folder, as the tree draws it.
							entry('lib', 'link'),
						] as any;
					if (p.endsWith('/lib')) return [file('util.ts')] as any;
					if (p.endsWith('/src')) return [file('index.ts')] as any;
					if (p.endsWith('/.git')) return [file('HEAD')] as any;
					if (p.endsWith('/dist')) return [file('out.js')] as any;
					return [];
				});
				vi.mocked(mockFs.stat).mockImplementation(async (filePath: any) => {
					const p = String(filePath).replace(/\\/g, '/');
					// The link resolves to a folder; every other path is a file.
					if (p.endsWith('/lib')) return { isDirectory: () => true, isFile: () => false } as any;
					const sizes: Record<string, number> = {
						'util.ts': 2,
						'index.ts': 10,
						HEAD: 5,
						'out.js': 7,
						'app.ts': 3,
					};
					return { size: sizes[p.split('/').pop()!] ?? 0 } as any;
				});
			};
			const mockRemoteTree = () => {
				vi.mocked(getSshRemoteById).mockReturnValue({ id: 'r1', host: 'box' } as any);
				vi.mocked(readFileRemote).mockResolvedValue({ success: true, data: 'dist\n' });
				// What `find` returns once the patterns it was given are pruned: `.git`
				// stays because the remote's `find -name` is asked for `.GIT`.
				// `find -L` lists the linked folder `lib` as a folder, as the local walk now counts it.
				vi.mocked(listTreeRemote).mockResolvedValue({
					success: true,
					data: {
						directories: ['src', '.git', 'lib'],
						files: ['src/index.ts', '.git/HEAD', 'app.ts', 'lib/util.ts'],
						fileSizes: [10, 5, 3, 2],
						truncated: false,
					},
				});
			};

			it('counts and sizes the tree the same in every mode', async () => {
				const handler = registeredHandlers.get('fs:directorySize');
				const results: Record<string, unknown> = {};
				for (const mode of ['local', 'ssh', 'hosted'] as const) {
					if (mode === 'local') await mockLocalTree();
					else mockRemoteTree();
					// A hosted agent keeps its SSH remote, so the Files panel asks the same way.
					results[mode] = await handler!(
						{},
						'/srv/tree',
						mode === 'local' ? undefined : 'r1',
						['.GIT', 'node_modules'],
						true
					);
				}
				expect(results.local).toEqual({
					totalSize: 15,
					fileCount: 3,
					folderCount: 2,
					fileCountCapped: false,
				});
				expect(results.ssh).toEqual(results.local);
				expect(results.hosted).toEqual(results.local);
			});

			it('stops counting a huge tree at the same cap in every mode, and says so', async () => {
				const handler = registeredHandlers.get('fs:directorySize');
				const total = DIRECTORY_SIZE_MAX_FILES + 5;
				const names = Array.from({ length: total }, (_, i) => `f${i}.txt`);
				const results: Record<string, unknown> = {};
				for (const mode of ['local', 'ssh', 'hosted'] as const) {
					if (mode === 'local') {
						const mockFs = (await import('fs/promises')).default;
						vi.mocked(mockFs.readFile).mockRejectedValue(new Error('ENOENT'));
						vi.mocked(mockFs.readdir).mockImplementation(async (dirPath: any) =>
							String(dirPath).replace(/\\/g, '/') === '/srv/huge'
								? (names.map((name) => ({
										name,
										isDirectory: () => false,
										isFile: () => true,
										isSymbolicLink: () => false,
									})) as any)
								: []
						);
						vi.mocked(mockFs.stat).mockResolvedValue({ size: 1 } as any);
					} else {
						vi.mocked(getSshRemoteById).mockReturnValue({ id: 'r1', host: 'box' } as any);
						// The listing itself is capped on the remote (`head`), and says it was.
						vi.mocked(listTreeRemote).mockResolvedValue({
							success: true,
							data: {
								directories: [],
								files: names.slice(0, DIRECTORY_SIZE_MAX_FILES),
								fileSizes: names.slice(0, DIRECTORY_SIZE_MAX_FILES).map(() => 1),
								truncated: true,
							},
						});
					}
					results[mode] = await handler!(
						{},
						'/srv/huge',
						mode === 'local' ? undefined : 'r1',
						[],
						false
					);
				}
				expect(results.local).toEqual({
					totalSize: DIRECTORY_SIZE_MAX_FILES,
					fileCount: DIRECTORY_SIZE_MAX_FILES,
					folderCount: 0,
					fileCountCapped: true,
				});
				expect(results.ssh).toEqual(results.local);
				expect(results.hosted).toEqual(results.local);
				expect(listTreeRemote).toHaveBeenCalledWith(
					'/srv/huge',
					expect.objectContaining({ maxFiles: DIRECTORY_SIZE_MAX_FILES }),
					expect.anything()
				);
			});

			it('asks the remote for the same patterns, its own .gitignore, and the same depth', async () => {
				mockRemoteTree();
				const handler = registeredHandlers.get('fs:directorySize');
				await handler!({}, '/srv/remote-only', 'r1', ['.git'], true);

				expect(readFileRemote).toHaveBeenCalledWith(
					'/srv/remote-only/.gitignore',
					expect.objectContaining({ id: 'r1' })
				);
				expect(listTreeRemote).toHaveBeenCalledWith(
					'/srv/remote-only',
					{
						maxDepth: 10,
						ignorePatterns: ['.git', 'dist'],
						withSizes: true,
						maxFiles: DIRECTORY_SIZE_MAX_FILES,
					},
					expect.objectContaining({ id: 'r1' })
				);
			});

			it('fails loudly, never counting here, when the remote cannot be read', async () => {
				vi.mocked(getSshRemoteById).mockReturnValue({ id: 'r1', host: 'box' } as any);
				vi.mocked(listTreeRemote).mockResolvedValue({ success: false, error: 'ssh: timed out' });
				const mockFs = (await import('fs/promises')).default;
				vi.mocked(mockFs.readdir).mockClear();

				const handler = registeredHandlers.get('fs:directorySize');
				await expect(handler!({}, '/srv/down', 'r1', [], false)).rejects.toThrow('ssh: timed out');
				expect(mockFs.readdir).not.toHaveBeenCalled();
			});
		});

		// A full recursive stat of the working directory is the most expensive thing
		// the main process does, and the Files panel asks for it from several places
		// inside one refresh cycle. Identical back-to-back requests must collapse
		// into a single walk.
		it('collapses identical back-to-back local requests into one walk', async () => {
			const mockFs = (await import('fs/promises')).default;

			vi.mocked(mockFs.readdir).mockImplementation(async (dirPath: any) => {
				if (dirPath === '/dedupe') {
					return [
						{
							name: 'file.txt',
							isDirectory: () => false,
							isFile: () => true,
							isSymbolicLink: () => false,
						},
					] as any;
				}
				return [];
			});
			vi.mocked(mockFs.stat).mockResolvedValue({ size: 7 } as any);

			const handler = registeredHandlers.get('fs:directorySize');
			const patterns = ['node_modules'];

			const [a, b] = await Promise.all([
				handler!({}, '/dedupe', undefined, patterns, false),
				handler!({}, '/dedupe', undefined, patterns, false),
			]);
			const c = await handler!({}, '/dedupe', undefined, patterns, false);

			expect(a).toEqual({ totalSize: 7, fileCount: 1, folderCount: 0, fileCountCapped: false });
			expect(b).toEqual(a);
			expect(c).toEqual(a);
			expect(vi.mocked(mockFs.readdir)).toHaveBeenCalledTimes(1);
		});

		it('does not reuse one directory answer for a different request', async () => {
			const mockFs = (await import('fs/promises')).default;

			vi.mocked(mockFs.readdir).mockImplementation(async (dirPath: any) => {
				if (dirPath === '/one') {
					return [
						{
							name: 'a.txt',
							isDirectory: () => false,
							isFile: () => true,
							isSymbolicLink: () => false,
						},
					] as any;
				}
				if (dirPath === '/two') {
					return [
						{
							name: 'a.txt',
							isDirectory: () => false,
							isFile: () => true,
							isSymbolicLink: () => false,
						},
						{
							name: 'b.txt',
							isDirectory: () => false,
							isFile: () => true,
							isSymbolicLink: () => false,
						},
					] as any;
				}
				return [];
			});
			vi.mocked(mockFs.stat).mockResolvedValue({ size: 10 } as any);

			const handler = registeredHandlers.get('fs:directorySize');

			// Different directory.
			expect((await handler!({}, '/one', undefined, ['x'], false)).fileCount).toBe(1);
			expect((await handler!({}, '/two', undefined, ['x'], false)).fileCount).toBe(2);
			// Same directory, different ignore patterns.
			expect((await handler!({}, '/two', undefined, ['y'], false)).fileCount).toBe(2);
			expect(vi.mocked(mockFs.readdir).mock.calls.length).toBeGreaterThanOrEqual(3);
		});

		it('should respect custom ignore patterns for local directories', async () => {
			const mockFs = (await import('fs/promises')).default;

			// Root has: src/ (dir), .git/ (dir), file.txt (file)
			vi.mocked(mockFs.readdir).mockImplementation(async (dirPath: any) => {
				const p = String(dirPath).replace(/\\/g, '/');
				if (p === '/project') {
					return [
						{
							name: 'src',
							isDirectory: () => true,
							isFile: () => false,
							isSymbolicLink: () => false,
						},
						{
							name: '.git',
							isDirectory: () => true,
							isFile: () => false,
							isSymbolicLink: () => false,
						},
						{
							name: 'file.txt',
							isDirectory: () => false,
							isFile: () => true,
							isSymbolicLink: () => false,
						},
					] as any;
				}
				if (p.includes('/src')) {
					return [
						{
							name: 'index.ts',
							isDirectory: () => false,
							isFile: () => true,
							isSymbolicLink: () => false,
						},
					] as any;
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
						{
							name: 'src',
							isDirectory: () => true,
							isFile: () => false,
							isSymbolicLink: () => false,
						},
						{
							name: '.git',
							isDirectory: () => true,
							isFile: () => false,
							isSymbolicLink: () => false,
						},
						{
							name: 'file.txt',
							isDirectory: () => false,
							isFile: () => true,
							isSymbolicLink: () => false,
						},
					] as any;
				}
				if (p.includes('/src')) {
					return [
						{
							name: 'index.ts',
							isDirectory: () => false,
							isFile: () => true,
							isSymbolicLink: () => false,
						},
					] as any;
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
						{
							name: 'src',
							isDirectory: () => true,
							isFile: () => false,
							isSymbolicLink: () => false,
						},
						{
							name: 'dist',
							isDirectory: () => true,
							isFile: () => false,
							isSymbolicLink: () => false,
						},
						{
							name: 'app.ts',
							isDirectory: () => false,
							isFile: () => true,
							isSymbolicLink: () => false,
						},
						{
							name: 'debug.log',
							isDirectory: () => false,
							isFile: () => true,
							isSymbolicLink: () => false,
						},
					] as any;
				}
				if (p.includes('/src')) {
					return [
						{
							name: 'index.ts',
							isDirectory: () => false,
							isFile: () => true,
							isSymbolicLink: () => false,
						},
					] as any;
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

			expect(global.fetch).toHaveBeenCalledWith(
				'https://example.com/image.jpg',
				expect.objectContaining({ signal: expect.any(AbortSignal) })
			);
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

				expect(global.fetch).toHaveBeenCalledWith(
					'https://cdn.example.com/image.png',
					expect.objectContaining({ signal: expect.any(AbortSignal) })
				);
				expect(result).toMatch(/^data:image\/png;base64,/);
			});
		});
	});
});

describe('remote folder copy budget', () => {
	it('caps the whole copy at 500 MB and one file at 50 MB', () => {
		expect(REMOTE_FOLDER_DOWNLOAD_MAX_BYTES).toBe(500 * 1024 * 1024);
		expect(REMOTE_FOLDER_DOWNLOAD_MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
	});

	it('lets a folder at the limits through and refuses one byte over, with its size', () => {
		expect(
			remoteFolderTooLarge(REMOTE_FOLDER_DOWNLOAD_MAX_BYTES, {
				name: 'a',
				size: REMOTE_FOLDER_DOWNLOAD_MAX_FILE_BYTES,
			})
		).toBeNull();
		expect(remoteFolderTooLarge(REMOTE_FOLDER_DOWNLOAD_MAX_BYTES + 1, null)).toBe(
			'The folder is too large to copy to this computer (500.0 MB; the limit is 500.0 MB)'
		);
	});

	it('cuts a long hostile file name in the message', () => {
		const message = remoteFolderTooLarge(1, {
			name: 'x'.repeat(5000),
			size: REMOTE_FOLDER_DOWNLOAD_MAX_FILE_BYTES + 1,
		});
		expect(message!.length).toBeLessThan(400);
	});
});
