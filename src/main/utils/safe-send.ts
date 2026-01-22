/**
 * Safe IPC message sending utility.
 * Handles cases where the renderer has been disposed.
 */

import { BrowserWindow } from 'electron';
import { logger } from './logger';

/** Function type for getting the main window reference */
export type GetMainWindow = () => BrowserWindow | null;

/**
 * Creates a safeSend function with the provided window getter.
 * This allows dependency injection of the window reference.
 *
 * @param getMainWindow - Function that returns the current main window or null
 * @returns A function that safely sends IPC messages to the renderer
 */
export function createSafeSend(getMainWindow: GetMainWindow) {
	/**
	 * Safely send IPC message to renderer.
	 * Handles cases where the renderer has been disposed (e.g., GPU crash, window closing).
	 * This prevents "Render frame was disposed before WebFrameMain could be accessed" errors.
	 */
	return function safeSend(channel: string, ...args: unknown[]): void {
		try {
			const mainWindow = getMainWindow();
			if (
				mainWindow &&
				!mainWindow.isDestroyed() &&
				mainWindow.webContents &&
				!mainWindow.webContents.isDestroyed()
			) {
				mainWindow.webContents.send(channel, ...args);
			}
		} catch (error) {
			// Silently ignore - renderer is not available
			// This can happen during GPU crashes, window closing, or app shutdown
			logger.debug(`Failed to send IPC message to renderer: ${channel}`, 'IPC', {
				error: String(error),
			});
		}
	};
}

/** Type for the safeSend function */
export type SafeSendFn = ReturnType<typeof createSafeSend>;
