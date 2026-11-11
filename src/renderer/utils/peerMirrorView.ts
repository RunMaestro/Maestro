/**
 * The one adapter from a Federation peer's library records (`AgentRecord`, `AITabRecord`,
 * `LogEntryRecord`, `QueuedTurn`) to the view types the transcript, the queued cards, the tab strip,
 * and the Thinking pill render (`TranscriptViewSession`, `QueuedItem`, `AITab`, `LogEntry`,
 * `ThinkingItem`).
 *
 * What it builds is a VIEW object for props, never a `Session`: it is not in `sessionStore`, and
 * the narrowed `TranscriptViewSession` type proves no local-agent field slips in. Fields that would
 * point a local action at the host's data (a cross-agent jump to a host session id, a recovery
 * action, pins, an agent error to retry) are not copied, so nothing in the view can act on them.
 */

import { liveTurnKey, type LiveTurn } from '../../shared/maestro-lib/client/live-turn';
import type { QueuedTurn } from '../../shared/maestro-lib/client/types';
import type {
	MirroredPeer,
	PeerMirrorConnection,
} from '../../shared/maestro-lib/client/peer-mirror';
import { mirrorKey } from '../../shared/maestro-lib/client/peer-mirror';
import { readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';
import type { AgentRecord, AITabRecord } from '../../shared/maestro-lib/store/records';
import {
	LOG_ENTRY_SOURCES,
	type LogEntryRecord,
	type LogEntrySource,
} from '../../shared/maestro-lib/store/transcript';
import type {
	AITab,
	LogEntry,
	QueuedItem,
	SessionState,
	ThinkingItem,
	ThinkingItemAgent,
	ToolType,
} from '../types';
import type { TranscriptViewSession } from '../components/TerminalOutput/types';

const KNOWN_SOURCES = new Set<string>(LOG_ENTRY_SOURCES);
const TOOL_STATUSES = new Set(['running', 'completed', 'error', 'failed']);

/** One host transcript entry as the renderer draws it. An unknown kind shows as a system line. */
export function mirrorLogEntry(record: LogEntryRecord): LogEntry {
	const entry: LogEntry = {
		id: record.id,
		timestamp: record.timestamp,
		source: KNOWN_SOURCES.has(record.source) ? (record.source as LogEntrySource) : 'system',
		text: record.text,
	};
	if (record.images?.length) entry.images = record.images;
	if (record.delivered !== undefined) entry.delivered = record.delivered;
	if (record.readOnly !== undefined) entry.readOnly = record.readOnly;
	if (record.aiCommand) entry.aiCommand = record.aiCommand;
	if (record.turnModel) entry.turnModel = record.turnModel;
	if (record.turnEffort) entry.turnEffort = record.turnEffort;
	const toolState = record.metadata?.toolState;
	const parentToolUseId = record.metadata?.parentToolUseId;
	if (toolState || parentToolUseId) {
		entry.metadata = {};
		if (toolState) {
			entry.metadata.toolState = {
				...(toolState.status && TOOL_STATUSES.has(toolState.status)
					? { status: toolState.status }
					: {}),
				input: toolState.input,
				output: toolState.output,
			};
		}
		if (parentToolUseId) entry.metadata.parentToolUseId = parentToolUseId;
	}
	return entry;
}

/** A host tab as the tab strip draws it: name, star, and busy state; no transcript, no draft. */
export function mirrorTab(record: AITabRecord): AITab {
	return {
		id: record.id,
		agentSessionId: record.agentSessionId ?? null,
		name: record.name ?? null,
		starred: record.starred === true,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: record.createdAt ?? 0,
		state: record.state === 'busy' ? 'busy' : 'idle',
		// The host's own start of the running turn, so the elapsed time survives a lid close.
		...(record.state === 'busy' && record.thinkingStartTime !== undefined
			? { thinkingStartTime: record.thinkingStartTime }
			: {}),
		...(record.hidden ? { hidden: true } : {}),
	};
}

/**
 * One message waiting in the host's queue as the queued cards draw it. A command is drawn as the
 * text the host holds for it: the host takes plain messages only, so it has no command metadata.
 */
export function mirrorQueuedItem(item: QueuedTurn): QueuedItem {
	return {
		id: item.itemId,
		timestamp: item.queuedAt,
		tabId: item.tabId,
		type: 'message',
		text: item.text,
		...(item.paused ? { paused: true } : {}),
	};
}

/** The tabs the strip draws for a mirrored agent (hidden consult tabs have no chip). */
export function mirrorTabs(agent: AgentRecord): AITab[] {
	return (agent.aiTabs ?? []).filter((tab) => !tab.hidden).map(mirrorTab);
}

/**
 * The tab to show: the one the user picked in this window, else the host's active tab, else the
 * first. Undefined when the agent has no visible tab.
 */
export function resolveMirrorTabId(agent: AgentRecord, preferred?: string): string | undefined {
	const visible = (agent.aiTabs ?? []).filter((tab) => !tab.hidden);
	if (preferred && visible.some((tab) => tab.id === preferred)) return preferred;
	if (agent.activeTabId && visible.some((tab) => tab.id === agent.activeTabId)) {
		return agent.activeTabId;
	}
	return visible[0]?.id;
}

/** What a mirrored tab shows: the host's persisted transcript, then the live tail of a turn. */
export function mirrorTabEntries(
	persisted: readonly LogEntryRecord[],
	liveTurn: LiveTurn | undefined,
	carryover?: readonly LogEntryRecord[]
): LogEntry[] {
	const tail = liveTurn?.entries ?? carryover ?? [];
	const seen = new Set(persisted.map((entry) => entry.id));
	const entries = persisted.map(mirrorLogEntry);
	// A re-read can already hold an entry the live turn showed (the user message): draw it once.
	for (const record of tail) if (!seen.has(record.id)) entries.push(mirrorLogEntry(record));
	return entries;
}

/**
 * The view object `TerminalOutput` renders for one mirrored tab. Its id is the mirror key, which
 * no local store knows, so any store lookup by it finds nothing.
 */
export function buildMirrorViewSession(input: {
	peerId: string;
	agent: AgentRecord;
	tabId: string;
	entries: LogEntry[];
	/** What waits in the agent's host queue (`MirroredPeer.queues`). */
	queue?: readonly QueuedTurn[];
}): TranscriptViewSession {
	const { peerId, agent, tabId, entries, queue } = input;
	const tabs = (agent.aiTabs ?? []).map(mirrorTab);
	return {
		id: mirrorKey(peerId, agent.id),
		activeTabId: tabId,
		aiTabs: tabs.map((tab) => (tab.id === tabId ? { ...tab, logs: entries } : tab)),
		inputMode: 'ai',
		toolType: agent.toolType as ToolType,
		cwd: agent.cwd ?? '',
		executionQueue: (queue ?? []).map(mirrorQueuedItem),
		deferredContent: undefined,
		// The host runs the agent; this desktop has no path or remote of its own for it.
		sessionSshRemoteConfig: undefined,
	};
}

/**
 * The Thinking pill's entries for every connected peer: one per visible tab the host reports busy,
 * the same rule `buildThinkingItems()` applies to a local agent. Each carries `mirror`, so a click
 * opens the mirrored agent and Stop reaches its host. A peer that is not connected shows nothing:
 * its last known state may be long over, and a Stop there could not reach it.
 */
export function buildMirrorThinkingItems(
	peers: Readonly<Record<string, MirroredPeer>>,
	order: readonly string[]
): ThinkingItem[] {
	const items: ThinkingItem[] = [];
	for (const peerId of order) {
		const peer = peers[peerId];
		if (!peer || peer.connection !== 'connected') continue;
		for (const agent of peer.agents) {
			const busyTabs = (agent.aiTabs ?? []).filter((tab) => !tab.hidden && tab.state === 'busy');
			if (busyTabs.length === 0) continue;
			const session: ThinkingItemAgent = {
				id: mirrorKey(peerId, agent.id),
				name: `${agent.name} on ${peer.name}`,
				state: 'busy',
			};
			for (const record of busyTabs) {
				const tab = mirrorTab(record);
				// The host sent no start time (the client learned of the turn from its stream): use
				// the first event this desktop saw.
				if (tab.thinkingStartTime === undefined) {
					const startedAt = peer.liveTurns[liveTurnKey(agent.id, record.id)]?.startedAt;
					if (startedAt !== undefined) tab.thinkingStartTime = startedAt;
				}
				items.push({ session, tab, mirror: { peerId, agentId: agent.id } });
			}
		}
	}
	return items;
}

/** The agent dot: the host's state, yellow while any of its tabs is busy. */
export function mirroredAgentState(agent: AgentRecord): SessionState {
	if ((agent.aiTabs ?? []).some((tab) => tab.state === 'busy')) return 'busy';
	return agent.state ?? 'idle';
}

/** The agent state whose color a peer's connection dot borrows, so it reads like an agent dot. */
export function peerConnectionDotState(connection: PeerMirrorConnection): SessionState {
	switch (connection) {
		case 'connected':
			return 'idle';
		case 'connecting':
		case 'reconnecting':
			return 'connecting';
		default:
			return 'error';
	}
}

/** Whether a peer's agents are the last known state rather than live. */
export function isPeerDisconnected(peer: Pick<MirroredPeer, 'connection'>): boolean {
	return peer.connection !== 'connected' && peer.connection !== 'connecting';
}

/**
 * Whether a peer has a Maestro host to show. Federation probes every SSH remote that has not opted
 * out, so most probes find no host (`not-installed`, `host-down`): those remotes stay plain SSH
 * remotes and out of the Left Bar. A peer that is connected, reconnecting, or was synced once
 * (shown dimmed while it is away) counts.
 */
export function isPeerFederated(
	peer: Pick<MirroredPeer, 'connection' | 'agents' | 'lastSyncAt'>
): boolean {
	return (
		peer.connection === 'connected' ||
		peer.connection === 'reconnecting' ||
		peer.lastSyncAt !== undefined ||
		peer.agents.length > 0
	);
}

/** A tooltip line for a peer's connection. */
export function peerConnectionLabel(peer: Pick<MirroredPeer, 'connection' | 'error'>): string {
	switch (peer.connection) {
		case 'connected':
			return 'Connected';
		case 'connecting':
			return 'Connecting';
		case 'reconnecting':
			return 'Reconnecting';
		case 'lost':
			return peer.error ? `Disconnected: ${peer.error}` : 'Disconnected';
		default:
			return peer.error ?? 'Not connected';
	}
}

/**
 * Why a mirrored agent's composer offers a control a local one has, but greys it out. The host
 * serves a plain message (`enqueue_command`) and nothing else: no slash commands (they run in the
 * local renderer), no shell command mode (it runs on THIS machine), and no images (FED-SSH-06
 * sends text only).
 */
export const MIRROR_COMPOSER_UNAVAILABLE = {
	slashCommands:
		"Slash commands are not available for a peer's agent: they run in this window, and the host receives only plain messages.",
	shellMode:
		"Shell command mode is not available for a peer's agent: it would run the command on this machine, not on the host.",
	images: "Images are not available for a peer's agent yet: the host receives text only.",
} as const;

/** A leading `/command` (not a path such as `/Users/me`), the way a local slash command starts. */
const SLASH_COMMAND_PATTERN = /^\/[A-Za-z][\w:-]*(?:\s|$)/;

/**
 * Why `text` cannot be sent to a mirrored agent as it stands, or undefined when it can. Only a
 * slash command is refused: sent as text it would reach the host's provider, not run here.
 */
export function mirrorSendBlockReason(text: string): string | undefined {
	return SLASH_COMMAND_PATTERN.test(text.trimStart())
		? MIRROR_COMPOSER_UNAVAILABLE.slashCommands
		: undefined;
}

/** The slice of a local agent "Move to Host" and its pointer read. */
export interface LiftableAgent {
	liftedTo?: unknown;
	sessionSshRemoteConfig?: { enabled: boolean; remoteId: string | null };
}

/**
 * The mirrored peer "Move to Host" lifts `agent` onto, or undefined when the action is not offered:
 * the agent already moved, it is not an SSH remote agent, or its remote is not a Federation peer
 * with a running host the mirror is connected to right now. The main-process lift checks the
 * same rules again (`runLift()`); this one only decides whether to offer the action.
 */
export function moveToHostPeer(
	agent: LiftableAgent,
	peers: readonly MirroredPeer[]
): MirroredPeer | undefined {
	if (readLiftedTo(agent.liftedTo)) return undefined;
	const ssh = agent.sessionSshRemoteConfig;
	if (!ssh?.enabled || !ssh.remoteId) return undefined;
	return peers.find((peer) => peer.remoteId === ssh.remoteId && peer.connection === 'connected');
}

/**
 * How a local agent stands with Federation, for its Left Bar badge and its Make Federated / Move to
 * Host actions:
 * - `local`: not an SSH agent.
 * - `moved`: lifted onto a host already; the row is a pointer.
 * - `ssh`: an SSH agent this Maestro drives over SSH. `peer` is its remote's mirror entry (absent
 *   when the remote opted out or is disabled, so it cannot federate); `hostReady` when that peer is
 *   connected right now, so Move to Host can run without setting anything up.
 */
export type AgentFederationStatus =
	| { kind: 'local' }
	| { kind: 'moved' }
	| { kind: 'ssh'; remoteId: string; peer?: MirroredPeer; hostReady: boolean };

export function agentFederationStatus(
	agent: LiftableAgent,
	peers: readonly MirroredPeer[]
): AgentFederationStatus {
	if (readLiftedTo(agent.liftedTo)) return { kind: 'moved' };
	const ssh = agent.sessionSshRemoteConfig;
	if (!ssh?.enabled || !ssh.remoteId) return { kind: 'local' };
	const peer = peers.find((candidate) => candidate.remoteId === ssh.remoteId);
	return {
		kind: 'ssh',
		remoteId: ssh.remoteId,
		...(peer ? { peer } : {}),
		hostReady: peer?.connection === 'connected',
	};
}

/** Whether Make Federated is offered: an SSH agent whose remote takes part but runs no host now. */
export function canMakeFederated(status: AgentFederationStatus): boolean {
	return status.kind === 'ssh' && status.peer !== undefined && !status.hostReady;
}

/** Where a lifted agent's pointer leads, and whether the mirror holds that agent right now. */
export interface LiftedMirrorTarget {
	peerId: string;
	agentId: string;
	/** `peer:agentId`, the address maestro-cli takes. */
	ref: string;
	/** The mirror shows this peer's agent, so a click can open it. */
	mirrored: boolean;
}

/** The pointer of a lifted agent as the Left Bar shows it, or undefined for one that never moved. */
export function liftedMirrorTarget(
	agent: Pick<LiftableAgent, 'liftedTo'>,
	peers: Readonly<Record<string, MirroredPeer>>
): LiftedMirrorTarget | undefined {
	const pointer = readLiftedTo(agent.liftedTo);
	if (!pointer) return undefined;
	const peer = peers[pointer.peer];
	return {
		peerId: pointer.peer,
		agentId: pointer.agentId,
		ref: mirrorKey(pointer.peer, pointer.agentId),
		mirrored: Boolean(peer?.agents.some((candidate) => candidate.id === pointer.agentId)),
	};
}
