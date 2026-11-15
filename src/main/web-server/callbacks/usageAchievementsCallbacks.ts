import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';

export function registerUsageAchievementsCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;

	// No usage dashboard callback: the old `get_usage_dashboard` message asked
	// the renderer over `remote:getUsageDashboard`, which no renderer ever
	// answered (it timed out after 15s). Clients read the dashboard through
	// `maestro-cli stats` and the web-desktop bridge instead.

	// Get achievements data - aggregates from settings store via IPC
	server.setGetAchievementsCallback(async () => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for getAchievements', 'WebServer');
			return [];
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:getAchievements:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result ?? []);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for getAchievements', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve([]);
				return;
			}
			mainWindow.webContents.send('remote:getAchievements', responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn('getAchievements callback timed out', 'WebServer');
				resolve([]);
			}, 10000);
		});
	});
}
