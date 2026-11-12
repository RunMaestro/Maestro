import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import type {
	QueueSessionSnapshot,
	EnqueueCommandResult,
	EnqueueCommandFailureReason,
} from '../types';

/** Known machine-readable enqueue failure causes, in the order the renderer's
 *  `remote:enqueueCommand` handler can produce them. */
const ENQUEUE_FAILURE_REASONS: readonly EnqueueCommandFailureReason[] = [
	'session-not-found',
	'tab-not-found',
	'no-ai-tabs',
];

/**
 * Narrow the renderer's `reason` field to a known cause. Anything else (an old
 * renderer that does not send one, or a value we do not recognise) becomes
 * `undefined` so callers fall back to their generic failure path rather than
 * acting on a reason they cannot interpret.
 */
function parseEnqueueFailureReason(raw: unknown): EnqueueCommandFailureReason | undefined {
	return ENQUEUE_FAILURE_REASONS.find((reason) => reason === raw);
}

export function registerQueueCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;

	// Round-trip the CLI's `dispatch --queue` into the renderer, which owns
	// the authoritative execution queue. The renderer decides (busy -> queue,
	// idle -> dispatch now) and replies with the queue outcome so the CLI can
	// report position. Mirrors setNewAITabWithPromptCallback's responseChannel
	// pattern (ipcMain.once + timeout).
	server.setEnqueueCommandCallback(
		async (
			sessionId: string,
			command: string,
			inputMode?: 'ai' | 'terminal',
			tabId?: string,
			images?: string[],
			background?: boolean
		) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for enqueueCommand', 'WebServer');
				return { success: false, error: 'Desktop window unavailable' };
			}

			return new Promise<EnqueueCommandResult>((resolve) => {
				const responseChannel = `remote:enqueueCommand:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					if (typeof result === 'object' && result !== null) {
						const r = result as Record<string, unknown>;
						resolve({
							success: r.success === true,
							tabId: typeof r.tabId === 'string' ? r.tabId : undefined,
							queued: typeof r.queued === 'boolean' ? r.queued : undefined,
							queuePosition: typeof r.queuePosition === 'number' ? r.queuePosition : undefined,
							queueLength: typeof r.queueLength === 'number' ? r.queueLength : undefined,
							itemId: typeof r.itemId === 'string' ? r.itemId : undefined,
							error: typeof r.error === 'string' ? r.error : undefined,
							reason: parseEnqueueFailureReason(r.reason),
						});
					} else {
						resolve({ success: false });
					}
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for enqueueCommand', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false, error: 'Desktop window unavailable' });
					return;
				}
				mainWindow.webContents.send(
					'remote:enqueueCommand',
					sessionId,
					command,
					responseChannel,
					inputMode,
					tabId,
					images,
					background
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`enqueueCommand callback timed out for session ${sessionId}`, 'WebServer');
					resolve({ success: false, error: 'Renderer did not respond' });
				}, 5000);
			});
		}
	);

	// Round-trip `maestro-cli queue list` into the renderer, which owns the
	// authoritative execution queue. Mirrors the enqueue responseChannel pattern.
	server.setListQueueCallback(async (sessionId?: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for listQueue', 'WebServer');
			return { success: false, queues: [], error: 'Desktop window unavailable' };
		}
		return new Promise<{ success: boolean; queues: QueueSessionSnapshot[]; error?: string }>(
			(resolve) => {
				const responseChannel = `remote:listQueue:response:${randomUUID()}`;
				let resolved = false;
				const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					if (typeof result === 'object' && result !== null) {
						const r = result as Record<string, unknown>;
						// IPC boundary: the renderer builds QueueSessionSnapshot[]; trust the shape.
						const queues = (Array.isArray(r.queues) ? r.queues : []) as QueueSessionSnapshot[];
						resolve({
							success: r.success === true,
							queues,
							error: typeof r.error === 'string' ? r.error : undefined,
						});
					} else {
						resolve({ success: false, queues: [] });
					}
				};
				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false, queues: [], error: 'Desktop window unavailable' });
					return;
				}
				mainWindow.webContents.send('remote:listQueue', sessionId, responseChannel);
				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false, queues: [], error: 'Renderer did not respond' });
				}, 5000);
			}
		);
	});

	// Round-trip `maestro-cli queue remove <itemId>` into the renderer.
	server.setRemoveQueueItemCallback(async (sessionId: string, itemId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for removeQueueItem', 'WebServer');
			return { success: false, removed: false, error: 'Desktop window unavailable' };
		}
		return new Promise<{ success: boolean; removed: boolean; error?: string }>((resolve) => {
			const responseChannel = `remote:removeQueueItem:response:${randomUUID()}`;
			let resolved = false;
			const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				if (typeof result === 'object' && result !== null) {
					const r = result as Record<string, unknown>;
					resolve({
						success: r.success === true,
						removed: r.removed === true,
						error: typeof r.error === 'string' ? r.error : undefined,
					});
				} else {
					resolve({ success: false, removed: false });
				}
			};
			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve({ success: false, removed: false, error: 'Desktop window unavailable' });
				return;
			}
			mainWindow.webContents.send('remote:removeQueueItem', sessionId, itemId, responseChannel);
			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve({ success: false, removed: false, error: 'Renderer did not respond' });
			}, 5000);
		});
	});
}
