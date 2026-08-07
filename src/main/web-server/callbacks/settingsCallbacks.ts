import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import type { Group } from '../../../shared/types';
import type { StoredSession } from '../../stores/types';
import { buildWebSettingsSnapshot } from '../web-settings-snapshot';

export function registerSettingsCallbacks(
	server: WebServer,
	deps: Pick<
		WebServerFactoryDependencies,
		'settingsStore' | 'getMainWindow' | 'groupsStore' | 'sessionsStore'
	>
): void {
	const { settingsStore, getMainWindow, groupsStore, sessionsStore } = deps;

	// Set up callback for web server to read settings
	// Shares the exact field mapping the broadcast path uses below, so the two
	// can't silently drift out of sync.
	server.setGetSettingsCallback(() => buildWebSettingsSnapshot(settingsStore));

	// Set up callback for web server to modify settings
	// Uses IPC request-response pattern - forwards to renderer which applies via existing settings infrastructure
	// After a successful set, re-reads all settings and broadcasts the change to all web clients
	//
	// Note: unlike every other callback in this file, this one calls back into
	// the WebServer instance (`server.broadcastSettingsChanged`) at runtime,
	// not just at registration time - it relies on the closure over `server`.
	server.setSetSettingCallback(async (key: string, value: unknown) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for setSetting', 'WebServer');
			return false;
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:setSetting:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				const success = result ?? false;

				// After successful setting change, broadcast updated settings to all web clients
				if (success) {
					server.broadcastSettingsChanged(buildWebSettingsSnapshot(settingsStore));
				}

				resolve(success);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for setSetting', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(false);
				return;
			}
			mainWindow.webContents.send('remote:setSetting', key, value, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`setSetting callback timed out for key ${key}`, 'WebServer');
				resolve(false);
			}, 5000);
		});
	});

	// Set up callback for web server to read groups
	// Direct read from groupsStore, derive sessionIds from sessions
	server.setGetGroupsCallback(() => {
		const groups = groupsStore.get<Group[]>('groups', []);
		const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
		return groups.map((g) => ({
			id: g.id,
			name: g.name,
			emoji: g.emoji || null,
			parentGroupId: g.parentGroupId,
			sessionIds: sessions.filter((s) => s.groupId === g.id).map((s) => s.id),
		}));
	});
}
