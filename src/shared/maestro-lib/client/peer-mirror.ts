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

import { peerAgentRef } from '../agents/lift-pointer';
import type { AgentRecord, GroupRecord } from '../store/records';
import { foldLiveTurn, liveTurnKey, type LiveTurn, type LiveTurnContext } from './live-turn';
import type { PeerConnectErrorCode } from './peer-connection';
import type { MaestroEvent, TurnEvent } from './types';

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
	/** Tabs whose transcript must be read again on next open, by `liveTurnKey(agentId, tabId)`. */
	staleTabs: Record<string, true>;
	/** When the agent list was last replaced whole, epoch ms. */
	lastSyncAt?: number;
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
	/** Read this tab's transcript again on next open (now, when it is open). */
	| { type: 'tab.stale'; agentId: string; tabId: string }
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

/** Set the connection. A change that changes nothing pushes nothing. */
export function setPeerConnection(
	peer: MirroredPeer,
	connection: PeerMirrorConnection,
	error?: string
): MirrorStep {
	if (peer.connection === connection && peer.error === error) return { peer, push: [] };
	const next: MirroredPeer = { ...peer, connection };
	if (error) next.error = error;
	else delete next.error;
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
		staleTabs: pruneByTabs(peer.staleTabs, keys),
		lastSyncAt: now,
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
	const next: MirroredPeer = {
		...peer,
		agents: peer.agents.filter((agent) => agent.id !== agentId),
		liveTurns: keep(peer.liveTurns),
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
 * Apply one event from the peer's client. Tab, settings, Auto Run, and group chat events change
 * nothing: every tab change is followed by an `agent.updated`, and Auto Run and group chat
 * mirroring are out of scope.
 */
export function applyPeerEvent(
	peer: MirroredPeer,
	event: MaestroEvent,
	ctx: MirrorContext
): MirrorStep {
	switch (event.type) {
		case 'host.connected': {
			const connected = setPeerConnection(peer, 'connected');
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
		default:
			return { peer, push: [] };
	}
}
