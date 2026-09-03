/**
 * @file groupChatActivity.ts
 * @description Derives "how much work happened in this chat" from the group
 * chat history log.
 *
 * A group chat is a long-lived room, not a task. The gap between its first and
 * last message is WALL CLOCK - a chat opened in August and used twice a week
 * reports hundreds of hours without anyone doing anything - so elapsed time is
 * the one number that must never be presented as effort.
 *
 * Working time is the union of the intervals the chat was busy. Each history
 * entry is stamped at the END of a turn, so a turn covers
 * `[timestamp - elapsedTimeMs, timestamp]`, and overlapping turns (participants
 * run in PARALLEL) collapse into one interval rather than summing - three
 * agents working the same ten minutes is ten minutes of chat time, not thirty.
 *
 * Entries recorded before per-turn timing existed carry no `elapsedTimeMs` and
 * degenerate to zero-length points. `stitchMs` is what keeps those honest: two
 * turns half a minute apart are one continuous block of work, while an
 * overnight gap ends the block. Without it an unmeasured chat reports 0m, which
 * is a worse lie than the elapsed span it replaced.
 */

import type { GroupChatHistoryEntry } from './group-chat-types';

/**
 * Idle gap that ends a block of work.
 *
 * Turns closer together than this are treated as one continuous work block:
 * the moderator reads, delegates, and synthesizes between participant turns,
 * and those handoffs are work even though nothing stamps a duration on them.
 */
export const GROUP_CHAT_ACTIVITY_STITCH_MS = 5 * 60 * 1000;

/** Totals derived from a chat's history log. */
export interface GroupChatActivityTotals {
	/** Union of busy intervals, idle gaps excluded. */
	workingTimeMs: number;
	/** Turns that reported a measured duration. */
	measuredTurns: number;
	/** Turns considered, measured or not. */
	totalTurns: number;
	/** Sum of per-turn token counts. Meaningless unless `turnsWithTokens > 0`. */
	tokenCount: number;
	/** Turns that reported token usage. Zero means "unknown", not "free". */
	turnsWithTokens: number;
	/** Sum of per-turn cost in USD. Meaningless unless `turnsWithCost > 0`. */
	costUsd: number;
	/** Turns that reported a cost. */
	turnsWithCost: number;
}

const EMPTY: GroupChatActivityTotals = {
	workingTimeMs: 0,
	measuredTurns: 0,
	totalTurns: 0,
	tokenCount: 0,
	turnsWithTokens: 0,
	costUsd: 0,
	turnsWithCost: 0,
};

/**
 * Roll a chat's history log up into working time, tokens, and cost.
 *
 * @param entries - History entries in any order; they are sorted internally.
 * @param stitchMs - Idle gap that ends a work block.
 */
export function computeGroupChatActivity(
	entries: readonly GroupChatHistoryEntry[],
	stitchMs: number = GROUP_CHAT_ACTIVITY_STITCH_MS
): GroupChatActivityTotals {
	if (!entries.length) return { ...EMPTY };

	const totals: GroupChatActivityTotals = { ...EMPTY, totalTurns: entries.length };

	const intervals: Array<{ start: number; end: number }> = [];
	for (const entry of entries) {
		const end = entry.timestamp;
		if (!Number.isFinite(end)) continue;

		// A negative or absurd elapsed value would stretch the union past the
		// chat itself, so only a positive measurement widens the interval.
		const elapsed =
			typeof entry.elapsedTimeMs === 'number' && entry.elapsedTimeMs > 0 ? entry.elapsedTimeMs : 0;
		if (elapsed > 0) totals.measuredTurns += 1;
		intervals.push({ start: end - elapsed, end });

		if (typeof entry.tokenCount === 'number' && entry.tokenCount > 0) {
			totals.tokenCount += entry.tokenCount;
			totals.turnsWithTokens += 1;
		}
		if (typeof entry.cost === 'number' && entry.cost > 0) {
			totals.costUsd += entry.cost;
			totals.turnsWithCost += 1;
		}
	}

	if (!intervals.length) return totals;

	intervals.sort((a, b) => a.start - b.start);

	let blockStart = intervals[0].start;
	let blockEnd = intervals[0].end;
	for (let i = 1; i < intervals.length; i++) {
		const { start, end } = intervals[i];
		if (start - blockEnd <= stitchMs) {
			// Same block: overlapping turns collapse, and a sub-stitch gap counts
			// as work rather than splitting one exchange into two blocks.
			if (end > blockEnd) blockEnd = end;
		} else {
			totals.workingTimeMs += blockEnd - blockStart;
			blockStart = start;
			blockEnd = end;
		}
	}
	totals.workingTimeMs += blockEnd - blockStart;

	return totals;
}
