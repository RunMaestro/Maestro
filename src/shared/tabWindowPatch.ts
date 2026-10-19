/**
 * Pure patch logic for Tab Windows (D2): how an owner app window streams one
 * agent's `Session` to that agent's tab window, and how the tab window applies
 * the stream to the copy it renders.
 *
 * The owner sends a snapshot (`buildTabWindowSnapshot`) when the tab window
 * attaches and whenever the set of popped tabs changes, then deltas
 * (`diffTabWindowSession`). The tab window applies both with
 * `applyTabWindowPatch`. The wire envelopes are in `tabWindowTypes.ts`; the
 * publisher numbers them.
 *
 * Every function here keeps three rules:
 * - Transcripts travel for popped tabs only. Every other tab, in the tab lists
 *   or held elsewhere on the session (closed, snoozed, orphaned), arrives with
 *   `logs: []`, and a delta never names a tab that is not popped.
 * - Per-window fields (`isClientSessionField`: active pointers, input mode, the
 *   composer and terminal drafts, PTY attachment) belong to the receiving
 *   window. A delta never carries them, and a snapshot for the agent the tab
 *   window already holds keeps the window's own values. A popped file tab adds
 *   the fields the tab window owns while it renders the file
 *   (`isTabWindowFileTabField`: edits, mode, scroll, disk state), and a popped
 *   browser tab what its own webview reports (`isTabWindowBrowserTabField`:
 *   page, history flags, loading, guest id), on the same terms.
 * - Tool output crosses capped (`compactLogToolOutputs`), the bound a stored
 *   transcript has. An entry that is already capped goes as it is.
 *
 * Generic over the session shape: `src/renderer/types` is out of reach of
 * `tsconfig.main.json`, so the renderer passes its own `Session`, which
 * satisfies {@link TabWindowPatchSession}.
 *
 * Design map: `docs/agent-guides/TAB-WINDOWS.md` ("Patch logic").
 */

import { isClientSessionField } from './sessionPersistenceMerge';
import { compactLogToolOutputs } from './toolOutput';
import { isTabWindowBrowserTabField, isTabWindowFileTabField } from './tabWindowTypes';
import type {
	TabWindowLogSplice,
	TabWindowSessionDelta,
	TabWindowSessionPatch,
	TabWindowTabDelta,
	TabWindowTabRef,
} from './tabWindowTypes';
import { isSingleTabRef, tabRefKey, type SingleTabType } from './unifiedTabRef';

// ============================================================================
// Types
// ============================================================================

/** The `Session` list that holds each kind of tab. */
const TAB_LIST_KEYS = {
	ai: 'aiTabs',
	file: 'filePreviewTabs',
	terminal: 'terminalTabs',
	browser: 'browserTabs',
} as const satisfies Record<SingleTabType, string>;

type TabListKey = (typeof TAB_LIST_KEYS)[SingleTabType];

const TAB_TYPES = Object.keys(TAB_LIST_KEYS) as SingleTabType[];
const TAB_LIST_KEY_SET: ReadonlySet<string> = new Set<string>(Object.values(TAB_LIST_KEYS));

/** What the patch logic reads of a session. The renderer's `Session` satisfies it. */
export interface TabWindowPatchSession {
	id: string;
	aiTabs: ReadonlyArray<{ id: string; logs: readonly unknown[] }>;
	filePreviewTabs: ReadonlyArray<{ id: string }>;
	terminalTabs: ReadonlyArray<{ id: string }>;
	browserTabs: ReadonlyArray<{ id: string }>;
}

/** Any tab of the session shape `S`. */
export type TabWindowTabOf<S extends TabWindowPatchSession> = S[TabListKey][number];

/** A transcript entry of the session shape `S`. */
export type TabWindowLogOf<S extends TabWindowPatchSession> = S['aiTabs'][number]['logs'][number];

/** A patch for the session shape `S`. */
export type TabWindowPatchOf<S extends TabWindowPatchSession> = TabWindowSessionPatch<
	S,
	TabWindowTabOf<S>,
	TabWindowLogOf<S>
>;

/** What changed between two states: the body of a delta, before the publisher numbers it. */
export type TabWindowDeltaChanges<S extends TabWindowPatchSession> = Pick<
	TabWindowSessionDelta<S, TabWindowTabOf<S>, TabWindowLogOf<S>>,
	'session' | 'tabs'
>;

/** What a tab window holds of its agent, and where it is in the owner's patch stream. */
export interface TabWindowMirror<S> {
	/** The agent as the tab window renders it. */
	session: S;
	/** The popped refs of the last snapshot. The tab window owns the draft of these tabs. */
	tabRefs: TabWindowTabRef[];
	/** `seq` of the last patch applied. */
	seq: number;
}

// ============================================================================
// Field helpers
// ============================================================================

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
	return typeof value === 'object' && value !== null;
}

/** `items` with `fn` applied, or `items` itself when no item changed. */
function mapChanged<T>(items: readonly T[], fn: (item: T) => T): readonly T[] {
	let result: T[] | null = null;
	for (let index = 0; index < items.length; index++) {
		const item = fn(items[index]);
		if (item === items[index]) continue;
		result ??= items.slice();
		result[index] = item;
	}
	return result ?? items;
}

/** Every own key of either record. */
function keysOf(a: Fields, b: Fields): Set<string> {
	return new Set([...Object.keys(a), ...Object.keys(b)]);
}

/**
 * The fields of `next` that differ from `prev` by identity, each passed through
 * `project`, skipping `skip`. A field `next` no longer has is reported as
 * `undefined`. Null when none changed.
 */
function changedFields(
	prev: Fields,
	next: Fields,
	skip: (key: string) => boolean,
	project: (key: string, value: unknown) => unknown = (_key, value) => value
): Fields | null {
	let changes: Fields | null = null;
	for (const key of keysOf(prev, next)) {
		if (skip(key) || prev[key] === next[key]) continue;
		changes ??= {};
		changes[key] = project(key, next[key]);
	}
	return changes;
}

/** `target` with `fields` written over it, skipping `skip`. `undefined` removes a field. */
function assignFields(target: Fields, fields: Fields, skip: (key: string) => boolean): Fields {
	let result: Fields | null = null;
	for (const [key, value] of Object.entries(fields)) {
		if (skip(key)) continue;
		if (value === undefined ? !(key in target) : target[key] === value) continue;
		result ??= { ...target };
		if (value === undefined) delete result[key];
		else result[key] = value;
	}
	return result ?? target;
}

/**
 * `target` with the per-window fields of `source` (`isOwn`), present or absent
 * alike.
 */
function withClientFieldsOf(
	target: Fields,
	source: Fields,
	isOwn: (key: string) => boolean = isClientSessionField
): Fields {
	let result: Fields | null = null;
	for (const key of keysOf(target, source)) {
		if (!isOwn(key) || target[key] === source[key]) continue;
		result ??= { ...target };
		if (key in source) result[key] = source[key];
		else delete result[key];
	}
	return result ?? target;
}

/** Not sent as a session field: a tab list (it travels per popped tab) or a per-window field. */
function isUnsentSessionField(key: string): boolean {
	return TAB_LIST_KEY_SET.has(key) || isClientSessionField(key);
}

/**
 * A field of a tab of kind `type` that belongs to the window holding the tab:
 * a per-window field, or one the tab window owns while it renders the tab: on
 * a file tab the file's state, on a browser tab what its webview reports.
 */
function isOwnTabField(type: SingleTabType, key: string): boolean {
	return (
		isClientSessionField(key) ||
		(type === 'file' && isTabWindowFileTabField(key)) ||
		(type === 'browser' && isTabWindowBrowserTabField(key))
	);
}

/** Not sent as a tab field: the transcript (it travels as a splice) or a per-window field. */
function unsentTabFieldOf(type: SingleTabType): (key: string) => boolean {
	return (key) => key === 'logs' || isOwnTabField(type, key);
}

// ============================================================================
// Transcripts
// ============================================================================

function logsOf(tab: Fields): unknown[] {
	return Array.isArray(tab.logs) ? tab.logs : [];
}

function capLogs(logs: unknown[]): unknown[] {
	return compactLogToolOutputs(logs).logs;
}

/** The tab without its transcript (the same object when it has none). */
function withoutLogs<T>(tab: T): T {
	if (!isFields(tab) || !Array.isArray(tab.logs) || tab.logs.length === 0) return tab;
	return { ...tab, logs: [] } as T;
}

/** The tab with its tool output capped (the same object when nothing needed it). */
function withCappedLogs<T>(tab: T): T {
	if (!isFields(tab) || !Array.isArray(tab.logs)) return tab;
	const logs = capLogs(tab.logs);
	return logs === tab.logs ? tab : ({ ...tab, logs } as T);
}

/** A closed, snoozed, or orphaned entry with every tab it holds stripped of its transcript. */
function entryWithoutLogs<T>(entry: T): T {
	if (!isFields(entry)) return entry;
	let result: Fields = entry;
	const tab = withoutLogs(entry.tab);
	if (tab !== entry.tab) result = { ...result, tab };
	if (Array.isArray(entry.members)) {
		const members = mapChanged(entry.members, entryWithoutLogs);
		if (members !== entry.members) result = { ...result, members };
	}
	return result as T;
}

/**
 * Session fields that hold tabs outside the tab lists. A tab there was closed,
 * snoozed, or closed mid-turn, so it is never popped and its transcript never
 * travels.
 */
const TAB_HOLDER_FIELDS = new Map<string, (value: readonly unknown[]) => readonly unknown[]>([
	['orphanedThinkingTabs', (tabs) => mapChanged(tabs, withoutLogs)],
	['closedTabHistory', (entries) => mapChanged(entries, entryWithoutLogs)],
	['unifiedClosedTabHistory', (entries) => mapChanged(entries, entryWithoutLogs)],
	['snoozedTabs', (entries) => mapChanged(entries, entryWithoutLogs)],
]);

/** A session-level field as it travels: a tab holder without its transcripts. */
function projectSessionField(key: string, value: unknown): unknown {
	const project = TAB_HOLDER_FIELDS.get(key);
	return project && Array.isArray(value) ? project(value) : value;
}

function findTab(session: object, ref: TabWindowTabRef): Fields | undefined {
	const tabs = (session as Fields)[TAB_LIST_KEYS[ref.type]];
	return Array.isArray(tabs) ? (tabs as Fields[]).find((tab) => tab.id === ref.id) : undefined;
}

// ============================================================================
// Owner side
// ============================================================================

/**
 * The agent as its tab window receives it on attach: the whole session, with
 * the transcript kept on the popped AI tabs only (tool output capped) and
 * emptied on every other tab, closed, snoozed, and orphaned ones included.
 * Per-window fields go as the owner has them: a tab window seeds from them and
 * keeps its own after that.
 */
export function buildTabWindowSnapshot<S extends TabWindowPatchSession>(
	session: S,
	poppedRefs: readonly TabWindowTabRef[]
): S {
	const popped = new Set(poppedRefs.map(tabRefKey));
	const snapshot: Fields = { ...(session as unknown as Fields) };
	for (const key of TAB_HOLDER_FIELDS.keys()) {
		if (key in snapshot) snapshot[key] = projectSessionField(key, snapshot[key]);
	}
	if (Array.isArray(session.aiTabs)) {
		snapshot.aiTabs = mapChanged(session.aiTabs, (tab) =>
			popped.has(tabRefKey({ type: 'ai', id: tab.id })) ? withCappedLogs(tab) : withoutLogs(tab)
		);
	}
	return snapshot as unknown as S;
}

/**
 * What changed from `prev` to `next` for a tab window that holds `poppedRefs`,
 * or null when nothing it receives changed.
 *
 * - `session`: the session-level fields that differ by identity, except the
 *   tab lists and the per-window fields. A tab holder (closed, snoozed,
 *   orphaned) travels without its transcripts.
 * - `tabs`: one entry per popped tab that changed: its changed fields (never a
 *   per-window one) and, for an AI tab, the transcript tail from the first
 *   index where `prev` and `next` hold different entries. A popped tab that
 *   left the tab lists is `removed`; one that came back carries all of itself.
 *   A tab that is not popped is never named.
 *
 * `prev` must be the state the previous patch was built from, not the last
 * state the owner saw, and `poppedRefs` the refs of the last snapshot. When the
 * popped set changes, the owner sends a new snapshot instead of a delta.
 */
export function diffTabWindowSession<S extends TabWindowPatchSession>(
	prev: S,
	next: S,
	poppedRefs: readonly TabWindowTabRef[]
): TabWindowDeltaChanges<S> | null {
	if (prev === next) return null;
	const session = changedFields(
		prev as unknown as Fields,
		next as unknown as Fields,
		isUnsentSessionField,
		projectSessionField
	);
	const tabs: TabWindowTabDelta[] = [];
	const seen = new Set<string>();
	for (const ref of poppedRefs) {
		const key = tabRefKey(ref);
		if (seen.has(key)) continue;
		seen.add(key);
		const delta = diffTab(ref, findTab(prev, ref), findTab(next, ref));
		if (delta) tabs.push(delta);
	}
	if (!session && tabs.length === 0) return null;
	return {
		...(session ? { session: session as Partial<S> } : {}),
		...(tabs.length > 0
			? { tabs: tabs as TabWindowTabDelta<TabWindowTabOf<S>, TabWindowLogOf<S>>[] }
			: {}),
	};
}

/** One popped tab's change, or null when it did not change. */
function diffTab(
	ref: TabWindowTabRef,
	prev: Fields | undefined,
	next: Fields | undefined
): TabWindowTabDelta | null {
	if (prev === next) return null;
	if (!next) return { ref, removed: true };
	if (!prev) {
		// New to the tab window: all of it, the draft included (it seeds the composer).
		const { logs, ...fields } = next;
		return ref.type === 'ai'
			? { ref, fields, logSplice: { start: 0, entries: capLogs(Array.isArray(logs) ? logs : []) } }
			: { ref, fields };
	}
	const fields = changedFields(prev, next, unsentTabFieldOf(ref.type));
	const logSplice = ref.type === 'ai' ? diffLogs(logsOf(prev), logsOf(next)) : null;
	if (!fields && !logSplice) return null;
	return { ref, ...(fields ? { fields } : {}), ...(logSplice ? { logSplice } : {}) };
}

/**
 * The changed tail of a transcript. Entries are replaced, never mutated, so it
 * starts at the first index where the two arrays hold different entries. That
 * covers an append, a streamed chunk rewriting the last entry, a flush that
 * drops an earlier thinking entry, a backfill that prepends history, and a
 * truncation. Null when both hold the same entries.
 */
function diffLogs(prev: unknown[], next: unknown[]): TabWindowLogSplice | null {
	if (prev === next) return null;
	const shared = Math.min(prev.length, next.length);
	let start = 0;
	while (start < shared && prev[start] === next[start]) start++;
	if (start === prev.length && start === next.length) return null;
	return { start, entries: capLogs(next.slice(start)) };
}

// ============================================================================
// Tab window side
// ============================================================================

/**
 * Apply one patch to what the tab window holds. Returns the new mirror, or null
 * when the patch cannot be applied; the caller then asks the owner for a fresh
 * snapshot and drops deltas until it arrives.
 *
 * A snapshot always applies. For the agent the window already holds, it keeps
 * the window's own per-window fields: the session-level ones (active pointers,
 * input mode, terminal draft) always, and a tab's draft (and a file or browser
 * tab's window-owned state) when that tab was in the previous snapshot's `tabRefs`
 * and still is. A tab that just arrived takes the owner's draft, which seeds
 * the composer (D2), and so does a tab that left (the owner holds its draft
 * again).
 *
 * A delta applies only to the same agent, right after the previous patch
 * (`seq + 1`), and only when every log splice lands inside the transcript the
 * window holds. A per-window field in it is ignored.
 *
 * Pass the session the window holds now (its store's copy), so that local
 * writes to per-window fields, such as the composer flushing a draft, survive.
 */
export function applyTabWindowPatch<S extends TabWindowPatchSession>(
	current: TabWindowMirror<S> | null,
	patch: TabWindowPatchOf<S>
): TabWindowMirror<S> | null {
	if (patch.form === 'snapshot') {
		if (patch.session.id !== patch.agentId) return null;
		const held = current?.session.id === patch.agentId ? current : null;
		return {
			session: held ? keepOwnFields(patch.session, held, patch.tabRefs) : patch.session,
			tabRefs: patch.tabRefs,
			seq: patch.seq,
		};
	}
	if (!current || current.session.id !== patch.agentId || patch.seq !== current.seq + 1) {
		return null;
	}
	// Main checks only the envelope, so a malformed body asks for a snapshot
	// instead of throwing in the window's patch listener.
	const { session: fields, tabs } = patch as { session?: unknown; tabs?: unknown };
	if (fields !== undefined && !isFields(fields)) return null;
	if (tabs !== undefined && !Array.isArray(tabs)) return null;
	let session = current.session as unknown as Fields;
	if (fields) session = assignFields(session, fields, isUnsentSessionField);
	for (const delta of tabs ?? []) {
		const applied = applyTabDelta(session, delta);
		if (!applied) return null;
		session = applied;
	}
	return { session: session as unknown as S, tabRefs: current.tabRefs, seq: patch.seq };
}

/** A snapshot of the agent the window holds, with the window's own per-window fields kept. */
function keepOwnFields<S extends TabWindowPatchSession>(
	snapshot: S,
	held: TabWindowMirror<S>,
	tabRefs: readonly TabWindowTabRef[]
): S {
	const before = new Set(held.tabRefs.map(tabRefKey));
	const now = new Set(tabRefs.map(tabRefKey));
	let session = withClientFieldsOf(
		snapshot as unknown as Fields,
		held.session as unknown as Fields
	);
	for (const type of TAB_TYPES) {
		const key = TAB_LIST_KEYS[type];
		const tabs = session[key];
		if (!Array.isArray(tabs)) continue;
		const kept = mapChanged(tabs as Fields[], (tab) => {
			const ref: TabWindowTabRef = { type, id: String(tab.id) };
			const refKey = tabRefKey(ref);
			if (!before.has(refKey) || !now.has(refKey)) return tab;
			const own = findTab(held.session, ref);
			return own ? withClientFieldsOf(tab, own, (field) => isOwnTabField(type, field)) : tab;
		});
		if (kept !== tabs) session = { ...session, [key]: kept };
	}
	return session as unknown as S;
}

/**
 * The session with one tab delta applied, or null when the delta does not fit
 * what the window holds: a malformed delta, a splice that does not land, or a
 * partial change to a tab the window does not hold.
 */
function applyTabDelta(session: Fields, delta: unknown): Fields | null {
	if (!isFields(delta)) return null;
	const { ref, removed, fields } = delta;
	if (!isSingleTabRef(ref)) return null;
	if (fields !== undefined && !isFields(fields)) return null;
	const splice = ref.type === 'ai' ? delta.logSplice : undefined;
	if (splice !== undefined && !isFields(splice)) return null;
	const key = TAB_LIST_KEYS[ref.type];
	const tabs = (Array.isArray(session[key]) ? session[key] : []) as Fields[];
	const index = tabs.findIndex((tab) => tab.id === ref.id);
	if (removed) {
		return index < 0 ? session : { ...session, [key]: tabs.filter((_, i) => i !== index) };
	}
	if (index < 0) {
		// Not held yet: only a whole tab can be added, and a whole tab's fields
		// include its id (a change never does). Its draft rides along as the seed.
		if (fields?.id !== ref.id) return null;
		if (splice && !isLandingSplice(splice, 0)) return null;
		const tab = assignFields({}, fields, (field) => field === 'logs');
		const added = ref.type === 'ai' ? { ...tab, logs: splice?.entries ?? [] } : tab;
		return { ...session, [key]: [...tabs, added] };
	}
	let tab = tabs[index];
	if (fields) tab = assignFields(tab, fields, unsentTabFieldOf(ref.type));
	if (splice) {
		const logs = logsOf(tab);
		if (!isLandingSplice(splice, logs.length)) return null;
		tab = { ...tab, logs: [...logs.slice(0, splice.start), ...splice.entries] };
	}
	if (tab === tabs[index]) return session;
	const nextTabs = tabs.slice();
	nextTabs[index] = tab;
	return { ...session, [key]: nextTabs };
}

/**
 * A splice lands when it starts inside the transcript held or right at its end.
 * One that starts past the end follows a patch this window missed.
 */
function isLandingSplice(
	splice: Fields,
	heldLength: number
): splice is Fields & TabWindowLogSplice {
	return (
		typeof splice.start === 'number' &&
		Number.isInteger(splice.start) &&
		splice.start >= 0 &&
		splice.start <= heldLength &&
		Array.isArray(splice.entries)
	);
}
