import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import chokidar from 'chokidar';
import {
	registerDocumentGraphHandlers,
	getDocumentGraphWatcherCount,
} from '../../main/ipc/handlers/documentGraph';
import { logger } from '../../main/utils/logger';
import { WINDOWS_LOCKED_SYSTEM_FILES } from '../../main/utils/watcher-ignore';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
}));

vi.mock('chokidar', () => ({
	default: {
		watch: vi.fn(),
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn((win) => Boolean(win)),
}));

describe('documentGraph IPC handlers', () => {
	type WatchEvent = 'add' | 'change' | 'unlink' | 'error';
	type MockWatcher = {
		handlers: Map<WatchEvent, Function[]>;
		on: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
		emit: (event: WatchEvent, ...args: unknown[]) => void;
	};

	let handlers: Map<string, Function>;
	let appBeforeQuit: (() => void) | undefined;
	let app: {
		on: ReturnType<typeof vi.fn>;
	};
	let mainWindow: { webContents: { send: ReturnType<typeof vi.fn> } } | null;
	let watchers: MockWatcher[];

	const createWatcher = (): MockWatcher => {
		const watcher: MockWatcher = {
			handlers: new Map(),
			on: vi.fn((event: WatchEvent, handler: Function) => {
				const eventHandlers = watcher.handlers.get(event) ?? [];
				eventHandlers.push(handler);
				watcher.handlers.set(event, eventHandlers);
				return watcher;
			}),
			close: vi.fn().mockResolvedValue(undefined),
			emit: (event: WatchEvent, ...args: unknown[]) => {
				for (const handler of watcher.handlers.get(event) ?? []) {
					handler(...args);
				}
			},
		};
		return watcher;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();

		handlers = new Map();
		watchers = [];
		appBeforeQuit = undefined;
		mainWindow = {
			webContents: {
				send: vi.fn(),
			},
		};

		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});
		vi.mocked(chokidar.watch).mockImplementation(() => {
			const watcher = createWatcher();
			watchers.push(watcher);
			return watcher as never;
		});
		app = {
			on: vi.fn((event: string, handler: () => void) => {
				if (event === 'before-quit') {
					appBeforeQuit = handler;
				}
				return app;
			}),
		};

		registerDocumentGraphHandlers({
			getMainWindow: () => mainWindow as any,
			app: app as any,
		});
	});

	afterEach(() => {
		appBeforeQuit?.();
		handlers.clear();
		vi.useRealTimers();
	});

	it('registers watch and unwatch handlers plus app shutdown cleanup', () => {
		expect(Array.from(handlers.keys())).toEqual([
			'documentGraph:watchFolder',
			'documentGraph:unwatchFolder',
		]);
		expect(app.on).toHaveBeenCalledWith('before-quit', expect.any(Function));
		expect(logger.debug).toHaveBeenCalledWith(
			'[DocumentGraph] Document Graph IPC handlers registered'
		);
	});

	it('starts a recursive markdown watcher with safe defaults', async () => {
		const result = await handlers.get('documentGraph:watchFolder')!({} as any, '/docs');

		expect(result).toEqual({ success: true });
		expect(chokidar.watch).toHaveBeenCalledWith('/docs', {
			ignored: [
				/(^|[/\\])\../,
				/node_modules/,
				/dist/,
				/build/,
				/\.git/,
				WINDOWS_LOCKED_SYSTEM_FILES,
			],
			persistent: true,
			ignoreInitial: true,
			depth: 99,
		});
		expect(watchers[0].on).toHaveBeenCalledWith('add', expect.any(Function));
		expect(watchers[0].on).toHaveBeenCalledWith('change', expect.any(Function));
		expect(watchers[0].on).toHaveBeenCalledWith('unlink', expect.any(Function));
		expect(watchers[0].on).toHaveBeenCalledWith('error', expect.any(Function));
		expect(getDocumentGraphWatcherCount()).toBe(1);
	});

	it('debounces markdown add/change/unlink events into one renderer notification', async () => {
		vi.useFakeTimers();
		await handlers.get('documentGraph:watchFolder')!({} as any, '/docs');

		watchers[0].emit('add', '/docs/a.md');
		watchers[0].emit('change', '/docs/notes.txt');
		watchers[0].emit('change', '/docs/a.md');
		watchers[0].emit('unlink', '/docs/B.MD');

		await vi.advanceTimersByTimeAsync(500);

		expect(mainWindow?.webContents.send).toHaveBeenCalledWith('documentGraph:filesChanged', {
			rootPath: '/docs',
			changes: [
				{ filePath: '/docs/a.md', eventType: 'change' },
				{ filePath: '/docs/B.MD', eventType: 'unlink' },
			],
		});
		expect(logger.info).toHaveBeenCalledWith(
			'Document graph files changed: 2 file(s) in /docs',
			'[DocumentGraph]'
		);
	});

	it('clears pending events without sending when no renderer window is available', async () => {
		vi.useFakeTimers();
		mainWindow = null;
		await handlers.get('documentGraph:watchFolder')!({} as any, '/docs');

		watchers[0].emit('add', '/docs/a.md');
		await vi.advanceTimersByTimeAsync(500);

		expect(watchers[0].close).not.toHaveBeenCalled();
		expect(logger.info).not.toHaveBeenCalledWith(
			expect.stringContaining('files changed'),
			'[DocumentGraph]'
		);
	});

	it('replaces an existing watcher and clears its pending debounce timer', async () => {
		vi.useFakeTimers();
		await handlers.get('documentGraph:watchFolder')!({} as any, '/docs');
		watchers[0].emit('add', '/docs/pending.md');

		const result = await handlers.get('documentGraph:watchFolder')!({} as any, '/docs');
		await vi.advanceTimersByTimeAsync(500);

		expect(result).toEqual({ success: true });
		expect(watchers[0].close).toHaveBeenCalledTimes(1);
		expect(getDocumentGraphWatcherCount()).toBe(1);
		expect(mainWindow?.webContents.send).not.toHaveBeenCalled();
		expect(logger.info).toHaveBeenCalledWith(
			'Closed existing document graph watcher for: /docs',
			'[DocumentGraph]'
		);
	});

	it('ignores stale debounce timers after watcher replacement clears pending events', async () => {
		vi.useFakeTimers();
		const clearTimeoutSpy = vi
			.spyOn(global, 'clearTimeout')
			.mockImplementation(() => undefined as any);

		try {
			await handlers.get('documentGraph:watchFolder')!({} as any, '/docs');
			watchers[0].emit('add', '/docs/stale.md');

			await handlers.get('documentGraph:watchFolder')!({} as any, '/docs');
			await vi.advanceTimersByTimeAsync(500);

			expect(mainWindow?.webContents.send).not.toHaveBeenCalled();
			expect(getDocumentGraphWatcherCount()).toBe(1);
		} finally {
			clearTimeoutSpy.mockRestore();
		}
	});

	it('unwatches a folder without pending debounce work', async () => {
		await handlers.get('documentGraph:watchFolder')!({} as any, '/docs');

		const result = await handlers.get('documentGraph:unwatchFolder')!({} as any, '/docs');

		expect(result).toEqual({ success: true });
		expect(watchers[0].close).toHaveBeenCalledTimes(1);
		expect(getDocumentGraphWatcherCount()).toBe(0);
		expect(mainWindow?.webContents.send).not.toHaveBeenCalled();
	});

	it('unwatches folders idempotently and clears pending debounce work', async () => {
		vi.useFakeTimers();
		await handlers.get('documentGraph:watchFolder')!({} as any, '/docs');
		watchers[0].emit('change', '/docs/a.md');

		const first = await handlers.get('documentGraph:unwatchFolder')!({} as any, '/docs');
		const second = await handlers.get('documentGraph:unwatchFolder')!({} as any, '/docs');
		await vi.advanceTimersByTimeAsync(500);

		expect(first).toEqual({ success: true });
		expect(second).toEqual({ success: true });
		expect(watchers[0].close).toHaveBeenCalledTimes(1);
		expect(getDocumentGraphWatcherCount()).toBe(0);
		expect(mainWindow?.webContents.send).not.toHaveBeenCalled();
	});

	it('closes all watchers and clears debounce state on app quit', async () => {
		vi.useFakeTimers();
		await handlers.get('documentGraph:watchFolder')!({} as any, '/docs');
		await handlers.get('documentGraph:watchFolder')!({} as any, '/notes');
		watchers[0].emit('add', '/docs/a.md');
		watchers[1].emit('add', '/notes/b.md');

		appBeforeQuit?.();
		await vi.advanceTimersByTimeAsync(500);

		expect(watchers[0].close).toHaveBeenCalledTimes(1);
		expect(watchers[1].close).toHaveBeenCalledTimes(1);
		expect(getDocumentGraphWatcherCount()).toBe(0);
		expect(mainWindow?.webContents.send).not.toHaveBeenCalled();
	});

	it('logs watcher errors without tearing down the watcher', async () => {
		await handlers.get('documentGraph:watchFolder')!({} as any, '/docs');
		const error = new Error('watch failed');

		watchers[0].emit('error', error);

		expect(logger.error).toHaveBeenCalledWith(
			'Document graph watcher error for /docs',
			'[DocumentGraph]',
			error
		);
		expect(getDocumentGraphWatcherCount()).toBe(1);
	});
});
