/**
 * Conversion between provider transcript messages (as returned by
 * `window.maestro.agentSessions.read`) and the `LogEntry` shape the AI
 * transcript renders, plus the boundary maths used to splice older history in
 * above what is already on screen.
 *
 * Two call sites must produce IDENTICAL entries from the same message: resuming
 * a session into a tab (`useAgentSessionManagement`) and backfilling older
 * history when the user scrolls to the top (`useTranscriptBackfill`, issue
 * #1407). The backfill matches what it just read against what is already
 * rendered to find the splice point, so any divergence in id or text between
 * the two paths would duplicate the overlapping region.
 */

import type { LogEntry } from '../types';
import { generateId } from './ids';

/**
 * A single message as returned by the agent session storage layer. Only the
 * fields the transcript needs are modelled; storage returns more.
 */
export interface TranscriptMessage {
	type: string;
	role?: string;
	content: string;
	timestamp: string;
	uuid: string;
	images?: string[];
}

/**
 * Matches the Auto Run synopsis prompt that Maestro injects into the agent
 * session after a task ("Give/Provide a brief synopsis of what you just
 * accomplished ..."). The leading verb and trailing wording have drifted across
 * versions and the prompt is user-customizable, so we anchor on the stable core
 * phrase. A restored tab hides this request and the assistant's `**Summary:**`
 * reply since they are bookkeeping, not part of the user's conversation.
 */
const SYNOPSIS_REQUEST_PATTERN =
	/^\s*\S+\s+a\s+brief\s+synopsis\s+of\s+what\s+you\s+just\s+accomplished/i;

export function isSynopsisRequest(msg: {
	type?: string;
	role?: string;
	content?: string;
}): boolean {
	const isUser = msg.type === 'user' || msg.role === 'user';
	return isUser && typeof msg.content === 'string' && SYNOPSIS_REQUEST_PATTERN.test(msg.content);
}

/** Drop each synopsis request and the assistant reply that immediately follows it. */
export function stripSynopsisTurns<T extends { type: string; role?: string; content: string }>(
	messages: T[]
): T[] {
	return messages.filter((msg, i, arr) => {
		if (isSynopsisRequest(msg)) return false;
		const prev = arr[i - 1];
		const isAssistant = msg.type === 'assistant' || msg.role === 'assistant';
		if (prev && isSynopsisRequest(prev) && isAssistant) return false;
		return true;
	});
}

/**
 * Convert transcript messages to log entries, keeping only messages with actual
 * text content or reconstructed images. Tool-use-only messages (empty text, no
 * images) are skipped - restored tabs start with thinking off, so there is
 * nothing useful to render for those entries.
 */
export function transcriptMessagesToLogEntries(messages: TranscriptMessage[]): LogEntry[] {
	return messages
		.filter(
			(msg) =>
				(msg.content && msg.content.trim().length > 0) ||
				(msg.images != null && msg.images.length > 0)
		)
		.map((msg) => ({
			// Storage should always supply a uuid; the fallback keeps keys unique if
			// one is missing. Entries that fall back cannot be matched by id across
			// two reads, which is why `selectOlderEntries` also compares source+text.
			id: msg.uuid || generateId(),
			timestamp: new Date(msg.timestamp).getTime(),
			source: msg.type === 'user' ? ('user' as const) : ('stdout' as const),
			text: msg.content,
			...(msg.images && msg.images.length > 0 && { images: msg.images }),
		}));
}

/**
 * Pick the entries of a freshly-read transcript window that sit strictly BEFORE
 * what the tab already shows, so they can be prepended without duplicating
 * anything on screen.
 *
 * `loaded` is the newest N messages read from disk and `visible` is the tail of
 * that same conversation, so the splice point is wherever `visible[0]` appears
 * inside `loaded`. Two things stop that from being a plain `indexOf`:
 *
 * - IDs only line up when the tab was hydrated from disk. A tab that ran live
 *   and then survived a restart holds locally generated IDs for the same
 *   messages, so the comparison has to fall back to source + text.
 * - Text alone is ambiguous: a user who sends "continue" ten times produces ten
 *   identical entries. So search outward from where the splice point is
 *   EXPECTED to be - the two lists differ only by entries that never reached
 *   disk - and take the nearest match rather than the first or last in the array.
 */
export function selectOlderEntries(loaded: LogEntry[], visible: LogEntry[]): LogEntry[] {
	if (loaded.length === 0) return [];
	const boundary = visible[0];
	if (!boundary) return loaded;

	const expected = Math.max(0, loaded.length - visible.length);
	for (let delta = 0; delta <= loaded.length; delta++) {
		const after = expected + delta;
		if (after < loaded.length && isSameEntry(loaded[after], boundary)) {
			return loaded.slice(0, after);
		}
		const before = expected - delta;
		if (delta > 0 && before >= 0 && isSameEntry(loaded[before], boundary)) {
			return loaded.slice(0, before);
		}
	}

	// No match: the boundary entry never reached disk (Maestro-injected system
	// notices and Agent Resilience outage markers live only in the tab). Cut on
	// time instead - staying strictly older than what is on screen is what keeps
	// the prepend duplicate-free.
	return loaded.filter((entry) => entry.timestamp < boundary.timestamp);
}

function isSameEntry(a: LogEntry, b: LogEntry): boolean {
	if (a.id === b.id) return true;
	return a.source === b.source && a.text.trim() === b.text.trim();
}
