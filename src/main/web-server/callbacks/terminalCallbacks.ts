import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import type { StoredSession } from '../../stores/types';
import { logger } from '../../utils/logger';
import { getDefaultShell } from '../../stores/defaults';

export function registerTerminalCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getProcessManager' | 'sessionsStore' | 'settingsStore'>
): void {
	const { getProcessManager, sessionsStore, settingsStore } = deps;

	// Set up callback for web server to write commands to sessions
	// Note: Process IDs have -ai or -terminal suffix based on session's inputMode
	server.setWriteToSessionCallback((sessionId: string, data: string) => {
		const processManager = getProcessManager();
		if (!processManager) {
			logger.warn('processManager is null for writeToSession', 'WebServer');
			return false;
		}

		// Get the session's current inputMode to determine which process to write to
		const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
		const session = sessions.find((s) => s.id === sessionId);
		if (!session) {
			logger.warn(`Session ${sessionId} not found for writeToSession`, 'WebServer');
			return false;
		}

		// Append -ai or -terminal suffix based on inputMode
		const targetSessionId =
			session.inputMode === 'ai' ? `${sessionId}-ai` : `${sessionId}-terminal`;
		logger.debug(`Writing to ${targetSessionId} (inputMode=${session.inputMode})`, 'WebServer');

		const result = processManager.write(targetSessionId, data);
		logger.debug(`Write result: ${result}`, 'WebServer');
		return result;
	});

	// Set up callbacks for raw terminal PTY write and resize (for xterm.js in web client)
	server.setWriteToTerminalCallback((sessionId: string, data: string) => {
		const processManager = getProcessManager();
		if (!processManager) {
			logger.warn('processManager is null for writeToTerminal', 'WebServer');
			return false;
		}
		return processManager.write(`${sessionId}-terminal`, data);
	});

	server.setResizeTerminalCallback((sessionId: string, cols: number, rows: number) => {
		const processManager = getProcessManager();
		if (!processManager) {
			logger.warn('processManager is null for resizeTerminal', 'WebServer');
			return false;
		}
		return processManager.resize(`${sessionId}-terminal`, cols, rows);
	});

	// Spawn a dedicated terminal PTY for the web client
	// Uses session ID format {sessionId}-terminal so data-listener broadcasts terminal_data
	server.setSpawnTerminalForWebCallback(
		async (sessionId: string, config: { cwd: string; cols?: number; rows?: number }) => {
			const processManager = getProcessManager();
			if (!processManager) {
				logger.warn('processManager is null for spawnTerminalForWeb', 'WebServer');
				return { success: false, pid: 0 };
			}
			const terminalSessionId = `${sessionId}-terminal`;
			// Check if a process already exists for this terminal session
			if (processManager.get(terminalSessionId)) {
				logger.info(
					`Terminal PTY already exists for web client: ${terminalSessionId}`,
					'WebServer'
				);
				return { success: true, pid: 0 };
			}
			// Resolve shell: custom path > default from settings > system default
			const customShellPath = settingsStore.get<string>('customShellPath', '');
			const defaultShell = settingsStore.get<string>('defaultShell', getDefaultShell());
			const shell = (customShellPath && customShellPath.trim()) || defaultShell;
			const shellArgs = settingsStore.get<string>('shellArgs', '');
			const shellEnvVars = settingsStore.get<Record<string, string>>('shellEnvVars', {});

			logger.info(`Spawning terminal PTY for web client: ${terminalSessionId}`, 'WebServer', {
				shell,
				cwd: config.cwd,
			});
			return processManager.spawnTerminalTab({
				sessionId: terminalSessionId,
				cwd: config.cwd,
				shell,
				shellArgs,
				shellEnvVars,
				cols: config.cols,
				rows: config.rows,
			});
		}
	);

	// Kill the web client's dedicated terminal PTY
	server.setKillTerminalForWebCallback((sessionId: string) => {
		const processManager = getProcessManager();
		if (!processManager) {
			logger.warn('processManager is null for killTerminalForWeb', 'WebServer');
			return false;
		}
		const terminalSessionId = `${sessionId}-terminal`;
		if (!processManager.get(terminalSessionId)) {
			return true; // Already gone
		}
		logger.info(`Killing terminal PTY for web client: ${terminalSessionId}`, 'WebServer');
		return processManager.kill(terminalSessionId);
	});
}
