import { ipcRenderer } from 'electron';

/**
 * Helper to log via the main process logger.
 * Uses 'debug' level for preload operations.
 */
const log = (message: string, data?: unknown) => {
	ipcRenderer.invoke('logger:log', 'debug', message, 'Preload', data);
};

export function createCommandRemoteApi() {
	return {
		/**
		 * Subscribe to remote command execution from web interface
		 * This allows web commands to go through the same code path as desktop commands
		 * inputMode is optional - if provided, renderer should use it instead of session state
		 *
		 * `receiptChannel` is the reply channel the web server mints per command;
		 * the renderer MUST answer it via `sendRemoteCommandReceipt` so the CLI's
		 * `success` reflects delivery rather than "an IPC send was issued". It is
		 * undefined for senders that do not wait for a receipt (main's own
		 * `remote:executeCommand` sends), so the renderer must tolerate that.
		 */
		onRemoteCommand: (
			callback: (
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean,
				images?: string[],
				background?: boolean,
				receiptChannel?: string
			) => void
		): (() => void) => {
			log('Registering onRemoteCommand listener');
			const handler = (
				_: unknown,
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean,
				images?: string[],
				background?: boolean,
				receiptChannel?: string
			) => {
				log('Received remote:executeCommand IPC', {
					sessionId,
					commandPreview: command?.substring(0, 50),
					inputMode,
					tabId,
					force,
					imageCount: images?.length ?? 0,
					background,
					receiptChannel,
				});
				try {
					callback(sessionId, command, inputMode, tabId, force, images, background, receiptChannel);
				} catch (error) {
					ipcRenderer.invoke(
						'logger:log',
						'error',
						'Error invoking remote command callback',
						'Preload',
						{ error: String(error) }
					);
				}
			};
			ipcRenderer.on('remote:executeCommand', handler);
			return () => ipcRenderer.removeListener('remote:executeCommand', handler);
		},

		/**
		 * Answer a `remote:executeCommand` receipt channel. `accepted: true` means
		 * the command was handed to the spawn/queue logic - NOT that it finished.
		 * `reason` names the branch that dropped it (session-not-found,
		 * tab-not-found, session-busy, unsupported-agent, ...) so the CLI can say
		 * why instead of reporting a meaningless `success: true`.
		 */
		sendRemoteCommandReceipt: (
			receiptChannel: string,
			accepted: boolean,
			reason?: string
		): void => {
			log('Sending remote command receipt', { receiptChannel, accepted, reason });
			ipcRenderer.send(receiptChannel, { accepted, reason });
		},

		/**
		 * Subscribe to remote mode switch from web interface
		 * Forwards to desktop's toggleInputMode logic
		 */
		onRemoteSwitchMode: (
			callback: (sessionId: string, mode: 'ai' | 'terminal', background?: boolean) => void
		): (() => void) => {
			log('Registering onRemoteSwitchMode listener');
			const handler = (
				_: unknown,
				sessionId: string,
				mode: 'ai' | 'terminal',
				background?: boolean
			) => {
				log('Received remote:switchMode IPC', { sessionId, mode, background });
				callback(sessionId, mode, background === true);
			};
			ipcRenderer.on('remote:switchMode', handler);
			return () => ipcRenderer.removeListener('remote:switchMode', handler);
		},

		/**
		 * Subscribe to remote interrupt from web interface
		 * Forwards to desktop's handleInterrupt logic
		 */
		onRemoteInterrupt: (callback: (sessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string) => callback(sessionId);
			ipcRenderer.on('remote:interrupt', handler);
			return () => ipcRenderer.removeListener('remote:interrupt', handler);
		},

		/**
		 * Subscribe to remote session selection from web interface
		 * Forwards to desktop's setActiveSessionId logic
		 * Optional tabId to also switch to a specific tab within the session
		 */
		onRemoteSelectSession: (
			callback: (sessionId: string, tabId?: string) => void
		): (() => void) => {
			log('Registering onRemoteSelectSession listener');
			const handler = (_: unknown, sessionId: string, tabId?: string) => {
				log('Received remote:selectSession IPC', { sessionId, tabId });
				callback(sessionId, tabId);
			};
			ipcRenderer.on('remote:selectSession', handler);
			return () => ipcRenderer.removeListener('remote:selectSession', handler);
		},
	};
}
