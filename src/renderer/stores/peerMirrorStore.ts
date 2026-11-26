/**
 * peerMirrorStore - this window's copy of the Federation peers the desktop mirrors.
 *
 * Memory only (FED-SSH-05). The main-process `PeerMirrorService` owns the truth;
 * `usePeerMirrorBridge()` loads its snapshot and folds its `federation:event` pushes in here. A
 * mirrored agent NEVER enters `sessionStore`, `maestro-sessions.json`, or any persisted store:
 * this store has no `persist` middleware and nothing here calls an IPC writer, so a disconnect or
 * a removed peer can never change local data. Input (FED-SSH-06) goes out through
 * `services/peerMirror.ts`.
 *
 * There is no view of its own: a hosted agent draws through the Main Window as its own Left Bar
 * record, which `startHostedAgentSync()` keeps in step with what this store holds. Agents are keyed
 * `peerId:agentId` (`mirrorKey()`), the string maestro-cli addresses.
 *
 * Folding reuses the shared rules in `src/shared/maestro-lib/client/peer-mirror.ts`, the same ones
 * the main service runs, so a window and main cannot disagree about a peer.
 */

import { create } from 'zustand';
import {
	applyPeerEvent,
	createMirroredPeer,
	mirrorKey,
	replacePeerAgents,
	setAgentAutoRun,
	setAgentQueue,
	type MirrorContext,
	type MirroredPeer,
	type MirrorPush,
} from '../../shared/maestro-lib/client/peer-mirror';
import { liveTurnKey } from '../../shared/maestro-lib/client/live-turn';
import type { LogEntryRecord } from '../../shared/maestro-lib/store/transcript';
import { generateId } from '../utils/ids';

/** One tab's transcript as the host persisted it, read lazily when the tab is opened. */
export interface MirrorTranscriptSlot {
	entries: LogEntryRecord[];
	/** A read has landed at least once. */
	loaded: boolean;
	loading: boolean;
	/** The host has newer entries than `entries`: read again when the tab is shown. */
	stale: boolean;
	/** Bumped on every stale mark, so a read that started before one cannot clear it. */
	staleVersion: number;
	/** The last read failed. */
	error?: string;
	/**
	 * The live entries of a turn that just ended, shown until the re-read that holds its answer
	 * lands. Display only, like the live turn they came from.
	 */
	carryover?: LogEntryRecord[];
}

export interface PeerMirrorData {
	/** This window loaded the mirror snapshot and follows its pushes. */
	enabled: boolean;
	/** Peer ids in stored order. */
	order: string[];
	peers: Record<string, MirroredPeer>;
	/** By peer id, then `liveTurnKey(agentId, tabId)`. */
	transcripts: Record<string, Record<string, MirrorTranscriptSlot>>;
	/**
	 * Bumped per mirrored agent (by `mirrorKey()`) whenever its History on the host may have moved:
	 * a turn of the agent ended, or the peer reloaded. A History panel reads again on a change.
	 */
	historyVersions: Record<string, number>;
}

export interface PeerMirrorActions {
	/** Replace everything with a snapshot from main. */
	hydrate(peers: MirroredPeer[]): void;
	/** Drop everything: the feature turned off, or this window stopped following the mirror. */
	reset(): void;
	/** Fold one `federation:event` push. The only writer of `peers` besides `hydrate`. */
	applyPush(push: MirrorPush): void;
	/** Mark a tab's read in flight. Returns the stale version the read must report back. */
	beginTranscriptRead(peerId: string, agentId: string, tabId: string): number;
	finishTranscriptRead(
		peerId: string,
		agentId: string,
		tabId: string,
		entries: LogEntryRecord[],
		staleVersion: number
	): void;
	failTranscriptRead(peerId: string, agentId: string, tabId: string, message: string): void;
}

export type PeerMirrorState = PeerMirrorData & PeerMirrorActions;

const EMPTY: PeerMirrorData = {
	enabled: false,
	order: [],
	peers: {},
	transcripts: {},
	historyVersions: {},
};

/** Bump the History version of one agent, or of every agent the peer has. */
function bumpHistory(
	state: PeerMirrorData,
	peerId: string,
	agentIds: readonly string[]
): PeerMirrorData {
	if (!agentIds.length) return state;
	const historyVersions = { ...state.historyVersions };
	for (const agentId of agentIds) {
		const key = mirrorKey(peerId, agentId);
		historyVersions[key] = (historyVersions[key] ?? 0) + 1;
	}
	return { ...state, historyVersions };
}

/** Every agent of every peer in a snapshot gets a new History version. */
function bumpAll(
	versions: Record<string, number>,
	peers: readonly MirroredPeer[]
): Record<string, number> {
	const next: Record<string, number> = {};
	for (const peer of peers) {
		for (const agent of peer.agents) {
			const key = mirrorKey(peer.peerId, agent.id);
			next[key] = (versions[key] ?? 0) + 1;
		}
	}
	return next;
}

/** Drop the History versions of one peer's agents (the peer was removed). */
function withoutPeerVersions(
	versions: Record<string, number>,
	peerId: string
): Record<string, number> {
	const prefix = `${peerId}:`;
	const next: Record<string, number> = {};
	for (const [key, version] of Object.entries(versions)) {
		if (!key.startsWith(prefix)) next[key] = version;
	}
	return next;
}

const foldContext: MirrorContext = { newId: generateId, now: () => Date.now() };

function emptySlot(): MirrorTranscriptSlot {
	return { entries: [], loaded: false, loading: false, stale: false, staleVersion: 0 };
}

function markStale(slot: MirrorTranscriptSlot): MirrorTranscriptSlot {
	return { ...slot, stale: true, staleVersion: slot.staleVersion + 1 };
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
	if (!(key in record)) return record;
	const next = { ...record };
	delete next[key];
	return next;
}

/** Keep only the slots whose tab the peer still has. */
function pruneSlots(
	slots: Record<string, MirrorTranscriptSlot> | undefined,
	peer: MirroredPeer
): Record<string, MirrorTranscriptSlot> {
	if (!slots) return {};
	const keep = new Set<string>();
	for (const agent of peer.agents) {
		for (const tab of agent.aiTabs ?? []) keep.add(liveTurnKey(agent.id, tab.id));
	}
	const next: Record<string, MirrorTranscriptSlot> = {};
	for (const [key, slot] of Object.entries(slots)) if (keep.has(key)) next[key] = slot;
	return next;
}

/** Store the peer, and drop the transcript slots of tabs it no longer has. */
function settlePeer(state: PeerMirrorData, peerId: string, peer: MirroredPeer): PeerMirrorData {
	return {
		...state,
		peers: { ...state.peers, [peerId]: peer },
		order: state.order.includes(peerId) ? state.order : [...state.order, peerId],
		transcripts: { ...state.transcripts, [peerId]: pruneSlots(state.transcripts[peerId], peer) },
	};
}

function updateSlot(
	state: PeerMirrorData,
	peerId: string,
	key: string,
	change: (slot: MirrorTranscriptSlot) => MirrorTranscriptSlot
): PeerMirrorData {
	const slots = state.transcripts[peerId] ?? {};
	return {
		...state,
		transcripts: {
			...state.transcripts,
			[peerId]: { ...slots, [key]: change(slots[key] ?? emptySlot()) },
		},
	};
}

/**
 * Fold one push into a window's copy. Pure: exported for tests. Uses the shared peer rules for
 * every agent and turn change, then keeps this window's own view state in step with them.
 */
export function reducePeerMirrorPush(state: PeerMirrorData, push: MirrorPush): PeerMirrorData {
	const { peerId, event } = push;
	const existing = state.peers[peerId];
	const peer =
		existing ??
		createMirroredPeer({
			peerId,
			remoteId: event.type === 'peer.state' ? event.peer.remoteId : '',
			name: event.type === 'peer.state' ? event.peer.name : peerId,
		});

	switch (event.type) {
		case 'peer.state': {
			const summary = event.peer;
			const next: MirroredPeer = {
				...peer,
				remoteId: summary.remoteId,
				name: summary.name,
				connection: summary.connection,
			};
			if (summary.error) next.error = summary.error;
			else delete next.error;
			if (summary.lastSyncAt !== undefined) next.lastSyncAt = summary.lastSyncAt;
			return settlePeer(state, peerId, next);
		}
		case 'peer.agents': {
			const { peer: next } = replacePeerAgents(
				peer,
				event.agents,
				event.groups,
				event.lastSyncAt ?? foldContext.now()
			);
			const settled = settlePeer(state, peerId, next);
			return bumpHistory(
				settled,
				peerId,
				next.agents.map((agent) => agent.id)
			);
		}
		case 'agent.updated':
			return settlePeer(
				state,
				peerId,
				applyPeerEvent(peer, { type: 'agent.updated', agent: event.agent }, foldContext).peer
			);
		case 'agent.removed':
			return settlePeer(
				state,
				peerId,
				applyPeerEvent(peer, { type: 'agent.removed', agentId: event.agentId }, foldContext).peer
			);
		case 'turn': {
			const key = liveTurnKey(event.agentId, event.tabId);
			const before = peer.liveTurns[key];
			const { peer: next } = applyPeerEvent(
				peer,
				{ type: 'turn', agentId: event.agentId, tabId: event.tabId, event: event.event },
				foldContext
			);
			let settled = settlePeer(state, peerId, next);
			if (!next.liveTurns[key]) {
				// The turn ended: the host wrote its History entry.
				settled = bumpHistory(settled, peerId, [event.agentId]);
				// The turn ended (or events were missed). Keep what it showed on screen until the
				// re-read lands, so the answer does not blink out and back in.
				settled = updateSlot(settled, peerId, key, (slot) => ({
					...markStale(slot),
					...(before?.entries.length ? { carryover: before.entries } : {}),
				}));
			}
			return settled;
		}
		case 'agent.queue':
			return settlePeer(state, peerId, setAgentQueue(peer, event.agentId, event.items).peer);
		case 'agent.autorun':
			return settlePeer(state, peerId, setAgentAutoRun(peer, event.agentId, event.state).peer);
		case 'tab.stale': {
			if (!existing) return state;
			const key = liveTurnKey(event.agentId, event.tabId);
			if (!state.transcripts[peerId]?.[key]) return state;
			return updateSlot(state, peerId, key, markStale);
		}
		case 'peer.stale': {
			if (!existing) return state;
			const slots = state.transcripts[peerId] ?? {};
			const next: Record<string, MirrorTranscriptSlot> = {};
			for (const [key, slot] of Object.entries(slots)) next[key] = markStale(slot);
			return bumpHistory(
				{ ...state, transcripts: { ...state.transcripts, [peerId]: next } },
				peerId,
				existing.agents.map((agent) => agent.id)
			);
		}
		case 'peer.removed': {
			if (!existing) return state;
			return {
				...state,
				peers: withoutKey(state.peers, peerId),
				order: state.order.filter((id) => id !== peerId),
				transcripts: withoutKey(state.transcripts, peerId),
				historyVersions: withoutPeerVersions(state.historyVersions, peerId),
			};
		}
		default:
			return state;
	}
}

export const usePeerMirrorStore = create<PeerMirrorState>()((set, get) => ({
	...EMPTY,

	hydrate: (peers) =>
		set((state) => {
			const record: Record<string, MirroredPeer> = {};
			for (const peer of peers) record[peer.peerId] = peer;
			return {
				enabled: true,
				order: peers.map((peer) => peer.peerId),
				peers: record,
				// A fresh snapshot may be ahead of anything read before it.
				transcripts: {},
				// A fresh snapshot may be ahead of any History a panel read before it.
				historyVersions: bumpAll(state.historyVersions, peers),
			};
		}),

	reset: () => set({ ...EMPTY }),

	applyPush: (push) => set((state) => reducePeerMirrorPush(state, push)),

	beginTranscriptRead: (peerId, agentId, tabId) => {
		const key = liveTurnKey(agentId, tabId);
		set((state) =>
			updateSlot(state, peerId, key, (slot) => {
				const next = { ...slot, loading: true };
				delete next.error;
				return next;
			})
		);
		return get().transcripts[peerId]?.[key]?.staleVersion ?? 0;
	},

	finishTranscriptRead: (peerId, agentId, tabId, entries, staleVersion) =>
		set((state) => {
			if (!state.peers[peerId]) return {};
			const key = liveTurnKey(agentId, tabId);
			return updateSlot(state, peerId, key, (slot) => {
				// Marked stale again while the read was out: the entries are already behind, so keep
				// the mark (and the carryover) and let the view read once more.
				const stillStale = slot.staleVersion !== staleVersion;
				const next: MirrorTranscriptSlot = {
					...slot,
					entries,
					loaded: true,
					loading: false,
					stale: stillStale,
				};
				if (!stillStale) delete next.carryover;
				return next;
			});
		}),

	failTranscriptRead: (peerId, agentId, tabId, message) =>
		set((state) => {
			if (!state.peers[peerId]) return {};
			// The stale mark is spent: the view shows the error with a retry instead of reading in a
			// loop against a peer that is down. The next stale mark (a reconnect) reads again.
			return updateSlot(state, peerId, liveTurnKey(agentId, tabId), (slot) => ({
				...slot,
				loading: false,
				stale: false,
				error: message,
			}));
		}),
}));
