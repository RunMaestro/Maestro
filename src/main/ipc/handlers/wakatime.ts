/**
 * WakaTime IPC Handlers
 *
 * Provides IPC handlers for WakaTime CLI availability checks
 * and API key validation from the renderer process.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { execFileNoThrow } from '../../utils/execFile';

const LOG_CONTEXT = '[WakaTime]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Register all WakaTime-related IPC handlers.
 *
 * Handlers:
 * - wakatime:checkCli — Check if wakatime-cli is installed and return version
 * - wakatime:validateApiKey — Validate an API key against the WakaTime API
 */
export function registerWakatimeHandlers(): void {
	// Check if wakatime-cli is available on PATH
	ipcMain.handle(
		'wakatime:checkCli',
		withIpcErrorLogging(
			handlerOpts('checkCli'),
			async (): Promise<{ available: boolean; version?: string }> => {
				for (const cmd of ['wakatime-cli', 'wakatime']) {
					const result = await execFileNoThrow(cmd, ['--version']);
					if (result.exitCode === 0) {
						return { available: true, version: result.stdout.trim() };
					}
				}
				return { available: false };
			}
		)
	);

	// Validate a WakaTime API key by running a quick status check
	ipcMain.handle(
		'wakatime:validateApiKey',
		withIpcErrorLogging(
			handlerOpts('validateApiKey'),
			async (key: string): Promise<{ valid: boolean }> => {
				if (!key) return { valid: false };

				// Find available CLI binary first
				let cliCmd: string | null = null;
				for (const cmd of ['wakatime-cli', 'wakatime']) {
					const detect = await execFileNoThrow(cmd, ['--version']);
					if (detect.exitCode === 0) {
						cliCmd = cmd;
						break;
					}
				}

				if (!cliCmd) return { valid: false };

				// Use --today with the key to verify it works
				const result = await execFileNoThrow(cliCmd, ['--key', key, '--today']);
				return { valid: result.exitCode === 0 };
			}
		)
	);
}
