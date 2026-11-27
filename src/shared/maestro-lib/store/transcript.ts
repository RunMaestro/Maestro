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

import type { SteerBubbleState } from '../../chatSteering';
import type { AgentError } from '../../types';
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

/**
 * The `system` note a turn the person stopped ends on. One string for every mode: the desktop
 * writes it when Stop ends a local or SSH turn (`turnInterrupt.ts`), and a host writes it into the
 * transcript of an interrupted turn (`buildTurnTranscript()`), so a hosted tab reads the same.
 */
export const TURN_CANCELED_NOTE = 'Canceled by user';

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
	/** A user message steered into the turn already running (`SteeredMessageHeader`). */
	steered?: boolean;
	/**
	 * A steered message: what the agent did with it. `queued`: it could not fold it in and ran it
	 * as a turn of its own after the one it was steered into (`isUserTurnStart()`); `absorbed`: it
	 * took it into that turn; `pending`: no verdict yet. Absent on a steer written before the state
	 * was recorded, read as joining the turn.
	 */
	steerState?: SteerBubbleState;
	/**
	 * A user message: the id of the queue item it ran from, on the host that ran it. A client that
	 * queued the message knows that id from the host's receipt, so it finds this entry by identity,
	 * never by text or position (two messages with the same text, or an image-only message).
	 */
	queuedItemId?: string;
	/**
	 * The turn this entry belongs to ended here (answered, on its own error, or stopped): stamped by
	 * the host on the turn's last entry when the turn ends (`markTurnEnded()`). A turn with no stamp
	 * on a host that stamps did not end: it runs, or died with its host (`turnFateAfter()`).
	 */
	turnEnded?: boolean;
	/**
	 * On a user message: when its turn's latest attempt ended with nothing of its own that stays
	 * (a retry into the same entry that answered empty), epoch ms (`markTurnEnded()`).
	 */
	turnEndedAt?: number;
	/**
	 * On a queued steer (`steerState: 'queued'`): its own follow-up turn ended with nothing of its
	 * own that stays, so the end went on the steer (`markTurnEnded()`). Its `turnEnded` may also be
	 * the end of the turn it was steered into; this tells the reader the steer's own turn ended too.
	 */
	steerTurnEnded?: boolean;
	/**
	 * A desktop's Agent Resilience card: the turn's error was taken over by that desktop's own
	 * automatic retry, and this is the id of its outage (`RetryStatusCard`). A Federation client
	 * reading a hosted tab tells from it that the host retries the message itself (`hostRetriesTurn()`).
	 */
	retryOutageId?: string;
	/**
	 * The retry card's outage was stopped by the user (its Stop): the retry no longer holds the
	 * message, which waits paused. `hostRetriesTurn()` reads a stopped card as no retry (R45).
	 */
	retryStopped?: boolean;
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
	/**
	 * A "Session not found" entry's recovery card: the prompt that hit the dead session and the
	 * tab to re-send it on, with the prior conversation as context.
	 */
	recoveryAction?: { lastUserPrompt: string; tabId: string };
	/**
	 * An error entry's structured error, as a local error entry carries it: the error card's
	 * details, and on a hosted record the error banner (`projectHostedSession()`).
	 */
	agentError?: AgentError;
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

/** What `MaestroClient.tabs.transcript` accepts: both the WebSocket client and the runtime slice the same way. */
export interface TranscriptWindow {
	/** Only entries with a timestamp after this, epoch ms. */
	sinceMs?: number;
	/** At most this many of the newest entries. 0 returns none. */
	tail?: number;
}

/** `entries` narrowed to the window: `sinceMs` first, then the newest `tail` of what is left. */
export function sliceTranscript(
	entries: LogEntryRecord[],
	window: TranscriptWindow = {}
): LogEntryRecord[] {
	let sliced = entries;
	if (window.sinceMs !== undefined) {
		const since = window.sinceMs;
		sliced = sliced.filter((entry) => entry.timestamp > since);
	}
	if (window.tail !== undefined) {
		sliced = window.tail <= 0 ? [] : sliced.slice(-window.tail);
	}
	return sliced;
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
