import { ipcRenderer } from 'electron';

export function createAutoRunControlRemoteApi() {
	return {
		/**
		 * Subscribe to remote stop auto-run from web interface (fire-and-forget)
		 */
		onRemoteStopAutoRun: (callback: (sessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string) => callback(sessionId);
			ipcRenderer.on('remote:stopAutoRun', handler);
			return () => ipcRenderer.removeListener('remote:stopAutoRun', handler);
		},

		/**
		 * Subscribe to remote reset auto-run document tasks
		 * (request-response - renderer reads/writes the document via existing autorun IPC).
		 *
		 * On failure we ack the channel with a fallback (so the web client doesn't hang)
		 * and then rethrow so the unhandled rejection reaches Sentry via the global handler.
		 */
		onRemoteResetAutoRunDocTasks: (
			callback: (sessionId: string, filename: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				filename: string,
				responseChannel: string
			) => {
				try {
					Promise.resolve(callback(sessionId, filename, responseChannel)).catch((err) => {
						ipcRenderer.send(responseChannel, false);
						throw err;
					});
				} catch (err) {
					ipcRenderer.send(responseChannel, false);
					throw err;
				}
			};
			ipcRenderer.on('remote:resetAutoRunDocTasks', handler);
			return () => ipcRenderer.removeListener('remote:resetAutoRunDocTasks', handler);
		},

		sendRemoteResetAutoRunDocTasksResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote auto-run error-recovery actions (resume / skip-document / abort).
		 * Each action mirrors the desktop AutoRunErrorBanner buttons.
		 */
		onRemoteResumeAutoRunError: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) => {
				try {
					Promise.resolve(callback(sessionId, responseChannel)).catch((err) => {
						ipcRenderer.send(responseChannel, false);
						throw err;
					});
				} catch (err) {
					ipcRenderer.send(responseChannel, false);
					throw err;
				}
			};
			ipcRenderer.on('remote:resumeAutoRunError', handler);
			return () => ipcRenderer.removeListener('remote:resumeAutoRunError', handler);
		},

		sendRemoteResumeAutoRunErrorResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		onRemoteSkipAutoRunDocument: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) => {
				try {
					Promise.resolve(callback(sessionId, responseChannel)).catch((err) => {
						ipcRenderer.send(responseChannel, false);
						throw err;
					});
				} catch (err) {
					ipcRenderer.send(responseChannel, false);
					throw err;
				}
			};
			ipcRenderer.on('remote:skipAutoRunDocument', handler);
			return () => ipcRenderer.removeListener('remote:skipAutoRunDocument', handler);
		},

		sendRemoteSkipAutoRunDocumentResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		onRemoteAbortAutoRunError: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) => {
				try {
					Promise.resolve(callback(sessionId, responseChannel)).catch((err) => {
						ipcRenderer.send(responseChannel, false);
						throw err;
					});
				} catch (err) {
					ipcRenderer.send(responseChannel, false);
					throw err;
				}
			};
			ipcRenderer.on('remote:abortAutoRunError', handler);
			return () => ipcRenderer.removeListener('remote:abortAutoRunError', handler);
		},

		sendRemoteAbortAutoRunErrorResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},
	};
}
