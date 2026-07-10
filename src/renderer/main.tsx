// IMPORTANT: wdyr must be imported BEFORE React
import './wdyr';
import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/electron/renderer';
import { shouldDropSentryEvent } from '../shared/sentryFilters';
import MaestroConsole from './App';
import { CadenzaHudRoot } from './cadenzaHud';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LayerStackProvider } from './contexts/LayerStackContext';
// ToastProvider removed - notification state now managed by notificationStore (Zustand)
// ModalProvider removed - modal state now managed by modalStore (Zustand)
import { WizardProvider } from './components/Wizard';
import { logger } from './utils/logger';
import './index.css';

// Initialize Sentry for renderer process
// Uses IPCMode.Classic in main process to avoid "sentry-ipc://" protocol conflicts
// See: https://github.com/getsentry/sentry-electron/issues/661
const isDevelopment = process.env.NODE_ENV === 'development';

// Check crash reporting setting - default to enabled
// This mirrors the main process check for consistency
const initSentry = async () => {
	try {
		const crashReportingEnabled =
			(await window.maestro?.settings?.get('crashReportingEnabled')) ?? true;
		if (crashReportingEnabled && !isDevelopment) {
			Sentry.init({
				// Set release version for filtering errors by app version
				release: __APP_VERSION__,
				// Only send errors, not performance data
				tracesSampleRate: 0,
				// PERF: drop console breadcrumbs. Sentry's default Breadcrumbs
				// integration wraps every console.* to capture a breadcrumb, and a
				// field trace showed that wrapper (addConsoleBreadcrumb) as the single
				// largest JS CPU consumer. We already retain console output via our own
				// logger, file logs, and the LogViewer, so nothing diagnostic is lost;
				// exception/crash reporting is unaffected.
				beforeBreadcrumb(breadcrumb) {
					return breadcrumb.category === 'console' ? null : breadcrumb;
				},
				// Filter out sensitive data + unfixable OS / Chromium / user-env noise.
				// See src/shared/sentryFilters.ts for the full classification.
				beforeSend(event) {
					if (shouldDropSentryEvent(event)) {
						return null;
					}
					if (event.user) {
						delete event.user.ip_address;
						delete event.user.email;
					}
					return event;
				},
			});
			// Tag release channel (rc vs stable) based on version string
			Sentry.setTag('channel', __APP_VERSION__.includes('-RC') ? 'rc' : 'stable');
		}
	} catch {
		// Settings not available yet, Sentry will be initialized by main process
	}
};
initSentry();

// Set up global error handlers for uncaught exceptions in renderer process
window.addEventListener('error', (event: ErrorEvent) => {
	logger.error(`Uncaught Error: ${event.message}`, 'UncaughtError', {
		filename: event.filename,
		lineno: event.lineno,
		colno: event.colno,
		error: event.error?.stack || String(event.error),
	});
	// Report to Sentry
	if (event.error) {
		Sentry.captureException(event.error, {
			extra: {
				filename: event.filename,
				lineno: event.lineno,
				colno: event.colno,
			},
		});
	}
	// Prevent default browser error handling
	event.preventDefault();
});

window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
	logger.error(
		`Unhandled Promise Rejection: ${event.reason?.message || String(event.reason)}`,
		'UnhandledRejection',
		{
			reason: event.reason,
			stack: event.reason?.stack,
		}
	);
	// Report to Sentry
	Sentry.captureException(event.reason || new Error('Unhandled Promise Rejection'), {
		extra: {
			type: 'unhandledrejection',
		},
	});
	// Prevent default browser error handling
	event.preventDefault();
});

// HUD mode: the main process loads this same bundle into a transparent,
// always-on-top child window with `?cadenzaHud`. Render just the floating
// cadenza cards - no app chrome, no providers the cards don't need.
const isCadenzaHud = new URLSearchParams(window.location.search).has('cadenzaHud');

if (isCadenzaHud) {
	document.documentElement.classList.add('cadenza-hud');
	document.body.classList.add('cadenza-hud');
	// The static loading splash (index.html) is hidden by the full App on ready,
	// which never mounts in HUD mode - remove it so the window is transparent.
	document.getElementById('initial-splash')?.remove();
	ReactDOM.createRoot(document.getElementById('root')!).render(
		<React.StrictMode>
			<ErrorBoundary>
				<CadenzaHudRoot />
			</ErrorBoundary>
		</React.StrictMode>
	);
} else {
	ReactDOM.createRoot(document.getElementById('root')!).render(
		<React.StrictMode>
			<ErrorBoundary>
				<LayerStackProvider>
					<WizardProvider>
						<MaestroConsole />
					</WizardProvider>
				</LayerStackProvider>
			</ErrorBoundary>
		</React.StrictMode>
	);
}
