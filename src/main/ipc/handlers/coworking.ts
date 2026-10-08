/**
 * Coworking IPC handlers.
 *
 * Bridges the renderer (Settings UI + tab event source) to the main-process
 * coworking subsystem (registry, tools, bridge, installers).
 */

import { BrowserWindow, ipcMain } from 'electron';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { coworkingRegistry } from '../../coworking/coworking-registry';
import { setBrowserResolver, setTerminalBufferResolver } from '../../coworking/coworking-tools';
import {
	getInstallStatus,
	installFor,
	installForAll,
	uninstallFor,
} from '../../coworking/coworking-installer';
import {
	createDefaultBrowserAuditSink,
	setBrowserAuditSink,
} from '../../coworking/coworking-audit';
import type {
	BrowserConfirmPolicy,
	BrowserOp,
	BrowserOpResult,
	CoworkingBrowserInput,
	CoworkingInstallStatus,
	CoworkingTerminalRecord,
} from '../../coworking/coworking-types';
import {
	browserOpNeedsConfirm,
	BROWSER_INTERACT_TIMEOUT_MS,
} from '../../../shared/coworkingBrowser';

const LOG_CTX = '[Coworking][IPC]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CTX,
	operation,
});

export interface CoworkingHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
}

export function registerCoworkingHandlers(deps: CoworkingHandlerDependencies): void {
	// Wire the browser-tool audit sink (system log line + JSONL under userData).
	setBrowserAuditSink(createDefaultBrowserAuditSink());

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
		'coworking:removeSession',
		withIpcErrorLogging(handlerOpts('removeSession'), async (sessionId: string): Promise<void> => {
			coworkingRegistry.removeSession(sessionId);
		})
	);

	ipcMain.handle(
		'coworking:syncSessionBrowsers',
		withIpcErrorLogging(
			handlerOpts('syncSessionBrowsers'),
			async (
				sessionId: string,
				inputs: CoworkingBrowserInput[],
				interactionEnabled: boolean,
				agentType?: string,
				confirmPolicy?: BrowserConfirmPolicy
			): Promise<void> => {
				coworkingRegistry.syncSessionBrowsers(
					sessionId,
					inputs,
					interactionEnabled,
					agentType,
					confirmPolicy
				);
			}
		)
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
	// Browser ops can involve a page-text extraction or a webview activation, so
	// give them more headroom than terminal reads. Kept under the MCP server's
	// 10s per-RPC timeout so the main side fails first with a clean message
	// instead of leaking a listener past the agent-facing timeout.
	const BROWSER_OP_TIMEOUT_MS = 8000;
	// Interaction ops can block on a human approval dialog; they use the shared
	// BROWSER_INTERACT_TIMEOUT_MS (from shared/coworkingBrowser) so the renderer
	// approval auto-decline stays in lockstep with this cap.

	setTerminalBufferResolver(async (sessionId: string, tabUuid: string): Promise<string> => {
		const win = deps.getMainWindow();
		if (!win || win.isDestroyed()) {
			throw new Error('Coworking: main window is not available to read terminal buffer');
		}
		const responseChannel = `coworking:bufferResponse:${nextRequestId++}`;
		const expectedSenderId = win.webContents.id;
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const handler = (_event: Electron.IpcMainEvent, content: string, ok?: boolean) => {
			// Drop responses originating from any renderer other than our main window
			// - defense-in-depth against a malicious or misconfigured renderer.
			if (_event.sender.id !== expectedSenderId) return;
			clearTimeout(timer);
			ipcMain.removeListener(responseChannel, handler);
			// The renderer signals a non-live terminal (its TerminalView ref isn't
			// mounted) via ok:false, mirroring the browser channel's ok:false path,
			// so readTerminal rejects with a clear error instead of resolving a
			// false, successful empty read.
			if (ok === false) {
				reject(
					new Error('Coworking: terminal is not live in the renderer (its view is not mounted)')
				);
				return;
			}
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
		return promise;
	});

	// ---- Browser-op resolver (main -> renderer -> main) ----
	//
	// Same shape as the terminal buffer resolver: the bridge calls into the
	// browser tools with the bridge-bound sessionId + the renderer-side tabUuid
	// and a BrowserOp; we forward it to the renderer (which prefers an already
	// mounted hidden webview and only activates the tab as a fallback) and await
	// the BrowserOpResult on a unique, sender-validated responseChannel.
	setBrowserResolver(
		async (sessionId: string, tabUuid: string, op: BrowserOp): Promise<BrowserOpResult> => {
			const win = deps.getMainWindow();
			if (!win || win.isDestroyed()) {
				throw new Error('Coworking: main window is not available to drive browser tab');
			}
			const responseChannel = `coworking:browserOpResponse:${nextRequestId++}`;
			const expectedSenderId = win.webContents.id;
			const { promise, resolve, reject } = Promise.withResolvers<BrowserOpResult>();
			const handler = (_event: Electron.IpcMainEvent, result: BrowserOpResult) => {
				if (_event.sender.id !== expectedSenderId) return;
				clearTimeout(timer);
				ipcMain.removeListener(responseChannel, handler);
				// The renderer reports op failures (tab not live, selector miss, eval
				// throw) via ok:false + a message in content, so the agent gets a clean
				// JSON-RPC error instead of a silent empty result.
				if (result && result.ok === false) {
					reject(new Error(result.content || 'Coworking: browser op failed'));
					return;
				}
				resolve(result);
			};
			const timer = setTimeout(
				() => {
					ipcMain.removeListener(responseChannel, handler);
					reject(new Error('Coworking: timed out waiting for browser op from renderer'));
				},
				op.kind === 'read' ? BROWSER_OP_TIMEOUT_MS : BROWSER_INTERACT_TIMEOUT_MS
			);
			ipcMain.on(responseChannel, handler);
			// Main computes the per-call approval requirement from its own mirrored
			// policy and sends it with the request, so the renderer's approval gate
			// holds even if the renderer's local settings read is stale. The renderer
			// ORs this with its own computation (defense in depth, never weakening).
			const needsConfirm = browserOpNeedsConfirm(
				coworkingRegistry.getBrowserConfirmPolicy(sessionId),
				op.kind
			);
			try {
				win.webContents.send(
					'coworking:requestBrowserOp',
					tabUuid,
					sessionId,
					op,
					responseChannel,
					needsConfirm
				);
			} catch (err) {
				clearTimeout(timer);
				ipcMain.removeListener(responseChannel, handler);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
			return promise;
		}
	);
}
