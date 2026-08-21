import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';

export function registerNotificationCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;

	server.setNotifyToastCallback(async (params) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for notifyToast', 'WebServer');
			return false;
		}
		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for notifyToast', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:notifyToast', params);
		return true;
	});

	server.setNotifyCenterFlashCallback(async (params) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for notifyCenterFlash', 'WebServer');
			return false;
		}
		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for notifyCenterFlash', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:notifyCenterFlash', params);
		return true;
	});
}
