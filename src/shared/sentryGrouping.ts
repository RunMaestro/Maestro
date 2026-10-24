/**
 * Sentry grouping overrides: events Sentry's default grouping splits apart.
 *
 * A V8 out-of-memory abort arrives as a native minidump, and Sentry groups
 * minidumps by their symbolicated native stack. An OOM's stack names whatever
 * allocation happened to fail last (a string flatten, a TCP connect callback,
 * GC internals), so one failure mode was spread across ~24 main-process
 * issues (#1862), none of them large enough to stand out. Grouping by process
 * type instead keeps every OOM of the main process in one issue and every
 * renderer OOM in another, where event and install counts mean something.
 */

interface MinimalSentryEvent {
	contexts?: Record<string, Record<string, unknown> | undefined>;
	tags?: Record<string, unknown>;
}

/** Crashpad annotation Electron sets on every V8 OOM, heap or otherwise. */
const V8_OOM_ANNOTATION = 'crashpad.electron.v8-oom.is_heap_oom';

/**
 * The fingerprint for a V8 OOM minidump, or undefined for any other event.
 *
 * @sentry/electron copies a minidump's Crashpad annotations into
 * `contexts.electron` under a `crashpad.` prefix before `beforeSend` runs,
 * which is the only client-side signal: the native stack is symbolicated on
 * the server.
 */
export function v8OomFingerprint(event: MinimalSentryEvent): string[] | undefined {
	const electron = event.contexts?.electron;
	if (!electron || !(V8_OOM_ANNOTATION in electron)) return undefined;
	const processType =
		electron['crashpad.process_type'] ?? event.tags?.['event.process'] ?? 'unknown';
	return ['v8-oom', String(processType)];
}
