import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';

export function registerTabCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;

	// Tab operation callbacks
	server.setSelectTabCallback(async (sessionId: string, tabId: string) => {
		logger.info(
			`[Web→Desktop] Tab select callback invoked: session=${sessionId}, tab=${tabId}`,
			'WebServer'
		);
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for selectTab', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for selectTab', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:selectTab', sessionId, tabId);
		return true;
	});

	server.setNewTabCallback(async (sessionId: string, background?: boolean) => {
		logger.info(
			`[Web→Desktop] New tab callback invoked: session=${sessionId}, background=${background === true}`,
			'WebServer'
		);
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for newTab', 'WebServer');
			return null;
		}

		// Use invoke for synchronous response with tab ID
		return new Promise((resolve) => {
			const responseChannel = `remote:newTab:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for newTab', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(null);
				return;
			}
			mainWindow.webContents.send('remote:newTab', sessionId, responseChannel, background === true);

			// Timeout after 5 seconds - clean up the listener to prevent memory leak
			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`newTab callback timed out for session ${sessionId}`, 'WebServer');
				resolve(null);
			}, 5000);
		});
	});

	server.setCloseTabCallback(async (sessionId: string, tabId: string) => {
		logger.info(
			`[Web→Desktop] Close tab callback invoked: session=${sessionId}, tab=${tabId}`,
			'WebServer'
		);
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for closeTab', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for closeTab', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:closeTab', sessionId, tabId);
		return true;
	});

	server.setRenameTabCallback(async (sessionId: string, tabId: string, newName: string) => {
		logger.info(
			`[Web→Desktop] Rename tab callback invoked: session=${sessionId}, tab=${tabId}, newName=${newName}`,
			'WebServer'
		);
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for renameTab', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for renameTab', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:renameTab', sessionId, tabId, newName);
		return true;
	});

	server.setStarTabCallback(async (sessionId: string, tabId: string, starred: boolean) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for starTab', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for starTab', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:starTab', sessionId, tabId, starred);
		return true;
	});

	server.setReorderTabCallback(async (sessionId: string, fromIndex: number, toIndex: number) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for reorderTab', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for reorderTab', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:reorderTab', sessionId, fromIndex, toIndex);
		return true;
	});

	server.setToggleBookmarkCallback(async (sessionId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for toggleBookmark', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for toggleBookmark', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:toggleBookmark', sessionId);
		return true;
	});

	server.setOpenFileTabCallback(
		async (
			sessionId: string,
			filePath: string,
			options: { background: boolean; switchToAgent: boolean }
		) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for openFileTab', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for openFileTab', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:openFileTab', sessionId, filePath, {
				background: options.background,
				switchToAgent: options.switchToAgent,
			});
			return true;
		}
	);

	server.setOpenDocumentGraphCallback(async (params) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for openDocumentGraph', 'WebServer');
			return false;
		}
		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for openDocumentGraph', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:openDocumentGraph', params);
		return true;
	});

	server.setRefreshFileTreeCallback(async (sessionId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for refreshFileTree', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for refreshFileTree', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:refreshFileTree', sessionId);
		return true;
	});

	server.setOpenModalCallback(async (params) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for openModal', 'WebServer');
			return false;
		}
		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for openModal', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:openModal', params);
		return true;
	});
}
