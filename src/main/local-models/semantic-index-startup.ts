/**
 * Starts the semantic indexer over the app's real stores, and points the
 * search (`work-search.ts`) at the same ones.
 *
 * Kept apart from `semantic-indexer.ts` so the indexer itself imports no
 * store, no History manager, and nothing from Cue: this is the one place that
 * knows where each source lives in a running app. The search is wired here for
 * the same reason, and from the same readers: it turns a hit back into text by
 * re-reading the source, so it must read what the indexer read.
 *
 * Starting is free. The indexer arms its first pass for a minute after launch,
 * and only when Semantic search is assigned a source; with the task off it
 * holds no timer and opens no file.
 */

import type Store from 'electron-store';
import type { HistoryEntry } from '../../shared/types';
import { getCueHistoryEntries } from '../cue/stats/cue-stats-query';
import type { HistoryManager } from '../history-manager';
import type { MaestroSettings, SessionsData } from '../stores/types';
import {
	cueScopeAgentFromRecord,
	dropCueRowsAlreadyInJsonl,
	readCueEntries,
} from '../utils/cue-history-merge';
import {
	refreshSemanticIndexer,
	SEMANTIC_INDEX_CUE_SETTING,
	startSemanticIndexer,
} from './semantic-indexer';
import type { HistoryReaderDeps } from './semantic-sources';
import { configureWorkSearch } from './work-search';

export interface SemanticIndexStartupDeps {
	settingsStore: Store<MaestroSettings>;
	sessionsStore: Store<SessionsData>;
	historyManager: HistoryManager;
}

/**
 * Build and start the app's indexer, and keep it in step with the two settings
 * it depends on. In-app changes arrive through the store's own change events;
 * a change written by another process (`maestro-cli models assign`,
 * `maestro-cli settings set`) is the settings watcher's to report, by calling
 * `refreshSemanticIndexer()`.
 */
export function startSemanticIndex(deps: SemanticIndexStartupDeps): void {
	const { settingsStore, sessionsStore, historyManager } = deps;

	const sessionRecords = (): Array<Record<string, unknown>> =>
		(sessionsStore.get('sessions', []) as unknown as Array<Record<string, unknown>>).filter(
			(record) => typeof record === 'object' && record !== null
		);

	const includeCue = (): boolean => settingsStore.get(SEMANTIC_INDEX_CUE_SETTING, false) === true;

	// Cue runs live in the Cue database, not in a History file, so an agent
	// that only ever ran Cue jobs has no file to list. Rows a History file
	// already carries (runs recorded before the split) are dropped, exactly as
	// the History panel drops them, so no run is indexed twice.
	const cueRuns: NonNullable<HistoryReaderDeps['cueRuns']> = {
		sessions: () =>
			sessionRecords()
				.map((record) => record.id)
				.filter((id): id is string => typeof id === 'string' && id !== ''),
		entries: (sessionId: string, stored: HistoryEntry[]) =>
			dropCueRowsAlreadyInJsonl(
				stored,
				readCueEntries(getCueHistoryEntries, [
					cueScopeAgentFromRecord(
						sessionId,
						sessionRecords().find((record) => record.id === sessionId)
					),
				])
			),
	};

	startSemanticIndexer({
		history: {
			listSessionsWithHistory: () => historyManager.listSessionsWithHistory(),
			getEntries: (sessionId) => historyManager.getEntries(sessionId),
			onEntryAdded: (listener) => historyManager.onEntryAdded(listener),
		},
		sessions: sessionRecords,
		includeCue,
		cueRuns,
	});

	configureWorkSearch({
		history: {
			listSessions: () => historyManager.listSessionsWithHistory(),
			getEntries: (sessionId) => historyManager.getEntries(sessionId),
			includeCue,
			cueRuns,
		},
		sessions: sessionRecords,
	});

	settingsStore.onDidChange('localModelAssignments', () => refreshSemanticIndexer());
	settingsStore.onDidChange(SEMANTIC_INDEX_CUE_SETTING, () => refreshSemanticIndexer());
}
