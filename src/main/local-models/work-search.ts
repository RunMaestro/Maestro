/**
 * Searching past work: the one main-process search behind the History panel's
 * semantic mode, cross-tab search's semantic mode, and `maestro-cli search`.
 *
 * Two modes over one corpus (History entries, archived Director's Notes
 * synopses, persisted AI tab transcripts):
 *
 * - `semantic` embeds the query on the Semantic search assignment and asks the
 *   embedding store for the nearest chunks. The store holds vectors and no
 *   text, so each hit is turned back into words by re-reading its source and
 *   re-cutting it with the same chunker and the same budget the indexer used;
 *   the hit's chunk index then names the window that matched.
 * - `text` reads the corpus directly and matches the query as written
 *   (case-insensitive). No model, no index.
 *
 * Rules that hold for both:
 *
 * - A source that can no longer be read (a deleted entry, a closed tab, a Cue
 *   run while Cue indexing is off) is dropped from the results, never returned
 *   as an id with nothing behind it.
 * - Nothing falls back. A semantic search that cannot run answers `off` or
 *   `unavailable` with the reason; it is never answered with text matches.
 * - The corpus is read through `semantic-sources.ts`, the same functions the
 *   indexer reads through, so the two cannot disagree about what a source's
 *   text is.
 */

import {
	parseTranscriptSourceId,
	type EmbeddingSearchHit,
	type EmbeddingSourceType,
	EMBEDDING_SOURCE_TYPES,
	type SemanticIndexProgress,
} from '../../shared/local-models/embedding-index';
import {
	countOccurrences,
	DEFAULT_WORK_SEARCH_LIMIT,
	MAX_WORK_SEARCH_LIMIT,
	parseWorkSearchRequest,
	workSearchSnippet,
	type WorkSearchHistoryRef,
	type WorkSearchHit,
	type WorkSearchRequest,
	type WorkSearchResult,
	type WorkSearchTranscriptRef,
} from '../../shared/local-models/work-search';
import { logger } from '../utils/logger';
import { readDirectorNotesArchive, type ArchivedSynopsis } from './directors-notes-archive';
import { getEmbeddingStore, type EmbeddingStore } from './embedding-store';
import {
	resolveSemanticChunkBudget,
	SEMANTIC_INDEX_TASK_ID,
	semanticIndexProgress,
	type ChunkBudget,
} from './semantic-indexer';
import {
	historyGroupEntries,
	historySessionIds,
	synopsisItem,
	transcriptItems,
	type HistoryReaderDeps,
	type SemanticSourceItem,
} from './semantic-sources';
import { localModelSourceKey, type LocalModelSource } from './sources';
import { runEmbeddingTask, type EmbeddingTaskResult } from './task-router';
import { chunkText } from './text-chunker';

const LOG_CONTEXT = '[WorkSearch]';

/**
 * Chunks fetched per hit wanted. A long source matches with several of its
 * windows, and only the best one becomes a hit; some hits are also dropped
 * because their source is gone. Fetching more than asked keeps the list full.
 */
const SEMANTIC_OVERFETCH = 4;

/** The group Director's Notes load as. They belong to no agent. */
const NOTES_GROUP_KEY = 'archive';

/** Longest title a hit carries. */
const TITLE_CHARS = 120;

export interface WorkSearchDeps {
	/** Embed one query on the Semantic search assignment, as an interactive call. */
	embedQuery: (query: string) => Promise<EmbeddingTaskResult>;
	/** How the indexer measured text for a source (see `resolveSemanticChunkBudget`). */
	resolveChunkBudget: (source: LocalModelSource) => Promise<ChunkBudget>;
	/** The embedding store. A getter, so a text search never opens the database. */
	store: () => Pick<EmbeddingStore, 'search'>;
	/** History, read exactly as the indexer reads it. */
	history: HistoryReaderDeps;
	/** Every agent record in the sessions store. */
	sessions: () => Array<Record<string, unknown>>;
	readArchive: () => Promise<ArchivedSynopsis[]>;
	indexProgress: () => SemanticIndexProgress;
	now?: () => number;
}

/** One readable source, with what a result row says about it. */
interface WorkDocument {
	item: SemanticSourceItem;
	title: string;
	timestamp?: number;
	history?: WorkSearchHistoryRef;
	transcript?: WorkSearchTranscriptRef;
}

/** The fields of a persisted tab and log entry a result row reads. */
interface StoredTab {
	id?: unknown;
	name?: unknown;
	logs?: unknown;
}

interface StoredLog {
	id?: unknown;
	timestamp?: unknown;
}

function firstLine(text: string, fallback: string): string {
	const line =
		text
			.split('\n')
			.map((part) => part.trim())
			.find((part) => part !== '') ?? '';
	if (line === '') return fallback;
	return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…` : line;
}

function agentName(record: Record<string, unknown> | undefined): string | undefined {
	return typeof record?.name === 'string' && record.name !== '' ? record.name : undefined;
}

/**
 * The corpus as one search sees it. Groups load on demand and at most once, so
 * twenty hits in one agent's History cost one read of that agent's file.
 */
class WorkCorpus {
	private readonly groups = new Map<string, Promise<Map<string, WorkDocument>>>();

	constructor(
		private readonly deps: WorkSearchDeps,
		private readonly includeEntries: boolean
	) {}

	private record(agentId: string): Record<string, unknown> | undefined {
		return this.deps.sessions().find((session) => session?.id === agentId);
	}

	agentName(agentId: string | null): string | undefined {
		return agentId === null ? undefined : agentName(this.record(agentId));
	}

	/** The groups of one source type, narrowed to an agent when one is named. */
	async groupKeys(sourceType: EmbeddingSourceType, agentId?: string): Promise<string[]> {
		if (sourceType === 'directors-notes') return agentId === undefined ? [NOTES_GROUP_KEY] : [];
		if (agentId !== undefined) return [agentId];
		if (sourceType === 'history') return historySessionIds(this.deps.history);
		return this.deps
			.sessions()
			.map((session) => session?.id)
			.filter((id): id is string => typeof id === 'string' && id !== '');
	}

	/** The group a stored hit belongs to, or `null` when it names none. */
	groupKeyOf(hit: Pick<EmbeddingSearchHit, 'sourceType' | 'agentId'>): string | null {
		return hit.sourceType === 'directors-notes' ? NOTES_GROUP_KEY : hit.agentId;
	}

	/** One group's documents by source id. A group that cannot be read is empty. */
	group(sourceType: EmbeddingSourceType, key: string): Promise<Map<string, WorkDocument>> {
		const cacheKey = `${sourceType}\n${key}`;
		let loading = this.groups.get(cacheKey);
		if (!loading) {
			loading = this.load(sourceType, key).then(
				(documents) => new Map(documents.map((document) => [document.item.sourceId, document])),
				(error) => {
					// One unreadable file must not cost the whole search its answer.
					logger.warn(`Could not read ${sourceType} group ${key}: ${error}`, LOG_CONTEXT);
					return new Map<string, WorkDocument>();
				}
			);
			this.groups.set(cacheKey, loading);
		}
		return loading;
	}

	private async load(sourceType: EmbeddingSourceType, key: string): Promise<WorkDocument[]> {
		if (sourceType === 'history') return this.loadHistory(key);
		if (sourceType === 'transcript') return this.loadTranscripts(key);
		return this.loadNotes();
	}

	private async loadHistory(sessionId: string): Promise<WorkDocument[]> {
		const pairs = await historyGroupEntries(this.deps.history, sessionId);
		return pairs.map(({ entry, item }) => ({
			item,
			title: firstLine(entry.summary ?? '', entry.sessionName || `${entry.type} entry`),
			timestamp: entry.timestamp,
			history: {
				type: entry.type,
				...(entry.agentSessionId ? { agentSessionId: entry.agentSessionId } : {}),
				...(entry.sessionName ? { sessionName: entry.sessionName } : {}),
				...(this.includeEntries ? { entry } : {}),
			},
		}));
	}

	private async loadTranscripts(agentId: string): Promise<WorkDocument[]> {
		const record = this.record(agentId);
		if (!record) return [];

		// A tab's name, and when each of its log entries was written: what a
		// result row shows that the index item does not carry.
		const tabs = new Map<string, { name: string; times: Map<string, number> }>();
		for (const tab of Array.isArray(record.aiTabs) ? (record.aiTabs as StoredTab[]) : []) {
			if (!tab || typeof tab.id !== 'string') continue;
			const times = new Map<string, number>();
			for (const log of Array.isArray(tab.logs) ? (tab.logs as StoredLog[]) : []) {
				if (typeof log?.id === 'string' && typeof log.timestamp === 'number') {
					times.set(log.id, log.timestamp);
				}
			}
			const name = typeof tab.name === 'string' && tab.name !== '' ? tab.name : 'Unnamed tab';
			tabs.set(tab.id, { name, times });
		}

		const documents: WorkDocument[] = [];
		for (const item of transcriptItems(record, (this.deps.now ?? Date.now)())) {
			const ref = parseTranscriptSourceId(item.sourceId);
			const tab = ref ? tabs.get(ref.tabId) : undefined;
			if (!ref || !tab) continue;
			const timestamp = tab.times.get(ref.turnId);
			documents.push({
				item,
				title: tab.name,
				...(timestamp !== undefined ? { timestamp } : {}),
				transcript: { tabId: ref.tabId, turnId: ref.turnId, tabName: tab.name },
			});
		}
		return documents;
	}

	private async loadNotes(): Promise<WorkDocument[]> {
		const documents: WorkDocument[] = [];
		for (const record of await this.deps.readArchive()) {
			const item = synopsisItem(record);
			if (!item) continue;
			documents.push({
				item,
				title: `Director's Notes (${record.lookbackDays} day lookback)`,
				timestamp: record.generatedAt,
			});
		}
		return documents;
	}
}

function toHit(
	corpus: WorkCorpus,
	document: WorkDocument,
	snippet: string,
	match: Pick<WorkSearchHit, 'score' | 'matchCount'>
): WorkSearchHit {
	const { item } = document;
	const name = corpus.agentName(item.agentId);
	return {
		sourceType: item.sourceType,
		sourceId: item.sourceId,
		agentId: item.agentId,
		...(name ? { agentName: name } : {}),
		...match,
		title: document.title,
		snippet,
		...(document.timestamp !== undefined ? { timestamp: document.timestamp } : {}),
		...(document.history ? { history: document.history } : {}),
		...(document.transcript ? { transcript: document.transcript } : {}),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function searchByMeaning(
	deps: WorkSearchDeps,
	request: WorkSearchRequest,
	limit: number
): Promise<WorkSearchResult> {
	const now = deps.now ?? Date.now;
	const started = now();

	const verdict = await deps.embedQuery(request.query);
	if (verdict.status === 'off') return { status: 'off' };
	if (verdict.status === 'cancelled') return { status: 'cancelled' };
	if (verdict.status === 'unavailable') {
		return { status: 'unavailable', reason: verdict.reason, code: verdict.code };
	}
	const vector = verdict.vectors[0];
	if (!vector || vector.length === 0) {
		return {
			status: 'unavailable',
			reason: 'The embedding model returned no vector for the query.',
			code: 'empty-embedding',
		};
	}

	const modelId = localModelSourceKey(verdict.source);
	const nearest = deps.store().search(vector, {
		modelId,
		limit: Math.min(limit * SEMANTIC_OVERFETCH, MAX_WORK_SEARCH_LIMIT * SEMANTIC_OVERFETCH),
		...(request.sourceTypes ? { sourceTypes: request.sourceTypes } : {}),
		...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
	});

	const progress = deps.indexProgress();
	const done = (hits: WorkSearchHit[]): WorkSearchResult => ({
		status: 'ok',
		mode: 'semantic',
		hits,
		durationMs: now() - started,
		modelId,
		index: { state: progress.state, indexed: progress.indexed, total: progress.total },
	});
	if (nearest.length === 0) return done([]);

	// Measured the way the indexer measured it, or the chunk index names a
	// different window than the one that was embedded.
	let budget: ChunkBudget;
	try {
		budget = await deps.resolveChunkBudget(verdict.source);
	} catch (error) {
		return { status: 'unavailable', reason: errorMessage(error), code: 'chunk-budget' };
	}

	const corpus = new WorkCorpus(deps, request.includeEntries === true);
	const hits: WorkSearchHit[] = [];
	const seen = new Set<string>();
	for (const candidate of nearest) {
		if (hits.length >= limit) break;
		// Best first, so the first chunk seen of a source is its best one.
		const sourceKey = `${candidate.sourceType}\n${candidate.sourceId}`;
		if (seen.has(sourceKey)) continue;
		seen.add(sourceKey);

		const groupKey = corpus.groupKeyOf(candidate);
		if (groupKey === null) continue;
		const document = (await corpus.group(candidate.sourceType, groupKey)).get(candidate.sourceId);
		if (!document) continue;

		const chunks = chunkText(document.item.text, budget);
		// A source that changed since it was indexed may have fewer windows now.
		const chunk = chunks[candidate.chunkIndex] ?? chunks[0] ?? document.item.text;
		hits.push(
			toHit(corpus, document, workSearchSnippet(chunk, request.query), { score: candidate.score })
		);
	}
	return done(hits);
}

async function searchByText(
	deps: WorkSearchDeps,
	request: WorkSearchRequest,
	limit: number
): Promise<WorkSearchResult> {
	const now = deps.now ?? Date.now;
	const started = now();
	const needle = request.query.toLowerCase();
	const corpus = new WorkCorpus(deps, request.includeEntries === true);

	const matches: Array<{ document: WorkDocument; matchCount: number }> = [];
	for (const sourceType of request.sourceTypes ?? EMBEDDING_SOURCE_TYPES) {
		for (const key of await corpus.groupKeys(sourceType, request.agentId)) {
			for (const document of (await corpus.group(sourceType, key)).values()) {
				const matchCount = countOccurrences(document.item.text.toLowerCase(), needle);
				if (matchCount > 0) matches.push({ document, matchCount });
			}
		}
	}

	// Newest first: a text match is exact, so recency is what ranks one hit
	// above another. Undated sources sort last.
	matches.sort(
		(a, b) =>
			(b.document.timestamp ?? 0) - (a.document.timestamp ?? 0) || b.matchCount - a.matchCount
	);
	return {
		status: 'ok',
		mode: 'text',
		hits: matches.slice(0, limit).map(({ document, matchCount }) =>
			toHit(corpus, document, workSearchSnippet(document.item.text, request.query), {
				matchCount,
			})
		),
		durationMs: now() - started,
	};
}

/** Run one search over injected deps. Exported for tests; the app uses {@link searchPastWork}. */
export async function runWorkSearch(
	deps: WorkSearchDeps,
	request: WorkSearchRequest
): Promise<WorkSearchResult> {
	const limit = Math.max(
		1,
		Math.min(MAX_WORK_SEARCH_LIMIT, Math.floor(request.limit ?? DEFAULT_WORK_SEARCH_LIMIT))
	);
	return (request.mode ?? 'semantic') === 'text'
		? searchByText(deps, request, limit)
		: searchByMeaning(deps, request, limit);
}

// ============================================================================
// Production wiring
// ============================================================================

/** What only the running app knows: where History and the agent records live. */
export type WorkSearchStores = Pick<WorkSearchDeps, 'history' | 'sessions'>;

let configured: WorkSearchDeps | null = null;

/**
 * Point the app's search at its stores. Called once at startup, beside the
 * indexer's own wiring (`semantic-index-startup.ts`), with the SAME History
 * readers, so a hit is read back through what indexed it. `null` unsets it.
 */
export function configureWorkSearch(stores: WorkSearchStores | null): void {
	configured = stores
		? {
				...stores,
				embedQuery: (query) =>
					runEmbeddingTask(SEMANTIC_INDEX_TASK_ID, { texts: [query], mode: 'query' }),
				resolveChunkBudget: resolveSemanticChunkBudget,
				store: getEmbeddingStore,
				readArchive: () => readDirectorNotesArchive(),
				indexProgress: semanticIndexProgress,
			}
		: null;
}

/** Search past work in the running app. */
export async function searchPastWork(request: WorkSearchRequest): Promise<WorkSearchResult> {
	if (!configured) {
		// A transport can be asked before startup has wired the stores.
		return {
			status: 'unavailable',
			reason: 'Search is not ready yet. Maestro is still starting.',
			code: 'not-started',
		};
	}
	return runWorkSearch(configured, request);
}

/** {@link searchPastWork} for a request that crossed IPC or the CLI bridge. */
export async function searchPastWorkRequest(value: unknown): Promise<WorkSearchResult> {
	return searchPastWork(parseWorkSearchRequest(value));
}
