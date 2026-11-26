/**
 * A hosted agent IS its Left Bar record. The record keeps everything an SSH agent has (cwd, SSH
 * remote, file tabs, browser tabs, terminal), so it renders through the same Main Window and Right
 * Bar as any agent. The only thing that differs is where its AI turns run: on the Federation host.
 *
 * `projectHostedSession()` folds what the host reports into that record: its AI tabs (name, star,
 * provider session, busy state), each tab's transcript (the persisted tail the mirror read, plus
 * the live entries of a turn still running), and the messages waiting in the host's queue. The
 * record then draws exactly like a local agent's, and the local copy stays current, so a Move Back
 * from Host has every conversation.
 *
 * Rules, so nothing is lost and nothing runs twice:
 * - Tabs match by id (a lift keeps tab ids). A host tab this record lacks is appended. A local tab
 *   the host does not have stays (a conversation kept from before the move), idle.
 * - A transcript is merged, never replaced: local entries the host's read window does not hold
 *   stay, in time order among the host's. Live entries carry `hostLive` and are rebuilt on every
 *   sync.
 * - Host queue items carry `hostQueued`: drawn as queued cards, never run by a local drain.
 *
 * Pure. Returns the same `session` reference when nothing changed.
 */

import { canonicalJson } from '../../shared/canonicalJson';
import type { LiveTurn } from '../../shared/maestro-lib/client/live-turn';
import { liveTurnKey } from '../../shared/maestro-lib/client/live-turn';
import type { QueuedTurn } from '../../shared/maestro-lib/client/types';
import type { AgentRecord, AITabRecord } from '../../shared/maestro-lib/store/records';
import type { LogEntryRecord } from '../../shared/maestro-lib/store/transcript';
import type { AgentError } from '../../shared/types';
import type { AITab, LogEntry, QueuedItem, Session, UnifiedTabRef } from '../types';
import { mirrorLogEntry, mirrorQueuedItem, mirrorTab } from './peerMirrorView';

/** One tab's transcript as the mirror holds it (`MirrorTranscriptSlot`, the fields read here). */
export interface HostedTranscript {
	entries: LogEntryRecord[];
	loaded: boolean;
	carryover?: LogEntryRecord[];
}

export interface HostedProjectionInput {
	/** The host's record of the agent. */
	agent: AgentRecord;
	/** By `liveTurnKey(agentId, tabId)`. */
	transcripts?: Readonly<Record<string, HostedTranscript>>;
	/** By `liveTurnKey(agentId, tabId)`. */
	liveTurns?: Readonly<Record<string, LiveTurn>>;
	/** What waits in the host's queue for this agent. */
	queue?: readonly QueuedTurn[];
}

const persistedViews = new WeakMap<readonly LogEntryRecord[], LogEntry[]>();

function persistedView(entries: readonly LogEntryRecord[]): LogEntry[] {
	let view = persistedViews.get(entries);
	if (!view) {
		view = entries.map(mirrorLogEntry);
		persistedViews.set(entries, view);
	}
	return view;
}

function sameIds(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i].id !== b[i].id) return false;
	return true;
}

/**
 * Two transcripts as one, in time order; each keeps its own order and a tie goes to `local`. A
 * local entry older than the host's read window lands ahead of it, and one written here during
 * the conversation (a wizard's flattened turns, a system note) lands where it happened, as it
 * does in a local agent's tab.
 */
function byTime(local: readonly LogEntry[], host: readonly LogEntry[]): LogEntry[] {
	if (local.length === 0) return [...host];
	if (host.length === 0) return [...local];
	const out: LogEntry[] = [];
	let i = 0;
	let j = 0;
	while (i < local.length && j < host.length) {
		if (local[i].timestamp <= host[j].timestamp) out.push(local[i++]);
		else out.push(host[j++]);
	}
	while (i < local.length) out.push(local[i++]);
	while (j < host.length) out.push(host[j++]);
	return out;
}

/**
 * A tab's transcript with the host's folded in. `persisted` undefined (never read) keeps the local
 * entries; the live tail still shows. Returns `local` itself when nothing changed.
 */
export function mergeHostedLogs(
	local: LogEntry[],
	persisted: readonly LogEntryRecord[] | undefined,
	tail: readonly LogEntryRecord[] | undefined
): LogEntry[] {
	const kept = local.filter((entry) => !entry.hostLive);
	const hostEntries = persisted ? persistedView(persisted) : [];
	const hostIds = new Set(hostEntries.map((entry) => entry.id));
	const older = persisted ? kept.filter((entry) => !hostIds.has(entry.id)) : kept;
	const seen = new Set([...older.map((entry) => entry.id), ...hostIds]);
	const live: LogEntry[] = [];
	for (const record of tail ?? []) {
		if (seen.has(record.id)) continue;
		seen.add(record.id);
		live.push({ ...mirrorLogEntry(record), hostLive: true });
	}
	const next = [...byTime(older, hostEntries), ...live];
	if (sameIds(next, local)) {
		// Same entries in the same order: keep the old array unless a live entry's text moved on.
		const liveChanged = live.some((entry, i) => {
			const prior = local[older.length + hostEntries.length + i];
			return prior?.text !== entry.text || prior?.metadata !== entry.metadata;
		});
		if (!liveChanged) return local;
	}
	return next;
}

/**
 * Whether two queues draw the same cards. Every field `mirrorQueuedItem()` writes is compared, so
 * an edit on the host that changes only the images, the model or effort, or a command's arguments
 * reaches the card and its editor instead of being dropped as "unchanged".
 */
function sameQueue(a: readonly QueuedItem[], b: readonly QueuedItem[]): boolean {
	return (
		a.length === b.length &&
		a.every((item, i) => {
			const other = b[i];
			return (
				item.id === other.id &&
				item.paused === other.paused &&
				item.type === other.type &&
				item.text === other.text &&
				item.command === other.command &&
				item.commandArgs === other.commandArgs &&
				item.tabId === other.tabId &&
				sameImages(item.images, other.images) &&
				canonicalJson(item.turnSettings ?? null) === canonicalJson(other.turnSettings ?? null)
			);
		})
	);
}

function sameImages(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	const left = a ?? [];
	const right = b ?? [];
	return left.length === right.length && left.every((image, i) => image === right[i]);
}

/**
 * The tab's error banner, raised and cleared as a local tab's is: an error the host's running turn
 * reports while this tab watches (a live entry not drawn here before) raises it, and the start of
 * the next turn clears it, as a local send does. A dismissed banner stays dismissed, because an
 * error already drawn never raises it again, and an old error in a transcript that loads later is
 * not live, so it raises nothing.
 */
function hostedTabError(
	local: AITab,
	busy: boolean,
	logs: readonly LogEntry[]
): AgentError | undefined {
	let error = busy && local.state !== 'busy' ? undefined : local.agentError;
	if (logs === local.logs) return error;
	const drawn = new Set((local.logs ?? []).map((entry) => entry.id));
	for (const entry of logs) {
		if (entry.hostLive && entry.source === 'error' && entry.agentError && !drawn.has(entry.id)) {
			error = entry.agentError;
		}
	}
	return error;
}

function projectTab(
	local: AITab,
	host: AITabRecord,
	logs: LogEntry[],
	liveTurn: LiveTurn | undefined
): AITab {
	const busy = host.state === 'busy';
	const thinkingStartTime = busy
		? (host.thinkingStartTime ?? liveTurn?.startedAt ?? local.thinkingStartTime)
		: undefined;
	const name = host.name ?? null;
	const agentSessionId = host.agentSessionId ?? local.agentSessionId ?? null;
	const starred = host.starred === true;
	const state = busy ? 'busy' : 'idle';
	const agentError = hostedTabError(local, busy, logs);
	if (
		local.name === name &&
		local.agentSessionId === agentSessionId &&
		local.starred === starred &&
		local.state === state &&
		local.thinkingStartTime === thinkingStartTime &&
		local.logs === logs &&
		local.agentError === agentError
	) {
		return local;
	}
	return { ...local, name, agentSessionId, starred, state, thinkingStartTime, logs, agentError };
}

/**
 * The agent as its host runs it. The record keeps its SSH remote for the files, terminal, and git
 * that run from this machine, but the host spawns each AI turn on its own machine: no SSH hop. A
 * check about the turn itself (can it be steered) reads this view, so a hosted agent answers as a
 * local agent on the host would, never as an SSH agent.
 */
export function hostRunView<T extends Pick<Session, 'sshRemoteId' | 'sessionSshRemoteConfig'>>(
	session: T
): T {
	if (!session.sshRemoteId && !session.sessionSshRemoteConfig) return session;
	return { ...session, sshRemoteId: undefined, sessionSshRemoteConfig: undefined };
}

/** `session` with the host's tabs, transcripts, busy state, and queue folded in. */
export function projectHostedSession(session: Session, input: HostedProjectionInput): Session {
	const { agent } = input;
	const hostTabs = (agent.aiTabs ?? []).filter((tab) => !tab.hidden);
	const hostById = new Map(hostTabs.map((tab) => [tab.id, tab]));
	const logsFor = (tabId: string, local: LogEntry[]): LogEntry[] => {
		const key = liveTurnKey(agent.id, tabId);
		const slot = input.transcripts?.[key];
		const live = input.liveTurns?.[key];
		return mergeHostedLogs(
			local,
			slot?.loaded ? slot.entries : undefined,
			live?.entries ?? slot?.carryover
		);
	};

	let changed = false;
	const localIds = new Set(session.aiTabs.map((tab) => tab.id));
	// An added agent starts with one blank local tab; once the host has tabs it is only noise.
	const isBlankLocalOnly = (tab: AITab) =>
		!hostById.has(tab.id) &&
		!tab.agentSessionId &&
		(tab.logs?.length ?? 0) === 0 &&
		!tab.inputValue &&
		(tab.stagedImages?.length ?? 0) === 0;
	const dropped = new Set(
		hostTabs.length > 0 ? session.aiTabs.filter(isBlankLocalOnly).map((tab) => tab.id) : []
	);

	const aiTabs: AITab[] = [];
	for (const local of session.aiTabs) {
		if (dropped.has(local.id)) {
			changed = true;
			continue;
		}
		const host = hostById.get(local.id);
		if (!host) {
			// The host does not have it: a conversation kept from before the move. Nothing runs it.
			if (local.state === 'busy' && !local.hidden) {
				aiTabs.push({ ...local, state: 'idle', thinkingStartTime: undefined });
				changed = true;
			} else aiTabs.push(local);
			continue;
		}
		const next = projectTab(
			local,
			host,
			logsFor(local.id, local.logs ?? []),
			input.liveTurns?.[liveTurnKey(agent.id, local.id)]
		);
		if (next !== local) changed = true;
		aiTabs.push(next);
	}
	const added: AITab[] = [];
	for (const host of hostTabs) {
		if (localIds.has(host.id)) continue;
		const tab = mirrorTab(host);
		tab.logs = logsFor(host.id, []);
		added.push(tab);
	}
	if (added.length > 0) {
		aiTabs.push(...added);
		changed = true;
	}

	let unifiedTabOrder = session.unifiedTabOrder;
	if (added.length > 0 || dropped.size > 0) {
		unifiedTabOrder = [
			...(session.unifiedTabOrder ?? []).filter(
				(ref) => !(ref.type === 'ai' && dropped.has(ref.id))
			),
			...added.map((tab): UnifiedTabRef => ({ type: 'ai', id: tab.id })),
		];
	}
	let activeTabId = session.activeTabId;
	if (dropped.has(activeTabId) || !aiTabs.some((tab) => tab.id === activeTabId)) {
		activeTabId =
			(agent.activeTabId && aiTabs.some((tab) => tab.id === agent.activeTabId)
				? agent.activeTabId
				: aiTabs[0]?.id) ?? activeTabId;
		if (activeTabId !== session.activeTabId) changed = true;
	}

	const hostQueue = (input.queue ?? []).map(
		(item): QueuedItem => ({ ...mirrorQueuedItem(item), hostQueued: true })
	);
	const localQueue = session.executionQueue ?? [];
	const ownQueue = localQueue.filter((item) => !item.hostQueued);
	const executionQueue = [...ownQueue, ...hostQueue];
	const queueChanged = !sameQueue(executionQueue, localQueue);
	if (queueChanged) changed = true;

	// A terminal command owns the agent's busy state while it runs; it is local, not the host's.
	const terminalBusy = session.state === 'busy' && session.busySource === 'terminal';
	const anyBusy = aiTabs.some((tab) => tab.state === 'busy');

	// The agent's error, as a local error sets it: the tab that last raised a banner names it (the
	// error modal reads it there), and it clears with that tab's banner. The queue pause a local
	// error adds is the host's to keep: it runs the queue.
	const priorById = new Map(session.aiTabs.map((tab) => [tab.id, tab]));
	const raised = aiTabs.find(
		(tab) => tab.agentError && tab.agentError !== priorById.get(tab.id)?.agentError
	);
	const errorTab =
		raised ??
		(session.agentErrorTabId
			? aiTabs.find((tab) => tab.id === session.agentErrorTabId)
			: undefined);
	// An error no tab owns (one raised here, not by the host) stays until it is cleared here.
	const agentError = raised || session.agentErrorTabId ? errorTab?.agentError : session.agentError;
	const agentErrorTabId = errorTab?.agentError ? errorTab.id : undefined;
	if (agentError !== session.agentError || agentErrorTabId !== session.agentErrorTabId) {
		changed = true;
	}

	const state = terminalBusy ? session.state : anyBusy ? 'busy' : agentError ? 'error' : 'idle';
	const busySource = terminalBusy ? session.busySource : anyBusy ? 'ai' : undefined;
	if (state !== session.state || busySource !== session.busySource) changed = true;

	if (!changed) return session;
	return {
		...session,
		aiTabs,
		activeTabId,
		...(unifiedTabOrder ? { unifiedTabOrder } : {}),
		executionQueue: queueChanged ? executionQueue : localQueue,
		state,
		busySource,
		agentError,
		agentErrorTabId,
	};
}

/**
 * `session` with everything the host sync put in it that only the host can settle taken out: its
 * queue cards (`hostQueued`), the live entries of a turn (`hostLive`), and the busy state of a host
 * turn. Used once when hosted agents are switched off, so the record works as its SSH agent with no
 * card or busy tab nobody here can finish. The host's conversations stay. Same reference back when
 * there is nothing to take out.
 */
export function releaseHostedSession(session: Session): Session {
	let changed = false;
	const aiTabs = session.aiTabs.map((tab) => {
		const logs = tab.logs?.some((entry) => entry.hostLive)
			? tab.logs.filter((entry) => !entry.hostLive)
			: tab.logs;
		if (logs === tab.logs && tab.state !== 'busy') return tab;
		changed = true;
		return { ...tab, logs, state: 'idle' as const, thinkingStartTime: undefined };
	});
	const queue = session.executionQueue ?? [];
	const executionQueue = queue.some((item) => item.hostQueued)
		? queue.filter((item) => !item.hostQueued)
		: queue;
	if (executionQueue !== queue) changed = true;
	const aiBusy = session.state === 'busy' && session.busySource !== 'terminal';
	if (aiBusy) changed = true;
	if (!changed) return session;
	return {
		...session,
		aiTabs,
		executionQueue,
		...(aiBusy ? { state: 'idle' as const, busySource: undefined } : {}),
	};
}
