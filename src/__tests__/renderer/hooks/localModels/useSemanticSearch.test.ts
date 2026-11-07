/**
 * @file useSemanticSearch.test.ts
 *
 * The two hooks a search surface uses for its semantic mode:
 *   - `useSemanticSearchReady` decides whether the toggle is drawn at all. It
 *     is true ONLY for a task that would answer now.
 *   - `useSemanticSearch` runs the search as the user types: debounced, newest
 *     answer wins, and a search that cannot run reports why instead of
 *     pretending it found nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
	SEMANTIC_SEARCH_DEBOUNCE_MS,
	useSemanticSearch,
	useSemanticSearchReady,
	type UseSemanticSearchOptions,
} from '../../../../renderer/hooks/localModels';
import type { WorkSearchResult } from '../../../../shared/local-models/work-search';

const taskReadiness = () => vi.mocked(window.maestro.localModels.taskReadiness);
const search = () => vi.mocked(window.maestro.localModels.search);

const HIT = {
	sourceType: 'history' as const,
	sourceId: 'entry-1',
	agentId: 'agent-1',
	score: 0.8,
	title: 'Fixed the login timeout',
	snippet: 'The token refresh raced the logout.',
};

function ok(hits = [HIT], index?: { state: 'indexing'; indexed: number; total: number }) {
	return { status: 'ok', mode: 'semantic', hits, durationMs: 1, ...(index ? { index } : {}) };
}

const SOURCES = ['history'] as const;

function renderSearch(initial: Partial<UseSemanticSearchOptions> = {}) {
	return renderHook((props: Partial<UseSemanticSearchOptions>) =>
		useSemanticSearch({
			query: '',
			enabled: true,
			sourceTypes: SOURCES,
			agentId: 'agent-1',
			...initial,
			...props,
		})
	);
}

/** Let the debounce elapse and the search promise settle. */
async function settle() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(SEMANTIC_SEARCH_DEBOUNCE_MS);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	taskReadiness().mockReset().mockResolvedValue([]);
	search()
		.mockReset()
		.mockResolvedValue(ok() as never);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('useSemanticSearchReady', () => {
	async function readyFor(state: string) {
		taskReadiness().mockResolvedValue([{ taskId: 'semantic-search', state }] as never);
		const { result } = renderHook(() => useSemanticSearchReady());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		return result.current;
	}

	it('is true only while the task would answer now', async () => {
		expect(await readyFor('ready')).toBe(true);
		expect(await readyFor('off')).toBe(false);
		expect(await readyFor('unavailable')).toBe(false);
		expect(await readyFor('utility-agent')).toBe(false);
	});

	it('asks about the one task, and is false until the answer lands', async () => {
		let resolve: (value: never) => void = () => {};
		taskReadiness().mockReturnValue(new Promise((done) => (resolve = done)) as never);
		const { result } = renderHook(() => useSemanticSearchReady());

		expect(result.current).toBe(false);
		expect(taskReadiness()).toHaveBeenCalledWith('semantic-search');

		await act(async () => {
			resolve([{ taskId: 'semantic-search', state: 'ready' }] as never);
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(result.current).toBe(true);
	});

	it('is false when the readiness call itself fails', async () => {
		taskReadiness().mockRejectedValue(new Error('bridge down'));
		const { result } = renderHook(() => useSemanticSearchReady());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(result.current).toBe(false);
	});
});

describe('useSemanticSearch', () => {
	it('asks nothing while disabled or while the query is blank', async () => {
		const { rerender } = renderSearch({ enabled: false, query: 'login' });
		await settle();
		rerender({ enabled: true, query: '   ' });
		await settle();
		expect(search()).not.toHaveBeenCalled();
	});

	it('searches once the typing pauses, by meaning, scoped as asked', async () => {
		const { result, rerender } = renderSearch();

		rerender({ query: 'why did log' });
		rerender({ query: 'why did login break' });
		// Typed but not searched yet: the surface shows it is working on it.
		expect(result.current.loading).toBe(true);
		expect(search()).not.toHaveBeenCalled();

		await settle();

		expect(search()).toHaveBeenCalledTimes(1);
		expect(search()).toHaveBeenCalledWith({
			query: 'why did login break',
			mode: 'semantic',
			sourceTypes: ['history'],
			agentId: 'agent-1',
		});
		expect(result.current).toMatchObject({
			hits: [HIT],
			loading: false,
			notice: null,
			indexNote: null,
			searchedQuery: 'why did login break',
		});
	});

	it('passes the limit and the entry request through', async () => {
		renderSearch({ query: 'q', limit: 30, includeEntries: true });
		await settle();
		expect(search()).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 30, includeEntries: true })
		);
	});

	it('drops an answer that a newer query has overtaken', async () => {
		let resolveFirst: (value: never) => void = () => {};
		search().mockReturnValueOnce(new Promise((done) => (resolveFirst = done)) as never);
		const { result, rerender } = renderSearch({ query: 'first' });
		await settle();

		const second = { ...HIT, sourceId: 'entry-2' };
		search().mockResolvedValueOnce(ok([second]) as never);
		rerender({ query: 'second' });
		await settle();
		expect(result.current.hits).toEqual([second]);

		await act(async () => {
			resolveFirst(ok([HIT]) as never);
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(result.current.hits).toEqual([second]);
		expect(result.current.searchedQuery).toBe('second');
	});

	it('says the index is still building when it is', async () => {
		search().mockResolvedValue(ok([HIT], { state: 'indexing', indexed: 12, total: 90 }) as never);
		const { result } = renderSearch({ query: 'q' });
		await settle();
		expect(result.current.indexNote).toBe('Index is still building: 12 of 90 sources.');
	});

	it.each<[string, WorkSearchResult, string]>([
		['off', { status: 'off' }, 'Semantic search is off'],
		[
			'unavailable',
			{ status: 'unavailable', reason: 'bge-small-en-v1.5 is not downloaded.' },
			'bge-small-en-v1.5 is not downloaded.',
		],
		['cancelled', { status: 'cancelled' }, 'cancelled'],
	])('reports a %s search as a notice with no hits', async (_name, verdict, notice) => {
		search().mockResolvedValue(verdict as never);
		const { result } = renderSearch({ query: 'q' });
		await settle();
		expect(result.current.hits).toEqual([]);
		expect(result.current.notice).toContain(notice);
		expect(result.current.loading).toBe(false);
	});

	it('reports a failed call as a notice', async () => {
		search().mockRejectedValue(new Error('bridge down'));
		const { result } = renderSearch({ query: 'q' });
		await settle();
		expect(result.current.notice).toBe('bridge down');
	});

	it('clears the hits when the mode is switched off', async () => {
		const { result, rerender } = renderSearch({ query: 'q' });
		await settle();
		expect(result.current.hits).toHaveLength(1);

		rerender({ query: 'q', enabled: false });
		expect(result.current).toMatchObject({ hits: [], loading: false, notice: null });
	});
});
