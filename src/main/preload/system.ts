/**
 * Preload API for system operations
 *
 * Provides the window.maestro.dialog, fonts, shells, shell, tunnel, sync, devtools, power, updates, app namespaces
 */

import { ipcRenderer } from 'electron';

/**
 * Shell information
 */
export interface ShellInfo {
	id: string;
	name: string;
	available: boolean;
	path?: string;
}

/**
 * Update status from electron-updater
 */
export interface UpdateStatus {
	status:
		| 'idle'
		| 'checking'
		| 'available'
		| 'not-available'
		| 'downloading'
		| 'downloaded'
		| 'error';
	info?: { version: string };
	progress?: { percent: number; bytesPerSecond: number; total: number; transferred: number };
	error?: string;
}

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
		trashItem: (itemPath: string) => ipcRenderer.invoke('shell:trashItem', itemPath),
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
		download: (): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('updates:download'),
		install: (): Promise<void> => ipcRenderer.invoke('updates:install'),
		getStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:getStatus'),
		onStatus: (callback: (status: UpdateStatus) => void) => {
			const handler = (_: any, status: UpdateStatus) => callback(status);
			ipcRenderer.on('updates:status', handler);
			return () => ipcRenderer.removeListener('updates:status', handler);
		},
		setAllowPrerelease: (allow: boolean): Promise<void> =>
			ipcRenderer.invoke('updates:setAllowPrerelease', allow),
	};
}

/**
 * Creates the app lifecycle API object for preload exposure
 */
export function createAppApi() {
	return {
		onQuitConfirmationRequest: (callback: () => void) => {
			const handler = () => callback();
			ipcRenderer.on('app:requestQuitConfirmation', handler);
			return () => ipcRenderer.removeListener('app:requestQuitConfirmation', handler);
		},
		confirmQuit: () => {
			ipcRenderer.send('app:quitConfirmed');
		},
		cancelQuit: () => {
			ipcRenderer.send('app:quitCancelled');
		},
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
