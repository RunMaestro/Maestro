/**
 * @file tabConversationStats.ts
 * @description Conversation-level counts and wall-clock span for one AI tab.
 *
 * The HTML export has always printed these figures at the top of the document.
 * They are just as useful without exporting, so the numbers live here and every
 * surface reads them from the same place: the Context Details popover in the
 * main panel header, `generateTabExportHtml()`, and `maestro-cli list-sessions`
 * can never disagree about how big a conversation is or how long it ran.
 *
 * Lives in `shared/` rather than `renderer/utils/` because the CLI is one of
 * those callers, and the CLI's tsconfig has no DOM lib: importing the renderer
 * type barrel from there drags in modules that reference `window`.
 */

import { formatDurationCompact } from './formatters';

/**
 * The only two fields the math needs.
 *
 * Structural rather than the renderer's `LogEntry`, so a caller outside the
 * renderer can pass its own shape without importing that barrel. Renderer
 * callers pass `LogEntry[]` directly and the generic hands the same entries
 * back, so nothing is lost on the way through.
 */
export interface ConversationLogEntry {
	timestamp: number;
	source: string;
}

/**
 * Log sources that count as part of the conversation.
 *
 * Everything the transcript renders as a block, which is why tool calls and
 * thinking are in: the export draws one message card per entry, so its
 * "Messages" figure is this list's length. A new `LogEntry['source']` that the
 * transcript renders has to be added HERE, not in each caller's own literal
 * array - the point of this list is that there is only one of it.
 */
export const CONVERSATION_LOG_SOURCES: ReadonlySet<string> = new Set([
	'user',
	'ai',
	'stdout',
	'error',
	'stderr',
	'system',
	'thinking',
	'tool',
]);

export interface TabConversationStats<T extends ConversationLogEntry> {
	/** The conversation entries, in order, with non-conversation sources dropped. */
	logs: T[];
	/** Every conversation entry, matching the export's "Messages" card. */
	totalMessages: number;
	/** Entries the user typed. */
	userMessages: number;
	/** Entries the agent produced as prose (`ai` / `stdout`). */
	aiMessages: number;
	/** Wall clock between the first and last entry. Zero below two entries. */
	durationMs: number;
}

/**
 * Count a tab's conversation and measure how long it has been running.
 *
 * The duration is a span, not working time: an agent left open overnight
 * reports the night. That is the figure the export has always shown.
 */
export function computeTabConversationStats<T extends ConversationLogEntry>(
	logs: readonly T[] | undefined
): TabConversationStats<T> {
	const relevantLogs = (logs ?? []).filter((log) => CONVERSATION_LOG_SOURCES.has(log.source));

	return {
		logs: relevantLogs,
		totalMessages: relevantLogs.length,
		userMessages: relevantLogs.filter((l) => l.source === 'user').length,
		aiMessages: relevantLogs.filter((l) => l.source === 'ai' || l.source === 'stdout').length,
		durationMs:
			relevantLogs.length < 2
				? 0
				: relevantLogs[relevantLogs.length - 1].timestamp - relevantLogs[0].timestamp,
	};
}

/** Render a conversation span the way the export does, including the zero case. */
export function formatConversationDuration(durationMs: number): string {
	return durationMs > 0 ? formatDurationCompact(durationMs) : '0m';
}
