import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import type { StoredSession } from '../../stores/types';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';

export function registerCommandCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow' | 'sessionsStore'>
): void {
	const { getMainWindow, sessionsStore } = deps;

	// Set up callback for web server to execute commands through the desktop
	// This forwards AI commands to the renderer, ensuring single source of truth
	// The renderer handles all spawn logic, state management, and broadcasts
	server.setExecuteCommandCallback(
		async (
			sessionId: string,
			command: string,
			inputMode?: 'ai' | 'terminal',
			tabId?: string,
			force?: boolean,
			images?: string[],
			background?: boolean
		) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for executeCommand', 'WebServer');
				return false;
			}

			// Look up the session to get Claude session ID for logging
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			const session = sessions.find((s) => s.id === sessionId);
			const agentSessionId = session?.agentSessionId || 'none';

			// Forward to renderer - it will handle spawn, state, and everything else.
			// Log metadata only at info level - remote commands can carry secrets,
			// proprietary code, or PII; the full prompt goes to debug, which is
			// only enabled by users who have explicitly opted in.
			logger.info(
				`[Web → Renderer] Forwarding command | Maestro: ${sessionId} | Claude: ${agentSessionId} | Mode: ${inputMode || 'auto'} | Tab: ${tabId || 'active'} | Force: ${force ? 'yes' : 'no'} | Focus: ${background ? 'no' : 'yes'} | Images: ${images?.length ?? 0} | CommandLength: ${command.length}`,
				'WebServer'
			);
			logger.debug(
				`[Web → Renderer] Command preview (truncated): ${command.substring(0, 100)}`,
				'WebServer'
			);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for executeCommand', 'WebServer');
				return false;
			}
			mainWindow.webContents.send(
				'remote:executeCommand',
				sessionId,
				command,
				inputMode,
				tabId,
				force,
				images,
				background
			);
			return true;
		}
	);

	// Set up callback for web server to interrupt sessions through the desktop
	// This forwards to the renderer which handles state updates and broadcasts
	server.setInterruptSessionCallback(async (sessionId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for interrupt', 'WebServer');
			return false;
		}

		// Forward to renderer - it will handle interrupt, state update, and broadcasts
		// This ensures web interrupts go through exact same code path as desktop interrupts
		logger.debug(`Forwarding interrupt to renderer for session ${sessionId}`, 'WebServer');
		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for interrupt', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:interrupt', sessionId);
		return true;
	});

	// Set up callback for web server to switch session mode through the desktop
	// This forwards to the renderer which handles state updates and broadcasts
	server.setSwitchModeCallback(async (sessionId: string, mode: 'ai' | 'terminal') => {
		logger.info(
			`[Web→Desktop] Mode switch callback invoked: session=${sessionId}, mode=${mode}`,
			'WebServer'
		);
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for switchMode', 'WebServer');
			return false;
		}

		// Forward to renderer - it will handle mode switch and broadcasts
		// This ensures web mode switches go through exact same code path as desktop
		logger.info(`[Web→Desktop] Sending IPC remote:switchMode to renderer`, 'WebServer');
		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for switchMode', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:switchMode', sessionId, mode);
		return true;
	});

	// Set up callback for web server to select/switch to a session in the desktop
	// This forwards to the renderer which handles state updates and broadcasts
	// If tabId is provided, also switches to that tab within the session
	server.setSelectSessionCallback(async (sessionId: string, tabId?: string, focus?: boolean) => {
		logger.info(
			`[Web→Desktop] Session select callback invoked: session=${sessionId}, tab=${tabId || 'none'}, focus=${focus || false}`,
			'WebServer'
		);
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for selectSession', 'WebServer');
			return false;
		}

		// When focus is requested, bring the window to the foreground
		if (focus) {
			mainWindow.show();
			mainWindow.focus();
		}

		// Forward to renderer - it will handle session selection and broadcasts
		logger.info(`[Web→Desktop] Sending IPC remote:selectSession to renderer`, 'WebServer');
		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for selectSession', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:selectSession', sessionId, tabId);
		return true;
	});
}
