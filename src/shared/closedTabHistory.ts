/**
 * The stored form of an agent's closed-tab history (`unifiedClosedTabHistory`,
 * the stack Cmd+Shift+T pops).
 *
 * In memory every entry holds the whole closed tab, transcript included. On disk
 * an entry is a pointer: enough to find the content again, not the content.
 *
 *   - AI tab whose provider can give the transcript back (a provider session id,
 *     a provider with `supportsSessionStorage`, an agent that is not SSH-remote):
 *     logs are dropped. Reopening reads the transcript back through
 *     `loadResumableSession()`.
 *   - Any other AI tab keeps its newest `MAX_PERSISTED_SESSION_LOGS` logs, as an
 *     open tab does, because nothing else holds them.
 *   - File tab: content is dropped and re-read from disk on reopen.
 *   - Browser tab: page runtime is reset; an incognito tab is never stored.
 *   - Terminal tab: PTY runtime is reset; reopening starts a fresh shell.
 *
 * The legacy AI-only `closedTabHistory` is never stored.
 *
 * The projection runs in BOTH processes: the renderer applies it when it
 * persists and when it restores, main applies it when it loads the store and to
 * every record a write touches. That matters because of the three-way merge in
 * `sessionPersistenceMerge.ts`: if the stored stack ever differs from what the
 * renderer's own projection produces, every later change reads as a conflict
 * and never reaches disk. So the function is:
 *   1. pure and deterministic (no clock, no randomness, no I/O),
 *   2. idempotent (projecting a projected stack returns an equal stack),
 *   3. tolerant of malformed data from older stores,
 *   4. canonical when empty (`undefined`, so the key is absent on disk, never `[]`),
 *   5. shape-preserving (untouched objects keep their reference and key order).
 */

import { MAX_PERSISTED_SESSION_LOGS } from './deferredSessionContent';
import { isEphemeralBrowserTab } from './browserTabPartition';
import { hasCapability } from './maestro-lib/providers/capabilities';

/** Closed tabs kept per agent, in memory and on disk. */
export const MAX_CLOSED_TAB_HISTORY = 25;

/** What the projection needs to know about the agent that owns the stack. */
export interface ClosedTabHistoryContext {
	/** The agent's provider, used when an AI tab carries no `turnProvider`. */
	toolType: string | undefined;
	/** True when the agent runs over SSH: its transcripts are not read back locally. */
	sshRemote: boolean;
}

type RecordData = Record<string, unknown>;

const CLOSED_TAB_TYPES = new Set(['ai', 'file', 'browser', 'terminal']);

const AI_RUNTIME_KEYS = [
	'thinkingStartTime',
	'agentError',
	'wizardState',
	'isGeneratingName',
	'awaitingSessionId',
	'scrollTop',
	'isAtBottom',
];
const FILE_RUNTIME_KEYS = [
	'editContent',
	'isLoading',
	'loadRequestId',
	'navigationHistory',
	'navigationIndex',
	'pendingScrollToLine',
];
const BROWSER_RUNTIME_KEYS = ['webContentsId', 'remotePage'];
const TERMINAL_RUNTIME_KEYS = ['exitCode', 'ptyInitialized'];

function isRecord(value: unknown): value is RecordData {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** `value` with `values` set and `keys` removed; the same reference when nothing changes. */
function patch(value: RecordData, values: RecordData, keys: string[] = []): RecordData {
	const changes = Object.keys(values).some((key) => value[key] !== values[key]);
	const removals = keys.some((key) => Object.prototype.hasOwnProperty.call(value, key));
	if (!changes && !removals) return value;
	const next: RecordData = { ...value, ...values };
	for (const key of keys) delete next[key];
	return next;
}

/** The provider context of a stored or in-memory agent record. */
export function closedTabHistoryContext(record: unknown): ClosedTabHistoryContext {
	const source = isRecord(record) ? record : {};
	const ssh = source.sessionSshRemoteConfig;
	return {
		toolType: typeof source.toolType === 'string' ? source.toolType : undefined,
		sshRemote: isRecord(ssh) && ssh.enabled === true,
	};
}

/**
 * True when reopening this closed AI tab can read its transcript back from the
 * provider, so the stored entry may drop its logs.
 */
export function isClosedAiTabReloadable(tab: unknown, context: ClosedTabHistoryContext): boolean {
	if (!isRecord(tab) || context.sshRemote) return false;
	if (typeof tab.agentSessionId !== 'string' || tab.agentSessionId.length === 0) return false;
	const provider = typeof tab.turnProvider === 'string' ? tab.turnProvider : context.toolType;
	return !!provider && hasCapability(provider, 'supportsSessionStorage');
}

function projectAiTab(tab: RecordData, context: ClosedTabHistoryContext): RecordData {
	const agentSessionId =
		typeof tab.agentSessionId === 'string' || tab.agentSessionId === null
			? tab.agentSessionId
			: null;
	const coerced = patch(tab, { agentSessionId });
	const logs = Array.isArray(coerced.logs) ? coerced.logs : [];
	let storedLogs: unknown[];
	if (isClosedAiTabReloadable(coerced, context)) {
		storedLogs = logs.length === 0 && Array.isArray(coerced.logs) ? coerced.logs : [];
	} else if (logs.length > MAX_PERSISTED_SESSION_LOGS) {
		storedLogs = logs.slice(-MAX_PERSISTED_SESSION_LOGS);
	} else {
		storedLogs = logs;
	}
	return patch(coerced, { logs: storedLogs, state: 'idle' }, AI_RUNTIME_KEYS);
}

function projectFileTab(tab: RecordData): RecordData {
	return patch(tab, { content: '' }, FILE_RUNTIME_KEYS);
}

function projectBrowserTab(tab: RecordData): RecordData {
	return patch(
		tab,
		{ isLoading: false, canGoBack: false, canGoForward: false },
		BROWSER_RUNTIME_KEYS
	);
}

function projectTerminalTab(tab: RecordData): RecordData {
	return patch(tab, { pid: 0, state: 'idle' }, TERMINAL_RUNTIME_KEYS);
}

/**
 * A `tilePlacement` the restore can use. `restoreTilePlacement()` dereferences
 * `anchorRef` without a guard, so anything less is dropped and the tab comes
 * back in the strip instead.
 */
function isUsableTilePlacement(value: unknown): boolean {
	if (!isRecord(value) || typeof value.groupId !== 'string') return false;
	const anchor = value.anchorRef;
	return (
		isRecord(anchor) &&
		typeof anchor.type === 'string' &&
		typeof anchor.id === 'string' &&
		(value.direction === 'row' || value.direction === 'column')
	);
}

function projectEntry(entry: unknown, context: ClosedTabHistoryContext): RecordData | null {
	if (!isRecord(entry) || typeof entry.type !== 'string' || !CLOSED_TAB_TYPES.has(entry.type)) {
		return null;
	}
	const tab = entry.tab;
	if (!isRecord(tab) || typeof tab.id !== 'string') return null;

	let storedTab: RecordData;
	switch (entry.type) {
		case 'ai':
			storedTab = projectAiTab(tab, context);
			break;
		case 'file':
			storedTab = projectFileTab(tab);
			break;
		case 'browser':
			if (isEphemeralBrowserTab(tab)) return null;
			storedTab = projectBrowserTab(tab);
			break;
		default:
			storedTab = projectTerminalTab(tab);
	}

	// Every reopen branch clamps the index with `Math.min(unifiedIndex,
	// order.length)`, so an unusable one lands the tab at the end of the strip.
	const unifiedIndex =
		typeof entry.unifiedIndex === 'number' &&
		Number.isFinite(entry.unifiedIndex) &&
		entry.unifiedIndex >= 0
			? entry.unifiedIndex
			: Number.MAX_SAFE_INTEGER;
	const closedAt =
		typeof entry.closedAt === 'number' && Number.isFinite(entry.closedAt) ? entry.closedAt : 0;
	const dropPlacement =
		Object.prototype.hasOwnProperty.call(entry, 'tilePlacement') &&
		!isUsableTilePlacement(entry.tilePlacement);
	return patch(
		entry,
		{ tab: storedTab, unifiedIndex, closedAt },
		dropPlacement ? ['tilePlacement'] : []
	);
}

/**
 * The stored form of a closed-tab stack: newest first, at most
 * `MAX_CLOSED_TAB_HISTORY` entries, each reduced to a pointer. `undefined` when
 * nothing is left, so the key stays off disk. Untouched entries keep their
 * reference.
 */
export function projectClosedTabHistory<T = RecordData>(
	history: unknown,
	context: ClosedTabHistoryContext
): T[] | undefined {
	if (!Array.isArray(history)) return undefined;
	const stored: RecordData[] = [];
	for (const entry of history) {
		if (stored.length >= MAX_CLOSED_TAB_HISTORY) break;
		const projected = projectEntry(entry, context);
		if (projected) stored.push(projected);
	}
	return stored.length > 0 ? (stored as T[]) : undefined;
}

/**
 * A stored agent record with its closed-tab stack in stored form: the unified
 * stack projected (key removed when empty) and the legacy `closedTabHistory` key
 * removed. Returns the same reference when the record already conforms, so main
 * can tell whether a load needs a rewrite.
 */
export function normalizeStoredClosedTabs<T>(record: T): T {
	if (!isRecord(record)) return record;
	const hasLegacy = Object.prototype.hasOwnProperty.call(record, 'closedTabHistory');
	const hasUnified = Object.prototype.hasOwnProperty.call(record, 'unifiedClosedTabHistory');
	if (!hasLegacy && !hasUnified) return record;

	const current = record.unifiedClosedTabHistory;
	const projected = projectClosedTabHistory(current, closedTabHistoryContext(record));
	const unchanged =
		!hasLegacy &&
		Array.isArray(current) &&
		projected !== undefined &&
		projected.length === current.length &&
		projected.every((entry, index) => entry === current[index]);
	if (unchanged) return record;

	const next: RecordData = { ...record };
	delete next.closedTabHistory;
	if (projected) next.unifiedClosedTabHistory = projected;
	else delete next.unifiedClosedTabHistory;
	return next as T;
}
