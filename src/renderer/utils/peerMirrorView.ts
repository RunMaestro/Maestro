/**
 * The one adapter from a Federation peer's library records (`AgentRecord`, `AITabRecord`,
 * `LogEntryRecord`) to the view types the transcript and tab strip render (`TranscriptViewSession`,
 * `AITab`, `LogEntry`).
 *
 * What it builds is a VIEW object for props, never a `Session`: it is not in `sessionStore`, and
 * the narrowed `TranscriptViewSession` type proves no local-agent field slips in. Fields that would
 * point a local action at the host's data (a cross-agent jump to a host session id, a recovery
 * action, pins, an agent error to retry) are not copied, so nothing in the view can act on them.
 */

import type { LiveTurn } from '../../shared/maestro-lib/client/live-turn';
import type {
	MirroredPeer,
	PeerMirrorConnection,
} from '../../shared/maestro-lib/client/peer-mirror';
import { mirrorKey } from '../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord, AITabRecord } from '../../shared/maestro-lib/store/records';
import {
	LOG_ENTRY_SOURCES,
	type LogEntryRecord,
	type LogEntrySource,
} from '../../shared/maestro-lib/store/transcript';
import type { AITab, LogEntry, SessionState, ToolType } from '../types';
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
		...(record.hidden ? { hidden: true } : {}),
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
}): TranscriptViewSession {
	const { peerId, agent, tabId, entries } = input;
	const tabs = (agent.aiTabs ?? []).map(mirrorTab);
	return {
		id: mirrorKey(peerId, agent.id),
		activeTabId: tabId,
		aiTabs: tabs.map((tab) => (tab.id === tabId ? { ...tab, logs: entries } : tab)),
		inputMode: 'ai',
		toolType: agent.toolType as ToolType,
		cwd: agent.cwd ?? '',
		executionQueue: [],
		deferredContent: undefined,
		// The host runs the agent; this desktop has no path or remote of its own for it.
		sessionSshRemoteConfig: undefined,
	};
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
