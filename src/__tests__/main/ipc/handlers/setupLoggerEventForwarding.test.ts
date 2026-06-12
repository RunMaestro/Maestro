/**
 * Tests for setupLoggerEventForwarding.
 *
 * Verifies that log entries are coalesced into batches and forwarded over
 * the `logger:newLogBatch` IPC channel, instead of one IPC send per entry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Replace the real logger with an EventEmitter so we can drive `newLog`
// events from the tests. Must be hoisted before importing the module under test.
vi.mock('../../../../main/utils/logger', () => {
	const emitter = new EventEmitter();
	return {
		logger: emitter,
	};
});

// Lightweight mocks for unrelated modules pulled in transitively by system.ts.
vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
	shell: {
		openExternal: vi.fn(),
		openPath: vi.fn(),
		showItemInFolder: vi.fn(),
		trashItem: vi.fn(),
	},
	BrowserWindow: { getFocusedWindow: vi.fn() },
	app: { getVersion: vi.fn(), getPath: vi.fn() },
	clipboard: { writeText: vi.fn(), readText: vi.fn() },
	nativeImage: { createFromBuffer: vi.fn() },
}));

vi.mock('../../../../main/utils/shellDetector', () => ({ detectShells: vi.fn() }));
vi.mock('../../../../main/utils/cliDetection', () => ({ isCloudflaredInstalled: vi.fn() }));
vi.mock('../../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../../main/update-checker', () => ({ checkForUpdates: vi.fn() }));
vi.mock('../../../../main/auto-updater', () => ({ setAllowPrerelease: vi.fn() }));
vi.mock('../../../../main/tunnel-manager', () => ({
	tunnelManager: { start: vi.fn(), stop: vi.fn(), getStatus: vi.fn() },
}));
vi.mock('../../../../main/web-server', () => ({ WebServer: class {} }));
vi.mock('../../../../main/power-manager', () => ({
	powerManager: { keepAwake: vi.fn(), allowSleep: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { setupLoggerEventForwarding } from '../../../../main/ipc/handlers/system';
import { logger } from '../../../../main/utils/logger';

const FLUSH_INTERVAL_MS = 50;

describe('setupLoggerEventForwarding', () => {
	let mainWindow: {
		isDestroyed: () => boolean;
		webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
	};

	beforeEach(() => {
		vi.useFakeTimers();
		mainWindow = {
			isDestroyed: () => false,
			webContents: {
				isDestroyed: () => false,
				send: vi.fn(),
			},
		};
	});

	afterEach(() => {
		vi.useRealTimers();
		(logger as unknown as EventEmitter).removeAllListeners('newLog');
	});

	it('coalesces log entries into a single batch send within the flush window', () => {
		setupLoggerEventForwarding(() => mainWindow as never);

		(logger as unknown as EventEmitter).emit('newLog', { id: 1 });
		(logger as unknown as EventEmitter).emit('newLog', { id: 2 });
		(logger as unknown as EventEmitter).emit('newLog', { id: 3 });

		// Buffer is still pending — no IPC sends yet.
		expect(mainWindow.webContents.send).not.toHaveBeenCalled();

		vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

		// All three entries should arrive as one batch.
		expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1);
		expect(mainWindow.webContents.send).toHaveBeenCalledWith('logger:newLogBatch', [
			{ id: 1 },
			{ id: 2 },
			{ id: 3 },
		]);
	});

	it('flushes early once the size threshold (100 entries) is exceeded', () => {
		setupLoggerEventForwarding(() => mainWindow as never);

		for (let i = 0; i < 100; i++) {
			(logger as unknown as EventEmitter).emit('newLog', { id: i });
		}

		// Hit the 100-entry cap — flush must happen synchronously, no timer needed.
		expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1);
		const [channel, batch] = mainWindow.webContents.send.mock.calls[0];
		expect(channel).toBe('logger:newLogBatch');
		expect((batch as unknown[]).length).toBe(100);
	});

	it('starts a fresh batch for entries arriving after a flush', () => {
		setupLoggerEventForwarding(() => mainWindow as never);

		(logger as unknown as EventEmitter).emit('newLog', { id: 'a' });
		vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

		(logger as unknown as EventEmitter).emit('newLog', { id: 'b' });
		vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

		expect(mainWindow.webContents.send).toHaveBeenCalledTimes(2);
		expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(1, 'logger:newLogBatch', [
			{ id: 'a' },
		]);
		expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(2, 'logger:newLogBatch', [
			{ id: 'b' },
		]);
	});

	it('skips sending when the main window is destroyed', () => {
		mainWindow.isDestroyed = () => true;
		setupLoggerEventForwarding(() => mainWindow as never);

		(logger as unknown as EventEmitter).emit('newLog', { id: 1 });
		vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

		expect(mainWindow.webContents.send).not.toHaveBeenCalled();
	});

	it('skips sending when there is no main window', () => {
		setupLoggerEventForwarding(() => null);

		(logger as unknown as EventEmitter).emit('newLog', { id: 1 });
		// Should not throw despite the missing window.
		expect(() => vi.advanceTimersByTime(FLUSH_INTERVAL_MS)).not.toThrow();
	});
});
