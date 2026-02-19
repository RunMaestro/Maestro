import * as Sentry from '@sentry/electron/renderer';

interface CaptureContext {
	tags?: Record<string, string>;
	extra?: Record<string, unknown>;
}

export function captureException(error: unknown, context?: CaptureContext): void {
	Sentry.captureException(error, context);
}

export function captureMessage(
	message: string,
	level: Sentry.SeverityLevel = 'info',
	extra?: Record<string, unknown>
): void {
	Sentry.captureMessage(message, { level, extra });
}
