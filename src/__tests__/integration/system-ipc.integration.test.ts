import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import {
	clipboard,
	dialog,
	ipcMain,
	nativeImage,
	shell,
	type App,
	type BrowserWindow,
} from 'electron';
import * as fsSync from 'fs';

import {
	registerSystemHandlers,
	setupLoggerEventForwarding,
	type SystemHandlerDependencies,
} from '../../main/ipc/handlers/system';
import { setAllowPrerelease } from '../../main/auto-updater';
import { checkForUpdates } from '../../main/update-checker';
import { powerManager } from '../../main/power-manager';
import { tunnelManager } from '../../main/tunnel-manager';
import { isCloudflaredInstalled } from '../../main/utils/cliDetection';
import { execFileNoThrow } from '../../main/utils/execFile';
import { logger } from '../../main/utils/logger';
import { detectShells } from '../../main/utils/shellDetector';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	dialog: {
		showOpenDialog: vi.fn(),
		showSaveDialog: vi.fn(),
	},
	shell: {
		openExternal: vi.fn(),
		openPath: vi.fn(),
		showItemInFolder: vi.fn(),
		trashItem: vi.fn(),
	},
	clipboard: {
		writeImage: vi.fn(),
	},
	nativeImage: {
		createFromDataURL: vi.fn(),
	},
	BrowserWindow: {
		getFocusedWindow: vi.fn(),
	},
	app: {
		getPath: vi.fn(),
		getVersion: vi.fn(),
	},
}));

vi.mock('fs', () => ({
	default: {
		copyFileSync: vi.fn(),
		existsSync: vi.fn(),
		mkdirSync: vi.fn(),
		readFileSync: vi.fn(),
	},
	copyFileSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
}));

vi.mock('../../main/auto-updater', () => ({
	setAllowPrerelease: vi.fn(),
}));

vi.mock('../../main/power-manager', () => ({
	powerManager: {
		addBlockReason: vi.fn(),
		getStatus: vi.fn(),
		isEnabled: vi.fn(),
		removeBlockReason: vi.fn(),
		setEnabled: vi.fn(),
	},
}));

vi.mock('../../main/tunnel-manager', () => ({
	tunnelManager: {
		getStatus: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
	},
}));

vi.mock('../../main/update-checker', () => ({
	checkForUpdates: vi.fn(),
}));

vi.mock('../../main/utils/cliDetection', () => ({
	isCloudflaredInstalled: vi.fn(),
}));

vi.mock('../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		autorun: vi.fn(),
		clearLogs: vi.fn(),
		debug: vi.fn(),
		enableFileLogging: vi.fn(),
		error: vi.fn(),
		getLogFilePath: vi.fn(),
		getLogLevel: vi.fn(),
		getLogs: vi.fn(),
		getMaxLogBuffer: vi.fn(),
		info: vi.fn(),
		isFileLoggingEnabled: vi.fn(),
		on: vi.fn(),
		setLogLevel: vi.fn(),
		setMaxLogBuffer: vi.fn(),
		toast: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('../../main/utils/shellDetector', () => ({
	detectShells: vi.fn(),
}));

type Handler = (event?: unknown, ...args: any[]) => Promise<any>;

const handlers = new Map<string, Handler>();

let mainWindow: {
	isDestroyed: ReturnType<typeof vi.fn>;
	webContents: {
		closeDevTools: ReturnType<typeof vi.fn>;
		isDestroyed: ReturnType<typeof vi.fn>;
		isDevToolsOpened: ReturnType<typeof vi.fn>;
		openDevTools: ReturnType<typeof vi.fn>;
		send: ReturnType<typeof vi.fn>;
	};
};
let appMock: { getPath: ReturnType<typeof vi.fn>; getVersion: ReturnType<typeof vi.fn> };
let settingsStore: {
	get: ReturnType<typeof vi.fn>;
	set: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
};
let bootstrapStore: {
	get: ReturnType<typeof vi.fn>;
	set: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
};
let webServer: { getSecureUrl: ReturnType<typeof vi.fn> };
let deps: SystemHandlerDependencies;

function invoke<T = unknown>(channel: string, ...args: any[]): Promise<T> {
	const handler = handlers.get(channel);
	expect(handler, `Expected ${channel} to be registered`).toBeDefined();
	return handler!({}, ...args) as Promise<T>;
}

function register(overrides: Partial<SystemHandlerDependencies> = {}) {
	handlers.clear();
	deps = {
		app: appMock as unknown as App,
		bootstrapStore: bootstrapStore as never,
		getMainWindow: () => mainWindow as unknown as BrowserWindow,
		getWebServer: () => webServer as never,
		settingsStore: settingsStore as never,
		tunnelManager,
		...overrides,
	};
	registerSystemHandlers(deps);
}

describe('system IPC integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		handlers.clear();

		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as Handler);
		});

		mainWindow = {
			isDestroyed: vi.fn().mockReturnValue(false),
			webContents: {
				closeDevTools: vi.fn(),
				isDestroyed: vi.fn().mockReturnValue(false),
				isDevToolsOpened: vi.fn().mockReturnValue(false),
				openDevTools: vi.fn(),
				send: vi.fn(),
			},
		};
		appMock = {
			getPath: vi.fn().mockReturnValue('/default/user-data'),
			getVersion: vi.fn().mockReturnValue('2.0.0'),
		};
		settingsStore = {
			delete: vi.fn(),
			get: vi.fn(),
			set: vi.fn(),
		};
		bootstrapStore = {
			delete: vi.fn(),
			get: vi.fn(),
			set: vi.fn(),
		};
		webServer = {
			getSecureUrl: vi.fn().mockReturnValue('http://localhost:3000/token-path'),
		};
		vi.mocked(fsSync.existsSync).mockReturnValue(true);
		vi.mocked(fsSync.readFileSync).mockReturnValue('source-content');
		vi.mocked(shell.openPath).mockResolvedValue('');
		register();
	});

	it('registers every system handler and restores saved power preference', () => {
		expect(handlers.size).toBe(39);
		expect(handlers.has('dialog:selectFolder')).toBe(true);
		expect(handlers.has('sync:setCustomPath')).toBe(true);
		expect(handlers.has('power:removeReason')).toBe(true);

		settingsStore.get.mockReturnValueOnce(true);
		register();
		expect(powerManager.setEnabled).toHaveBeenCalledWith(true);
		expect(logger.info).toHaveBeenCalledWith(
			'Sleep prevention restored from settings',
			'PowerManager'
		);
	});

	it('handles dialog, font, shell detection, and update boundaries', async () => {
		vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
			canceled: false,
			filePaths: ['/workspace'],
		});
		await expect(invoke('dialog:selectFolder')).resolves.toBe('/workspace');
		vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
			canceled: true,
			filePaths: [],
		});
		await expect(invoke('dialog:selectFolder')).resolves.toBeNull();

		vi.mocked(dialog.showOpenDialog).mockRejectedValueOnce(new Error('closed'));
		await expect(invoke('dialog:selectFolder')).resolves.toBeNull();
		expect(logger.error).toHaveBeenCalledWith('dialog:selectFolder failed', 'Dialog', {
			error: expect.any(Error),
		});

		vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
			canceled: false,
			filePath: '/tmp/export.csv',
		});
		await expect(
			invoke('dialog:saveFile', {
				defaultPath: 'export.csv',
				filters: [{ name: 'CSV', extensions: ['csv'] }],
			})
		).resolves.toBe('/tmp/export.csv');
		vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
			canceled: true,
			filePath: undefined,
		});
		await expect(invoke('dialog:saveFile', {})).resolves.toBeNull();

		register({ getMainWindow: () => null });
		await expect(invoke('dialog:selectFolder')).resolves.toBeNull();
		await expect(invoke('dialog:saveFile', {})).resolves.toBeNull();
		register();

		vi.mocked(execFileNoThrow).mockResolvedValueOnce({
			exitCode: 0,
			stderr: '',
			stdout: 'Arial\nArial\nMonaco\n',
		});
		await expect(invoke('fonts:detect')).resolves.toEqual(['Arial', 'Monaco']);
		vi.mocked(execFileNoThrow).mockResolvedValueOnce({
			exitCode: 1,
			stderr: 'missing',
			stdout: '',
		});
		await expect(invoke<string[]>('fonts:detect')).resolves.toContain('JetBrains Mono');
		vi.mocked(execFileNoThrow).mockRejectedValueOnce(new Error('spawn failed'));
		const consoleError = vi.spyOn(globalThis.console, 'error').mockImplementation(() => {});
		await expect(invoke<string[]>('fonts:detect')).resolves.toContain('Monaco');
		consoleError.mockRestore();

		vi.mocked(detectShells).mockResolvedValueOnce([
			{ id: 'zsh', name: 'Zsh', available: true, path: '/bin/zsh' },
			{ id: 'fish', name: 'Fish', available: false },
		]);
		await expect(invoke('shells:detect')).resolves.toEqual([
			{ id: 'zsh', name: 'Zsh', available: true, path: '/bin/zsh' },
			{ id: 'fish', name: 'Fish', available: false },
		]);
		vi.mocked(detectShells).mockRejectedValueOnce(new Error('detect failed'));
		await expect(invoke<any[]>('shells:detect')).resolves.toEqual(
			expect.arrayContaining([expect.objectContaining({ id: 'bash', available: false })])
		);

		vi.mocked(checkForUpdates).mockResolvedValueOnce({ updateAvailable: false });
		await expect(invoke('updates:check', true)).resolves.toEqual({ updateAvailable: false });
		expect(checkForUpdates).toHaveBeenCalledWith('2.0.0', true);
		await invoke('updates:setAllowPrerelease', true);
		expect(setAllowPrerelease).toHaveBeenCalledWith(true);
	});

	it('validates shell, clipboard, tunnel, and devtools handler flows', async () => {
		await invoke('shell:openExternal', 'https://example.com');
		await invoke('shell:openExternal', 'mailto:test@example.com');
		expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
		expect(shell.openExternal).toHaveBeenCalledWith('mailto:test@example.com');

		await invoke('shell:openExternal', 'file:///Users/test/doc.pdf');
		await invoke('shell:openExternal', '/Users/test/doc.pdf');
		expect(shell.openPath).toHaveBeenCalledWith('/Users/test/doc.pdf');
		expect(shell.openPath).toHaveBeenCalledWith('/Users/test/doc.pdf');
		vi.mocked(shell.openPath).mockResolvedValueOnce('Cannot open');
		await expect(invoke('shell:openExternal', '/Users/test/bad.xyz')).rejects.toThrow(
			'Cannot open'
		);
		vi.mocked(fsSync.existsSync).mockReturnValueOnce(false);
		await expect(invoke('shell:openExternal', 'file:///Users/test/missing.pdf')).rejects.toThrow(
			'Path does not exist'
		);
		vi.mocked(shell.openPath).mockResolvedValueOnce('Cannot open file URL');
		await expect(invoke('shell:openExternal', 'file:///Users/test/bad.pdf')).rejects.toThrow(
			'Cannot open file URL'
		);

		await expect(invoke('shell:openExternal', 'javascript:alert(1)')).rejects.toThrow(
			'Protocol not allowed'
		);
		await expect(invoke('shell:openExternal', '')).rejects.toThrow('Invalid URL');
		vi.mocked(fsSync.existsSync).mockReturnValueOnce(false);
		await expect(invoke('shell:openExternal', '/missing')).rejects.toThrow('Path does not exist');
		await expect(invoke('shell:openExternal', 'LICENSE')).resolves.toBeUndefined();

		vi.mocked(shell.openExternal).mockRejectedValueOnce(new Error('No application available'));
		await expect(
			invoke('shell:openExternal', 'https://example.com/missing')
		).resolves.toBeUndefined();
		vi.mocked(shell.openExternal).mockRejectedValueOnce(new Error('boom'));
		await expect(invoke('shell:openExternal', 'https://example.com/boom')).rejects.toThrow('boom');

		await invoke('shell:trashItem', '/tmp/file.txt');
		expect(shell.trashItem).toHaveBeenCalledWith(path.resolve('/tmp/file.txt'));
		vi.mocked(shell.trashItem).mockRejectedValueOnce('cancelled by user');
		await expect(invoke('shell:trashItem', '/tmp/file.txt')).resolves.toBeUndefined();
		vi.mocked(shell.trashItem).mockRejectedValueOnce(new Error('denied'));
		await expect(invoke('shell:trashItem', '/tmp/file.txt')).rejects.toThrow('denied');
		await expect(invoke('shell:trashItem', '')).rejects.toThrow('Invalid path');
		vi.mocked(fsSync.existsSync).mockReturnValueOnce(false);
		await expect(invoke('shell:trashItem', '/missing')).resolves.toBeUndefined();

		await invoke('shell:showItemInFolder', '/tmp/file.txt');
		expect(shell.showItemInFolder).toHaveBeenCalledWith(path.resolve('/tmp/file.txt'));
		await expect(invoke('shell:showItemInFolder', '')).rejects.toThrow('Invalid path');
		vi.mocked(fsSync.existsSync).mockReturnValueOnce(false);
		await expect(invoke('shell:showItemInFolder', '/missing')).resolves.toBeUndefined();

		await invoke('shell:openPath', '/tmp/file.txt');
		await expect(invoke('shell:openPath', '')).rejects.toThrow('Invalid path');
		vi.mocked(shell.openPath).mockResolvedValueOnce('No app');
		await expect(invoke('shell:openPath', '/tmp/unknown.xyz')).resolves.toBeUndefined();
		vi.mocked(fsSync.existsSync).mockReturnValueOnce(false);
		await expect(invoke('shell:openPath', '/missing')).resolves.toBeUndefined();

		const image = { isEmpty: vi.fn().mockReturnValue(false) };
		vi.mocked(nativeImage.createFromDataURL).mockReturnValueOnce(image as never);
		await invoke('clipboard:writeImage', 'data:image/png;base64,abc');
		expect(clipboard.writeImage).toHaveBeenCalledWith(image);
		await expect(invoke('clipboard:writeImage', '')).rejects.toThrow('Invalid data URL');
		vi.mocked(nativeImage.createFromDataURL).mockReturnValueOnce({
			isEmpty: vi.fn().mockReturnValue(true),
		} as never);
		await expect(invoke('clipboard:writeImage', 'data:image/png;base64,bad')).rejects.toThrow(
			'Failed to create image'
		);

		vi.mocked(isCloudflaredInstalled).mockResolvedValueOnce(true);
		await expect(invoke('tunnel:isCloudflaredInstalled')).resolves.toBe(true);
		vi.mocked(tunnelManager.start).mockResolvedValueOnce({
			success: true,
			url: 'https://abc.trycloudflare.com',
		});
		await expect(invoke('tunnel:start')).resolves.toEqual({
			success: true,
			url: 'https://abc.trycloudflare.com/token-path',
		});
		register({ getWebServer: () => null });
		await expect(invoke('tunnel:start')).resolves.toEqual({
			success: false,
			error: 'Web server not running',
		});
		register();
		vi.mocked(tunnelManager.start).mockResolvedValueOnce({ success: false, error: 'failed' });
		await expect(invoke('tunnel:start')).resolves.toEqual({ success: false, error: 'failed' });
		await expect(invoke('tunnel:stop')).resolves.toEqual({ success: true });
		vi.mocked(tunnelManager.getStatus).mockReturnValueOnce({ running: true, url: 'https://abc' });
		await expect(invoke('tunnel:getStatus')).resolves.toEqual({
			running: true,
			url: 'https://abc',
		});

		await invoke('devtools:open');
		expect(mainWindow.webContents.openDevTools).toHaveBeenCalled();
		await invoke('devtools:close');
		expect(mainWindow.webContents.closeDevTools).toHaveBeenCalled();
		mainWindow.webContents.isDevToolsOpened.mockReturnValueOnce(false);
		await invoke('devtools:toggle');
		mainWindow.webContents.isDevToolsOpened.mockReturnValueOnce(true);
		await invoke('devtools:toggle');
	});

	it('routes logger, sync, and power management operations through dependencies', async () => {
		for (const level of ['debug', 'info', 'warn', 'error', 'toast', 'autorun', 'custom']) {
			await invoke('logger:log', level, `${level} message`, 'Ctx', { level });
		}
		expect(logger.debug).toHaveBeenCalledWith('debug message', 'Ctx', { level: 'debug' });
		expect(logger.info).toHaveBeenCalledWith('[custom] custom message', 'Ctx', {
			level: 'custom',
		});

		vi.mocked(logger.getLogs).mockReturnValueOnce([{ message: 'one' }] as never);
		await expect(invoke('logger:getLogs', { level: 'info', limit: 1 })).resolves.toEqual([
			{ message: 'one' },
		]);
		await invoke('logger:clearLogs');
		await invoke('logger:setLogLevel', 'debug');
		await invoke('logger:setMaxLogBuffer', 123);
		await invoke('logger:getLogLevel');
		await invoke('logger:getMaxLogBuffer');
		await invoke('logger:getLogFilePath');
		await invoke('logger:isFileLoggingEnabled');
		await invoke('logger:enableFileLogging');
		expect(settingsStore.set).toHaveBeenCalledWith('logLevel', 'debug');
		expect(settingsStore.set).toHaveBeenCalledWith('maxLogBuffer', 123);

		await expect(invoke('sync:getDefaultPath')).resolves.toBe('/default/user-data');
		bootstrapStore.get.mockImplementation((key: string) =>
			key === 'customSyncPath' ? '/sync/current' : undefined
		);
		await expect(invoke('sync:getSettings')).resolves.toEqual({ customSyncPath: '/sync/current' });
		await expect(invoke('sync:getCurrentStoragePath')).resolves.toBe('/sync/current');
		register({ bootstrapStore: undefined });
		await expect(invoke('sync:getSettings')).resolves.toEqual({ customSyncPath: undefined });
		await expect(invoke('sync:getCurrentStoragePath')).resolves.toBe('/default/user-data');
		register();

		vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
			canceled: false,
			filePaths: ['/sync/selected'],
		});
		await expect(invoke('sync:selectSyncFolder')).resolves.toBe('/sync/selected');
		register({ getMainWindow: () => null });
		await expect(invoke('sync:selectSyncFolder')).resolves.toBeNull();
		register();
		vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
			canceled: true,
			filePaths: [],
		});
		await expect(invoke('sync:selectSyncFolder')).resolves.toBeNull();
		register({ bootstrapStore: undefined });
		await expect(invoke('sync:setCustomPath', '/target')).resolves.toEqual({
			success: false,
			error: 'Bootstrap store not available',
		});
		register();

		bootstrapStore.get.mockImplementation((key: string) => {
			if (key === 'customSyncPath') return undefined;
			if (key === 'iCloudSyncEnabled') return true;
			return undefined;
		});
		vi.mocked(fsSync.existsSync).mockImplementation((filePath: fsSync.PathLike) => {
			const value = String(filePath);
			return value.includes('/target') || value.includes('maestro-settings.json');
		});
		vi.mocked(fsSync.readFileSync).mockImplementation((filePath: fsSync.PathOrFileDescriptor) =>
			String(filePath).includes('/target') ? 'different' : 'source-content'
		);
		await expect(invoke('sync:setCustomPath', '/target')).resolves.toMatchObject({
			success: true,
			migrated: 1,
			requiresRestart: true,
		});
		expect(fsSync.copyFileSync).toHaveBeenCalled();
		expect(bootstrapStore.set).toHaveBeenCalledWith('customSyncPath', '/target');
		expect(bootstrapStore.delete).toHaveBeenCalledWith('iCloudSyncEnabled');

		bootstrapStore.get.mockReturnValue(undefined);
		vi.mocked(fsSync.existsSync).mockImplementation((filePath: fsSync.PathLike) => {
			const value = String(filePath);
			return value.includes('/target-with-error') || value.includes('maestro-settings.json');
		});
		vi.mocked(fsSync.copyFileSync).mockImplementationOnce(() => {
			throw new Error('copy failed');
		});
		await expect(invoke('sync:setCustomPath', '/target-with-error')).resolves.toMatchObject({
			success: false,
			errors: [expect.stringContaining('Failed to migrate maestro-settings.json')],
		});

		bootstrapStore.get.mockImplementation((key: string) =>
			key === 'customSyncPath' ? '/target' : undefined
		);
		await expect(invoke('sync:setCustomPath', '/target')).resolves.toEqual({
			success: true,
			migrated: 0,
		});
		vi.mocked(fsSync.existsSync).mockReturnValueOnce(false);
		vi.mocked(fsSync.mkdirSync).mockImplementationOnce(() => {
			throw new Error('permission denied');
		});
		await expect(invoke('sync:setCustomPath', '/blocked')).resolves.toEqual({
			success: false,
			error: 'Cannot create directory: /blocked',
		});
		vi.mocked(fsSync.existsSync).mockReturnValue(true);
		await expect(invoke('sync:setCustomPath', null)).resolves.toMatchObject({
			success: true,
			requiresRestart: true,
		});
		expect(bootstrapStore.delete).toHaveBeenCalledWith('customSyncPath');

		await invoke('power:setEnabled', true);
		expect(powerManager.setEnabled).toHaveBeenCalledWith(true);
		expect(settingsStore.set).toHaveBeenCalledWith('preventSleepEnabled', true);
		vi.mocked(powerManager.isEnabled).mockReturnValueOnce(true);
		await expect(invoke('power:isEnabled')).resolves.toBe(true);
		vi.mocked(powerManager.getStatus).mockReturnValueOnce({ enabled: true, reasons: ['auto-run'] });
		await expect(invoke('power:getStatus')).resolves.toEqual({
			enabled: true,
			reasons: ['auto-run'],
		});
		await invoke('power:addReason', 'auto-run');
		await invoke('power:removeReason', 'auto-run');
		expect(powerManager.addBlockReason).toHaveBeenCalledWith('auto-run');
		expect(powerManager.removeBlockReason).toHaveBeenCalledWith('auto-run');
	});

	it('forwards logger events only to live renderer web contents', () => {
		vi.useFakeTimers();
		let newLogHandler: ((entry: { message: string }) => void) | undefined;
		vi.mocked(logger.on).mockImplementation((event: string, handler: any) => {
			if (event === 'newLog') {
				newLogHandler = handler;
			}
		});

		try {
			setupLoggerEventForwarding(() => mainWindow as unknown as BrowserWindow);
			newLogHandler?.({ message: 'ready' });
			expect(mainWindow.webContents.send).not.toHaveBeenCalled();
			vi.advanceTimersByTime(50);
			expect(mainWindow.webContents.send).toHaveBeenCalledWith('logger:newLogBatch', [
				{ message: 'ready' },
			]);

			mainWindow.webContents.isDestroyed.mockReturnValueOnce(true);
			newLogHandler?.({ message: 'disposed' });
			vi.advanceTimersByTime(50);
			expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1);

			mainWindow.webContents.isDestroyed.mockReturnValue(false);
			mainWindow.webContents.send.mockImplementationOnce(() => {
				throw new Error('renderer gone');
			});
			expect(() => newLogHandler?.({ message: 'ignored' })).not.toThrow();
			expect(() => vi.advanceTimersByTime(50)).not.toThrow();
		} finally {
			vi.useRealTimers();
		}
	});
});
