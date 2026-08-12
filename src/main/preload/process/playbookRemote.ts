import { ipcRenderer } from 'electron';

/**
 * Subscribe to remote playbook CRUD from web interface (request-response).
 * Renderer forwards to window.maestro.playbooks.* IPC and replies on the channel.
 *
 * Failure handling: each handler acks the IPC channel with a neutral
 * fallback (`[]` / `null` / `false`) so the web client doesn't hang on a
 * regression, and rethrows the error so Sentry's global unhandled-rejection
 * hook still reports the cause. The web UI currently can't distinguish a
 * legitimate empty list from a transport failure with this shape - a
 * follow-up will move these to the structured `{ success, error }` payload
 * used by `onRemoteSetAutoRunFolder` (tracked in the AutoRun follow-up gist).
 */
export function createPlaybookRemoteApi() {
	return {
		onRemoteListPlaybooks: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) => {
				try {
					Promise.resolve(callback(sessionId, responseChannel)).catch((err) => {
						ipcRenderer.send(responseChannel, []);
						throw err;
					});
				} catch (err) {
					ipcRenderer.send(responseChannel, []);
					throw err;
				}
			};
			ipcRenderer.on('remote:listPlaybooks', handler);
			return () => ipcRenderer.removeListener('remote:listPlaybooks', handler);
		},

		sendRemoteListPlaybooksResponse: (responseChannel: string, playbooks: unknown[]): void => {
			ipcRenderer.send(responseChannel, playbooks);
		},

		onRemoteCreatePlaybook: (
			callback: (sessionId: string, playbook: unknown, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				playbook: unknown,
				responseChannel: string
			) => {
				try {
					Promise.resolve(callback(sessionId, playbook, responseChannel)).catch((err) => {
						ipcRenderer.send(responseChannel, null);
						throw err;
					});
				} catch (err) {
					ipcRenderer.send(responseChannel, null);
					throw err;
				}
			};
			ipcRenderer.on('remote:createPlaybook', handler);
			return () => ipcRenderer.removeListener('remote:createPlaybook', handler);
		},

		sendRemoteCreatePlaybookResponse: (responseChannel: string, playbook: unknown): void => {
			ipcRenderer.send(responseChannel, playbook);
		},

		onRemoteUpdatePlaybook: (
			callback: (
				sessionId: string,
				playbookId: string,
				updates: unknown,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				playbookId: string,
				updates: unknown,
				responseChannel: string
			) => {
				try {
					Promise.resolve(callback(sessionId, playbookId, updates, responseChannel)).catch(
						(err) => {
							ipcRenderer.send(responseChannel, null);
							throw err;
						}
					);
				} catch (err) {
					ipcRenderer.send(responseChannel, null);
					throw err;
				}
			};
			ipcRenderer.on('remote:updatePlaybook', handler);
			return () => ipcRenderer.removeListener('remote:updatePlaybook', handler);
		},

		sendRemoteUpdatePlaybookResponse: (responseChannel: string, playbook: unknown): void => {
			ipcRenderer.send(responseChannel, playbook);
		},

		onRemoteDeletePlaybook: (
			callback: (sessionId: string, playbookId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				playbookId: string,
				responseChannel: string
			) => {
				try {
					Promise.resolve(callback(sessionId, playbookId, responseChannel)).catch((err) => {
						ipcRenderer.send(responseChannel, false);
						throw err;
					});
				} catch (err) {
					ipcRenderer.send(responseChannel, false);
					throw err;
				}
			};
			ipcRenderer.on('remote:deletePlaybook', handler);
			return () => ipcRenderer.removeListener('remote:deletePlaybook', handler);
		},

		sendRemoteDeletePlaybookResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},
	};
}
