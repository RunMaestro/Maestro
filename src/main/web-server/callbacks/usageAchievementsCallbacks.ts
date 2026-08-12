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

	// Get usage dashboard data - aggregates from session usage stats via IPC
	server.setGetUsageDashboardCallback(async (timeRange: 'day' | 'week' | 'month' | 'all') => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for getUsageDashboard', 'WebServer');
			return {
				totalTokensIn: 0,
				totalTokensOut: 0,
				totalCost: 0,
				sessionBreakdown: [],
				dailyUsage: [],
			};
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:getUsageDashboard:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(
					result ?? {
						totalTokensIn: 0,
						totalTokensOut: 0,
						totalCost: 0,
						sessionBreakdown: [],
						dailyUsage: [],
					}
				);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for getUsageDashboard', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve({
					totalTokensIn: 0,
					totalTokensOut: 0,
					totalCost: 0,
					sessionBreakdown: [],
					dailyUsage: [],
				});
				return;
			}
			mainWindow.webContents.send('remote:getUsageDashboard', timeRange, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn('getUsageDashboard callback timed out', 'WebServer');
				resolve({
					totalTokensIn: 0,
					totalTokensOut: 0,
					totalCost: 0,
					sessionBreakdown: [],
					dailyUsage: [],
				});
			}, 15000);
		});
	});

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
