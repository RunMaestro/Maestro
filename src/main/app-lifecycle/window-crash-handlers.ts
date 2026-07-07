import type { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';

/** Sentry severity levels */
type SentrySeverityLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

/** Sentry module type for crash reporting */
interface SentryModule {
	captureMessage: (
		message: string,
		captureContext?: { level?: SentrySeverityLevel; extra?: Record<string, unknown> }
	) => string;
}

/** Cached Sentry module reference */
let sentryModule: SentryModule | null = null;

/**
 * Reports a crash event to Sentry from the main process.
 * Lazily loads Sentry to avoid module initialization issues.
 */
async function reportCrashToSentry(
	message: string,
	level: SentrySeverityLevel,
	extra?: Record<string, unknown>
): Promise<void> {
	try {
		if (!sentryModule) {
			const sentry = await import('@sentry/electron/main');
			sentryModule = sentry;
		}
		sentryModule.captureMessage(message, { level, extra });
	} catch {
		// Sentry not available (development mode or initialization failed)
		logger.debug('Sentry not available for crash reporting', 'Window');
	}
}

/**
 * Capture renderer crashes, unresponsive windows, load failures, and console
 * errors that the renderer process cannot report itself.
 */
export function attachWindowCrashHandlers(mainWindow: BrowserWindow): void {
	// Handle renderer process termination (crash, kill, OOM, etc.)
	mainWindow.webContents.on('render-process-gone', (_event, details) => {
		logger.error('Renderer process gone', 'Window', {
			reason: details.reason,
			exitCode: details.exitCode,
		});

		// `killed` (signal-terminated, e.g. app quit / OS shutdown / user
		// force-quit) and `clean-exit` are intentional terminations, not
		// crashes - the auto-reload guard below already treats them as such.
		// Reporting them as `fatal` Sentry events is pure noise; genuine
		// out-of-memory kills surface separately as reason `oom`. Only the
		// real crash reasons (`crashed`, `oom`, `abnormal-exit`, etc.) are
		// worth a breadcrumb. Fixes MAESTRO-4X/4Y.
		const intentionalTermination = details.reason === 'killed' || details.reason === 'clean-exit';
		if (!intentionalTermination) {
			// Report to Sentry from main process (always available)
			reportCrashToSentry(`Renderer process gone: ${details.reason}`, 'fatal', {
				reason: details.reason,
				exitCode: details.exitCode,
			});
		}

		// Auto-reload unless the process was intentionally killed
		if (details.reason !== 'killed' && details.reason !== 'clean-exit') {
			logger.info('Attempting to reload renderer after crash', 'Window');
			setTimeout(() => {
				if (!mainWindow.isDestroyed()) {
					mainWindow.webContents.reload();
				}
			}, 1000);
		}
	});

	// Handle window becoming unresponsive (frozen renderer)
	mainWindow.on('unresponsive', () => {
		logger.warn('Window became unresponsive', 'Window');
		reportCrashToSentry('Window unresponsive', 'warning', {
			memoryUsage: process.memoryUsage(),
		});
	});

	// Log when window recovers from unresponsive state
	mainWindow.on('responsive', () => {
		logger.info('Window became responsive again', 'Window');
	});

	// Note: the legacy 'crashed' event was removed in Electron 41 and
	// is now subsumed by 'render-process-gone' above (which reports to
	// Sentry with full reason/exitCode detail and handles auto-reload).

	// Handle page load failures (network issues, invalid URLs, etc.)
	mainWindow.webContents.on(
		'did-fail-load',
		(_event, errorCode, errorDescription, validatedURL) => {
			// Ignore aborted loads (user navigated away)
			if (errorCode === -3) return;

			logger.error('Page failed to load', 'Window', {
				errorCode,
				errorDescription,
				url: validatedURL,
			});
			reportCrashToSentry(`Page failed to load: ${errorDescription}`, 'error', {
				errorCode,
				errorDescription,
				url: validatedURL,
			});
		}
	);

	// Handle preload script errors
	mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
		logger.error('Preload script error', 'Window', {
			preloadPath,
			error: error.message,
			stack: error.stack,
		});
		reportCrashToSentry('Preload script error', 'fatal', {
			preloadPath,
			error: error.message,
			stack: error.stack,
		});
	});

	// Forward renderer console errors to main process logger and Sentry
	// This catches errors that happen before or outside React's error boundary
	mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
		// Level 2 = error (0=verbose, 1=info, 2=warning, 3=error)
		if (level === 3) {
			logger.error(`Renderer console error: ${message}`, 'Window', {
				line,
				source: sourceId,
			});

			// Report critical errors to Sentry
			// Filter out common noise (React dev warnings, etc.)
			const isCritical =
				message.includes('Uncaught') ||
				message.includes('TypeError') ||
				message.includes('ReferenceError') ||
				message.includes('Cannot read') ||
				message.includes('is not defined') ||
				message.includes('is not a function');

			if (isCritical) {
				reportCrashToSentry(`Renderer error: ${message}`, 'error', {
					line,
					source: sourceId,
				});
			}
		}
	});
}
