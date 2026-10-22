/**
 * What Maestro attaches to its Sentry events beyond the SDK defaults, as pure
 * functions so the shape can be tested without an Electron or Sentry runtime.
 *
 * Privacy contract: nothing here may carry a path, a prompt, an agent name, or
 * anything a user typed. The identity is the random per-install GUID that is
 * already the `installationId` tag, and the agent context is counts plus agent
 * TYPE ids drawn from the fixed `AGENT_IDS` list.
 *
 * Noise filtering lives in `sentryFilters.ts`; this module only adds context
 * and grouping to events that are going to be sent anyway.
 */

import { isValidAgentId } from './agentIds';

/**
 * The Sentry `user` for this install. Sentry's Users column, "users affected"
 * alert conditions, and crash-free-user rates all count `user.id`, so without
 * it every issue reads "Users 0" no matter how many installs hit it. The id is
 * the install GUID, never anything about the person.
 */
export function sentryUserForInstallation(
	installationId: string | null | undefined
): { id: string } | undefined {
	const id = typeof installationId === 'string' ? installationId.trim() : '';
	return id ? { id } : undefined;
}

/** Background work in flight, derived from the power manager's block reasons. */
export interface SentryWorkContext {
	/** Auto Run documents being processed right now (one per agent). */
	autorunRuns: number;
	/** Agent turns in flight (one `session:` reason per busy agent). */
	busyAgents: number;
	/** Cue runs executing. */
	cueRuns: number;
	/** Group chat rounds in flight. */
	groupChats: number;
}

/**
 * Count the work behind the power manager's block reasons. Those reasons are
 * the one place in the main process that already learns when an Auto Run, an
 * agent turn, a Cue run, or a group chat round starts and stops (see the
 * naming convention in `power-manager.ts`), and they are recorded whether or
 * not the user enabled sleep prevention. Only the prefix is read; the ids after
 * it never leave this function.
 */
export function summarizeWorkReasons(reasons: Iterable<string>): SentryWorkContext {
	const context: SentryWorkContext = { autorunRuns: 0, busyAgents: 0, cueRuns: 0, groupChats: 0 };
	for (const reason of reasons) {
		if (reason.startsWith('autorun:')) context.autorunRuns += 1;
		else if (reason.startsWith('session:')) context.busyAgents += 1;
		else if (reason.startsWith('cue:run:')) context.cueRuns += 1;
		else if (reason.startsWith('groupchat:')) context.groupChats += 1;
	}
	return context;
}

/** Sentry tags for the work context. Tags (not contexts) so issues and alerts can filter on them. */
export function workContextTags(context: SentryWorkContext): Record<string, string> {
	return {
		'autorun.active': context.autorunRuns > 0 ? 'true' : 'false',
		'autorun.count': String(context.autorunRuns),
		'agents.busy': String(context.busyAgents),
		'cue.active': context.cueRuns > 0 ? 'true' : 'false',
		'groupchat.active': context.groupChats > 0 ? 'true' : 'false',
	};
}

/** The configured agents, reduced to what is safe to report. */
export interface SentryAgentInventory {
	count: number;
	/** Distinct agent type ids, sorted. Unknown values collapse to `other`. */
	providers: string[];
}

/**
 * Reduce the stored agent list to a count and the set of provider TYPE ids.
 * `toolType` comes off disk, so anything that is not a known agent id is
 * reported as `other` rather than echoed: a hand-edited or corrupted store must
 * not be able to put arbitrary text into a crash report.
 */
export function summarizeAgentInventory(
	sessions: ReadonlyArray<{ toolType?: unknown }>
): SentryAgentInventory {
	const providers = new Set<string>();
	for (const session of sessions) {
		const toolType = session?.toolType;
		if (typeof toolType !== 'string' || toolType === '') continue;
		providers.add(isValidAgentId(toolType) ? toolType : 'other');
	}
	return { count: sessions.length, providers: [...providers].sort() };
}

/** Sentry tags for the agent inventory. */
export function agentInventoryTags(inventory: SentryAgentInventory): Record<string, string> {
	return {
		'agents.count': String(inventory.count),
		'agents.providers': inventory.providers.length > 0 ? inventory.providers.join(',') : 'none',
	};
}

/** The subset of a Sentry event the native-crash grouping reads. */
export interface NativeCrashEventLike {
	tags?: Record<string, unknown>;
	contexts?: Record<string, Record<string, unknown> | undefined>;
}

/**
 * Fingerprint for a native crash (minidump) whose cause is already known when
 * the event is built, or `undefined` to keep Sentry's default grouping.
 *
 * A minidump event reaches `beforeSend` WITHOUT a stack trace: `@sentry/electron`
 * attaches the dump as an `event.minidump` attachment and Sentry symbolicates it
 * server side, so the crashing frame is not available to group on here. What IS
 * available are the crashpad annotations Electron writes, copied onto
 * `contexts.electron` with a `crashpad.` prefix, plus the `event.environment` /
 * `event.process` tags the SDK sets on every native crash.
 *
 * The V8 heap OOM is the case that fragments: its stack is whatever allocation
 * tipped the heap over the limit, so server-side stack grouping scattered one
 * failure mode across dozens of `partition_alloc::internal::OnNoMemoryInternal`
 * issues (one per allocation path, per release). Electron marks it explicitly
 * with `electron.v8-oom.is_heap_oom = "1"`, so those are grouped by process
 * alone. Other native crashes keep default grouping, since there the stack is
 * the signal; consolidating those by top frame is a server-side fingerprint
 * rule, because only the server has the frames.
 *
 * The process name is lowercased because the SDK reports the same process as
 * both `GPU` and `gpu` depending on which crash path built the event.
 */
export function buildNativeCrashFingerprint(event: NativeCrashEventLike): string[] | undefined {
	if (event.tags?.['event.environment'] !== 'native') return undefined;
	const electron = event.contexts?.electron;
	if (electron?.['crashpad.electron.v8-oom.is_heap_oom'] !== '1') return undefined;
	const rawProcess = event.tags?.['event.process'];
	const processType =
		typeof rawProcess === 'string' && rawProcess.trim()
			? rawProcess.trim().toLowerCase()
			: 'unknown';
	return ['native-crash', 'v8-heap-oom', processType];
}
