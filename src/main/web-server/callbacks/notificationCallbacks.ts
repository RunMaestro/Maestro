import type { NotificationInboxResult } from '../../../shared/notificationInbox';
import { createRemoteRequest } from './remoteRequest';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';

export function registerNotificationCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;
	const remoteRequest = createRemoteRequest(getMainWindow);
	server.setNotificationInboxCallback((request) =>
		remoteRequest<NotificationInboxResult>(
			'notificationInbox',
			'notificationInbox',
			{ success: false, error: 'Notification inbox unavailable or timed out' },
			(mainWindow, responseChannel) =>
				mainWindow.webContents.send('remote:notificationInbox', request, responseChannel)
		)
	);

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
