/**
 * @file semantic-indexer.test.ts
 *
 * The semantic index's background indexer, with the model (`embed`), the
 * store, and the sources all faked. What is under test is the indexer's own
 * rules, which no real model would make visible:
 *
 *   - **Unchanged text is never embedded twice.** Dedupe is by chunk text
 *     hash, per source and per position.
 *   - **Cue runs are left out unless asked for**, and dropped again when the
 *     setting goes back off.
 *   - **A new entry is indexed without waiting for a pass.**
 *   - **Off means nothing runs**, and an interactive task makes it wait.
 *   - **A source that cannot run is reported as itself**, never substituted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
}));

import {
	INDEX_BATCH_CHUNKS,
	INDEX_MIN_BATCH_REST_MS,
	INDEX_MAX_BATCH_REST_MS,
	INDEX_INCREMENTAL_DELAY_MS,
	INDEX_REFRESH_DELAY_MS,
	INDEX_REPASS_INTERVAL_MS,
	INDEX_STARTUP_DELAY_MS,
	SemanticIndexer,
	type SemanticIndexerDeps,
	type SemanticIndexStore,
} from '../../../main/local-models/semantic-indexer';
import {
	embeddingTextHash,
	type EmbeddingChunkInput,
} from '../../../main/local-models/embedding-store';
import { LocalModelError } from '../../../main/local-models/errors';
import {
	createHistoryReader,
	historyEntryItem,
	type SemanticSourceItem,
	type SemanticSourceReader,
} from '../../../main/local-models/semantic-sources';
import type { LocalModelSource } from '../../../main/local-models/sources';
import type { EmbeddingTaskResult } from '../../../main/local-models/task-router';
import type { EmbeddingSourceType } from '../../../shared/local-models/embedding-index';
import type { HistoryEntry } from '../../../shared/types';
import { captureException } from '../../../main/utils/sentry';

const BGE: LocalModelSource = { type: 'local', modelId: 'bge-small-en-v1.5' };
const BGE_KEY = 'local:bge-small-en-v1.5';
const NOMIC: LocalModelSource = { type: 'endpoint', endpointId: 'ep-1', model: 'nomic' };
const NOMIC_KEY = 'endpoint:ep-1:nomic';

/** One token per word, windows of 4 words: short texts make several chunks. */
const BUDGET = {
	countTokens: (text: string) => text.split(/\s+/).filter(Boolean).length,
	maxTokens: 4,
};

/** An in-memory stand-in for the embedding store, with the same replace-by-id rule. */
class FakeStore implements SemanticIndexStore {
	rows = new Map<string, EmbeddingChunkInput>();

	private key(
		row: Pick<EmbeddingChunkInput, 'modelId' | 'sourceType' | 'sourceId' | 'chunkIndex'>
	) {
		return [row.modelId, row.sourceType, row.sourceId, row.chunkIndex].join('|');
	}

	upsertChunks(rows: readonly EmbeddingChunkInput[]): number {
		for (const row of rows) this.rows.set(this.key(row), row);
		return rows.length;
	}

	deleteBySource(sourceType: EmbeddingSourceType, sourceId: string): number {
		let removed = 0;
		for (const [key, row] of this.rows) {
			if (row.sourceType === sourceType && row.sourceId === sourceId) {
				this.rows.delete(key);
				removed++;
			}
		}
		return removed;
	}

	sourceChunkHashes(modelId: string, sourceType: EmbeddingSourceType): Map<string, string[]> {
		const bySource = new Map<string, string[]>();
		const rows = [...this.rows.values()]
			.filter((row) => row.modelId === modelId && row.sourceType === sourceType)
			.sort((a, b) => a.chunkIndex - b.chunkIndex);
		for (const row of rows) {
			bySource.set(row.sourceId, [...(bySource.get(row.sourceId) ?? []), row.textHash]);
		}
		return bySource;
	}

	sourceIds(sourceType: EmbeddingSourceType): string[] {
		return [
			...new Set(
				[...this.rows.values()]
					.filter((row) => row.sourceType === sourceType)
					.map((row) => row.sourceId)
			),
		];
	}

	hasSource(modelId: string, sourceType: EmbeddingSourceType, sourceId: string): boolean {
		return [...this.rows.values()].some(
			(row) => row.modelId === modelId && row.sourceType === sourceType && row.sourceId === sourceId
		);
	}

	/** Source ids stored under a model, sorted. */
	ids(modelId = BGE_KEY): string[] {
		return [
			...new Set(
				[...this.rows.values()].filter((row) => row.modelId === modelId).map((row) => row.sourceId)
			),
		].sort();
	}

	chunksOf(sourceId: string, modelId = BGE_KEY): EmbeddingChunkInput[] {
		return [...this.rows.values()]
			.filter((row) => row.modelId === modelId && row.sourceId === sourceId)
			.sort((a, b) => a.chunkIndex - b.chunkIndex);
	}
}

function item(
	sourceId: string,
	text: string,
	overrides: Partial<SemanticSourceItem> = {}
): SemanticSourceItem {
	return {
		sourceType: 'history',
		sourceId,
		agentId: 'agent-a',
		text,
		mutable: false,
		...overrides,
	};
}

/** A reader over a mutable array of groups, so a test can change what exists between passes. */
function reader(
	sourceType: EmbeddingSourceType,
	groups: Record<string, SemanticSourceItem[]>
): SemanticSourceReader & { loads: string[] } {
	const loads: string[] = [];
	return {
		sourceType,
		loads,
		async groups() {
			return Object.keys(groups).map((key) => ({
				key,
				async load() {
					loads.push(key);
					return groups[key];
				},
			}));
		},
	};
}

interface Harness {
	indexer: SemanticIndexer;
	store: FakeStore;
	embed: ReturnType<typeof vi.fn<SemanticIndexerDeps['embed']>>;
	/** Every text handed to the model, across calls. */
	embedded: () => string[];
	state: { source: LocalModelSource | null; busy: boolean; releaseBusy: () => void };
}

function harness(
	readers: SemanticSourceReader[],
	overrides: Partial<SemanticIndexerDeps> = {}
): Harness {
	const store = new FakeStore();
	const state: Harness['state'] = { source: BGE, busy: false, releaseBusy: () => {} };
	const embed = vi.fn<SemanticIndexerDeps['embed']>(
		async (texts): Promise<EmbeddingTaskResult> => ({
			status: 'ok',
			vectors: texts.map((text) => new Float32Array([text.length, 1])),
			source: state.source as LocalModelSource,
			durationMs: 1,
		})
	);
	const indexer = new SemanticIndexer({
		resolveSource: () => state.source,
		resolveChunkBudget: async () => BUDGET,
		embed,
		store: () => store,
		readers,
		isInteractiveBusy: () => state.busy,
		whenInteractiveIdle: () =>
			new Promise<void>((resolve) => {
				state.releaseBusy = () => {
					state.busy = false;
					resolve();
				};
			}),
		yieldToEventLoop: async () => {},
		restBetweenBatches: async () => {},
		...overrides,
	});
	return {
		indexer,
		store,
		embed,
		embedded: () => embed.mock.calls.flatMap(([texts]) => [...texts]),
		state,
	};
}

describe('SemanticIndexer', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('a full pass', () => {
		it('embeds every source, chunk by chunk, and reports indexed out of total', async () => {
			const history = reader('history', {
				'agent-a': [item('e1', 'one two three four. five six.'), item('e2', 'short entry')],
			});
			const notes = reader('directors-notes', {
				archive: [item('n1', 'shipped login', { sourceType: 'directors-notes', agentId: null })],
			});
			const { indexer, store, embedded } = harness([history, notes]);
			indexer.start();

			await indexer.runPass();

			// e1 is two sentences that do not fit one window of four words.
			expect(embedded()).toEqual([
				'one two three four.',
				'five six.',
				'short entry',
				'shipped login',
			]);
			expect(store.chunksOf('e1').map((row) => row.chunkIndex)).toEqual([0, 1]);
			expect(store.chunksOf('e1')[1]).toMatchObject({
				sourceType: 'history',
				agentId: 'agent-a',
				modelId: BGE_KEY,
				textHash: embeddingTextHash('five six.'),
			});
			expect(store.chunksOf('n1')[0].agentId).toBeNull();

			const progress = indexer.getProgress();
			expect(progress).toMatchObject({ state: 'idle', indexed: 3, total: 3, modelId: BGE_KEY });
			expect(progress.bySourceType.history).toEqual({ indexed: 2, total: 2 });
			expect(progress.bySourceType['directors-notes']).toEqual({ indexed: 1, total: 1 });
			expect(progress.bySourceType.transcript).toEqual({ indexed: 0, total: 0 });
			expect(progress.lastPassAt).toEqual(expect.any(Number));
			indexer.stop();
		});

		it('knows the total before the first batch, so the bar never grows', async () => {
			const history = reader('history', {
				'agent-a': [item('e1', 'alpha'), item('e2', 'beta')],
				'agent-b': [item('e3', 'gamma')],
			});
			const seen: Array<{ indexed: number; total: number }> = [];
			const { indexer, embed } = harness([history]);
			embed.mockImplementation(async (texts) => {
				seen.push({ indexed: indexer.getProgress().indexed, total: indexer.getProgress().total });
				return {
					status: 'ok',
					vectors: texts.map(() => new Float32Array([1, 0])),
					source: BGE,
					durationMs: 1,
				};
			});
			indexer.start();
			await indexer.runPass();

			expect(seen[0]).toEqual({ indexed: 0, total: 3 });
			indexer.stop();
		});

		it('sends the model small batches of short sources', async () => {
			const many = Array.from({ length: INDEX_BATCH_CHUNKS * 2 + 3 }, (_, i) =>
				item(`e${i}`, `entry ${i}`)
			);
			const { indexer, embed } = harness([reader('history', { 'agent-a': many })]);
			indexer.start();
			await indexer.runPass();

			expect(embed.mock.calls.map(([texts]) => texts.length)).toEqual([
				INDEX_BATCH_CHUNKS,
				INDEX_BATCH_CHUNKS,
				3,
			]);
			indexer.stop();
		});
	});

	describe('long sources', () => {
		it('bounds inference and commits only after every slice succeeds', async () => {
			const sentences = Array.from(
				{ length: INDEX_BATCH_CHUNKS * 2 + 1 },
				(_, i) => `part ${i} has words.`
			);
			const { indexer, embed, store, embedded } = harness([
				reader('transcript', {
					'agent-a': [item('long', sentences.join(' '), { sourceType: 'transcript' })],
				}),
			]);
			embed.mockImplementation(async (texts) => {
				expect(store.chunksOf('long')).toEqual([]);
				return {
					status: 'ok',
					vectors: texts.map((text) => new Float32Array([text.length, 1])),
					source: BGE,
					durationMs: 1,
				};
			});
			indexer.start();
			await indexer.runPass();

			expect(embed.mock.calls.map(([texts]) => texts.length)).toEqual([
				INDEX_BATCH_CHUNKS,
				INDEX_BATCH_CHUNKS,
				1,
			]);
			expect(embedded()).toEqual(sentences);
			expect(store.chunksOf('long').map((row) => row.chunkIndex)).toEqual(
				sentences.map((_, index) => index)
			);
			expect(indexer.getProgress()).toMatchObject({ indexed: 1, total: 1 });
			indexer.stop();
		});

		it('keeps a partially embedded source out of the store after cancellation', async () => {
			const text = Array.from(
				{ length: INDEX_BATCH_CHUNKS + 1 },
				(_, i) => `part ${i} has words.`
			).join(' ');
			const { indexer, embed, store } = harness([reader('history', { a: [item('long', text)] })]);
			embed.mockResolvedValueOnce({
				status: 'ok',
				vectors: Array.from({ length: INDEX_BATCH_CHUNKS }, () => new Float32Array([1, 0])),
				source: BGE,
				durationMs: 1,
			});
			embed.mockResolvedValueOnce({ status: 'cancelled', source: BGE });
			indexer.start();
			await indexer.runPass();

			expect(embed).toHaveBeenCalledTimes(2);
			expect(store.chunksOf('long')).toEqual([]);
			expect(indexer.getProgress().indexed).toBe(0);
			indexer.stop();
		});
	});

	describe('dedupe by text hash', () => {
		it('embeds nothing on a second pass over unchanged sources', async () => {
			const history = reader('history', {
				'agent-a': [item('e1', 'alpha beta'), item('e2', 'gamma')],
			});
			const { indexer, embed } = harness([history]);
			indexer.start();
			await indexer.runPass();
			expect(embed).toHaveBeenCalledTimes(1);

			await indexer.runPass();

			expect(embed).toHaveBeenCalledTimes(1);
			expect(indexer.getProgress()).toMatchObject({ state: 'idle', indexed: 2, total: 2 });
			indexer.stop();
		});

		it('does not re-read a group whose sources are all indexed', async () => {
			const groups: Record<string, SemanticSourceItem[]> = {
				'agent-a': [item('e1', 'alpha')],
				'agent-b': [item('e2', 'beta')],
			};
			const tracked = reader('history', groups);
			const { indexer } = harness([tracked]);
			indexer.start();
			await indexer.runPass();
			tracked.loads.length = 0;

			groups['agent-b'].push(item('e3', 'gamma'));
			await indexer.runPass();

			// Both scanned once; only the group with new work is read a second time.
			expect(tracked.loads).toEqual(['agent-a', 'agent-b', 'agent-b']);
			indexer.stop();
		});

		it('re-embeds only the chunk of a mutable source that changed', async () => {
			const groups = {
				'agent-a': [
					item('tab#m1', 'one two three four. five six.', {
						sourceType: 'transcript',
						mutable: true,
					}),
				],
			};
			const { indexer, store, embedded, embed } = harness([reader('transcript', groups)]);
			indexer.start();
			await indexer.runPass();
			expect(embedded()).toEqual(['one two three four.', 'five six.']);
			embed.mockClear();

			// The turn grew: the first window is the same text, the second is not.
			groups['agent-a'] = [
				item('tab#m1', 'one two three four. five six seven.', {
					sourceType: 'transcript',
					mutable: true,
				}),
			];
			await indexer.runPass();

			expect(embedded()).toEqual(['five six seven.']);
			expect(store.chunksOf('tab#m1').map((row) => row.textHash)).toEqual([
				embeddingTextHash('one two three four.'),
				embeddingTextHash('five six seven.'),
			]);
			expect(indexer.getProgress()).toMatchObject({ indexed: 1, total: 1 });
			indexer.stop();
		});

		it('leaves an unchanged mutable source alone', async () => {
			const groups = {
				'agent-a': [item('tab#m1', 'one two three', { sourceType: 'transcript', mutable: true })],
			};
			const { indexer, embed } = harness([reader('transcript', groups)]);
			indexer.start();
			await indexer.runPass();
			await indexer.runPass();
			expect(embed).toHaveBeenCalledTimes(1);
			indexer.stop();
		});

		it('clears a mutable source that shrank, so no stale tail survives', async () => {
			const groups = {
				'agent-a': [
					item('tab#m1', 'one two three four. five six.', {
						sourceType: 'transcript',
						mutable: true,
					}),
				],
			};
			const { indexer, store } = harness([reader('transcript', groups)]);
			indexer.start();
			await indexer.runPass();
			expect(store.chunksOf('tab#m1')).toHaveLength(2);

			groups['agent-a'] = [item('tab#m1', 'one two', { sourceType: 'transcript', mutable: true })];
			await indexer.runPass();

			expect(store.chunksOf('tab#m1').map((row) => row.textHash)).toEqual([
				embeddingTextHash('one two'),
			]);
			indexer.stop();
		});

		it('gives two sources with the same text a row each', async () => {
			const history = reader('history', {
				'agent-a': [item('e1', 'continue'), item('e2', 'continue')],
			});
			const { indexer, store } = harness([history]);
			indexer.start();
			await indexer.runPass();
			// Both are findable, even though the text (and its hash) is one.
			expect(store.ids()).toEqual(['e1', 'e2']);
			indexer.stop();
		});

		it('does not skip an immutable source just because the store holds its id under another model', async () => {
			const history = reader('history', { 'agent-a': [item('e1', 'alpha')] });
			const { indexer, store, state, embed } = harness([history]);
			indexer.start();
			await indexer.runPass();

			state.source = NOMIC;
			await indexer.runPass();

			expect(embed).toHaveBeenCalledTimes(2);
			expect(store.ids(NOMIC_KEY)).toEqual(['e1']);
			// The old model's rows are left alone, not overwritten.
			expect(store.ids(BGE_KEY)).toEqual(['e1']);
			expect(indexer.getProgress().modelId).toBe(NOMIC_KEY);
			indexer.stop();
		});
	});

	describe('Cue runs', () => {
		const entries: HistoryEntry[] = [
			{ id: 'user-1', type: 'USER', timestamp: 1, summary: 'fixed login', projectPath: '/p' },
			{ id: 'auto-1', type: 'AUTO', timestamp: 2, summary: 'ran playbook', projectPath: '/p' },
			{ id: 'cue-1', type: 'CUE', timestamp: 3, summary: 'lint on save', projectPath: '/p' },
		];

		function cueHarness() {
			const setting = { includeCue: false };
			const history = createHistoryReader({
				listSessions: async () => ['agent-a'],
				getEntries: async () => entries,
				includeCue: () => setting.includeCue,
			});
			return { setting, ...harness([history]) };
		}

		it('are skipped by default', async () => {
			const { indexer, store } = cueHarness();
			indexer.start();
			await indexer.runPass();

			expect(store.ids()).toEqual(['auto-1', 'user-1']);
			expect(indexer.getProgress()).toMatchObject({ indexed: 2, total: 2 });
			indexer.stop();
		});

		it('are indexed once the setting is on, and dropped again when it goes off', async () => {
			const { indexer, store, setting } = cueHarness();
			indexer.start();
			await indexer.runPass();

			setting.includeCue = true;
			await indexer.runPass();
			expect(store.ids()).toEqual(['auto-1', 'cue-1', 'user-1']);
			expect(indexer.getProgress()).toMatchObject({ indexed: 3, total: 3 });

			setting.includeCue = false;
			await indexer.runPass();
			expect(store.ids()).toEqual(['auto-1', 'user-1']);
			expect(indexer.getProgress()).toMatchObject({ indexed: 2, total: 2 });
			indexer.stop();
		});
	});

	describe('pruning', () => {
		it('drops the rows of a source that no longer exists', async () => {
			const groups = { 'agent-a': [item('e1', 'alpha'), item('e2', 'beta')] };
			const { indexer, store } = harness([reader('history', groups)]);
			indexer.start();
			await indexer.runPass();

			groups['agent-a'] = [item('e2', 'beta')];
			await indexer.runPass();

			expect(store.ids()).toEqual(['e2']);
			indexer.stop();
		});

		it('prunes nothing of a type when one of its groups could not be read', async () => {
			let fail = false;
			const flaky: SemanticSourceReader = {
				sourceType: 'history',
				async groups() {
					return [
						{
							key: 'agent-a',
							async load() {
								if (fail) throw new Error('EBUSY');
								return [item('e1', 'alpha')];
							},
						},
					];
				},
			};
			const { indexer, store } = harness([flaky]);
			indexer.start();
			await indexer.runPass();
			expect(store.ids()).toEqual(['e1']);

			fail = true;
			await indexer.runPass();

			// A file that failed to load must not look like deleted entries.
			expect(store.ids()).toEqual(['e1']);
			expect(indexer.getProgress().state).toBe('idle');
			indexer.stop();
		});
	});

	describe('incremental add', () => {
		const added: HistoryEntry = {
			id: 'new-1',
			type: 'USER',
			timestamp: 9,
			summary: 'renamed the tab',
			projectPath: '/p',
		};

		it('indexes a new entry a few seconds after it is written, without a pass', async () => {
			const history = reader('history', { 'agent-a': [item('e1', 'alpha')] });
			const { indexer, store, embed } = harness([history]);
			indexer.start();
			await indexer.runPass();
			history.loads.length = 0;
			embed.mockClear();

			indexer.noteItem(historyEntryItem(added, 'agent-a', false) as SemanticSourceItem);
			expect(embed).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(INDEX_INCREMENTAL_DELAY_MS);

			expect(embed).toHaveBeenCalledTimes(1);
			expect(embed.mock.calls[0][0]).toEqual(['renamed the tab']);
			expect(store.ids()).toEqual(['e1', 'new-1']);
			// No source was re-read to do it.
			expect(history.loads).toEqual([]);
			expect(indexer.getProgress()).toMatchObject({ state: 'idle', indexed: 2, total: 2 });
			indexer.stop();
		});

		it('embeds a burst of new entries as one batch, each once', async () => {
			const { indexer, embed } = harness([reader('history', {})]);
			indexer.start();

			indexer.noteItem(item('n1', 'first'));
			indexer.noteItem(item('n2', 'second'));
			indexer.noteItem(item('n1', 'first'));
			await vi.advanceTimersByTimeAsync(INDEX_INCREMENTAL_DELAY_MS);

			expect(embed).toHaveBeenCalledTimes(1);
			expect(embed.mock.calls[0][0]).toEqual(['first', 'second']);
			indexer.stop();
		});

		it('skips an entry a pass already stored', async () => {
			const history = reader('history', { 'agent-a': [item('e1', 'alpha')] });
			const { indexer, embed } = harness([history]);
			indexer.start();
			await indexer.runPass();
			embed.mockClear();

			indexer.noteItem(item('e1', 'alpha'));
			await vi.advanceTimersByTimeAsync(INDEX_INCREMENTAL_DELAY_MS);

			expect(embed).not.toHaveBeenCalled();
			expect(indexer.getProgress()).toMatchObject({ indexed: 1, total: 1 });
			indexer.stop();
		});

		it('ignores new entries while the task is off', async () => {
			const { indexer, embed, state } = harness([reader('history', {})]);
			state.source = null;
			indexer.start();

			indexer.noteItem(item('n1', 'first'));
			await vi.advanceTimersByTimeAsync(INDEX_INCREMENTAL_DELAY_MS * 2);

			expect(embed).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			indexer.stop();
		});
	});

	describe('off', () => {
		it('arms nothing, reads nothing, and embeds nothing', async () => {
			const history = reader('history', { 'agent-a': [item('e1', 'alpha')] });
			const { indexer, embed, state } = harness([history]);
			state.source = null;

			indexer.start();
			expect(indexer.getProgress().state).toBe('off');
			expect(vi.getTimerCount()).toBe(0);

			await indexer.runPass();
			await vi.advanceTimersByTimeAsync(INDEX_REPASS_INTERVAL_MS * 2);

			expect(history.loads).toEqual([]);
			expect(embed).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			indexer.stop();
		});

		it('starts a pass shortly after a source is assigned', async () => {
			const history = reader('history', { 'agent-a': [item('e1', 'alpha')] });
			const { indexer, store, state } = harness([history]);
			state.source = null;
			indexer.start('off|cue=false');

			state.source = BGE;
			indexer.refresh(`${BGE_KEY}|cue=false`);
			expect(indexer.getProgress().state).toBe('idle');
			await vi.advanceTimersByTimeAsync(INDEX_REFRESH_DELAY_MS);

			expect(store.ids()).toEqual(['e1']);
			indexer.stop();
		});

		it('stops a pass in flight and disarms when the task is switched off', async () => {
			const many = Array.from({ length: INDEX_BATCH_CHUNKS * 3 }, (_, i) =>
				item(`e${i}`, `entry ${i}`)
			);
			const { indexer, embed, state, store } = harness([reader('history', { 'agent-a': many })]);
			embed.mockImplementation(async (texts) => {
				// Switched off while the first batch is with the model.
				state.source = null;
				indexer.refresh('off|cue=false');
				return {
					status: 'ok',
					vectors: texts.map(() => new Float32Array([1, 0])),
					source: BGE,
					durationMs: 1,
				};
			});
			indexer.start(`${BGE_KEY}|cue=false`);

			await indexer.runPass();

			expect(embed).toHaveBeenCalledTimes(1);
			// The batch that came back after the switch is not written.
			expect(store.rows.size).toBe(0);
			expect(indexer.getProgress()).toMatchObject({ state: 'off', indexed: 0, total: 0 });
			expect(vi.getTimerCount()).toBe(0);
			indexer.stop();
		});

		it('does nothing on a settings change that touched neither setting', async () => {
			const { indexer } = harness([reader('history', {})]);
			indexer.start(`${BGE_KEY}|cue=false`);
			const armed = vi.getTimerCount();

			indexer.refresh(`${BGE_KEY}|cue=false`);

			expect(vi.getTimerCount()).toBe(armed);
			indexer.stop();
		});
	});

	describe('clearing the cache', () => {
		it('discards an in-flight batch before clearing and defers a full rebuild', async () => {
			const { indexer, embed, store } = harness([reader('history', { a: [item('e1', 'alpha')] })]);
			let finish!: (value: EmbeddingTaskResult) => void;
			embed.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					})
			);
			indexer.start();
			const pass = indexer.runPass();
			await vi.advanceTimersByTimeAsync(0);
			const clear = vi.fn(() => store.rows.clear());
			const clearing = indexer.clearIndex(clear);
			expect(clear).not.toHaveBeenCalled();
			finish({ status: 'ok', vectors: [new Float32Array([1, 0])], source: BGE, durationMs: 1 });
			await Promise.all([pass, clearing]);
			expect(clear).toHaveBeenCalledOnce();
			expect(store.rows.size).toBe(0);
			expect(indexer.getProgress()).toMatchObject({ state: 'idle', indexed: 0, total: 1 });
			await vi.advanceTimersByTimeAsync(INDEX_REPASS_INTERVAL_MS - 1);
			expect(embed).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(store.ids()).toEqual(['e1']);
			indexer.stop();
		});

		it('clears even while an interactive task keeps the indexer paused', async () => {
			const { indexer, state, embed } = harness([reader('history', { a: [item('e1', 'alpha')] })]);
			state.busy = true;
			indexer.start();
			const pass = indexer.runPass();
			await vi.advanceTimersByTimeAsync(0);
			expect(indexer.getProgress().state).toBe('paused');
			const clear = vi.fn();
			await Promise.all([pass, indexer.clearIndex(clear)]);
			expect(clear).toHaveBeenCalledOnce();
			expect(embed).not.toHaveBeenCalled();
			indexer.stop();
		});

		it('reports a clear failure to the caller while leaving future passes usable', async () => {
			const { indexer } = harness([]);
			indexer.start();
			await expect(
				indexer.clearIndex(() => {
					throw new Error('disk is full');
				})
			).rejects.toThrow('disk is full');
			await indexer.runPass();
			expect(indexer.getProgress().state).toBe('idle');
			indexer.stop();
		});
	});

	describe('scheduling', () => {
		it.each([0, 200, 10_000])(
			'rests after a %i ms model call within the background limits',
			async (runtimeMs) => {
				let now = 0;
				const rest = vi.fn(async () => {});
				const { indexer, embed } = harness([reader('history', { a: [item('e1', 'alpha')] })], {
					now: () => now,
					restBetweenBatches: rest,
				});
				embed.mockImplementation(async (texts) => {
					now += runtimeMs;
					return {
						status: 'ok',
						vectors: texts.map(() => new Float32Array([1, 0])),
						source: BGE,
						durationMs: runtimeMs,
					};
				});
				indexer.start();
				await indexer.runPass();
				expect(rest).toHaveBeenCalledWith(
					Math.min(INDEX_MAX_BATCH_REST_MS, Math.max(INDEX_MIN_BATCH_REST_MS, runtimeMs)),
					expect.any(AbortSignal)
				);
				indexer.stop();
			}
		);

		it('aborts the production rest timer when indexing is switched off', async () => {
			const { indexer, embed, state, store } = harness(
				[reader('history', { a: [item('e1', 'alpha')] })],
				{ restBetweenBatches: undefined }
			);
			indexer.start('on');
			const pass = indexer.runPass();
			await vi.advanceTimersByTimeAsync(0);
			expect(embed).toHaveBeenCalledTimes(1);
			state.source = null;
			indexer.refresh('off');
			await pass;
			expect(store.rows.size).toBe(0);
			expect(indexer.getProgress().state).toBe('off');
			expect(vi.getTimerCount()).toBe(0);
		});

		it('waits a minute after launch, then passes again on an interval', async () => {
			const history = reader('history', { 'agent-a': [item('e1', 'alpha')] });
			const { indexer, store } = harness([history]);
			indexer.start();

			await vi.advanceTimersByTimeAsync(INDEX_STARTUP_DELAY_MS - 1);
			expect(history.loads).toEqual([]);
			await vi.advanceTimersByTimeAsync(1);
			expect(store.ids()).toEqual(['e1']);

			history.loads.length = 0;
			await vi.advanceTimersByTimeAsync(INDEX_REPASS_INTERVAL_MS);
			expect(history.loads).toEqual(['agent-a']);
			indexer.stop();
		});

		it('holds no timer after stop', async () => {
			const { indexer } = harness([reader('history', {})]);
			indexer.start();
			indexer.noteItem(item('n1', 'first'));
			expect(vi.getTimerCount()).toBeGreaterThan(0);

			indexer.stop();

			expect(vi.getTimerCount()).toBe(0);
		});
	});

	describe('standing aside for interactive tasks', () => {
		it('lets an interactive request run between slices of one long source', async () => {
			const text = Array.from(
				{ length: INDEX_BATCH_CHUNKS + 1 },
				(_, i) => `part ${i} has words.`
			).join(' ');
			const { indexer, embed, state, store } = harness([
				reader('history', { a: [item('long', text)] }),
			]);
			embed.mockImplementation(async (texts) => {
				if (embed.mock.calls.length === 1) state.busy = true;
				return {
					status: 'ok',
					vectors: texts.map(() => new Float32Array([1, 0])),
					source: BGE,
					durationMs: 1,
				};
			});
			indexer.start();
			const pass = indexer.runPass();
			await vi.advanceTimersByTimeAsync(0);
			expect(indexer.getProgress().state).toBe('paused');
			expect(embed).toHaveBeenCalledTimes(1);
			expect(store.chunksOf('long')).toEqual([]);
			state.releaseBusy();
			await pass;
			expect(embed).toHaveBeenCalledTimes(2);
			expect(store.chunksOf('long')).toHaveLength(INDEX_BATCH_CHUNKS + 1);
			indexer.stop();
		});

		it('pauses before a batch while one is running, and resumes when it ends', async () => {
			const history = reader('history', { 'agent-a': [item('e1', 'alpha')] });
			const { indexer, embed, state, store } = harness([history]);
			const states: string[] = [];
			indexer.onProgress((progress) => states.push(progress.state));
			state.busy = true;
			indexer.start();

			const pass = indexer.runPass();
			await vi.advanceTimersByTimeAsync(0);
			expect(indexer.getProgress().state).toBe('paused');
			expect(embed).not.toHaveBeenCalled();

			state.releaseBusy();
			await pass;

			expect(embed).toHaveBeenCalledTimes(1);
			expect(store.ids()).toEqual(['e1']);
			expect(states).toEqual(expect.arrayContaining(['indexing', 'paused', 'idle']));
			expect(states.indexOf('paused')).toBeLessThan(states.lastIndexOf('indexing'));
			indexer.stop();
		});
	});

	describe('a source that cannot run', () => {
		it('reports a model that is not downloaded before reading any file', async () => {
			const history = reader('history', { 'agent-a': [item('e1', 'alpha')] });
			const { indexer, embed } = harness([history], {
				resolveChunkBudget: async () => {
					throw new LocalModelError('BGE Small is not downloaded.', {
						code: 'model-not-installed',
						recovery: 'Download it in Settings -> Local Models.',
						consumerId: 'test',
					});
				},
			});
			indexer.start();

			await indexer.runPass();

			expect(indexer.getProgress()).toMatchObject({
				state: 'unavailable',
				reason: 'BGE Small is not downloaded. Download it in Settings -> Local Models.',
			});
			expect(history.loads).toEqual([]);
			expect(embed).not.toHaveBeenCalled();
			indexer.stop();
		});

		it('stops at an unavailable verdict, keeps what it stored, and tries again later', async () => {
			const groups = { 'agent-a': [item('e1', 'alpha')], 'agent-b': [item('e2', 'beta')] };
			const { indexer, embed, store } = harness([reader('history', groups)]);
			embed
				.mockResolvedValueOnce({
					status: 'unavailable',
					source: BGE,
					reason: 'Ollama is not reachable.',
					code: 'network',
				})
				.mockImplementation(async (texts) => ({
					status: 'ok',
					vectors: texts.map(() => new Float32Array([1, 0])),
					source: BGE,
					durationMs: 1,
				}));
			indexer.start();

			await indexer.runPass();
			expect(indexer.getProgress()).toMatchObject({
				state: 'unavailable',
				reason: 'Ollama is not reachable.',
			});
			expect(store.rows.size).toBe(0);

			await vi.advanceTimersByTimeAsync(INDEX_REPASS_INTERVAL_MS);
			expect(store.ids()).toEqual(['e1', 'e2']);
			expect(indexer.getProgress()).toMatchObject({ state: 'idle', indexed: 2, total: 2 });
			expect(indexer.getProgress().reason).toBeUndefined();
			indexer.stop();
		});

		it('never files vectors from another source under the assigned one', async () => {
			const history = reader('history', { 'agent-a': [item('e1', 'alpha')] });
			const { indexer, embed, store } = harness([history]);
			embed.mockResolvedValue({
				status: 'ok',
				vectors: [new Float32Array([1, 0])],
				source: NOMIC,
				durationMs: 1,
			});
			indexer.start();

			await indexer.runPass();

			expect(store.rows.size).toBe(0);
			indexer.stop();
		});

		it('reports an unexpected failure to Sentry and says so, without throwing', async () => {
			const history = reader('history', { 'agent-a': [item('e1', 'alpha')] });
			const { indexer, embed } = harness([history]);
			embed.mockRejectedValue(new Error('session exploded'));
			indexer.start();

			await expect(indexer.runPass()).resolves.toBeUndefined();

			expect(indexer.getProgress()).toMatchObject({
				state: 'unavailable',
				reason: 'Indexing failed: session exploded',
			});
			expect(captureException).toHaveBeenCalledTimes(1);
			indexer.stop();
		});
	});

	describe('progress', () => {
		it('hands out copies, so a listener cannot change the indexer state', async () => {
			const { indexer } = harness([reader('history', { 'agent-a': [item('e1', 'alpha')] })]);
			indexer.start();
			await indexer.runPass();

			const snapshot = indexer.getProgress();
			snapshot.indexed = 99;
			snapshot.bySourceType.history.total = 99;

			expect(indexer.getProgress()).toMatchObject({ indexed: 1 });
			expect(indexer.getProgress().bySourceType.history.total).toBe(1);
			indexer.stop();
		});

		it('keeps one failing listener from silencing the rest', async () => {
			const { indexer } = harness([reader('history', {})]);
			const heard = vi.fn();
			indexer.onProgress(() => {
				throw new Error('listener bug');
			});
			const release = indexer.onProgress(heard);
			indexer.start();

			await indexer.runPass();
			expect(heard).toHaveBeenCalled();

			heard.mockClear();
			release();
			await indexer.runPass();
			expect(heard).not.toHaveBeenCalled();
			indexer.stop();
		});
	});
});
