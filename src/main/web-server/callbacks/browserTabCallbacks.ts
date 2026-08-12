import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';

export function registerBrowserTabCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;

	server.setOpenBrowserTabCallback(async (sessionId: string, url: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for openBrowserTab', 'WebServer');
			return false;
		}

		// Request-response: wait for the renderer to confirm the tab was
		// actually created before telling the CLI the call succeeded.
		return new Promise<boolean>((resolve) => {
			const responseChannel = `remote:openBrowserTab:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result === true);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for openBrowserTab', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(false);
				return;
			}
			mainWindow.webContents.send('remote:openBrowserTab', sessionId, url, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`openBrowserTab callback timed out for session ${sessionId}`, 'WebServer');
				resolve(false);
			}, 5000);
		});
	});

	server.setOpenTerminalTabCallback(
		async (sessionId: string, config: { cwd?: string; shell?: string; name?: string | null }) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for openTerminalTab', 'WebServer');
				return false;
			}

			return new Promise<boolean>((resolve) => {
				const responseChannel = `remote:openTerminalTab:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result === true);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for openTerminalTab', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(false);
					return;
				}
				mainWindow.webContents.send('remote:openTerminalTab', sessionId, config, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`openTerminalTab callback timed out for session ${sessionId}`, 'WebServer');
					resolve(false);
				}, 5000);
			});
		}
	);

	server.setNewAITabWithPromptCallback(
		async (sessionId: string, prompt: string, background?: boolean) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for newAITabWithPrompt', 'WebServer');
				return { success: false };
			}

			return new Promise<{ success: boolean; tabId?: string }>((resolve) => {
				const responseChannel = `remote:newAITabWithPrompt:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					// Renderer was updated to ack with `{ success, tabId? }`. Older
					// renderers that still send a bare boolean stay supported via
					// the `result === true` fallback.
					if (typeof result === 'object' && result !== null) {
						const r = result as { success?: unknown; tabId?: unknown };
						resolve({
							success: r.success === true,
							tabId: typeof r.tabId === 'string' ? r.tabId : undefined,
						});
					} else {
						resolve({ success: result === true });
					}
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for newAITabWithPrompt', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false });
					return;
				}
				mainWindow.webContents.send(
					'remote:newAITabWithPrompt',
					sessionId,
					prompt,
					responseChannel,
					background
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(
						`newAITabWithPrompt callback timed out for session ${sessionId}`,
						'WebServer'
					);
					resolve({ success: false });
				}, 5000);
			});
		}
	);
}
