import { ipcRenderer } from 'electron';

export function createSettingsRemoteApi() {
	return {
		/**
		 * Subscribe to remote set setting from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteSetSetting: (
			callback: (key: string, value: unknown, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, key: string, value: unknown, responseChannel: string) =>
				callback(key, value, responseChannel);
			ipcRenderer.on('remote:setSetting', handler);
			return () => ipcRenderer.removeListener('remote:setSetting', handler);
		},

		/**
		 * Send response for remote set setting
		 */
		sendRemoteSetSettingResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},
	};
}
