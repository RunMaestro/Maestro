import { ipcRenderer } from 'electron';

export function createSessionCrudRemoteApi() {
	return {
		/**
		 * Subscribe to remote create-worktree-agent from the CLI. Creates a new
		 * agent in a git worktree branched off a parent agent, without Auto Run.
		 */
		onRemoteCreateWorktreeSession: (
			callback: (parentSessionId: string, config: any, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				parentSessionId: string,
				config: any,
				responseChannel: string
			) => {
				try {
					// callback may return a promise even though typed as void
					Promise.resolve(callback(parentSessionId, config, responseChannel)).catch((error) => {
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
			ipcRenderer.on('remote:createWorktreeSession', handler);
			return () => ipcRenderer.removeListener('remote:createWorktreeSession', handler);
		},

		/**
		 * Send response for remote create-worktree-agent
		 */
		sendRemoteCreateWorktreeSessionResponse: (
			responseChannel: string,
			result: { success: boolean; sessionId?: string; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote create session from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteCreateSession: (
			callback: (
				name: string,
				toolType: string,
				cwd: string,
				groupId: string | undefined,
				config: Record<string, unknown> | undefined,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				name: string,
				toolType: string,
				cwd: string,
				groupId: string | undefined,
				config: Record<string, unknown> | undefined,
				responseChannel: string
			) => callback(name, toolType, cwd, groupId, config, responseChannel);
			ipcRenderer.on('remote:createSession', handler);
			return () => ipcRenderer.removeListener('remote:createSession', handler);
		},

		/**
		 * Send response for remote create session
		 */
		sendRemoteCreateSessionResponse: (
			responseChannel: string,
			result: { sessionId: string } | null
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote delete session from web interface (fire-and-forget)
		 */
		onRemoteDeleteSession: (callback: (sessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string) => callback(sessionId);
			ipcRenderer.on('remote:deleteSession', handler);
			return () => ipcRenderer.removeListener('remote:deleteSession', handler);
		},

		/**
		 * Subscribe to remote rename session from web interface
		 * Uses request-response pattern with a unique responseChannel
		 */
		onRemoteRenameSession: (
			callback: (sessionId: string, newName: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, newName: string, responseChannel: string) =>
				callback(sessionId, newName, responseChannel);
			ipcRenderer.on('remote:renameSession', handler);
			return () => ipcRenderer.removeListener('remote:renameSession', handler);
		},

		/**
		 * Send response for remote rename session
		 */
		sendRemoteRenameSessionResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote update session cwd from CLI/web.
		 * Uses request-response pattern with a unique responseChannel; the
		 * renderer responds with { success, error? } so the caller can surface
		 * the reason a cwd change was refused (e.g. agent still running).
		 */
		onRemoteUpdateSessionCwd: (
			callback: (sessionId: string, newCwd: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, newCwd: string, responseChannel: string) =>
				callback(sessionId, newCwd, responseChannel);
			ipcRenderer.on('remote:updateSessionCwd', handler);
			return () => ipcRenderer.removeListener('remote:updateSessionCwd', handler);
		},

		/**
		 * Send response for remote update session cwd
		 */
		sendRemoteUpdateSessionCwdResponse: (
			responseChannel: string,
			result: { success: boolean; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote requests to update an agent's SSH execution config.
		 * The renderer merges the partial patch and responds with { success, error? }
		 * so the caller can surface why an update was refused (e.g. agent running).
		 */
		onRemoteUpdateSessionSsh: (
			callback: (
				sessionId: string,
				sshPatch: Record<string, unknown>,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				sshPatch: Record<string, unknown>,
				responseChannel: string
			) => callback(sessionId, sshPatch, responseChannel);
			ipcRenderer.on('remote:updateSessionSsh', handler);
			return () => ipcRenderer.removeListener('remote:updateSessionSsh', handler);
		},

		/**
		 * Send response for remote update session SSH config
		 */
		sendRemoteUpdateSessionSshResponse: (
			responseChannel: string,
			result: { success: boolean; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		/**
		 * Subscribe to remote requests to update an agent's editable per-session
		 * config (nudge/new-session message, custom path/args/env vars, model,
		 * effort, context window, Claude token source). The renderer merges the
		 * partial patch and responds with { success, error? }.
		 */
		onRemoteUpdateSessionConfig: (
			callback: (
				sessionId: string,
				configPatch: Record<string, unknown>,
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				configPatch: Record<string, unknown>,
				responseChannel: string
			) => callback(sessionId, configPatch, responseChannel);
			ipcRenderer.on('remote:updateSessionConfig', handler);
			return () => ipcRenderer.removeListener('remote:updateSessionConfig', handler);
		},

		/**
		 * Send response for remote update session config
		 */
		sendRemoteUpdateSessionConfigResponse: (
			responseChannel: string,
			result: { success: boolean; error?: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},
	};
}
