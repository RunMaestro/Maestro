/**
 * @file work-search.test.ts
 *
 * The one search behind the History panel, cross-tab search, and
 * `maestro-cli search`, over injected deps: no model, no database, no disk.
 *
 * What is pinned here:
 *   - **A semantic hit is turned back into words through the indexer's own
 *     chunker**, so the snippet is the window the hit's chunk index names.
 *   - **One hit per source**, its best chunk, and a source that is gone is
 *     dropped rather than returned as a bare id.
 *   - **Nothing falls back**: off, unavailable and cancelled pass through.
 *   - **Text mode reads the same corpus** with no model and no store.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The production wiring imports the indexer, the store and the router; the
// tests below drive `runWorkSearch` over fakes and only check that the app
// entry refuses before it is configured.
vi.mock('../../../main/local-models/semantic-indexer', () => ({
	SEMANTIC_INDEX_TASK_ID: 'semantic-search',
	resolveSemanticChunkBudget: vi.fn(),
	semanticIndexProgress: vi.fn(),
}));
vi.mock('../../../main/local-models/embedding-store', () => ({ getEmbeddingStore: vi.fn() }));
vi.mock('../../../main/local-models/task-router', () => ({ runEmbeddingTask: vi.fn() }));
vi.mock('../../../main/local-models/directors-notes-archive', () => ({
	readDirectorNotesArchive: vi.fn(async () => []),
}));
vi.mock('../../../main/local-models/sources', () => ({
	localModelSourceKey: (source: { modelId: string }) => `local:${source.modelId}`,
}));

import {
	configureWorkSearch,
	runWorkSearch,
	searchPastWork,
	searchPastWorkRequest,
	hydrateSemanticIndexPage,
	browseSemanticIndexRequest,
	type WorkSearchDeps,
} from '../../../main/local-models/work-search';
import { getEmbeddingStore } from '../../../main/local-models/embedding-store';
import {
	historyEntryText,
	TRANSCRIPT_SETTLE_MS,
} from '../../../main/local-models/semantic-sources';
import { chunkText } from '../../../main/local-models/text-chunker';
import {
	emptySemanticIndexProgress,
	transcriptSourceId,
	type EmbeddingSearchHit,
} from '../../../shared/local-models/embedding-index';
import type { HistoryEntry } from '../../../shared/types';

const NOW = 10_000_000;
const SOURCE = { type: 'local' as const, modelId: 'bge-small-en-v1.5' };

describe('index browsing', () => {
	it('hydrates indexed sources through the shared corpus without loading a model', async () => {
		const { deps } = makeDeps();
		const page = await hydrateSemanticIndexPage(deps, {
			offset: 0,
			limit: 20,
			total: 2,
			entries: ['a-login', 'deleted'].map((sourceId) => ({
				modelId: 'local:bge-small-en-v1.5',
				sourceType: 'history' as const,
				sourceId,
				agentId: 'agent-a',
				chunks: 2,
				indexedAt: NOW,
			})),
		});
		expect(page.entries[0]).toMatchObject({ title: 'Fixed the login timeout', chunks: 2 });
		expect(page.entries[0].snippet).toContain('Fixed the login timeout');
		expect(page.entries[1].sourceId).toBe('deleted');
		expect(page.entries[1].title).toBeUndefined();
		expect(page.total).toBe(2);
		expect(deps.embedQuery).not.toHaveBeenCalled();
		expect(deps.resolveChunkBudget).not.toHaveBeenCalled();
	});

	it.each([
		null,
		{},
		{ modelId: '' },
		{ modelId: 'm', sourceType: 'unknown' },
		{ modelId: 'm', offset: -1 },
		{ modelId: 'm', limit: Infinity },
	])('rejects an invalid browse request before reading SQLite: %j', async (request) => {
		vi.mocked(getEmbeddingStore).mockClear();
		await expect(browseSemanticIndexRequest(request)).rejects.toThrow();
		expect(getEmbeddingStore).not.toHaveBeenCalled();
	});
});

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		id: 'entry-1',
		type: 'USER',
		timestamp: 1_000,
		summary: 'Fixed the login timeout',
		projectPath: '/project',
		...overrides,
	};
}

/** One word per token, so a window is easy to count by eye. */
const countTokens = (text: string) => text.split(/\s+/).filter(Boolean).length;

const HISTORY: Record<string, HistoryEntry[]> = {
	'agent-a': [
		entry({ id: 'a-login', timestamp: 3_000, agentSessionId: 'sess-1', sessionName: 'Auth' }),
		entry({ id: 'a-cue', type: 'CUE', summary: 'nightly sweep finished', timestamp: 4_000 }),
		entry({
			id: 'a-long',
			timestamp: 2_000,
			summary: 'Rewrote the scheduler',
			// Two windows of four words each, at a budget of four tokens.
			fullResponse: 'one two three four. five six seven eight.',
		}),
	],
	'agent-b': [entry({ id: 'b-retry', summary: 'Added retry to the uploader', timestamp: 5_000 })],
};

const SESSIONS = [
	{
		id: 'agent-a',
		name: 'Backend',
		aiTabs: [
			{
				id: 'tab-1',
				name: 'Auth work',
				logs: [
					{ id: 'u1', source: 'user', text: 'why does login time out', timestamp: 100 },
					{ id: 'r1', source: 'ai', text: 'The token refresh races the logout.', timestamp: 200 },
					{ id: 'u2', source: 'user', text: 'fix it', timestamp: 300 },
					{ id: 'r2', source: 'ai', text: 'Done.', timestamp: NOW - TRANSCRIPT_SETTLE_MS - 1 },
				],
			},
			{
				id: 'tab-hidden',
				hidden: true,
				logs: [{ id: 'h1', source: 'user', text: 'login consult', timestamp: 100 }],
			},
		],
	},
	{ id: 'agent-b', name: 'Uploader', aiTabs: [] },
];

function hit(overrides: Partial<EmbeddingSearchHit>): EmbeddingSearchHit {
	return {
		sourceType: 'history',
		sourceId: 'a-login',
		agentId: 'agent-a',
		chunkIndex: 0,
		score: 0.9,
		...overrides,
	};
}

function makeDeps(overrides: Partial<WorkSearchDeps> = {}) {
	const search = vi.fn((): EmbeddingSearchHit[] => []);
	const deps: WorkSearchDeps = {
		embedQuery: vi.fn(async () => ({
			status: 'ok' as const,
			vectors: [Float32Array.from([1, 0])],
			source: SOURCE,
			durationMs: 1,
		})),
		resolveChunkBudget: vi.fn(async () => ({ countTokens, maxTokens: 4 })),
		store: () => ({ search }),
		history: {
			listSessions: async () => Object.keys(HISTORY),
			getEntries: vi.fn(async (sessionId: string) => HISTORY[sessionId] ?? []),
			includeCue: () => false,
		},
		sessions: () => SESSIONS,
		readArchive: async () => [
			{ id: 'notes-1', generatedAt: 6_000, lookbackDays: 7, text: 'The login work shipped.' },
		],
		indexProgress: () => ({ ...emptySemanticIndexProgress('indexing'), indexed: 3, total: 9 }),
		now: () => NOW,
		...overrides,
	};
	return { deps, search };
}

beforeEach(() => {
	vi.clearAllMocks();
	configureWorkSearch(null);
});

describe('semantic mode', () => {
	it('embeds the query and searches the store under the source key, with the filters', async () => {
		const { deps, search } = makeDeps();
		const result = await runWorkSearch(deps, {
			query: 'login',
			sourceTypes: ['history'],
			agentId: 'agent-a',
			limit: 5,
		});

		expect(deps.embedQuery).toHaveBeenCalledWith('login');
		expect(search).toHaveBeenCalledWith(expect.any(Float32Array), {
			modelId: 'local:bge-small-en-v1.5',
			// More than asked: several chunks of one source collapse into one hit.
			limit: 20,
			sourceTypes: ['history'],
			agentId: 'agent-a',
		});
		expect(result).toMatchObject({
			status: 'ok',
			mode: 'semantic',
			hits: [],
			modelId: 'local:bge-small-en-v1.5',
			index: { state: 'indexing', indexed: 3, total: 9 },
		});
		// No hit, so no source was read and nothing was measured.
		expect(deps.resolveChunkBudget).not.toHaveBeenCalled();
		expect(deps.history.getEntries).not.toHaveBeenCalled();
	});

	it('turns a history hit into a row: title, agent, time, and where it lives', async () => {
		const { deps, search } = makeDeps();
		search.mockReturnValue([hit({ score: 0.83 })]);

		const result = await runWorkSearch(deps, { query: 'login' });
		expect(result).toMatchObject({
			status: 'ok',
			hits: [
				{
					sourceType: 'history',
					sourceId: 'a-login',
					agentId: 'agent-a',
					agentName: 'Backend',
					score: 0.83,
					title: 'Fixed the login timeout',
					snippet: 'Fixed the login timeout',
					timestamp: 3_000,
					history: { type: 'USER', agentSessionId: 'sess-1', sessionName: 'Auth' },
				},
			],
		});
		// The whole entry rides only when asked for.
		expect(result.status === 'ok' && result.hits[0].history?.entry).toBeUndefined();
	});

	it('carries the whole entry when the caller asks for it', async () => {
		const { deps, search } = makeDeps();
		search.mockReturnValue([hit({})]);
		const result = await runWorkSearch(deps, { query: 'login', includeEntries: true });
		expect(result.status === 'ok' && result.hits[0].history?.entry).toBe(HISTORY['agent-a'][0]);
	});

	it('cuts the snippet from the window the chunk index names', async () => {
		const { deps, search } = makeDeps();
		search.mockReturnValue([hit({ sourceId: 'a-long', chunkIndex: 2 })]);
		const result = await runWorkSearch(deps, { query: 'unrelated' });
		expect(deps.resolveChunkBudget).toHaveBeenCalledWith(SOURCE);

		// The same cut the indexer made: same text, same chunker, same budget.
		const windows = chunkText(historyEntryText(HISTORY['agent-a'][2]), {
			countTokens,
			maxTokens: 4,
		});
		expect(windows).toHaveLength(3);
		expect(result.status === 'ok' && result.hits[0].snippet).toBe(windows[2].trim());
		expect(windows[2]).toContain('five six seven eight.');
	});

	it('falls back to the first window when the source now has fewer', async () => {
		const { deps, search } = makeDeps();
		search.mockReturnValue([hit({ sourceId: 'a-login', chunkIndex: 7 })]);
		const result = await runWorkSearch(deps, { query: 'login' });
		expect(result.status === 'ok' && result.hits[0].snippet).toBe('Fixed the login timeout');
	});

	it('keeps one hit per source, its best chunk, and reads each agent once', async () => {
		const { deps, search } = makeDeps();
		search.mockReturnValue([
			hit({ sourceId: 'a-long', chunkIndex: 1, score: 0.9 }),
			hit({ sourceId: 'a-long', chunkIndex: 0, score: 0.8 }),
			hit({ sourceId: 'a-login', score: 0.7 }),
		]);
		const result = await runWorkSearch(deps, { query: 'q' });
		expect(result.status === 'ok' && result.hits.map((h) => [h.sourceId, h.score])).toEqual([
			['a-long', 0.9],
			['a-login', 0.7],
		]);
		expect(deps.history.getEntries).toHaveBeenCalledTimes(1);
	});

	it('drops a hit whose source is gone, and a Cue run while Cue indexing is off', async () => {
		const { deps, search } = makeDeps();
		search.mockReturnValue([
			hit({ sourceId: 'deleted-entry', score: 0.95 }),
			hit({ sourceId: 'a-cue', score: 0.9 }),
			hit({ agentId: null, sourceId: 'orphan', score: 0.85 }),
			hit({ sourceId: 'a-login', score: 0.5 }),
		]);
		const result = await runWorkSearch(deps, { query: 'q' });
		expect(result.status === 'ok' && result.hits.map((h) => h.sourceId)).toEqual(['a-login']);
	});

	it('stops at the limit', async () => {
		const { deps, search } = makeDeps();
		search.mockReturnValue([
			hit({ sourceId: 'a-login', score: 0.9 }),
			hit({ sourceId: 'a-long', score: 0.8 }),
		]);
		const result = await runWorkSearch(deps, { query: 'q', limit: 1 });
		expect(result.status === 'ok' && result.hits.map((h) => h.sourceId)).toEqual(['a-login']);
	});

	it('resolves a transcript hit to its tab and the turn to jump to', async () => {
		// A window wide enough to hold the whole turn.
		const { deps, search } = makeDeps({
			resolveChunkBudget: vi.fn(async () => ({ countTokens, maxTokens: 100 })),
		});
		search.mockReturnValue([
			hit({ sourceType: 'transcript', sourceId: transcriptSourceId('tab-1', 'u1'), score: 0.7 }),
			// A hidden consult tab is never a result, whatever the index still holds.
			hit({ sourceType: 'transcript', sourceId: transcriptSourceId('tab-hidden', 'h1') }),
		]);
		const result = await runWorkSearch(deps, { query: 'token refresh' });
		expect(result).toMatchObject({
			hits: [
				{
					sourceType: 'transcript',
					agentId: 'agent-a',
					agentName: 'Backend',
					title: 'Auth work',
					timestamp: 100,
					transcript: { tabId: 'tab-1', turnId: 'u1', tabName: 'Auth work' },
				},
			],
		});
		expect(result.status === 'ok' && result.hits).toHaveLength(1);
		expect(result.status === 'ok' && result.hits[0].snippet).toContain('token refresh');
	});

	it("resolves a Director's Notes hit, which belongs to no agent", async () => {
		const { deps, search } = makeDeps();
		search.mockReturnValue([
			hit({ sourceType: 'directors-notes', sourceId: 'notes-1', agentId: null, score: 0.6 }),
		]);
		const result = await runWorkSearch(deps, { query: 'shipped' });
		expect(result).toMatchObject({
			hits: [
				{
					sourceType: 'directors-notes',
					sourceId: 'notes-1',
					agentId: null,
					title: "Director's Notes (7 day lookback)",
					snippet: 'The login work shipped.',
					timestamp: 6_000,
				},
			],
		});
	});

	it('survives one unreadable group', async () => {
		const { deps, search } = makeDeps();
		vi.mocked(deps.history.getEntries).mockImplementation(async (sessionId: string) => {
			if (sessionId === 'agent-a') throw new Error('corrupt file');
			return HISTORY[sessionId] ?? [];
		});
		search.mockReturnValue([
			hit({ sourceId: 'a-login', score: 0.9 }),
			hit({ sourceId: 'b-retry', agentId: 'agent-b', score: 0.8 }),
		]);
		const result = await runWorkSearch(deps, { query: 'q' });
		expect(result.status === 'ok' && result.hits.map((h) => h.sourceId)).toEqual(['b-retry']);
	});

	it('never falls back: off, unavailable and cancelled pass through', async () => {
		const { deps, search } = makeDeps();

		vi.mocked(deps.embedQuery).mockResolvedValueOnce({ status: 'off' });
		expect(await runWorkSearch(deps, { query: 'q' })).toEqual({ status: 'off' });

		vi.mocked(deps.embedQuery).mockResolvedValueOnce({
			status: 'unavailable',
			source: SOURCE,
			reason: 'bge-small-en-v1.5 is not downloaded.',
			code: 'model-not-installed',
		});
		expect(await runWorkSearch(deps, { query: 'q' })).toEqual({
			status: 'unavailable',
			reason: 'bge-small-en-v1.5 is not downloaded.',
			code: 'model-not-installed',
		});

		vi.mocked(deps.embedQuery).mockResolvedValueOnce({ status: 'cancelled', source: SOURCE });
		expect(await runWorkSearch(deps, { query: 'q' })).toEqual({ status: 'cancelled' });

		expect(search).not.toHaveBeenCalled();
		expect(deps.history.getEntries).not.toHaveBeenCalled();
	});

	it('reports a model that could not be measured as unavailable', async () => {
		const { deps, search } = makeDeps();
		search.mockReturnValue([hit({})]);
		vi.mocked(deps.resolveChunkBudget).mockRejectedValueOnce(new Error('tokenizer missing'));
		expect(await runWorkSearch(deps, { query: 'q' })).toEqual({
			status: 'unavailable',
			reason: 'tokenizer missing',
			code: 'chunk-budget',
		});
	});
});

describe('text mode', () => {
	it('matches the same corpus with no model and no store, newest first', async () => {
		const { deps, search } = makeDeps();
		const result = await runWorkSearch(deps, { query: 'LOGIN', mode: 'text' });

		expect(deps.embedQuery).not.toHaveBeenCalled();
		expect(search).not.toHaveBeenCalled();
		expect(result).toMatchObject({ status: 'ok', mode: 'text' });
		expect(
			result.status === 'ok' && result.hits.map((h) => [h.sourceType, h.sourceId, h.matchCount])
		).toEqual([
			['directors-notes', 'notes-1', 1],
			['history', 'a-login', 1],
			['transcript', transcriptSourceId('tab-1', 'u1'), 1],
		]);
		expect(result.status === 'ok' && result.index).toBeUndefined();
		expect(result.status === 'ok' && result.hits[0].score).toBeUndefined();
	});

	it('narrows to an agent, which leaves the notes out', async () => {
		const { deps } = makeDeps();
		const result = await runWorkSearch(deps, { query: 'login', mode: 'text', agentId: 'agent-a' });
		expect(result.status === 'ok' && result.hits.map((h) => h.sourceType)).toEqual([
			'history',
			'transcript',
		]);
		expect(deps.history.getEntries).toHaveBeenCalledTimes(1);
		expect(deps.history.getEntries).toHaveBeenCalledWith('agent-a');
	});

	it('narrows to a source type and stops at the limit', async () => {
		const { deps } = makeDeps();
		const result = await runWorkSearch(deps, {
			query: 'the',
			mode: 'text',
			sourceTypes: ['history'],
			limit: 2,
		});
		expect(result.status === 'ok' && result.hits.map((h) => h.sourceId)).toEqual([
			'b-retry',
			'a-login',
		]);
	});

	it('answers ok with no hits when nothing matches', async () => {
		const { deps } = makeDeps();
		expect(await runWorkSearch(deps, { query: 'kubernetes', mode: 'text' })).toMatchObject({
			status: 'ok',
			hits: [],
		});
	});
});

describe('the app entry', () => {
	it('refuses by name before startup has wired the stores', async () => {
		expect(await searchPastWork({ query: 'q' })).toEqual({
			status: 'unavailable',
			reason: 'Search is not ready yet. Maestro is still starting.',
			code: 'not-started',
		});
	});

	it('throws for a request with no query, as a caller bug', async () => {
		await expect(searchPastWorkRequest({ mode: 'semantic' })).rejects.toThrow('needs a query');
	});

	it('searches over the configured stores once wired', async () => {
		configureWorkSearch({
			history: {
				listSessions: async () => ['agent-b'],
				getEntries: async (sessionId) => HISTORY[sessionId] ?? [],
				includeCue: () => false,
			},
			sessions: () => SESSIONS,
		});
		const result = await searchPastWorkRequest({
			query: 'uploader',
			mode: 'text',
			sourceTypes: ['history'],
		});
		expect(result.status === 'ok' && result.hits.map((h) => h.sourceId)).toEqual(['b-retry']);
	});
});
