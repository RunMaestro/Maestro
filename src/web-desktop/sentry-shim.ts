/**
 * Browser-safe stand-in for @sentry/electron/renderer in the web build.
 *
 * The Electron renderer SDK cannot run inside the web-desktop bundle because
 * it depends on Electron IPC internals. Keep the same surface, but route
 * captured failures through console + the Maestro logger bridge once preload
 * has exposed window.maestro.
 */

import { isExpectedBridgeError } from '../shared/bridgeError';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const tags = new Map<string, string>();
let user: unknown = null;
const recentReports = new Map<string, { at: number; suppressed: number }>();
const REPORT_INTERVAL_MS = 30_000;

function toErrorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Throttle matching reports and consume logger failures so reporting cannot recurse. */
function report(level: LogLevel, message: string, extra?: unknown): void {
	const key = `${level}:${message}`;
	const previous = recentReports.get(key);
	const now = Date.now();
	if (previous && now - previous.at < REPORT_INTERVAL_MS) {
		previous.suppressed++;
		return;
	}
	if (recentReports.size >= 100) recentReports.delete(recentReports.keys().next().value!);
	recentReports.set(key, { at: now, suppressed: 0 });
	const payload = {
		extra,
		...(previous?.suppressed ? { suppressed: previous.suppressed } : {}),
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
		void window.maestro?.logger?.log(level, message, 'WebDesktopSentryShim', payload)?.catch(() => {
			// Already recorded locally. Reporting a logger failure would recurse.
		});
	} catch {
		// The logger bridge is best-effort; never let reporting throw back into app code.
	}
}

export function init(_options: unknown): void {}

export function captureException(err: unknown, ctx?: unknown): void {
	if (isExpectedBridgeError(err)) return;
	report('error', toErrorMessage(err), {
		context: ctx,
		stack: err instanceof Error ? err.stack : undefined,
	});
}

export function captureMessage(msg: unknown, levelOrCtx?: unknown, ctx?: unknown): void {
	if (isExpectedBridgeError(msg)) return;
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
