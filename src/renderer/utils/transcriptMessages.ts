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
 * How many provider messages the resume path reads when hydrating a tab. The
 * scroll-to-top backfill seeds its first window from this rather than from the
 * tab's entry count, because tool-only messages are dropped on the way in and a
 * window sized from what is on screen can land entirely inside it.
 */
export const TRANSCRIPT_RESUME_READ_LIMIT = 500;

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
 *
 * Nearest-to-expected is not enough on its own, though. `expected` is only an
 * estimate, and it is off by however many renderer-only entries the tab holds
 * (system notices, outage markers). Shift the estimate past one repetition of a
 * repeated message and the nearest source+text hit is the WRONG occurrence,
 * which either drops genuine turns or re-prepends ones already on screen. So
 * candidates are ranked by how much corroborating evidence they carry, and the
 * scan returns the best tier it found rather than the first hit of any tier:
 *
 *   1. Matching id - unambiguous, the tab was hydrated from this same file.
 *   2. Same source and text AND the same timestamp - a disk-hydrated entry keeps
 *      the provider's timestamp verbatim, so this pins the exact occurrence.
 *   3. Same source and text, and the entry AFTER it lines up with `visible[1]`
 *      too - two consecutive matches is far stronger than one.
 *   4. Same source and text alone - the old behavior, kept as a last resort
 *      because a live tab's entries carry locally generated ids and renderer
 *      clock timestamps, and their next entry may be a renderer-only notice
 *      that was never written to disk.
 */
export function selectOlderEntries(loaded: LogEntry[], visible: LogEntry[]): LogEntry[] {
	if (loaded.length === 0) return [];
	const boundary = visible[0];
	if (!boundary) return loaded;

	// Index of the best (lowest-numbered) tier seen so far. Because the scan
	// walks outward from `expected`, the first index recorded for a tier is
	// already the nearest one, so later hits in the same tier are ignored.
	let bestTier = Number.POSITIVE_INFINITY;
	let bestIndex = -1;
	const consider = (index: number): boolean => {
		const tier = matchTier(loaded, index, visible);
		if (tier === null) return false;
		if (tier < bestTier) {
			bestTier = tier;
			bestIndex = index;
		}
		// Tier 1 is an id match: nothing can beat it, so stop the scan.
		return tier === MATCH_TIER_ID;
	};

	const expected = Math.max(0, loaded.length - visible.length);
	for (let delta = 0; delta <= loaded.length; delta++) {
		const after = expected + delta;
		if (after < loaded.length && consider(after)) break;
		const before = expected - delta;
		if (delta > 0 && before >= 0 && consider(before)) break;
	}

	if (bestIndex >= 0) return loaded.slice(0, bestIndex);

	// No match: the boundary entry never reached disk (Maestro-injected system
	// notices and Agent Resilience outage markers live only in the tab). Cut on
	// time instead - staying strictly older than what is on screen is what keeps
	// the prepend duplicate-free.
	return loaded.filter((entry) => entry.timestamp < boundary.timestamp);
}

const MATCH_TIER_ID = 1;
const MATCH_TIER_TIMESTAMP = 2;
const MATCH_TIER_SEQUENCE = 3;
const MATCH_TIER_TEXT = 4;

/**
 * How strongly `loaded[index]` looks like the splice boundary `visible[0]`.
 * Lower is stronger; `null` means it is not a candidate at all.
 */
function matchTier(loaded: LogEntry[], index: number, visible: LogEntry[]): number | null {
	const candidate = loaded[index];
	const boundary = visible[0];
	if (candidate.id === boundary.id) return MATCH_TIER_ID;
	if (!isSameEntry(candidate, boundary)) return null;
	if (candidate.timestamp === boundary.timestamp) return MATCH_TIER_TIMESTAMP;
	const nextLoaded = loaded[index + 1];
	const nextVisible = visible[1];
	if (nextLoaded && nextVisible && isSameEntry(nextLoaded, nextVisible)) {
		return MATCH_TIER_SEQUENCE;
	}
	return MATCH_TIER_TEXT;
}

function isSameEntry(a: LogEntry, b: LogEntry): boolean {
	if (a.id === b.id) return true;
	return a.source === b.source && a.text.trim() === b.text.trim();
}
