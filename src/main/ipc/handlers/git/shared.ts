import type { BrowserWindow } from 'electron';
import { CreateHandlerOptions } from '../../../utils/ipcHandler';

export const LOG_CONTEXT = '[Git]';

/**
 * Dependencies for Git handlers
 */
export interface GitHandlerDependencies {
	/** Settings store for accessing SSH remote configurations */
	settingsStore: {
		get: (key: string, defaultValue?: unknown) => unknown;
	};
	/**
	 * Returns the current main window (or null). Used to route worktree
	 * watcher events through safeSend so web-desktop bridge clients receive
	 * them alongside the desktop renderer.
	 */
	getMainWindow: () => BrowserWindow | null;
}

/** Helper to create handler options with Git context */
export const handlerOpts = (operation: string, logSuccess = false): CreateHandlerOptions => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess,
});
