// What the desktop knows about a Federation peer it mirrors, and the rules that change it.
//
// A mirrored peer lives in memory only: the main-process `PeerMirrorService` holds one of these
// per peer and pushes the `MirrorEvent`s this reducer returns to every window. Nothing here, or in
// anything that holds it, writes a local store: a peer's agents never become local agents, and a
// disconnect or a removed peer can never change local data.
//
// Agents are keyed `peerId:agentId` (`mirrorKey()`), the same string maestro-cli addresses.
//
// Pure: no I/O, no clock of its own. M5 (the desktop as a runtime subscriber) can reuse the
// `snapshot` and `agent.*` rules as they stand.

import type { AutoRunBroadcastState } from '../../autoRunBroadcast';
import type { AutoRunActivity } from '../autorun/run-tracker';
import { peerAgentRef } from '../agents/lift-pointer';
import type { AgentRecord, GroupRecord } from '../store/records';
import { foldLiveTurn, liveTurnKey, type LiveTurn, type LiveTurnContext } from './live-turn';
import type { PeerConnectErrorCode } from './peer-connection';
import type { HostKind, MaestroEvent, QueuedTurn, QueueExit, TurnEvent } from './types';

/** How the desktop's connection to a peer stands. The failure codes are `PeerConnectErrorCode`. */
export type PeerMirrorConnection =
	| 'connecting'
	| 'connected'
	| 'reconnecting'
	| 'lost'
	| PeerConnectErrorCode;

/** One peer the desktop mirrors. Replaced, never mutated. */
export interface MirroredPeer {
	/** `peerIdFor()`: the remote's name, or its id when another remote shares the name. */
	peerId: string;
	remoteId: string;
	/** The remote's name, for the Left Bar header. */
	name: string;
	connection: PeerMirrorConnection;
	/** The message the CLI would print for a failure, with its fix line. */
	error?: string;
	/** In host order, without transcripts. Kept through a disconnect, so they can be shown dimmed. */
	agents: AgentRecord[];
	groups: GroupRecord[];
	/** By `liveTurnKey(agentId, tabId)`. */
	liveTurns: Record<string, LiveTurn>;
	/**
	 * The messages waiting in the host's execution queue, by agent id, in order. An agent with
	 * nothing waiting has no entry. Kept through a disconnect, like the agents.
	 */
	queues: Record<string, QueuedTurn[]>;
	/**
	 * How the host queue items that last left the queue left it (started or removed), by agent id,
	 * oldest first, at most `MAX_MIRRORED_QUEUE_EXITS`. An entry (even empty) means the host names
	 * every exit (`queue.changed` `namesExits`), so an item gone without a name is still on its way.
	 * An agent of a host that does not name them (an older headless host, a desktop host) has none.
	 */
	queueExits?: Record<string, QueueExit[]>;
	/**
	 * How many times an agent's host queue was read whole (after an attach, a resync, or a wake)
	 * since its host began naming exits, by agent id. A read names no exit, so a start named while
	 * this mirror was not attached is missing from `queueExits`: an item last seen waiting before
	 * the latest read is judged by the tab's state, not by a name that will not come.
	 */
	queueReads?: Record<string, number>;
	/**
	 * Each agent's running Auto Run, as the host's last `autorun_state` frame drew it, by agent id.
	 * An agent with no run has no entry. A run's figures stay through a disconnect, like the queue:
	 * the run goes on on the host, and the host replays every live run when the connection resumes.
	 */
	autoRuns: Record<string, AutoRunBroadcastState>;
	/** Tabs whose transcript must be read again on next open, by `liveTurnKey(agentId, tabId)`. */
	staleTabs: Record<string, true>;
	/** When the agent list was last replaced whole, epoch ms. */
	lastSyncAt?: number;
	/**
	 * The host listed its agents whole (a snapshot, or a list read) since the link was last down.
	 * Until then the agents held are the host's report from before (kept to draw them dimmed): a
	 * host that restarted is connected before its first snapshot lands, and a tab it last reported
	 * busy, or an agent list still empty, says nothing about the host now (`hostReportIsCurrent()`).
	 */
	reportedSinceLink?: boolean;
	/**
	 * The kind of host this peer last attached to (`host.connected`): what a transcript's turn with
	 * no end stamp means (`turnFateAfter()`). Kept through a disconnect.
	 */
	hostKind?: HostKind;
}

/**
 * Whether `peer`'s agents are the host's report as it is now: connected, and listed whole since the
 * link was last down. A decision that trusts a tab's state or the agent list waits for this.
 */
export function hostReportIsCurrent(
	peer: Pick<MirroredPeer, 'connection' | 'reportedSinceLink'>
): boolean {
	return peer.connection === 'connected' && peer.reportedSinceLink === true;
}

/** A peer as `maestro-cli federation peers` and the Left Bar header show it. */
export interface MirrorPeerSummary {
	peerId: string;
	remoteId: string;
	name: string;
	connection: PeerMirrorConnection;
	error?: string;
	agentCount: number;
	lastSyncAt?: number;
	/** `MirroredPeer.reportedSinceLink`, carried so every window judges the report the same. */
	reportedSinceLink?: boolean;
	/** `MirroredPeer.hostKind`. */
	hostKind?: HostKind;
}

/** A change a window applies to its own copy of a peer. */
export type MirrorEvent =
	/** The connection changed (or the summary did). */
	| { type: 'peer.state'; peer: MirrorPeerSummary }
	/** The whole agent list, after a snapshot or a reload. */
	| { type: 'peer.agents'; agents: AgentRecord[]; groups: GroupRecord[]; lastSyncAt?: number }
	/** Added or changed. */
	| { type: 'agent.updated'; agent: AgentRecord }
	| { type: 'agent.removed'; agentId: string }
	/** A turn event as received. Fold it with `foldLiveTurn()`. */
	| { type: 'turn'; agentId: string; tabId: string; event: TurnEvent }
	/**
	 * What waits in the agent's host queue now, in order. Replaces what was held. `exit` and
	 * `namesExits` as on `queue.changed`.
	 */
	| {
			type: 'agent.queue';
			agentId: string;
			items: QueuedTurn[];
			exit?: QueueExit;
			namesExits?: true;
	  }
	/** The agent's Auto Run as the host drew it now; `null` when it has none. Replaces what was held. */
	| { type: 'agent.autorun'; agentId: string; state: AutoRunBroadcastState | null }
	/**
	 * A piece of the agent's Auto Run reasoning, or one of its tool calls, as it happens. Nothing is
	 * held: a window feeds it to its Thought Stream (`feedHostedAutoRunActivity()`).
	 */
	| { type: 'agent.autorunActivity'; agentId: string; activity: AutoRunActivity }
	/** Read this tab's transcript again on next open (now, when it is open). */
	| { type: 'tab.stale'; agentId: string; tabId: string }
	/** The host wrote the agent's History (`history.changed`): read it again. */
	| { type: 'agent.history'; agentId: string }
	/** Every tab is stale: the connection could not resume, or the desktop woke up. */
	| { type: 'peer.stale' }
	/** The peer is no longer mirrored: its remote was deleted or opted out. */
	| { type: 'peer.removed' };

/** What a push to the renderer carries. */
export interface MirrorPush {
	peerId: string;
	event: MirrorEvent;
}

/** The result of a rule: the next peer, and what to push. */
export interface MirrorStep {
	peer: MirroredPeer;
	push: MirrorEvent[];
}

export interface MirrorContext extends LiveTurnContext {
	now(): number;
}

/** How a mirrored agent is keyed and addressed: `peerId:agentId`. */
export function mirrorKey(peerId: string, agentId: string): string {
	return peerAgentRef(peerId, agentId);
}

/** A peer the desktop has not connected to yet. */
export function createMirroredPeer(input: {
	peerId: string;
	remoteId: string;
	name: string;
}): MirroredPeer {
	return {
		...input,
		connection: 'connecting',
		agents: [],
		groups: [],
		liveTurns: {},
		queues: {},
		autoRuns: {},
		staleTabs: {},
	};
}

export function summarizePeer(peer: MirroredPeer): MirrorPeerSummary {
	return {
		peerId: peer.peerId,
		remoteId: peer.remoteId,
		name: peer.name,
		connection: peer.connection,
		...(peer.error ? { error: peer.error } : {}),
		agentCount: peer.agents.length,
		...(peer.lastSyncAt !== undefined ? { lastSyncAt: peer.lastSyncAt } : {}),
		...(peer.reportedSinceLink ? { reportedSinceLink: true } : {}),
		...(peer.hostKind ? { hostKind: peer.hostKind } : {}),
	};
}

/** What `findMirrorPeer()` answers: the one peer `ref` names, or why there is none. */
export type MirrorPeerMatch =
	| { ok: true; peer: MirrorPeerSummary }
	| { ok: false; code: 'unknown-peer' | 'ambiguous-peer'; error: string };

/**
 * The mirrored peer `ref` names, the way the other remote verbs resolve one: the peer id exactly,
 * then a case-insensitive peer id or remote name, then the remote id or a unique id prefix. A name
 * two remotes share matches neither (their peer ids are their remote ids).
 */
export function findMirrorPeer(peers: readonly MirrorPeerSummary[], ref: string): MirrorPeerMatch {
	const wanted = ref.trim();
	const exact = peers.find((peer) => peer.peerId === wanted);
	if (exact) return { ok: true, peer: exact };
	const lower = wanted.toLowerCase();
	const tiers = [
		peers.filter(
			(peer) => peer.peerId.toLowerCase() === lower || peer.name.toLowerCase() === lower
		),
		peers.filter((peer) => peer.remoteId === wanted),
		wanted ? peers.filter((peer) => peer.remoteId.startsWith(wanted)) : [],
	];
	for (const matches of tiers) {
		if (matches.length === 1) return { ok: true, peer: matches[0] };
		if (matches.length > 1) {
			return {
				ok: false,
				code: 'ambiguous-peer',
				error: `Ambiguous peer "${ref}": matches ${matches.map((peer) => peer.peerId).join(', ')}`,
			};
		}
	}
	return { ok: false, code: 'unknown-peer', error: `Not a mirrored peer: ${ref}` };
}

function stateStep(peer: MirroredPeer): MirrorStep {
	return { peer, push: [{ type: 'peer.state', peer: summarizePeer(peer) }] };
}

/**
 * Set the connection. A change that changes nothing pushes nothing. Any state but connected means
 * the link is down: the host's next whole list is the first report since (`reportedSinceLink`).
 */
export function setPeerConnection(
	peer: MirroredPeer,
	connection: PeerMirrorConnection,
	error?: string
): MirrorStep {
	const forgetsReport = connection !== 'connected' && peer.reportedSinceLink === true;
	if (peer.connection === connection && peer.error === error && !forgetsReport) {
		return { peer, push: [] };
	}
	const next: MirroredPeer = { ...peer, connection };
	if (error) next.error = error;
	else delete next.error;
	if (forgetsReport) delete next.reportedSinceLink;
	return stateStep(next);
}

function tabKeysOf(agents: readonly AgentRecord[]): Set<string> {
	const keys = new Set<string>();
	for (const agent of agents) {
		for (const tab of agent.aiTabs ?? []) keys.add(liveTurnKey(agent.id, tab.id));
	}
	return keys;
}

/** Keep only the entries whose tab still exists. */
function pruneByTabs<T>(record: Record<string, T>, keys: Set<string>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const [key, value] of Object.entries(record)) {
		if (keys.has(key)) out[key] = value;
	}
	return out;
}

/** Keep only the entries (queues, Auto Runs) of agents the peer still has. */
function pruneByAgent<T>(
	byAgent: Record<string, T>,
	agents: readonly AgentRecord[]
): Record<string, T> {
	const ids = new Set(agents.map((agent) => agent.id));
	const out: Record<string, T> = {};
	for (const [agentId, value] of Object.entries(byAgent))
		if (ids.has(agentId)) out[agentId] = value;
	return out;
}

/** How many queue exits the mirror keeps per agent (`MirroredPeer.queueExits`). */
export const MAX_MIRRORED_QUEUE_EXITS = 32;

/**
 * How long the desktop mirror merges the `agent.history` pushes of one agent into one: a desktop
 * host sends one History write as `history:entryAdded` plus the two to four `fs.watch` events
 * macOS fires for it, and each push makes an open History panel read the host's whole list again.
 * A window that waits on such a push waits longer than this (L34).
 */
export const MIRROR_HISTORY_PUSH_MERGE_MS = 150;

/** How `itemId` left its host's queue, when the host named it; undefined while not named. */
export function queueExitOf(
	exits: readonly QueueExit[] | undefined,
	itemId: string
): QueueExit['exit'] | undefined {
	return exits?.find((exit) => exit.itemId === itemId)?.exit;
}

/**
 * A queue list with each `imagesKept` item given the images held for its id (M26): a desktop host
 * sends an item's images once, and after that says they are unchanged. An item held with none
 * keeps the flag, so a read of the queue that the change raced can still give them
 * (`withReadQueueImages()`).
 */
function withKeptQueueImages(
	items: QueuedTurn[],
	had: readonly QueuedTurn[] | undefined
): QueuedTurn[] {
	if (!items.some((item) => item.imagesKept)) return items;
	const held = new Map((had ?? []).map((item) => [item.itemId, item.images]));
	return items.map((item) => {
		const images = item.imagesKept ? held.get(item.itemId) : undefined;
		return images?.length ? { ...withoutKeptFlag(item), images } : item;
	});
}

function withoutKeptFlag({ imagesKept: _kept, ...item }: QueuedTurn): QueuedTurn {
	return item;
}

/**
 * The held queue `kept` with the images a read of the queue gave each item still waiting for them
 * (`imagesKept` with none held: a change that said "unchanged" reached a mirror whose first read
 * of the queue had not landed). The same list when there is nothing to give. Used when a change
 * raced the read and its newer list is kept over the read's (Greptile on #2160).
 */
export function withReadQueueImages(
	kept: readonly QueuedTurn[],
	read: readonly QueuedTurn[]
): readonly QueuedTurn[] {
	const fromRead = new Map(read.map((item) => [item.itemId, item.images]));
	let changed = false;
	const next = kept.map((item) => {
		const images = item.imagesKept ? fromRead.get(item.itemId) : undefined;
		if (!images?.length) return item;
		changed = true;
		return { ...withoutKeptFlag(item), images };
	});
	return changed ? next : kept;
}

/**
 * Replace what waits in one agent's host queue (a `queue.changed`, or a read of the queue after a
 * reconnect or a wake). An agent the peer does not have is ignored; an empty list drops the entry.
 * A change that names how an item left (`exits.exit`) adds it to the agent's recent exits; a read
 * of the queue names none and leaves them as they are. An `imagesKept` item takes the images held
 * for it (`withKeptQueueImages()`).
 */
export function setAgentQueue(
	peer: MirroredPeer,
	agentId: string,
	listed: QueuedTurn[],
	exits: { exit?: QueueExit; namesExits?: boolean } = {}
): MirrorStep {
	if (!peer.agents.some((agent) => agent.id === agentId)) return { peer, push: [] };
	const had = peer.queues[agentId];
	const items = withKeptQueueImages(listed, had);
	const knewExits = peer.queueExits?.[agentId];
	const namesExits = exits.namesExits === true;
	// A whole read of a queue whose host names exits: the exits named meanwhile may be missing.
	const gapRead = !namesExits && !!knewExits;
	const exitsChange = !!exits.exit || (namesExits && !knewExits) || gapRead;
	if (!had?.length && !items.length && !exitsChange) return { peer, push: [] };
	const queues = { ...peer.queues };
	if (items.length) queues[agentId] = items;
	else delete queues[agentId];
	let queueExits = peer.queueExits;
	if (namesExits) {
		const kept = (knewExits ?? []).filter((known) => known.itemId !== exits.exit?.itemId);
		const next = exits.exit ? [...kept, exits.exit] : kept;
		queueExits = { ...peer.queueExits, [agentId]: next.slice(-MAX_MIRRORED_QUEUE_EXITS) };
	}
	const queueReads = gapRead
		? { ...peer.queueReads, [agentId]: (peer.queueReads?.[agentId] ?? 0) + 1 }
		: peer.queueReads;
	return {
		peer: {
			...peer,
			queues,
			...(queueExits ? { queueExits } : {}),
			...(queueReads ? { queueReads } : {}),
		},
		push: [
			{
				type: 'agent.queue',
				agentId,
				items,
				...(exits.exit ? { exit: exits.exit } : {}),
				...(namesExits ? { namesExits: true as const } : {}),
			},
		],
	};
}

/**
 * Replace one agent's Auto Run with the host's frame (`null` or a frame that is not running clears
 * it). An agent the peer does not have is ignored.
 */
export function setAgentAutoRun(
	peer: MirroredPeer,
	agentId: string,
	state: AutoRunBroadcastState | null
): MirrorStep {
	if (!peer.agents.some((agent) => agent.id === agentId)) return { peer, push: [] };
	const running = state?.isRunning ? state : null;
	if (!running && !peer.autoRuns[agentId]) return { peer, push: [] };
	const autoRuns = { ...peer.autoRuns };
	if (running) autoRuns[agentId] = running;
	else delete autoRuns[agentId];
	return {
		peer: { ...peer, autoRuns },
		push: [{ type: 'agent.autorun', agentId, state: running }],
	};
}

/** Mark every tab stale (a connection that did not resume, a wake). */
export function markAllTabsStale(peer: MirroredPeer): MirrorStep {
	const staleTabs: Record<string, true> = {};
	for (const key of tabKeysOf(peer.agents)) staleTabs[key] = true;
	return { peer: { ...peer, staleTabs }, push: [{ type: 'peer.stale' }] };
}

/** The tab's transcript was read: it is no longer stale. */
export function clearTabStale(peer: MirroredPeer, agentId: string, tabId: string): MirroredPeer {
	const key = liveTurnKey(agentId, tabId);
	if (!peer.staleTabs[key]) return peer;
	const staleTabs = { ...peer.staleTabs };
	delete staleTabs[key];
	return { ...peer, staleTabs };
}

/** Replace the whole agent list (a snapshot, or a reload after a wake or a reconnect). */
export function replacePeerAgents(
	peer: MirroredPeer,
	agents: AgentRecord[],
	groups: GroupRecord[],
	now: number
): MirrorStep {
	const keys = tabKeysOf(agents);
	const next: MirroredPeer = {
		...peer,
		agents,
		groups,
		liveTurns: pruneByTabs(peer.liveTurns, keys),
		queues: pruneByAgent(peer.queues, agents),
		...(peer.queueExits ? { queueExits: pruneByAgent(peer.queueExits, agents) } : {}),
		...(peer.queueReads ? { queueReads: pruneByAgent(peer.queueReads, agents) } : {}),
		autoRuns: pruneByAgent(peer.autoRuns, agents),
		staleTabs: pruneByTabs(peer.staleTabs, keys),
		lastSyncAt: now,
		// Only a live link lists the agents: this is the host's report as it is now.
		reportedSinceLink: true,
	};
	return {
		peer: next,
		push: [
			{ type: 'peer.agents', agents, groups, lastSyncAt: now },
			{ type: 'peer.state', peer: summarizePeer(next) },
		],
	};
}

function upsertAgent(peer: MirroredPeer, agent: AgentRecord): MirrorStep {
	const index = peer.agents.findIndex((existing) => existing.id === agent.id);
	const agents =
		index >= 0
			? [...peer.agents.slice(0, index), agent, ...peer.agents.slice(index + 1)]
			: [...peer.agents, agent];
	// Live turns and stale marks for tabs this agent no longer has go with them.
	const gone = new Set(
		(index >= 0 ? (peer.agents[index].aiTabs ?? []) : [])
			.map((tab) => tab.id)
			.filter((tabId) => !(agent.aiTabs ?? []).some((tab) => tab.id === tabId))
			.map((tabId) => liveTurnKey(agent.id, tabId))
	);
	const drop = <T>(record: Record<string, T>): Record<string, T> => {
		if (!gone.size) return record;
		const out = { ...record };
		for (const key of gone) delete out[key];
		return out;
	};
	const next: MirroredPeer = {
		...peer,
		agents,
		liveTurns: drop(peer.liveTurns),
		staleTabs: drop(peer.staleTabs),
	};
	const push: MirrorEvent[] = [{ type: 'agent.updated', agent }];
	if (index < 0) push.push({ type: 'peer.state', peer: summarizePeer(next) });
	return { peer: next, push };
}

function removeAgent(peer: MirroredPeer, agentId: string): MirrorStep {
	if (!peer.agents.some((agent) => agent.id === agentId)) return { peer, push: [] };
	const prefix = liveTurnKey(agentId, '');
	const keep = <T>(record: Record<string, T>): Record<string, T> => {
		const out: Record<string, T> = {};
		for (const [key, value] of Object.entries(record)) {
			if (!key.startsWith(prefix)) out[key] = value;
		}
		return out;
	};
	const queues = { ...peer.queues };
	delete queues[agentId];
	const queueExits = peer.queueExits ? { ...peer.queueExits } : undefined;
	if (queueExits) delete queueExits[agentId];
	const queueReads = peer.queueReads ? { ...peer.queueReads } : undefined;
	if (queueReads) delete queueReads[agentId];
	const autoRuns = { ...peer.autoRuns };
	delete autoRuns[agentId];
	const next: MirroredPeer = {
		...peer,
		agents: peer.agents.filter((agent) => agent.id !== agentId),
		liveTurns: keep(peer.liveTurns),
		queues,
		...(queueExits ? { queueExits } : {}),
		...(queueReads ? { queueReads } : {}),
		autoRuns,
		staleTabs: keep(peer.staleTabs),
	};
	return {
		peer: next,
		push: [
			{ type: 'agent.removed', agentId },
			{ type: 'peer.state', peer: summarizePeer(next) },
		],
	};
}

function applyTurn(
	peer: MirroredPeer,
	agentId: string,
	tabId: string,
	event: TurnEvent,
	ctx: MirrorContext
): MirrorStep {
	const key = liveTurnKey(agentId, tabId);
	const folded = foldLiveTurn(peer.liveTurns[key], event, ctx);
	const liveTurns = { ...peer.liveTurns };
	const push: MirrorEvent[] = [{ type: 'turn', agentId, tabId, event }];
	let staleTabs = peer.staleTabs;
	if (folded) {
		liveTurns[key] = folded;
	} else {
		// The turn ended or events were missed: the host's persisted transcript is the truth now.
		delete liveTurns[key];
		staleTabs = { ...peer.staleTabs, [key]: true };
		push.push({ type: 'tab.stale', agentId, tabId });
	}
	return { peer: { ...peer, liveTurns, staleTabs }, push };
}

/**
 * Apply one event from the peer's client. Tab, settings, and group chat events change nothing:
 * every tab change is followed by an `agent.updated`, and group chat mirroring is out of scope.
 * A `queue.changed` replaces the agent's queue; an Auto Run `state` replaces its run. A run's
 * output and usage are not held: the host's History and the agent's tabs carry them.
 */
export function applyPeerEvent(
	peer: MirroredPeer,
	event: MaestroEvent,
	ctx: MirrorContext
): MirrorStep {
	switch (event.type) {
		case 'host.connected': {
			const kind = event.host?.kind;
			const connected =
				kind && kind !== peer.hostKind
					? stateStep({ ...setPeerConnection(peer, 'connected').peer, hostKind: kind })
					: setPeerConnection(peer, 'connected');
			if (event.resumed) return connected;
			// Nothing was replayed: every transcript a window holds may be behind.
			const stale = markAllTabsStale(connected.peer);
			return { peer: stale.peer, push: [...connected.push, ...stale.push] };
		}
		case 'host.reconnecting':
			return setPeerConnection(peer, 'reconnecting', peer.error);
		case 'host.lost':
			return setPeerConnection(peer, 'lost', event.reason);
		case 'snapshot':
			return replacePeerAgents(peer, event.agents, event.groups, ctx.now());
		case 'agent.added':
		case 'agent.updated':
			return upsertAgent(peer, event.agent);
		case 'agent.removed':
			return removeAgent(peer, event.agentId);
		case 'groups.changed':
			return { peer: { ...peer, groups: event.groups }, push: [] };
		case 'turn':
			return applyTurn(peer, event.agentId, event.tabId, event.event, ctx);
		case 'queue.changed':
			return setAgentQueue(peer, event.agentId, event.items, {
				exit: event.exit,
				namesExits: event.namesExits,
			});
		case 'autorun': {
			const run = event.event;
			if (run.kind === 'thinking' || run.kind === 'tool') {
				if (!peer.agents.some((agent) => agent.id === event.agentId)) return { peer, push: [] };
				return {
					peer,
					push: [{ type: 'agent.autorunActivity', agentId: event.agentId, activity: run }],
				};
			}
			if (run.kind !== 'state') return { peer, push: [] };
			// Only a wire event carries the frame; without one, only a clear can be applied.
			if (run.frame === undefined && run.state !== null) return { peer, push: [] };
			return setAgentAutoRun(peer, event.agentId, run.frame ?? null);
		}
		case 'history.changed':
			if (!peer.agents.some((agent) => agent.id === event.agentId)) return { peer, push: [] };
			return { peer, push: [{ type: 'agent.history', agentId: event.agentId }] };
		default:
			return { peer, push: [] };
	}
}
