/**
 * Safe IPC message sending utility.
 * Handles cases where the renderer has been disposed.
 */

import { BrowserWindow } from 'electron';
import { logger } from './logger';
import { broadcastBridgeEvent } from '../web-server/handlers/bridgeHandlers';

/**
 * Function type for enumerating every window a broadcast should reach.
 *
 * In single-window mode this resolves to just the primary window; in
 * multi-window mode it resolves to every open app window (typically
 * `BrowserWindow.getAllWindows()`). Injected so the helper stays free of any
 * direct `electron` value usage and remains trivially unit-testable.
 */
export type GetBroadcastWindows = () => ReadonlyArray<BrowserWindow | null | undefined>;

/**
 * Creates a safeSend function with the provided window enumerator.
 * This allows dependency injection of the window references.
 *
 * @param getWindows - Function that returns every window the broadcast should reach
 * @returns A function that safely sends IPC messages to every renderer
 */
export function createSafeSend(getWindows: GetBroadcastWindows) {
	/**
	 * Safely send an IPC message to every renderer.
	 * Handles cases where a renderer has been disposed (e.g., GPU crash, window closing).
	 * This prevents "Render frame was disposed before WebFrameMain could be accessed" errors.
	 *
	 * MULTI-WINDOW INVARIANT — do NOT "optimize" this into per-window targeting.
	 * Every `process:*` event (data, exit, status, ...) and every other
	 * main→renderer push is BROADCAST to all open windows; each renderer then
	 * filters agent-scoped events to the agents it owns via
	 * `WindowContext.sessionIds` (see `useOwnedSessionGate` in the renderer).
	 * Resolving the single owning window here and sending only to it would
	 * couple the main process to the renderer's ownership map, break the
	 * web-desktop bridge (which has no window), and complicate moving an agent
	 * between windows. Broadcasting to all + filtering in the renderer keeps the
	 * architecture simple and uniform with the bridge below.
	 *
	 * Always fans out to web-desktop bridge clients first (no-op when the Encore
	 * Feature is off or no clients are connected). The bridge broadcast runs
	 * independently of the Electron renderers' liveness so web-desktop users
	 * receive events even when every desktop window is closed, destroyed, or
	 * mid-launch - without that, every main→renderer push would silently
	 * skip the bridge whenever no window was immediately available.
	 */
	return function safeSend(channel: string, ...args: unknown[]): void {
		broadcastBridgeEvent(channel, args);

		for (const win of getWindows()) {
			try {
				if (isWebContentsAvailable(win)) {
					win.webContents.send(channel, ...args);
				}
			} catch (error) {
				// Silently ignore - this renderer is not available
				// This fires on every clean app shutdown, GPU crash, or mid-window-close;
				// reporting it to Sentry would generate high-volume noise, not signal.
				// Keep iterating so a single dead window never blocks the others.
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
