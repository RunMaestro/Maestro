/**
 * runUiCommand - the host side of the `ui.runCommand` brokered capability.
 *
 * A plugin can only ever reach a command that the renderer registered into its
 * shared command registry (the SAME registry the command palette is built
 * from); it cannot fabricate a channel or invoke a privileged internal IPC/WS
 * verb. The flow is a main->renderer request/response round-trip modeled on the
 * web-server-factory callbacks: mint a unique responseChannel, send the command
 * id to the renderer, and resolve the boolean ack (true = a registered command
 * ran; false = unknown command, renderer gone, or timeout).
 */

import { randomUUID } from 'crypto';
import { ipcMain, type BrowserWindow } from 'electron';
import { isWebContentsAvailable } from '../utils/safe-send';
import { logger } from '../utils/logger';

/** How long to wait for the renderer to ack a ui.runCommand round-trip. */
const RUN_UI_COMMAND_TIMEOUT_MS = 5000;

/**
 * Build the `runUiCommand` host dep. `getMainWindow` is read fresh per call so
 * a recreated window is always honored.
 */
export function createRunUiCommand(
	getMainWindow: () => BrowserWindow | null,
	timeoutMs: number = RUN_UI_COMMAND_TIMEOUT_MS
): (commandId: string, args?: unknown) => Promise<boolean> {
	return (commandId, args) =>
		new Promise<boolean>((resolve) => {
			const mainWindow = getMainWindow();
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('mainWindow unavailable for ui.runCommand', '[Plugins]');
				resolve(false);
				return;
			}

			const responseChannel = `plugins:run-ui-command:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, ok: unknown): void => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(ok === true);
			};

			ipcMain.once(responseChannel, handleResponse);
			mainWindow.webContents.send('plugins:run-ui-command', commandId, args, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`ui.runCommand "${commandId}" timed out`, '[Plugins]');
				resolve(false);
			}, timeoutMs);
		});
}
