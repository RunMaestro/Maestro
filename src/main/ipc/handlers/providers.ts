/**
 * Provider Error Tracking IPC Handlers
 *
 * Registers IPC handlers for provider error stats queries:
 * - Get error stats for a specific provider
 * - Get error stats for all providers
 * - Clear error tracking for a session (after manual provider switch)
 */

import { ipcMain } from 'electron';
import type { ProviderErrorTracker } from '../../providers/provider-error-tracker';
import type { ToolType } from '../../../shared/types';
import type { ProviderErrorStats } from '../../../shared/account-types';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = 'Providers';

/**
 * Dependencies for provider error tracking handlers
 */
export interface ProviderHandlerDependencies {
	getProviderErrorTracker: () => ProviderErrorTracker | null;
}

/**
 * Register all provider error tracking IPC handlers.
 */
export function registerProviderHandlers(deps: ProviderHandlerDependencies): void {
	const { getProviderErrorTracker } = deps;

	// Get error stats for a specific provider
	ipcMain.handle(
		'providers:get-error-stats',
		async (_event, toolType: string): Promise<ProviderErrorStats | null> => {
			const tracker = getProviderErrorTracker();
			if (!tracker) return null;
			return tracker.getProviderStats(toolType as ToolType);
		}
	);

	// Get error stats for all providers
	ipcMain.handle(
		'providers:get-all-error-stats',
		async (): Promise<Record<string, ProviderErrorStats>> => {
			const tracker = getProviderErrorTracker();
			if (!tracker) return {};
			const stats = tracker.getAllStats();
			const result: Record<string, ProviderErrorStats> = {};
			for (const [key, value] of stats) {
				result[key] = value;
			}
			return result;
		}
	);

	// Clear error tracking for a session (e.g., after manual provider switch)
	ipcMain.handle(
		'providers:clear-session-errors',
		async (_event, sessionId: string): Promise<void> => {
			const tracker = getProviderErrorTracker();
			if (!tracker) return;
			logger.debug('Clearing provider errors for session', LOG_CONTEXT, { sessionId });
			tracker.clearSession(sessionId);
		}
	);
}
