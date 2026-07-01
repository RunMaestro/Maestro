/**
 * Preload API for cross-agent `@@mention` dispatch (Phase 03).
 *
 * Exposes `window.maestro.crossAgent`:
 * - `send(request)`  -> invoke `cross-agent:send`, returns `{ requestId }`.
 * - `onChunk(handler)` -> subscribe to streamed `cross-agent:chunk` events,
 *   returns a cleanup function.
 */

import { ipcRenderer } from 'electron';
import type {
	CrossAgentSendRequest,
	CrossAgentResponseChunk,
} from '../../shared/crossAgentTypes';

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
