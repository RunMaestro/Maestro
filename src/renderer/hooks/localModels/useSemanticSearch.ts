/**
 * useSemanticSearch - search past work by meaning from a renderer surface.
 *
 * Two hooks, because a surface asks two different questions:
 *
 * - `useSemanticSearchReady()` - may the surface OFFER a semantic mode at all?
 *   True only while the Semantic search task would answer right now. The
 *   verdict is the main process's own (`resolveTaskReadiness`), so the toggle
 *   cannot be shown for a model that is not downloaded.
 * - `useSemanticSearch(options)` - run the search as the user types. The query
 *   is debounced (each search embeds it, which a keystroke should not pay
 *   for), and an answer that arrives after a newer query was issued is dropped.
 *
 * The search itself runs in main (`localModels:search`), the same function
 * `maestro-cli search --semantic` calls. Nothing here falls back to a text
 * match: a search that cannot run reports why in `notice` and returns no hits.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { EmbeddingSourceType } from '../../../shared/local-models/embedding-index';
import { resolveLocalModelAssignment } from '../../../shared/local-models/tasks';
import {
	describeWorkSearchIndex,
	WORK_SEARCH_OFF_REASON,
	type WorkSearchHit,
} from '../../../shared/local-models/work-search';
import { useSettingsStore } from '../../stores/settingsStore';
import { useDebouncedValue } from '../utils/useThrottle';
import { useLocalModelTaskReadiness } from './useLocalModelTaskReadiness';

/** Wait after the last keystroke before a query is embedded. */
export const SEMANTIC_SEARCH_DEBOUNCE_MS = 300;

/** Whether the Semantic search task would answer right now. */
export function useSemanticSearchReady(): boolean {
	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const endpoints = useSettingsStore((s) => s.localModelEndpoints);
	// Everything the verdict depends on that the renderer can see, so assigning
	// a source while the surface is open shows the toggle without reopening it.
	const revision = useMemo(
		() => JSON.stringify([resolveLocalModelAssignment(assignments, 'semantic-search'), endpoints]),
		[assignments, endpoints]
	);
	const { readiness } = useLocalModelTaskReadiness(revision, 'semantic-search');
	return readiness['semantic-search']?.state === 'ready';
}

export interface UseSemanticSearchOptions {
	query: string;
	/** False while the surface is in its text mode: nothing is asked. */
	enabled: boolean;
	/** Pass a stable array (a module constant); it is compared by content. */
	sourceTypes: readonly EmbeddingSourceType[];
	agentId?: string;
	limit?: number;
	/** Carry the whole History entry on each history hit. */
	includeEntries?: boolean;
}

export interface SemanticSearchState {
	/** Best first. Empty while disabled, while the query is blank, or on a refusal. */
	hits: WorkSearchHit[];
	/** A search is running, or the typed query has not been searched yet. */
	loading: boolean;
	/** Why a search that was asked for produced nothing. Written for a person. */
	notice: string | null;
	/** Set when the index does not cover everything yet. */
	indexNote: string | null;
	/** The query `hits` answer, which trails what is typed by the debounce. */
	searchedQuery: string;
}

const IDLE: Omit<SemanticSearchState, 'loading'> = {
	hits: [],
	notice: null,
	indexNote: null,
	searchedQuery: '',
};

export function useSemanticSearch(options: UseSemanticSearchOptions): SemanticSearchState {
	const { query, enabled, sourceTypes, agentId, limit, includeEntries } = options;
	const debouncedQuery = useDebouncedValue(query, SEMANTIC_SEARCH_DEBOUNCE_MS).trim();
	const sourceKey = sourceTypes.join(',');

	const [state, setState] = useState(IDLE);
	const [searching, setSearching] = useState(false);
	// Each request takes the next number; only the newest may write state.
	const latestRequest = useRef(0);

	// The typed query has caught up with the debounced one. While it has not,
	// the debounced value is a query the user has already typed past.
	const settled = query.trim() === debouncedQuery;

	useEffect(() => {
		const request = ++latestRequest.current;
		if (!enabled || (settled && debouncedQuery === '')) {
			setState(IDLE);
			setSearching(false);
			return;
		}
		// Mid-typing (or the mode was switched on mid-typing): the answer in hand
		// stays on screen until the debounce delivers the query to search for.
		if (!settled) return;
		setSearching(true);
		const settle = (next: Omit<SemanticSearchState, 'loading'>) => {
			if (request !== latestRequest.current) return;
			setState(next);
			setSearching(false);
		};
		const refused = (notice: string) => settle({ ...IDLE, notice, searchedQuery: debouncedQuery });

		window.maestro.localModels
			.search({
				query: debouncedQuery,
				mode: 'semantic',
				sourceTypes: sourceKey.split(',') as EmbeddingSourceType[],
				...(agentId !== undefined ? { agentId } : {}),
				...(limit !== undefined ? { limit } : {}),
				...(includeEntries ? { includeEntries: true } : {}),
			})
			.then((result) => {
				if (result.status === 'ok') {
					settle({
						hits: result.hits,
						notice: null,
						indexNote: describeWorkSearchIndex(result.index),
						searchedQuery: debouncedQuery,
					});
				} else if (result.status === 'off') refused(WORK_SEARCH_OFF_REASON);
				else if (result.status === 'cancelled') refused('The search was cancelled.');
				else refused(result.reason);
			})
			.catch((error: unknown) => refused(error instanceof Error ? error.message : String(error)));

		return () => {
			// Unmounting, or a newer query: this answer is no longer wanted.
			if (request === latestRequest.current) latestRequest.current++;
		};
	}, [enabled, settled, debouncedQuery, sourceKey, agentId, limit, includeEntries]);

	const awaitingDebounce = enabled && !settled && query.trim() !== '';
	return { ...state, loading: (enabled && searching) || awaitingDebounce };
}
