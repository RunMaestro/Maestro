/**
 * The desktop's mirror of its Federation peers (FED-SSH-05), and the input path to them (FED-SSH-06).
 *
 * For every SSH remote with `federation` on, the service holds the SSH forward (FED-SSH-01) and a
 * `MaestroClient` attached to the host behind it, and folds the host's events into a
 * `MirroredPeer` (`src/shared/maestro-lib/client/peer-mirror.ts`). It pushes each change to every
 * window as `federation:event` and answers reads (`peers`, `snapshot`, `transcript`) for the IPC
 * handler and the CLI bridge. `act()` drives a mirrored agent over the same held client.
 *
 * Each agent's host queue rides the host's `queue.changed` events. Those are live only: whenever
 * the mirror may have missed some (a first attach, a resync, a wake), the service reads every
 * agent's queue again (`refreshQueues`), so the window shows what waits on the host right now.
 *
 * Hard rules:
 * - Memory only. A mirrored agent never reaches `sessionStore`, `maestro-sessions.json`, or any
 *   persisted store. The service has no reference to one; its only outputs are its own memory
 *   and the `push` / `reset` callbacks.
 * - One remote at a time. Connects, reloads, and reconnects run through ONE queue, strictly in
 *   sequence, so no two discovery or forward ssh processes start at once (decision D8: tailcat
 *   remotes fail under concurrent dials). A remote without `federation` is never dialed.
 * - No tight retry loop of its own. Once attached, the client heartbeats, reconnects, and resyncs,
 *   and the lease restarts the forward; the service only records what they report. A remote that
 *   answered with no host (`not-installed`, `host-down`) or could not be reached is probed once,
 *   then again only after a wake, a change to the stored remotes, a reconnect, a host setup
 *   (`setupHostFromDesktop`), or the slow re-probe (`MIRROR_REPROBE_INTERVAL_MS`).
 *
 * Federation is opportunistic: every enabled SSH remote that has not opted out is probed, and only
 * the ones that run a host count as peers (`isPeerFederated()`). The mirror holds each host's whole
 * roster; the Left Bar shows only the agents a local record points at (`liftedAgentKeys()`). Constructed once at boot
 * (`createFederationRuntime`).
 */

import * as os from 'os';

import { generateUUID } from '../../shared/uuid';
import { withOwnHostAsLocal } from '../../shared/history';
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
	setAgentQueue,
	withReadQueueImages,
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
import type {
	AgentPatchField,
	ClientErrorCode,
	HistoryEntryUpdates,
	MaestroClient,
	TurnEvent,
} from '../../shared/maestro-lib/client/types';
import type { LogEntryRecord } from '../../shared/maestro-lib/store/transcript';
import type { HistoryEntry } from '../../shared/types';
import type { SshRemoteConfig } from '../../shared/types';
import type { ProjectTokenUsage, ProjectTokenUsageProject } from '../../shared/projectTokenUsage';

/** Per-tab turn pushes are batched this long, so a fast stream is not one IPC per chunk. */
export const MIRROR_TURN_COALESCE_MS = 50;
/** Transcripts served, kept for a second read of the same tab (another window, a re-open). */
export const MIRROR_TRANSCRIPT_CACHE_SIZE = 20;
/** Entries a transcript read returns when the caller does not say. */
export const MIRROR_TRANSCRIPT_DEFAULT_TAIL = 500;
/**
 * How long an action waits for a peer that is reconnecting right now (the host came back, the
 * client has not attached yet) before it is refused. A peer that is down, or whose discovery found
 * no host, is refused at once.
 */
export const MIRROR_ACT_RECONNECT_WAIT_MS = 10_000;
/**
 * How often a remote that answered with no host is probed again, so a host started there some
 * other way (a service manager, `remote-host start`, a reboot) shows up without a click.
 */
export const MIRROR_REPROBE_INTERVAL_MS = 15 * 60_000;
/**
 * The redial ceiling of a host that went down while nothing on this machine is hosted on it (or
 * hosted agents are off): the forward's wait doubles up to this instead of its usual 30 s. An
 * explicit act (Check Now, a send, Move to Host) dials at once and starts the wait over.
 */
export const MIRROR_IDLE_REDIAL_MAX_MS = 5 * 60_000;

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
	/** This machine's hostname, stamped on the History of a turn sent from here. Default `os.hostname()`. */
	originHost?: string;
	/** Test seam for the turn coalescing timer. */
	setTimer?(callback: () => void, ms: number): unknown;
	clearTimer?(handle: unknown): void;
	/** Re-probe interval for remotes with no host. Default `MIRROR_REPROBE_INTERVAL_MS`; 0 turns it off. */
	reprobeIntervalMs?: number;
	/**
	 * Whether an agent on this machine runs on the host `peerId` (a hosted agent, with hosted agents
	 * on): the one predicate the outage tracker reads. A host it says no to redials slowly while it
	 * stays down (`MIRROR_IDLE_REDIAL_MAX_MS`). Absent: every host redials at the forward's own pace.
	 */
	hostsAgents?(peerId: string): boolean;
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

/**
 * What `act()` answers. `unknown`: the host may have taken a send; do not resend blindly. `code`
 * says why it failed: `host-unavailable` when the peer was not connected and nothing was sent.
 */
export type PeerActionAnswer =
	| { ok: true; result: PeerAgentActionResult }
	| {
			ok: false;
			error: string;
			unknown?: boolean;
			code?: ClientErrorCode;
			/**
			 * The service refused before handing anything to the client: the peer was not connected.
			 * The one refusal a caller may retry without any risk of the host running it twice. A
			 * client-level `host-unavailable` (a client closed while a send was pending) never sets it.
			 */
			notSent?: true;
			/** `update-agent` only: the fields the host applied before it refused the rest. */
			appliedFields?: AgentPatchField[];
	  };

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
	/**
	 * Bumped per agent on every `queue.changed`, so a queue read that started before one cannot
	 * overwrite it with an older answer.
	 */
	queueVersions: Map<string, number>;
	/** Actions waiting for a reconnect in progress; called when the connection settles or the entry drops. */
	linkWaiters: Set<() => void>;
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
	/**
	 * Each mirrored agent's History as the host last sent it, by `peerId` NUL `agentId`. Dropped
	 * when a turn of the agent ends, and for the whole peer on a reload, so the next read is fresh.
	 */
	private readonly historyCache = new Map<string, Promise<HistoryEntry[]>>();
	private unwatchRemotes: (() => void) | null = null;
	private reprobeTimer: ReturnType<typeof setTimeout> | null = null;
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
		this.scheduleReprobe();
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
				queueVersions: new Map(),
				linkWaiters: new Set(),
			};
			this.entries.set(remote.id, created);
			this.emit(created, { type: 'peer.state', peer: summarizePeer(created.state) });
			void this.enqueue(remote.id, () => this.connect(created));
		}
	}

	/**
	 * Whether this service holds a live connection to the peer on `remoteId` right now. The SSH
	 * reachability tracker reads it: a held connection proves the remote is up, so a failed dial
	 * beside it is a transport hiccup, not an outage.
	 */
	isRemoteConnected(remoteId: string): boolean {
		const entry = this.entries.get(remoteId);
		return !!entry && !entry.dropped && entry.state.connection === 'connected';
	}

	/**
	 * What this machine hosts changed (an agent moved to or back from a host, hosted agents switched
	 * on or off): each held forward takes its redial pace again. A host that now runs an agent of
	 * this machine and waits out a slow redial dials at once.
	 */
	noteHostedAgentsChanged(): void {
		for (const entry of this.entries.values()) this.applyRedialPace(entry);
	}

	/** Restart a held forward that is down, skipping its backoff (an explicit act on the peer). */
	private redialNow(entry: PeerEntry): void {
		const lease = entry.connection?.lease;
		const forward = lease?.state().status;
		if (lease && (forward === 'down' || forward === 'stopped')) lease.restart();
	}

	/** The forward's redial ceiling for this peer: slow while nothing here is hosted on it. */
	private applyRedialPace(entry: PeerEntry): void {
		const lease = entry.connection?.lease;
		if (!lease || entry.dropped || !this.deps.hostsAgents) return;
		const idle = !this.deps.hostsAgents(entry.state.peerId);
		lease.setBackoffCeiling?.(idle ? MIRROR_IDLE_REDIAL_MAX_MS : undefined);
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
	 * A mirrored agent's History, newest first: what the host recorded and the shared History of
	 * the agent's project (`client.history.list`). Read once and kept until a turn of the agent
	 * ends or the peer reloads; the History panel pages and filters it (`peer-history.ts`). A peer
	 * that is not attached is an error that names it.
	 */
	async history(peerId: string, agentId: string): Promise<HistoryEntry[]> {
		const { client } = this.historyClient(peerId);
		const key = `${peerId}\u0000${agentId}`;
		const cached = this.historyCache.get(key);
		if (cached) return cached;
		const read = (async () => {
			const listed = await client.history.list(agentId);
			if (!listed.ok) throw new Error(`Peer "${peerId}": ${listed.error.message}`);
			// A turn sent from here carries this machine's name (`originHost`); it reads as local.
			return withOwnHostAsLocal(listed.value, this.deps.originHost ?? os.hostname());
		})();
		this.historyCache.set(key, read);
		// A failed read is not kept: the next open asks again.
		read.catch(() => {
			if (this.historyCache.get(key) === read) this.historyCache.delete(key);
		});
		return read;
	}

	/**
	 * Delete one entry of a mirrored agent's History on its host (the History panel's Delete, the
	 * same edit `history:delete` makes for a local agent). False when the host's own History of
	 * the agent has no such entry. The cached History is dropped either way, so the next page reads
	 * what the host now holds.
	 */
	async historyRemove(peerId: string, agentId: string, entryId: string): Promise<boolean> {
		const { entry, client } = this.historyClient(peerId);
		const result = await client.history.remove(agentId, entryId);
		this.forgetHistory(entry, agentId);
		if (!result.ok) throw new Error(`Peer "${peerId}": ${result.error.message}`);
		return result.value.removed;
	}

	/** Change one entry of a mirrored agent's History on its host (the History panel's Validate). */
	async historyUpdate(
		peerId: string,
		agentId: string,
		entryId: string,
		updates: HistoryEntryUpdates
	): Promise<boolean> {
		const { entry, client } = this.historyClient(peerId);
		const result = await client.history.update(agentId, entryId, updates);
		this.forgetHistory(entry, agentId);
		if (!result.ok) throw new Error(`Peer "${peerId}": ${result.error.message}`);
		return result.value.updated;
	}

	/**
	 * The token usage of `projects` on the host of the remote on `remoteId`, computed there
	 * (`get_project_token_usage`): the Usage Dashboard counts an SSH or hosted agent's
	 * conversations this way. Undefined, never a throw, when the remote has no host attached, the
	 * host is older than the message, or it does not answer within `timeoutMs`: the caller leaves
	 * those agents "not counted".
	 */
	async projectTokenUsage(
		remoteId: string,
		projects: ProjectTokenUsageProject[],
		timeoutMs: number
	): Promise<ProjectTokenUsage | undefined> {
		const entry = this.entries.get(remoteId);
		const usage = entry?.connection?.client.usage;
		if (!entry || entry.dropped || entry.state.connection !== 'connected' || !usage) {
			return undefined;
		}
		const result = await usage.projectTokens(projects, { timeoutMs });
		return result.ok ? result.value : undefined;
	}

	/** The peer's client for a History call. A peer that is not attached is an error that names it. */
	private historyClient(peerId: string): { entry: PeerEntry; client: MaestroClient } {
		const entry = this.entryForPeer(peerId);
		const client = entry.connection?.client;
		if (!client) {
			throw new Error(
				`Peer "${peerId}" is not connected.${entry.state.error ? ` ${entry.state.error}` : ''}`
			);
		}
		return { entry, client };
	}

	/**
	 * Drive a mirrored agent (FED-SSH-06): send, Stop, new tab, rename or star a tab, change the
	 * agent's or a tab's settings, through the
	 * same `runPeerAgentAction()` the CLI's `peer:agent` verbs run. Never queued: a peer that is
	 * reconnecting right now is asked to try at once and waited for, up to
	 * `MIRROR_ACT_RECONNECT_WAIT_MS`; any other peer that is not connected answers an error at once
	 * (`notSent`), and nothing is held for a later reconnect. The host's
	 * own events then update the mirror (a new tab, a rename, the turn's stream).
	 */
	async act(peerId: string, agentId: string, action: PeerAgentAction): Promise<PeerActionAnswer> {
		let entry: PeerEntry;
		try {
			entry = this.entryForPeer(peerId);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		// A send (or any act) on a peer whose forward waits out a backoff: dial now, and start the
		// wait over, as Check Now does. The act itself is not held for it.
		this.redialNow(entry);
		const failure = await this.awaitReconnect(entry);
		const client = entry.connection?.client;
		if (entry.dropped || !client || entry.state.connection !== 'connected') {
			return {
				ok: false,
				code: 'host-unavailable',
				notSent: true,
				error: notConnectedMessage(entry.state, 'Nothing was sent.', failure),
			};
		}
		const agent = entry.state.agents.find((candidate) => candidate.id === agentId);
		if (!agent) {
			return { ok: false, error: `Peer "${peerId}" has no agent ${agentId}.` };
		}
		const result = await runPeerAgentAction(client, agent, action, {
			originHost: this.deps.originHost ?? os.hostname(),
		});
		if (!result.ok) {
			return {
				ok: false,
				error: peerActionErrorMessage(peerId, result.error),
				code: result.error.code,
				...(result.error.unknown ? { unknown: true } : {}),
				...(result.error.appliedFields ? { appliedFields: result.error.appliedFields } : {}),
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
			throw new Error(notConnectedMessage(entry.state, 'Nothing moved.'));
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
		this.redialNow(entry);
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

	/**
	 * Run `task` in the one SSH queue, after every dial queued before it and before any queued after
	 * it, so a call that opens its own ssh (installing or starting a host) never dials beside a probe.
	 */
	exclusive<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task);
		this.queue = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	/** `reconnect()` by SSH remote id: the peer on that remote, probed again now. */
	async reconnectRemote(remoteId: string): Promise<PeerReconnectResult> {
		const entry = this.entries.get(remoteId);
		if (!entry) {
			return { ok: false, error: `SSH remote ${remoteId} is not a Federation peer.` };
		}
		return this.reconnect(entry.state.peerId);
	}

	/** Close every client, drop every forward, forget everything, and tell every window. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.reprobeTimer !== null) {
			clearTimeout(this.reprobeTimer);
			this.reprobeTimer = null;
		}
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
		this.historyCache.clear();
		const entries = [...this.entries.values()];
		this.entries.clear();
		this.pending.clear();
		await Promise.all(entries.map((entry) => this.detach(entry)));
		this.deps.reset();
	}

	// -------------------------------------------------------------------------

	/** Probe again, in the one queue, every remote that answered with no host or was unreachable. */
	private reprobeIdle(): void {
		if (!this.started || this.stopped) return;
		for (const entry of this.entries.values()) {
			const { connection } = entry.state;
			if (entry.connection) continue;
			if (connection === 'connecting' || connection === 'connected') continue;
			void this.enqueue(entry.remote.id, () => this.reload(entry));
		}
	}

	private scheduleReprobe(): void {
		const interval = this.deps.reprobeIntervalMs ?? MIRROR_REPROBE_INTERVAL_MS;
		if (interval <= 0 || this.stopped) return;
		this.reprobeTimer = setTimeout(() => {
			this.reprobeTimer = null;
			this.reprobeIdle();
			this.scheduleReprobe();
		}, interval);
		this.reprobeTimer.unref?.();
	}

	/**
	 * Wait, bounded by `MIRROR_ACT_RECONNECT_WAIT_MS`, for a peer that is connecting or reconnecting
	 * right now, and ask a held client to try at once rather than at its next backoff step. Returns
	 * the reason a reconnect tried here failed (what discovery found), if one did.
	 */
	private async awaitReconnect(entry: PeerEntry): Promise<string | undefined> {
		if (!isLinkInProgress(entry.state.connection) || entry.dropped) return undefined;
		const done = Promise.withResolvers<void>();
		const waiter = () => done.resolve();
		entry.linkWaiters.add(waiter);
		const timer = setTimeout(waiter, MIRROR_ACT_RECONNECT_WAIT_MS);
		timer.unref?.();
		let failure: string | undefined;
		const client = entry.connection?.client;
		const tried = client?.connection.reconnect().then(
			(result) => {
				if (entry.dropped || this.stopped) return;
				if (!result.ok) {
					failure = result.error.message;
				} else if (
					entry.connection?.client === client &&
					client.connection.state() === 'connected'
				) {
					// The client reports `host.connected` itself; make sure the state says so.
					this.commit(entry, setPeerConnection(entry.state, 'connected'));
				}
			},
			(error: unknown) => {
				failure = error instanceof Error ? error.message : String(error);
			}
		);
		try {
			await Promise.race(tried ? [done.promise, tried] : [done.promise]);
		} finally {
			clearTimeout(timer);
			entry.linkWaiters.delete(waiter);
		}
		return failure;
	}

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
		this.applyRedialPace(entry);
		// The client reports `host.connected` from inside `connect()`; make sure the state says so.
		this.commit(entry, setPeerConnection(entry.state, 'connected'));
		// The snapshot that came with the attach carries no queues: read what waits.
		await this.refreshQueues(entry);
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
		await this.refreshQueues(entry);
	}

	/**
	 * Read every agent's host queue and replace what the mirror holds. A read that fails (the host
	 * dropped, the agent went away) leaves that agent's queue as it was: the connection state says
	 * why, and the next attach reads again.
	 */
	private async refreshQueues(entry: PeerEntry): Promise<void> {
		const client = entry.connection?.client;
		if (!client || entry.dropped || this.stopped) return;
		const reads = entry.state.agents.map(async (agent) => {
			const version = entry.queueVersions.get(agent.id) ?? 0;
			const read = await client.turns.queue.list(agent.id);
			return { agentId: agent.id, version, read };
		});
		for (const { agentId, version, read } of await Promise.all(reads)) {
			if (entry.dropped || this.stopped) return;
			if (!read.ok) continue;
			if ((entry.queueVersions.get(agentId) ?? 0) !== version) {
				// A `queue.changed` landed while the read was out: its list is newer than this answer,
				// so keep it. The read still covered a stretch whose named exits this mirror may have
				// missed (a start while the link was down), and that change names only its own exit:
				// commit the kept list as a whole read, so the gap is counted (`queueReads`) here and in
				// every window, and an item last seen waiting is judged by the tab's state (M19). A host
				// that names no exits has no gap to count.
				// The kept list also takes the read's images for an item the change said were unchanged
				// while this mirror held none (M26).
				const held = entry.state.queues[agentId] ?? [];
				const kept = withReadQueueImages(held, read.value);
				if (entry.state.queueExits?.[agentId] || kept !== held) {
					this.commit(entry, setAgentQueue(entry.state, agentId, [...kept]));
				}
				continue;
			}
			this.commit(entry, setAgentQueue(entry.state, agentId, read.value));
		}
	}

	private onEvent(entry: PeerEntry, event: Parameters<typeof applyPeerEvent>[1]): void {
		if (entry.dropped || this.stopped) return;
		if (event.type === 'queue.changed') {
			entry.queueVersions.set(event.agentId, (entry.queueVersions.get(event.agentId) ?? 0) + 1);
		}
		this.commit(entry, applyPeerEvent(entry.state, event, this.ctx));
		// A resync after a connection that could not resume: the queues may have moved meanwhile.
		// The first attach reads them itself, once `connect()` holds the client.
		if (event.type === 'snapshot' && entry.connection) {
			this.refreshQueues(entry).catch((error) =>
				this.deps.onError?.(error, 'federation:queue-refresh')
			);
		}
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
		if (entry.linkWaiters.size > 0 && !isLinkInProgress(entry.state.connection)) {
			for (const waiter of [...entry.linkWaiters]) waiter();
		}
		for (const event of step.push) {
			if (event.type === 'tab.stale') {
				this.forgetTranscript(entry, event.agentId, event.tabId);
				// A turn ended: it wrote a History entry on the host.
				this.forgetHistory(entry, event.agentId);
			} else if (event.type === 'agent.removed') {
				this.forgetHistory(entry, event.agentId);
			} else if (event.type === 'peer.stale' || event.type === 'peer.agents') {
				this.forgetTranscripts(entry);
				this.forgetHistory(entry);
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

	/** Forget one agent's cached History, or every agent's of the peer. */
	private forgetHistory(entry: PeerEntry, agentId?: string): void {
		const prefix = `${entry.state.peerId}\u0000${agentId ?? ''}`;
		for (const key of [...this.historyCache.keys()]) {
			if (agentId !== undefined ? key === prefix : key.startsWith(prefix)) {
				this.historyCache.delete(key);
			}
		}
	}

	/** Stop mirroring one remote: close its client, drop its forward, tell every window. */
	private drop(remoteId: string): void {
		const entry = this.entries.get(remoteId);
		if (!entry) return;
		this.entries.delete(remoteId);
		this.forgetTranscripts(entry);
		this.forgetHistory(entry);
		for (const key of [...this.turnBuffer.keys()]) {
			if (key.startsWith(`${entry.state.peerId}\u0000`)) this.turnBuffer.delete(key);
		}
		this.emit(entry, { type: 'peer.removed' });
		void this.detach(entry);
	}

	private async detach(entry: PeerEntry): Promise<void> {
		entry.dropped = true;
		for (const waiter of [...entry.linkWaiters]) waiter();
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

/** A connect or a reconnect is under way: an action waits for it rather than failing. */
function isLinkInProgress(connection: MirroredPeer['connection']): boolean {
	return connection === 'connecting' || connection === 'reconnecting';
}

/**
 * Why an action on a peer that is not connected was refused. A reconnect still under way says so,
 * never the last discovery's error (it found no host before the host came back); a reconnect tried
 * here that failed gives what it found; otherwise the peer's own state and error.
 */
function notConnectedMessage(peer: MirroredPeer, outcome: string, failure?: string): string {
	if (failure) return `Could not reconnect to peer "${peer.peerId}". ${outcome} ${failure}`;
	if (isLinkInProgress(peer.connection)) {
		return `Still ${peer.connection} to peer "${peer.peerId}". ${outcome}`;
	}
	const reason = peer.error ? ` ${peer.error}` : '';
	return `Not connected to peer "${peer.peerId}" (${peer.connection}). ${outcome}${reason}`;
}
