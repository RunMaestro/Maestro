/** Loaded solely by the trusted confirmation window, never the SPA or a plugin. */
import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld(
	'pluginConfirmation',
	Object.freeze({
		getOffer: () => ipcRenderer.invoke('plugin-confirmation:offer'),
		confirm: (nonce: string, approved: boolean, password?: string) =>
			ipcRenderer.invoke('plugin-confirmation:call', {
				nonce,
				approved,
				...(password === undefined ? {} : { password }),
			}),
	})
);
