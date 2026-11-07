import { ipcRenderer } from 'electron';
import type { CreateGistResult } from '../../../shared/gitUtils';

export function createGistRemoteApi() {
	return {
		/**
		 * Subscribe to remote create-gist requests from the web/CLI interface.
		 * Uses request-response pattern with a unique responseChannel. Ack a
		 * structured failure before rethrowing synchronous callback errors so
		 * the CLI doesn't wait for the 60s response timeout.
		 */
		onRemoteCreateGist: (
			callback: (
				sessionId: string,
				description: string,
				isPublic: boolean,
				agentSessionId: string | undefined,
				allowSecrets: boolean,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				description: string,
				isPublic: boolean,
				agentSessionId: string | undefined,
				allowSecrets: boolean,
				responseChannel: string
			) => {
				try {
					callback(sessionId, description, isPublic, agentSessionId, allowSecrets, responseChannel);
				} catch (error) {
					ipcRenderer.send(responseChannel, {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
			};
			ipcRenderer.on('remote:createGist', handler);
			return () => ipcRenderer.removeListener('remote:createGist', handler);
		},

		/**
		 * Send response for remote create-gist
		 */
		sendRemoteCreateGistResponse: (responseChannel: string, result: CreateGistResult): void => {
			ipcRenderer.send(responseChannel, result);
		},
	};
}
