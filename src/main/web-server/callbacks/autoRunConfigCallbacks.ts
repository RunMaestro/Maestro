import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { createRemoteRequest } from './remoteRequest';

export function registerAutoRunConfigCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;

	server.setRefreshAutoRunDocsCallback(async (sessionId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for refreshAutoRunDocs', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for refreshAutoRunDocs', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:refreshAutoRunDocs', sessionId);
		return true;
	});

	server.setConfigureAutoRunCallback(async (sessionId: string, config: any) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for configureAutoRun', 'WebServer');
			return { success: false, error: 'Main window not available' };
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:configureAutoRun:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result || { success: false, error: 'No response' });
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for configureAutoRun', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve({ success: false, error: 'Web contents not available' });
				return;
			}
			mainWindow.webContents.send('remote:configureAutoRun', sessionId, config, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`configureAutoRun callback timed out for session ${sessionId}`, 'WebServer');
				resolve({ success: false, error: 'Timeout' });
			}, 10000);
		});
	});

	// Goal-Driven Auto Run launched from the CLI (`goal-run --visible`). Uses the
	// shared remoteRequest round-trip rather than the hand-rolled listener dance
	// above. The renderer only replies once the run has actually reached a
	// running state, so the timeout is generous: startGoalRun loads the
	// `autorun-goal` prompt and reads git status before dispatching START_BATCH.
	const remoteRequest = createRemoteRequest(getMainWindow);
	server.setLaunchGoalRunCallback(async (sessionId, config) =>
		remoteRequest<{ success: boolean; tabId?: string; code?: string; error?: string }>(
			'launchGoalRun',
			'launchGoalRun',
			{ success: false, code: 'LAUNCH_TIMEOUT', error: 'Timed out waiting for the desktop app' },
			(mainWindow, responseChannel) =>
				mainWindow.webContents.send('remote:launchGoalRun', sessionId, config, responseChannel),
			20000
		)
	);

	// Set up callback for web server to update the Auto Run folder on a session.
	// Mirrors `configureAutoRun` IPC pattern: bridge to renderer via remote IPC,
	// renderer-side `handleAutoRunFolderSelected` reloads docs and persists the
	// choice through normal session storage.
	server.setSessionAutoRunFolderCallback(async (sessionId: string, folderPath: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for setSessionAutoRunFolder', 'WebServer');
			return { success: false, error: 'Main window not available' };
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:setAutoRunFolder:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (
				_event: Electron.IpcMainEvent,
				result: { success: boolean; error?: string } | undefined
			) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result || { success: false, error: 'No response' });
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for setSessionAutoRunFolder', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve({ success: false, error: 'Web contents not available' });
				return;
			}
			mainWindow.webContents.send(
				'remote:setAutoRunFolder',
				sessionId,
				folderPath,
				responseChannel
			);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(
					`setSessionAutoRunFolder callback timed out for session ${sessionId}`,
					'WebServer'
				);
				resolve({ success: false, error: 'Timeout' });
			}, 10000);
		});
	});

	// Set up callback for web server to fetch Auto Run documents list
	// Uses IPC request-response pattern with timeout
	server.setGetAutoRunDocsCallback(async (sessionId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for getAutoRunDocs', 'WebServer');
			return [];
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:getAutoRunDocs:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result || []);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for getAutoRunDocs', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve([]);
				return;
			}
			mainWindow.webContents.send('remote:getAutoRunDocs', sessionId, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`getAutoRunDocs callback timed out for session ${sessionId}`, 'WebServer');
				resolve([]);
			}, 10000);
		});
	});

	// Set up callback for web server to fetch Auto Run document content
	// Uses IPC request-response pattern with timeout
	server.setGetAutoRunDocContentCallback(async (sessionId: string, filename: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for getAutoRunDocContent', 'WebServer');
			return '';
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:getAutoRunDocContent:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result ?? '');
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for getAutoRunDocContent', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve('');
				return;
			}
			mainWindow.webContents.send(
				'remote:getAutoRunDocContent',
				sessionId,
				filename,
				responseChannel
			);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(
					`getAutoRunDocContent callback timed out for session ${sessionId}`,
					'WebServer'
				);
				resolve('');
			}, 10000);
		});
	});

	// Set up callback for web server to save Auto Run document content
	// Uses IPC request-response pattern with timeout
	server.setSaveAutoRunDocCallback(async (sessionId: string, filename: string, content: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for saveAutoRunDoc', 'WebServer');
			return false;
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:saveAutoRunDoc:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result ?? false);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for saveAutoRunDoc', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(false);
				return;
			}
			mainWindow.webContents.send(
				'remote:saveAutoRunDoc',
				sessionId,
				filename,
				content,
				responseChannel
			);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`saveAutoRunDoc callback timed out for session ${sessionId}`, 'WebServer');
				resolve(false);
			}, 10000);
		});
	});
}
