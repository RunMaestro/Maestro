const { contextBridge, ipcRenderer } = require('electron');
// Test-only adversarial capability. Production preloads are still loaded unchanged.
// Even a renderer with arbitrary invoke access must fail the native sender/frame guard.
contextBridge.exposeInMainWorld('__nativeProbe', {
	invoke: async (channel, action, payload) => {
		try {
			return { value: await ipcRenderer.invoke(channel, action, payload) };
		} catch (error) {
			return { error: error.message };
		}
	},
	isMainFrame: process.isMainFrame,
});
