/**
 * Coworking IPC handlers.
 *
 * Bridges the renderer (Settings UI + tab event source) to the main-process
 * coworking subsystem (registry, tools, bridge, installers).
 */

import { BrowserWindow, ipcMain } from 'electron';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { coworkingRegistry } from '../../coworking/coworking-registry';
import { setTerminalBufferResolver } from '../../coworking/coworking-tools';
import {
	getInstallStatus,
	installFor,
	installForAll,
	uninstallFor,
} from '../../coworking/coworking-installer';
import type {
	CoworkingInstallStatus,
	CoworkingTerminalRecord,
} from '../../coworking/coworking-types';

const LOG_CTX = '[Coworking][IPC]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CTX,
	operation,
});

export interface CoworkingHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
}

export function registerCoworkingHandlers(deps: CoworkingHandlerDependencies): void {
	// ---- Settings panel ----

	ipcMain.handle(
		'coworking:getInstallStatus',
		withIpcErrorLogging(
			handlerOpts('getInstallStatus'),
			async (): Promise<CoworkingInstallStatus[]> => getInstallStatus()
		)
	);

	ipcMain.handle(
		'coworking:install',
		withIpcErrorLogging(handlerOpts('install'), async (agentId: string): Promise<void> => {
			await installFor(agentId);
		})
	);

	ipcMain.handle(
		'coworking:uninstall',
		withIpcErrorLogging(handlerOpts('uninstall'), async (agentId: string): Promise<void> => {
			await uninstallFor(agentId);
		})
	);

	ipcMain.handle(
		'coworking:installAll',
		withIpcErrorLogging(handlerOpts('installAll'), async () => installForAll())
	);

	// ---- Registry sync (renderer → main) ----
	//
	// There is no `setActiveSession` here. The registry holds *every* session's
	// terminals concurrently and the bridge-bound sessionId scopes tool calls.
	// See coworking-bridge.ts for how that binding is established at handshake.

	ipcMain.handle(
		'coworking:syncSessionTerminals',
		withIpcErrorLogging(
			handlerOpts('syncSessionTerminals'),
			async (sessionId: string, records: CoworkingTerminalRecord[]): Promise<void> => {
				coworkingRegistry.syncSessionTerminals(sessionId, records);
			}
		)
	);

	ipcMain.handle(
		'coworking:upsertTerminal',
		withIpcErrorLogging(
			handlerOpts('upsertTerminal'),
			async (record: CoworkingTerminalRecord): Promise<void> => {
				coworkingRegistry.upsertTerminal(record);
			}
		)
	);

	ipcMain.handle(
		'coworking:removeTerminal',
		withIpcErrorLogging(handlerOpts('removeTerminal'), async (tabUuid: string): Promise<void> => {
			coworkingRegistry.removeTerminal(tabUuid);
		})
	);

	ipcMain.handle(
		'coworking:removeSession',
		withIpcErrorLogging(handlerOpts('removeSession'), async (sessionId: string): Promise<void> => {
			coworkingRegistry.removeSession(sessionId);
		})
	);

	// ---- Buffer-request resolver (main → renderer → main) ----
	//
	// The MCP server bridge calls into `readTerminal(sessionId, ...)`, which calls this
	// resolver with the bridge-bound sessionId + the renderer-side tabUuid. We
	// webContents.send a request with a unique responseChannel + that sessionId (so the
	// renderer picks the correct TerminalView from its per-session ref map); the renderer
	// answers via ipcRenderer.send(responseChannel, content).
	let nextRequestId = 1;
	const BUFFER_REQUEST_TIMEOUT_MS = 5000;

	setTerminalBufferResolver(async (sessionId: string, tabUuid: string): Promise<string> => {
		const win = deps.getMainWindow();
		if (!win || win.isDestroyed()) {
			throw new Error('Coworking: main window is not available to read terminal buffer');
		}
		const responseChannel = `coworking:bufferResponse:${nextRequestId++}`;
		const expectedSenderId = win.webContents.id;
		return new Promise<string>((resolve, reject) => {
			const handler = (_event: Electron.IpcMainEvent, content: string) => {
				// Drop responses originating from any renderer other than our main window
				// — defense-in-depth against a malicious or misconfigured renderer.
				if (_event.sender.id !== expectedSenderId) return;
				clearTimeout(timer);
				ipcMain.removeListener(responseChannel, handler);
				resolve(typeof content === 'string' ? content : '');
			};
			const timer = setTimeout(() => {
				ipcMain.removeListener(responseChannel, handler);
				reject(new Error('Coworking: timed out waiting for terminal buffer from renderer'));
			}, BUFFER_REQUEST_TIMEOUT_MS);
			ipcMain.on(responseChannel, handler);
			try {
				win.webContents.send('coworking:requestBuffer', tabUuid, sessionId, responseChannel);
			} catch (err) {
				// If `send` throws (e.g. window destroyed between the guard and now),
				// surface it immediately instead of waiting out the 5s timeout while
				// the listener leaks.
				clearTimeout(timer);
				ipcMain.removeListener(responseChannel, handler);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	});
}
