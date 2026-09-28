import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';

export function registerContextOpsCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;

	// Merge context - uses IPC request-response pattern
	server.setMergeContextCallback(async (sourceSessionId: string, targetSessionId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for mergeContext', 'WebServer');
			return false;
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:mergeContext:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result ?? false);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for mergeContext', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(false);
				return;
			}
			mainWindow.webContents.send(
				'remote:mergeContext',
				sourceSessionId,
				targetSessionId,
				responseChannel
			);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(
					`mergeContext callback timed out for sessions ${sourceSessionId} → ${targetSessionId}`,
					'WebServer'
				);
				resolve(false);
			}, 30000);
		});
	});

	// Transfer context - uses IPC request-response pattern
	server.setTransferContextCallback(async (sourceSessionId: string, targetSessionId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for transferContext', 'WebServer');
			return false;
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:transferContext:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result ?? false);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for transferContext', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(false);
				return;
			}
			mainWindow.webContents.send(
				'remote:transferContext',
				sourceSessionId,
				targetSessionId,
				responseChannel
			);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(
					`transferContext callback timed out for sessions ${sourceSessionId} → ${targetSessionId}`,
					'WebServer'
				);
				resolve(false);
			}, 30000);
		});
	});

	// Summarize context - uses IPC request-response pattern
	server.setSummarizeContextCallback(async (sessionId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for summarizeContext', 'WebServer');
			return false;
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:summarizeContext:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result ?? false);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for summarizeContext', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(false);
				return;
			}
			mainWindow.webContents.send('remote:summarizeContext', sessionId, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`summarizeContext callback timed out for session ${sessionId}`, 'WebServer');
				resolve(false);
			}, 60000);
		});
	});
}
