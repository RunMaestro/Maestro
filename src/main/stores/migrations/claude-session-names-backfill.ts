/**
 * Claude Session Names Backfill
 *
 * One-shot repair for tab names the Claude origins store lost.
 *
 * `claude:registerSessionOrigin` runs on every turn and used to REPLACE the
 * session's record with the bare origin string, erasing the saved tab name.
 * Those sessions dropped out of the Tab Switcher's "All Named" list and lost
 * their title in the sessions browser, though history still carried the name
 * on every entry. This copies the newest recorded name back.
 *
 * Runs after the history manager initializes, since history is the source.
 * Idempotent via a marker in the settings store.
 */

import type Store from 'electron-store';

import { logger } from '../../utils/logger';
import type { HistoryManager } from '../../history-manager';
import type { HistoryEntry } from '../../../shared/types';
import { backfillClaudeSessionNames } from '../../storage/claude-session-origins';
import type { ClaudeSessionOriginsData, MaestroSettings } from '../types';

/** Settings key marking the one-time name backfill as done. */
export const CLAUDE_SESSION_NAMES_BACKFILL_MARKER = 'migration_claudeSessionNamesBackfillV1';

export async function migrateClaudeSessionNamesFromHistory(
	settingsStore: Store<MaestroSettings>,
	originsStore: Store<ClaudeSessionOriginsData>,
	historyManager: Pick<HistoryManager, 'listSessionsWithHistory' | 'getEntries'>
): Promise<void> {
	if (settingsStore.get(CLAUDE_SESSION_NAMES_BACKFILL_MARKER)) return;

	const entries: HistoryEntry[] = [];
	for (const sessionId of await historyManager.listSessionsWithHistory()) {
		entries.push(...(await historyManager.getEntries(sessionId)));
	}
	const restored = backfillClaudeSessionNames(originsStore, entries);

	settingsStore.set(CLAUDE_SESSION_NAMES_BACKFILL_MARKER, true);
	logger.info(
		`Claude session names backfill complete - restored ${restored} name(s) from history`,
		'Migration'
	);
}
