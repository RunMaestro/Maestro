import { randomUUID } from 'crypto';
import { ipcMain, type BrowserWindow } from 'electron';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';

/**
 * Shared by the AutoRun control-flow and Playbooks callbacks - both bridge a
 * request to the renderer and wait for a single response on a per-call
 * channel. Extracted verbatim out of web-server-factory.ts (Phase 6
 * refactoring), where it lived inline and was used by both domains.
 */
/**
 * One request/reply round-trip with a renderer over IPC: mint a fresh response
 * channel, send it on `requestChannel`, and resolve with the renderer's reply
 * (mapped by `parse`) or `fallback` if it doesn't answer within `timeoutMs`.
 * Extracts the hand-rolled once-listener + timeout dance used by several
 * `remote:*` reads. Caller must have already confirmed the window's webContents.
 */
export function requestFromRenderer<T>(
	win: BrowserWindow,
	requestChannel: string,
	options: { fallback: T; parse?: (raw: unknown) => T; timeoutMs?: number; args?: unknown[] }
): Promise<T> {
	const { fallback, parse = (raw) => raw as T, timeoutMs = 3000, args = [] } = options;
	return new Promise<T>((resolve) => {
		const responseChannel = `${requestChannel}:response:${randomUUID()}`;
		let settled = false;
		const finish = (value: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			ipcMain.removeListener(responseChannel, onReply);
			resolve(value);
		};
		const onReply = (_event: Electron.IpcMainEvent, raw: unknown) => finish(parse(raw));
		ipcMain.once(responseChannel, onReply);
		win.webContents.send(requestChannel, ...args, responseChannel);
		const timeoutId = setTimeout(() => finish(fallback), timeoutMs);
	});
}

export function createRemoteRequest(getMainWindow: () => BrowserWindow | null) {
	return function remoteRequest<T>(
		operation: string,
		channel: string,
		fallback: T,
		send: (mainWindow: BrowserWindow, responseChannel: string) => void,
		timeoutMs = 10000
	): Promise<T> {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn(`mainWindow is null for ${operation}`, 'WebServer');
			return Promise.resolve(fallback);
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:${channel}:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: T) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result === undefined ? fallback : result);
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn(`webContents is not available for ${operation}`, 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve(fallback);
				return;
			}
			send(mainWindow, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`${operation} callback timed out`, 'WebServer');
				resolve(fallback);
			}, timeoutMs);
		});
	};
}
