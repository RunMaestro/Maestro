import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';

export function registerGroupChatCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;

	// Get all group chats - uses IPC request-response pattern
	server.setGetGroupChatsCallback(async () => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for getGroupChats', 'WebServer');
			return [];
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:getGroupChats:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result || []);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for getGroupChats', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve([]);
				return;
			}
			mainWindow.webContents.send('remote:getGroupChats', responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`getGroupChats callback timed out`, 'WebServer');
				resolve([]);
			}, 10000);
		});
	});

	// Start a group chat - uses IPC request-response pattern
	server.setStartGroupChatCallback(async (topic: string, participantIds: string[]) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for startGroupChat', 'WebServer');
			return null;
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:startGroupChat:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result || null);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for startGroupChat', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(null);
				return;
			}
			mainWindow.webContents.send('remote:startGroupChat', topic, participantIds, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`startGroupChat callback timed out`, 'WebServer');
				resolve(null);
			}, 15000);
		});
	});

	// Get group chat state - uses IPC request-response pattern
	server.setGetGroupChatStateCallback(async (chatId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for getGroupChatState', 'WebServer');
			return null;
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:getGroupChatState:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result || null);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for getGroupChatState', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(null);
				return;
			}
			mainWindow.webContents.send('remote:getGroupChatState', chatId, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`getGroupChatState callback timed out for chat ${chatId}`, 'WebServer');
				resolve(null);
			}, 10000);
		});
	});

	// Stop group chat - uses IPC request-response pattern
	server.setStopGroupChatCallback(async (chatId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for stopGroupChat', 'WebServer');
			return false;
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:stopGroupChat:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result ?? false);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for stopGroupChat', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(false);
				return;
			}
			mainWindow.webContents.send('remote:stopGroupChat', chatId, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`stopGroupChat callback timed out for chat ${chatId}`, 'WebServer');
				resolve(false);
			}, 10000);
		});
	});

	// Send message to group chat - uses IPC request-response pattern
	server.setSendGroupChatMessageCallback(async (chatId: string, message: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for sendGroupChatMessage', 'WebServer');
			return false;
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:sendGroupChatMessage:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result ?? false);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for sendGroupChatMessage', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(false);
				return;
			}
			mainWindow.webContents.send('remote:sendGroupChatMessage', chatId, message, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`sendGroupChatMessage callback timed out for chat ${chatId}`, 'WebServer');
				resolve(false);
			}, 10000);
		});
	});
}
