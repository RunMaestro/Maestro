/**
 * WakaTime IPC Handlers
 *
 * Provides IPC handlers for WakaTime CLI availability checks
 * and API key validation from the renderer process.
 *
 * Uses the WakaTimeManager instance to leverage auto-install
 * and version checking capabilities.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { execFileNoThrow } from '../../utils/execFile';
import type { WakaTimeManager } from '../../wakatime-manager';

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
 * - wakatime:checkCli — Check if wakatime-cli is installed (auto-installs if needed) and return version
 * - wakatime:validateApiKey — Validate an API key against the WakaTime API
 */
export function registerWakatimeHandlers(wakatimeManager: WakaTimeManager): void {
	// Check if wakatime-cli is available (auto-installs if needed)
	ipcMain.handle(
		'wakatime:checkCli',
		withIpcErrorLogging(
			handlerOpts('checkCli'),
			async (): Promise<{ available: boolean; version?: string }> => {
				const installed = await wakatimeManager.ensureCliInstalled();
				if (!installed) return { available: false };

				const cliPath = wakatimeManager.getCliPath();
				if (!cliPath) return { available: false };

				const result = await execFileNoThrow(cliPath, ['--version']);
				if (result.exitCode === 0) {
					return { available: true, version: result.stdout.trim() };
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

				// Ensure CLI is available (auto-installs if needed)
				const installed = await wakatimeManager.ensureCliInstalled();
				if (!installed) return { valid: false };

				const cliPath = wakatimeManager.getCliPath();
				if (!cliPath) return { valid: false };

				// Use --today with the key to verify it works
				const result = await execFileNoThrow(cliPath, ['--key', key, '--today']);
				return { valid: result.exitCode === 0 };
			}
		)
	);
}
