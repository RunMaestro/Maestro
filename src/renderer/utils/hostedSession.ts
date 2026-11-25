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
 * - A transcript is merged, never replaced: local entries outside the host's read window stay,
 *   ahead of the host's. Live entries carry `hostLive` and are rebuilt on every sync.
 * - Host queue items carry `hostQueued`: drawn as queued cards, never run by a local drain.
 *
 * Pure. Returns the same `session` reference when nothing changed.
 */

import type { LiveTurn } from '../../shared/maestro-lib/client/live-turn';
import { liveTurnKey } from '../../shared/maestro-lib/client/live-turn';
import type { QueuedTurn } from '../../shared/maestro-lib/client/types';
import type { AgentRecord, AITabRecord } from '../../shared/maestro-lib/store/records';
import type { LogEntryRecord } from '../../shared/maestro-lib/store/transcript';
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
	const next = [...older, ...hostEntries, ...live];
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

function sameQueue(a: readonly QueuedItem[], b: readonly QueuedItem[]): boolean {
	return (
		a.length === b.length &&
		a.every(
			(item, i) =>
				item.id === b[i].id &&
				item.paused === b[i].paused &&
				item.text === b[i].text &&
				item.tabId === b[i].tabId
		)
	);
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
	if (
		local.name === name &&
		local.agentSessionId === agentSessionId &&
		local.starred === starred &&
		local.state === state &&
		local.thinkingStartTime === thinkingStartTime &&
		local.logs === logs
	) {
		return local;
	}
	return { ...local, name, agentSessionId, starred, state, thinkingStartTime, logs };
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
	const state = terminalBusy ? session.state : anyBusy ? 'busy' : 'idle';
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
