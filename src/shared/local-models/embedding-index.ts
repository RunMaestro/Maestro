/**
 * The semantic index's wire vocabulary: what kind of thing a stored vector
 * came from, and what a search hands back.
 *
 * It lives in `shared/` because a hit travels. The embedding store in main
 * produces it, and the search surfaces (the History panel, cross-tab search,
 * `maestro-cli search`) all render the same structure. The vectors themselves
 * never leave main, so nothing here carries one.
 */

/**
 * What a chunk of indexed text belongs to.
 *
 * - `history`         - one History entry.
 * - `directors-notes` - one Director's Notes synopsis.
 * - `transcript`      - one turn of an AI tab's persisted transcript (see
 *                       {@link transcriptSourceId}).
 */
export const EMBEDDING_SOURCE_TYPES = ['history', 'directors-notes', 'transcript'] as const;

export type EmbeddingSourceType = (typeof EMBEDDING_SOURCE_TYPES)[number];

export function isEmbeddingSourceType(value: unknown): value is EmbeddingSourceType {
	return typeof value === 'string' && (EMBEDDING_SOURCE_TYPES as readonly string[]).includes(value);
}

/** Joins a tab id to a turn id. Neither id can contain it: both are generated ids. */
const TRANSCRIPT_SOURCE_SEPARATOR = '#';

/**
 * The source id of one transcript turn: the tab, plus the id of the log entry
 * that opens the turn (the user's message).
 *
 * A turn rather than a whole tab, because a tab's persisted transcript is a
 * sliding window (the newest `MAX_PERSISTED_SESSION_LOGS` entries). Chunking
 * the whole tab would renumber every chunk each time the oldest entry fell off,
 * and re-embed the lot. A turn's text does not move once the turn is over, so
 * its chunks are embedded once.
 */
export function transcriptSourceId(tabId: string, turnId: string): string {
	return `${tabId}${TRANSCRIPT_SOURCE_SEPARATOR}${turnId}`;
}

/** The tab and turn a transcript source id names, or `null` when it is not one. */
export function parseTranscriptSourceId(
	sourceId: string
): { tabId: string; turnId: string } | null {
	const at = sourceId.indexOf(TRANSCRIPT_SOURCE_SEPARATOR);
	if (at <= 0 || at === sourceId.length - 1) return null;
	return { tabId: sourceId.slice(0, at), turnId: sourceId.slice(at + 1) };
}

/** One chunk that matched a query, best first in a result list. */
export interface EmbeddingSearchHit {
	sourceType: EmbeddingSourceType;
	/**
	 * The source's own id: a history entry id, a notes id, or a
	 * {@link transcriptSourceId}.
	 */
	sourceId: string;
	/** The agent the source belongs to, when it belongs to one. */
	agentId: string | null;
	/** Which window of the source's text matched (0-based). */
	chunkIndex: number;
	/** Cosine similarity to the query, from -1 to 1. Higher is closer. */
	score: number;
}

/** How much one embedding model has indexed. */
export interface EmbeddingModelStats {
	modelId: string;
	/** Vector width. One model writes one width. */
	dimensions: number;
	chunks: number;
	/** Chunk counts per source type; a type with nothing indexed reads 0. */
	bySourceType: Record<EmbeddingSourceType, number>;
}

export interface EmbeddingStoreStats {
	/** Chunks across every model, including ones no longer assigned. */
	totalChunks: number;
	/** One entry per model with rows on disk, largest first. */
	models: EmbeddingModelStats[];
	/** Size of the database file's pages in bytes. */
	sizeBytes: number;
}

/**
 * What the background indexer is doing.
 *
 * - `off`         - Semantic search is assigned no source. Nothing runs, and
 *                   no timer is armed.
 * - `idle`        - the last pass finished; everything it could read is indexed.
 * - `indexing`    - a pass is embedding.
 * - `paused`      - a pass is waiting for an interactive Local Models task to
 *                   finish before it takes the model again.
 * - `unavailable` - the assigned source could not run. `reason` names it.
 */
export const SEMANTIC_INDEX_STATES = ['off', 'idle', 'indexing', 'paused', 'unavailable'] as const;

export type SemanticIndexState = (typeof SEMANTIC_INDEX_STATES)[number];

/** Sources counted per type: how many exist, and how many are up to date. */
export interface SemanticIndexSourceProgress {
	indexed: number;
	total: number;
}

/**
 * The indexer's progress, as every surface reads it (Settings, the
 * `localModels:semanticIndex:*` channels, `maestro-cli models index`).
 *
 * Counts are SOURCES (a history entry, a synopsis, a transcript turn), not
 * chunks: how many chunks a source becomes is only known once it is read and
 * split, and a total that grew while the bar filled would promise nothing.
 */
export interface SemanticIndexProgress {
	state: SemanticIndexState;
	/** Sources up to date under the assigned model. */
	indexed: number;
	/** Sources the last pass found. 0 before the first pass. */
	total: number;
	bySourceType: Record<EmbeddingSourceType, SemanticIndexSourceProgress>;
	/** The index key of the assigned source, when one is assigned. */
	modelId?: string;
	/** Why the state is `unavailable`. Written for a person. */
	reason?: string;
	/** When the last pass finished (Unix ms). Absent until one has. */
	lastPassAt?: number;
}

/** A progress record with every count at zero. */
export function emptySemanticIndexProgress(state: SemanticIndexState): SemanticIndexProgress {
	const bySourceType = {} as Record<EmbeddingSourceType, SemanticIndexSourceProgress>;
	for (const type of EMBEDDING_SOURCE_TYPES) bySourceType[type] = { indexed: 0, total: 0 };
	return { state, indexed: 0, total: 0, bySourceType };
}
