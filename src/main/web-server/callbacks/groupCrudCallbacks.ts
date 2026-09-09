import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { createRemoteRequest } from './remoteRequest';
import type { GroupAppearance, GroupUpdateRequest } from '../../../shared/groupAppearance';

export function registerGroupCrudCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;
	const remoteRequest = createRemoteRequest(getMainWindow);

	// Set up callback for web server to create a group
	// Uses IPC request-response pattern
	server.setCreateGroupCallback(
		async (name: string, emoji?: string, parentGroupId?: string, appearance?: GroupAppearance) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for createGroup', 'WebServer');
				return null;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:createGroup:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result || null);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for createGroup', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(null);
					return;
				}
				mainWindow.webContents.send(
					'remote:createGroup',
					name,
					emoji,
					parentGroupId,
					appearance ?? {},
					responseChannel
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`createGroup callback timed out`, 'WebServer');
					resolve(null);
				}, 5000);
			});
		}
	);

	// Set up callback for web server to update a group's name, appearance, or
	// parent. Uses the shared IPC request-response helper; the renderer answers
	// `false` when the group is gone or the reparent is illegal.
	server.setUpdateGroupCallback(async (groupId: string, update: GroupUpdateRequest) =>
		remoteRequest<boolean>('updateGroup', 'updateGroup', false, (mainWindow, responseChannel) =>
			mainWindow.webContents.send('remote:updateGroup', groupId, update, responseChannel)
		)
	);

	// Set up callback for web server to rename a group
	// Uses IPC request-response pattern
	server.setRenameGroupCallback(async (groupId: string, name: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for renameGroup', 'WebServer');
			return false;
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:renameGroup:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result ?? false);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for renameGroup', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(false);
				return;
			}
			mainWindow.webContents.send('remote:renameGroup', groupId, name, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`renameGroup callback timed out for group ${groupId}`, 'WebServer');
				resolve(false);
			}, 5000);
		});
	});

	// Set up callback for web server to delete a group
	// Fire-and-forget pattern
	server.setDeleteGroupCallback(async (groupId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for deleteGroup', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for deleteGroup', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:deleteGroup', groupId);
		return true;
	});

	// Set up callback for web server to move a session to a group
	// Uses IPC request-response pattern
	server.setMoveSessionToGroupCallback(async (sessionId: string, groupId: string | null) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for moveSessionToGroup', 'WebServer');
			return false;
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:moveSessionToGroup:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result ?? false);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for moveSessionToGroup', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(false);
				return;
			}
			mainWindow.webContents.send('remote:moveSessionToGroup', sessionId, groupId, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`moveSessionToGroup callback timed out for session ${sessionId}`, 'WebServer');
				resolve(false);
			}, 5000);
		});
	});
}
