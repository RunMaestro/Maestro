import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import type { TerminalTabInfo, ReadTerminalTabResult } from '../types';

export function registerBrowserTabCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;

	server.setOpenBrowserTabCallback(
		async (sessionId: string, url: string, options?: { background?: boolean }) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for openBrowserTab', 'WebServer');
				return { success: false };
			}

			// Request-response: wait for the renderer to confirm the tab was
			// actually created before telling the CLI the call succeeded.
			return new Promise<{ success: boolean; tabId?: string }>((resolve) => {
				const responseChannel = `remote:openBrowserTab:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					// Renderer acks with `{ success, tabId? }`; older renderers that
					// still send a bare boolean stay supported.
					if (typeof result === 'object' && result !== null) {
						const r = result as { success?: unknown; tabId?: unknown };
						resolve({
							success: r.success === true,
							tabId: typeof r.tabId === 'string' ? r.tabId : undefined,
						});
						return;
					}
					resolve({ success: result === true });
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for openBrowserTab', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false });
					return;
				}
				mainWindow.webContents.send('remote:openBrowserTab', sessionId, url, responseChannel, {
					background: options?.background === true,
				});

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`openBrowserTab callback timed out for session ${sessionId}`, 'WebServer');
					resolve({ success: false });
				}, 5000);
			});
		}
	);

	server.setCloseBrowserTabCallback(async (tabId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for closeBrowserTab', 'WebServer');
			return false;
		}

		return new Promise<boolean>((resolve) => {
			const responseChannel = `remote:closeBrowserTab:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result === true);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for closeBrowserTab', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(false);
				return;
			}
			mainWindow.webContents.send('remote:closeBrowserTab', tabId, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`closeBrowserTab callback timed out for tab ${tabId}`, 'WebServer');
				resolve(false);
			}, 5000);
		});
	});

	server.setOpenTerminalTabCallback(
		async (
			sessionId: string,
			config: { cwd?: string; shell?: string; name?: string | null; command?: string },
			options?: { background?: boolean }
		) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for openTerminalTab', 'WebServer');
				return { success: false };
			}

			return new Promise<{ success: boolean; tabId?: string }>((resolve) => {
				const responseChannel = `remote:openTerminalTab:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					// Renderer acks with `{ success, tabId? }`; older renderers that
					// still send a bare boolean stay supported.
					if (typeof result === 'object' && result !== null) {
						const r = result as { success?: unknown; tabId?: unknown };
						resolve({
							success: r.success === true,
							tabId: typeof r.tabId === 'string' ? r.tabId : undefined,
						});
						return;
					}
					resolve({ success: result === true });
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for openTerminalTab', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false });
					return;
				}
				mainWindow.webContents.send('remote:openTerminalTab', sessionId, config, responseChannel, {
					background: options?.background === true,
				});

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`openTerminalTab callback timed out for session ${sessionId}`, 'WebServer');
					resolve({ success: false });
				}, 5000);
			});
		}
	);

	server.setWriteTerminalTabCallback(
		async (sessionId: string, payload: { tabRef?: string; data: string }) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for writeTerminalTab', 'WebServer');
				return { success: false, error: 'Desktop window not available' };
			}

			return new Promise<{
				success: boolean;
				error?: string;
				tabId?: string;
				tabName?: string;
			}>((resolve) => {
				const responseChannel = `remote:writeTerminalTab:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					if (typeof result === 'object' && result !== null) {
						const r = result as {
							success?: unknown;
							error?: unknown;
							tabId?: unknown;
							tabName?: unknown;
						};
						resolve({
							success: r.success === true,
							error: typeof r.error === 'string' ? r.error : undefined,
							tabId: typeof r.tabId === 'string' ? r.tabId : undefined,
							tabName: typeof r.tabName === 'string' ? r.tabName : undefined,
						});
						return;
					}
					resolve({ success: result === true });
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for writeTerminalTab', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false, error: 'Desktop window not available' });
					return;
				}
				mainWindow.webContents.send('remote:writeTerminalTab', sessionId, payload, responseChannel);

				// Longer than the other remote channels: the renderer may spend up
				// to 4s waiting for a lazily-spawned PTY before it can write.
				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`writeTerminalTab callback timed out for session ${sessionId}`, 'WebServer');
					resolve({ success: false, error: 'Timed out waiting for the desktop app' });
				}, 8000);
			});
		}
	);

	server.setReadTerminalTabCallback(
		async (sessionId: string, payload: { tabRef?: string; tail?: number }) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for readTerminalTab', 'WebServer');
				return { success: false, error: 'Desktop window not available' };
			}

			return new Promise<ReadTerminalTabResult>((resolve) => {
				const responseChannel = `remote:readTerminalTab:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					if (typeof result === 'object' && result !== null) {
						const r = result as Record<string, unknown>;
						resolve({
							success: r.success === true,
							error: typeof r.error === 'string' ? r.error : undefined,
							tabId: typeof r.tabId === 'string' ? r.tabId : undefined,
							tabName: typeof r.tabName === 'string' ? r.tabName : undefined,
							cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
							state: typeof r.state === 'string' ? r.state : undefined,
							content: typeof r.content === 'string' ? r.content : undefined,
							totalLines: typeof r.totalLines === 'number' ? r.totalLines : undefined,
						});
						return;
					}
					resolve({ success: false, error: 'Malformed response from the desktop app' });
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for readTerminalTab', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false, error: 'Desktop window not available' });
					return;
				}
				mainWindow.webContents.send('remote:readTerminalTab', sessionId, payload, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`readTerminalTab callback timed out for session ${sessionId}`, 'WebServer');
					resolve({ success: false, error: 'Timed out waiting for the desktop app' });
				}, 5000);
			});
		}
	);

	server.setListTerminalTabsCallback(async (sessionId?: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for listTerminalTabs', 'WebServer');
			return [];
		}

		return new Promise<TerminalTabInfo[]>((resolve) => {
			const responseChannel = `remote:listTerminalTabs:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(Array.isArray(result) ? (result as TerminalTabInfo[]) : []);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for listTerminalTabs', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve([]);
				return;
			}
			mainWindow.webContents.send('remote:listTerminalTabs', sessionId, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn('listTerminalTabs callback timed out', 'WebServer');
				resolve([]);
			}, 5000);
		});
	});

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
