import { ipcRenderer } from 'electron';

export function createContextOpsRemoteApi() {
	return {
		/**
		 * Subscribe to remote merge context from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteMergeContext: (
			callback: (sourceSessionId: string, targetSessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sourceSessionId: string,
				targetSessionId: string,
				responseChannel: string
			) => callback(sourceSessionId, targetSessionId, responseChannel);
			ipcRenderer.on('remote:mergeContext', handler);
			return () => ipcRenderer.removeListener('remote:mergeContext', handler);
		},

		/**
		 * Send response for remote merge context
		 */
		sendRemoteMergeContextResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote transfer context from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteTransferContext: (
			callback: (sourceSessionId: string, targetSessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sourceSessionId: string,
				targetSessionId: string,
				responseChannel: string
			) => callback(sourceSessionId, targetSessionId, responseChannel);
			ipcRenderer.on('remote:transferContext', handler);
			return () => ipcRenderer.removeListener('remote:transferContext', handler);
		},

		/**
		 * Send response for remote transfer context
		 */
		sendRemoteTransferContextResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote summarize context from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteSummarizeContext: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) =>
				callback(sessionId, responseChannel);
			ipcRenderer.on('remote:summarizeContext', handler);
			return () => ipcRenderer.removeListener('remote:summarizeContext', handler);
		},

		/**
		 * Send response for remote summarize context
		 */
		sendRemoteSummarizeContextResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},
	};
}
