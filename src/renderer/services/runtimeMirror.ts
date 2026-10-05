/**
 * The renderer's mirror of the hosted runtime (4.3 and 4.5 of the migration plan).
 *
 * With the `libraryRuntime` setting on, main owns agents, groups, and tabs. This window keeps its Zustand
 * store as a mirror of them: it loads the runtime's snapshot once, applies every stamped event the
 * runtime emits, and sends its own changes as commands (`agentOps.ts`) or, for what it owns itself, as
 * the desktop fold. This module is the state and the rules; nothing here knows about React.
 *
 * What it remembers, per agent: the revision it last applied and the DOMAIN view of the record it last
 * applied (`FoldBaseline`). The revision guards two things. An event at or below it is stale and is
 * skipped, which is also how this window's own command echo is recognised. A fold names it as `baseRev`,
 * so a domain edit made in a window that has not seen the latest change is dropped by the runtime instead
 * of overwriting it. The baseline is what a fold's domain part is diffed against.
 *
 * While this window has a command in flight for an agent, the events about that agent are held and the
 * newest is applied after the last answer lands: two quick commands never flicker the first one's result
 * back onto the screen.
 *
 * With the setting off nothing here is reached: `isLibraryRuntimeHosting()` is false and every caller
 * keeps today's path.
 */

import type {
	DesktopFold,
	DesktopFoldGroups,
	DesktopSnapshot,
} from '../../shared/maestro-lib/agents/desktop-fold-types';
import {
	baselineOf,
	buildFoldAgent,
	type FoldBaseline,
} from '../../shared/maestro-lib/agents/fold-builder';
import { GROUP_DOMAIN_KEYS } from '../../shared/maestro-lib/agents/ownership';
import { valuesEqual } from '../../shared/maestro-lib/client/mirror';
import type {
	AgentRecord,
	GroupRecord,
	TabRefRecord,
} from '../../shared/maestro-lib/store/records';
import type {
	LibraryRuntimeCommand,
	LibraryRuntimeCommandAnswer,
	LibraryRuntimeEventMessage,
} from '../../shared/libraryRuntime';
import { useSessionStore } from '../stores/sessionStore';
import { notifyToast } from '../stores/notificationStore';
import type { Group, Session } from '../types';
import { applyRuntimeAgentRecord, sessionFromRecord } from '../utils/runtimeAgentRecord';
import { generateId } from '../utils/ids';
import { logger } from '../utils/logger';
import { isLibraryRuntimeHosting } from './libraryRuntime';

const LOG_CONTEXT = '[RuntimeMirror]';

interface AgentMirror {
	rev: number;
	baseline: FoldBaseline;
}

/** What the mirror needs from its host: how to prepare an agent that arrives from the runtime. */
export interface RuntimeMirrorHost {
	restoreSession: (session: Session) => Promise<Session>;
	/** Called after agents arrived, to put busy indicators back on any that are mid-turn. */
	reattachLiveTurns?: () => void | Promise<void>;
}

const agents = new Map<string, AgentMirror>();
let groupsRev = 0;
let authoritativeGroups: GroupRecord[] = [];
/** Agents the runtime reported removed: a late event must not bring one back. */
const gone = new Set<string>();
const inFlight = new Map<string, number>();
const held = new Map<string, LibraryRuntimeEventMessage>();
/**
 * An agent this window is creating, as it will hold it (view and workspace state included). The runtime's
 * record of a new agent has none of that, so the arrival of `agent.added` for one of these takes the
 * runtime's domain keys onto this copy instead of building a bare session from the record.
 */
const pendingLocal = new Map<string, Session>();
let host: RuntimeMirrorHost | null = null;
let fenced = false;
/**
 * Events arrive from the moment the stream starts, and the stream starts BEFORE the snapshot is read so
 * nothing emitted in between is lost. Until the snapshot has seeded the mirror and the store holds its
 * agents, they wait here; each is then applied in order and the stale ones (at or below the snapshot's
 * revision) are skipped.
 */
let loaded = false;
let early: Array<{
	message: LibraryRuntimeEventMessage;
	options: { force?: boolean; snap?: boolean };
}> = [];
/** Events apply one at a time, in arrival order: restoring an agent suspends. */
let queue: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** Remember the runtime's state as the baseline. Call with the snapshot the store was loaded from. */
export function seedRuntimeMirror(snapshot: DesktopSnapshot): void {
	agents.clear();
	gone.clear();
	held.clear();
	inFlight.clear();
	for (const agent of snapshot.agents) {
		agents.set(agent.id, {
			rev: snapshot.revs[agent.id] ?? 0,
			baseline: baselineOf(agent),
		});
	}
	groupsRev = snapshot.groupsRev;
	authoritativeGroups = snapshot.groups.map(domainOfGroup);
	fenced = false;
}

/** The store holds the snapshot's agents: apply the events that arrived while it loaded. */
export function markRuntimeMirrorLoaded(): void {
	loaded = true;
	const waiting = early;
	early = [];
	for (const { message, options } of waiting) void applyRuntimeMessage(message, options);
}

export function setRuntimeMirrorHost(next: RuntimeMirrorHost | null): void {
	host = next;
}

/** Forget everything. For tests. */
export function resetRuntimeMirror(): void {
	agents.clear();
	gone.clear();
	held.clear();
	inFlight.clear();
	pendingLocal.clear();
	groupsRev = 0;
	authoritativeGroups = [];
	host = null;
	fenced = false;
	loaded = false;
	early = [];
	queue = Promise.resolve();
}

/** The revision this window last applied for an agent, or undefined for one the runtime never told it about. */
export function runtimeRevisionOf(agentId: string): number | undefined {
	return agents.get(agentId)?.rev;
}

export function runtimeKnowsAgent(agentId: string): boolean {
	return agents.has(agentId);
}

export function isRuntimeFenced(): boolean {
	return fenced;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function domainOfGroup(group: Record<string, unknown>): GroupRecord {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(group)) {
		if (GROUP_DOMAIN_KEYS.has(key) && value !== undefined) out[key] = value;
	}
	return out as unknown as GroupRecord;
}

/** The local groups with the runtime's domain keys taken, `collapsed` kept, and groups only this window holds kept. */
function mergeGroups(local: Group[], incoming: GroupRecord[], previous: GroupRecord[]): Group[] {
	const localById = new Map(local.map((group) => [group.id, group]));
	const previousIds = new Set(previous.map((group) => group.id));
	const incomingIds = new Set(incoming.map((group) => group.id));
	const merged = incoming.map((record) => {
		const held = localById.get(record.id);
		const domain = domainOfGroup(record as unknown as Record<string, unknown>);
		const next = {
			...(held ? nonDomain(held as unknown as Record<string, unknown>) : {}),
			...domain,
			collapsed: held?.collapsed ?? record.collapsed ?? false,
		} as unknown as Group;
		return held && valuesEqual(held, next) ? held : next;
	});
	// A group this window made and has not folded yet stays; one the runtime knew and no longer holds goes.
	for (const group of local) {
		if (!incomingIds.has(group.id) && !previousIds.has(group.id)) merged.push(group);
	}
	return merged;
}

function nonDomain(record: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (!GROUP_DOMAIN_KEYS.has(key)) out[key] = value;
	}
	return out;
}

function applyGroups(
	message: LibraryRuntimeEventMessage & { event: { type: 'groups.changed' } }
): void {
	if (message.groupsRev !== undefined && message.groupsRev <= groupsRev) return;
	const previous = authoritativeGroups;
	authoritativeGroups = message.event.groups.map((group) =>
		domainOfGroup(group as unknown as Record<string, unknown>)
	);
	if (message.groupsRev !== undefined) groupsRev = message.groupsRev;
	const { groups, setGroups } = useSessionStore.getState();
	const next = mergeGroups(groups, message.event.groups, previous);
	if (next.length === groups.length && next.every((group, index) => group === groups[index]))
		return;
	setGroups(next);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

async function applyAgent(
	record: AgentRecord,
	rev: number | undefined,
	options: { force?: boolean; snap?: boolean }
): Promise<void> {
	const id = record.id;
	if (gone.has(id)) return;
	const known = agents.get(id);
	// A snap is the record of a command that FAILED: it raised no event and bumped no revision, so the
	// revision it carries equals the one this window holds, and the stale test would drop it.
	if (!options.snap && rev !== undefined && known && rev <= known.rev) return;
	if (!options.force && (inFlight.get(id) ?? 0) > 0) {
		const pending = held.get(id);
		if (!pending || (rev ?? 0) >= (pending.rev ?? 0)) {
			held.set(id, {
				event: { type: 'agent.updated', agent: record },
				...(rev !== undefined ? { rev } : {}),
			});
		}
		return;
	}
	agents.set(id, { rev: rev ?? known?.rev ?? 0, baseline: baselineOf(record) });

	const { sessions, setSessions } = useSessionStore.getState();
	const local = sessions.find((session) => session.id === id);
	if (!local) {
		const rich = pendingLocal.get(id);
		if (rich) {
			const arrived = applyRuntimeAgentRecord(rich, record);
			setSessions((prev) =>
				prev.some((session) => session.id === id) ? prev : [...prev, arrived]
			);
			return;
		}
		if (!host) return;
		const restored = await host.restoreSession(sessionFromRecord(record));
		const withLogs = await withStoredTranscripts(restored);
		useSessionStore
			.getState()
			.setSessions((prev) =>
				prev.some((session) => session.id === id) ? prev : [...prev, withLogs]
			);
		void host.reattachLiveTurns?.();
		return;
	}
	const previous = known?.baseline;
	const next = applyRuntimeAgentRecord(local, record, previous);
	if (next === local) return;
	setSessions((prev) =>
		prev.map((session) =>
			session.id === id ? applyRuntimeAgentRecord(session, record, previous) : session
		)
	);
}

/** An agent that arrives from the runtime has no transcripts in the projected event: read each tab's once. */
async function withStoredTranscripts(session: Session): Promise<Session> {
	const read = window.maestro?.sessions?.getDeferredContent;
	if (!read || !session.aiTabs?.length) return session;
	const tabs = await Promise.all(
		session.aiTabs.map(async (tab) => {
			try {
				const content = await read(session.id, tab.id, false);
				return content?.logs?.length ? { ...tab, logs: content.logs } : tab;
			} catch {
				// A tab with no stored transcript yet (a fresh one) has nothing to read.
				return tab;
			}
		})
	);
	return { ...session, aiTabs: tabs } as Session;
}

function applyRemoved(agentId: string): void {
	agents.delete(agentId);
	held.delete(agentId);
	gone.add(agentId);
	const state = useSessionStore.getState();
	if (!state.sessions.some((session) => session.id === agentId)) return;
	const survivors = state.sessions.filter((session) => session.id !== agentId);
	state.setSessions(survivors);
	if (state.activeSessionId === agentId) state.setActiveSessionId(survivors[0]?.id ?? '');
}

function applyFenced(reason: string): void {
	if (fenced) return;
	fenced = true;
	notifyToast({
		type: 'error',
		title: 'Maestro lost the data directory',
		message: `${reason} Changes are not saved. Quit Maestro.`,
		dismissible: true,
	});
}

/**
 * Apply one event the runtime emitted. Events apply in arrival order, and one that fails is logged and
 * does not stop the ones behind it. Resolves when it has been applied.
 */
export function applyRuntimeMessage(
	message: LibraryRuntimeEventMessage,
	options: { force?: boolean; snap?: boolean } = {}
): Promise<void> {
	if (!loaded) {
		early.push({ message, options });
		return Promise.resolve();
	}
	const run = async (): Promise<void> => {
		const { event } = message;
		switch (event.type) {
			case 'agent.added':
			case 'agent.updated':
				await applyAgent(event.agent, message.rev, options);
				return;
			case 'agent.removed':
				applyRemoved(event.agentId);
				return;
			case 'groups.changed':
				applyGroups(message as LibraryRuntimeEventMessage & { event: { type: 'groups.changed' } });
				return;
			case 'host.lost':
				applyFenced(event.reason);
				return;
			default:
				// Tab events are always followed by an `agent.updated` that carries the whole agent.
				return;
		}
	};
	queue = queue.then(run).catch((error) => {
		logger.warn(
			`Applying a runtime event failed: ${error instanceof Error ? error.message : String(error)}`,
			LOG_CONTEXT
		);
	});
	return queue;
}

/** Subscribe this window to the runtime's events. Returns the unsubscribe function. */
export function startRuntimeEventStream(): () => void {
	const api = window.maestro?.libraryRuntime;
	if (!api?.onEvent) return () => undefined;
	return api.onEvent((message) => {
		void applyRuntimeMessage(message);
	});
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface RuntimeCommandOptions {
	/** The agents the command is about: events about them are held until the command answers. */
	agentIds?: readonly string[];
	/** An agent the command creates, as this window will hold it. See `pendingLocal`. */
	creating?: Session;
}

/**
 * Send one repository command and apply what it caused. The answer's own copy of the events is applied
 * at once (it is the authoritative record, and the broadcast copy at the same revision is then skipped),
 * and whatever was held meanwhile is released afterwards.
 */
export async function sendRuntimeCommand(
	command: LibraryRuntimeCommand,
	options: RuntimeCommandOptions = {}
): Promise<LibraryRuntimeCommandAnswer> {
	const ids = options.agentIds ?? [];
	const api = window.maestro?.libraryRuntime;
	if (!api?.command) {
		throw new Error('The library runtime is not available.');
	}
	if (fenced) {
		return {
			result: {
				ok: false,
				error: {
					code: 'host-lost',
					message: 'Another Maestro took over this data directory. Quit Maestro.',
					method: command.method,
				},
			} as LibraryRuntimeCommandAnswer['result'],
			changes: [],
		};
	}
	for (const id of ids) inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
	if (options.creating) pendingLocal.set(options.creating.id, options.creating);
	try {
		const answer = await api.command({ commandId: generateId(), command });
		for (const change of answer.changes) await applyRuntimeMessage(change, { force: true });
		if (!answer.result.ok && answer.authoritative) {
			// A refusal raises no event. An operation that applied its change first (a tab, a rename)
			// is put back to what the runtime holds.
			await applyRuntimeMessage(
				{
					event: { type: 'agent.updated', agent: answer.authoritative.agent },
					rev: answer.authoritative.rev,
				},
				{ force: true, snap: true }
			);
		}
		return answer;
	} finally {
		if (options.creating) pendingLocal.delete(options.creating.id);
		const release: string[] = [];
		for (const id of ids) {
			const left = (inFlight.get(id) ?? 1) - 1;
			if (left <= 0) {
				inFlight.delete(id);
				release.push(id);
			} else {
				inFlight.set(id, left);
			}
		}
		for (const id of release) {
			const pending = held.get(id);
			held.delete(id);
			if (pending) void applyRuntimeMessage(pending);
		}
	}
}

// ---------------------------------------------------------------------------
// Translating this window's strip positions into the runtime's
// ---------------------------------------------------------------------------

const refKey = (ref: TabRefRecord): string => `${ref.type}:${ref.id}`;

/**
 * The strip as the runtime last told this window about it. A window holds refs the runtime has not heard of
 * yet (a file tab opened since the last fold), so an index counted over the window's whole strip names a
 * different place in the runtime's shorter one. These two functions count over the refs both sides hold.
 */
function runtimeOrderKeys(agentId: string): Set<string> | undefined {
	const mirror = agents.get(agentId);
	return mirror ? new Set(mirror.baseline.order.map(refKey)) : undefined;
}

/**
 * Where `ref` sits among the refs of `order` that the runtime also holds, or undefined when the runtime
 * does not hold `ref` (nothing it could move: the window's fold places that ref relative to its neighbour).
 * Pass the window's order AFTER the move.
 */
export function runtimeTabIndexFor(
	agentId: string,
	order: readonly TabRefRecord[],
	ref: TabRefRecord
): number | undefined {
	const known = runtimeOrderKeys(agentId);
	if (!known || !known.has(refKey(ref))) return undefined;
	return order
		.filter((entry) => known.has(refKey(entry)))
		.findIndex((entry) => refKey(entry) === refKey(ref));
}

/**
 * What a new tab at `index` of `order` sits after, in the runtime's terms: the nearest earlier ref the
 * runtime holds; `null` when the tab leads the strip; `undefined` when refs precede it but the runtime
 * holds none of them (it then places the tab by the placement setting).
 */
export function runtimeAnchorFor(
	agentId: string,
	order: readonly TabRefRecord[],
	index: number
): TabRefRecord | null | undefined {
	if (index <= 0) return null;
	const known = runtimeOrderKeys(agentId);
	if (!known) return undefined;
	for (let at = index - 1; at >= 0; at -= 1) {
		if (known.has(refKey(order[at]))) return order[at];
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

export interface BuildRuntimeFoldInput {
	/** Sessions to fold, already prepared for persistence (`prepareSessionForPersistence`). */
	sessions: readonly Session[];
	/** Ids this window removed without a command. */
	removedIds?: readonly string[];
	/** Whether this window folds the agent's stream (4.7). Default: all of them. */
	ownsAgent?: (agentId: string) => boolean;
	activeSessionId?: string;
}

/**
 * The groups part of a fold: `collapsed` for every group, the group list when it differs from what the
 * runtime holds (a site not migrated to a command), and the groups the runtime holds that this window
 * no longer does.
 */
export function buildGroupsFold(groups: readonly Group[]): DesktopFoldGroups {
	const collapsed: Record<string, boolean> = {};
	for (const group of groups) collapsed[group.id] = group.collapsed === true;
	const part: DesktopFoldGroups = { baseRev: groupsRev, collapsed };

	const local = groups.map((group) => domainOfGroup(group as unknown as Record<string, unknown>));
	const known = new Set(authoritativeGroups.map((group) => group.id));
	const differs =
		local.length !== authoritativeGroups.length ||
		local.some((group, index) => !valuesEqual(group, authoritativeGroups[index]));
	if (differs) {
		part.domain = groups.map((group) => ({ ...group })) as unknown as GroupRecord[];
		const present = new Set(local.map((group) => group.id));
		const removed = [...known].filter((id) => !present.has(id));
		if (removed.length > 0) part.removeGroups = removed;
	}
	return part;
}

/** A fold from sessions prepared for persistence. An agent the runtime never told this window about is adopted. */
export function buildRuntimeFold(input: BuildRuntimeFoldInput): DesktopFold {
	const fold: DesktopFold = { agents: [] };
	for (const session of input.sessions) {
		if (gone.has(session.id)) continue;
		const mirror = agents.get(session.id);
		const record = session as unknown as Record<string, unknown>;
		if (!mirror) {
			(fold.adoptAgents ??= []).push(record);
			continue;
		}
		fold.agents.push(
			buildFoldAgent(record, mirror.baseline, {
				baseRev: mirror.rev,
				ownsStream: input.ownsAgent ? input.ownsAgent(session.id) : true,
			})
		);
	}
	const removed = (input.removedIds ?? []).filter((id) => agents.has(id));
	if (removed.length > 0) fold.removeAgents = removed;
	if (input.activeSessionId !== undefined) fold.activeSessionId = input.activeSessionId;
	return fold;
}

/** Send a fold. Throws when the runtime refused it or could not write it, so the caller keeps the batch pending. */
export async function sendRuntimeFold(fold: DesktopFold): Promise<void> {
	if (isRuntimeFenced()) throw new Error('The library runtime lost the data directory.');
	const api = window.maestro?.libraryRuntime;
	if (!api?.fold) throw new Error('The library runtime is not available.');
	const answer = await api.fold(fold);
	if (!answer.ok) throw new Error('The library runtime did not accept the fold.');
	for (const drift of answer.drift) {
		logger.debug(`Fold drift: ${drift.kind}`, LOG_CONTEXT, drift);
	}
	// A removal the fold carried is now true in the runtime: forget it here, and remember it so a late
	// event for the id cannot bring the agent back.
	for (const id of fold.removeAgents ?? []) {
		agents.delete(id);
		gone.add(id);
	}
}

/** Persist the groups alone (they change infrequently and have no debounce of their own). */
export async function persistGroupsToRuntime(groups: readonly Group[]): Promise<void> {
	if (!isLibraryRuntimeHosting()) return;
	await sendRuntimeFold({ agents: [], groups: buildGroupsFold(groups) });
}
