/**
 * The one adapter from a Federation peer's library records (`AgentRecord`, `AITabRecord`,
 * `LogEntryRecord`, `QueuedTurn`) to the renderer's types (`AITab`, `LogEntry`, `QueuedItem`), used
 * by the host sync (`projectHostedSession()`), plus how a local agent stands with Federation.
 */

import { isSteerBubbleState } from '../../shared/chatSteering';
import type { QueuedTurn } from '../../shared/maestro-lib/client/types';
import type { MirroredPeer } from '../../shared/maestro-lib/client/peer-mirror';
import { readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';
import type { AITabRecord } from '../../shared/maestro-lib/store/records';
import {
	LOG_ENTRY_SOURCES,
	type LogEntryRecord,
	type LogEntrySource,
} from '../../shared/maestro-lib/store/transcript';
import { asThinkingMode, type AgentError, type UsageStats } from '../../shared/types';
import type { AITab, LogEntry, QueuedItem } from '../types';

const KNOWN_SOURCES = new Set<string>(LOG_ENTRY_SOURCES);

/**
 * A host entry's structured error, read off the wire: the fields the error card and the error
 * banner draw. Anything else (a malformed value from a newer or older host) is dropped, and the
 * entry draws as plain error text.
 */
function mirrorAgentError(value: unknown): AgentError | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	const error = value as Record<string, unknown>;
	if (
		typeof error.type !== 'string' ||
		typeof error.message !== 'string' ||
		typeof error.recoverable !== 'boolean' ||
		typeof error.agentId !== 'string' ||
		typeof error.timestamp !== 'number'
	) {
		return undefined;
	}
	return value as AgentError;
}
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
	// A message the host steered into its running turn wears the same header as a local one.
	if (record.steered === true) entry.steered = true;
	// What the agent did with it: a `queued` steer ran as a turn of its own, and is drawn so.
	if (record.steered === true && isSteerBubbleState(record.steerState)) {
		entry.steerState = record.steerState;
	}
	// The host's queue item this message ran from: a queued consult or hand-off finds its own turn
	// by it (`crossAgentHandoff.ts`).
	if (typeof record.queuedItemId === 'string' && record.queuedItemId) {
		entry.queuedItemId = record.queuedItemId;
	}
	if (record.aiCommand) entry.aiCommand = record.aiCommand;
	if (record.turnModel) entry.turnModel = record.turnModel;
	if (record.turnEffort) entry.turnEffort = record.turnEffort;
	// The host's "Session not found" entry draws the same recovery card here; recovering runs
	// from this tab and re-sends to the host (`useSessionRecovery`).
	const recovery = record.recoveryAction;
	if (
		recovery &&
		typeof recovery.lastUserPrompt === 'string' &&
		typeof recovery.tabId === 'string' &&
		recovery.tabId
	) {
		entry.recoveryAction = { lastUserPrompt: recovery.lastUserPrompt, tabId: recovery.tabId };
	}
	// The host's error card draws as a local one: its message, and View Details when the error
	// carries the provider's raw output.
	const agentError = mirrorAgentError(record.agentError);
	if (agentError) entry.agentError = agentError;
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

/** A token count off the wire: a finite, non-negative number, or nothing. */
function tokenCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const USAGE_TOKEN_FIELDS = [
	'inputTokens',
	'outputTokens',
	'cacheReadInputTokens',
	'cacheCreationInputTokens',
] as const;

/**
 * A host tab's token usage, read off the wire: the fields the header's context gauge, cost pill,
 * and usage tooltip read (`useContextWindow()`, `MainPanelHeader`). A value with no valid token
 * counts (a malformed record from a newer or older host) is dropped, and the tab shows no gauge,
 * as a local tab before its first turn does. The host's accounting detail stays on the host.
 */
export function mirrorUsageStats(value: unknown): UsageStats | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const counts: Partial<Record<(typeof USAGE_TOKEN_FIELDS)[number], number>> = {};
	for (const field of USAGE_TOKEN_FIELDS) {
		const count = tokenCount(raw[field]);
		if (count === undefined) return undefined;
		counts[field] = count;
	}
	const usage: UsageStats = {
		inputTokens: counts.inputTokens ?? 0,
		outputTokens: counts.outputTokens ?? 0,
		cacheReadInputTokens: counts.cacheReadInputTokens ?? 0,
		cacheCreationInputTokens: counts.cacheCreationInputTokens ?? 0,
		totalCostUsd: tokenCount(raw.totalCostUsd) ?? 0,
		contextWindow: tokenCount(raw.contextWindow) ?? 0,
	};
	if (raw.contextWindowResolved === true) usage.contextWindowResolved = true;
	if (typeof raw.contextWindowModel === 'string' && raw.contextWindowModel) {
		usage.contextWindowModel = raw.contextWindowModel.slice(0, 200);
	}
	const reasoning = tokenCount(raw.reasoningTokens);
	if (reasoning !== undefined) usage.reasoningTokens = reasoning;
	const absolute = raw.absoluteUsage;
	if (typeof absolute === 'object' && absolute !== null && !Array.isArray(absolute)) {
		const snap = absolute as Record<string, unknown>;
		const fields = [...USAGE_TOKEN_FIELDS, 'reasoningTokens'].map((field) =>
			tokenCount(snap[field])
		);
		if (fields.every((count) => count !== undefined)) {
			const [
				inputTokens,
				outputTokens,
				cacheReadInputTokens,
				cacheCreationInputTokens,
				reasoningTokens,
			] = fields as number[];
			usage.absoluteUsage = {
				inputTokens,
				outputTokens,
				cacheReadInputTokens,
				cacheCreationInputTokens,
				reasoningTokens,
			};
		}
	}
	return usage;
}

/**
 * A host tab as the tab strip and composer draw it: name, star, busy state, and the composer
 * settings the host's tab holds (Save to History, thinking, read-only, model, effort), so its pills
 * show what the host will run, and its token usage, so the header's context gauge and cost pill read
 * what a local tab's do; no transcript, no draft.
 */
export function mirrorTab(record: AITabRecord): AITab {
	const thinking = asThinkingMode(record.showThinking);
	const usageStats = mirrorUsageStats(record.usageStats);
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
		...(typeof record.saveToHistory === 'boolean' ? { saveToHistory: record.saveToHistory } : {}),
		...(thinking ? { showThinking: thinking } : {}),
		...(typeof record.readOnlyMode === 'boolean' ? { readOnlyMode: record.readOnlyMode } : {}),
		...(record.customModel ? { customModel: record.customModel } : {}),
		...(record.customEffort ? { customEffort: record.customEffort } : {}),
		...(usageStats ? { usageStats } : {}),
	};
}

/**
 * One message waiting in the host's queue as the queued cards draw it, in the shape a local item
 * of the same kind has: a desktop host's slash command is a command card (its command line split
 * into the command and its arguments), and the model, effort, and images it was queued with ride
 * along, so the card and its editor show what the host will run.
 */
export function mirrorQueuedItem(item: QueuedTurn): QueuedItem {
	const base = {
		id: item.itemId,
		timestamp: item.queuedAt,
		tabId: item.tabId,
		...(item.paused ? { paused: true } : {}),
		...(item.turnSettings ? { turnSettings: item.turnSettings } : {}),
		...(item.images?.length ? { images: [...item.images] } : {}),
		// Images an older desktop host said were unchanged before this window held them (M28).
		...(item.imagesKept && !item.images?.length ? { hostImagesPending: true } : {}),
	};
	if (item.kind === 'command') {
		const line = item.text.trim();
		const space = line.search(/\s/);
		return {
			...base,
			type: 'command',
			command: space === -1 ? line : line.slice(0, space),
			commandArgs: space === -1 ? '' : line.slice(space + 1).trim(),
		};
	}
	return { ...base, type: 'message', text: item.text };
}

/**
 * Whether a peer has a Maestro host to show. Federation probes every SSH remote that has not opted
 * out, so most probes find no host (`not-installed`, `host-down`): those remotes stay plain SSH
 * remotes, out of the palette's Reconnect entries and Add Hosted Agent. A peer that is connected,
 * reconnecting, or was synced once (its last known state, while it is away) counts.
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

/** The slice of a local agent "Move to Host" and its pointer read. */
export interface LiftableAgent {
	liftedTo?: unknown;
	sessionSshRemoteConfig?: { enabled: boolean; remoteId: string | null };
}

/**
 * How a local agent stands with Federation, for its Left Bar badge and its Move to Host action:
 * - `local`: not an SSH agent.
 * - `moved`: a hosted agent (lifted from here, or added from the host's roster); the row is a
 *   pointer. `peerId` and `agentId` name it; `peer` is its mirror entry while the mirror has one.
 * - `ssh`: an SSH agent this Maestro drives over SSH. `peer` is its remote's mirror entry (absent
 *   when the remote opted out or is disabled, so it cannot move); `hostReady` when that peer is
 *   connected right now, so Move to Host moves it without setting a host up first.
 */
export type AgentFederationStatus =
	| { kind: 'local' }
	| { kind: 'moved'; peerId: string; agentId: string; peer?: FederationStatusPeer }
	| { kind: 'ssh'; remoteId: string; peer?: FederationStatusPeer; hostReady: boolean };

/**
 * The part of a mirror entry a Federation status names: what the mode pill and Move to Host read.
 * Not the agents, queues, or live turns, which change on every frame of a hosted turn: a status
 * that held them would draw every mode pill again per frame with nothing on screen changed (L36).
 */
export type FederationStatusPeer = Pick<
	MirroredPeer,
	'peerId' | 'remoteId' | 'name' | 'connection' | 'error'
>;

function statusPeer(peer: MirroredPeer): FederationStatusPeer {
	return {
		peerId: peer.peerId,
		remoteId: peer.remoteId,
		name: peer.name,
		connection: peer.connection,
		...(peer.error !== undefined ? { error: peer.error } : {}),
	};
}

function sameStatusPeer(a?: FederationStatusPeer, b?: FederationStatusPeer): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.peerId === b.peerId &&
		a.remoteId === b.remoteId &&
		a.name === b.name &&
		a.connection === b.connection &&
		a.error === b.error
	);
}

/** Whether two statuses draw the same: the equality a status subscription re-renders on. */
export function sameFederationStatus(a: AgentFederationStatus, b: AgentFederationStatus): boolean {
	if (a === b) return true;
	switch (a.kind) {
		case 'local':
			return b.kind === 'local';
		case 'moved':
			return (
				b.kind === 'moved' &&
				a.peerId === b.peerId &&
				a.agentId === b.agentId &&
				sameStatusPeer(a.peer, b.peer)
			);
		case 'ssh':
			return (
				b.kind === 'ssh' &&
				a.remoteId === b.remoteId &&
				a.hostReady === b.hostReady &&
				sameStatusPeer(a.peer, b.peer)
			);
	}
}

export function agentFederationStatus(
	agent: LiftableAgent,
	peers: readonly MirroredPeer[]
): AgentFederationStatus {
	const pointer = readLiftedTo(agent.liftedTo);
	if (pointer) {
		const peer = peers.find((candidate) => candidate.peerId === pointer.peer);
		return {
			kind: 'moved',
			peerId: pointer.peer,
			agentId: pointer.agentId,
			...(peer ? { peer: statusPeer(peer) } : {}),
		};
	}
	const ssh = agent.sessionSshRemoteConfig;
	if (!ssh?.enabled || !ssh.remoteId) return { kind: 'local' };
	const peer = peers.find((candidate) => candidate.remoteId === ssh.remoteId);
	return {
		kind: 'ssh',
		remoteId: ssh.remoteId,
		...(peer ? { peer: statusPeer(peer) } : {}),
		hostReady: peer?.connection === 'connected',
	};
}

/**
 * Whether Move to Host is offered: an SSH agent whose remote takes part in Federation. With no host
 * there yet, the same action sets one up first (`hostReady` false).
 */
export function canMoveToHost(
	status: AgentFederationStatus
): status is Extract<AgentFederationStatus, { kind: 'ssh' }> & { peer: FederationStatusPeer } {
	return status.kind === 'ssh' && status.peer !== undefined;
}
