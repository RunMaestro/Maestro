/**
 * Safe IPC message sending utility.
 * Handles cases where the renderer has been disposed.
 */

import { BrowserWindow } from 'electron';
import { logger } from './logger';

/** Function type for getting the main window reference */
export type GetMainWindow = () => BrowserWindow | null;
export type GetWindows = () => Array<BrowserWindow | null | undefined>;

/**
 * Creates a safeSend function with the provided window getter.
 * This allows dependency injection of the window references.
 *
 * @param getMainWindow - Function that returns the current main window or null
 * @param getWindows - Optional function that returns every window that should receive the message
 * @returns A function that safely sends IPC messages to the renderer
 */
export function createSafeSend(getMainWindow: GetMainWindow, getWindows?: GetWindows) {
	/**
	 * Safely send IPC message to renderer.
	 * Handles cases where the renderer has been disposed (e.g., GPU crash, window closing).
	 * This prevents "Render frame was disposed before WebFrameMain could be accessed" errors.
	 */
	return function safeSend(channel: string, ...args: unknown[]): void {
		const windows = getWindows?.() ?? [getMainWindow()];
		const uniqueWindows = Array.from(
			new Set(windows.filter((win): win is BrowserWindow => Boolean(win)))
		);

		for (const win of uniqueWindows) {
			try {
				if (isWebContentsAvailable(win)) {
					win.webContents.send(channel, ...args);
				}
			} catch (error) {
				// Silently ignore - renderer is not available
				// This fires on every clean app shutdown, GPU crash, or mid-window-close;
				// reporting it to Sentry would generate high-volume noise, not signal.
				logger.debug(`Failed to send IPC message to renderer: ${channel}`, 'IPC', {
					error: String(error),
				});
			}
		}
	};
}

/** Type for the safeSend function */
export type SafeSendFn = ReturnType<typeof createSafeSend>;

/**
 * Check if a BrowserWindow's webContents is available for IPC.
 * This is useful for inline checks when safeSend cannot be used.
 *
 * @param win - The BrowserWindow to check (can be null or undefined)
 * @returns true if the window and webContents are available for sending messages
 */
export function isWebContentsAvailable(
	win: BrowserWindow | null | undefined
): win is BrowserWindow {
	return !!(win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed());
}
