import { ipcRenderer } from 'electron';

export function createAutoRunConfigRemoteApi() {
	return {
		/**
		 * Subscribe to remote refresh auto-run docs from web interface
		 */
		onRemoteRefreshAutoRunDocs: (callback: (sessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string) => callback(sessionId);
			ipcRenderer.on('remote:refreshAutoRunDocs', handler);
			return () => ipcRenderer.removeListener('remote:refreshAutoRunDocs', handler);
		},

		/**
		 * Subscribe to remote configure auto-run from CLI/web interface
		 */
		onRemoteConfigureAutoRun: (
			callback: (sessionId: string, config: any, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, config: any, responseChannel: string) => {
				try {
					// callback may return a promise even though typed as void
					Promise.resolve(callback(sessionId, config, responseChannel)).catch((error) => {
						ipcRenderer.send(responseChannel, {
							success: false,
							error: error instanceof Error ? error.message : String(error),
						});
					});
				} catch (error) {
					ipcRenderer.send(responseChannel, {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			};
			ipcRenderer.on('remote:configureAutoRun', handler);
			return () => ipcRenderer.removeListener('remote:configureAutoRun', handler);
		},

		/**
		 * Send response for remote configure auto-run
		 */
		sendRemoteConfigureAutoRunResponse: (
			responseChannel: string,
			result: { success: boolean; playbookId?: string; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to a remote Goal-Driven Auto Run launch (`goal-run --visible`).
		 * Mirrors `onRemoteConfigureAutoRun`, but carries the goal config instead
		 * of a document list.
		 */
		onRemoteLaunchGoalRun: (
			callback: (
				sessionId: string,
				config: {
					goal: string;
					exitCriteria?: string;
					maxIterations?: number | null;
					model?: string;
					effort?: string;
				},
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				config: {
					goal: string;
					exitCriteria?: string;
					maxIterations?: number | null;
					model?: string;
					effort?: string;
				},
				responseChannel: string
			) => {
				// Ack with a failure so the CLI never hangs on a renderer regression,
				// then rethrow so Sentry still sees the bug (same shape as
				// `onRemoteSetAutoRunFolder`).
				try {
					Promise.resolve(callback(sessionId, config, responseChannel)).catch((error) => {
						ipcRenderer.send(responseChannel, {
							success: false,
							code: 'LAUNCH_FAILED',
							error: error instanceof Error ? error.message : String(error),
						});
						throw error;
					});
				} catch (error) {
					ipcRenderer.send(responseChannel, {
						success: false,
						code: 'LAUNCH_FAILED',
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
			};
			ipcRenderer.on('remote:launchGoalRun', handler);
			return () => ipcRenderer.removeListener('remote:launchGoalRun', handler);
		},

		/**
		 * Send response for a remote Goal-Driven Auto Run launch
		 */
		sendRemoteLaunchGoalRunResponse: (
			responseChannel: string,
			result: { success: boolean; tabId?: string; code?: string; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote set Auto Run folder from web interface
		 * (request-response). Web clients use this to repoint a session at a
		 * different `.maestro/` folder, mirroring desktop's `dialog.selectFolder`
		 * + `handleAutoRunFolderSelected` flow.
		 */
		onRemoteSetAutoRunFolder: (
			callback: (sessionId: string, folderPath: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				folderPath: string,
				responseChannel: string
			) => {
				// Ack the response with a fallback so the web client doesn't hang on
				// a regression, then rethrow so Sentry actually sees the bug instead
				// of silently degrading. Mirrors `onRemoteOpenBrowserTab`'s pattern.
				try {
					Promise.resolve(callback(sessionId, folderPath, responseChannel)).catch((error) => {
						ipcRenderer.send(responseChannel, {
							success: false,
							error: error instanceof Error ? error.message : String(error),
						});
						throw error;
					});
				} catch (error) {
					ipcRenderer.send(responseChannel, {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
			};
			ipcRenderer.on('remote:setAutoRunFolder', handler);
			return () => ipcRenderer.removeListener('remote:setAutoRunFolder', handler);
		},

		/**
		 * Send response for remote set Auto Run folder
		 */
		sendRemoteSetAutoRunFolderResponse: (
			responseChannel: string,
			result: { success: boolean; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote get auto-run docs from web interface (request-response)
		 */
		onRemoteGetAutoRunDocs: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) => {
				try {
					Promise.resolve(callback(sessionId, responseChannel)).catch(() => {
						ipcRenderer.send(responseChannel, []);
					});
				} catch {
					ipcRenderer.send(responseChannel, []);
				}
			};
			ipcRenderer.on('remote:getAutoRunDocs', handler);
			return () => ipcRenderer.removeListener('remote:getAutoRunDocs', handler);
		},

		/**
		 * Send response for remote get auto-run docs
		 */
		sendRemoteGetAutoRunDocsResponse: (responseChannel: string, documents: any[]): void => {
			ipcRenderer.send(responseChannel, documents);
		},

		/**
		 * Subscribe to remote get auto-run doc content from web interface (request-response)
		 */
		onRemoteGetAutoRunDocContent: (
			callback: (sessionId: string, filename: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				filename: string,
				responseChannel: string
			) => {
				try {
					Promise.resolve(callback(sessionId, filename, responseChannel)).catch(() => {
						ipcRenderer.send(responseChannel, '');
					});
				} catch {
					ipcRenderer.send(responseChannel, '');
				}
			};
			ipcRenderer.on('remote:getAutoRunDocContent', handler);
			return () => ipcRenderer.removeListener('remote:getAutoRunDocContent', handler);
		},

		/**
		 * Send response for remote get auto-run doc content
		 */
		sendRemoteGetAutoRunDocContentResponse: (responseChannel: string, content: string): void => {
			ipcRenderer.send(responseChannel, content);
		},

		/**
		 * Subscribe to remote save auto-run doc from web interface (request-response)
		 */
		onRemoteSaveAutoRunDoc: (
			callback: (
				sessionId: string,
				filename: string,
				content: string,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				filename: string,
				content: string,
				responseChannel: string
			) => {
				try {
					Promise.resolve(callback(sessionId, filename, content, responseChannel)).catch(() => {
						ipcRenderer.send(responseChannel, false);
					});
				} catch {
					ipcRenderer.send(responseChannel, false);
				}
			};
			ipcRenderer.on('remote:saveAutoRunDoc', handler);
			return () => ipcRenderer.removeListener('remote:saveAutoRunDoc', handler);
		},

		/**
		 * Send response for remote save auto-run doc
		 */
		sendRemoteSaveAutoRunDocResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},
	};
}
