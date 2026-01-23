/**
 * Tests for quit handler factory.
 *
 * Tests cover:
 * - Factory creates quit handler with setup, isQuitConfirmed, confirmQuit methods
 * - Setup registers IPC handlers and before-quit event
 * - Quit flow intercepts when not confirmed
 * - Quit flow performs cleanup when confirmed
 * - Cleanup handles all resources properly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Track event handlers
let beforeQuitHandler: ((event: { preventDefault: () => void }) => void) | null = null;
const ipcHandlers = new Map<string, (...args: unknown[]) => void>();

// Mock app
const mockQuit = vi.fn();
const mockAppOn = vi.fn((event: string, handler: (e: { preventDefault: () => void }) => void) => {
	if (event === 'before-quit') {
		beforeQuitHandler = handler;
	}
});

// Mock ipcMain
const mockIpcMainOn = vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
	ipcHandlers.set(channel, handler);
});

vi.mock('electron', () => ({
	app: {
		on: (...args: unknown[]) => mockAppOn(...args),
		quit: () => mockQuit(),
	},
	ipcMain: {
		on: (...args: unknown[]) => mockIpcMainOn(...args),
	},
	BrowserWindow: vi.fn(),
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

// Mock tunnel-manager for the typeof import
vi.mock('../../../main/tunnel-manager', () => ({
	tunnelManager: {
		stop: vi.fn().mockResolvedValue(undefined),
	},
}));

describe('app-lifecycle/quit-handler', () => {
	let mockMainWindow: {
		isDestroyed: ReturnType<typeof vi.fn>;
		webContents: { send: ReturnType<typeof vi.fn> };
	};
	let mockProcessManager: {
		killAll: ReturnType<typeof vi.fn>;
	};
	let mockWebServer: {
		stop: ReturnType<typeof vi.fn>;
	};
	let mockHistoryManager: {
		stopWatching: ReturnType<typeof vi.fn>;
	};
	let mockTunnelManager: {
		stop: ReturnType<typeof vi.fn>;
	};

	let deps: {
		getMainWindow: ReturnType<typeof vi.fn>;
		getProcessManager: ReturnType<typeof vi.fn>;
		getWebServer: ReturnType<typeof vi.fn>;
		getHistoryManager: ReturnType<typeof vi.fn>;
		tunnelManager: typeof mockTunnelManager;
		getActiveGroomingSessionCount: ReturnType<typeof vi.fn>;
		cleanupAllGroomingSessions: ReturnType<typeof vi.fn>;
		closeStatsDB: ReturnType<typeof vi.fn>;
		stopCliWatcher: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		beforeQuitHandler = null;
		ipcHandlers.clear();

		mockMainWindow = {
			isDestroyed: vi.fn().mockReturnValue(false),
			webContents: { send: vi.fn() },
		};
		mockProcessManager = {
			killAll: vi.fn(),
		};
		mockWebServer = {
			stop: vi.fn().mockResolvedValue(undefined),
		};
		mockHistoryManager = {
			stopWatching: vi.fn(),
		};
		mockTunnelManager = {
			stop: vi.fn().mockResolvedValue(undefined),
		};

		deps = {
			getMainWindow: vi.fn().mockReturnValue(mockMainWindow),
			getProcessManager: vi.fn().mockReturnValue(mockProcessManager),
			getWebServer: vi.fn().mockReturnValue(mockWebServer),
			getHistoryManager: vi.fn().mockReturnValue(mockHistoryManager),
			tunnelManager: mockTunnelManager,
			getActiveGroomingSessionCount: vi.fn().mockReturnValue(0),
			cleanupAllGroomingSessions: vi.fn().mockResolvedValue(undefined),
			closeStatsDB: vi.fn(),
			stopCliWatcher: vi.fn(),
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('createQuitHandler', () => {
		it('should create quit handler with setup, isQuitConfirmed, confirmQuit methods', async () => {
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);

			expect(quitHandler).toHaveProperty('setup');
			expect(quitHandler).toHaveProperty('isQuitConfirmed');
			expect(quitHandler).toHaveProperty('confirmQuit');
			expect(typeof quitHandler.setup).toBe('function');
			expect(typeof quitHandler.isQuitConfirmed).toBe('function');
			expect(typeof quitHandler.confirmQuit).toBe('function');
		});

		it('should start with quitConfirmed as false', async () => {
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);

			expect(quitHandler.isQuitConfirmed()).toBe(false);
		});
	});

	describe('setup', () => {
		it('should register app:quitConfirmed IPC handler', async () => {
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();

			expect(ipcHandlers.has('app:quitConfirmed')).toBe(true);
		});

		it('should register app:quitCancelled IPC handler', async () => {
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();

			expect(ipcHandlers.has('app:quitCancelled')).toBe(true);
		});

		it('should register before-quit handler on app', async () => {
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();

			expect(mockAppOn).toHaveBeenCalledWith('before-quit', expect.any(Function));
			expect(beforeQuitHandler).not.toBeNull();
		});
	});

	describe('quitConfirmed IPC handler', () => {
		it('should set quitConfirmed to true and call app.quit', async () => {
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();

			const handler = ipcHandlers.get('app:quitConfirmed')!;
			handler();

			expect(quitHandler.isQuitConfirmed()).toBe(true);
			expect(mockQuit).toHaveBeenCalled();
		});

		it('should log quit confirmation', async () => {
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();

			const handler = ipcHandlers.get('app:quitConfirmed')!;
			handler();

			expect(mockLogger.info).toHaveBeenCalledWith('Quit confirmed by renderer', 'Window');
		});
	});

	describe('quitCancelled IPC handler', () => {
		it('should log quit cancellation', async () => {
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();

			const handler = ipcHandlers.get('app:quitCancelled')!;
			handler();

			expect(mockLogger.info).toHaveBeenCalledWith('Quit cancelled by renderer', 'Window');
		});
	});

	describe('before-quit handler', () => {
		it('should prevent default and ask renderer for confirmation when not confirmed', async () => {
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();

			const mockEvent = { preventDefault: vi.fn() };
			beforeQuitHandler!(mockEvent);

			expect(mockEvent.preventDefault).toHaveBeenCalled();
			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('app:requestQuitConfirmation');
		});

		it('should auto-confirm and quit if window is null', async () => {
			deps.getMainWindow.mockReturnValue(null);

			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();

			const mockEvent = { preventDefault: vi.fn() };
			beforeQuitHandler!(mockEvent);

			expect(mockEvent.preventDefault).toHaveBeenCalled();
			expect(mockQuit).toHaveBeenCalled();
		});

		it('should auto-confirm and quit if window is destroyed', async () => {
			mockMainWindow.isDestroyed.mockReturnValue(true);

			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();

			const mockEvent = { preventDefault: vi.fn() };
			beforeQuitHandler!(mockEvent);

			expect(mockQuit).toHaveBeenCalled();
		});

		it('should perform cleanup when quit is confirmed', async () => {
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();
			quitHandler.confirmQuit();

			const mockEvent = { preventDefault: vi.fn() };
			beforeQuitHandler!(mockEvent);

			// Should not prevent default when confirmed
			expect(mockEvent.preventDefault).not.toHaveBeenCalled();

			// Should perform cleanup
			expect(mockHistoryManager.stopWatching).toHaveBeenCalled();
			expect(deps.stopCliWatcher).toHaveBeenCalled();
			expect(mockProcessManager.killAll).toHaveBeenCalled();
			expect(mockTunnelManager.stop).toHaveBeenCalled();
			expect(mockWebServer.stop).toHaveBeenCalled();
			expect(deps.closeStatsDB).toHaveBeenCalled();
		});

		it('should cleanup grooming sessions if any are active', async () => {
			deps.getActiveGroomingSessionCount.mockReturnValue(3);

			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();
			quitHandler.confirmQuit();

			const mockEvent = { preventDefault: vi.fn() };
			beforeQuitHandler!(mockEvent);

			expect(deps.cleanupAllGroomingSessions).toHaveBeenCalledWith(mockProcessManager);
		});

		it('should not cleanup grooming sessions if none are active', async () => {
			deps.getActiveGroomingSessionCount.mockReturnValue(0);

			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();
			quitHandler.confirmQuit();

			const mockEvent = { preventDefault: vi.fn() };
			beforeQuitHandler!(mockEvent);

			expect(deps.cleanupAllGroomingSessions).not.toHaveBeenCalled();
		});

		it('should handle null process manager gracefully', async () => {
			deps.getProcessManager.mockReturnValue(null);

			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();
			quitHandler.confirmQuit();

			const mockEvent = { preventDefault: vi.fn() };

			// Should not throw
			expect(() => beforeQuitHandler!(mockEvent)).not.toThrow();
		});

		it('should handle null web server gracefully', async () => {
			deps.getWebServer.mockReturnValue(null);

			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();
			quitHandler.confirmQuit();

			const mockEvent = { preventDefault: vi.fn() };

			// Should not throw
			expect(() => beforeQuitHandler!(mockEvent)).not.toThrow();
		});

		it('should work without stopCliWatcher dependency', async () => {
			const depsWithoutCliWatcher = { ...deps };
			delete depsWithoutCliWatcher.stopCliWatcher;

			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(
				depsWithoutCliWatcher as Parameters<typeof createQuitHandler>[0]
			);
			quitHandler.setup();
			quitHandler.confirmQuit();

			const mockEvent = { preventDefault: vi.fn() };

			// Should not throw
			expect(() => beforeQuitHandler!(mockEvent)).not.toThrow();
		});
	});

	describe('confirmQuit', () => {
		it('should set quitConfirmed to true', async () => {
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);

			expect(quitHandler.isQuitConfirmed()).toBe(false);
			quitHandler.confirmQuit();
			expect(quitHandler.isQuitConfirmed()).toBe(true);
		});
	});
});
