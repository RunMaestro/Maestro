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
 * How many times a window may reload its renderer inside
 * {@link RENDERER_RELOAD_WINDOW_MS} before it stops trying. A renderer that
 * cannot start at all (`launch-failed`: no usable sandbox, a container without
 * /dev/shm) dies again the moment it is reloaded, so an uncapped reload spun
 * forever and sent a fatal Sentry event per attempt - 248 in 23 seconds from
 * one Linux install (MAESTRO-164/165).
 */
export const MAX_RENDERER_RELOADS = 3;
export const RENDERER_RELOAD_WINDOW_MS = 60_000;

/**
 * Capture renderer crashes, unresponsive windows, load failures, and console
 * errors that the renderer process cannot report itself.
 *
 * `getIsQuitting` tells a renderer killed by the app's own shutdown apart from
 * one killed by a stray signal while the app keeps running.
 */
export function attachWindowCrashHandlers(
	mainWindow: BrowserWindow,
	getIsQuitting?: () => boolean
): void {
	// When this window's recent auto-reloads happened, to tell a one-off crash
	// apart from a renderer that dies every time it is started.
	let recentReloads: number[] = [];
	let reportedCrashLoop = false;
	// One reload at a time: an exit that arrives while a reload is already queued
	// shares it rather than queueing another and spending a second slot of the
	// budget on the same death (approach from #1903).
	let reloadPending = false;

	// Handle renderer process termination (crash, kill, OOM, etc.)
	mainWindow.webContents.on('render-process-gone', (_event, details) => {
		logger.error('Renderer process gone', 'Window', {
			reason: details.reason,
			exitCode: details.exitCode,
		});

		const wantsReload = details.reason !== 'clean-exit' && !getIsQuitting?.();
		const scheduleReload = wantsReload && !reloadPending;
		if (scheduleReload) {
			const now = Date.now();
			recentReloads = recentReloads.filter((at) => now - at < RENDERER_RELOAD_WINDOW_MS);
			if (recentReloads.length >= MAX_RENDERER_RELOADS) {
				// Crash loop: another reload would only die the same way. Report the
				// give-up once instead of one fatal event per attempt.
				if (!reportedCrashLoop) {
					reportedCrashLoop = true;
					logger.error('Renderer keeps exiting; stopped reloading it', 'Window', {
						reason: details.reason,
						exitCode: details.exitCode,
						reloads: recentReloads.length,
					});
					reportCrashToSentry(
						`Renderer crash loop, stopped reloading: ${details.reason}`,
						'fatal',
						{ reason: details.reason, exitCode: details.exitCode, reloads: recentReloads.length }
					);
				}
				return;
			}
			recentReloads.push(now);
			reportedCrashLoop = false;
		}

		// `killed` (signal-terminated) and `clean-exit` are not crashes, so
		// reporting them as `fatal` Sentry events is pure noise; genuine
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

		// A `killed` renderer still needs a reload unless the app is quitting.
		// The main process outlives a SIGTERM aimed at the renderer (a stray
		// `pkill -f` whose pattern hits Chromium's `--lang=en-US` flag is
		// enough), and without a reload the window stays black for good.
		if (scheduleReload) {
			logger.info('Attempting to reload renderer after it exited', 'Window', {
				reason: details.reason,
			});
			reloadPending = true;
			setTimeout(() => {
				reloadPending = false;
				if (
					!mainWindow.isDestroyed() &&
					!mainWindow.webContents.isDestroyed() &&
					!getIsQuitting?.()
				) {
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
		// Level 3 = error (0=verbose, 1=info, 2=warning, 3=error)
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
