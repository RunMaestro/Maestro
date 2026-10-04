/**
 * A tab's transcript, as it sits in `maestro-sessions.json`.
 *
 * Transcripts have no file of their own: each AI tab carries its entries in
 * `logs`, and the desktop persists the whole tab. So a transcript is read
 * through the sessions document (`readSessionsStore`), and this module only
 * names the entry shape and finds one tab's entries in it.
 *
 * `LogEntryRecord` is the ON-DISK entry (gap L11: one transcript entry model
 * every surface shares, so each renders what the others wrote). The renderer's
 * `LogEntry` (`src/renderer/types/index.ts`) is the in-memory shape and takes
 * its `source` union from here, so the two cannot disagree about what kinds of
 * entry exist. Like the other records, only the fields a client reads are
 * named; every other key - card payloads such as `shellCommand`, `delegation`,
 * `snoozeReturn`, or a field from a newer build - stays on the object.
 *
 * Pure: no file access. Safe to import from the renderer.
 */

import type { AgentRecord, AITabRecord, SessionsDocument, UnknownFields } from './records';
import { agentsOf, aiTabsOf } from './read-stores';

/** Every kind of transcript entry, in no particular order. */
export const LOG_ENTRY_SOURCES = [
	'stdout',
	'stderr',
	'system',
	'user',
	'ai',
	'error',
	'thinking',
	'tool',
] as const;

/** Who or what produced a transcript entry. */
export type LogEntrySource = (typeof LOG_ENTRY_SOURCES)[number];

/** A tool call's progress, carried on `source: 'tool'` entries. */
export interface LogEntryToolState extends UnknownFields {
	status?: 'running' | 'completed' | 'error' | 'failed';
	input?: unknown;
	output?: unknown;
}

/** One transcript entry, mirroring the persisted fields of the renderer's `LogEntry`. */
export interface LogEntryRecord extends UnknownFields {
	id: string;
	timestamp: number;
	/** Kept as a string: an entry kind from a newer build is still shown, as text. */
	source: LogEntrySource | (string & {});
	text: string;
	/** Image references (`maestro-image://store/...`) or data URLs. */
	images?: string[];
	/** User messages: false while the agent has not accepted the message. */
	delivered?: boolean;
	readOnly?: boolean;
	/** A custom AI command (`/commit`) this user message invoked. */
	aiCommand?: { command: string; description: string };
	metadata?: UnknownFields & {
		toolState?: LogEntryToolState;
		/** Claude subagent nesting: the parent tool call's id. */
		parentToolUseId?: string;
	};
	/** The model and effort the turn ran under; absent means the agent default. */
	turnModel?: string;
	turnEffort?: string;
}

function isLogEntryRecord(value: unknown): value is LogEntryRecord {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.id === 'string' &&
		typeof entry.timestamp === 'number' &&
		typeof entry.source === 'string' &&
		typeof entry.text === 'string'
	);
}

/**
 * A tab's transcript entries, oldest first (stored order). An entry missing
 * the four fields every surface needs to draw it is skipped here and left in
 * the document untouched; the returned entries are the original objects.
 */
export function transcriptOf(tab: AITabRecord): LogEntryRecord[] {
	if (!Array.isArray(tab.logs)) return [];
	return tab.logs.filter(isLogEntryRecord);
}

/** The outcome of looking up one tab's transcript. */
export type TabTranscriptResult =
	| { status: 'ok'; agent: AgentRecord; tab: AITabRecord; entries: LogEntryRecord[] }
	| { status: 'agent-not-found'; agentId: string }
	| { status: 'tab-not-found'; agent: AgentRecord; tabId: string };

/**
 * Find one tab's transcript in a sessions document. A hidden consult tab is a
 * real tab with a real transcript, so it is found like any other.
 */
export function findTabTranscript(
	document: SessionsDocument,
	agentId: string,
	tabId: string
): TabTranscriptResult {
	const agent = agentsOf(document).find((candidate) => candidate.id === agentId);
	if (!agent) return { status: 'agent-not-found', agentId };
	const tab = aiTabsOf(agent).find((candidate) => candidate.id === tabId);
	if (!tab) return { status: 'tab-not-found', agent, tabId };
	return { status: 'ok', agent, tab, entries: transcriptOf(tab) };
}
