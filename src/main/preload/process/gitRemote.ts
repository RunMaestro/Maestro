import { ipcRenderer } from 'electron';

export function createGitRemoteApi() {
	return {
		/**
		 * Subscribe to remote get git status from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteGetGitStatus: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) => {
				try {
					Promise.resolve(callback(sessionId, responseChannel)).catch(() => {
						ipcRenderer.send(responseChannel, { branch: '', files: [], ahead: 0, behind: 0 });
					});
				} catch {
					ipcRenderer.send(responseChannel, { branch: '', files: [], ahead: 0, behind: 0 });
				}
			};
			ipcRenderer.on('remote:getGitStatus', handler);
			return () => ipcRenderer.removeListener('remote:getGitStatus', handler);
		},

		/**
		 * Send response for remote get git status
		 */
		sendRemoteGetGitStatusResponse: (responseChannel: string, result: any): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote get git diff from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteGetGitDiff: (
			callback: (sessionId: string, filePath: string | undefined, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				filePath: string | undefined,
				responseChannel: string
			) => {
				try {
					Promise.resolve(callback(sessionId, filePath, responseChannel)).catch(() => {
						ipcRenderer.send(responseChannel, { diff: '', files: [] });
					});
				} catch {
					ipcRenderer.send(responseChannel, { diff: '', files: [] });
				}
			};
			ipcRenderer.on('remote:getGitDiff', handler);
			return () => ipcRenderer.removeListener('remote:getGitDiff', handler);
		},

		/**
		 * Send response for remote get git diff
		 */
		sendRemoteGetGitDiffResponse: (responseChannel: string, result: any): void => {
			ipcRenderer.send(responseChannel, result);
		},
	};
}
