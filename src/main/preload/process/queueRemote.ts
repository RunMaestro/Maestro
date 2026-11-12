import { ipcRenderer } from 'electron';

export function createQueueRemoteApi() {
	return {
		/**
		 * Subscribe to remote "enqueue command" from the CLI (`dispatch --queue`).
		 * The renderer decides queue-vs-dispatch and must ack via
		 * sendRemoteEnqueueCommandResponse. Ack failure before rethrowing
		 * synchronous callback errors so the CLI doesn't wait for the timeout.
		 */
		onRemoteEnqueueCommand: (
			callback: (
				sessionId: string,
				command: string,
				responseChannel: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				images?: string[],
				background?: boolean
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				command: string,
				responseChannel: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				images?: string[],
				background?: boolean
			) => {
				try {
					callback(sessionId, command, responseChannel, inputMode, tabId, images, background);
				} catch (error) {
					ipcRenderer.send(responseChannel, { success: false });
					throw error;
				}
			};
			ipcRenderer.on('remote:enqueueCommand', handler);
			return () => ipcRenderer.removeListener('remote:enqueueCommand', handler);
		},

		/**
		 * Send response for remote "enqueue command". Carries the queue outcome
		 * (queued vs dispatched now, position, item id) so `maestro-cli dispatch
		 * --queue` can report status to its caller.
		 */
		sendRemoteEnqueueCommandResponse: (
			responseChannel: string,
			result: {
				success: boolean;
				tabId?: string;
				queued?: boolean;
				queuePosition?: number;
				queueLength?: number;
				itemId?: string;
				error?: string;
			}
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote "list queue" from the CLI (`queue list`). Renderer
		 * replies via sendRemoteListQueueResponse.
		 */
		onRemoteListQueue: (
			callback: (sessionId: string | undefined, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string | undefined, responseChannel: string) => {
				try {
					callback(sessionId, responseChannel);
				} catch (error) {
					ipcRenderer.send(responseChannel, { success: false, queues: [] });
					throw error;
				}
			};
			ipcRenderer.on('remote:listQueue', handler);
			return () => ipcRenderer.removeListener('remote:listQueue', handler);
		},

		sendRemoteListQueueResponse: (
			responseChannel: string,
			result: { success: boolean; queues: unknown[]; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote "remove queue item" from the CLI (`queue remove`).
		 * Renderer replies via sendRemoteRemoveQueueItemResponse.
		 */
		onRemoteRemoveQueueItem: (
			callback: (sessionId: string, itemId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, itemId: string, responseChannel: string) => {
				try {
					callback(sessionId, itemId, responseChannel);
				} catch (error) {
					ipcRenderer.send(responseChannel, { success: false, removed: false });
					throw error;
				}
			};
			ipcRenderer.on('remote:removeQueueItem', handler);
			return () => ipcRenderer.removeListener('remote:removeQueueItem', handler);
		},

		sendRemoteRemoveQueueItemResponse: (
			responseChannel: string,
			result: { success: boolean; removed: boolean; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},
	};
}
