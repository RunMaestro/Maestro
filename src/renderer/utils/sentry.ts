/**
 * Sentry utilities for error reporting in the renderer process.
 *
 * Thin wrapper around @sentry/electron/renderer to provide consistent
 * named exports matching the main-process wrapper (src/main/utils/sentry.ts).
 */

import * as Sentry from '@sentry/electron/renderer';

/**
 * Reports an exception to Sentry from the renderer process.
 *
 * @param error - The error to report
 * @param captureContext - Optional Sentry capture context (e.g. { extra: { key: value } })
 */
export function captureException(
	error: Error | unknown,
	captureContext?: {
		level?: Sentry.SeverityLevel;
		tags?: Record<string, string>;
		extra?: Record<string, unknown>;
	}
): void {
	Sentry.captureException(error, captureContext);
}

/**
 * Reports a message to Sentry from the renderer process.
 *
 * @param message - The message to report
 * @param captureContext - Optional Sentry capture context (e.g. { level: 'warning', extra: { key: value } })
 */
export function captureMessage(
	message: string,
	captureContext?: { level?: Sentry.SeverityLevel; extra?: Record<string, unknown> }
): void {
	Sentry.captureMessage(message, captureContext);
}
