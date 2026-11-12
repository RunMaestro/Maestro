/**
 * Browser-safe stand-in for @sentry/electron/renderer in the web build.
 *
 * The Electron renderer SDK cannot run inside the web-desktop bundle because
 * it depends on Electron IPC internals. Keep the same surface, but route
 * captured failures through console + the Maestro logger bridge once preload
 * has exposed window.maestro.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const tags = new Map<string, string>();
let user: unknown = null;

function toErrorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function report(level: LogLevel, message: string, extra?: unknown): void {
	const payload = {
		extra,
		tags: Object.fromEntries(tags),
		user,
	};
	if (level === 'error') {
		console.error(`[web-desktop] ${message}`, payload);
	} else if (level === 'warn') {
		console.warn(`[web-desktop] ${message}`, payload);
	} else {
		console.log(`[web-desktop] ${message}`, payload);
	}
	try {
		void window.maestro?.logger?.log(level, message, 'WebDesktopSentryShim', payload);
	} catch {
		// The logger bridge is best-effort; never let reporting throw back into app code.
	}
}

export function init(_options: unknown): void {}

export function captureException(err: unknown, ctx?: unknown): void {
	report('error', toErrorMessage(err), {
		context: ctx,
		stack: err instanceof Error ? err.stack : undefined,
	});
}

export function captureMessage(msg: unknown, levelOrCtx?: unknown, ctx?: unknown): void {
	const level =
		typeof levelOrCtx === 'string' &&
		['debug', 'info', 'warning', 'warn', 'error'].includes(levelOrCtx)
			? levelOrCtx === 'warning'
				? 'warn'
				: (levelOrCtx as LogLevel)
			: 'info';
	report(level, toErrorMessage(msg), {
		context: ctx ?? levelOrCtx,
	});
}

export function setTag(key: string, value: string): void {
	tags.set(key, value);
}

export function setUser(nextUser: unknown): void {
	user = nextUser;
}
export const Severity = {
	Error: 'error',
	Warning: 'warning',
	Info: 'info',
	Debug: 'debug',
};
export default { init, captureException, captureMessage, setTag, setUser, Severity };
