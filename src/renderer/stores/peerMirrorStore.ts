/**
 * peerMirrorStore - this window's copy of the Federation peers the desktop mirrors.
 *
 * Memory only (FED-SSH-05). The main-process `PeerMirrorService` owns the truth;
 * `usePeerMirrorBridge()` loads its snapshot and folds its `federation:event` pushes in here. A
 * mirrored agent NEVER enters `sessionStore`, `maestro-sessions.json`, or any persisted store:
 * this store has no `persist` middleware and nothing here calls an IPC writer, so a disconnect or
 * a removed peer can never change local data. Input (FED-SSH-06) goes out through
 * `services/peerMirror.ts`; the only input state kept here is the composer's unsent drafts.
 *
 * Selection is separate from the local one. `activeMirror` is set only while the Main Window
 * shows a mirrored agent; `activeSessionId` keeps holding a LOCAL id the whole time, so no
 * `selectActiveSession()` consumer ever sees a peer's agent. Selecting a local agent
 * (`setActiveSessionId`) clears `activeMirror`, and selecting a mirror clears the active group
 * chat. Agents are keyed `peerId:agentId` (`mirrorKey()`), the string maestro-cli addresses.
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
	type MirrorContext,
	type MirroredPeer,
	type MirrorPush,
} from '../../shared/maestro-lib/client/peer-mirror';
import { liveTurnKey } from '../../shared/maestro-lib/client/live-turn';
import type { LogEntryRecord } from '../../shared/maestro-lib/store/transcript';
import { generateId } from '../utils/ids';
import { resolveMirrorTabId } from '../utils/peerMirrorView';
import { useGroupChatStore } from './groupChatStore';

/** The mirrored agent the Main Window shows. */
export interface MirrorSelection {
	/** `mirrorKey(peerId, agentId)`. */
	key: string;
	peerId: string;
	agentId: string;
}

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
	/** The Federation Encore Feature is on and this window follows the mirror. */
	enabled: boolean;
	/** Peer ids in stored order. */
	order: string[];
	peers: Record<string, MirroredPeer>;
	/** By peer id, then `liveTurnKey(agentId, tabId)`. */
	transcripts: Record<string, Record<string, MirrorTranscriptSlot>>;
	activeMirror: MirrorSelection | null;
	/** View state: the tab shown per mirrored agent, by peer id then agent id. */
	activeTabIds: Record<string, Record<string, string>>;
	/** View state: Left Bar peer groups the user collapsed. */
	collapsedPeerIds: Record<string, true>;
	/** Unsent composer text per mirrored tab, by `mirrorDraftKey()`. Memory only. */
	drafts: Record<string, string>;
}

export interface PeerMirrorActions {
	/** Replace everything with a snapshot from main. Keeps the selection when it still exists. */
	hydrate(peers: MirroredPeer[]): void;
	/** Drop everything: the feature turned off, or this window stopped following the mirror. */
	reset(): void;
	/** Fold one `federation:event` push. The only writer of `peers` besides `hydrate`. */
	applyPush(push: MirrorPush): void;
	selectMirroredAgent(peerId: string, agentId: string): void;
	clearMirrorSelection(): void;
	selectMirrorTab(peerId: string, agentId: string, tabId: string): void;
	/** Step the shown mirrored agent's tab, wrapping (the tab-cycling shortcut). */
	cycleMirrorTab(direction: 1 | -1): void;
	togglePeerCollapsed(peerId: string): void;
	/** Keep (or, with an empty text, drop) the composer draft of one mirrored tab. */
	setMirrorDraft(peerId: string, agentId: string, tabId: string, text: string): void;
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
	activeMirror: null,
	activeTabIds: {},
	collapsedPeerIds: {},
	drafts: {},
};

/** The key of one mirrored tab's composer draft. */
export function mirrorDraftKey(peerId: string, agentId: string, tabId: string): string {
	return `${mirrorKey(peerId, agentId)}\u0000${tabId}`;
}

/** Drop the drafts of one peer's agents (the peer was removed). */
function withoutPeerDrafts(drafts: Record<string, string>, peerId: string): Record<string, string> {
	const prefix = `${peerId}:`;
	let changed = false;
	const next: Record<string, string> = {};
	for (const [key, text] of Object.entries(drafts)) {
		if (key.startsWith(prefix)) changed = true;
		else next[key] = text;
	}
	return changed ? next : drafts;
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

/** Drop a selection, view state, and slots that point at agents the peer no longer has. */
function settlePeer(state: PeerMirrorData, peerId: string, peer: MirroredPeer): PeerMirrorData {
	const agentIds = new Set(peer.agents.map((agent) => agent.id));
	const tabIds = { ...(state.activeTabIds[peerId] ?? {}) };
	for (const agentId of Object.keys(tabIds)) if (!agentIds.has(agentId)) delete tabIds[agentId];
	const selectionGone =
		state.activeMirror?.peerId === peerId && !agentIds.has(state.activeMirror.agentId);
	return {
		...state,
		peers: { ...state.peers, [peerId]: peer },
		order: state.order.includes(peerId) ? state.order : [...state.order, peerId],
		transcripts: { ...state.transcripts, [peerId]: pruneSlots(state.transcripts[peerId], peer) },
		activeTabIds: { ...state.activeTabIds, [peerId]: tabIds },
		activeMirror: selectionGone ? null : state.activeMirror,
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
			return settlePeer(state, peerId, next);
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
				// The turn ended (or events were missed). Keep what it showed on screen until the
				// re-read lands, so the answer does not blink out and back in.
				settled = updateSlot(settled, peerId, key, (slot) => ({
					...markStale(slot),
					...(before?.entries.length ? { carryover: before.entries } : {}),
				}));
			}
			return settled;
		}
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
			return { ...state, transcripts: { ...state.transcripts, [peerId]: next } };
		}
		case 'peer.removed': {
			if (!existing) return state;
			return {
				...state,
				peers: withoutKey(state.peers, peerId),
				order: state.order.filter((id) => id !== peerId),
				transcripts: withoutKey(state.transcripts, peerId),
				activeTabIds: withoutKey(state.activeTabIds, peerId),
				collapsedPeerIds: withoutKey(state.collapsedPeerIds, peerId),
				drafts: withoutPeerDrafts(state.drafts, peerId),
				activeMirror: state.activeMirror?.peerId === peerId ? null : state.activeMirror,
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
			const selection = state.activeMirror;
			const keep =
				selection &&
				record[selection.peerId]?.agents.some((agent) => agent.id === selection.agentId);
			const collapsedPeerIds: Record<string, true> = {};
			for (const id of Object.keys(state.collapsedPeerIds)) {
				if (record[id]) collapsedPeerIds[id] = true;
			}
			return {
				enabled: true,
				order: peers.map((peer) => peer.peerId),
				peers: record,
				// A fresh snapshot may be ahead of anything read before it.
				transcripts: {},
				activeMirror: keep ? selection : null,
				activeTabIds: {},
				collapsedPeerIds,
				drafts: state.drafts,
			};
		}),

	reset: () => set({ ...EMPTY }),

	applyPush: (push) => set((state) => reducePeerMirrorPush(state, push)),

	selectMirroredAgent: (peerId, agentId) => {
		const peer = get().peers[peerId];
		if (!peer?.agents.some((agent) => agent.id === agentId)) return;
		set({ activeMirror: { key: mirrorKey(peerId, agentId), peerId, agentId } });
		// One thing in the Main Window at a time: a group chat yields to the mirror, the same way
		// it yields to a local agent.
		useGroupChatStore.getState().setActiveGroupChatId(null);
	},

	clearMirrorSelection: () => {
		if (get().activeMirror) set({ activeMirror: null });
	},

	selectMirrorTab: (peerId, agentId, tabId) =>
		set((state) => ({
			activeTabIds: {
				...state.activeTabIds,
				[peerId]: { ...(state.activeTabIds[peerId] ?? {}), [agentId]: tabId },
			},
		})),

	cycleMirrorTab: (direction) => {
		const state = get();
		const selection = state.activeMirror;
		if (!selection) return;
		const agent = state.peers[selection.peerId]?.agents.find((a) => a.id === selection.agentId);
		const tabs = (agent?.aiTabs ?? []).filter((tab) => !tab.hidden);
		if (!agent || tabs.length < 2) return;
		const current = resolveMirrorTabId(
			agent,
			state.activeTabIds[selection.peerId]?.[selection.agentId]
		);
		const index = Math.max(
			0,
			tabs.findIndex((tab) => tab.id === current)
		);
		const next = tabs[(index + direction + tabs.length) % tabs.length];
		get().selectMirrorTab(selection.peerId, selection.agentId, next.id);
	},

	togglePeerCollapsed: (peerId) =>
		set((state) => ({
			collapsedPeerIds: state.collapsedPeerIds[peerId]
				? withoutKey(state.collapsedPeerIds, peerId)
				: { ...state.collapsedPeerIds, [peerId]: true },
		})),

	setMirrorDraft: (peerId, agentId, tabId, text) =>
		set((state) => {
			const key = mirrorDraftKey(peerId, agentId, tabId);
			if (!text) return key in state.drafts ? { drafts: withoutKey(state.drafts, key) } : {};
			return state.drafts[key] === text ? {} : { drafts: { ...state.drafts, [key]: text } };
		}),

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

/** The mirror key the Main Window shows, or null while it shows a local agent or a group chat. */
export function selectActiveMirrorKey(state: PeerMirrorData): string | null {
	return state.activeMirror?.key ?? null;
}

/** Whether the Main Window shows a mirrored agent right now. Read at event time by local gates. */
export function isMirrorShown(): boolean {
	return usePeerMirrorStore.getState().activeMirror !== null;
}
