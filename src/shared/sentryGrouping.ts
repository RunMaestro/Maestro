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
 * the server. Only minidump events carry those annotations, so their presence
 * alone identifies one. Every V8 OOM is grouped, heap or not, because any of
 * them fails on an arbitrary allocation and would fragment the same way.
 *
 * The process name is normalized because the same process reaches here under
 * different spellings: Crashpad's `process_type` says `gpu-process`, while the
 * SDK's `event.process` fallback says `gpu` or, from `child-process-gone`,
 * `GPU`. Without it one GPU OOM could open two issues.
 */
export function v8OomFingerprint(event: MinimalSentryEvent): string[] | undefined {
	const electron = event.contexts?.electron;
	if (!electron || !(V8_OOM_ANNOTATION in electron)) return undefined;
	const processName =
		normalizeProcessName(electron['crashpad.process_type']) ||
		normalizeProcessName(event.tags?.['event.process']) ||
		'unknown';
	return ['v8-oom', processName];
}

/** `gpu-process`, `GPU` and `gpu` are one process. Empty when there is no name. */
function normalizeProcessName(raw: unknown): string {
	if (typeof raw !== 'string') return '';
	return raw
		.trim()
		.toLowerCase()
		.replace(/-process$/, '');
}
