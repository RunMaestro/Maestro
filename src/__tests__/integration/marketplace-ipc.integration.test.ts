import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceManifest } from '../../shared/marketplace-types';
import type { SshRemoteConfig } from '../../shared/types';

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const handlers = new Map<string, IpcHandler>();

let tempRoot: string;
let userDataDir: string;
let autoRunDir: string;
let localPlaybookDir: string;
let appHandlers: Map<string, () => void>;
let fetchMock: ReturnType<typeof vi.fn>;
let webContentsSend: ReturnType<typeof vi.fn>;
let mkdirRemote: ReturnType<typeof vi.fn>;
let writeFileRemote: ReturnType<typeof vi.fn>;

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
	const handler = handlers.get(channel);
	expect(handler, `Expected ${channel} to be registered`).toBeDefined();
	return (await handler!({}, ...args)) as T;
}

async function writeJson(filePath: string, value: unknown) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function okJson(data: unknown) {
	return {
		ok: true,
		status: 200,
		statusText: 'OK',
		json: vi.fn().mockResolvedValue(data),
		text: vi.fn().mockResolvedValue(JSON.stringify(data)),
		arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(data)).buffer),
	};
}

function okText(text: string) {
	return {
		ok: true,
		status: 200,
		statusText: 'OK',
		json: vi.fn().mockRejectedValue(new Error('not json')),
		text: vi.fn().mockResolvedValue(text),
		arrayBuffer: vi.fn().mockResolvedValue(Buffer.from(text).buffer),
	};
}

function notFound() {
	return {
		ok: false,
		status: 404,
		statusText: 'Not Found',
		json: vi.fn(),
		text: vi.fn(),
		arrayBuffer: vi.fn(),
	};
}

async function registerMarketplace(settingsStore?: { get: ReturnType<typeof vi.fn> }) {
	const { registerMarketplaceHandlers } = await import('../../main/ipc/handlers/marketplace');
	registerMarketplaceHandlers({
		app: {
			getVersion: vi.fn(() => '0.17.1'),
			getPath: vi.fn((name: string) => {
				expect(name).toBe('userData');
				return userDataDir;
			}),
			on: vi.fn((event: string, handler: () => void) => {
				appHandlers.set(event, handler);
				return {} as never;
			}),
		} as never,
		settingsStore: settingsStore as never,
	});
}

async function writeLocalPlaybookManifest(playbookPath = localPlaybookDir) {
	await fs.mkdir(path.join(playbookPath, 'assets'), { recursive: true });
	await fs.writeFile(path.join(playbookPath, 'Phase-01-Setup.md'), '# Local setup', 'utf-8');
	await fs.writeFile(path.join(playbookPath, 'README.md'), '# Local README', 'utf-8');
	await fs.writeFile(path.join(playbookPath, 'assets', 'diagram.txt'), 'local-asset', 'utf-8');

	const manifest: MarketplaceManifest = {
		lastUpdated: '2026-05-25',
		playbooks: [
			{
				id: 'local-playbook',
				title: 'Local Playbook',
				description: 'Local integration fixture',
				path: playbookPath,
				tags: ['integration'],
				documents: [
					{
						filename: 'Phase-01-Setup',
						title: 'Setup',
						description: 'Run setup',
					},
				],
				assets: ['diagram.txt'],
				prompt: 'Custom prompt',
				loopEnabled: true,
				maxLoops: 2,
			},
		],
	};
	await writeJson(path.join(userDataDir, 'local-manifest.json'), manifest);
	return manifest;
}

describe('marketplace IPC integration', () => {
	beforeEach(async () => {
		vi.resetModules();
		handlers.clear();
		appHandlers = new Map();
		fetchMock = vi.fn();
		webContentsSend = vi.fn();
		mkdirRemote = vi.fn().mockResolvedValue({ success: true });
		writeFileRemote = vi.fn().mockResolvedValue({ success: true });
		vi.stubGlobal('fetch', fetchMock);

		tempRoot = await fs.mkdtemp(path.join(tmpdir(), 'maestro-marketplace-ipc-'));
		userDataDir = path.join(tempRoot, 'user-data');
		autoRunDir = path.join(tempRoot, 'Auto Run Docs');
		localPlaybookDir = path.join(tempRoot, 'local-playbook');
		await fs.mkdir(userDataDir, { recursive: true });
		await fs.mkdir(autoRunDir, { recursive: true });

		vi.doMock('electron', () => ({
			ipcMain: {
				handle: vi.fn((channel: string, handler: IpcHandler) => {
					handlers.set(channel, handler);
				}),
				removeHandler: vi.fn((channel: string) => {
					handlers.delete(channel);
				}),
			},
			BrowserWindow: {
				getAllWindows: vi.fn(() => [
					{
						isDestroyed: () => false,
						webContents: {
							isDestroyed: () => false,
							send: webContentsSend,
						},
					},
				]),
			},
			App: vi.fn(),
		}));
		vi.doMock('../../main/utils/logger', () => ({
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
			},
		}));
		vi.doMock('../../main/utils/remote-fs', () => ({
			mkdirRemote,
			writeFileRemote,
		}));
	});

	afterEach(async () => {
		appHandlers.get('will-quit')?.();
		handlers.clear();
		vi.unstubAllGlobals();
		vi.resetModules();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it('serves a valid cache merged with local manifest overrides', async () => {
		const officialManifest: MarketplaceManifest = {
			lastUpdated: '2026-05-24',
			playbooks: [
				{
					id: 'official',
					title: 'Official Playbook',
					description: 'Official fixture',
					path: 'official/path',
					tags: ['official'],
					documents: [{ filename: 'Phase-01-Official', title: 'Official' }],
				},
				{
					id: 'override-me',
					title: 'Official Version',
					description: 'Will be overridden',
					path: 'official/override',
					tags: ['official'],
					documents: [{ filename: 'Phase-01-Old', title: 'Old' }],
				},
			],
		};
		await writeJson(path.join(userDataDir, 'marketplace-cache.json'), {
			fetchedAt: Date.now() - 60_000,
			manifest: officialManifest,
		});
		await writeJson(path.join(userDataDir, 'local-manifest.json'), {
			lastUpdated: '2026-05-25',
			playbooks: [
				{
					id: 'override-me',
					title: 'Local Override',
					description: 'Local wins',
					path: localPlaybookDir,
					tags: ['local'],
					documents: [{ filename: 'Phase-01-Local', title: 'Local' }],
				},
				{
					id: 'local-only',
					title: 'Local Only',
					description: 'Local fixture',
					path: localPlaybookDir,
					tags: ['local'],
					documents: [{ filename: 'Phase-01-Only', title: 'Only' }],
				},
			],
		});
		await registerMarketplace();

		const result = await invoke<{
			success: true;
			manifest: MarketplaceManifest;
			fromCache: boolean;
			cacheAge: number;
		}>('marketplace:getManifest');

		expect(result.success).toBe(true);
		expect(result.fromCache).toBe(true);
		expect(result.cacheAge).toBeGreaterThan(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.manifest.playbooks).toEqual([
			expect.objectContaining({ id: 'official', source: 'official' }),
			expect.objectContaining({ id: 'override-me', title: 'Local Override', source: 'local' }),
			expect.objectContaining({ id: 'local-only', source: 'local' }),
		]);
	});

	it('broadcasts local manifest watcher changes and cleans up watcher errors', async () => {
		vi.useFakeTimers();
		let watchCallback: ((eventType: string) => void) | undefined;
		let watcherError: ((error: Error) => void) | undefined;
		const watcher = {
			close: vi.fn(),
			on: vi.fn((event: string, handler: (error: Error) => void) => {
				if (event === 'error') watcherError = handler;
			}),
		};
		const watchSpy = vi.spyOn(fsSync, 'watch').mockImplementation(((_file, listener) => {
			watchCallback = listener as (eventType: string) => void;
			return watcher as unknown as fsSync.FSWatcher;
		}) as typeof fsSync.watch);

		try {
			await registerMarketplace();
			await registerMarketplace();
			expect(watcher.close).toHaveBeenCalledTimes(1);

			expect(watchCallback).toBeDefined();
			watchCallback!('change');
			watchCallback!('rename');
			await vi.advanceTimersByTimeAsync(500);
			expect(webContentsSend).toHaveBeenCalledWith('marketplace:manifestChanged');

			const { BrowserWindow } = await import('electron');
			const destroyedWindowSend = vi.fn();
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValueOnce([
				{
					isDestroyed: () => true,
					webContents: {
						isDestroyed: () => false,
						send: destroyedWindowSend,
					},
				},
			] as never);
			watchCallback!('change');
			await vi.advanceTimersByTimeAsync(500);
			expect(destroyedWindowSend).not.toHaveBeenCalled();

			expect(watcherError).toBeDefined();
			expect(() => watcherError!(new Error('watch failed'))).not.toThrow();

			watcher.close.mockImplementationOnce(() => {
				throw new Error('close failed');
			});
			expect(() => appHandlers.get('will-quit')?.()).not.toThrow();
		} finally {
			watchSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it('continues when the local manifest watcher cannot be created', async () => {
		const watchSpy = vi.spyOn(fsSync, 'watch').mockImplementation(() => {
			throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
		});

		try {
			await registerMarketplace();
			expect(handlers.has('marketplace:getManifest')).toBe(true);
		} finally {
			watchSpy.mockRestore();
		}
	});

	it('handles cache, fetch, and local-manifest fallback states', async () => {
		fetchMock.mockRejectedValueOnce(new Error('offline'));
		await registerMarketplace();

		const emptyResult = await invoke<{
			success: true;
			manifest: MarketplaceManifest;
			fromCache: boolean;
		}>('marketplace:getManifest');
		expect(emptyResult).toMatchObject({
			success: true,
			fromCache: false,
			manifest: { playbooks: [] },
		});

		await fs.rm(path.join(userDataDir, 'marketplace-cache.json'), { force: true });
		await fs.writeFile(path.join(userDataDir, 'marketplace-cache.json'), '{not json', 'utf-8');
		fetchMock.mockResolvedValueOnce(okJson({ invalid: true }));
		const invalidOfficial = await invoke<{ success: true; manifest: MarketplaceManifest }>(
			'marketplace:getManifest'
		);
		expect(invalidOfficial.manifest.playbooks).toEqual([]);

		await writeJson(path.join(userDataDir, 'marketplace-cache.json'), {
			fetchedAt: 'wrong',
			manifest: { playbooks: [] },
		});
		await writeJson(path.join(userDataDir, 'local-manifest.json'), { playbooks: 'wrong' });
		fetchMock.mockResolvedValueOnce(
			okJson({
				lastUpdated: '2026-05-25',
				playbooks: [
					{
						id: 'official',
						title: 'Official',
						description: 'Official fixture',
						path: 'official/path',
						tags: [],
						documents: [{ filename: 'Phase-01' }],
					},
				],
			})
		);
		const recovered = await invoke<{ success: true; manifest: MarketplaceManifest }>(
			'marketplace:getManifest'
		);
		expect(recovered.manifest.playbooks).toEqual([
			expect.objectContaining({ id: 'official', source: 'official' }),
		]);

		await writeJson(path.join(userDataDir, 'marketplace-cache.json'), {
			fetchedAt: Date.now() - 7 * 60 * 60 * 1000,
			manifest: {
				lastUpdated: '2026-05-24',
				playbooks: [
					{
						id: 'expired',
						title: 'Expired',
						description: 'Expired fixture',
						path: 'expired/path',
						tags: [],
						documents: [{ filename: 'Phase-Expired' }],
					},
				],
			},
		});
		await fs.writeFile(path.join(userDataDir, 'local-manifest.json'), '{bad json', 'utf-8');
		fetchMock.mockResolvedValueOnce(notFound());
		const fallback = await invoke<{
			success: true;
			manifest: MarketplaceManifest;
			fromCache: boolean;
			cacheAge: number;
		}>('marketplace:getManifest');
		expect(fallback.fromCache).toBe(true);
		expect(fallback.cacheAge).toBeGreaterThan(0);
		expect(fallback.manifest.playbooks).toEqual([
			expect.objectContaining({ id: 'expired', source: 'official' }),
		]);
	});

	it('merges only valid local manifest entries and supports tilde local paths', async () => {
		const tildeRoot = path.join(tempRoot, 'home-playbook');
		await fs.mkdir(tildeRoot, { recursive: true });
		await fs.writeFile(path.join(tildeRoot, 'Phase-01-Tilde.md'), '# Tilde doc', 'utf-8');
		await fs.writeFile(path.join(tildeRoot, 'README.md'), '# Tilde README', 'utf-8');
		const homedirSpy = vi.spyOn(require('os'), 'homedir').mockReturnValue(tempRoot);
		await writeJson(path.join(userDataDir, 'marketplace-cache.json'), {
			fetchedAt: Date.now(),
			manifest: {
				lastUpdated: '2026-05-24',
				playbooks: [
					{
						id: 'official',
						title: 'Official',
						description: 'Official fixture',
						path: 'official/path',
						tags: [],
						documents: [{ filename: 'Phase-01' }],
					},
				],
			},
		});
		await writeJson(path.join(userDataDir, 'local-manifest.json'), {
			lastUpdated: '2026-05-25',
			playbooks: [
				{ title: 'Missing ID', path: localPlaybookDir, documents: [] },
				{ id: 'missing-fields', title: '', path: localPlaybookDir, documents: [] },
				{
					id: 'tilde-local',
					title: 'Tilde Local',
					description: 'Tilde fixture',
					path: '~/home-playbook',
					tags: [],
					documents: [{ filename: 'Phase-01-Tilde' }],
				},
			],
		});

		try {
			await registerMarketplace();
			const manifest = await invoke<{ success: true; manifest: MarketplaceManifest }>(
				'marketplace:getManifest'
			);
			expect(manifest.manifest.playbooks.map((playbook) => playbook.id)).toEqual([
				'official',
				'tilde-local',
			]);

			const document = await invoke<{ success: true; content: string }>(
				'marketplace:getDocument',
				'~/home-playbook',
				'Phase-01-Tilde'
			);
			expect(document.content).toBe('# Tilde doc');
			const readme = await invoke<{ success: true; content: string }>(
				'marketplace:getReadme',
				'~/home-playbook'
			);
			expect(readme.content).toBe('# Tilde README');
		} finally {
			homedirSpy.mockRestore();
		}
	});

	it('covers manifest metadata fallbacks and remaining document/readme edge paths', async () => {
		await writeJson(path.join(userDataDir, 'marketplace-cache.json'), {
			fetchedAt: Date.now(),
			manifest: {
				lastUpdated: '',
				playbooks: [
					{
						id: 'official',
						title: 'Official',
						description: 'Official fixture',
						path: 'official/path',
						tags: [],
						documents: [{ filename: 'Phase-01' }],
					},
				],
			},
		});
		await writeJson(path.join(userDataDir, 'local-manifest.json'), {
			lastUpdated: '',
			playbooks: [
				{
					id: 'local-only',
					title: 'Local Only',
					description: 'Local fixture',
					path: localPlaybookDir,
					tags: [],
					documents: [{ filename: 'Phase-Local' }],
				},
			],
		});
		await registerMarketplace();

		const fallbackDate = await invoke<{ success: true; manifest: MarketplaceManifest }>(
			'marketplace:getManifest'
		);
		expect(fallbackDate.manifest.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);

		await expect(
			invoke<{ success: false; error: string }>(
				'marketplace:getDocument',
				localPlaybookDir,
				path.join(tempRoot, 'outside')
			)
		).resolves.toMatchObject({ success: false, error: expect.stringContaining('traversal') });

		const originalReadFile = fs.readFile;
		const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(((file, ...args) => {
			if (String(file).endsWith('string-error.md')) {
				return Promise.reject('string read failure');
			}
			return originalReadFile(file as never, ...(args as never));
		}) as typeof fs.readFile);
		await expect(
			invoke<{ success: false; error: string }>(
				'marketplace:getDocument',
				localPlaybookDir,
				'string-error'
			)
		).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining('string read failure'),
		});
		readFileSpy.mockRestore();

		fetchMock.mockRejectedValueOnce('document offline string');
		await expect(
			invoke<{ success: false; error: string }>('marketplace:getDocument', 'github/path', 'offline')
		).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining('document offline string'),
		});

		fetchMock.mockResolvedValueOnce(okText('# Remote README'));
		await expect(
			invoke<{ success: true; content: string | null }>('marketplace:getReadme', 'github/path')
		).resolves.toEqual({ success: true, content: '# Remote README' });

		await fs.rm(path.join(userDataDir, 'marketplace-cache.json'), { force: true });
		await fs.rm(path.join(userDataDir, 'local-manifest.json'), { force: true });
		fetchMock.mockRejectedValueOnce('manifest offline string');
		const manifestFailure = await invoke<{ success: true; manifest: MarketplaceManifest }>(
			'marketplace:getManifest'
		);
		expect(manifestFailure.manifest.playbooks).toEqual([]);
	});

	it('imports a freshly fetched official playbook with no assets into the target folder', async () => {
		const manifest: MarketplaceManifest = {
			lastUpdated: '2026-05-25',
			playbooks: [
				{
					id: 'fresh-import',
					title: 'Fresh Import',
					description: 'Fresh fixture',
					path: 'fresh/path',
					tags: [],
					documents: [{ filename: 'Phase-01-Fresh', resetOnCompletion: true }],
				},
			],
		};
		await writeJson(path.join(userDataDir, 'playbooks', 'session-fresh.json'), {
			playbooks: 'wrong',
		});
		fetchMock.mockImplementation(async (url: string) => {
			if (url.endsWith('/manifest.json')) return okJson(manifest);
			if (url.endsWith('/fresh/path/Phase-01-Fresh.md')) return okText('# Fresh doc');
			return notFound();
		});
		await registerMarketplace();

		const importResult = await invoke<{
			success: true;
			importedDocs: string[];
			importedAssets: string[];
			playbook: { documents: Array<{ filename: string; resetOnCompletion?: boolean }> };
		}>('marketplace:importPlaybook', 'fresh-import', 'Fresh Import', autoRunDir, 'session-fresh');

		expect(importResult).toMatchObject({
			success: true,
			importedDocs: ['Phase-01-Fresh'],
			importedAssets: [],
			playbook: {
				documents: [{ filename: 'Fresh Import/Phase-01-Fresh', resetOnCompletion: true }],
			},
		});
	});

	it('continues past invalid and missing local assets', async () => {
		await fs.mkdir(localPlaybookDir, { recursive: true });
		await fs.writeFile(path.join(localPlaybookDir, 'Phase-01-Asset.md'), '# Asset doc', 'utf-8');
		await writeJson(path.join(userDataDir, 'local-manifest.json'), {
			lastUpdated: '2026-05-25',
			playbooks: [
				{
					id: 'bad-assets',
					title: 'Bad Assets',
					description: 'Bad asset fixture',
					path: localPlaybookDir,
					tags: [],
					documents: [{ filename: 'Phase-01-Asset' }],
					assets: ['../blocked.bin', 'missing.bin', 'string-error.bin'],
				},
			],
		});
		const originalReadFile = fs.readFile;
		const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(((file, ...args) => {
			if (String(file).endsWith('string-error.bin')) {
				return Promise.reject('asset string failure');
			}
			return originalReadFile(file as never, ...(args as never));
		}) as typeof fs.readFile);
		fetchMock.mockRejectedValue(new Error('network disabled for local-only import'));
		await registerMarketplace();

		const importResult = await invoke<{
			success: true;
			importedDocs: string[];
			importedAssets: string[];
		}>('marketplace:importPlaybook', 'bad-assets', 'Bad Assets', autoRunDir, 'session-assets');

		expect(importResult).toMatchObject({
			success: true,
			importedDocs: ['Phase-01-Asset'],
			importedAssets: [],
		});
		readFileSpy.mockRestore();
	});

	it('reports document and README fetch failures without crashing the IPC boundary', async () => {
		await registerMarketplace();

		await expect(
			invoke<{ success: false; error: string }>(
				'marketplace:getDocument',
				localPlaybookDir,
				'missing-local'
			)
		).resolves.toMatchObject({ success: false, error: expect.stringContaining('not found') });

		const readFileSpy = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('disk denied'));
		await expect(
			invoke<{ success: false; error: string }>(
				'marketplace:getDocument',
				localPlaybookDir,
				'denied-local'
			)
		).resolves.toMatchObject({ success: false, error: expect.stringContaining('disk denied') });
		readFileSpy.mockRestore();

		await expect(
			invoke<{ success: true; content: string | null }>(
				'marketplace:getReadme',
				path.join(tempRoot, 'no-readme')
			)
		).resolves.toEqual({ success: true, content: null });

		const readmeSpy = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('readme denied'));
		await expect(
			invoke<{ success: false; error: string }>(
				'marketplace:getReadme',
				path.join(tempRoot, 'bad-readme')
			)
		).resolves.toMatchObject({ success: false, error: expect.stringContaining('readme denied') });
		readmeSpy.mockRestore();

		fetchMock.mockResolvedValueOnce(notFound());
		await expect(
			invoke<{ success: false; error: string }>('marketplace:getDocument', 'github/path', 'missing')
		).resolves.toMatchObject({ success: false, error: expect.stringContaining('not found') });

		fetchMock.mockResolvedValueOnce({ ...notFound(), status: 500, statusText: 'Server Error' });
		await expect(
			invoke<{ success: false; error: string }>(
				'marketplace:getDocument',
				'github/path',
				'server-error'
			)
		).resolves.toMatchObject({ success: false, error: expect.stringContaining('500') });

		fetchMock.mockRejectedValueOnce(new Error('network down'));
		await expect(
			invoke<{ success: false; error: string }>('marketplace:getDocument', 'github/path', 'offline')
		).resolves.toMatchObject({ success: false, error: expect.stringContaining('network down') });

		fetchMock.mockResolvedValueOnce(notFound());
		await expect(
			invoke<{ success: true; content: string | null }>('marketplace:getReadme', 'github/path')
		).resolves.toEqual({ success: true, content: null });

		fetchMock.mockResolvedValueOnce({ ...notFound(), status: 500, statusText: 'Server Error' });
		await expect(
			invoke<{ success: false; error: string }>('marketplace:getReadme', 'github/path')
		).resolves.toMatchObject({ success: false, error: expect.stringContaining('500') });

		fetchMock.mockRejectedValueOnce(new Error('readme offline'));
		await expect(
			invoke<{ success: false; error: string }>('marketplace:getReadme', 'github/path')
		).resolves.toMatchObject({ success: false, error: expect.stringContaining('readme offline') });
	});

	it('recovers from cache write failures and refresh fallbacks', async () => {
		const manifest: MarketplaceManifest = {
			lastUpdated: '2026-05-25',
			playbooks: [
				{
					id: 'fresh',
					title: 'Fresh',
					description: 'Fresh fixture',
					path: 'fresh/path',
					tags: [],
					documents: [{ filename: 'Phase-01' }],
				},
			],
		};
		const writeSpy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('cache full'));
		fetchMock.mockResolvedValueOnce(okJson(manifest));
		await registerMarketplace();

		const fetched = await invoke<{ success: true; manifest: MarketplaceManifest }>(
			'marketplace:getManifest'
		);
		expect(fetched.manifest.playbooks).toEqual([
			expect.objectContaining({ id: 'fresh', source: 'official' }),
		]);
		writeSpy.mockRestore();

		await writeJson(path.join(userDataDir, 'marketplace-cache.json'), {
			fetchedAt: Date.now(),
			manifest,
		});
		fetchMock.mockRejectedValueOnce(new Error('refresh offline'));
		const cacheFallback = await invoke<{
			success: true;
			manifest: MarketplaceManifest;
			fromCache: boolean;
		}>('marketplace:refreshManifest');
		expect(cacheFallback.fromCache).toBe(true);
		expect(cacheFallback.manifest.playbooks).toEqual([
			expect.objectContaining({ id: 'fresh', source: 'official' }),
		]);

		await fs.rm(path.join(userDataDir, 'marketplace-cache.json'), { force: true });
		fetchMock.mockRejectedValueOnce(new Error('refresh offline'));
		const localOnly = await invoke<{
			success: true;
			manifest: MarketplaceManifest;
			fromCache: boolean;
		}>('marketplace:refreshManifest');
		expect(localOnly).toMatchObject({
			success: true,
			fromCache: false,
			manifest: { playbooks: [] },
		});
	});

	it('refuses to persist a local playbook when all documents fail to import', async () => {
		await writeLocalPlaybookManifest();
		await fs.unlink(path.join(localPlaybookDir, 'Phase-01-Setup.md'));
		await fs.writeFile(
			path.join(localPlaybookDir, 'assets', 'stat-fails.txt'),
			'bad stat',
			'utf-8'
		);
		await fs.mkdir(path.join(localPlaybookDir, 'assets', 'directory-asset'), { recursive: true });
		await writeJson(path.join(userDataDir, 'playbooks', 'session-local-errors.json'), {
			playbooks: [{ id: 'existing' }],
		});
		const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (entryPath: fsSync.PathLike) => {
			if (String(entryPath).endsWith('stat-fails.txt')) {
				throw new Error('stat failed');
			}
			return {
				isFile: () => !String(entryPath).endsWith('directory-asset'),
			} as never;
		});
		fetchMock.mockRejectedValue(new Error('network disabled for local-only import'));
		await registerMarketplace();

		const importResult = await invoke<{
			success: false;
			error: string;
		}>(
			'marketplace:importPlaybook',
			'local-playbook',
			'Imported Local Errors',
			autoRunDir,
			'session-local-errors'
		);

		expect(importResult).toMatchObject({
			success: false,
			error: expect.stringContaining('Failed to import any documents'),
		});
		const playbooks = JSON.parse(
			await fs.readFile(path.join(userDataDir, 'playbooks', 'session-local-errors.json'), 'utf-8')
		);
		expect(playbooks.playbooks).toEqual([{ id: 'existing' }]);
		statSpy.mockRestore();
	});

	it('treats local asset directory read failures as recoverable', async () => {
		await writeLocalPlaybookManifest();
		await fs.rm(path.join(localPlaybookDir, 'assets'), { recursive: true, force: true });
		await fs.writeFile(path.join(localPlaybookDir, 'assets'), 'not a directory', 'utf-8');
		fetchMock.mockRejectedValue(new Error('network disabled for local-only import'));
		await registerMarketplace();

		const importResult = await invoke<{
			success: true;
			importedDocs: string[];
			importedAssets: string[];
		}>('marketplace:importPlaybook', 'local-playbook', 'Imported Broken Assets', autoRunDir, 's');

		expect(importResult).toMatchObject({
			success: true,
			importedDocs: ['Phase-01-Setup'],
			importedAssets: [],
		});
	});

	it('reports import lookup and remote directory failures', async () => {
		const sshRemote: SshRemoteConfig = {
			id: 'remote-1',
			name: 'Remote 1',
			host: 'remote.test',
			port: 22,
			username: 'tester',
			privateKeyPath: '/tmp/no-key',
			enabled: true,
		};
		await registerMarketplace({
			get: vi.fn((key: string, fallback: unknown) =>
				key === 'sshRemotes' ? [sshRemote] : fallback
			),
		});
		fetchMock.mockRejectedValue(new Error('offline'));
		await expect(
			invoke<{ success: false; error: string }>(
				'marketplace:importPlaybook',
				'missing-playbook',
				'Missing',
				autoRunDir,
				'session-missing'
			)
		).resolves.toMatchObject({ success: false, error: expect.stringContaining('not found') });

		await writeJson(path.join(userDataDir, 'marketplace-cache.json'), {
			fetchedAt: Date.now(),
			manifest: {
				lastUpdated: '2026-05-25',
				playbooks: [
					{
						id: 'remote-playbook',
						title: 'Remote Playbook',
						description: 'Remote fixture',
						path: 'remote/path',
						tags: [],
						documents: [{ filename: 'Phase-01-Remote' }],
					},
				],
			},
		});
		mkdirRemote.mockResolvedValueOnce({ success: false, error: 'mkdir denied' });
		await expect(
			invoke<{ success: false; error: string }>(
				'marketplace:importPlaybook',
				'remote-playbook',
				'Remote Broken',
				'/srv/auto-run/',
				'session-remote-broken',
				'remote-1'
			)
		).resolves.toMatchObject({ success: false, error: expect.stringContaining('mkdir denied') });
	});

	it('reports missing SSH settings instead of falling back to local import', async () => {
		await writeLocalPlaybookManifest();
		fetchMock.mockRejectedValue(new Error('network disabled for local-only import'));
		await registerMarketplace();

		const importResult = await invoke<{ success: false; error: string }>(
			'marketplace:importPlaybook',
			'local-playbook',
			'Imported Without Settings',
			autoRunDir,
			'session-no-settings',
			'missing-remote'
		);

		expect(importResult).toMatchObject({
			success: false,
			error: expect.stringContaining('SSH remote not found or disabled'),
		});
		expect(mkdirRemote).not.toHaveBeenCalled();
	});

	it('keeps remote imports going when individual document and asset writes fail', async () => {
		const manifest: MarketplaceManifest = {
			lastUpdated: '2026-05-25',
			playbooks: [
				{
					id: 'remote-partial',
					title: 'Remote Partial',
					description: 'Remote fixture',
					path: 'remote/partial',
					tags: [],
					documents: [{ filename: 'Phase-01-Remote' }, { filename: 'Phase-02-Remote' }],
					assets: ['bad.bin', 'missing.bin', 'server.bin', 'offline.bin', 'offline-error.bin'],
				},
			],
		};
		await writeJson(path.join(userDataDir, 'marketplace-cache.json'), {
			fetchedAt: Date.now(),
			manifest,
		});
		fetchMock.mockImplementation(async (url: string) => {
			if (url.endsWith('/Phase-01-Remote.md')) return okText('# Remote one');
			if (url.endsWith('/Phase-02-Remote.md')) return okText('# Remote two');
			if (url.endsWith('/bad.bin')) return okText('bad');
			if (url.endsWith('/missing.bin')) return notFound();
			if (url.endsWith('/server.bin'))
				return { ...notFound(), status: 500, statusText: 'Server Error' };
			if (url.endsWith('/offline.bin')) throw 'asset offline string';
			if (url.endsWith('/offline-error.bin')) throw new Error('asset offline error');
			return notFound();
		});
		mkdirRemote
			.mockResolvedValueOnce({ success: true })
			.mockResolvedValueOnce({ success: false, error: 'asset mkdir denied' });
		writeFileRemote
			.mockResolvedValueOnce({ success: false })
			.mockResolvedValueOnce({ success: true })
			.mockResolvedValueOnce({ success: false });
		const sshRemote: SshRemoteConfig = {
			id: 'remote-1',
			name: 'Remote 1',
			host: 'remote.test',
			port: 22,
			username: 'tester',
			privateKeyPath: '/tmp/no-key',
			enabled: true,
		};
		await registerMarketplace({
			get: vi.fn((key: string, fallback: unknown) =>
				key === 'sshRemotes' ? [sshRemote] : fallback
			),
		});

		const importResult = await invoke<{
			success: true;
			importedDocs: string[];
			importedAssets: string[];
		}>(
			'marketplace:importPlaybook',
			'remote-partial',
			'Remote Partial',
			'/srv/auto-run',
			'session-remote-partial',
			'remote-1'
		);

		expect(importResult.importedDocs).toEqual(['Phase-02-Remote']);
		expect(importResult.importedAssets).toEqual([]);
	});

	it('reads local documents, README files, and imports local playbooks into Auto Run storage', async () => {
		await writeLocalPlaybookManifest();
		fetchMock.mockRejectedValue(new Error('network disabled for local-only import'));
		await registerMarketplace();

		const documentResult = await invoke<{ success: true; content: string }>(
			'marketplace:getDocument',
			localPlaybookDir,
			'Phase-01-Setup'
		);
		expect(documentResult).toEqual({ success: true, content: '# Local setup' });

		const readmeResult = await invoke<{ success: true; content: string }>(
			'marketplace:getReadme',
			localPlaybookDir
		);
		expect(readmeResult).toEqual({ success: true, content: '# Local README' });

		const traversal = await invoke<{ success: false; error: string }>(
			'marketplace:getDocument',
			localPlaybookDir,
			'../secret'
		);
		expect(traversal).toMatchObject({
			success: false,
			error: expect.stringContaining('Invalid filename'),
		});

		const importResult = await invoke<{
			success: true;
			importedDocs: string[];
			importedAssets: string[];
			playbook: { name: string; documents: Array<{ filename: string }> };
		}>('marketplace:importPlaybook', 'local-playbook', 'Imported Local', autoRunDir, 'session-1');

		expect(importResult).toMatchObject({
			success: true,
			importedDocs: ['Phase-01-Setup'],
			importedAssets: ['diagram.txt'],
			playbook: {
				name: 'Local Playbook',
				documents: [{ filename: 'Imported Local/Phase-01-Setup' }],
			},
		});
		await expect(
			fs.readFile(path.join(autoRunDir, 'Imported Local', 'Phase-01-Setup.md'), 'utf-8')
		).resolves.toBe('# Local setup');
		await expect(
			fs.readFile(path.join(autoRunDir, 'Imported Local', 'assets', 'diagram.txt'), 'utf-8')
		).resolves.toBe('local-asset');
		const playbooks = JSON.parse(
			await fs.readFile(path.join(userDataDir, 'playbooks', 'session-1.json'), 'utf-8')
		);
		expect(playbooks.playbooks).toEqual([
			expect.objectContaining({
				name: 'Local Playbook',
				loopEnabled: true,
				maxLoops: 2,
				prompt: 'Custom prompt',
			}),
		]);
	});

	it('refreshes from mocked GitHub data and imports remote playbooks through SSH writes', async () => {
		const remoteManifest: MarketplaceManifest = {
			lastUpdated: '2026-05-25',
			playbooks: [
				{
					id: 'remote-playbook',
					title: 'Remote Playbook',
					description: 'GitHub-backed fixture',
					path: 'remote/path',
					tags: ['remote'],
					documents: [{ filename: 'Phase-01-Remote', title: 'Remote' }],
					assets: ['remote.bin'],
					prompt: null,
				},
			],
		};
		fetchMock.mockImplementation(async (url: string) => {
			if (url.endsWith('/manifest.json')) return okJson(remoteManifest);
			if (url.endsWith('/remote/path/Phase-01-Remote.md')) return okText('# Remote doc');
			if (url.endsWith('/remote/path/assets/remote.bin')) return okText('remote-asset');
			return notFound();
		});
		const sshRemote: SshRemoteConfig = {
			id: 'remote-1',
			name: 'Remote 1',
			host: 'remote.test',
			port: 22,
			username: 'tester',
			privateKeyPath: '/tmp/no-key',
			enabled: true,
		};
		await registerMarketplace({
			get: vi.fn((key: string, fallback: unknown) =>
				key === 'sshRemotes' ? [sshRemote] : fallback
			),
		});

		const refresh = await invoke<{
			success: true;
			manifest: MarketplaceManifest;
			fromCache: boolean;
		}>('marketplace:refreshManifest');
		expect(refresh).toMatchObject({
			success: true,
			fromCache: false,
			manifest: { playbooks: [expect.objectContaining({ id: 'remote-playbook' })] },
		});

		const importResult = await invoke<{
			success: true;
			importedDocs: string[];
			importedAssets: string[];
			playbook: { prompt: string };
		}>(
			'marketplace:importPlaybook',
			'remote-playbook',
			'Imported Remote',
			'/srv/app/Auto Run Docs',
			'session-remote',
			'remote-1'
		);

		expect(importResult).toMatchObject({
			success: true,
			importedDocs: ['Phase-01-Remote'],
			importedAssets: ['remote.bin'],
			playbook: { prompt: '' },
		});
		expect(mkdirRemote).toHaveBeenCalledWith(
			'/srv/app/Auto Run Docs/Imported Remote',
			sshRemote,
			true
		);
		expect(mkdirRemote).toHaveBeenCalledWith(
			'/srv/app/Auto Run Docs/Imported Remote/assets',
			sshRemote,
			true
		);
		expect(writeFileRemote).toHaveBeenCalledWith(
			'/srv/app/Auto Run Docs/Imported Remote/Phase-01-Remote.md',
			'# Remote doc',
			sshRemote
		);
		expect(writeFileRemote).toHaveBeenCalledWith(
			'/srv/app/Auto Run Docs/Imported Remote/assets/remote.bin',
			expect.any(Buffer),
			sshRemote
		);
	});
});
