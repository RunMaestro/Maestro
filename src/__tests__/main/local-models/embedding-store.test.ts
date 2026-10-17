/**
 * @vitest-environment node
 *
 * Tests for the semantic index's embedding store.
 *
 * These run the real SQL against a real SQLite file in a temp dir (through the
 * `node:sqlite` shim in `helpers/nodeSqlite.ts`, since `better-sqlite3` is
 * compiled for Electron's Node). What is under test is exactly what a mocked
 * statement cannot show: that a vector survives the round trip through a BLOB,
 * that an upsert replaces rather than duplicates, and that the in-memory copy a
 * search reads stays equal to what is on disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';

vi.mock('better-sqlite3', () => nodeSqliteBetterSqlite3Mock());

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	EmbeddingStore,
	EMBEDDINGS_DB_FILENAME,
	closeEmbeddingStore,
	embeddingChunkId,
	embeddingTextHash,
	getEmbeddingStore,
	type EmbeddingChunkInput,
} from '../../../main/local-models/embedding-store';
import { logger } from '../../../main/utils/logger';

const MODEL = 'bge-small-en-v1.5';
const OTHER_MODEL = 'endpoint:ollama:nomic-embed-text';

function chunk(
	overrides: Omit<Partial<EmbeddingChunkInput>, 'vector'> & { vector: number[] }
): EmbeddingChunkInput {
	const { vector, ...rest } = overrides;
	return {
		sourceType: 'history',
		sourceId: 'entry-1',
		agentId: 'agent-a',
		chunkIndex: 0,
		textHash: embeddingTextHash(`${rest.sourceId ?? 'entry-1'}:${rest.chunkIndex ?? 0}`),
		modelId: MODEL,
		...rest,
		vector: Float32Array.from(vector),
	};
}

describe.skipIf(!canLoadNodeSqlite())('EmbeddingStore', () => {
	let dir: string;
	let dbPath: string;
	let store: EmbeddingStore;

	beforeEach(() => {
		vi.clearAllMocks();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-embeddings-'));
		dbPath = path.join(dir, EMBEDDINGS_DB_FILENAME);
		store = new EmbeddingStore(dbPath);
	});

	afterEach(() => {
		store.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('upsertChunks', () => {
		it('stores chunks and reports them per model and source type', () => {
			const written = store.upsertChunks([
				chunk({ sourceId: 'entry-1', vector: [1, 0, 0] }),
				chunk({ sourceId: 'entry-1', chunkIndex: 1, vector: [0, 1, 0] }),
				chunk({ sourceType: 'transcript', sourceId: 'tab-1', vector: [0, 0, 1] }),
			]);

			expect(written).toBe(3);
			const stats = store.stats();
			expect(stats.totalChunks).toBe(3);
			expect(stats.sizeBytes).toBeGreaterThan(0);
			expect(stats.models).toEqual([
				{
					modelId: MODEL,
					dimensions: 3,
					chunks: 3,
					bySourceType: { history: 2, 'directors-notes': 0, transcript: 1 },
				},
			]);
		});

		it('replaces a chunk written again at the same model, source and index', () => {
			store.upsertChunks([chunk({ vector: [1, 0, 0] })]);
			store.upsertChunks([chunk({ vector: [0, 1, 0], textHash: embeddingTextHash('edited') })]);

			expect(store.stats().totalChunks).toBe(1);
			const [hit] = store.search(Float32Array.from([0, 1, 0]), { modelId: MODEL });
			expect(hit.score).toBeCloseTo(1, 5);
			expect(store.knownTextHashes(MODEL, [embeddingTextHash('edited')]).size).toBe(1);
			expect(store.knownTextHashes(MODEL, [embeddingTextHash('entry-1:0')]).size).toBe(0);
		});

		it('writes nothing when any row in the batch is invalid', () => {
			expect(() =>
				store.upsertChunks([
					chunk({ sourceId: 'good', vector: [1, 0, 0] }),
					chunk({ sourceId: 'bad', vector: [Number.NaN, 0, 0] }),
				])
			).toThrow(/not finite/);
			expect(() => store.upsertChunks([chunk({ vector: [] })])).toThrow(/non-empty vector/);
			expect(() => store.upsertChunks([chunk({ chunkIndex: -1, vector: [1] })])).toThrow(
				/chunk index/
			);
			expect(() =>
				store.upsertChunks([
					chunk({ sourceType: 'nope' as EmbeddingChunkInput['sourceType'], vector: [1] }),
				])
			).toThrow(/Unknown embedding source type/);

			expect(store.stats().totalChunks).toBe(0);
		});

		it('survives closing and reopening the database file', () => {
			store.upsertChunks([
				chunk({ sourceId: 'entry-1', vector: [0.6, 0.8, 0] }),
				chunk({ sourceId: 'entry-2', agentId: null, vector: [0, 0, 1] }),
			]);
			store.close();

			store = new EmbeddingStore(dbPath);
			const hits = store.search(Float32Array.from([0.6, 0.8, 0]), { modelId: MODEL });

			expect(hits.map((hit) => hit.sourceId)).toEqual(['entry-1', 'entry-2']);
			expect(hits[0].score).toBeCloseTo(1, 5);
			expect(hits[0].agentId).toBe('agent-a');
			expect(hits[1].agentId).toBeNull();
			expect(hits[1].score).toBeCloseTo(0, 5);
		});
	});

	describe('search', () => {
		beforeEach(() => {
			store.upsertChunks([
				chunk({ sourceId: 'far', vector: [0, 1, 0] }),
				chunk({ sourceId: 'near', vector: [1, 0.1, 0] }),
				chunk({ sourceId: 'exact', vector: [1, 0, 0] }),
				chunk({ sourceId: 'opposite', vector: [-1, 0, 0] }),
			]);
		});

		it('returns the nearest chunks first', () => {
			const hits = store.search(Float32Array.from([1, 0, 0]), { modelId: MODEL });

			expect(hits.map((hit) => hit.sourceId)).toEqual(['exact', 'near', 'far', 'opposite']);
			expect(hits[0]).toEqual({
				sourceType: 'history',
				sourceId: 'exact',
				agentId: 'agent-a',
				chunkIndex: 0,
				score: expect.closeTo(1, 5),
			});
			expect(hits[3].score).toBeCloseTo(-1, 5);
		});

		it('keeps only the best `limit` hits', () => {
			const hits = store.search(Float32Array.from([1, 0, 0]), { modelId: MODEL, limit: 2 });
			expect(hits.map((hit) => hit.sourceId)).toEqual(['exact', 'near']);
		});

		it('scores by cosine, whatever the length of the stored or query vector', () => {
			store.upsertChunks([chunk({ sourceId: 'long', vector: [50, 0, 0] })]);

			const query = Float32Array.from([7, 0, 0]);
			const hits = store.search(query, { modelId: MODEL, limit: 2 });

			expect(hits.map((hit) => hit.sourceId).sort()).toEqual(['exact', 'long']);
			expect(hits[0].score).toBeCloseTo(1, 5);
			expect(hits[1].score).toBeCloseTo(1, 5);
			// The caller's vector is not normalized in place.
			expect(Array.from(query)).toEqual([7, 0, 0]);
		});

		it('lets the earlier chunk win a tie', () => {
			store.upsertChunks([
				chunk({ sourceId: 'twin-a', vector: [0, 0, 1], createdAt: 1 }),
				chunk({ sourceId: 'twin-b', vector: [0, 0, 1], createdAt: 2 }),
			]);
			const hits = store.search(Float32Array.from([0, 0, 1]), { modelId: MODEL, limit: 2 });
			expect(hits.map((hit) => hit.sourceId)).toEqual(['twin-a', 'twin-b']);
		});

		it('filters by source type and by agent', () => {
			store.upsertChunks([
				chunk({
					sourceType: 'transcript',
					sourceId: 'tab-1',
					agentId: 'agent-b',
					vector: [1, 0, 0],
				}),
				chunk({
					sourceType: 'directors-notes',
					sourceId: 'notes-1',
					agentId: null,
					vector: [1, 0, 0],
				}),
			]);
			const query = Float32Array.from([1, 0, 0]);

			expect(
				store
					.search(query, { modelId: MODEL, sourceTypes: ['transcript', 'directors-notes'] })
					.map((hit) => hit.sourceId)
					.sort()
			).toEqual(['notes-1', 'tab-1']);
			expect(
				store.search(query, { modelId: MODEL, agentId: 'agent-b' }).map((hit) => hit.sourceId)
			).toEqual(['tab-1']);
			expect(store.search(query, { modelId: MODEL, sourceTypes: [] })).toEqual([]);
		});

		it('answers an empty query or an empty index with nothing', () => {
			expect(store.search(new Float32Array(0), { modelId: MODEL })).toEqual([]);
			expect(store.search(Float32Array.from([1, 0, 0]), { modelId: 'never-indexed' })).toEqual([]);
		});

		it('reads disk once, then serves searches and writes from memory', () => {
			const query = Float32Array.from([1, 0, 0]);
			store.search(query, { modelId: MODEL });

			const handle = (store as unknown as { handle: { prepare: (sql: string) => unknown } }).handle;
			const prepare = vi.spyOn(handle, 'prepare');

			expect(store.search(query, { modelId: MODEL })).toHaveLength(4);
			expect(prepare).not.toHaveBeenCalled();

			// A write after the load lands in the same map the search reads.
			store.upsertChunks([chunk({ sourceId: 'fresh', vector: [1, 0, 0], createdAt: 0 })]);
			prepare.mockClear();
			const hits = store.search(query, { modelId: MODEL });
			expect(hits.map((hit) => hit.sourceId)).toContain('fresh');
			expect(hits).toHaveLength(5);
			expect(prepare).not.toHaveBeenCalled();
		});
	});

	describe('model invalidation', () => {
		beforeEach(() => {
			store.upsertChunks([
				chunk({ sourceId: 'old-model', modelId: MODEL, vector: [1, 0, 0] }),
				chunk({ sourceId: 'new-model', modelId: OTHER_MODEL, vector: [1, 0, 0, 0] }),
			]);
		});

		it('never mixes two models in one search', () => {
			expect(
				store.search(Float32Array.from([1, 0, 0]), { modelId: MODEL }).map((hit) => hit.sourceId)
			).toEqual(['old-model']);
			expect(
				store
					.search(Float32Array.from([1, 0, 0, 0]), { modelId: OTHER_MODEL })
					.map((hit) => hit.sourceId)
			).toEqual(['new-model']);
			// Switching back reloads the first model rather than reusing the second's vectors.
			expect(
				store.search(Float32Array.from([1, 0, 0]), { modelId: MODEL }).map((hit) => hit.sourceId)
			).toEqual(['old-model']);
		});

		it('keeps the same source under both models as separate rows', () => {
			store.upsertChunks([
				chunk({ sourceId: 'old-model', modelId: OTHER_MODEL, vector: [0, 1, 0, 0] }),
			]);

			const stats = store.stats();
			expect(stats.totalChunks).toBe(3);
			expect(stats.models.map((model) => [model.modelId, model.chunks, model.dimensions])).toEqual([
				[OTHER_MODEL, 2, 4],
				[MODEL, 1, 3],
			]);
			expect(embeddingChunkId(MODEL, 'history', 'old-model', 0)).not.toBe(
				embeddingChunkId(OTHER_MODEL, 'history', 'old-model', 0)
			);
		});

		it('skips a stored vector whose width differs from the query', () => {
			store.upsertChunks([chunk({ sourceId: 'wrong-width', modelId: MODEL, vector: [1, 0] })]);
			expect(
				store.search(Float32Array.from([1, 0, 0]), { modelId: MODEL }).map((hit) => hit.sourceId)
			).toEqual(['old-model']);
		});

		it('clears one model and leaves the other searchable', () => {
			// Load the model that is about to be cleared, so the cache has to be dropped too.
			store.search(Float32Array.from([1, 0, 0]), { modelId: MODEL });

			expect(store.clear(MODEL)).toBe(1);

			expect(store.search(Float32Array.from([1, 0, 0]), { modelId: MODEL })).toEqual([]);
			expect(store.search(Float32Array.from([1, 0, 0, 0]), { modelId: OTHER_MODEL })).toHaveLength(
				1
			);
			expect(store.stats().models.map((model) => model.modelId)).toEqual([OTHER_MODEL]);
		});

		it('clears everything when no model is named', () => {
			store.search(Float32Array.from([1, 0, 0, 0]), { modelId: OTHER_MODEL });

			expect(store.clear()).toBe(2);

			expect(store.stats()).toMatchObject({ totalChunks: 0, models: [] });
			expect(store.search(Float32Array.from([1, 0, 0, 0]), { modelId: OTHER_MODEL })).toEqual([]);
		});

		it('reports which text hashes a model already has', () => {
			const shared = embeddingTextHash('same text');
			store.upsertChunks([
				chunk({ sourceId: 'hashed', modelId: MODEL, textHash: shared, vector: [1, 0, 0] }),
			]);

			expect(store.knownTextHashes(MODEL, [shared, shared, embeddingTextHash('unseen')])).toEqual(
				new Set([shared])
			);
			// The same text under another model still has to be embedded there.
			expect(store.knownTextHashes(OTHER_MODEL, [shared]).size).toBe(0);
			expect(store.knownTextHashes(MODEL, []).size).toBe(0);
		});

		it('looks up more hashes than one statement can bind', () => {
			const hashes = Array.from({ length: 1200 }, (_, index) => embeddingTextHash(`text-${index}`));
			store.upsertChunks(
				[3, 700, 1199].map((index) =>
					chunk({ sourceId: `entry-${index}`, textHash: hashes[index], vector: [1, 0, 0] })
				)
			);
			expect(store.knownTextHashes(MODEL, hashes)).toEqual(
				new Set([hashes[3], hashes[700], hashes[1199]])
			);
		});
	});

	describe('deleteBySource', () => {
		beforeEach(() => {
			store.upsertChunks([
				chunk({ sourceId: 'entry-1', chunkIndex: 0, vector: [1, 0, 0] }),
				chunk({ sourceId: 'entry-1', chunkIndex: 1, vector: [0.9, 0.1, 0] }),
				chunk({ sourceId: 'entry-2', vector: [0, 1, 0] }),
				chunk({ sourceType: 'transcript', sourceId: 'entry-1', vector: [0, 0, 1] }),
				chunk({ sourceId: 'entry-1', modelId: OTHER_MODEL, vector: [1, 0, 0, 0] }),
			]);
		});

		it('removes every chunk of the source, under every model', () => {
			expect(store.deleteBySource('history', 'entry-1')).toBe(3);

			expect(
				store
					.search(Float32Array.from([1, 0, 0]), { modelId: MODEL })
					.map((hit) => `${hit.sourceType}:${hit.sourceId}`)
					.sort()
			).toEqual(['history:entry-2', 'transcript:entry-1']);
			expect(store.search(Float32Array.from([1, 0, 0, 0]), { modelId: OTHER_MODEL })).toEqual([]);
			expect(store.stats().totalChunks).toBe(2);
		});

		it('drops the chunks from a model that is already in memory', () => {
			const query = Float32Array.from([1, 0, 0]);
			expect(store.search(query, { modelId: MODEL })).toHaveLength(4);

			store.deleteBySource('history', 'entry-1');

			expect(
				store
					.search(query, { modelId: MODEL })
					.map((hit) => `${hit.sourceType}:${hit.sourceId}`)
					.sort()
			).toEqual(['history:entry-2', 'transcript:entry-1']);
		});

		it('reports zero for a source that was never indexed', () => {
			expect(store.deleteBySource('directors-notes', 'missing')).toBe(0);
			expect(store.stats().totalChunks).toBe(5);
		});
	});

	describe('per-source reads for the indexer', () => {
		beforeEach(() => {
			store.upsertChunks([
				chunk({ sourceId: 'entry-1', chunkIndex: 1, textHash: 'h-1b', vector: [0, 1] }),
				chunk({ sourceId: 'entry-1', chunkIndex: 0, textHash: 'h-1a', vector: [1, 0] }),
				chunk({ sourceId: 'entry-2', textHash: 'h-2a', vector: [1, 1] }),
				chunk({ sourceType: 'transcript', sourceId: 'tab-1#m1', textHash: 'h-t', vector: [1, 0] }),
				chunk({ sourceId: 'entry-3', modelId: OTHER_MODEL, textHash: 'h-3a', vector: [1, 0] }),
			]);
		});

		it('lists each source of a type with its hashes in chunk order', () => {
			const hashes = store.sourceChunkHashes(MODEL, 'history');
			expect([...hashes.keys()].sort()).toEqual(['entry-1', 'entry-2']);
			// Written out of order; read back by chunk index.
			expect(hashes.get('entry-1')).toEqual(['h-1a', 'h-1b']);
			expect(hashes.get('entry-2')).toEqual(['h-2a']);
		});

		it('reads one model and one source type, never another', () => {
			expect([...store.sourceChunkHashes(MODEL, 'transcript').keys()]).toEqual(['tab-1#m1']);
			expect([...store.sourceChunkHashes(OTHER_MODEL, 'history').keys()]).toEqual(['entry-3']);
			expect(store.sourceChunkHashes(MODEL, 'directors-notes').size).toBe(0);
		});

		it('lists the source ids of a type under every model, each once', () => {
			expect(store.sourceIds('history').sort()).toEqual(['entry-1', 'entry-2', 'entry-3']);
			expect(store.sourceIds('transcript')).toEqual(['tab-1#m1']);
			expect(store.sourceIds('directors-notes')).toEqual([]);
		});

		it('answers whether one source is embedded under one model', () => {
			expect(store.hasSource(MODEL, 'history', 'entry-1')).toBe(true);
			expect(store.hasSource(MODEL, 'history', 'entry-3')).toBe(false);
			expect(store.hasSource(OTHER_MODEL, 'history', 'entry-3')).toBe(true);
			expect(store.hasSource(MODEL, 'transcript', 'entry-1')).toBe(false);
			expect(store.hasSource(MODEL, 'history', 'missing')).toBe(false);
		});
	});

	describe('a database file that cannot be read', () => {
		it('is moved aside and replaced with an empty index', () => {
			store.close();
			fs.writeFileSync(dbPath, 'this is not a sqlite database, it is a sentence');

			store = new EmbeddingStore(dbPath);
			expect(store.stats()).toMatchObject({ totalChunks: 0, models: [] });

			const quarantined = fs
				.readdirSync(dir)
				.filter((name) => /^embeddings\.corrupt-\d{8}-\d{6}\.db$/.test(name));
			expect(quarantined).toHaveLength(1);
			expect(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8')).toContain('not a sqlite');
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('could not be read'),
				'[EmbeddingStore]'
			);

			// The replacement is a working store.
			store.upsertChunks([chunk({ vector: [1, 0, 0] })]);
			expect(store.search(Float32Array.from([1, 0, 0]), { modelId: MODEL })).toHaveLength(1);
		});
	});

	describe('singleton', () => {
		const previous = process.env.MAESTRO_USER_DATA;

		afterEach(() => {
			closeEmbeddingStore();
			if (previous === undefined) delete process.env.MAESTRO_USER_DATA;
			else process.env.MAESTRO_USER_DATA = previous;
		});

		it('opens embeddings.db in the data dir on first use and reopens after a close', () => {
			process.env.MAESTRO_USER_DATA = dir;

			const first = getEmbeddingStore();
			expect(getEmbeddingStore()).toBe(first);
			// Constructing it opened nothing.
			expect(fs.existsSync(dbPath)).toBe(false);

			first.upsertChunks([chunk({ vector: [1, 0, 0] })]);
			expect(fs.existsSync(dbPath)).toBe(true);

			closeEmbeddingStore();
			const second = getEmbeddingStore();
			expect(second).not.toBe(first);
			expect(second.stats().totalChunks).toBe(1);
		});
	});
});
