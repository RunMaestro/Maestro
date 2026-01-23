/**
 * Tests for CLI activity watcher factory.
 *
 * Tests cover:
 * - Factory creates watcher with start/stop methods
 * - Watcher creates directory if it doesn't exist
 * - Watcher notifies renderer on file changes
 * - Watcher handles errors gracefully
 * - Watcher cleans up on stop
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FSWatcher, WatchEventType } from 'fs';

// Track watcher callbacks
let watcherCallback: ((eventType: WatchEventType, filename: string | null) => void) | null = null;
let watcherErrorCallback: ((error: Error) => void) | null = null;
const mockClose = vi.fn();

// Mock fs module
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockWatch = vi.fn(
	(_dirPath: string, callback: (eventType: WatchEventType, filename: string | null) => void) => {
		watcherCallback = callback;
		return {
			close: mockClose,
			on: vi.fn((event: string, cb: (error: Error) => void) => {
				if (event === 'error') {
					watcherErrorCallback = cb;
				}
			}),
		} as unknown as FSWatcher;
	}
);

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

// Mock path
vi.mock('path', () => ({
	default: {
		join: (...args: string[]) => args.join('/'),
		dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
	},
	join: (...args: string[]) => args.join('/'),
	dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
}));

// Mock logger
const mockLogger = {
	error: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
};

vi.mock('../../../main/utils/logger', () => ({
	logger: mockLogger,
}));

describe('app-lifecycle/cli-watcher', () => {
	let mockMainWindow: {
		isDestroyed: ReturnType<typeof vi.fn>;
		webContents: { send: ReturnType<typeof vi.fn> };
	};
	let getMainWindow: ReturnType<typeof vi.fn>;
	let getUserDataPath: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		watcherCallback = null;
		watcherErrorCallback = null;

		mockMainWindow = {
			isDestroyed: vi.fn().mockReturnValue(false),
			webContents: { send: vi.fn() },
		};
		getMainWindow = vi.fn().mockReturnValue(mockMainWindow);
		getUserDataPath = vi.fn().mockReturnValue('/test/user/data');

		// Default: directory exists
		mockExistsSync.mockReturnValue(true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('createCliWatcher', () => {
		it('should create a watcher with start, stop, and getWatcher methods', async () => {
			const { createCliWatcher } = await import('../../../main/app-lifecycle/cli-watcher');

			const cliWatcher = createCliWatcher({ getMainWindow, getUserDataPath });

			expect(cliWatcher).toHaveProperty('start');
			expect(cliWatcher).toHaveProperty('stop');
			expect(cliWatcher).toHaveProperty('getWatcher');
			expect(typeof cliWatcher.start).toBe('function');
			expect(typeof cliWatcher.stop).toBe('function');
			expect(typeof cliWatcher.getWatcher).toBe('function');
		});

		it('should return null watcher before start is called', async () => {
			const { createCliWatcher } = await import('../../../main/app-lifecycle/cli-watcher');

			const cliWatcher = createCliWatcher({ getMainWindow, getUserDataPath });

			expect(cliWatcher.getWatcher()).toBeNull();
		});
	});

	describe('start', () => {
		it('should create directory if it does not exist', async () => {
			mockExistsSync.mockReturnValue(false);

			const { createCliWatcher } = await import('../../../main/app-lifecycle/cli-watcher');

			const cliWatcher = createCliWatcher({ getMainWindow, getUserDataPath });
			cliWatcher.start();

			expect(mockMkdirSync).toHaveBeenCalledWith('/test/user/data', { recursive: true });
		});

		it('should not create directory if it exists', async () => {
			mockExistsSync.mockReturnValue(true);

			const { createCliWatcher } = await import('../../../main/app-lifecycle/cli-watcher');

			const cliWatcher = createCliWatcher({ getMainWindow, getUserDataPath });
			cliWatcher.start();

			expect(mockMkdirSync).not.toHaveBeenCalled();
		});

		it('should start watching the user data directory', async () => {
			const { createCliWatcher } = await import('../../../main/app-lifecycle/cli-watcher');

			const cliWatcher = createCliWatcher({ getMainWindow, getUserDataPath });
			cliWatcher.start();

			expect(mockWatch).toHaveBeenCalledWith('/test/user/data', expect.any(Function));
			expect(cliWatcher.getWatcher()).not.toBeNull();
		});

		it('should log info when started', async () => {
			const { createCliWatcher } = await import('../../../main/app-lifecycle/cli-watcher');

			const cliWatcher = createCliWatcher({ getMainWindow, getUserDataPath });
			cliWatcher.start();

			expect(mockLogger.info).toHaveBeenCalledWith('CLI activity watcher started', 'Startup');
		});

		it('should notify renderer when cli-activity.json changes', async () => {
			const { createCliWatcher } = await import('../../../main/app-lifecycle/cli-watcher');

			const cliWatcher = createCliWatcher({ getMainWindow, getUserDataPath });
			cliWatcher.start();

			// Simulate file change
			expect(watcherCallback).not.toBeNull();
			watcherCallback!('change', 'cli-activity.json');

			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('cli:activityChange');
		});

		it('should not notify renderer for other files', async () => {
			const { createCliWatcher } = await import('../../../main/app-lifecycle/cli-watcher');

			const cliWatcher = createCliWatcher({ getMainWindow, getUserDataPath });
			cliWatcher.start();

			// Simulate file change for different file
			watcherCallback!('change', 'other-file.json');

			expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
		});

		it('should not notify renderer if window is null', async () => {
			getMainWindow.mockReturnValue(null);

			const { createCliWatcher } = await import('../../../main/app-lifecycle/cli-watcher');

			const cliWatcher = createCliWatcher({ getMainWindow, getUserDataPath });
			cliWatcher.start();

			// Simulate file change
			watcherCallback!('change', 'cli-activity.json');

			expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
		});

		it('should not notify renderer if window is destroyed', async () => {
			mockMainWindow.isDestroyed.mockReturnValue(true);

			const { createCliWatcher } = await import('../../../main/app-lifecycle/cli-watcher');

			const cliWatcher = createCliWatcher({ getMainWindow, getUserDataPath });
			cliWatcher.start();

			// Simulate file change
			watcherCallback!('change', 'cli-activity.json');

			expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
		});

		it('should log error on watcher error', async () => {
			const { createCliWatcher } = await import('../../../main/app-lifecycle/cli-watcher');

			const cliWatcher = createCliWatcher({ getMainWindow, getUserDataPath });
			cliWatcher.start();

			// Simulate watcher error
			expect(watcherErrorCallback).not.toBeNull();
			const testError = new Error('Test watcher error');
			watcherErrorCallback!(testError);

			expect(mockLogger.error).toHaveBeenCalledWith(
				'CLI activity watcher error: Test watcher error',
				'CliActivityWatcher'
			);
		});

		it('should handle watch() throwing an error', async () => {
			mockWatch.mockImplementationOnce(() => {
				throw new Error('Watch failed');
			});

			const { createCliWatcher } = await import('../../../main/app-lifecycle/cli-watcher');

			const cliWatcher = createCliWatcher({ getMainWindow, getUserDataPath });
			cliWatcher.start();

			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining('Failed to start CLI activity watcher'),
				'CliActivityWatcher',
				expect.objectContaining({
					stack: expect.any(String),
				})
			);
		});
	});

	describe('stop', () => {
		it('should close the watcher', async () => {
			const { createCliWatcher } = await import('../../../main/app-lifecycle/cli-watcher');

			const cliWatcher = createCliWatcher({ getMainWindow, getUserDataPath });
			cliWatcher.start();
			cliWatcher.stop();

			expect(mockClose).toHaveBeenCalled();
			expect(cliWatcher.getWatcher()).toBeNull();
		});

		it('should do nothing if watcher not started', async () => {
			const { createCliWatcher } = await import('../../../main/app-lifecycle/cli-watcher');

			const cliWatcher = createCliWatcher({ getMainWindow, getUserDataPath });
			cliWatcher.stop(); // Should not throw

			expect(mockClose).not.toHaveBeenCalled();
		});
	});
});
