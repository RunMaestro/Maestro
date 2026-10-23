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

import { stripEmbeddedSystemPrompt } from './embeddedSystemPrompt';
import { generateUUID } from './uuid';

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
 *
 * A user turn is unwrapped on the way through (`stripEmbeddedSystemPrompt`).
 * Every provider except Claude Code lacks a system-prompt flag, so the spawn
 * path embeds the whole Maestro system prompt in the FIRST user turn, and that
 * turn is what the provider writes to disk. Rendering it verbatim showed the
 * system prompt, the conductor profile and the injected context as if the user
 * had typed them, and buried the prompt they really sent at the bottom of it
 * (issue #1533). Stripping here rather than at each call site is what keeps
 * resume and backfill producing identical entries for the same message; it also
 * makes a hydrated first turn match the clean entry a live tab logged, which is
 * what `selectOlderEntries` needs to find its splice point.
 *
 * The strip runs BEFORE the empty check: a turn that carried nothing but the
 * envelope has no user text to show and should drop out entirely.
 */
export function transcriptMessagesToLogEntries(messages: TranscriptMessage[]) {
	return messages
		.map((msg) => {
			const source = msg.type === 'user' ? ('user' as const) : ('stdout' as const);
			return {
				// Storage should always supply a uuid; the fallback keeps keys unique if
				// one is missing. Entries that fall back cannot be matched by id across
				// two reads, which is why `selectOlderEntries` also compares source+text.
				id: msg.uuid || generateUUID(),
				timestamp: new Date(msg.timestamp).getTime(),
				source,
				text: source === 'user' ? stripEmbeddedSystemPrompt(msg.content) : msg.content,
				...(msg.images && msg.images.length > 0 && { images: msg.images }),
			};
		})
		.filter(
			(entry) =>
				(entry.text && entry.text.trim().length > 0) ||
				(entry.images != null && entry.images.length > 0)
		);
}
