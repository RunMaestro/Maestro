/**
 * Global error handlers for uncaught exceptions and unhandled rejections.
 * Sets up process-level error handling to prevent crashes and log errors.
 */

import { logger } from '../utils/logger';

/**
 * Sets up global error handlers for the Node.js process.
 * Should be called early in application startup.
 *
 * - Catches uncaught exceptions and logs them without crashing
 * - Catches unhandled promise rejections and logs them
 */
export function setupGlobalErrorHandlers(): void {
	process.on('uncaughtException', (error: Error) => {
		logger.error(`Uncaught Exception: ${error.message}`, 'UncaughtException', {
			stack: error.stack,
			name: error.name,
		});
		// Don't exit the process - let it continue running
	});

	process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
		const reasonMessage = reason instanceof Error ? reason.message : String(reason);
		const reasonStack = reason instanceof Error ? reason.stack : undefined;

		logger.error(`Unhandled Promise Rejection: ${reasonMessage}`, 'UnhandledRejection', {
			reason: reason,
			stack: reasonStack,
			promise: String(promise),
		});
	});
}
