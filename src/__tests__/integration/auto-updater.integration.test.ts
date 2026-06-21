import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	const eventHandlers = new Map<string, (...args: unknown[]) => void>();
	const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

	const autoUpdater = {
		autoDownload: true,
		autoInstallOnAppQuit: false,
		allowPrerelease: true,
		on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			eventHandlers.set(event, handler);
			return autoUpdater;
		}),
		checkForUpdates: vi.fn(),
		downloadUpdate: vi.fn(),
		quitAndInstall: vi.fn(),
	};

	return {
		autoUpdater,
		eventHandlers,
		ipcHandlers,
		ipcMain: {
			handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
				ipcHandlers.set(channel, handler);
			}),
		},
		isWebContentsAvailable: vi.fn(() => true),
		logger: {
			error: vi.fn(),
			info: vi.fn(),
		},
	};
});

vi.mock('electron', () => ({
	BrowserWindow: vi.fn(),
	ipcMain: mocks.ipcMain,
}));

vi.mock('../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

vi.mock('../../main/utils/safe-send', () => ({
	isWebContentsAvailable: mocks.isWebContentsAvailable,
}));

const updateInfo = {
	files: [{ url: 'Maestro-1.2.3.dmg' }],
	releaseDate: '2026-05-14T00:00:00.000Z',
	version: '1.2.3',
} as any;
const transientGitHubMessage =
	'GitHub is temporarily unavailable. This is usually brief - try again in a moment, or download manually from GitHub.';

async function importAutoUpdaterModule() {
	vi.resetModules();
	const module = await import('../../main/auto-updater');
	module._setAutoUpdaterLoaderForTesting(() => mocks.autoUpdater as any);
	return module;
}

function createWindow() {
	return {
		webContents: {
			send: vi.fn(),
		},
	} as any;
}

function getIpcHandler(channel: string) {
	const handler = mocks.ipcHandlers.get(channel);
	if (!handler) {
		throw new Error(`Missing IPC handler: ${channel}`);
	}
	return handler;
}

describe('auto-updater integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.eventHandlers.clear();
		mocks.ipcHandlers.clear();
		mocks.autoUpdater.autoDownload = true;
		mocks.autoUpdater.autoInstallOnAppQuit = false;
		mocks.autoUpdater.allowPrerelease = true;
		mocks.autoUpdater.checkForUpdates.mockResolvedValue(undefined);
		mocks.autoUpdater.downloadUpdate.mockResolvedValue(undefined);
		mocks.isWebContentsAvailable.mockReturnValue(true);
	});

	it('initializes updater defaults and registers event and IPC handlers once', async () => {
		const { initAutoUpdater } = await importAutoUpdaterModule();
		const window = createWindow();

		initAutoUpdater(window);
		initAutoUpdater(window);

		expect(mocks.autoUpdater.autoDownload).toBe(false);
		expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
		expect(mocks.autoUpdater.allowPrerelease).toBe(false);
		expect(mocks.logger.info).toHaveBeenCalledWith('electron-updater initialized', 'AutoUpdater', {
			allowPrerelease: false,
			autoDownload: false,
			autoInstallOnAppQuit: true,
		});
		expect([...mocks.eventHandlers.keys()]).toEqual([
			'update-available',
			'update-not-available',
			'download-progress',
			'update-downloaded',
			'error',
		]);
		expect([...mocks.ipcHandlers.keys()]).toEqual([
			'updates:checkAutoUpdater',
			'updates:download',
			'updates:install',
			'updates:getStatus',
		]);
		expect(mocks.ipcMain.handle).toHaveBeenCalledTimes(4);
		expect(mocks.autoUpdater.on).toHaveBeenCalledTimes(10);
	});

	it('routes updater event status changes to available renderer web contents', async () => {
		const { initAutoUpdater } = await importAutoUpdaterModule();
		const window = createWindow();
		const progress = { bytesPerSecond: 10, delta: 5, percent: 42, total: 100, transferred: 42 };
		const error = new Error('network unavailable');

		initAutoUpdater(window);

		mocks.eventHandlers.get('update-available')?.(updateInfo);
		expect(window.webContents.send).toHaveBeenLastCalledWith('updates:status', {
			info: updateInfo,
			status: 'available',
		});

		mocks.eventHandlers.get('update-not-available')?.(updateInfo);
		expect(window.webContents.send).toHaveBeenLastCalledWith('updates:status', {
			info: updateInfo,
			status: 'not-available',
		});

		mocks.eventHandlers.get('download-progress')?.(progress);
		expect(window.webContents.send).toHaveBeenLastCalledWith('updates:status', {
			info: updateInfo,
			progress,
			status: 'downloading',
		});

		mocks.eventHandlers.get('update-downloaded')?.(updateInfo);
		expect(window.webContents.send).toHaveBeenLastCalledWith('updates:status', {
			info: updateInfo,
			status: 'downloaded',
		});

		mocks.eventHandlers.get('error')?.(error);
		expect(window.webContents.send).toHaveBeenLastCalledWith('updates:status', {
			error: transientGitHubMessage,
			status: 'error',
		});
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'Auto-update error: network unavailable',
			'AutoUpdater',
			{ stack: error.stack }
		);
	});

	it('does not send renderer status when web contents are unavailable', async () => {
		const { initAutoUpdater } = await importAutoUpdaterModule();
		const window = createWindow();

		initAutoUpdater(window);
		mocks.isWebContentsAvailable.mockReturnValue(false);
		mocks.eventHandlers.get('update-available')?.(updateInfo);

		expect(window.webContents.send).not.toHaveBeenCalled();
	});

	it('handles update-check IPC success, empty results, and errors', async () => {
		const { initAutoUpdater } = await importAutoUpdaterModule();
		const window = createWindow();
		initAutoUpdater(window);
		const checkHandler = getIpcHandler('updates:checkAutoUpdater');

		mocks.autoUpdater.checkForUpdates.mockResolvedValueOnce({ updateInfo });
		await expect(checkHandler()).resolves.toEqual({ success: true, updateInfo });
		expect(window.webContents.send).toHaveBeenCalledWith('updates:status', { status: 'checking' });
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'electron-updater check result: v1.2.3 available',
			'AutoUpdater',
			{ releaseDate: '2026-05-14T00:00:00.000Z', version: '1.2.3' }
		);

		mocks.autoUpdater.checkForUpdates.mockResolvedValueOnce(undefined);
		await expect(checkHandler()).resolves.toEqual({ success: true, updateInfo: undefined });
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'electron-updater check result: no update',
			'AutoUpdater',
			undefined
		);

		const failure = new Error('GitHub unavailable');
		mocks.autoUpdater.checkForUpdates.mockRejectedValueOnce(failure);
		await expect(checkHandler()).resolves.toEqual({ success: false, error: 'GitHub unavailable' });
		expect(window.webContents.send).toHaveBeenLastCalledWith('updates:status', {
			error: 'GitHub unavailable',
			status: 'error',
		});
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'electron-updater check failed: GitHub unavailable',
			'AutoUpdater',
			{ stack: failure.stack }
		);

		mocks.autoUpdater.checkForUpdates.mockRejectedValueOnce('offline');
		await expect(checkHandler()).resolves.toEqual({ success: false, error: 'offline' });
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'electron-updater check failed: offline',
			'AutoUpdater',
			{ stack: undefined }
		);
	});

	it('handles download IPC success, missing updates, and failures', async () => {
		const { initAutoUpdater } = await importAutoUpdaterModule();
		const window = createWindow();
		initAutoUpdater(window);
		const downloadHandler = getIpcHandler('updates:download');

		mocks.autoUpdater.checkForUpdates.mockResolvedValueOnce({ updateInfo });
		await expect(downloadHandler()).resolves.toEqual({ success: true });
		expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
		expect(window.webContents.send).toHaveBeenCalledWith('updates:status', {
			progress: { bytesPerSecond: 0, delta: 0, percent: 0, total: 0, transferred: 0 },
			status: 'downloading',
		});
		expect(mocks.logger.info).toHaveBeenCalledWith('Starting download of v1.2.3', 'AutoUpdater', {
			files: ['Maestro-1.2.3.dmg'],
			releaseDate: '2026-05-14T00:00:00.000Z',
			version: '1.2.3',
		});

		mocks.autoUpdater.checkForUpdates.mockResolvedValueOnce(null);
		await expect(downloadHandler()).resolves.toEqual({
			error: 'No update available to download',
			success: false,
		});
		expect(window.webContents.send).toHaveBeenLastCalledWith('updates:status', {
			error: 'No update available to download',
			status: 'error',
		});

		mocks.autoUpdater.checkForUpdates.mockResolvedValueOnce({});
		await expect(downloadHandler()).resolves.toEqual({
			error: 'No update available to download',
			success: false,
		});

		const failure = new Error('disk full');
		mocks.autoUpdater.checkForUpdates.mockResolvedValueOnce({
			updateInfo: { ...updateInfo, files: undefined },
		});
		mocks.autoUpdater.downloadUpdate.mockRejectedValueOnce(failure);
		await expect(downloadHandler()).resolves.toEqual({ error: 'disk full', success: false });
		expect(window.webContents.send).toHaveBeenLastCalledWith('updates:status', {
			error: 'disk full',
			status: 'error',
		});
		expect(mocks.logger.error).toHaveBeenCalledWith('Download failed: disk full', 'AutoUpdater', {
			stack: failure.stack,
		});

		mocks.autoUpdater.checkForUpdates.mockRejectedValueOnce('cancelled');
		await expect(downloadHandler()).resolves.toEqual({ error: 'cancelled', success: false });
		expect(mocks.logger.error).toHaveBeenCalledWith('Download failed: cancelled', 'AutoUpdater', {
			stack: undefined,
		});
	});

	it('installs downloaded updates and returns current status', async () => {
		const { initAutoUpdater } = await importAutoUpdaterModule();
		initAutoUpdater(createWindow());

		mocks.eventHandlers.get('update-downloaded')?.(updateInfo);

		expect(getIpcHandler('updates:getStatus')()).toEqual({
			info: updateInfo,
			status: 'downloaded',
		});
		expect(getIpcHandler('updates:install')()).toBeUndefined();
		expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
	});

	it('supports manual checks and prerelease toggling', async () => {
		const { checkForUpdatesManual, setAllowPrerelease } = await importAutoUpdaterModule();

		mocks.autoUpdater.checkForUpdates.mockResolvedValueOnce({ updateInfo });
		await expect(checkForUpdatesManual()).resolves.toBe(updateInfo);
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'Manual check found update: v1.2.3',
			'AutoUpdater'
		);

		mocks.autoUpdater.checkForUpdates.mockResolvedValueOnce({});
		await expect(checkForUpdatesManual()).resolves.toBeNull();
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'Manual check: no update available',
			'AutoUpdater'
		);

		mocks.autoUpdater.checkForUpdates.mockRejectedValueOnce('boom');
		await expect(checkForUpdatesManual()).resolves.toBeNull();
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'Manual update check failed: Unknown error',
			'AutoUpdater',
			{ stack: undefined }
		);

		const failure = new Error('manual failed');
		mocks.autoUpdater.checkForUpdates.mockRejectedValueOnce(failure);
		await expect(checkForUpdatesManual()).resolves.toBeNull();
		expect(mocks.logger.error).toHaveBeenCalledWith(
			'Manual update check failed: manual failed',
			'AutoUpdater',
			{ stack: failure.stack }
		);

		setAllowPrerelease(true);
		expect(mocks.autoUpdater.allowPrerelease).toBe(true);
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'Auto-updater prerelease mode: enabled',
			'AutoUpdater'
		);

		setAllowPrerelease(false);
		expect(mocks.autoUpdater.allowPrerelease).toBe(false);
		expect(mocks.logger.info).toHaveBeenCalledWith(
			'Auto-updater prerelease mode: disabled',
			'AutoUpdater'
		);
	});

	it('loads electron-updater through the default lazy loader', async () => {
		const nodeModule = await import('node:module');
		const moduleLoader = nodeModule.default as any;
		const originalLoad = moduleLoader._load;
		moduleLoader._load = vi.fn(function (
			this: unknown,
			request: string,
			parent: unknown,
			isMain: boolean
		) {
			if (request === 'electron-updater') {
				return { autoUpdater: mocks.autoUpdater };
			}
			return originalLoad.call(this, request, parent, isMain);
		});

		try {
			vi.resetModules();
			mocks.autoUpdater.checkForUpdates.mockResolvedValueOnce({ updateInfo });
			const { checkForUpdatesManual } = await import('../../main/auto-updater');

			await expect(checkForUpdatesManual()).resolves.toBe(updateInfo);
		} finally {
			moduleLoader._load = originalLoad;
		}
	});
});
