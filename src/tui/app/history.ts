/**
 * The state behind the History overlay, and the reads that fill it.
 *
 * History is paged by the library (`readHistory`, newest first, 200 per page).
 * The overlay shows one growing list: the cursor reaching the last loaded row
 * reads the next, older page and appends it, so a long history never needs a
 * paging key of its own.
 */

import {
	DEFAULT_HISTORY_PAGE_SIZE,
	readHistory,
	type HistoryEntry,
	type MaestroPaths,
} from '../../shared/maestro-lib';

export interface HistoryViewState {
	agentId: string;
	/** Loaded entries, newest first. */
	entries: readonly HistoryEntry[];
	/** Entries the file holds, loaded or not. */
	total: number;
	/** Pass to `readHistory` as `before` for the next page; undefined when none remain. */
	nextBefore: number | undefined;
	/** The row the cursor is on. */
	cursor: number;
	/** Why there is nothing to show (no file, unreadable, corrupt), in one line. */
	problem?: string;
}

type HistoryPaths = Pick<MaestroPaths, 'historyDir'>;

function fromRead(
	paths: HistoryPaths,
	agentId: string,
	before: number | undefined
): Omit<HistoryViewState, 'cursor'> {
	const result = readHistory(paths, agentId, { limit: DEFAULT_HISTORY_PAGE_SIZE, before });
	switch (result.status) {
		case 'ok':
			return {
				agentId,
				entries: result.entries,
				total: result.total,
				nextBefore: result.hasMore ? result.nextBefore : undefined,
			};
		case 'missing':
			return {
				agentId,
				entries: [],
				total: 0,
				nextBefore: undefined,
				problem: 'No history yet for this agent.',
			};
		case 'corrupt':
			return {
				agentId,
				entries: [],
				total: 0,
				nextBefore: undefined,
				problem: `History file is corrupt: ${result.reason}`,
			};
		case 'unreadable':
			return {
				agentId,
				entries: [],
				total: 0,
				nextBefore: undefined,
				problem: `History file could not be read: ${result.reason}`,
			};
	}
}

/** The newest page of an agent's history, with the cursor on the newest entry. */
export function openHistory(paths: HistoryPaths, agentId: string): HistoryViewState {
	return { ...fromRead(paths, agentId, undefined), cursor: 0 };
}

/** Move the cursor, reading the next older page when it reaches the last loaded row. */
export function moveHistoryCursor(
	paths: HistoryPaths,
	state: HistoryViewState,
	delta: number
): HistoryViewState {
	const last = state.entries.length - 1;
	const cursor = Math.min(Math.max(0, state.cursor + delta), Math.max(0, last));
	if (cursor < last || state.nextBefore === undefined) return { ...state, cursor };

	const older = fromRead(paths, state.agentId, state.nextBefore);
	return {
		...state,
		cursor,
		entries: [...state.entries, ...older.entries],
		nextBefore: older.nextBefore,
	};
}

/** A summary on one line: history summaries are free text and can run over several. */
export function summaryLine(summary: string): string {
	return summary.replace(/\s+/g, ' ').trim();
}
