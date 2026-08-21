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
			callback: (
				sessionId: string,
				url: string,
				responseChannel: string,
				options: { background?: boolean }
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				url: string,
				responseChannel: string,
				options?: { background?: boolean }
			) => {
				try {
					callback(sessionId, url, responseChannel, options ?? {});
				} catch (error) {
					ipcRenderer.send(responseChannel, { success: false });
					throw error;
				}
			};
			ipcRenderer.on('remote:openBrowserTab', handler);
			return () => ipcRenderer.removeListener('remote:openBrowserTab', handler);
		},

		/**
		 * Send response for remote open browser tab. The tab id lets the caller
		 * close the tab again later (see `sendRemoteCloseBrowserTabResponse`).
		 */
		sendRemoteOpenBrowserTabResponse: (
			responseChannel: string,
			success: boolean,
			tabId?: string
		): void => {
			ipcRenderer.send(responseChannel, { success, tabId });
		},

		/**
		 * Subscribe to remote close browser tab from CLI/web interface.
		 * Renderer must ack via sendRemoteCloseBrowserTabResponse.
		 */
		onRemoteCloseBrowserTab: (
			callback: (tabId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, tabId: string, responseChannel: string) => {
				try {
					callback(tabId, responseChannel);
				} catch (error) {
					ipcRenderer.send(responseChannel, false);
					throw error;
				}
			};
			ipcRenderer.on('remote:closeBrowserTab', handler);
			return () => ipcRenderer.removeListener('remote:closeBrowserTab', handler);
		},

		/**
		 * Send response for remote close browser tab
		 */
		sendRemoteCloseBrowserTabResponse: (responseChannel: string, success: boolean): void => {
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
				config: { cwd?: string; shell?: string; name?: string | null; command?: string },
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				config: { cwd?: string; shell?: string; name?: string | null; command?: string },
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
		sendRemoteOpenTerminalTabResponse: (
			responseChannel: string,
			success: boolean,
			tabId?: string
		): void => {
			ipcRenderer.send(responseChannel, { success, tabId });
		},

		/**
		 * Subscribe to remote writes into an existing terminal tab from CLI/web
		 * interface. Renderer must ack via sendRemoteWriteTerminalTabResponse.
		 */
		onRemoteWriteTerminalTab: (
			callback: (
				sessionId: string,
				payload: { tabRef?: string; data: string },
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				payload: { tabRef?: string; data: string },
				responseChannel: string
			) => {
				try {
					callback(sessionId, payload, responseChannel);
				} catch (error) {
					ipcRenderer.send(responseChannel, { success: false, error: 'Renderer error' });
					throw error;
				}
			};
			ipcRenderer.on('remote:writeTerminalTab', handler);
			return () => ipcRenderer.removeListener('remote:writeTerminalTab', handler);
		},

		/**
		 * Send response for a remote terminal write. The resolved tab is echoed
		 * back so the CLI can report which terminal actually received the command.
		 */
		sendRemoteWriteTerminalTabResponse: (
			responseChannel: string,
			success: boolean,
			result?: { error?: string; tabId?: string; tabName?: string }
		): void => {
			ipcRenderer.send(responseChannel, { success, ...result });
		},

		/**
		 * Subscribe to remote terminal tab listing from CLI/web interface.
		 */
		onRemoteListTerminalTabs: (
			callback: (sessionId: string | undefined, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string | undefined, responseChannel: string) => {
				try {
					callback(sessionId, responseChannel);
				} catch (error) {
					ipcRenderer.send(responseChannel, []);
					throw error;
				}
			};
			ipcRenderer.on('remote:listTerminalTabs', handler);
			return () => ipcRenderer.removeListener('remote:listTerminalTabs', handler);
		},

		/**
		 * Send response for a remote terminal tab listing.
		 */
		sendRemoteListTerminalTabsResponse: (responseChannel: string, tabs: unknown[]): void => {
			ipcRenderer.send(responseChannel, tabs);
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
