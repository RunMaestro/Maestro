import { ipcRenderer } from 'electron';
import type { AutoRunBroadcastState } from '../../../shared/autoRunBroadcast';
import type {
	SteeringCommandRequest,
	SteeringCommandResult,
} from '../../../shared/autoRunSteeringCommands';

export function createAutoRunControlRemoteApi() {
	return {
		/**
		 * Subscribe to Auto Run state belonging to a DIFFERENT Maestro client.
		 *
		 * Two producers feed this one channel. In the web-desktop (browser) build
		 * the WebSocket shim maps the server's `autorun_state` packet onto it. In
		 * the Electron desktop app main sends it directly, for a run owned by a
		 * browser tab - the desktop is not a WebSocket client, so without that
		 * forward a web-started run was invisible here for its whole duration
		 * (issue #1519).
		 *
		 * A window is never sent its own run back, so the owner keeps its
		 * controls; see `forwardAutoRunStateToDesktopWindows` in
		 * `main/ipc/handlers/web.ts`.
		 */
		onRemoteAutoRunStateMirror: (
			callback: (sessionId: string, state: AutoRunBroadcastState | null) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, state: AutoRunBroadcastState | null) =>
				callback(sessionId, state);
			ipcRenderer.on('remote:autoRunStateMirror', handler);
			return () => ipcRenderer.removeListener('remote:autoRunStateMirror', handler);
		},

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

		/**
		 * Subscribe to a remote Auto Run steering verb (`maestro-cli steer-auto-run`).
		 *
		 * A round trip rather than a fire-and-forget send: every verb answers the
		 * caller with the note it parked or took back, or with the run's notes
		 * and replies, so the response channel is part of the contract.
		 */
		onRemoteAutoRunSteeringCommand: (
			callback: (request: SteeringCommandRequest, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, request: SteeringCommandRequest, responseChannel: string) =>
				callback(request, responseChannel);
			ipcRenderer.on('remote:autoRunSteeringCommand', handler);
			return () => ipcRenderer.removeListener('remote:autoRunSteeringCommand', handler);
		},

		sendRemoteAutoRunSteeringCommandResponse: (
			responseChannel: string,
			result: SteeringCommandResult
		): void => {
			ipcRenderer.send(responseChannel, result);
		},
	};
}
