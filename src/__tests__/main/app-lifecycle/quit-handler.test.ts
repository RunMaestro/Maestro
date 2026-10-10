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
const mockExit = vi.fn();
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
		exit: (...args: unknown[]) => mockExit(...args),
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

// Mock power-manager for the typeof import
vi.mock('../../../main/power-manager', () => ({
	powerManager: {
		clearAllReasons: vi.fn(),
	},
}));

// Mock cue-executor to avoid pulling in agent/parser/SSH dependencies
const mockStopAllCueRuns = vi.fn();
vi.mock('../../../main/cue/cue-executor', () => ({
	stopAllCueRuns: (...args: unknown[]) => mockStopAllCueRuns(...args),
}));

// Mock the multi-window persistence helper so we can assert the quit handler
// snapshots the layout during cleanup without exercising the helper internals
// (those are covered by window-state-persistence.test.ts).
const mockSaveAllWindowStates = vi.fn();
vi.mock('../../../main/window-state-persistence', () => ({
	saveAllWindowStates: (...args: unknown[]) => mockSaveAllWindowStates(...args),
}));

// Platform is controllable per-test: the update-install hard-exit only applies
// on macOS (Squirrel.Mac/ShipIt), while Windows/Linux keep the graceful path.
let mockIsMacOS = true;
vi.mock('../../../shared/platformDetection', () => ({
	isMacOS: () => mockIsMacOS,
	isWindows: () => false,
	isLinux: () => false,
}));

describe('app-lifecycle/quit-handler', () => {
	let mockMainWindow: {
		isDestroyed: ReturnType<typeof vi.fn>;
		webContents: { send: ReturnType<typeof vi.fn>; isDestroyed: ReturnType<typeof vi.fn> };
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

	let mockPowerManager: {
		clearAllReasons: ReturnType<typeof vi.fn>;
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
		powerManager: typeof mockPowerManager;
		stopSessionCleanup: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		beforeQuitHandler = null;
		ipcHandlers.clear();
		mockIsMacOS = true;

		// Stub process.kill so the production hardExit() (SIGKILL to self) never
		// actually terminates the test runner. Restored by vi.restoreAllMocks().
		vi.spyOn(process, 'kill').mockReturnValue(true);

		mockMainWindow = {
			isDestroyed: vi.fn().mockReturnValue(false),
			webContents: { send: vi.fn(), isDestroyed: vi.fn().mockReturnValue(false) },
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
		mockPowerManager = {
			clearAllReasons: vi.fn(),
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
			powerManager: mockPowerManager,
			stopSessionCleanup: vi.fn(),
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

		it('should register app:quitConfirmationPending IPC handler', async () => {
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');
			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();
			expect(ipcHandlers.has('app:quitConfirmationPending')).toBe(true);
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

		it('should hard-exit on the macOS update-install path after the grace window', async () => {
			mockIsMacOS = true;
			vi.useFakeTimers();
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();
			// confirmQuit() is the auto-updater path. On macOS the bundle swap is done
			// by an external ShipIt helper that quitAndInstall already spawned, so we
			// hard-exit rather than risk the graceful-teardown finalizer deadlock that
			// left the app "not responding" after Restart to Update.
			quitHandler.confirmQuit();

			const mockEvent = { preventDefault: vi.fn() };
			beforeQuitHandler!(mockEvent);

			// We hold the loop open and SIGKILL ourselves once the helper has settled.
			expect(mockEvent.preventDefault).toHaveBeenCalled();
			expect(process.kill).not.toHaveBeenCalled();
			vi.advanceTimersByTime(2000);
			expect(process.kill).toHaveBeenCalledWith(process.pid, 'SIGKILL');
			expect(mockExit).not.toHaveBeenCalled();
			vi.useRealTimers();
		});

		it('should perform cleanup on the update-install path without force-exiting off macOS', async () => {
			mockIsMacOS = false;
			vi.useFakeTimers();
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();
			// confirmQuit() is the auto-updater path - on Windows/Linux the graceful
			// teardown must proceed so electron-updater can apply the update.
			quitHandler.confirmQuit();

			const mockEvent = { preventDefault: vi.fn() };
			beforeQuitHandler!(mockEvent);

			// Off macOS we must NOT hold the loop open or hard-exit, so the native
			// will-quit/quit teardown can run the installer handoff.
			expect(mockEvent.preventDefault).not.toHaveBeenCalled();
			vi.advanceTimersByTime(60_000);
			expect(mockExit).not.toHaveBeenCalled();
			expect(process.kill).not.toHaveBeenCalled();
			vi.useRealTimers();

			// Should perform cleanup
			expect(mockHistoryManager.stopWatching).toHaveBeenCalled();
			expect(deps.stopCliWatcher).toHaveBeenCalled();
			expect(deps.stopSessionCleanup).toHaveBeenCalled();
			// Cue processes (tracked separately) must be killed before ProcessManager.killAll
			expect(mockStopAllCueRuns).toHaveBeenCalled();
			expect(mockProcessManager.killAll).toHaveBeenCalled();
			const cueOrder = mockStopAllCueRuns.mock.invocationCallOrder[0];
			const killOrder = mockProcessManager.killAll.mock.invocationCallOrder[0];
			expect(cueOrder).toBeLessThan(killOrder);
			// clearAllReasons must be called AFTER killAll to prevent late process
			// output from re-arming the sleep blocker
			expect(mockPowerManager.clearAllReasons).toHaveBeenCalled();
			const clearOrder = mockPowerManager.clearAllReasons.mock.invocationCallOrder[0];
			expect(killOrder).toBeLessThan(clearOrder);
			expect(mockTunnelManager.stop).toHaveBeenCalled();
			expect(mockWebServer.stop).toHaveBeenCalled();
			expect(deps.closeStatsDB).toHaveBeenCalled();
		});

		it('saves the multi-window layout during cleanup, before processes are torn down', async () => {
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const fakeStore = { set: vi.fn() };
			const fakeRegistry = { getAll: vi.fn(() => []) };
			const quitHandler = createQuitHandler({
				...deps,
				windowStateStore: fakeStore,
				getWindowRegistry: () => fakeRegistry,
			} as unknown as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();
			quitHandler.confirmQuit();

			beforeQuitHandler!({ preventDefault: vi.fn() });

			// The layout is snapshotted with the injected store + registry...
			expect(mockSaveAllWindowStates).toHaveBeenCalledWith(fakeStore, fakeRegistry);
			// ...and it happens before ProcessManager.killAll() destroys the windows
			// (whose bounds the snapshot needs to still be valid).
			const saveOrder = mockSaveAllWindowStates.mock.invocationCallOrder[0];
			const killOrder = mockProcessManager.killAll.mock.invocationCallOrder[0];
			expect(saveOrder).toBeLessThan(killOrder);
		});

		it('skips the window-state save when the store/registry are not injected', async () => {
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			// deps omits windowStateStore / getWindowRegistry (phased rollout).
			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();
			quitHandler.confirmQuit();

			expect(() => beforeQuitHandler!({ preventDefault: vi.fn() })).not.toThrow();
			expect(mockSaveAllWindowStates).not.toHaveBeenCalled();
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

		it('should force-quit after safety timeout if renderer never responds', async () => {
			vi.useFakeTimers();

			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();

			const mockEvent = { preventDefault: vi.fn() };
			beforeQuitHandler!(mockEvent);

			// Renderer was asked for confirmation
			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('app:requestQuitConfirmation');
			expect(mockQuit).not.toHaveBeenCalled();

			// Advance past the 5s timeout without renderer responding
			vi.advanceTimersByTime(5000);

			expect(mockQuit).toHaveBeenCalled();
			expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out'), 'Window');

			vi.useRealTimers();
		});

		it('should clear safety timeout when renderer confirms quit', async () => {
			vi.useFakeTimers();

			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();

			const mockEvent = { preventDefault: vi.fn() };
			beforeQuitHandler!(mockEvent);

			// Renderer confirms before timeout
			const confirmHandler = ipcHandlers.get('app:quitConfirmed')!;
			confirmHandler();

			// mockQuit called once from confirmHandler
			expect(mockQuit).toHaveBeenCalledTimes(1);

			// Advance past timeout - should NOT trigger a second quit
			vi.advanceTimersByTime(5000);
			expect(mockQuit).toHaveBeenCalledTimes(1);

			vi.useRealTimers();
		});

		it('should disarm the safety timeout when the modal is pending without quitting', async () => {
			vi.useFakeTimers();

			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();

			const mockEvent = { preventDefault: vi.fn() };
			beforeQuitHandler!(mockEvent);

			// Renderer signals the confirmation modal is now showing.
			const pendingHandler = ipcHandlers.get('app:quitConfirmationPending')!;
			pendingHandler();

			// Advance well past the 5s timeout - the app must NOT force-quit while
			// the user is deciding at the open modal.
			vi.advanceTimersByTime(5000);
			expect(mockQuit).not.toHaveBeenCalled();
			expect(quitHandler.isQuitConfirmed()).toBe(false);

			vi.useRealTimers();
		});

		it('should clear safety timeout when renderer cancels quit', async () => {
			vi.useFakeTimers();

			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();

			const mockEvent = { preventDefault: vi.fn() };
			beforeQuitHandler!(mockEvent);

			// Renderer cancels
			const cancelHandler = ipcHandlers.get('app:quitCancelled')!;
			cancelHandler();

			// Advance past timeout - should NOT force quit
			vi.advanceTimersByTime(5000);
			expect(mockQuit).not.toHaveBeenCalled();

			vi.useRealTimers();
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

		it('should hold the loop open and hard-exit after the grace window on a user quit', async () => {
			vi.useFakeTimers();
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();

			// User-quit path: renderer confirms via the IPC handler (NOT confirmQuit,
			// which is reserved for the auto-updater). This sets quitConfirmed=true
			// and calls app.quit(), which re-emits before-quit.
			ipcHandlers.get('app:quitConfirmed')!();

			const mockEvent = { preventDefault: vi.fn() };
			beforeQuitHandler!(mockEvent);

			// Cleanup ran...
			expect(mockHistoryManager.stopWatching).toHaveBeenCalled();
			expect(mockProcessManager.killAll).toHaveBeenCalled();
			// ...the loop is held open so the watchdog timer can fire...
			expect(mockEvent.preventDefault).toHaveBeenCalled();
			expect(process.kill).not.toHaveBeenCalled();

			// ...and after the grace window we hard-exit via SIGKILL to self,
			// bypassing the native teardown that deadlocks on addon TSFN finalizers.
			vi.advanceTimersByTime(750);
			expect(process.kill).toHaveBeenCalledWith(process.pid, 'SIGKILL');
			// app.exit() must NOT be used on this path - it runs FreeEnvironment and
			// can deadlock; it is only the fallback if process.kill throws.
			expect(mockExit).not.toHaveBeenCalled();

			vi.useRealTimers();
		});

		it('should not run cleanup or arm the timer twice on a re-entrant before-quit', async () => {
			vi.useFakeTimers();
			const { createQuitHandler } = await import('../../../main/app-lifecycle/quit-handler');

			const quitHandler = createQuitHandler(deps as Parameters<typeof createQuitHandler>[0]);
			quitHandler.setup();
			ipcHandlers.get('app:quitConfirmed')!();

			beforeQuitHandler!({ preventDefault: vi.fn() });
			// A second before-quit emit (e.g. another path calling app.quit) must be a no-op.
			beforeQuitHandler!({ preventDefault: vi.fn() });

			expect(mockHistoryManager.stopWatching).toHaveBeenCalledTimes(1);
			expect(mockProcessManager.killAll).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(750);
			// Only one timer was armed despite two emits.
			expect(process.kill).toHaveBeenCalledTimes(1);

			vi.useRealTimers();
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
