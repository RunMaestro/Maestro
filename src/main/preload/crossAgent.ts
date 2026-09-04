/**
 * Preload API for cross-agent `@mention` dispatch (Phase 03).
 *
 * Exposes `window.maestro.crossAgent`:
 * - `send(request)`  -> invoke `cross-agent:send`, returns `{ requestId }`.
 * - `cancel(sourceSessionId)` -> invoke `cross-agent:cancel`, stopping every
 *   consult that agent still has in flight (Stop).
 * - `onChunk(handler)` -> subscribe to streamed `cross-agent:chunk` events,
 *   returns a cleanup function.
 */

import { ipcRenderer } from 'electron';
import type { CrossAgentSendRequest, CrossAgentResponseChunk } from '../../shared/crossAgentTypes';

/**
 * Creates the cross-agent API object for preload exposure.
 */
export function createCrossAgentApi() {
	return {
		/**
		 * Dispatch a cross-agent request. Non-blocking: the target agent's response
		 * streams back via {@link onChunk}, correlated by the returned `requestId`.
		 */
		send: (request: CrossAgentSendRequest): Promise<{ requestId: string }> =>
			ipcRenderer.invoke('cross-agent:send', request),

		/**
		 * Stop every consult a source agent still has in flight (the Stop button).
		 * Each one settles with a terminal `canceled` chunk, so the response bubbles
		 * and the "N agents responding" indicator both close out.
		 */
		cancel: (sourceSessionId: string): Promise<{ canceled: number }> =>
			ipcRenderer.invoke('cross-agent:cancel', { sourceSessionId }),

		/**
		 * Subscribe to streamed cross-agent response chunks.
		 * @returns Cleanup function to unsubscribe.
		 */
		onChunk: (handler: (chunk: CrossAgentResponseChunk) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, chunk: CrossAgentResponseChunk) =>
				handler(chunk);
			ipcRenderer.on('cross-agent:chunk', wrappedHandler);
			return () => ipcRenderer.removeListener('cross-agent:chunk', wrappedHandler);
		},
	};
}

/**
 * TypeScript type for the cross-agent API.
 */
export type CrossAgentApi = ReturnType<typeof createCrossAgentApi>;
