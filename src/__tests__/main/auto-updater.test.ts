/**
 * @file auto-updater.test.ts
 * @description Tests for the electron-updater integration in src/main/auto-updater.ts.
 *
 * Focused on the `updates:install` IPC handler — specifically that it invokes
 * the optional `onBeforeQuitAndInstall` hook before calling
 * `autoUpdater.quitAndInstall()`. This hook is what lets the host bypass the
 * busy-agent quit confirmation gate so the Windows installer (which spawns
 * waiting on our PID) isn't orphaned by `before-quit` preventDefault.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture IPC handler registrations so we can invoke them from tests.
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockHandle = vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
	ipcHandlers.set(channel, fn);
});

vi.mock('electron', () => ({
	BrowserWindow: class {},
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => mockHandle(channel, fn),
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

vi.mock('../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn(() => false),
}));

// electron-updater is loaded via dynamic `require` inside auto-updater.ts to
// defer electron.app access — that bypasses vitest's module mocker. We use the
// __setAutoUpdaterForTesting escape hatch instead.
const mockAutoUpdater = {
	autoDownload: false,
	autoInstallOnAppQuit: false,
	allowPrerelease: false,
	on: vi.fn(),
	checkForUpdates: vi.fn(),
	downloadUpdate: vi.fn(),
	quitAndInstall: vi.fn(),
};

describe('main/auto-updater', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		ipcHandlers.clear();
		mockAutoUpdater.quitAndInstall.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('updates:install handler', () => {
		it('invokes onBeforeQuitAndInstall before quitAndInstall', async () => {
			const { initAutoUpdater, __setAutoUpdaterForTesting } =
				await import('../../main/auto-updater');
			__setAutoUpdaterForTesting(
				mockAutoUpdater as unknown as Parameters<typeof __setAutoUpdaterForTesting>[0]
			);
			const callOrder: string[] = [];
			const onBeforeQuitAndInstall = vi.fn(() => {
				callOrder.push('onBeforeQuitAndInstall');
			});
			mockAutoUpdater.quitAndInstall.mockImplementation(() => {
				callOrder.push('quitAndInstall');
			});

			initAutoUpdater({} as Parameters<typeof initAutoUpdater>[0], {
				onBeforeQuitAndInstall,
			});

			const installHandler = ipcHandlers.get('updates:install');
			expect(installHandler).toBeTruthy();

			await installHandler!();

			expect(onBeforeQuitAndInstall).toHaveBeenCalledTimes(1);
			expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
			expect(callOrder).toEqual(['onBeforeQuitAndInstall', 'quitAndInstall']);
		});

		it('still calls quitAndInstall when no onBeforeQuitAndInstall is provided', async () => {
			const { initAutoUpdater, __setAutoUpdaterForTesting } =
				await import('../../main/auto-updater');
			__setAutoUpdaterForTesting(
				mockAutoUpdater as unknown as Parameters<typeof __setAutoUpdaterForTesting>[0]
			);

			initAutoUpdater({} as Parameters<typeof initAutoUpdater>[0]);

			const installHandler = ipcHandlers.get('updates:install');
			expect(installHandler).toBeTruthy();

			await installHandler!();

			expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
		});

		it('still calls quitAndInstall if onBeforeQuitAndInstall throws', async () => {
			const { initAutoUpdater, __setAutoUpdaterForTesting } =
				await import('../../main/auto-updater');
			__setAutoUpdaterForTesting(
				mockAutoUpdater as unknown as Parameters<typeof __setAutoUpdaterForTesting>[0]
			);
			const onBeforeQuitAndInstall = vi.fn(() => {
				throw new Error('hook blew up');
			});

			initAutoUpdater({} as Parameters<typeof initAutoUpdater>[0], {
				onBeforeQuitAndInstall,
			});

			const installHandler = ipcHandlers.get('updates:install');
			expect(installHandler).toBeTruthy();

			expect(() => installHandler!()).not.toThrow();

			expect(onBeforeQuitAndInstall).toHaveBeenCalledTimes(1);
			expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
		});
	});
});
