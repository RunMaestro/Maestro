// IMPORTANT: wdyr must be imported BEFORE React
import './wdyr';
import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/electron/renderer';
import MaestroConsole from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LayerStackProvider } from './contexts/LayerStackContext';
import { ToastProvider } from './contexts/ToastContext';
import { ModalProvider } from './contexts/ModalContext';
import { UILayoutProvider } from './contexts/UILayoutContext';
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
				// Only send errors, not performance data
				tracesSampleRate: 0,
				// Filter out sensitive data
				beforeSend(event) {
					if (event.user) {
						delete event.user.ip_address;
						delete event.user.email;
					}
					return event;
				},
			});
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

ReactDOM.createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<ErrorBoundary>
			<ToastProvider>
				<LayerStackProvider>
					<ModalProvider>
						<UILayoutProvider>
							<WizardProvider>
								<MaestroConsole />
							</WizardProvider>
						</UILayoutProvider>
					</ModalProvider>
				</LayerStackProvider>
			</ToastProvider>
		</ErrorBoundary>
	</React.StrictMode>
);
