/**
 * The semantic index's storage: one vector per chunk of indexed text, in
 * `userData/embeddings.db`.
 *
 * Search is brute-force cosine in JavaScript. Tens of thousands of 384-wide
 * vectors is a few milliseconds of dot products, which is why there is no
 * native vector extension here and must not be one: a second native module to
 * rebuild per platform buys nothing at this size.
 *
 * Three rules shape the module:
 *
 * - **One model per search.** Vectors from two models are not comparable, so
 *   every row carries its `model_id` and a search reads exactly one. Changing
 *   the assigned model does not delete the old rows; they simply stop being
 *   read, and the indexer re-embeds lazily under the new id.
 * - **Search does not touch disk.** The active model's vectors are loaded once,
 *   on the first search, and every write after that updates the same map. A
 *   write before the first search does NOT load them: the background indexer
 *   can run for hours without holding the whole index in memory.
 * - **The file is a cache of derivable data.** Every vector can be recomputed
 *   from text Maestro already stores, so a database that will not open is
 *   moved aside and rebuilt rather than repaired.
 *
 * Vectors are stored as the raw bytes of a `Float32Array` in the platform's
 * byte order. Every platform Maestro ships on is little-endian, and the file
 * is never moved between machines by the app.
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
	EMBEDDING_SOURCE_TYPES,
	isEmbeddingSourceType,
	type EmbeddingModelStats,
	type EmbeddingSearchHit,
	type EmbeddingSourceType,
	type EmbeddingStoreStats,
	type SemanticIndexBrowseRequest,
	type SemanticIndexPage,
} from '../../shared/local-models/embedding-index';
import { fileTimestampSlug } from '../../shared/formatters';
import { logger } from '../utils/logger';
import { runSqliteMigrations, type SqliteMigration } from '../utils/sqlite-migrations';
import { localModelsDataDir } from './paths';
import { dotProduct, l2Normalize } from './vectors';

const LOG_CONTEXT = '[EmbeddingStore]';

/** The database file, relative to the data dir. */
export const EMBEDDINGS_DB_FILENAME = 'embeddings.db';

/** Hits returned when a search names no limit. */
export const DEFAULT_EMBEDDING_SEARCH_LIMIT = 20;

/** SQLite's default cap on bound parameters is 999; stay well under it. */
const HASH_LOOKUP_BATCH = 500;

// ============================================================================
// Schema
// ============================================================================

const CREATE_EMBEDDING_CHUNKS_SQL = `
  CREATE TABLE IF NOT EXISTS embedding_chunks (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    agent_id TEXT,
    chunk_index INTEGER NOT NULL,
    text_hash TEXT NOT NULL,
    model_id TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector BLOB NOT NULL,
    created_at INTEGER NOT NULL
  )
`;

/**
 * `source` serves delete-by-source; `model_hash` serves every per-model read
 * (the cache load, the stats grouping, clearing one model) and the indexer's
 * "is this text already embedded?" lookup.
 */
const CREATE_EMBEDDING_CHUNKS_INDEXES_SQL = [
	'CREATE INDEX IF NOT EXISTS idx_embedding_chunks_source ON embedding_chunks(source_type, source_id)',
	'CREATE INDEX IF NOT EXISTS idx_embedding_chunks_model_hash ON embedding_chunks(model_id, text_hash)',
];

const EMBEDDING_MIGRATIONS: SqliteMigration[] = [
	{
		version: 1,
		description: 'Initial schema: embedding_chunks table',
		up: (db) => {
			db.prepare(CREATE_EMBEDDING_CHUNKS_SQL).run();
			for (const sql of CREATE_EMBEDDING_CHUNKS_INDEXES_SQL) db.prepare(sql).run();
		},
	},
];

const UPSERT_CHUNK_SQL = `
  INSERT INTO embedding_chunks
    (id, source_type, source_id, agent_id, chunk_index, text_hash, model_id, dimensions, vector, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    agent_id = excluded.agent_id,
    text_hash = excluded.text_hash,
    dimensions = excluded.dimensions,
    vector = excluded.vector,
    created_at = excluded.created_at
`;

// ============================================================================
// Types
// ============================================================================

/** One chunk to store. Its width is the vector's own length, never restated. */
export interface EmbeddingChunkInput {
	sourceType: EmbeddingSourceType;
	sourceId: string;
	agentId?: string | null;
	chunkIndex: number;
	/** {@link embeddingTextHash} of the chunk's text. */
	textHash: string;
	modelId: string;
	vector: Float32Array;
	/** Defaults to now. */
	createdAt?: number;
}

export interface EmbeddingSearchOptions {
	/** The model whose vectors are searched. The query must come from the same one. */
	modelId: string;
	limit?: number;
	/** Restrict to these source types. Omitted means every type; empty means none. */
	sourceTypes?: readonly EmbeddingSourceType[];
	/** Restrict to chunks that belong to this agent. */
	agentId?: string;
}

interface CachedChunk {
	sourceType: EmbeddingSourceType;
	sourceId: string;
	agentId: string | null;
	chunkIndex: number;
	/** Unit length, so a dot product with a unit query is the cosine. */
	vector: Float32Array;
}

interface ChunkRow {
	id: string;
	source_type: string;
	source_id: string;
	agent_id: string | null;
	chunk_index: number;
	dimensions: number;
	vector: Uint8Array;
}

// ============================================================================
// Pure helpers
// ============================================================================

/** SHA-256 of a chunk's text, hex. The `text_hash` column, and the dedupe key. */
export function embeddingTextHash(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A chunk's row id: a hash of what makes it that chunk. Derived rather than
 * generated so writing the same chunk twice is an update, not a duplicate, and
 * hashed rather than joined so no source id can collide with another by
 * containing the separator.
 */
export function embeddingChunkId(
	modelId: string,
	sourceType: EmbeddingSourceType,
	sourceId: string,
	chunkIndex: number
): string {
	return createHash('sha256')
		.update(JSON.stringify([modelId, sourceType, sourceId, chunkIndex]), 'utf8')
		.digest('hex')
		.slice(0, 32);
}

function vectorToBlob(vector: Float32Array): Buffer {
	// A copy, not a view: the caller keeps its array and may reuse the buffer.
	return Buffer.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
}

/**
 * Decode a stored vector, or `null` when the bytes do not match the recorded
 * width. Copies, because a driver's blob can sit at an offset that is not a
 * multiple of four and a `Float32Array` view over it would throw.
 */
function blobToVector(blob: Uint8Array, dimensions: number): Float32Array | null {
	if (dimensions <= 0 || blob.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
		return null;
	}
	const vector = new Float32Array(dimensions);
	new Uint8Array(vector.buffer).set(blob);
	return vector;
}

function assertValidChunk(row: EmbeddingChunkInput): void {
	if (!isEmbeddingSourceType(row.sourceType)) {
		throw new Error(`Unknown embedding source type: ${String(row.sourceType)}`);
	}
	if (!row.sourceId) throw new Error('An embedding chunk needs a source id');
	if (!row.modelId) throw new Error('An embedding chunk needs a model id');
	if (!row.textHash) throw new Error('An embedding chunk needs a text hash');
	if (!Number.isInteger(row.chunkIndex) || row.chunkIndex < 0) {
		throw new Error(`Invalid embedding chunk index: ${row.chunkIndex}`);
	}
	if (row.vector.length === 0) throw new Error('An embedding chunk needs a non-empty vector');
	// One NaN makes every comparison against the row false, which silently
	// scrambles the ranking instead of failing.
	for (let i = 0; i < row.vector.length; i++) {
		if (!Number.isFinite(row.vector[i])) {
			throw new Error(`Embedding vector for ${row.sourceType}:${row.sourceId} is not finite`);
		}
	}
}

/** A database file SQLite refuses to read, under either driver's wording. */
function isCorruptDatabaseError(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === 'string' && /^SQLITE_(CORRUPT|NOTADB)/.test(code)) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /not a database|malformed/i.test(message);
}

function emptySourceCounts(): Record<EmbeddingSourceType, number> {
	const counts = {} as Record<EmbeddingSourceType, number>;
	for (const type of EMBEDDING_SOURCE_TYPES) counts[type] = 0;
	return counts;
}

// ============================================================================
// Store
// ============================================================================

export class EmbeddingStore {
	private handle: Database.Database | null = null;
	/** The one model held in memory, once a search has asked for it. */
	private cache: { modelId: string; chunks: Map<string, CachedChunk> } | null = null;

	constructor(private readonly dbPath: string) {}

	// ------------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------------

	/** Opened on first use, so constructing the store costs nothing. */
	private get db(): Database.Database {
		if (!this.handle) this.handle = this.open();
		return this.handle;
	}

	private open(): Database.Database {
		fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
		try {
			return this.openAndMigrate();
		} catch (error) {
			if (!isCorruptDatabaseError(error)) throw error;
			this.quarantine(error);
			return this.openAndMigrate();
		}
	}

	private openAndMigrate(): Database.Database {
		const db = new Database(this.dbPath);
		try {
			db.pragma('journal_mode = WAL');
			runSqliteMigrations(db, EMBEDDING_MIGRATIONS, LOG_CONTEXT);
			return db;
		} catch (error) {
			try {
				db.close();
			} catch {
				// The original failure is the one worth reporting.
			}
			throw error;
		}
	}

	/**
	 * Move an unreadable database aside. Nothing is lost that cannot be
	 * recomputed, and the stamped name keeps the bytes for anyone who wants to
	 * look at what went wrong.
	 */
	private quarantine(cause: unknown): void {
		const parsed = path.parse(this.dbPath);
		const target = path.join(
			parsed.dir,
			`${parsed.name}.corrupt-${fileTimestampSlug()}${parsed.ext}`
		);
		fs.renameSync(this.dbPath, target);
		for (const suffix of ['-wal', '-shm']) fs.rmSync(this.dbPath + suffix, { force: true });
		logger.warn(
			`Embedding index could not be read (${cause instanceof Error ? cause.message : String(cause)}); moved to ${target} and starting empty`,
			LOG_CONTEXT
		);
	}

	/** Flush the write-ahead log and release the file. Safe to call twice. */
	close(): void {
		this.cache = null;
		if (!this.handle) return;
		const db = this.handle;
		this.handle = null;
		try {
			db.pragma('wal_checkpoint(TRUNCATE)');
		} catch (error) {
			logger.warn(`Embedding index checkpoint failed: ${error}`, LOG_CONTEXT);
		}
		db.close();
	}

	// ------------------------------------------------------------------------
	// Writes
	// ------------------------------------------------------------------------

	/**
	 * Store chunks, replacing any that already exist at the same
	 * (model, source, chunk index). All of them or none: one transaction, and
	 * every row is validated before the first is written.
	 *
	 * A source that now has FEWER chunks than before keeps its old tail; call
	 * {@link deleteBySource} first when re-indexing a source whose text changed.
	 */
	upsertChunks(rows: readonly EmbeddingChunkInput[]): number {
		if (rows.length === 0) return 0;
		for (const row of rows) assertValidChunk(row);

		const db = this.db;
		const statement = db.prepare(UPSERT_CHUNK_SQL);
		const now = Date.now();
		db.transaction(() => {
			for (const row of rows) {
				statement.run(
					embeddingChunkId(row.modelId, row.sourceType, row.sourceId, row.chunkIndex),
					row.sourceType,
					row.sourceId,
					row.agentId ?? null,
					row.chunkIndex,
					row.textHash,
					row.modelId,
					row.vector.length,
					vectorToBlob(row.vector),
					row.createdAt ?? now
				);
			}
		})();

		// Only after the commit, so a rolled-back batch never reaches a search.
		const cache = this.cache;
		if (cache) {
			for (const row of rows) {
				if (row.modelId !== cache.modelId) continue;
				cache.chunks.set(
					embeddingChunkId(row.modelId, row.sourceType, row.sourceId, row.chunkIndex),
					{
						sourceType: row.sourceType,
						sourceId: row.sourceId,
						agentId: row.agentId ?? null,
						chunkIndex: row.chunkIndex,
						vector: l2Normalize(Float32Array.from(row.vector)),
					}
				);
			}
		}
		return rows.length;
	}

	/**
	 * Drop every chunk of one source, under every model. The source is gone (or
	 * about to be re-indexed), so no model's copy of it is worth keeping.
	 */
	deleteBySource(sourceType: EmbeddingSourceType, sourceId: string): number {
		const result = this.db
			.prepare('DELETE FROM embedding_chunks WHERE source_type = ? AND source_id = ?')
			.run(sourceType, sourceId);
		if (this.cache) {
			for (const [id, chunk] of this.cache.chunks) {
				if (chunk.sourceType === sourceType && chunk.sourceId === sourceId) {
					this.cache.chunks.delete(id);
				}
			}
		}
		return Number(result.changes);
	}

	/**
	 * Delete one model's vectors, or every model's when no id is given. The
	 * pages are left for SQLite to reuse; the next index fills them.
	 */
	clear(modelId?: string): number {
		const result =
			modelId === undefined
				? this.db.prepare('DELETE FROM embedding_chunks').run()
				: this.db.prepare('DELETE FROM embedding_chunks WHERE model_id = ?').run(modelId);
		if (this.cache && (modelId === undefined || this.cache.modelId === modelId)) {
			this.cache = null;
		}
		return Number(result.changes);
	}

	/** Clear every model and return SQLite's unused pages to the filesystem. */
	clearAndCompact(): void {
		this.clear();
		this.db.exec('VACUUM');
		this.db.pragma('wal_checkpoint(TRUNCATE)');
	}

	/** Count the files actually on disk, including pages not checkpointed yet. */
	async diskUsageBytes(): Promise<number> {
		const sizes = await Promise.all(
			['', '-wal', '-shm'].map(async (suffix) => {
				try {
					return (await fs.promises.stat(this.dbPath + suffix)).size;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
					throw error;
				}
			})
		);
		return sizes.reduce((sum, size) => sum + size, 0);
	}

	// ------------------------------------------------------------------------
	// Reads
	// ------------------------------------------------------------------------

	/**
	 * The chunks nearest a query, best first.
	 *
	 * Only `modelId`'s vectors are read. A stored vector whose width differs
	 * from the query's is skipped rather than compared: the same model id
	 * serving a different width (an endpoint model swapped under its name) is
	 * stale data, not a match.
	 */
	search(queryVector: Float32Array, options: EmbeddingSearchOptions): EmbeddingSearchHit[] {
		if (queryVector.length === 0) return [];
		const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_EMBEDDING_SEARCH_LIMIT));
		const sourceTypes = options.sourceTypes ? new Set(options.sourceTypes) : null;
		// The caller's vector is left alone; normalizing in place would change it.
		const query = l2Normalize(Float32Array.from(queryVector));

		// Kept sorted best-first and never longer than `limit`, so the scan
		// allocates one hit per result instead of one per stored chunk.
		const top: EmbeddingSearchHit[] = [];
		for (const chunk of this.loadModel(options.modelId).values()) {
			if (chunk.vector.length !== query.length) continue;
			if (sourceTypes && !sourceTypes.has(chunk.sourceType)) continue;
			if (options.agentId !== undefined && chunk.agentId !== options.agentId) continue;

			const score = dotProduct(query, chunk.vector);
			if (top.length === limit && score <= top[top.length - 1].score) continue;

			// After any equal score, so earlier rows win a tie.
			let position = top.length;
			while (position > 0 && top[position - 1].score < score) position--;
			top.splice(position, 0, {
				sourceType: chunk.sourceType,
				sourceId: chunk.sourceId,
				agentId: chunk.agentId,
				chunkIndex: chunk.chunkIndex,
				score,
			});
			if (top.length > limit) top.pop();
		}
		return top;
	}

	/**
	 * Which of `hashes` are already embedded under `modelId`. The indexer asks
	 * before embedding so unchanged text is never sent through the model twice.
	 */
	knownTextHashes(modelId: string, hashes: readonly string[]): Set<string> {
		const known = new Set<string>();
		const unique = [...new Set(hashes)];
		for (let start = 0; start < unique.length; start += HASH_LOOKUP_BATCH) {
			const batch = unique.slice(start, start + HASH_LOOKUP_BATCH);
			const rows = this.db
				.prepare(
					`SELECT DISTINCT text_hash FROM embedding_chunks
					 WHERE model_id = ? AND text_hash IN (${batch.map(() => '?').join(', ')})`
				)
				.all(modelId, ...batch) as Array<{ text_hash: string }>;
			for (const row of rows) known.add(row.text_hash);
		}
		return known;
	}

	/**
	 * Every source of one type embedded under `modelId`, with its chunks' text
	 * hashes in chunk order. The indexer compares this, position by position,
	 * with what a source's text chunks to now: equal lists mean the source is up
	 * to date, and a position that differs is the only one re-embedded.
	 *
	 * Per source on purpose. {@link knownTextHashes} answers "has this text ever
	 * been embedded", which is not enough to skip a chunk: two sources with the
	 * same text each need a row of their own to be found.
	 */
	sourceChunkHashes(modelId: string, sourceType: EmbeddingSourceType): Map<string, string[]> {
		const rows = this.db
			.prepare(
				`SELECT source_id, text_hash FROM embedding_chunks
				 WHERE model_id = ? AND source_type = ?
				 ORDER BY source_id, chunk_index`
			)
			.all(modelId, sourceType) as Array<{ source_id: string; text_hash: string }>;
		const bySource = new Map<string, string[]>();
		for (const row of rows) {
			const hashes = bySource.get(row.source_id);
			if (hashes) hashes.push(row.text_hash);
			else bySource.set(row.source_id, [row.text_hash]);
		}
		return bySource;
	}

	/** Whether one source has any chunk embedded under `modelId`. One indexed lookup. */
	hasSource(modelId: string, sourceType: EmbeddingSourceType, sourceId: string): boolean {
		const row = this.db
			.prepare(
				`SELECT 1 AS present FROM embedding_chunks
				 WHERE source_type = ? AND source_id = ? AND model_id = ?
				 LIMIT 1`
			)
			.get(sourceType, sourceId, modelId);
		return row !== undefined && row !== null;
	}

	/**
	 * The ids of every source of one type with a row under ANY model. What a
	 * prune walks: a source that no longer exists is dead under every model, and
	 * {@link deleteBySource} removes it from all of them.
	 */
	sourceIds(sourceType: EmbeddingSourceType): string[] {
		const rows = this.db
			.prepare('SELECT DISTINCT source_id FROM embedding_chunks WHERE source_type = ?')
			.all(sourceType) as Array<{ source_id: string }>;
		return rows.map((row) => row.source_id);
	}

	/** A bounded page of source metadata. Vector BLOBs never leave SQLite. */
	browse(request: SemanticIndexBrowseRequest): SemanticIndexPage {
		const offset = Math.max(0, Math.floor(request.offset ?? 0));
		const limit = Math.max(1, Math.min(50, Math.floor(request.limit ?? 20)));
		const where = `model_id = ?${request.sourceType ? ' AND source_type = ?' : ''}`;
		const params = request.sourceType ? [request.modelId, request.sourceType] : [request.modelId];
		const grouped = `FROM embedding_chunks WHERE ${where} GROUP BY source_type, source_id, agent_id`;
		const total = this.db
			.prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 ${grouped})`)
			.get(...params) as { count: number };
		const rows = this.db
			.prepare(
				`SELECT source_type, source_id, agent_id, COUNT(*) AS chunks, MAX(created_at) AS indexed_at
				 ${grouped} ORDER BY indexed_at DESC, source_type, source_id, agent_id LIMIT ? OFFSET ?`
			)
			.all(...params, limit, offset) as Array<{
			source_type: EmbeddingSourceType;
			source_id: string;
			agent_id: string | null;
			chunks: number;
			indexed_at: number;
		}>;
		return {
			offset,
			limit,
			total: total.count,
			entries: rows.map((row) => ({
				modelId: request.modelId,
				sourceType: row.source_type,
				sourceId: row.source_id,
				agentId: row.agent_id,
				chunks: row.chunks,
				indexedAt: row.indexed_at,
			})),
		};
	}

	/** What is on disk, per model. Reads the database, not the in-memory copy. */
	stats(): EmbeddingStoreStats {
		const rows = this.db
			.prepare(
				`SELECT model_id, source_type, MAX(dimensions) AS dimensions, COUNT(*) AS chunks
				 FROM embedding_chunks
				 GROUP BY model_id, source_type`
			)
			.all() as Array<{
			model_id: string;
			source_type: string;
			dimensions: number;
			chunks: number;
		}>;

		const byModel = new Map<string, EmbeddingModelStats>();
		for (const row of rows) {
			let model = byModel.get(row.model_id);
			if (!model) {
				model = {
					modelId: row.model_id,
					dimensions: row.dimensions,
					chunks: 0,
					bySourceType: emptySourceCounts(),
				};
				byModel.set(row.model_id, model);
			}
			model.chunks += row.chunks;
			model.dimensions = Math.max(model.dimensions, row.dimensions);
			if (isEmbeddingSourceType(row.source_type)) model.bySourceType[row.source_type] += row.chunks;
		}

		const models = [...byModel.values()].sort(
			(a, b) => b.chunks - a.chunks || a.modelId.localeCompare(b.modelId)
		);
		return {
			totalChunks: models.reduce((sum, model) => sum + model.chunks, 0),
			models,
			sizeBytes: this.pragmaNumber('page_count') * this.pragmaNumber('page_size'),
		};
	}

	private pragmaNumber(name: string): number {
		const rows = this.db.pragma(name) as Array<Record<string, number>>;
		return Number(rows[0]?.[name] ?? 0);
	}

	/**
	 * The in-memory vectors for one model, read from disk the first time and
	 * whenever a different model is asked for. Holding one model at a time is
	 * deliberate: a search never spans two, and the previous model's vectors
	 * are dead weight the moment the assignment changes.
	 */
	private loadModel(modelId: string): Map<string, CachedChunk> {
		if (this.cache?.modelId === modelId) return this.cache.chunks;

		const rows = this.db
			.prepare(
				`SELECT id, source_type, source_id, agent_id, chunk_index, dimensions, vector
				 FROM embedding_chunks
				 WHERE model_id = ?
				 ORDER BY created_at, id`
			)
			.all(modelId) as unknown as ChunkRow[];

		const chunks = new Map<string, CachedChunk>();
		let skipped = 0;
		for (const row of rows) {
			const vector = blobToVector(row.vector, row.dimensions);
			if (!vector || !isEmbeddingSourceType(row.source_type)) {
				skipped++;
				continue;
			}
			chunks.set(row.id, {
				sourceType: row.source_type,
				sourceId: row.source_id,
				agentId: row.agent_id,
				chunkIndex: row.chunk_index,
				vector: l2Normalize(vector),
			});
		}
		if (skipped > 0) {
			logger.warn(`Skipped ${skipped} unreadable embedding row(s) for ${modelId}`, LOG_CONTEXT);
		}
		logger.debug(`Loaded ${chunks.size} embedding vector(s) for ${modelId}`, LOG_CONTEXT);

		this.cache = { modelId, chunks };
		return chunks;
	}
}

// ============================================================================
// Singleton
// ============================================================================

let instance: EmbeddingStore | null = null;

/** The app's one embedding store, over `userData/embeddings.db`. */
export function getEmbeddingStore(): EmbeddingStore {
	if (!instance) {
		instance = new EmbeddingStore(path.join(localModelsDataDir(), EMBEDDINGS_DB_FILENAME));
	}
	return instance;
}

/** Close the store (call on app quit). A later `getEmbeddingStore()` reopens it. */
export function closeEmbeddingStore(): void {
	if (!instance) return;
	instance.close();
	instance = null;
}
