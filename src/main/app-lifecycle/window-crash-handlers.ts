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

/** Delay before reloading a renderer that exited, so the exit can settle. */
export const RENDERER_RELOAD_DELAY_MS = 1000;
/** Window over which automatic renderer reloads are counted. */
export const RENDERER_RELOAD_WINDOW_MS = 60_000;
/** Automatic reloads allowed per window before the handler stops reloading. */
export const MAX_RENDERER_RELOADS_PER_WINDOW = 3;

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
 *
 * `getIsQuitting` tells a renderer killed by the app's own shutdown apart from
 * one killed by a stray signal while the app keeps running.
 */
export function attachWindowCrashHandlers(
	mainWindow: BrowserWindow,
	getIsQuitting?: () => boolean
): void {
	// Handle renderer process termination (crash, kill, OOM, etc.)
	mainWindow.webContents.on('render-process-gone', (_event, details) => {
		logger.error('Renderer process gone', 'Window', {
			reason: details.reason,
			exitCode: details.exitCode,
		});

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
		if (details.reason !== 'clean-exit' && !getIsQuitting?.()) {
			scheduleRendererReload(details.reason, details.exitCode);
		}
	});

	// The reload above is the only thing that relaunches a dead renderer, so it
	// is also what turns a renderer that can never start into a loop. When the
	// cause is environmental (no fork headroom: `launch-failed` exit 1002; a
	// macOS bundle whose helper app is gone, so every child CHECK-fails at
	// start) each reload just fails again, and an unbounded loop spawned and
	// reported hundreds of dead renderers per minute (MAESTRO-164/165: 248
	// launch failures in 25 seconds from one install). Two guards: exits that
	// arrive while a reload is already queued share it, and only a few reloads
	// are allowed per window of time before the loop stops for good.
	let pendingReload: ReturnType<typeof setTimeout> | null = null;
	const recentReloads: number[] = [];

	function scheduleRendererReload(reason: string, exitCode: number): void {
		if (pendingReload) {
			return;
		}
		const now = Date.now();
		while (recentReloads.length > 0 && now - recentReloads[0] > RENDERER_RELOAD_WINDOW_MS) {
			recentReloads.shift();
		}
		if (recentReloads.length >= MAX_RENDERER_RELOADS_PER_WINDOW) {
			logger.error('Renderer keeps exiting; giving up on automatic reloads', 'Window', {
				reason,
				exitCode,
				reloads: recentReloads.length,
			});
			reportCrashToSentry('Renderer reload loop stopped', 'error', {
				reason,
				exitCode,
				reloads: recentReloads.length,
				windowMs: RENDERER_RELOAD_WINDOW_MS,
			});
			return;
		}
		recentReloads.push(now);
		logger.info('Attempting to reload renderer after it exited', 'Window', { reason });
		pendingReload = setTimeout(() => {
			pendingReload = null;
			if (!mainWindow.isDestroyed() && !getIsQuitting?.()) {
				mainWindow.webContents.reload();
			}
		}, RENDERER_RELOAD_DELAY_MS);
	}

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
