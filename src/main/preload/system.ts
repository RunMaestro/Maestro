/**
 * Preload API for system operations
 *
 * Provides the window.maestro.dialog, fonts, shells, shell, tunnel, sync, devtools, power, updates, app namespaces
 */

import { ipcRenderer } from 'electron';
import { subscribeIpc } from './ipcSubscription';
import type { ParsedDeepLink, ShellInfo, UpdateStatus } from '../../shared/types';
export type { ShellInfo, UpdateStatus } from '../../shared/types';

/**
 * Creates the dialog API object for preload exposure
 */
export function createDialogApi() {
	return {
		selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
		saveFile: (options: {
			defaultPath?: string;
			filters?: Array<{ name: string; extensions: string[] }>;
			title?: string;
		}) => ipcRenderer.invoke('dialog:saveFile', options),
	};
}

/**
 * Creates the fonts API object for preload exposure
 */
export function createFontsApi() {
	return {
		detect: () => ipcRenderer.invoke('fonts:detect'),
	};
}

/**
 * Creates the shells API object for preload exposure
 */
export function createShellsApi() {
	return {
		detect: (): Promise<ShellInfo[]> => ipcRenderer.invoke('shells:detect'),
	};
}

/**
 * Creates the shell API object for preload exposure
 */
export function createShellApi() {
	return {
		openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
		openPath: (itemPath: string) => ipcRenderer.invoke('shell:openPath', itemPath),
		trashItem: (itemPath: string) => ipcRenderer.invoke('shell:trashItem', itemPath),
		showItemInFolder: (itemPath: string) => ipcRenderer.invoke('shell:showItemInFolder', itemPath),
		copyTextToClipboard: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
		copyImageToClipboard: (dataUrl: string) => ipcRenderer.invoke('clipboard:writeImage', dataUrl),
		readImageFromClipboard: (): Promise<string | null> => ipcRenderer.invoke('clipboard:readImage'),
	};
}

/**
 * Creates the tunnel API object for preload exposure
 */
export function createTunnelApi() {
	return {
		isCloudflaredInstalled: () => ipcRenderer.invoke('tunnel:isCloudflaredInstalled'),
		start: () => ipcRenderer.invoke('tunnel:start'),
		stop: () => ipcRenderer.invoke('tunnel:stop'),
		getStatus: () => ipcRenderer.invoke('tunnel:getStatus'),
	};
}

/**
 * Creates the sync API object for preload exposure
 */
export function createSyncApi() {
	return {
		getDefaultPath: (): Promise<string> => ipcRenderer.invoke('sync:getDefaultPath'),
		getSettings: (): Promise<{ customSyncPath?: string }> => ipcRenderer.invoke('sync:getSettings'),
		getCurrentStoragePath: (): Promise<string> => ipcRenderer.invoke('sync:getCurrentStoragePath'),
		selectSyncFolder: (): Promise<string | null> => ipcRenderer.invoke('sync:selectSyncFolder'),
		setCustomPath: (
			customPath: string | null
		): Promise<{
			success: boolean;
			migrated?: number;
			errors?: string[];
			requiresRestart?: boolean;
			error?: string;
		}> => ipcRenderer.invoke('sync:setCustomPath', customPath),
	};
}

/**
 * Creates the devtools API object for preload exposure
 */
export function createDevtoolsApi() {
	return {
		open: () => ipcRenderer.invoke('devtools:open'),
		close: () => ipcRenderer.invoke('devtools:close'),
		toggle: () => ipcRenderer.invoke('devtools:toggle'),
	};
}

/**
 * Creates the power API object for preload exposure
 */
export function createPowerApi() {
	return {
		setEnabled: (enabled: boolean): Promise<void> =>
			ipcRenderer.invoke('power:setEnabled', enabled),
		isEnabled: (): Promise<boolean> => ipcRenderer.invoke('power:isEnabled'),
		getStatus: (): Promise<{
			enabled: boolean;
			blocking: boolean;
			reasons: string[];
			platform: 'darwin' | 'win32' | 'linux';
		}> => ipcRenderer.invoke('power:getStatus'),
		addReason: (reason: string): Promise<void> => ipcRenderer.invoke('power:addReason', reason),
		removeReason: (reason: string): Promise<void> =>
			ipcRenderer.invoke('power:removeReason', reason),
	};
}

/**
 * Creates the updates API object for preload exposure
 */
export function createUpdatesApi() {
	return {
		check: (
			includePrerelease?: boolean
		): Promise<{
			currentVersion: string;
			latestVersion: string;
			updateAvailable: boolean;
			versionsBehind: number;
			releases: Array<{
				tag_name: string;
				name: string;
				body: string;
				html_url: string;
				published_at: string;
			}>;
			releasesUrl: string;
			error?: string;
		}> => ipcRenderer.invoke('updates:check', includePrerelease),
		checkin: (): Promise<void> => ipcRenderer.invoke('updates:checkin'),
		download: (targetTag?: string): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('updates:download', targetTag),
		install: (): Promise<void> => ipcRenderer.invoke('updates:install'),
		getStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:getStatus'),
		onStatus: (callback: (status: UpdateStatus) => void) =>
			subscribeIpc('updates:status', callback),
		setAllowPrerelease: (allow: boolean): Promise<void> =>
			ipcRenderer.invoke('updates:setAllowPrerelease', allow),
	};
}

/**
 * Creates the app lifecycle API object for preload exposure
 */
export function createAppApi() {
	return {
		onQuitConfirmationRequest: (callback: () => void) =>
			subscribeIpc('app:requestQuitConfirmation', callback),
		confirmQuit: () => {
			ipcRenderer.send('app:quitConfirmed');
		},
		cancelQuit: () => {
			ipcRenderer.send('app:quitCancelled');
		},
		/**
		 * Tell the main process the quit-confirmation modal is now showing and the
		 * user is deciding. Disarms the dead-renderer safety timeout so the app
		 * doesn't force-quit while the dialog is open.
		 */
		quitConfirmationPending: () => {
			ipcRenderer.send('app:quitConfirmationPending');
		},
		/**
		 * Listen for system resume event (after sleep/suspend)
		 * Used to refresh settings that may have been reset during sleep
		 */
		onSystemResume: (callback: () => void) => subscribeIpc('app:systemResume', callback),
		/**
		 * Listen for deep link navigation events (maestro:// URLs)
		 * Fired when the app is activated via a deep link from OS notification clicks,
		 * external apps, or CLI commands.
		 */
		/**
		 * Listen for keyboard shortcuts forwarded from browser tab webviews.
		 * When a webview has focus, keystrokes don't reach the renderer's window
		 * event listener, so the main process intercepts them and forwards here.
		 */
		onBrowserTabShortcutKey: (
			callback: (input: {
				key: string;
				code: string;
				meta: boolean;
				control: boolean;
				alt: boolean;
				shift: boolean;
			}) => void
		): (() => void) => subscribeIpc('browser-tab:shortcutKey', callback),
		onDeepLink: (callback: (deepLink: ParsedDeepLink) => void): (() => void) =>
			subscribeIpc('app:deepLink', callback),
		/**
		 * Listen for global hotkey registration failures (e.g. another app already
		 * owns the combo). Renderer should surface this to the user so they pick a
		 * different key.
		 */
		onGlobalHotkeyRegistrationFailed: (callback: (keys: string[]) => void): (() => void) =>
			subscribeIpc('globalHotkey:registrationFailed', callback),
	};
}

export type DialogApi = ReturnType<typeof createDialogApi>;
export type FontsApi = ReturnType<typeof createFontsApi>;
export type ShellsApi = ReturnType<typeof createShellsApi>;
export type ShellApi = ReturnType<typeof createShellApi>;
export type TunnelApi = ReturnType<typeof createTunnelApi>;
export type SyncApi = ReturnType<typeof createSyncApi>;
export type DevtoolsApi = ReturnType<typeof createDevtoolsApi>;
export type PowerApi = ReturnType<typeof createPowerApi>;
export type UpdatesApi = ReturnType<typeof createUpdatesApi>;
export type AppApi = ReturnType<typeof createAppApi>;
