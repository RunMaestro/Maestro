/**
 * The one adapter from a Federation peer's library records (`AgentRecord`, `AITabRecord`,
 * `LogEntryRecord`, `QueuedTurn`) to the renderer's types (`AITab`, `LogEntry`, `QueuedItem`), used
 * by the host sync (`projectHostedSession()`), plus how a local agent stands with Federation.
 */

import type { QueuedTurn } from '../../shared/maestro-lib/client/types';
import type { MirroredPeer } from '../../shared/maestro-lib/client/peer-mirror';
import { readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';
import type { AITabRecord } from '../../shared/maestro-lib/store/records';
import {
	LOG_ENTRY_SOURCES,
	type LogEntryRecord,
	type LogEntrySource,
} from '../../shared/maestro-lib/store/transcript';
import type { AITab, LogEntry, QueuedItem } from '../types';

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
 * One message waiting in the host's queue as the queued cards draw it, in the shape a local item
 * of the same kind has: a desktop host's slash command is a command card (its command line split
 * into the command and its arguments), and the model and effort it was queued with ride along,
 * so the card and its editor show what the host will run.
 */
export function mirrorQueuedItem(item: QueuedTurn): QueuedItem {
	const base = {
		id: item.itemId,
		timestamp: item.queuedAt,
		tabId: item.tabId,
		...(item.paused ? { paused: true } : {}),
		...(item.turnSettings ? { turnSettings: item.turnSettings } : {}),
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
	| { kind: 'moved'; peerId: string; agentId: string; peer?: MirroredPeer }
	| { kind: 'ssh'; remoteId: string; peer?: MirroredPeer; hostReady: boolean };

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
			...(peer ? { peer } : {}),
		};
	}
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

/**
 * Whether Move to Host is offered: an SSH agent whose remote takes part in Federation. With no host
 * there yet, the same action sets one up first (`hostReady` false).
 */
export function canMoveToHost(
	status: AgentFederationStatus
): status is Extract<AgentFederationStatus, { kind: 'ssh' }> & { peer: MirroredPeer } {
	return status.kind === 'ssh' && status.peer !== undefined;
}
