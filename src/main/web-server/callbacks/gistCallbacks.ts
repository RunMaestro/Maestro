import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';

export function registerGistCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;

	// Create gist - uses IPC request-response pattern. The renderer holds
	// the AI-tab transcripts in memory, so we forward to it and let it
	// build the payload + call the existing `git:createGist` handler.
	server.setCreateGistCallback(
		async (sessionId: string, description: string, isPublic: boolean) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for createGist', 'WebServer');
				return { success: false, error: 'Desktop app window is not available' };
			}

			return new Promise<{ success: boolean; gistUrl?: string; error?: string }>((resolve) => {
				const responseChannel = `remote:createGist:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (
					_event: Electron.IpcMainEvent,
					result: { success: boolean; gistUrl?: string; error?: string } | undefined
				) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result ?? { success: false, error: 'Empty response' });
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for createGist', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false, error: 'Desktop webContents not available' });
					return;
				}
				mainWindow.webContents.send(
					'remote:createGist',
					sessionId,
					description,
					isPublic,
					responseChannel
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`createGist callback timed out for session ${sessionId}`, 'WebServer');
					resolve({ success: false, error: 'Timed out waiting for gist creation' });
				}, 60000);
			});
		}
	);
}
