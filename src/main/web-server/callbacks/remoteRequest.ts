import { randomUUID } from 'crypto';
import { ipcMain, type BrowserWindow } from 'electron';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';

/**
 * Shared by the AutoRun control-flow and Playbooks callbacks - both bridge a
 * request to the renderer and wait for a single response on a per-call
 * channel. Extracted verbatim out of web-server-factory.ts (Phase 6
 * refactoring), where it lived inline and was used by both domains.
 */
export function createRemoteRequest(getMainWindow: () => BrowserWindow | null) {
	return function remoteRequest<T>(
		operation: string,
		channel: string,
		fallback: T,
		send: (mainWindow: BrowserWindow, responseChannel: string) => void,
		timeoutMs = 10000
	): Promise<T> {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn(`mainWindow is null for ${operation}`, 'WebServer');
			return Promise.resolve(fallback);
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:${channel}:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: T) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result === undefined ? fallback : result);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn(`webContents is not available for ${operation}`, 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(fallback);
				return;
			}
			send(mainWindow, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`${operation} callback timed out`, 'WebServer');
				resolve(fallback);
			}, timeoutMs);
		});
	};
}
