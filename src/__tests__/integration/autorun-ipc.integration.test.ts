/**
 * @file autorun-ipc.integration.test.ts
 * @description Integration coverage for Auto Run IPC handlers against a real temp filesystem.
 */

import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAutorunHandlers } from '../../main/ipc/handlers/autorun';
import type { SshRemoteConfig } from '../../shared/types';

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
type WatcherHandler = (filePath: string) => void;

const ipcState = vi.hoisted(() => ({
	handlers: new Map<string, IpcHandler>(),
}));

const chokidarState = vi.hoisted(() => ({
	watchers: [] as Array<{
		folderPath: string;
		handlers: Map<string, WatcherHandler>;
		close: ReturnType<typeof vi.fn>;
	}>,
	watch: vi.fn((folderPath: string) => {
		const handlers = new Map<string, WatcherHandler>();
		const watcher = {
			on: vi.fn((event: string, handler: WatcherHandler) => {
				handlers.set(event, handler);
				return watcher;
			}),
			close: vi.fn(),
		};
		chokidarState.watchers.push({ folderPath, handlers, close: watcher.close });
		return watcher;
	}),
}));

const remoteFsState = vi.hoisted(() => ({
	readDirRemote: vi.fn(),
	readFileRemote: vi.fn(),
	writeFileRemote: vi.fn(),
	existsRemote: vi.fn(),
	mkdirRemote: vi.fn(),
	deleteRemote: vi.fn(),
	sshRemotes: [] as SshRemoteConfig[],
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: IpcHandler) => {
			ipcState.handlers.set(channel, handler);
		}),
		removeHandler: vi.fn((channel: string) => {
			ipcState.handlers.delete(channel);
		}),
	},
	BrowserWindow: vi.fn(),
	App: vi.fn(),
}));

vi.mock('chokidar', () => ({
	default: {
		watch: chokidarState.watch,
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../main/utils/remote-fs', () => ({
	readDirRemote: remoteFsState.readDirRemote,
	readFileRemote: remoteFsState.readFileRemote,
	writeFileRemote: remoteFsState.writeFileRemote,
	existsRemote: remoteFsState.existsRemote,
	mkdirRemote: remoteFsState.mkdirRemote,
	deleteRemote: remoteFsState.deleteRemote,
}));

const sshRemote: SshRemoteConfig = {
	id: 'remote-1',
	name: 'Remote One',
	host: 'remote.example.com',
	port: 22,
	username: 'maestro',
	privateKeyPath: '/keys/maestro',
	enabled: true,
};

describe('Auto Run IPC integration', () => {
	let tempRoot: string;
	let docsDir: string;
	let appHandlers: Map<string, () => void>;
	let webContentsSend: ReturnType<typeof vi.fn>;
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let dateNowSpy: ReturnType<typeof vi.spyOn> | undefined;

	async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
		const handler = ipcState.handlers.get(channel);
		expect(handler, `Expected ${channel} to be registered`).toBeDefined();
		return (await handler!({}, ...args)) as T;
	}

	async function writeFixtureDocs() {
		await fs.mkdir(path.join(docsDir, 'folder'), { recursive: true });
		await fs.mkdir(path.join(docsDir, '.hidden'), { recursive: true });
		await fs.writeFile(path.join(docsDir, 'alpha.md'), '# Alpha\n\n- [ ] first task');
		await fs.writeFile(path.join(docsDir, 'Zeta.md'), '# Zeta');
		await fs.writeFile(path.join(docsDir, 'folder', 'Beta.md'), '# Beta');
		await fs.writeFile(path.join(docsDir, 'folder', 'ignore.txt'), 'not markdown');
		await fs.writeFile(path.join(docsDir, '.hidden', 'secret.md'), '# Hidden');
	}

	async function expectFailure(channel: string, args: unknown[], expectedMessage: string) {
		const result = await invoke<Record<string, unknown>>(channel, ...args);
		expect(result).toMatchObject({
			success: false,
			error: expect.stringContaining(expectedMessage),
		});
		return result;
	}

	beforeEach(async () => {
		vi.clearAllMocks();
		remoteFsState.readDirRemote.mockReset();
		remoteFsState.readFileRemote.mockReset();
		remoteFsState.writeFileRemote.mockReset();
		remoteFsState.existsRemote.mockReset();
		remoteFsState.mkdirRemote.mockReset();
		remoteFsState.deleteRemote.mockReset();
		ipcState.handlers.clear();
		chokidarState.watchers = [];
		remoteFsState.sshRemotes = [sshRemote];
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		tempRoot = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'maestro-autorun-ipc-'));
		docsDir = path.join(tempRoot, 'Auto Run Docs');
		await fs.mkdir(docsDir, { recursive: true });
		await writeFixtureDocs();

		appHandlers = new Map();
		webContentsSend = vi.fn();

		registerAutorunHandlers({
			mainWindow: null as any,
			getMainWindow: () =>
				({
					isDestroyed: () => false,
					webContents: {
						isDestroyed: () => false,
						send: webContentsSend,
					},
				}) as any,
			app: {
				on: vi.fn((event: string, handler: () => void) => {
					appHandlers.set(event, handler);
					return {} as any;
				}),
			} as any,
			settingsStore: {
				get: vi.fn((key: string, fallback: unknown) =>
					key === 'sshRemotes' ? remoteFsState.sshRemotes : fallback
				),
			} as any,
		});
	});

	afterEach(async () => {
		appHandlers.get('before-quit')?.();
		ipcState.handlers.clear();
		chokidarState.watchers = [];
		consoleLogSpy.mockRestore();
		dateNowSpy?.mockRestore();
		dateNowSpy = undefined;
		vi.useRealTimers();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it('lists, detects, reads, and writes markdown documents with subdirectories', async () => {
		const hasDocs = await invoke<Record<string, unknown>>('autorun:hasDocuments', docsDir);
		expect(hasDocs).toEqual({ success: true, hasDocuments: true });

		const listed = await invoke<{ success: true; files: string[]; tree: unknown[] }>(
			'autorun:listDocs',
			docsDir
		);
		expect(listed.files).toEqual(['folder/Beta', 'alpha', 'Zeta']);
		expect(listed.tree).toEqual([
			{
				name: 'folder',
				type: 'folder',
				path: 'folder',
				children: [{ name: 'Beta', type: 'file', path: 'folder/Beta' }],
			},
			{ name: 'alpha', type: 'file', path: 'alpha' },
			{ name: 'Zeta', type: 'file', path: 'Zeta' },
		]);

		const read = await invoke<{ success: true; content: string }>(
			'autorun:readDoc',
			docsDir,
			'folder/Beta'
		);
		expect(read).toEqual({ success: true, content: '# Beta' });

		const writeResult = await invoke<Record<string, unknown>>(
			'autorun:writeDoc',
			docsDir,
			'nested/New Task',
			'# New Task\n\n- [ ] verify'
		);
		expect(writeResult).toEqual({ success: true });
		await expect(fs.readFile(path.join(docsDir, 'nested', 'New Task.md'), 'utf-8')).resolves.toBe(
			'# New Task\n\n- [ ] verify'
		);

		const traversal = await invoke<Record<string, unknown>>(
			'autorun:readDoc',
			docsDir,
			'../outside'
		);
		expect(traversal).toMatchObject({ success: false, error: expect.stringContaining('Invalid') });
	});

	it('rejects unsafe local inputs and handles filesystem edge cases', async () => {
		await fs.mkdir(path.join(docsDir, 'empty-folder'), { recursive: true });
		await fs.writeFile(path.join(docsDir, 'empty-folder', 'note.txt'), 'not markdown');
		await fs
			.symlink(path.join(docsDir, 'missing.md'), path.join(docsDir, 'broken.md'))
			.catch(() => {});
		const relisted = await invoke<{ success: true; files: string[] }>('autorun:listDocs', docsDir);
		expect(relisted.files).not.toContain('empty-folder/note');
		expect(relisted.files).not.toContain('broken');

		const nestedOnlyDir = path.join(tempRoot, 'nested-only-docs');
		await fs.mkdir(path.join(nestedOnlyDir, 'deep'), { recursive: true });
		await fs.writeFile(path.join(nestedOnlyDir, 'deep', 'only.md'), '# nested');
		await expect(
			invoke<Record<string, unknown>>('autorun:hasDocuments', nestedOnlyDir)
		).resolves.toEqual({ success: true, hasDocuments: true });

		const emptyDocsDir = path.join(tempRoot, 'empty-docs');
		await fs.mkdir(path.join(emptyDocsDir, 'deep'), { recursive: true });
		await fs.writeFile(path.join(emptyDocsDir, 'deep', 'note.txt'), 'not markdown');
		await expect(
			invoke<Record<string, unknown>>('autorun:hasDocuments', emptyDocsDir)
		).resolves.toEqual({ success: true, hasDocuments: false });

		const notDirectory = path.join(tempRoot, 'not-directory.md');
		await fs.writeFile(notDirectory, '# file');
		await expectFailure('autorun:listDocs', [notDirectory], 'Path is not a directory');
		await expect(
			invoke<Record<string, unknown>>('autorun:hasDocuments', notDirectory)
		).resolves.toEqual({ success: true, hasDocuments: false });
		await expect(
			invoke<Record<string, unknown>>('autorun:hasDocuments', path.join(tempRoot, 'missing-docs'))
		).resolves.toEqual({ success: true, hasDocuments: false });
		await expect(
			invoke<Record<string, unknown>>('autorun:readDoc', docsDir, 'missing')
		).resolves.toEqual({ success: true, content: '', notFound: true });
		await expect(
			invoke<Record<string, unknown>>('autorun:readDoc', docsDir, 'alpha.md')
		).resolves.toEqual({ success: true, content: '# Alpha\n\n- [ ] first task' });

		const encodedName = '%E0%A4%A';
		await expect(
			invoke<Record<string, unknown>>('autorun:writeDoc', docsDir, encodedName, '# encoded')
		).resolves.toEqual({ success: true });
		await expect(fs.readFile(path.join(docsDir, `${encodedName}.md`), 'utf-8')).resolves.toBe(
			'# encoded'
		);
		await expectFailure('autorun:writeDoc', [docsDir, '%2e%2e/outside', '# unsafe'], 'Invalid');
		await expect(
			invoke<Record<string, unknown>>('autorun:writeDoc', docsDir, 'already.md', '# Already')
		).resolves.toEqual({ success: true });

		await expectFailure('autorun:saveImage', [docsDir, '..', 'aW1hZ2U=', 'png'], 'Invalid');
		await expectFailure('autorun:saveImage', [docsDir, 'alpha', 'aW1hZ2U=', 'bmp'], 'Invalid');
		await expect(
			invoke<Record<string, unknown>>('autorun:listImages', docsDir, 'alpha')
		).resolves.toEqual({ success: true, images: [] });
		await expectFailure('autorun:listImages', [docsDir, '..'], 'Invalid document name');
		await expectFailure(
			'autorun:deleteImage',
			[docsDir, 'images/missing.png'],
			'Image file not found'
		);

		await expectFailure('autorun:createBackup', [docsDir, '../alpha'], 'Invalid filename');
		await expectFailure('autorun:createBackup', [docsDir, 'missing'], 'Source file not found');
		await expect(
			invoke<Record<string, unknown>>('autorun:createBackup', docsDir, 'already.md')
		).resolves.toEqual({ success: true, backupFilename: 'already.backup.md' });
		await fs.writeFile(path.join(docsDir, 'already.md'), '# Changed');
		await expectFailure('autorun:restoreBackup', [docsDir, '../alpha'], 'Invalid filename');
		await expectFailure('autorun:restoreBackup', [docsDir, 'missing'], 'Backup file not found');
		await expect(
			invoke<Record<string, unknown>>('autorun:restoreBackup', docsDir, 'already.md')
		).resolves.toEqual({ success: true });
		await expect(fs.readFile(path.join(docsDir, 'already.md'), 'utf-8')).resolves.toBe('# Already');
		await expectFailure('autorun:createWorkingCopy', [docsDir, '../alpha', 1], 'Invalid filename');
		await expectFailure(
			'autorun:createWorkingCopy',
			[docsDir, 'missing', 1],
			'Source file not found'
		);
		dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(321);
		await expect(
			invoke<Record<string, unknown>>('autorun:createWorkingCopy', docsDir, 'already.md', 1)
		).resolves.toEqual({
			success: true,
			workingCopyPath: 'runs/already-321-loop-1',
			originalPath: 'already',
		});

		await expectFailure('autorun:deleteFolder', [null], 'Invalid project path');
		const projectWithoutDocs = path.join(tempRoot, 'project-without-docs');
		await fs.mkdir(projectWithoutDocs, { recursive: true });
		await expect(
			invoke<Record<string, unknown>>('autorun:deleteFolder', projectWithoutDocs)
		).resolves.toEqual({ success: true });
		const projectWithFile = path.join(tempRoot, 'project-with-file');
		await fs.mkdir(projectWithFile, { recursive: true });
		await fs.writeFile(path.join(projectWithFile, 'Auto Run Docs'), 'not a directory');
		await expect(
			invoke<Record<string, unknown>>('autorun:deleteFolder', projectWithFile)
		).resolves.toEqual({ success: true });
		await expect(fs.readFile(path.join(projectWithFile, 'Auto Run Docs'), 'utf-8')).resolves.toBe(
			'not a directory'
		);

		const createdWatchDir = path.join(tempRoot, 'created-watch');
		await expect(
			invoke<Record<string, unknown>>('autorun:watchFolder', createdWatchDir)
		).resolves.toEqual({ success: true });
		expect((await fs.stat(createdWatchDir)).isDirectory()).toBe(true);
		const firstWatcher = chokidarState.watchers.at(-1);
		await expect(
			invoke<Record<string, unknown>>('autorun:watchFolder', createdWatchDir)
		).resolves.toEqual({ success: true });
		expect(firstWatcher?.close).toHaveBeenCalledOnce();
		chokidarState.watchers.at(-1)?.handlers.get('error')?.('watch failed');
		appHandlers.get('before-quit')?.();
		expect(chokidarState.watchers.every(({ close }) => close.mock.calls.length > 0)).toBe(true);

		await expectFailure('autorun:watchFolder', [notDirectory], 'Path is not a directory');
		await expect(
			invoke<Record<string, unknown>>('autorun:unwatchFolder', path.join(tempRoot, 'not-watched'))
		).resolves.toEqual({ success: true });
		await expectFailure('autorun:deleteBackups', [notDirectory], 'Path is not a directory');
	});

	it('saves, lists, and deletes document images', async () => {
		dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456);
		await fs.mkdir(path.join(docsDir, 'images'), { recursive: true });
		await fs.writeFile(path.join(docsDir, 'images', 'beta-1.png'), 'beta');
		await fs.writeFile(path.join(docsDir, 'images', 'alpha-old.txt'), 'ignore');

		const saved = await invoke<{ success: true; relativePath: string }>(
			'autorun:saveImage',
			docsDir,
			'alpha.md',
			Buffer.from('image-data').toString('base64'),
			'PNG'
		);
		expect(saved).toEqual({ success: true, relativePath: 'images/alpha-123456.png' });
		await expect(fs.readFile(path.join(docsDir, saved.relativePath), 'utf-8')).resolves.toBe(
			'image-data'
		);

		const images = await invoke<{
			success: true;
			images: Array<{ filename: string; relativePath: string }>;
		}>('autorun:listImages', docsDir, 'alpha');
		expect(images.images).toEqual([
			{ filename: 'alpha-123456.png', relativePath: 'images/alpha-123456.png' },
		]);

		const deleted = await invoke<Record<string, unknown>>(
			'autorun:deleteImage',
			docsDir,
			saved.relativePath
		);
		expect(deleted).toEqual({ success: true });
		await expect(fs.access(path.join(docsDir, saved.relativePath))).rejects.toThrow();

		const invalid = await invoke<Record<string, unknown>>(
			'autorun:deleteImage',
			docsDir,
			'../alpha-123456.png'
		);
		expect(invalid).toMatchObject({ success: false, error: expect.stringContaining('Invalid') });
	});

	it('creates, restores, deletes backups, creates working copies, and deletes the docs folder', async () => {
		dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(999);

		const backup = await invoke<{ success: true; backupFilename: string }>(
			'autorun:createBackup',
			docsDir,
			'alpha'
		);
		expect(backup).toEqual({ success: true, backupFilename: 'alpha.backup.md' });
		await fs.writeFile(path.join(docsDir, 'alpha.md'), '# Changed');

		const restored = await invoke<Record<string, unknown>>(
			'autorun:restoreBackup',
			docsDir,
			'alpha'
		);
		expect(restored).toEqual({ success: true });
		await expect(fs.readFile(path.join(docsDir, 'alpha.md'), 'utf-8')).resolves.toBe(
			'# Alpha\n\n- [ ] first task'
		);
		await expect(fs.access(path.join(docsDir, 'alpha.backup.md'))).rejects.toThrow();

		await fs.writeFile(path.join(docsDir, 'stale.backup.md'), '# stale');
		await fs.writeFile(path.join(docsDir, 'folder', 'Beta.backup.md'), '# beta backup');
		const deletedBackups = await invoke<{ success: true; deletedCount: number }>(
			'autorun:deleteBackups',
			docsDir
		);
		expect(deletedBackups).toEqual({ success: true, deletedCount: 2 });

		const workingCopy = await invoke<{
			success: true;
			workingCopyPath: string;
			originalPath: string;
		}>('autorun:createWorkingCopy', docsDir, 'folder/Beta', 2);
		expect(workingCopy).toEqual({
			success: true,
			workingCopyPath: 'runs/folder/Beta-999-loop-2',
			originalPath: 'folder/Beta',
		});
		await expect(
			fs.readFile(path.join(docsDir, 'runs', 'folder', 'Beta-999-loop-2.md'), 'utf-8')
		).resolves.toBe('# Beta');

		const deletedFolder = await invoke<Record<string, unknown>>('autorun:deleteFolder', tempRoot);
		expect(deletedFolder).toEqual({ success: true });
		await expect(fs.access(docsDir)).rejects.toThrow();
	});

	it('watches markdown changes, debounces notifications, and closes watchers', async () => {
		vi.useFakeTimers();

		const watchResult = await invoke<Record<string, unknown>>('autorun:watchFolder', docsDir);
		expect(watchResult).toEqual({ success: true });
		expect(chokidarState.watchers).toHaveLength(1);

		const watcher = chokidarState.watchers[0];
		watcher.handlers.get('change')?.(path.join(docsDir, 'alpha.md'));
		await vi.advanceTimersByTimeAsync(100);
		watcher.handlers.get('unlink')?.(path.join(docsDir, 'folder', 'Beta.md'));
		watcher.handlers.get('add')?.(path.join(docsDir, 'ignore.txt'));

		await vi.advanceTimersByTimeAsync(299);
		expect(webContentsSend).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(webContentsSend).toHaveBeenCalledWith('autorun:fileChanged', {
			folderPath: docsDir,
			filename: 'folder/Beta',
			eventType: 'rename',
		});

		const unwatchResult = await invoke<Record<string, unknown>>('autorun:unwatchFolder', docsDir);
		expect(unwatchResult).toEqual({ success: true });
		expect(watcher.close).toHaveBeenCalledOnce();
	});

	it('routes remote document listing, reading, and writing through SSH helpers', async () => {
		remoteFsState.readDirRemote.mockImplementation(async (dirPath: string) => {
			if (dirPath === '/remote/docs') {
				return {
					success: true,
					data: [
						{ name: '.hidden.md', isDirectory: false, isSymlink: false },
						{ name: 'empty', isDirectory: true, isSymlink: false },
						{ name: 'folder', isDirectory: true, isSymlink: false },
						{ name: 'ignore.txt', isDirectory: false, isSymlink: false },
						{ name: 'alpha.md', isDirectory: false, isSymlink: false },
					],
				};
			}
			if (dirPath === '/remote/docs/empty') {
				return {
					success: true,
					data: [{ name: 'ignore.txt', isDirectory: false, isSymlink: false }],
				};
			}
			if (dirPath === '/remote/docs/folder') {
				return {
					success: true,
					data: [{ name: 'Beta.md', isDirectory: false, isSymlink: false }],
				};
			}
			return { success: false, error: `unexpected dir ${dirPath}` };
		});
		remoteFsState.readFileRemote.mockResolvedValue({ success: true, data: '# Remote beta' });
		remoteFsState.existsRemote.mockResolvedValue({ success: true, data: false });
		remoteFsState.mkdirRemote.mockResolvedValue({ success: true });
		remoteFsState.writeFileRemote.mockResolvedValue({ success: true });

		const listed = await invoke<{ success: true; files: string[]; tree: unknown[] }>(
			'autorun:listDocs',
			'/remote/docs',
			'remote-1'
		);
		expect(listed.files).toEqual(['folder/Beta', 'alpha']);
		expect(remoteFsState.readDirRemote).toHaveBeenCalledWith('/remote/docs', sshRemote);
		expect(remoteFsState.readDirRemote).toHaveBeenCalledWith('/remote/docs/folder', sshRemote);

		const read = await invoke<{ success: true; content: string }>(
			'autorun:readDoc',
			'/remote/docs',
			'folder/Beta',
			'remote-1'
		);
		expect(read).toEqual({ success: true, content: '# Remote beta' });
		expect(remoteFsState.readFileRemote).toHaveBeenCalledWith(
			'/remote/docs/folder/Beta.md',
			sshRemote
		);

		const writeResult = await invoke<Record<string, unknown>>(
			'autorun:writeDoc',
			'/remote/docs',
			'nested/New Task',
			'# New remote task',
			'remote-1'
		);
		expect(writeResult).toEqual({ success: true });
		expect(remoteFsState.existsRemote).toHaveBeenCalledWith('/remote/docs/nested', sshRemote);
		expect(remoteFsState.mkdirRemote).toHaveBeenCalledWith('/remote/docs/nested', sshRemote, true);
		expect(remoteFsState.writeFileRemote).toHaveBeenCalledWith(
			'/remote/docs/nested/New Task.md',
			'# New remote task',
			sshRemote
		);

		remoteFsState.sshRemotes = [];
		const missingRemote = await invoke<Record<string, unknown>>(
			'autorun:listDocs',
			'/remote/docs',
			'remote-1'
		);
		expect(missingRemote).toMatchObject({
			success: false,
			error: expect.stringContaining('SSH remote not found'),
		});
	});

	it('rejects remote operations when settings store is unavailable', async () => {
		ipcState.handlers.clear();
		registerAutorunHandlers({
			mainWindow: null as any,
			getMainWindow: () => null as any,
			app: {
				on: vi.fn((event: string, handler: () => void) => {
					appHandlers.set(event, handler);
					return {} as any;
				}),
			} as any,
		});

		await expectFailure('autorun:listDocs', ['/remote/docs', 'remote-1'], 'SSH remote not found');
		expect(remoteFsState.readDirRemote).not.toHaveBeenCalled();
	});

	it('rejects missing remote configuration before invoking SSH helpers', async () => {
		remoteFsState.sshRemotes = [];
		await expectFailure(
			'autorun:readDoc',
			['/remote/docs', 'alpha', 'remote-1'],
			'SSH remote not found'
		);
		await expectFailure(
			'autorun:writeDoc',
			['/remote/docs', 'alpha', '# remote', 'remote-1'],
			'SSH remote not found'
		);
		await expectFailure(
			'autorun:saveImage',
			['/remote/docs', 'alpha', 'aW1hZ2U=', 'png', 'remote-1'],
			'SSH remote not found'
		);
		await expectFailure(
			'autorun:deleteImage',
			['/remote/docs', 'images/alpha.png', 'remote-1'],
			'SSH remote not found'
		);
		await expectFailure(
			'autorun:listImages',
			['/remote/docs', 'alpha', 'remote-1'],
			'SSH remote not found'
		);
		await expectFailure(
			'autorun:watchFolder',
			['/remote/docs', 'remote-1'],
			'SSH remote not found'
		);
		await expectFailure(
			'autorun:createBackup',
			['/remote/docs', 'alpha', 'remote-1'],
			'SSH remote not found'
		);
		await expectFailure(
			'autorun:restoreBackup',
			['/remote/docs', 'alpha', 'remote-1'],
			'SSH remote not found'
		);
		await expectFailure(
			'autorun:createWorkingCopy',
			['/remote/docs', 'alpha', 1, 'remote-1'],
			'SSH remote not found'
		);
		await expectFailure(
			'autorun:deleteBackups',
			['/remote/docs', 'remote-1'],
			'SSH remote not found'
		);
		expect(remoteFsState.readDirRemote).not.toHaveBeenCalled();
		expect(remoteFsState.readFileRemote).not.toHaveBeenCalled();
		expect(remoteFsState.writeFileRemote).not.toHaveBeenCalled();
		expect(remoteFsState.existsRemote).not.toHaveBeenCalled();
		expect(remoteFsState.mkdirRemote).not.toHaveBeenCalled();
		expect(remoteFsState.deleteRemote).not.toHaveBeenCalled();
	});

	it('surfaces SSH helper failures and fallback messages', async () => {
		remoteFsState.sshRemotes = [sshRemote];
		remoteFsState.readDirRemote.mockResolvedValueOnce({ success: false, error: 'offline' });
		await expect(
			invoke<Record<string, unknown>>('autorun:listDocs', '/remote/docs', 'remote-1')
		).resolves.toEqual({ success: true, files: [], tree: [] });

		remoteFsState.readFileRemote.mockResolvedValueOnce({ success: false, error: 'read failed' });
		await expectFailure('autorun:readDoc', ['/remote/docs', 'alpha', 'remote-1'], 'read failed');

		remoteFsState.existsRemote.mockResolvedValueOnce({ success: true, data: false });
		remoteFsState.mkdirRemote.mockResolvedValueOnce({ success: false, error: 'mkdir failed' });
		await expectFailure(
			'autorun:writeDoc',
			['/remote/docs', 'nested/alpha', '# remote', 'remote-1'],
			'mkdir failed'
		);

		remoteFsState.existsRemote.mockResolvedValueOnce({ success: true, data: true });
		remoteFsState.writeFileRemote.mockResolvedValueOnce({ success: false, error: 'write failed' });
		await expectFailure(
			'autorun:writeDoc',
			['/remote/docs', 'nested/alpha', '# remote', 'remote-1'],
			'write failed'
		);

		remoteFsState.existsRemote.mockResolvedValueOnce({ success: true, data: false });
		remoteFsState.mkdirRemote.mockResolvedValueOnce({
			success: false,
			error: 'image mkdir failed',
		});
		await expectFailure(
			'autorun:saveImage',
			['/remote/docs', 'alpha', 'aW1hZ2U=', 'png', 'remote-1'],
			'image mkdir failed'
		);

		remoteFsState.existsRemote.mockResolvedValueOnce({ success: true, data: true });
		remoteFsState.writeFileRemote.mockResolvedValueOnce({
			success: false,
			error: 'image write failed',
		});
		await expectFailure(
			'autorun:saveImage',
			['/remote/docs', 'alpha', 'aW1hZ2U=', 'png', 'remote-1'],
			'image write failed'
		);

		remoteFsState.deleteRemote.mockResolvedValueOnce({ success: false, error: 'delete failed' });
		await expectFailure(
			'autorun:deleteImage',
			['/remote/docs', 'images/alpha.png', 'remote-1'],
			'delete failed'
		);

		remoteFsState.existsRemote.mockResolvedValueOnce({ success: true, data: false });
		await expect(
			invoke<Record<string, unknown>>('autorun:listImages', '/remote/docs', 'alpha', 'remote-1')
		).resolves.toEqual({ success: true, images: [] });

		remoteFsState.existsRemote.mockResolvedValueOnce({ success: true, data: true });
		remoteFsState.readDirRemote.mockResolvedValueOnce({
			success: false,
			error: 'image list failed',
		});
		await expectFailure(
			'autorun:listImages',
			['/remote/docs', 'alpha', 'remote-1'],
			'image list failed'
		);

		remoteFsState.existsRemote.mockResolvedValueOnce({ success: true, data: false });
		remoteFsState.mkdirRemote.mockResolvedValueOnce({
			success: false,
			error: 'watch mkdir failed',
		});
		await expectFailure('autorun:watchFolder', ['/remote/docs', 'remote-1'], 'watch mkdir failed');

		remoteFsState.readFileRemote.mockResolvedValueOnce({
			success: false,
			error: 'backup read failed',
		});
		await expectFailure(
			'autorun:createBackup',
			['/remote/docs', 'alpha', 'remote-1'],
			'backup read failed'
		);

		remoteFsState.readFileRemote.mockResolvedValueOnce({ success: true, data: '# alpha' });
		remoteFsState.writeFileRemote.mockResolvedValueOnce({
			success: false,
			error: 'backup write failed',
		});
		await expectFailure(
			'autorun:createBackup',
			['/remote/docs', 'alpha', 'remote-1'],
			'backup write failed'
		);

		remoteFsState.readFileRemote.mockResolvedValueOnce({ success: false, error: 'no backup' });
		await expectFailure(
			'autorun:restoreBackup',
			['/remote/docs', 'alpha', 'remote-1'],
			'Backup file not found'
		);

		remoteFsState.readFileRemote.mockResolvedValueOnce({ success: true, data: '# backup' });
		remoteFsState.writeFileRemote.mockResolvedValueOnce({
			success: false,
			error: 'restore write failed',
		});
		await expectFailure(
			'autorun:restoreBackup',
			['/remote/docs', 'alpha', 'remote-1'],
			'restore write failed'
		);

		remoteFsState.readFileRemote.mockResolvedValueOnce({ success: true, data: '# backup' });
		remoteFsState.writeFileRemote.mockResolvedValueOnce({ success: true });
		remoteFsState.deleteRemote.mockResolvedValueOnce({ success: false, error: 'cleanup denied' });
		await expect(
			invoke<Record<string, unknown>>('autorun:restoreBackup', '/remote/docs', 'alpha', 'remote-1')
		).resolves.toEqual({ success: true });

		remoteFsState.readFileRemote.mockResolvedValueOnce({
			success: false,
			error: 'working read failed',
		});
		await expectFailure(
			'autorun:createWorkingCopy',
			['/remote/docs', 'alpha', 1, 'remote-1'],
			'working read failed'
		);

		remoteFsState.readFileRemote.mockResolvedValueOnce({ success: true, data: '# alpha' });
		remoteFsState.mkdirRemote.mockResolvedValueOnce({ success: false, error: 'runs mkdir failed' });
		await expectFailure(
			'autorun:createWorkingCopy',
			['/remote/docs', 'alpha', 1, 'remote-1'],
			'runs mkdir failed'
		);

		remoteFsState.readFileRemote.mockResolvedValueOnce({ success: true, data: '# alpha' });
		remoteFsState.mkdirRemote.mockResolvedValueOnce({ success: true });
		remoteFsState.writeFileRemote.mockResolvedValueOnce({
			success: false,
			error: 'working write failed',
		});
		await expectFailure(
			'autorun:createWorkingCopy',
			['/remote/docs', 'alpha', 1, 'remote-1'],
			'working write failed'
		);

		remoteFsState.readFileRemote.mockResolvedValueOnce({ success: false });
		await expectFailure(
			'autorun:readDoc',
			['/remote/docs', 'alpha', 'remote-1'],
			'Failed to read remote file'
		);

		remoteFsState.existsRemote.mockResolvedValueOnce({ success: true, data: false });
		remoteFsState.mkdirRemote.mockResolvedValueOnce({ success: false });
		await expectFailure(
			'autorun:writeDoc',
			['/remote/docs', 'fallback/alpha', '# remote', 'remote-1'],
			'Failed to create remote parent directory'
		);

		remoteFsState.existsRemote.mockResolvedValueOnce({ success: true, data: true });
		remoteFsState.writeFileRemote.mockResolvedValueOnce({ success: false });
		await expectFailure(
			'autorun:writeDoc',
			['/remote/docs', 'fallback/alpha', '# remote', 'remote-1'],
			'Failed to write remote file'
		);

		remoteFsState.existsRemote.mockResolvedValueOnce({ success: true, data: false });
		remoteFsState.mkdirRemote.mockResolvedValueOnce({ success: false });
		await expectFailure(
			'autorun:saveImage',
			['/remote/docs', 'alpha', 'aW1hZ2U=', 'png', 'remote-1'],
			'Failed to create remote images directory'
		);

		remoteFsState.existsRemote.mockResolvedValueOnce({ success: true, data: true });
		remoteFsState.writeFileRemote.mockResolvedValueOnce({ success: false });
		await expectFailure(
			'autorun:saveImage',
			['/remote/docs', 'alpha', 'aW1hZ2U=', 'png', 'remote-1'],
			'Failed to write remote image file'
		);

		remoteFsState.deleteRemote.mockResolvedValueOnce({ success: false });
		await expectFailure(
			'autorun:deleteImage',
			['/remote/docs', 'images/alpha.png', 'remote-1'],
			'Failed to delete remote image file'
		);

		remoteFsState.existsRemote.mockResolvedValueOnce({ success: true, data: true });
		remoteFsState.readDirRemote.mockResolvedValueOnce({ success: false });
		await expectFailure(
			'autorun:listImages',
			['/remote/docs', 'alpha', 'remote-1'],
			'Failed to read remote images directory'
		);

		remoteFsState.existsRemote.mockResolvedValueOnce({ success: true, data: false });
		remoteFsState.mkdirRemote.mockResolvedValueOnce({ success: false });
		await expectFailure(
			'autorun:watchFolder',
			['/remote/docs', 'remote-1'],
			'Failed to create remote Auto Run folder'
		);

		remoteFsState.readFileRemote.mockResolvedValueOnce({ success: false });
		await expectFailure(
			'autorun:createBackup',
			['/remote/docs', 'alpha', 'remote-1'],
			'Source file not found'
		);

		remoteFsState.readFileRemote.mockResolvedValueOnce({ success: true, data: '# alpha' });
		remoteFsState.writeFileRemote.mockResolvedValueOnce({ success: false });
		await expectFailure(
			'autorun:createBackup',
			['/remote/docs', 'alpha', 'remote-1'],
			'Failed to write backup file'
		);

		remoteFsState.readFileRemote.mockResolvedValueOnce({ success: true, data: '# backup' });
		remoteFsState.writeFileRemote.mockResolvedValueOnce({ success: false });
		await expectFailure(
			'autorun:restoreBackup',
			['/remote/docs', 'alpha', 'remote-1'],
			'Failed to restore backup'
		);

		remoteFsState.readFileRemote.mockResolvedValueOnce({ success: false });
		await expectFailure(
			'autorun:createWorkingCopy',
			['/remote/docs', 'alpha', 1, 'remote-1'],
			'Source file not found'
		);

		remoteFsState.readFileRemote.mockResolvedValueOnce({ success: true, data: '# alpha' });
		remoteFsState.mkdirRemote.mockResolvedValueOnce({ success: false });
		await expectFailure(
			'autorun:createWorkingCopy',
			['/remote/docs', 'alpha', 1, 'remote-1'],
			'Failed to create Runs directory'
		);

		remoteFsState.readFileRemote.mockResolvedValueOnce({ success: true, data: '# alpha' });
		remoteFsState.mkdirRemote.mockResolvedValueOnce({ success: true });
		remoteFsState.writeFileRemote.mockResolvedValueOnce({ success: false });
		await expectFailure(
			'autorun:createWorkingCopy',
			['/remote/docs', 'alpha', 1, 'remote-1'],
			'Failed to write working copy'
		);

		remoteFsState.readDirRemote.mockResolvedValueOnce({
			success: false,
			error: 'skip missing dir',
		});
		await expect(
			invoke<Record<string, unknown>>('autorun:deleteBackups', '/remote/docs', 'remote-1')
		).resolves.toEqual({ success: true, deletedCount: 0 });
	});

	it('routes remote image save, listing, and delete operations through SSH helpers', async () => {
		dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456);
		remoteFsState.existsRemote
			.mockResolvedValueOnce({ success: true, data: false })
			.mockResolvedValueOnce({ success: true, data: true });
		remoteFsState.mkdirRemote.mockResolvedValue({ success: true });
		remoteFsState.writeFileRemote.mockResolvedValue({ success: true });
		remoteFsState.readDirRemote.mockResolvedValue({
			success: true,
			data: [
				{ name: 'alpha-123456.png', isDirectory: false, isSymlink: false },
				{ name: 'alpha-older.gif', isDirectory: false, isSymlink: false },
				{ name: 'alpha-note.txt', isDirectory: false, isSymlink: false },
				{ name: 'alpha-folder.png', isDirectory: true, isSymlink: false },
				{ name: 'beta-123456.png', isDirectory: false, isSymlink: false },
			],
		});
		remoteFsState.deleteRemote.mockResolvedValue({ success: true });

		const saved = await invoke<{ success: true; relativePath: string }>(
			'autorun:saveImage',
			'/remote/docs',
			'alpha.md',
			Buffer.from('remote-image').toString('base64'),
			'PNG',
			'remote-1'
		);
		expect(saved).toEqual({ success: true, relativePath: 'images/alpha-123456.png' });
		expect(remoteFsState.mkdirRemote).toHaveBeenCalledWith('/remote/docs/images', sshRemote, true);
		expect(remoteFsState.writeFileRemote).toHaveBeenCalledWith(
			'/remote/docs/images/alpha-123456.png',
			Buffer.from('remote-image'),
			sshRemote
		);

		const images = await invoke<{
			success: true;
			images: Array<{ filename: string; relativePath: string }>;
		}>('autorun:listImages', '/remote/docs', 'alpha', 'remote-1');
		expect(images.images).toEqual([
			{ filename: 'alpha-123456.png', relativePath: 'images/alpha-123456.png' },
			{ filename: 'alpha-older.gif', relativePath: 'images/alpha-older.gif' },
		]);

		const deleted = await invoke<Record<string, unknown>>(
			'autorun:deleteImage',
			'/remote/docs',
			'images/alpha-123456.png',
			'remote-1'
		);
		expect(deleted).toEqual({ success: true });
		expect(remoteFsState.deleteRemote).toHaveBeenCalledWith(
			'/remote/docs/images/alpha-123456.png',
			sshRemote,
			false
		);
	});

	it('routes remote watch, backup, restore, working-copy, and cleanup workflows through SSH helpers', async () => {
		dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(777);
		remoteFsState.existsRemote.mockResolvedValue({ success: true, data: false });
		remoteFsState.mkdirRemote.mockResolvedValue({ success: true });
		remoteFsState.readFileRemote.mockResolvedValue({ success: true, data: '# Remote alpha' });
		remoteFsState.writeFileRemote.mockResolvedValue({ success: true });
		remoteFsState.deleteRemote.mockImplementation(async (filePath: string) => ({
			success: !filePath.endsWith('failed.backup.md'),
			error: filePath.endsWith('failed.backup.md') ? 'permission denied' : undefined,
		}));
		remoteFsState.readDirRemote.mockImplementation(async (dirPath: string) => {
			if (dirPath === '/remote/docs') {
				return {
					success: true,
					data: [
						{ name: 'folder', isDirectory: true, isSymlink: false },
						{ name: 'alpha.backup.md', isDirectory: false, isSymlink: false },
						{ name: 'failed.backup.md', isDirectory: false, isSymlink: false },
						{ name: 'alpha.md', isDirectory: false, isSymlink: false },
					],
				};
			}
			if (dirPath === '/remote/docs/folder') {
				return {
					success: true,
					data: [{ name: 'beta.backup.md', isDirectory: false, isSymlink: false }],
				};
			}
			return { success: false, error: `unexpected dir ${dirPath}` };
		});

		const watch = await invoke<Record<string, unknown>>(
			'autorun:watchFolder',
			'/remote/docs',
			'remote-1'
		);
		expect(watch).toEqual({
			success: true,
			isRemote: true,
			message: 'File watching not available for remote sessions. Use polling.',
		});
		expect(chokidarState.watchers).toHaveLength(0);
		expect(remoteFsState.mkdirRemote).toHaveBeenCalledWith('/remote/docs', sshRemote, true);

		const backup = await invoke<{ success: true; backupFilename: string }>(
			'autorun:createBackup',
			'/remote/docs',
			'alpha',
			'remote-1'
		);
		expect(backup).toEqual({ success: true, backupFilename: 'alpha.backup.md' });
		expect(remoteFsState.writeFileRemote).toHaveBeenCalledWith(
			'/remote/docs/alpha.backup.md',
			'# Remote alpha',
			sshRemote
		);

		const restored = await invoke<Record<string, unknown>>(
			'autorun:restoreBackup',
			'/remote/docs',
			'alpha',
			'remote-1'
		);
		expect(restored).toEqual({ success: true });
		expect(remoteFsState.writeFileRemote).toHaveBeenCalledWith(
			'/remote/docs/alpha.md',
			'# Remote alpha',
			sshRemote
		);
		expect(remoteFsState.deleteRemote).toHaveBeenCalledWith(
			'/remote/docs/alpha.backup.md',
			sshRemote,
			false
		);

		const workingCopy = await invoke<{
			success: true;
			workingCopyPath: string;
			originalPath: string;
		}>('autorun:createWorkingCopy', '/remote/docs', 'folder/Beta', 2, 'remote-1');
		expect(workingCopy).toEqual({
			success: true,
			workingCopyPath: 'runs/folder/Beta-777-loop-2',
			originalPath: 'folder/Beta',
		});
		expect(remoteFsState.mkdirRemote).toHaveBeenCalledWith(
			'/remote/docs/runs/folder',
			sshRemote,
			true
		);
		expect(remoteFsState.writeFileRemote).toHaveBeenCalledWith(
			'/remote/docs/runs/folder/Beta-777-loop-2.md',
			'# Remote alpha',
			sshRemote
		);

		const cleanup = await invoke<{ success: true; deletedCount: number }>(
			'autorun:deleteBackups',
			'/remote/docs',
			'remote-1'
		);
		expect(cleanup).toEqual({ success: true, deletedCount: 2 });
		expect(remoteFsState.deleteRemote).toHaveBeenCalledWith(
			'/remote/docs/folder/beta.backup.md',
			sshRemote,
			false
		);
		expect(remoteFsState.deleteRemote).toHaveBeenCalledWith(
			'/remote/docs/failed.backup.md',
			sshRemote,
			false
		);
	});
});
