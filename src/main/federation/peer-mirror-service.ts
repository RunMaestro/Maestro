/**
 * The desktop's mirror of its Federation peers (FED-SSH-05), and the input path to them (FED-SSH-06).
 *
 * For every SSH remote with `federation` on, the service holds the SSH forward (FED-SSH-01) and a
 * `MaestroClient` attached to the host behind it, and folds the host's events into a
 * `MirroredPeer` (`src/shared/maestro-lib/client/peer-mirror.ts`). It pushes each change to every
 * window as `federation:event` and answers reads (`peers`, `snapshot`, `transcript`) for the IPC
 * handler and the CLI bridge. `act()` drives a mirrored agent over the same held client.
 *
 * Hard rules:
 * - Memory only. A mirrored agent never reaches `sessionStore`, `maestro-sessions.json`, or any
 *   persisted store. The service has no reference to one; its only outputs are its own memory
 *   and the `push` / `reset` callbacks.
 * - One remote at a time. Connects, reloads, and reconnects run through ONE queue, strictly in
 *   sequence, so no two discovery or forward ssh processes start at once (decision D8: tailcat
 *   remotes fail under concurrent dials). A remote without `federation` is never dialed.
 * - No retry loop of its own. Once attached, the client heartbeats, reconnects, and resyncs, and
 *   the lease restarts the forward; the service only records what they report.
 *
 * Constructed only while the Federation Encore Feature is on (`createFederationSupervisorHooks`).
 */

import { generateUUID } from '../../shared/uuid';
import {
	PeerConnectError,
	connectPeerClient,
	federationPeersOf,
	type PeerClient,
} from '../../shared/maestro-lib/client/peer-connection';
import {
	applyPeerEvent,
	clearTabStale,
	createMirroredPeer,
	markAllTabsStale,
	replacePeerAgents,
	setPeerConnection,
	summarizePeer,
	type MirrorContext,
	type MirrorEvent,
	type MirrorPeerSummary,
	type MirrorPush,
	type MirrorStep,
	type MirroredPeer,
} from '../../shared/maestro-lib/client/peer-mirror';
import { coalesceTurnEvents, liveTurnKey } from '../../shared/maestro-lib/client/live-turn';
import {
	peerActionErrorMessage,
	runPeerAgentAction,
	type PeerAgentAction,
	type PeerAgentActionResult,
} from '../../shared/maestro-lib/client/peer-actions';
import type {
	ForwardedHostEndpoint,
	SshForwardLease,
} from '../../shared/maestro-lib/client/ssh-forward';
import type { MaestroClient, TurnEvent } from '../../shared/maestro-lib/client/types';
import type { LogEntryRecord } from '../../shared/maestro-lib/store/transcript';
import type { SshRemoteConfig } from '../../shared/types';

/** Per-tab turn pushes are batched this long, so a fast stream is not one IPC per chunk. */
export const MIRROR_TURN_COALESCE_MS = 50;
/** Transcripts served, kept for a second read of the same tab (another window, a re-open). */
export const MIRROR_TRANSCRIPT_CACHE_SIZE = 20;
/** Entries a transcript read returns when the caller does not say. */
export const MIRROR_TRANSCRIPT_DEFAULT_TAIL = 500;

export interface PeerMirrorServiceDeps {
	/** The stored SSH remotes. Read on every reconcile; nothing is cached. */
	readRemotes(): SshRemoteConfig[];
	/** Call `onChange` when the stored SSH remotes change. Returns the unsubscribe. */
	watchRemotes?(onChange: () => void): () => void;
	acquireForward(remote: SshRemoteConfig): SshForwardLease;
	createClient(endpoint: () => Promise<ForwardedHostEndpoint>): MaestroClient;
	/** Send one change to every window. */
	push(payload: MirrorPush): void;
	/** Tell every window to drop everything (the feature turned off). */
	reset(): void;
	now?(): number;
	newId?(): string;
	/** Report a failure that is not a peer's own state (a bug, not a down host). */
	onError?(error: unknown, operation: string): void;
	/** Test seam for the turn coalescing timer. */
	setTimer?(callback: () => void, ms: number): unknown;
	clearTimer?(handle: unknown): void;
}

/** What `snapshot()` answers: every peer with its agents and live turns. */
export interface PeerMirrorSnapshot {
	peers: MirroredPeer[];
}

export interface PeerReconnectResult {
	ok: boolean;
	error?: string;
	peer?: MirrorPeerSummary;
}

/** What `act()` answers. `unknown`: the host may have taken a send; do not resend blindly. */
export type PeerActionAnswer =
	| { ok: true; result: PeerAgentActionResult }
	| { ok: false; error: string; unknown?: boolean };

export interface TranscriptReadOptions {
	tail?: number;
}

/** One mirrored remote: its state and, while attached, its client. */
interface PeerEntry {
	remote: SshRemoteConfig;
	state: MirroredPeer;
	connection?: PeerClient;
	/** Unsubscribes for the client's events and the lease's state. */
	unsubscribes: Array<() => void>;
	/** Set when the entry is dropped, so a queued task or a late event for it does nothing. */
	dropped: boolean;
}

export class PeerMirrorService {
	private readonly deps: PeerMirrorServiceDeps;
	private readonly ctx: MirrorContext;
	/** By remote id, in stored order. */
	private readonly entries = new Map<string, PeerEntry>();
	/** The one queue every dial runs through. */
	private queue: Promise<void> = Promise.resolve();
	/** Queued (not yet started) tasks by remote id, so a task is never queued twice. */
	private readonly pending = new Map<string, Promise<void>>();
	private readonly turnBuffer = new Map<
		string,
		{ peerId: string; agentId: string; tabId: string; events: TurnEvent[] }
	>();
	private turnTimer: unknown = null;
	private readonly transcriptCache = new Map<string, LogEntryRecord[]>();
	private unwatchRemotes: (() => void) | null = null;
	private started = false;
	private stopped = false;

	constructor(deps: PeerMirrorServiceDeps) {
		this.deps = deps;
		this.ctx = { now: deps.now ?? (() => Date.now()), newId: deps.newId ?? generateUUID };
	}

	/** Start mirroring every opted-in remote, and follow the stored remotes from now on. */
	start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		this.unwatchRemotes = this.deps.watchRemotes?.(() => this.reconcile()) ?? null;
		this.reconcile();
	}

	/**
	 * Settle the mirrored set against the stored remotes: a newly opted-in remote is queued for
	 * connect, one that was deleted, disabled, or opted out is dropped. A remote whose peer id
	 * changed (another remote now shares its name) is dropped and mirrored again under the new id.
	 */
	reconcile(): void {
		if (!this.started || this.stopped) return;
		const wanted = federationPeersOf(this.deps.readRemotes());
		const wantedIds = new Set(wanted.map(({ remote }) => remote.id));
		for (const [remoteId, entry] of [...this.entries]) {
			const match = wanted.find(({ remote }) => remote.id === remoteId);
			if (!wantedIds.has(remoteId) || (match && match.peer !== entry.state.peerId)) {
				this.drop(remoteId);
			}
		}
		for (const { peer, remote } of wanted) {
			const entry = this.entries.get(remote.id);
			if (entry) {
				entry.remote = remote;
				if (entry.state.name !== remote.name) {
					this.commit(entry, { peer: { ...entry.state, name: remote.name }, push: [] });
					this.emit(entry, { type: 'peer.state', peer: summarizePeer(entry.state) });
				}
				continue;
			}
			const created: PeerEntry = {
				remote,
				state: createMirroredPeer({ peerId: peer, remoteId: remote.id, name: remote.name }),
				unsubscribes: [],
				dropped: false,
			};
			this.entries.set(remote.id, created);
			this.emit(created, { type: 'peer.state', peer: summarizePeer(created.state) });
			void this.enqueue(remote.id, () => this.connect(created));
		}
	}

	/** Every mirrored peer, in stored order. The same answer the CLI's `federation peers` prints. */
	peers(): MirrorPeerSummary[] {
		return [...this.entries.values()].map((entry) => summarizePeer(entry.state));
	}

	/** Every peer with its agents and live turns, for a window that just loaded. */
	snapshot(): PeerMirrorSnapshot {
		return { peers: [...this.entries.values()].map((entry) => entry.state) };
	}

	/**
	 * A tab's transcript as the host persisted it, newest `tail` entries. Clears the tab's stale
	 * mark. A peer that is not attached is an error that names it.
	 */
	async transcript(
		peerId: string,
		agentId: string,
		tabId: string,
		options: TranscriptReadOptions = {}
	): Promise<LogEntryRecord[]> {
		const entry = this.entryForPeer(peerId);
		const client = entry.connection?.client;
		if (!client) {
			throw new Error(
				`Peer "${peerId}" is not connected.${entry.state.error ? ` ${entry.state.error}` : ''}`
			);
		}
		const tail = options.tail ?? MIRROR_TRANSCRIPT_DEFAULT_TAIL;
		const cacheKey = `${peerId}\u0000${liveTurnKey(agentId, tabId)}\u0000${tail}`;
		const stale = entry.state.staleTabs[liveTurnKey(agentId, tabId)] === true;
		const cached = this.transcriptCache.get(cacheKey);
		if (cached && !stale) {
			this.transcriptCache.delete(cacheKey);
			this.transcriptCache.set(cacheKey, cached);
			return cached;
		}
		const read = await client.tabs.transcript(agentId, tabId, { tail });
		if (!read.ok) throw new Error(`Peer "${peerId}": ${read.error.message}`);
		if (!entry.dropped) {
			entry.state = clearTabStale(entry.state, agentId, tabId);
			this.transcriptCache.delete(cacheKey);
			this.transcriptCache.set(cacheKey, read.value);
			while (this.transcriptCache.size > MIRROR_TRANSCRIPT_CACHE_SIZE) {
				const oldest = this.transcriptCache.keys().next().value as string;
				this.transcriptCache.delete(oldest);
			}
		}
		return read.value;
	}

	/**
	 * Drive a mirrored agent (FED-SSH-06): send, Stop, new tab, rename or star a tab, through the
	 * same `runPeerAgentAction()` the CLI's `peer:agent` verbs run. Never queued: a peer that is not
	 * connected right now answers an error at once, and nothing is held for a reconnect. The host's
	 * own events then update the mirror (a new tab, a rename, the turn's stream).
	 */
	async act(peerId: string, agentId: string, action: PeerAgentAction): Promise<PeerActionAnswer> {
		let entry: PeerEntry;
		try {
			entry = this.entryForPeer(peerId);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		const client = entry.connection?.client;
		if (!client || entry.state.connection !== 'connected') {
			const reason = entry.state.error ? ` ${entry.state.error}` : '';
			return {
				ok: false,
				error: `Not connected to peer "${peerId}" (${entry.state.connection}). Nothing was sent.${reason}`,
			};
		}
		const agent = entry.state.agents.find((candidate) => candidate.id === agentId);
		if (!agent) {
			return { ok: false, error: `Peer "${peerId}" has no agent ${agentId}.` };
		}
		const result = await runPeerAgentAction(client, agent, action);
		if (!result.ok) {
			return {
				ok: false,
				error: peerActionErrorMessage(peerId, result.error),
				...(result.error.unknown ? { unknown: true } : {}),
			};
		}
		return { ok: true, result: result.value };
	}

	/**
	 * The held client of the peer on `remoteId`, for a call that is not an agent action (the
	 * desktop's Lift, `src/main/federation/lift.ts`). Borrowed, never dialed: a peer that is not
	 * connected right now is an error that names it, so no second ssh starts beside the queue.
	 */
	hostClient(remoteId: string): { peer: string; client: MaestroClient } {
		const entry = this.entries.get(remoteId);
		if (!entry) {
			throw new Error(
				`SSH remote ${remoteId} is not a mirrored Federation peer. Turn Federation on for it first.`
			);
		}
		const client = entry.connection?.client;
		if (!client || entry.state.connection !== 'connected') {
			const reason = entry.state.error ? ` ${entry.state.error}` : '';
			throw new Error(
				`Not connected to peer "${entry.state.peerId}" (${entry.state.connection}). Nothing moved.${reason}`
			);
		}
		return { peer: entry.state.peerId, client };
	}

	/**
	 * Force a reload of one peer: restart the forward when it is down, reconnect the client when it
	 * is not attached, then read the whole agent list again. Runs in the one queue.
	 */
	async reconnect(peerId: string): Promise<PeerReconnectResult> {
		let entry: PeerEntry;
		try {
			entry = this.entryForPeer(peerId);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		const lease = entry.connection?.lease;
		const forward = lease?.state().status;
		if (lease && (forward === 'down' || forward === 'stopped')) lease.restart();
		await this.enqueue(entry.remote.id, () => this.reload(entry));
		const summary = summarizePeer(entry.state);
		return summary.connection === 'connected'
			? { ok: true, peer: summary }
			: {
					ok: false,
					error: summary.error ?? `Peer "${peerId}" is ${summary.connection}.`,
					peer: summary,
				};
	}

	/**
	 * After a wake: every peer, in order, reconnects when it is not attached and reloads its whole
	 * agent list; every tab is marked stale. Idempotent against the several `resume` events one
	 * wake raises: a reload already queued for a peer is not queued again.
	 */
	reloadAfterWake(): void {
		if (!this.started || this.stopped) return;
		for (const entry of this.entries.values()) {
			void this.enqueue(entry.remote.id, () => this.reload(entry));
		}
	}

	/** Close every client, drop every forward, forget everything, and tell every window. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.unwatchRemotes?.();
		this.unwatchRemotes = null;
		if (this.turnTimer !== null) {
			(this.deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)))(
				this.turnTimer
			);
			this.turnTimer = null;
		}
		this.turnBuffer.clear();
		this.transcriptCache.clear();
		const entries = [...this.entries.values()];
		this.entries.clear();
		this.pending.clear();
		await Promise.all(entries.map((entry) => this.detach(entry)));
		this.deps.reset();
	}

	// -------------------------------------------------------------------------

	private entryForPeer(peerId: string): PeerEntry {
		for (const entry of this.entries.values()) {
			if (entry.state.peerId === peerId) return entry;
		}
		throw new Error(`Not a mirrored peer: ${peerId}`);
	}

	/** Run `task` for `remoteId` in the one queue, unless one is already waiting for it. */
	private enqueue(remoteId: string, task: () => Promise<void>): Promise<void> {
		const waiting = this.pending.get(remoteId);
		if (waiting) return waiting;
		const run = this.queue.then(async () => {
			this.pending.delete(remoteId);
			if (this.stopped) return;
			try {
				await task();
			} catch (error) {
				this.deps.onError?.(error, 'federation:queue');
			}
		});
		this.pending.set(remoteId, run);
		this.queue = run;
		return run;
	}

	/** Open the forward and attach a client. A failure is the peer's state, not a throw. */
	private async connect(entry: PeerEntry): Promise<void> {
		if (entry.dropped || this.stopped) return;
		this.commit(entry, setPeerConnection(entry.state, 'connecting'));
		const unsubscribes: Array<() => void> = [];
		let opened: PeerClient;
		try {
			opened = await connectPeerClient(entry.state.peerId, entry.remote, {
				acquireForward: (remote) => {
					const lease = this.deps.acquireForward(remote);
					unsubscribes.push(lease.onChange((state) => this.onLeaseState(entry, state)));
					return lease;
				},
				// Subscribe before `connect()`, so the snapshot that follows the first attach is not missed.
				createClient: (endpoint) => {
					const client = this.deps.createClient(endpoint);
					unsubscribes.push(client.events.subscribe((event) => this.onEvent(entry, event)));
					return client;
				},
			});
		} catch (error) {
			for (const unsubscribe of unsubscribes) unsubscribe();
			if (entry.dropped || this.stopped) return;
			if (error instanceof PeerConnectError) {
				this.commit(entry, setPeerConnection(entry.state, error.code, error.message));
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			this.commit(entry, setPeerConnection(entry.state, 'connect-failed', message));
			this.deps.onError?.(error, 'federation:connect');
			return;
		}
		if (entry.dropped || this.stopped) {
			for (const unsubscribe of unsubscribes) unsubscribe();
			await opened.release();
			return;
		}
		entry.connection = opened;
		entry.unsubscribes = unsubscribes;
		// The client reports `host.connected` from inside `connect()`; make sure the state says so.
		this.commit(entry, setPeerConnection(entry.state, 'connected'));
	}

	/** Reconnect when needed, then replace the whole agent list and mark every tab stale. */
	private async reload(entry: PeerEntry): Promise<void> {
		if (entry.dropped || this.stopped) return;
		if (!entry.connection) {
			await this.connect(entry);
			if (!entry.connection) return;
		}
		const { client } = entry.connection;
		if (client.connection.state() !== 'connected') {
			const attached = await client.connection.reconnect();
			if (entry.dropped || this.stopped) return;
			if (!attached.ok) {
				this.commit(entry, setPeerConnection(entry.state, 'lost', attached.error.message));
				return;
			}
		}
		const [agents, groups] = await Promise.all([client.agents.list(), client.groups.list()]);
		if (entry.dropped || this.stopped) return;
		if (!agents.ok) {
			this.commit(entry, setPeerConnection(entry.state, 'lost', agents.error.message));
			return;
		}
		this.commit(
			entry,
			replacePeerAgents(
				entry.state,
				agents.value,
				groups.ok ? groups.value : entry.state.groups,
				this.ctx.now()
			)
		);
		this.commit(entry, setPeerConnection(entry.state, 'connected'));
		this.commit(entry, markAllTabsStale(entry.state));
	}

	private onEvent(entry: PeerEntry, event: Parameters<typeof applyPeerEvent>[1]): void {
		if (entry.dropped || this.stopped) return;
		this.commit(entry, applyPeerEvent(entry.state, event, this.ctx));
	}

	private onLeaseState(entry: PeerEntry, state: ReturnType<SshForwardLease['state']>): void {
		if (entry.dropped || this.stopped) return;
		if (state.status === 'down') {
			this.commit(entry, setPeerConnection(entry.state, 'lost', state.error.message));
		} else if (state.status === 'stopped') {
			this.commit(entry, setPeerConnection(entry.state, 'lost', 'The SSH forward stopped.'));
		}
	}

	/** Take the reducer's result: keep the state, drop stale cache lines, and push the changes. */
	private commit(entry: PeerEntry, step: MirrorStep): void {
		entry.state = step.peer;
		for (const event of step.push) {
			if (event.type === 'tab.stale') this.forgetTranscript(entry, event.agentId, event.tabId);
			else if (event.type === 'peer.stale' || event.type === 'peer.agents') {
				this.forgetTranscripts(entry);
			}
			this.emit(entry, event);
		}
	}

	private emit(entry: PeerEntry, event: MirrorEvent): void {
		const peerId = entry.state.peerId;
		if (event.type === 'turn') {
			const key = `${peerId}\u0000${liveTurnKey(event.agentId, event.tabId)}`;
			const buffered = this.turnBuffer.get(key);
			if (buffered) buffered.events.push(event.event);
			else {
				this.turnBuffer.set(key, {
					peerId,
					agentId: event.agentId,
					tabId: event.tabId,
					events: [event.event],
				});
			}
			this.armTurnTimer();
			return;
		}
		// Anything else goes out after the turn events before it, so a window sees them in order.
		this.flushTurns();
		this.deps.push({ peerId, event });
	}

	private armTurnTimer(): void {
		if (this.turnTimer !== null) return;
		const setTimer =
			this.deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
		this.turnTimer = setTimer(() => {
			this.turnTimer = null;
			this.flushTurns();
		}, MIRROR_TURN_COALESCE_MS);
	}

	private flushTurns(): void {
		if (!this.turnBuffer.size) return;
		const batches = [...this.turnBuffer.values()];
		this.turnBuffer.clear();
		for (const { peerId, agentId, tabId, events } of batches) {
			for (const event of coalesceTurnEvents(events)) {
				this.deps.push({ peerId, event: { type: 'turn', agentId, tabId, event } });
			}
		}
	}

	private forgetTranscript(entry: PeerEntry, agentId: string, tabId: string): void {
		const prefix = `${entry.state.peerId}\u0000${liveTurnKey(agentId, tabId)}\u0000`;
		for (const key of [...this.transcriptCache.keys()]) {
			if (key.startsWith(prefix)) this.transcriptCache.delete(key);
		}
	}

	private forgetTranscripts(entry: PeerEntry): void {
		const prefix = `${entry.state.peerId}\u0000`;
		for (const key of [...this.transcriptCache.keys()]) {
			if (key.startsWith(prefix)) this.transcriptCache.delete(key);
		}
	}

	/** Stop mirroring one remote: close its client, drop its forward, tell every window. */
	private drop(remoteId: string): void {
		const entry = this.entries.get(remoteId);
		if (!entry) return;
		this.entries.delete(remoteId);
		this.forgetTranscripts(entry);
		for (const key of [...this.turnBuffer.keys()]) {
			if (key.startsWith(`${entry.state.peerId}\u0000`)) this.turnBuffer.delete(key);
		}
		this.emit(entry, { type: 'peer.removed' });
		void this.detach(entry);
	}

	private async detach(entry: PeerEntry): Promise<void> {
		entry.dropped = true;
		for (const unsubscribe of entry.unsubscribes) unsubscribe();
		entry.unsubscribes = [];
		const connection = entry.connection;
		entry.connection = undefined;
		try {
			await connection?.release();
		} catch (error) {
			this.deps.onError?.(error, 'federation:release');
		}
	}
}
