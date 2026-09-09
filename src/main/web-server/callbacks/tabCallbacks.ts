import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { createKeyedWriteQueue } from '../../utils/atomic-json-store';
import { normalizeRenameTabResult, type RenameTabResult } from '../types';

/**
 * How long a single remote rename may hold its per-tab queue slot without the
 * renderer confirming it. Deliberately far past any plausible persistence: this
 * releases the slot when the renderer is never going to answer at all, it is not
 * a budget for how long a rename may legitimately take.
 */
const RENAME_CONFIRMATION_RELEASE_MS = 60_000;

export function registerTabCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow' | 'getWindowForSession'>
): void {
	const { getMainWindow, getWindowForSession } = deps;
	const resolveSessionWindow = (sessionId: string) =>
		getWindowForSession?.(sessionId) ?? getMainWindow();

	// Renames for ONE tab run strictly one at a time. A rename is a round trip
	// through the renderer that persists the name to the provider's session
	// metadata and to every matching history entry before it answers, so two
	// overlapping renames race: the request that started FIRST can finish LAST
	// and leave the tab named after the older request in both the persisted
	// metadata and the UI. Serializing makes the LATEST rename authoritative,
	// and it also puts the results back on the wire in request order, so a
	// client applying them as they arrive cannot regress to an older name.
	// It lives here rather than in the renderer because this callback is the
	// single path every remote rename takes (CLI, web client, any future
	// caller). Different tabs still run concurrently: the key is per tab.
	const renameQueue = createKeyedWriteQueue();

	// Tab operation callbacks
	server.setSelectTabCallback(async (sessionId: string, tabId: string) => {
		logger.info(
			`[Web→Desktop] Tab select callback invoked: session=${sessionId}, tab=${tabId}`,
			'WebServer'
		);
		const targetWindow = resolveSessionWindow(sessionId);
		if (!targetWindow) {
			logger.warn('No owning window is available for selectTab', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(targetWindow)) {
			logger.warn('webContents is not available for selectTab', 'WebServer');
			return false;
		}
		targetWindow.webContents.send('remote:selectTab', sessionId, tabId);
		return true;
	});

	server.setNewTabCallback(async (sessionId: string, background?: boolean) => {
		logger.info(
			`[Web→Desktop] New tab callback invoked: session=${sessionId}, background=${background === true}`,
			'WebServer'
		);
		const targetWindow = resolveSessionWindow(sessionId);
		if (!isWebContentsAvailable(targetWindow)) {
			logger.warn('No owning window is available for newTab', 'WebServer');
			return null;
		}

		// Use invoke for synchronous response with tab ID
		return new Promise((resolve) => {
			const responseChannel = `remote:newTab:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result);
			};

			ipcMain.once(responseChannel, handleResponse);
			targetWindow.webContents.send(
				'remote:newTab',
				sessionId,
				responseChannel,
				background === true
			);

			// Timeout after 5 seconds - clean up the listener to prevent memory leak
			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`newTab callback timed out for session ${sessionId}`, 'WebServer');
				resolve(null);
			}, 5000);
		});
	});

	server.setCloseTabCallback(async (sessionId: string, tabId: string) => {
		logger.info(
			`[Web→Desktop] Close tab callback invoked: session=${sessionId}, tab=${tabId}`,
			'WebServer'
		);
		const targetWindow = resolveSessionWindow(sessionId);
		if (!targetWindow) {
			logger.warn('No owning window is available for closeTab', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(targetWindow)) {
			logger.warn('webContents is not available for closeTab', 'WebServer');
			return false;
		}
		targetWindow.webContents.send('remote:closeTab', sessionId, tabId);
		return true;
	});

	server.setRenameTabCallback(async (sessionId: string, tabId: string, newName: string) => {
		logger.info(
			`[Web→Desktop] Rename tab callback invoked: session=${sessionId}, tab=${tabId}, newName=${newName}`,
			'WebServer'
		);

		// The window is resolved INSIDE the queued unit, not before it: a rename
		// waiting behind another one can be handed a window that has since closed.
		return renameQueue.enqueue(`${sessionId}:${tabId}`, async (): Promise<RenameTabResult> => {
			const targetWindow = resolveSessionWindow(sessionId);
			if (!targetWindow) {
				logger.warn('No owning window is available for renameTab', 'WebServer');
				return { success: false, error: 'No owning window is available for renameTab' };
			}

			if (!isWebContentsAvailable(targetWindow)) {
				logger.warn('webContents is not available for renameTab', 'WebServer');
				return { success: false, error: 'webContents is not available for renameTab' };
			}

			const { webContents } = targetWindow;

			return new Promise<RenameTabResult>((resolve) => {
				const responseChannel = `remote:renameTab:response:${randomUUID()}`;
				let settled = false;

				// The renderer answers on EVERY path, including its own catch, so the
				// ordinary outcomes are its reply and the renderer going away.
				//
				// A five second deadline used to sit here and resolve a FAILURE on
				// expiry. Persisting the name walks every history file for the agent
				// session, which outruns any fixed budget on a large history, and the
				// renderer then finished the rename anyway: the caller was told the
				// rename failed while the desktop went on to persist it and repaint
				// the tab with the new name. So a failure is now only ever reported
				// when it is definitely true, which is when the renderer is gone: that
				// is also the only moment nothing can still mutate, so a reported
				// failure can never be contradicted afterwards.
				//
				// A wrong label on a remote client is not permanent either way: in
				// LIVE mode `useRemoteIntegration` rebroadcasts each agent's tab
				// inventory, `name` included, on a 500ms hash-diffed interval, so a
				// client reconciles to desktop truth shortly after. That backstop is
				// why a brief disagreement is survivable, and it is NOT a licence to
				// report an outcome we do not have: it does not run outside LIVE mode,
				// and it never reaches the caller blocked on this promise.
				function settle(result: RenameTabResult) {
					if (settled) return;
					settled = true;
					clearTimeout(releaseTimer);
					ipcMain.removeListener(responseChannel, onResponse);
					// Touching a destroyed webContents throws, and its listeners die
					// with it, so only detach while it is still alive.
					if (isWebContentsAvailable(targetWindow)) {
						webContents.removeListener('destroyed', onRendererGone);
						webContents.removeListener('render-process-gone', onRendererGone);
					}
					resolve(result);
				}

				function onResponse(_event: Electron.IpcMainEvent, result: unknown) {
					settle(normalizeRenameTabResult(result));
				}

				function onRendererGone() {
					logger.warn(
						`renameTab lost its renderer before confirmation for session ${sessionId}`,
						'WebServer'
					);
					settle({
						success: false,
						error: 'The desktop renderer went away before the rename was confirmed',
					});
				}

				ipcMain.once(responseChannel, onResponse);
				webContents.once('destroyed', onRendererGone);
				webContents.once('render-process-gone', onRendererGone);
				webContents.send('remote:renameTab', sessionId, tabId, newName, responseChannel);

				// A rename delivered while the renderer is mid-reload has no listener
				// on the other end and no `destroyed` event to end the wait, so without
				// this every later rename for the tab would queue behind it forever.
				// The bound exists to RELEASE THE QUEUE SLOT and the listener, not to
				// answer the caller, so it sits far past any plausible persistence and
				// it reports only what it knows: the rename was not confirmed. It must
				// never claim the rename failed, because the renderer may still be
				// finishing one, and a claim of failure is exactly what the late
				// mutation would go on to contradict.
				const releaseTimer = setTimeout(() => {
					logger.warn(
						`renameTab was not confirmed within ${RENAME_CONFIRMATION_RELEASE_MS}ms for session ${sessionId}`,
						'WebServer'
					);
					settle({
						success: false,
						error: 'The desktop did not confirm the rename; it may still be applying',
						unconfirmed: true,
					});
				}, RENAME_CONFIRMATION_RELEASE_MS);
			});
		});
	});

	server.setStarTabCallback(async (sessionId: string, tabId: string, starred: boolean) => {
		const targetWindow = resolveSessionWindow(sessionId);
		if (!targetWindow) {
			logger.warn('No owning window is available for starTab', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(targetWindow)) {
			logger.warn('webContents is not available for starTab', 'WebServer');
			return false;
		}
		targetWindow.webContents.send('remote:starTab', sessionId, tabId, starred);
		return true;
	});

	server.setReorderTabCallback(async (sessionId: string, fromIndex: number, toIndex: number) => {
		const targetWindow = resolveSessionWindow(sessionId);
		if (!targetWindow) {
			logger.warn('No owning window is available for reorderTab', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(targetWindow)) {
			logger.warn('webContents is not available for reorderTab', 'WebServer');
			return false;
		}
		targetWindow.webContents.send('remote:reorderTab', sessionId, fromIndex, toIndex);
		return true;
	});

	server.setToggleBookmarkCallback(async (sessionId: string) => {
		const targetWindow = resolveSessionWindow(sessionId);
		if (!targetWindow) {
			logger.warn('No owning window is available for toggleBookmark', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(targetWindow)) {
			logger.warn('webContents is not available for toggleBookmark', 'WebServer');
			return false;
		}
		targetWindow.webContents.send('remote:toggleBookmark', sessionId);
		return true;
	});

	server.setOpenFileTabCallback(
		async (
			sessionId: string,
			filePath: string,
			options: { background: boolean; switchToAgent: boolean }
		) => {
			const targetWindow = resolveSessionWindow(sessionId);
			if (!targetWindow) {
				logger.warn('No owning window is available for openFileTab', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(targetWindow)) {
				logger.warn('webContents is not available for openFileTab', 'WebServer');
				return false;
			}
			targetWindow.webContents.send('remote:openFileTab', sessionId, filePath, {
				background: options.background,
				switchToAgent: options.switchToAgent,
			});
			return true;
		}
	);

	server.setOpenDocumentGraphCallback(async (params) => {
		const targetWindow = resolveSessionWindow(params.sessionId);
		if (!targetWindow) {
			logger.warn('No owning window is available for openDocumentGraph', 'WebServer');
			return false;
		}
		if (!isWebContentsAvailable(targetWindow)) {
			logger.warn('webContents is not available for openDocumentGraph', 'WebServer');
			return false;
		}
		targetWindow.webContents.send('remote:openDocumentGraph', params);
		return true;
	});

	server.setRefreshFileTreeCallback(async (sessionId: string) => {
		const targetWindow = resolveSessionWindow(sessionId);
		if (!targetWindow) {
			logger.warn('No owning window is available for refreshFileTree', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(targetWindow)) {
			logger.warn('webContents is not available for refreshFileTree', 'WebServer');
			return false;
		}
		targetWindow.webContents.send('remote:refreshFileTree', sessionId);
		return true;
	});

	server.setOpenModalCallback(async (params) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for openModal', 'WebServer');
			return false;
		}
		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for openModal', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:openModal', params);
		return true;
	});
}
