/**
 * Tests for settings file watcher factory.
 */

import type { FSWatcher, WatchEventType } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type WatchRecord = {
	dirPath: string;
	callback: (eventType: WatchEventType, filename: string | null) => void;
	errorCallback?: (error: Error) => void;
	close: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
};

const { watchRecords, mockExistsSync, mockMkdirSync, mockWatch } = vi.hoisted(() => {
	const records: WatchRecord[] = [];
	const existsSync = vi.fn();
	const mkdirSync = vi.fn();
	const watch = vi.fn(
		(dirPath: string, callback: (eventType: WatchEventType, filename: string | null) => void) => {
			const record: WatchRecord = {
				dirPath,
				callback,
				close: vi.fn(),
				on: vi.fn((event: string, cb: (error: Error) => void) => {
					if (event === 'error') {
						record.errorCallback = cb;
					}
				}),
			};
			records.push(record);
			return record as unknown as FSWatcher;
		}
	);

	return {
		watchRecords: records,
		mockExistsSync: existsSync,
		mockMkdirSync: mkdirSync,
		mockWatch: watch,
	};
});

vi.mock('fs', () => ({
	default: {
		existsSync: (...args: unknown[]) => mockExistsSync(...args),
		mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
		watch: (...args: unknown[]) => mockWatch(...args),
	},
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
	watch: (...args: unknown[]) => mockWatch(...args),
}));

const mockLogger = vi.hoisted(() => ({
	debug: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: mockLogger,
}));

const mockIsWebContentsAvailable = vi.hoisted(() => vi.fn());

vi.mock('../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: (...args: unknown[]) => mockIsWebContentsAvailable(...args),
}));

import { createSettingsWatcher } from '../../../main/app-lifecycle/settings-watcher';

describe('app-lifecycle/settings-watcher', () => {
	let mainWindow: { webContents: { send: ReturnType<typeof vi.fn> } };
	let getMainWindow: ReturnType<typeof vi.fn>;
	let getSettingsPath: ReturnType<typeof vi.fn>;
	let getAgentConfigsPath: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		watchRecords.length = 0;
		mainWindow = { webContents: { send: vi.fn() } };
		getMainWindow = vi.fn().mockReturnValue(mainWindow);
		getSettingsPath = vi.fn().mockReturnValue('/settings');
		getAgentConfigsPath = vi.fn().mockReturnValue('/agent-configs');
		mockExistsSync.mockReturnValue(true);
		mockIsWebContentsAvailable.mockReturnValue(true);
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	function createWatcher() {
		return createSettingsWatcher({
			getMainWindow,
			getSettingsPath,
			getAgentConfigsPath,
		});
	}

	it('creates missing settings directories and starts separate watchers for distinct paths', () => {
		mockExistsSync.mockReturnValue(false);
		const watcher = createWatcher();

		watcher.start();

		expect(mockMkdirSync).toHaveBeenCalledWith('/settings', { recursive: true });
		expect(mockMkdirSync).toHaveBeenCalledWith('/agent-configs', { recursive: true });
		expect(mockWatch).toHaveBeenCalledWith('/settings', expect.any(Function));
		expect(mockWatch).toHaveBeenCalledWith('/agent-configs', expect.any(Function));
		expect(watchRecords).toHaveLength(2);
		expect(watchRecords[0].on).toHaveBeenCalledWith('error', expect.any(Function));
		expect(mockLogger.info).toHaveBeenCalledWith('Settings file watcher started', 'Startup');
	});

	it('starts two filename-specific watchers when settings and agent configs share a directory', () => {
		getAgentConfigsPath.mockReturnValue('/settings');
		const watcher = createWatcher();

		watcher.start();

		expect(mockWatch).toHaveBeenNthCalledWith(1, '/settings', expect.any(Function));
		expect(mockWatch).toHaveBeenNthCalledWith(2, '/settings', expect.any(Function));
		expect(watchRecords).toHaveLength(2);

		watchRecords[1].callback('change', 'maestro-agent-configs.json');
		vi.advanceTimersByTime(300);
		expect(mainWindow.webContents.send).toHaveBeenCalledWith('settings:externalChange');
	});

	it('debounces settings file changes and ignores unrelated files', () => {
		const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
		const watcher = createWatcher();
		watcher.start();

		watchRecords[0].callback('change', 'other-file.json');
		expect(mainWindow.webContents.send).not.toHaveBeenCalled();

		watchRecords[0].callback('change', 'maestro-settings.json');
		watchRecords[0].callback('rename', 'maestro-settings.json');
		expect(clearTimeoutSpy).toHaveBeenCalled();

		vi.advanceTimersByTime(299);
		expect(mainWindow.webContents.send).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(mockLogger.debug).toHaveBeenCalledWith(
			'External change detected in maestro-settings.json, notifying renderer',
			'SettingsWatcher'
		);
		expect(mainWindow.webContents.send).toHaveBeenCalledWith('settings:externalChange');
		expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1);
	});

	it('debounces agent config changes and skips renderer notification when webContents is unavailable', () => {
		mockIsWebContentsAvailable.mockReturnValue(false);
		const watcher = createWatcher();
		watcher.start();

		watchRecords[1].callback('change', 'maestro-agent-configs.json');
		vi.advanceTimersByTime(300);

		expect(mockIsWebContentsAvailable).toHaveBeenCalledWith(mainWindow);
		expect(mainWindow.webContents.send).not.toHaveBeenCalled();
	});

	it('logs watcher errors and watch startup failures', () => {
		const watcher = createWatcher();
		watcher.start();

		watchRecords[0].errorCallback?.(new Error('watch failed'));
		expect(mockLogger.error).toHaveBeenCalledWith(
			'Settings watcher error for maestro-settings.json: watch failed',
			'SettingsWatcher'
		);

		mockLogger.error.mockClear();
		mockWatch.mockImplementationOnce(() => {
			throw new Error('settings unavailable');
		});
		createWatcher().start();
		expect(mockLogger.error).toHaveBeenCalledWith(
			'Failed to watch maestro-settings.json: settings unavailable',
			'SettingsWatcher'
		);

		mockLogger.error.mockClear();
		mockWatch.mockImplementationOnce(() => {
			throw 'string failure';
		});
		createWatcher().start();
		expect(mockLogger.error).toHaveBeenCalledWith(
			'Failed to watch maestro-settings.json: string failure',
			'SettingsWatcher'
		);
	});

	it('closes watchers and clears pending debounce timers on stop', () => {
		const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
		const watcher = createWatcher();
		watcher.start();

		watchRecords[0].callback('change', 'maestro-settings.json');
		watchRecords[1].callback('change', 'maestro-agent-configs.json');

		watcher.stop();

		expect(watchRecords[0].close).toHaveBeenCalled();
		expect(watchRecords[1].close).toHaveBeenCalled();
		expect(clearTimeoutSpy).toHaveBeenCalled();

		vi.advanceTimersByTime(300);
		expect(mainWindow.webContents.send).not.toHaveBeenCalled();
	});

	it('stops cleanly when no debounce timers are pending', () => {
		const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
		const watcher = createWatcher();
		watcher.start();

		watcher.stop();

		expect(watchRecords[0].close).toHaveBeenCalled();
		expect(watchRecords[1].close).toHaveBeenCalled();
		expect(clearTimeoutSpy).not.toHaveBeenCalled();
	});
});
