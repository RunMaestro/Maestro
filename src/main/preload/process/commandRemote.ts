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
		 */
		onRemoteCommand: (
			callback: (
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean,
				images?: string[],
				background?: boolean
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
				background?: boolean
			) => {
				log('Received remote:executeCommand IPC', {
					sessionId,
					commandPreview: command?.substring(0, 50),
					inputMode,
					tabId,
					force,
					imageCount: images?.length ?? 0,
					background,
				});
				try {
					callback(sessionId, command, inputMode, tabId, force, images, background);
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
		 * Subscribe to remote mode switch from web interface
		 * Forwards to desktop's toggleInputMode logic
		 */
		onRemoteSwitchMode: (
			callback: (sessionId: string, mode: 'ai' | 'terminal') => void
		): (() => void) => {
			log('Registering onRemoteSwitchMode listener');
			const handler = (_: unknown, sessionId: string, mode: 'ai' | 'terminal') => {
				log('Received remote:switchMode IPC', { sessionId, mode });
				callback(sessionId, mode);
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
