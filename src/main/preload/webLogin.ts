/**
 * Preload API for Web Login account management (`window.maestro.webLogin`).
 *
 * Mirrors the six `webLogin:*` channels registered in
 * `src/main/ipc/handlers/webLogin.ts`. Desktop-only by construction: the
 * web-desktop bridge refuses every one of these channels, so this namespace
 * exists but answers nothing in a browser.
 */

import { ipcRenderer } from 'electron';
import type { WebUserPublic } from '../../shared/webLogin';

/** Creates the Web Login API object for contextBridge exposure. */
export function createWebLoginApi() {
	return {
		listUsers: (): Promise<WebUserPublic[]> => ipcRenderer.invoke('webLogin:listUsers'),
		createUser: (input: {
			username: string;
			password: string;
			displayName?: string;
		}): Promise<WebUserPublic> => ipcRenderer.invoke('webLogin:createUser', input),
		setPassword: (id: string, password: string): Promise<void> =>
			ipcRenderer.invoke('webLogin:setPassword', id, password),
		setDisplayName: (id: string, displayName: string): Promise<WebUserPublic> =>
			ipcRenderer.invoke('webLogin:setDisplayName', id, displayName),
		setDisabled: (id: string, disabled: boolean): Promise<WebUserPublic> =>
			ipcRenderer.invoke('webLogin:setDisabled', id, disabled),
		deleteUser: (id: string): Promise<void> => ipcRenderer.invoke('webLogin:deleteUser', id),
	};
}

export type WebLoginApi = ReturnType<typeof createWebLoginApi>;
