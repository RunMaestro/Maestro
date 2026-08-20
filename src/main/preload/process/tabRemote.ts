import { ipcRenderer } from 'electron';

export function createTabRemoteApi() {
	return {
		/**
		 * Subscribe to remote tab selection from web interface
		 */
		onRemoteSelectTab: (callback: (sessionId: string, tabId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, tabId: string) => callback(sessionId, tabId);
			ipcRenderer.on('remote:selectTab', handler);
			return () => ipcRenderer.removeListener('remote:selectTab', handler);
		},

		/**
		 * Subscribe to remote new tab from web interface
		 */
		onRemoteNewTab: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) =>
				callback(sessionId, responseChannel);
			ipcRenderer.on('remote:newTab', handler);
			return () => ipcRenderer.removeListener('remote:newTab', handler);
		},

		/**
		 * Send response for remote new tab
		 */
		sendRemoteNewTabResponse: (responseChannel: string, result: { tabId: string } | null): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote close tab from web interface
		 */
		onRemoteCloseTab: (callback: (sessionId: string, tabId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, tabId: string) => callback(sessionId, tabId);
			ipcRenderer.on('remote:closeTab', handler);
			return () => ipcRenderer.removeListener('remote:closeTab', handler);
		},

		/**
		 * Subscribe to remote rename tab from web interface
		 */
		onRemoteRenameTab: (
			callback: (sessionId: string, tabId: string, newName: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, tabId: string, newName: string) =>
				callback(sessionId, tabId, newName);
			ipcRenderer.on('remote:renameTab', handler);
			return () => ipcRenderer.removeListener('remote:renameTab', handler);
		},

		/**
		 * Subscribe to remote star tab from web interface
		 */
		onRemoteStarTab: (
			callback: (sessionId: string, tabId: string, starred: boolean) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, tabId: string, starred: boolean) =>
				callback(sessionId, tabId, starred);
			ipcRenderer.on('remote:starTab', handler);
			return () => ipcRenderer.removeListener('remote:starTab', handler);
		},

		/**
		 * Subscribe to remote reorder tab from web interface
		 */
		onRemoteReorderTab: (
			callback: (sessionId: string, fromIndex: number, toIndex: number) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, fromIndex: number, toIndex: number) =>
				callback(sessionId, fromIndex, toIndex);
			ipcRenderer.on('remote:reorderTab', handler);
			return () => ipcRenderer.removeListener('remote:reorderTab', handler);
		},

		/**
		 * Subscribe to remote bookmark toggle from web interface
		 */
		onRemoteToggleBookmark: (callback: (sessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string) => callback(sessionId);
			ipcRenderer.on('remote:toggleBookmark', handler);
			return () => ipcRenderer.removeListener('remote:toggleBookmark', handler);
		},

		/**
		 * Subscribe to remote open file tab from web interface.
		 * `switchToAgent` controls whether the UI switches to the target agent
		 * (defaults to true if the sender omits it).
		 */
		onRemoteOpenFileTab: (
			callback: (sessionId: string, filePath: string, switchToAgent: boolean) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, filePath: string, switchToAgent?: boolean) =>
				callback(sessionId, filePath, switchToAgent !== false);
			ipcRenderer.on('remote:openFileTab', handler);
			return () => ipcRenderer.removeListener('remote:openFileTab', handler);
		},

		/**
		 * Subscribe to remote refresh file tree from web interface
		 */
		onRemoteRefreshFileTree: (callback: (sessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string) => callback(sessionId);
			ipcRenderer.on('remote:refreshFileTree', handler);
			return () => ipcRenderer.removeListener('remote:refreshFileTree', handler);
		},

		/**
		 * Subscribe to a remote request to open one of the app's modals /
		 * dashboards (from `maestro-cli open`). `surface` is a `UiSurface.id`
		 * and `tab` (when present) has already been validated against it in
		 * the main process.
		 */
		onRemoteOpenModal: (
			callback: (params: { surface: string; tab?: string }) => void
		): (() => void) => {
			const handler = (_: unknown, params: { surface: string; tab?: string }) => callback(params);
			ipcRenderer.on('remote:openModal', handler);
			return () => ipcRenderer.removeListener('remote:openModal', handler);
		},
	};
}
