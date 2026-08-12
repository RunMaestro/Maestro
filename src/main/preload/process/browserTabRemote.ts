import { ipcRenderer } from 'electron';

export function createBrowserTabRemoteApi() {
	return {
		/**
		 * Subscribe to remote open browser tab from CLI/web interface.
		 * Renderer must ack success via sendRemoteOpenBrowserTabResponse.
		 * If the callback throws synchronously, ack false first so the CLI
		 * doesn't wait for the 5s response timeout, then rethrow for Sentry.
		 */
		onRemoteOpenBrowserTab: (
			callback: (sessionId: string, url: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, url: string, responseChannel: string) => {
				try {
					callback(sessionId, url, responseChannel);
				} catch (error) {
					ipcRenderer.send(responseChannel, false);
					throw error;
				}
			};
			ipcRenderer.on('remote:openBrowserTab', handler);
			return () => ipcRenderer.removeListener('remote:openBrowserTab', handler);
		},

		/**
		 * Send response for remote open browser tab
		 */
		sendRemoteOpenBrowserTabResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote open terminal tab from CLI/web interface.
		 * Renderer must ack success via sendRemoteOpenTerminalTabResponse.
		 * Ack false before rethrowing synchronous callback errors so the CLI
		 * doesn't wait for the 5s response timeout.
		 */
		onRemoteOpenTerminalTab: (
			callback: (
				sessionId: string,
				config: { cwd?: string; shell?: string; name?: string | null },
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				config: { cwd?: string; shell?: string; name?: string | null },
				responseChannel: string
			) => {
				try {
					callback(sessionId, config, responseChannel);
				} catch (error) {
					ipcRenderer.send(responseChannel, false);
					throw error;
				}
			};
			ipcRenderer.on('remote:openTerminalTab', handler);
			return () => ipcRenderer.removeListener('remote:openTerminalTab', handler);
		},

		/**
		 * Send response for remote open terminal tab
		 */
		sendRemoteOpenTerminalTabResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote "new AI tab with prompt" from CLI/web interface.
		 * Renderer must ack success via sendRemoteNewAITabWithPromptResponse.
		 * Ack false before rethrowing synchronous callback errors so the CLI
		 * doesn't wait for the 5s response timeout.
		 */
		onRemoteNewAITabWithPrompt: (
			callback: (
				sessionId: string,
				prompt: string,
				responseChannel: string,
				background?: boolean
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				prompt: string,
				responseChannel: string,
				background?: boolean
			) => {
				try {
					callback(sessionId, prompt, responseChannel, background);
				} catch (error) {
					ipcRenderer.send(responseChannel, false);
					throw error;
				}
			};
			ipcRenderer.on('remote:newAITabWithPrompt', handler);
			return () => ipcRenderer.removeListener('remote:newAITabWithPrompt', handler);
		},

		/**
		 * Send response for remote "new AI tab with prompt".
		 * `tabId` is the id of the freshly-created tab - surfaced so
		 * `maestro-cli dispatch --new-tab` can return an addressable id to its
		 * caller without owning a persistent channel.
		 */
		sendRemoteNewAITabWithPromptResponse: (
			responseChannel: string,
			success: boolean,
			tabId?: string
		): void => {
			ipcRenderer.send(responseChannel, { success, tabId });
		},
	};
}
