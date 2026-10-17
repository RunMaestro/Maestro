/**
 * The semantic index's background indexer: it turns what Maestro stores
 * (History entries, Director's Notes synopses, persisted AI tab transcripts)
 * into vectors in the embedding store, and keeps them current.
 *
 * What it promises:
 *
 *   - **Off means nothing runs.** With Semantic search assigned no source the
 *     indexer holds no timer, reads no file, and loads no model. It starts
 *     again when {@link SemanticIndexer.refresh} sees an assignment.
 *   - **It stands aside.** Before every batch it waits for any interactive
 *     Local Models task to finish (`whenNoInteractiveLocalTask`), and its own
 *     calls are marked `background` so they never hold each other up. A search
 *     waits behind at most the one batch already in flight.
 *   - **It never blocks the UI.** Text is read one group at a time, a text is
 *     bounded before it is tokenized (`chunkText`), and the event loop gets a
 *     turn between sources.
 *   - **Unchanged text is never embedded twice.** A source is compared with the
 *     store by its chunks' text hashes, position by position, and only a
 *     position that differs reaches the model. An immutable source (a History
 *     entry, a synopsis, a finished turn) is skipped the moment the store
 *     holds it, without being read past its id.
 *   - **A model change re-embeds lazily.** Rows are keyed by the assigned
 *     source ({@link localModelSourceKey}); under a new one every source reads
 *     as missing and the next pass fills it in. The old rows are left alone.
 *   - **No fallback.** A source that cannot run stops the pass and is reported
 *     as itself; nothing reaches for another model.
 *
 * A full PASS has two phases. The scan lists every source and counts what is
 * already indexed, so the total is known before the first batch (a progress
 * bar whose total grew while it filled would promise nothing), then drops
 * rows whose source no longer exists. The embed phase re-reads only the groups
 * that had work. New History entries and synopses skip the wait for the next
 * pass: they arrive through {@link SemanticIndexer.noteItem}.
 *
 * Everything the indexer touches is injected ({@link SemanticIndexerDeps}), so
 * its rules are tested against arrays and a fake `embed`; the production
 * wiring is {@link startSemanticIndexer}.
 */

import {
	EMBEDDING_SOURCE_TYPES,
	emptySemanticIndexProgress,
	type EmbeddingSourceType,
	type SemanticIndexProgress,
	type SemanticIndexState,
} from '../../shared/local-models/embedding-index';
import { estimateTokenCount } from '../../shared/formatters';
import { resolveLocalModelAssignment } from '../../shared/local-models/tasks';
import type { HistoryEntry } from '../../shared/types';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import {
	onDirectorNotesArchived,
	readDirectorNotesArchive,
	type ArchivedSynopsis,
} from './directors-notes-archive';
import {
	embeddingTextHash,
	getEmbeddingStore,
	type EmbeddingChunkInput,
	type EmbeddingStore,
} from './embedding-store';
import { isLocalModelEndpointError, isLocalModelError } from './errors';
import { resolveInstalledEncoder } from './onnx-encoder';
import {
	createDirectorNotesReader,
	createHistoryReader,
	createTranscriptReader,
	historyEntryItem,
	synopsisItem,
	type HistoryReaderDeps,
	type SemanticSourceGroup,
	type SemanticSourceItem,
	type SemanticSourceReader,
} from './semantic-sources';
import {
	localModelSourceKey,
	readLocalModelAssignments,
	sourceForAssignment,
	type LocalModelSource,
} from './sources';
import {
	isInteractiveLocalTaskRunning,
	runEmbeddingTask,
	whenNoInteractiveLocalTask,
	type EmbeddingTaskResult,
} from './task-router';
import { CHUNK_TARGET_TOKENS, chunkText } from './text-chunker';
import { loadTokenizer } from './tokenizer';

const LOG_CONTEXT = '[SemanticIndexer]';

/** Who the core names when a refusal reaches a person. */
const CONSUMER_ID = 'local-models:semantic-index';

/** The task whose assignment decides whether, and on what, the indexer runs. */
export const SEMANTIC_INDEX_TASK_ID = 'semantic-search';

/** The setting that opts Cue runs into the index. */
export const SEMANTIC_INDEX_CUE_SETTING = 'semanticIndexCue';

/** Chunks sent to the model per call. Small, so a waiting search is not kept long. */
export const INDEX_BATCH_CHUNKS = 32;

/** Wait after launch before the first pass: startup has better uses for the CPU. */
export const INDEX_STARTUP_DELAY_MS = 60_000;

/** Wait after a settings change, so a run of picker changes is one pass. */
export const INDEX_REFRESH_DELAY_MS = 5_000;

/** Wait after a new entry, so a burst of them is one batch. */
export const INDEX_INCREMENTAL_DELAY_MS = 3_000;

/**
 * Time between passes. A pass over an index that is up to date reads each
 * group once and embeds nothing; it is what picks up transcripts (which have
 * no write hook) and History written by another process.
 */
export const INDEX_REPASS_INTERVAL_MS = 15 * 60_000;

/** Progress pushes are spaced at least this far apart; a state change always goes out. */
const PROGRESS_EMIT_INTERVAL_MS = 250;

/**
 * Tokens kept free in a model's window for what is added around a chunk: the
 * model's special tokens and its document prefix.
 */
const WINDOW_RESERVE_TOKENS = 24;

/** How a source's text is measured and how long a window may be. */
export interface ChunkBudget {
	countTokens: (text: string) => number;
	maxTokens: number;
}

/** The store calls the indexer makes. `EmbeddingStore` satisfies it. */
export type SemanticIndexStore = Pick<
	EmbeddingStore,
	'upsertChunks' | 'deleteBySource' | 'sourceChunkHashes' | 'sourceIds' | 'hasSource'
>;

export interface SemanticIndexerDeps {
	/** The source Semantic search is assigned, or `null` when the task is off. */
	resolveSource: () => LocalModelSource | null;
	/**
	 * How to measure text for that source. Throws a classified error when the
	 * source cannot be used (a model that is not downloaded), which the indexer
	 * reports as `unavailable` before it has read a single file.
	 */
	resolveChunkBudget: (source: LocalModelSource) => Promise<ChunkBudget>;
	/** Embed document texts through the task router, as a background call. */
	embed: (texts: readonly string[], signal: AbortSignal) => Promise<EmbeddingTaskResult>;
	/** The embedding store. A getter, so nothing opens the database while off. */
	store: () => SemanticIndexStore;
	readers: readonly SemanticSourceReader[];
	/** Whether an interactive Local Models task is running right now. */
	isInteractiveBusy: () => boolean;
	/** Resolves when no interactive task is running. */
	whenInteractiveIdle: () => Promise<void>;
	/** Give the event loop a turn. Defaults to `setImmediate`. */
	yieldToEventLoop?: () => Promise<void>;
	now?: () => number;
}

/** One source with work to do: its chunks, and which of them need a vector. */
interface SourcePlan {
	item: SemanticSourceItem;
	chunks: string[];
	hashes: string[];
	/** Chunk indices to embed and write. */
	needs: number[];
	/** The source now has fewer chunks than are stored: clear it first. */
	replace: boolean;
}

/** Thrown inside a pass to end it early. Never leaves the indexer. */
class PassStopped extends Error {
	constructor(
		readonly state: SemanticIndexState,
		readonly reason?: string
	) {
		super(reason ?? state);
	}
}

function sameHashes(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * Exported for tests; production code shares {@link getSemanticIndexer}.
 */
export class SemanticIndexer {
	private progress: SemanticIndexProgress = emptySemanticIndexProgress('off');
	private readonly listeners = new Set<(progress: SemanticIndexProgress) => void>();
	private lastEmitAt = 0;

	private started = false;
	private passTimer: ReturnType<typeof setTimeout> | null = null;
	private incrementalTimer: ReturnType<typeof setTimeout> | null = null;
	/** Passes and incremental batches run one at a time, in order. */
	private work: Promise<void> = Promise.resolve();
	private abort: AbortController | null = null;
	/** What the last {@link refresh} saw, so an unrelated settings change is a no-op. */
	private seenConfig: string | null = null;
	private incoming: SemanticSourceItem[] = [];
	private lastPassAt: number | undefined;

	constructor(private readonly deps: SemanticIndexerDeps) {}

	// ------------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------------

	/**
	 * Begin keeping the index current. Arms the first pass
	 * {@link INDEX_STARTUP_DELAY_MS} from now when a source is assigned, and
	 * nothing at all when the task is off.
	 */
	start(configKey?: string): void {
		if (this.started) return;
		this.started = true;
		this.seenConfig = configKey ?? null;
		if (this.deps.resolveSource()) {
			this.setState('idle');
			this.schedulePass(INDEX_STARTUP_DELAY_MS);
		} else {
			this.setState('off');
		}
	}

	/** Stop for good (app quit): abort the batch in flight and drop every timer. */
	stop(): void {
		this.started = false;
		this.clearTimers();
		this.abort?.abort();
		this.incoming = [];
	}

	/**
	 * A setting the indexer depends on may have changed. `configKey` is whatever
	 * the caller derives from those settings; an unchanged key does nothing, so
	 * this is safe to call on every settings write.
	 *
	 * Going off aborts the pass in flight and disarms everything. Anything else
	 * (a first assignment, a different model, the Cue switch) arms a pass.
	 */
	refresh(configKey: string): void {
		if (!this.started || configKey === this.seenConfig) return;
		this.seenConfig = configKey;
		this.clearTimers();
		this.abort?.abort();
		if (!this.deps.resolveSource()) {
			this.incoming = [];
			this.progress = emptySemanticIndexProgress('off');
			this.emit(true);
			return;
		}
		if (this.progress.state === 'off') this.setState('idle');
		this.schedulePass(INDEX_REFRESH_DELAY_MS);
	}

	/**
	 * A source that was just written (a History entry, a synopsis). Embedded
	 * within a few seconds instead of at the next pass. Ignored while off.
	 */
	noteItem(item: SemanticSourceItem): void {
		if (!this.started || !this.deps.resolveSource()) return;
		this.incoming.push(item);
		if (this.incrementalTimer) return;
		this.incrementalTimer = this.timer(INDEX_INCREMENTAL_DELAY_MS, () => {
			this.incrementalTimer = null;
			void this.enqueue(() => this.indexIncoming());
		});
	}

	getProgress(): SemanticIndexProgress {
		return {
			...this.progress,
			bySourceType: Object.fromEntries(
				EMBEDDING_SOURCE_TYPES.map((type) => [type, { ...this.progress.bySourceType[type] }])
			) as SemanticIndexProgress['bySourceType'],
		};
	}

	/** Progress pushes: every state change, and counts no more often than every quarter second. */
	onProgress(listener: (progress: SemanticIndexProgress) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Run one full pass now, after any work already queued. Resolves when it has
	 * finished, stopped, or been refused; it never rejects.
	 */
	runPass(): Promise<void> {
		return this.enqueue(() => this.pass());
	}

	// ------------------------------------------------------------------------
	// Scheduling
	// ------------------------------------------------------------------------

	private timer(delayMs: number, run: () => void): ReturnType<typeof setTimeout> {
		const handle = setTimeout(run, delayMs);
		// The index must never be the reason the app stays alive.
		handle.unref?.();
		return handle;
	}

	private schedulePass(delayMs: number): void {
		if (!this.started) return;
		if (this.passTimer) clearTimeout(this.passTimer);
		this.passTimer = this.timer(delayMs, () => {
			this.passTimer = null;
			void this.runPass();
		});
	}

	private clearTimers(): void {
		if (this.passTimer) clearTimeout(this.passTimer);
		if (this.incrementalTimer) clearTimeout(this.incrementalTimer);
		this.passTimer = null;
		this.incrementalTimer = null;
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const next = this.work.then(task, task);
		this.work = next.catch(() => undefined);
		return this.work;
	}

	// ------------------------------------------------------------------------
	// Progress
	// ------------------------------------------------------------------------

	private setState(state: SemanticIndexState, reason?: string): void {
		const { reason: _previous, ...rest } = this.progress;
		this.progress = { ...rest, state, ...(reason !== undefined ? { reason } : {}) };
		this.emit(true);
	}

	private emit(force = false): void {
		const now = (this.deps.now ?? Date.now)();
		if (!force && now - this.lastEmitAt < PROGRESS_EMIT_INTERVAL_MS) return;
		this.lastEmitAt = now;
		const snapshot = this.getProgress();
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch (error) {
				logger.warn(`Semantic index progress listener failed: ${error}`, LOG_CONTEXT);
			}
		}
	}

	private count(type: EmbeddingSourceType, field: 'indexed' | 'total', by = 1): void {
		this.progress.bySourceType[type][field] += by;
		this.progress[field] += by;
	}

	private yieldTurn(): Promise<void> {
		return this.deps.yieldToEventLoop?.() ?? new Promise<void>((resolve) => setImmediate(resolve));
	}

	// ------------------------------------------------------------------------
	// A pass
	// ------------------------------------------------------------------------

	private async pass(): Promise<void> {
		if (!this.started) return;
		const source = this.deps.resolveSource();
		if (!source) {
			this.progress = emptySemanticIndexProgress('off');
			this.emit(true);
			return;
		}

		const controller = new AbortController();
		this.abort = controller;
		const modelId = localModelSourceKey(source);
		try {
			const budget = await this.deps.resolveChunkBudget(source);
			this.progress = { ...emptySemanticIndexProgress('indexing'), modelId };
			if (this.lastPassAt !== undefined) this.progress.lastPassAt = this.lastPassAt;
			this.emit(true);

			const scanned = [];
			for (const reader of this.deps.readers) {
				scanned.push(await this.scan(reader, modelId, budget, controller.signal));
			}
			for (const { reader, stored, pending, live, done } of scanned) {
				for (const group of pending) {
					this.throwIfStopped(controller.signal, modelId);
					const items = await group.load();
					const plans: SourcePlan[] = [];
					for (const item of items) {
						if (!live.has(item.sourceId)) {
							// Written since the scan: count it, so indexed never passes total.
							live.add(item.sourceId);
							this.count(reader.sourceType, 'total');
						}
						const known = stored.get(item.sourceId);
						if (known && known.length > 0 && !item.mutable) continue;
						const plan = this.plan(item, known, budget);
						if (plan) plans.push(plan);
						// Chunking ran on this thread; let something else have it.
						await this.yieldTurn();
					}
					await this.embedPlans(plans, modelId, controller.signal, done);
				}
			}

			this.lastPassAt = (this.deps.now ?? Date.now)();
			this.progress.lastPassAt = this.lastPassAt;
			this.setState('idle');
		} catch (error) {
			this.endPass(error, modelId);
		} finally {
			if (this.abort === controller) this.abort = null;
			// Off holds no timer; every other outcome tries again later. A pass
			// already armed (by a settings change that aborted this one) is sooner
			// and is left alone.
			if (this.started && this.progress.state !== 'off' && !this.passTimer) {
				this.schedulePass(INDEX_REPASS_INTERVAL_MS);
			}
		}
	}

	/**
	 * Phase one for one reader: count what exists and what is already indexed,
	 * note which groups have work, and drop rows whose source is gone.
	 *
	 * A reader or group that cannot be read is logged and skipped, and then
	 * NOTHING of that type is pruned this pass: a History file that failed to
	 * load must not look like a thousand deleted entries.
	 */
	private async scan(
		reader: SemanticSourceReader,
		modelId: string,
		budget: ChunkBudget,
		signal: AbortSignal
	): Promise<{
		reader: SemanticSourceReader;
		stored: Map<string, string[]>;
		pending: SemanticSourceGroup[];
		/** Every source id the reader produced. */
		live: Set<string>;
		/** Source ids already counted as indexed, so none is counted twice. */
		done: Set<string>;
	}> {
		const store = this.deps.store();
		const stored = store.sourceChunkHashes(modelId, reader.sourceType);
		const live = new Set<string>();
		const done = new Set<string>();
		const pending: SemanticSourceGroup[] = [];
		let complete = true;

		let groups: SemanticSourceGroup[] = [];
		try {
			groups = await reader.groups();
		} catch (error) {
			complete = false;
			logger.warn(`Could not list ${reader.sourceType} sources: ${error}`, LOG_CONTEXT);
		}

		for (const group of groups) {
			this.throwIfStopped(signal, modelId);
			let items: SemanticSourceItem[];
			try {
				items = await group.load();
			} catch (error) {
				complete = false;
				logger.warn(
					`Could not read ${reader.sourceType} group ${group.key}: ${error}`,
					LOG_CONTEXT
				);
				continue;
			}
			let hasWork = false;
			for (const item of items) {
				if (live.has(item.sourceId)) continue;
				live.add(item.sourceId);
				this.count(reader.sourceType, 'total');

				// A source the store has never seen is work, and is NOT chunked here:
				// a first pass would otherwise tokenize all of History in one go.
				// Only a mutable source the store holds must be chunked to compare.
				const known = stored.get(item.sourceId);
				let upToDate = false;
				if (known && known.length > 0) {
					upToDate = !item.mutable || this.plan(item, known, budget) === null;
					if (item.mutable) await this.yieldTurn();
				}
				if (upToDate) {
					done.add(item.sourceId);
					this.count(reader.sourceType, 'indexed');
				} else {
					hasWork = true;
				}
			}
			if (hasWork) pending.push(group);
			this.emit();
			await this.yieldTurn();
		}

		if (complete) {
			let pruned = 0;
			for (const sourceId of store.sourceIds(reader.sourceType)) {
				if (live.has(sourceId)) continue;
				pruned += store.deleteBySource(reader.sourceType, sourceId);
				stored.delete(sourceId);
			}
			if (pruned > 0) {
				logger.debug(
					`Dropped ${pruned} chunk(s) of ${reader.sourceType} sources that no longer exist`,
					LOG_CONTEXT
				);
			}
		}
		return { reader, stored, pending, live, done };
	}

	/**
	 * What one source needs, or `null` when the store already has it.
	 *
	 * `stored` is the source's chunk hashes under the assigned model. An
	 * immutable source that has any is done without its text being chunked;
	 * everything else is chunked and compared position by position.
	 */
	private plan(
		item: SemanticSourceItem,
		stored: readonly string[] | undefined,
		budget: ChunkBudget
	): SourcePlan | null {
		if (stored && stored.length > 0 && !item.mutable) return null;
		const chunks = chunkText(item.text, budget);
		if (chunks.length === 0) return null;
		const hashes = chunks.map(embeddingTextHash);
		if (stored && sameHashes(stored, hashes)) return null;

		const replace = (stored?.length ?? 0) > hashes.length;
		const needs: number[] = [];
		for (let index = 0; index < hashes.length; index++) {
			if (replace || stored?.[index] !== hashes[index]) needs.push(index);
		}
		return { item, chunks, hashes, needs, replace };
	}

	/** Embed and store plans, a batch of whole sources at a time. */
	private async embedPlans(
		plans: readonly SourcePlan[],
		modelId: string,
		signal: AbortSignal,
		done: Set<string> = new Set()
	): Promise<void> {
		let batch: SourcePlan[] = [];
		let size = 0;
		for (const plan of plans) {
			batch.push(plan);
			size += plan.needs.length;
			if (size >= INDEX_BATCH_CHUNKS) {
				await this.embedBatch(batch, modelId, signal, done);
				batch = [];
				size = 0;
			}
		}
		if (batch.length > 0) await this.embedBatch(batch, modelId, signal, done);
	}

	/**
	 * One call to the model, then one write per source. A source's chunks are
	 * written together, so an interrupted pass never leaves half a source
	 * looking like a whole one.
	 */
	private async embedBatch(
		batch: readonly SourcePlan[],
		modelId: string,
		signal: AbortSignal,
		done: Set<string>
	): Promise<void> {
		// Interactive work first. Checked again after the wait: another task may
		// have started in the meantime.
		while (this.deps.isInteractiveBusy()) {
			this.throwIfStopped(signal, modelId);
			if (this.progress.state !== 'paused') this.setState('paused');
			await this.deps.whenInteractiveIdle();
		}
		this.throwIfStopped(signal, modelId);
		if (this.progress.state !== 'indexing') this.setState('indexing');

		const texts = batch.flatMap((plan) => plan.needs.map((index) => plan.chunks[index]));
		const result = await this.deps.embed(texts, signal);
		if (result.status === 'off') throw new PassStopped('off');
		if (result.status === 'cancelled') throw new PassStopped('idle');
		if (result.status === 'unavailable') throw new PassStopped('unavailable', result.reason);
		// The assignment may have changed while the call was in flight. Vectors
		// from another model must not be filed under this one.
		this.throwIfStopped(signal, modelId);
		if (localModelSourceKey(result.source) !== modelId) throw new PassStopped('idle');
		if (result.vectors.length !== texts.length) {
			throw new Error(
				`Embedding returned ${result.vectors.length} vectors for ${texts.length} texts`
			);
		}

		const store = this.deps.store();
		let cursor = 0;
		for (const plan of batch) {
			const rows: EmbeddingChunkInput[] = plan.needs.map((index) => ({
				sourceType: plan.item.sourceType,
				sourceId: plan.item.sourceId,
				agentId: plan.item.agentId,
				chunkIndex: index,
				textHash: plan.hashes[index],
				modelId,
				vector: result.vectors[cursor++],
			}));
			if (plan.replace) store.deleteBySource(plan.item.sourceType, plan.item.sourceId);
			store.upsertChunks(rows);
			// A mutable source the scan counted, then found changed, is one source.
			if (!done.has(plan.item.sourceId)) {
				done.add(plan.item.sourceId);
				this.count(plan.item.sourceType, 'indexed');
			}
		}
		this.emit();
		await this.yieldTurn();
	}

	/** End the pass when it was aborted, or the assignment is no longer the one it began under. */
	private throwIfStopped(signal: AbortSignal, modelId: string): void {
		if (!this.started) throw new PassStopped('idle');
		// Off is checked before the abort flag: switching the task off aborts the
		// pass too, and that pass must end as off, not as idle.
		const source = this.deps.resolveSource();
		if (!source) throw new PassStopped('off');
		if (signal.aborted || localModelSourceKey(source) !== modelId) throw new PassStopped('idle');
	}

	private endPass(error: unknown, modelId: string): void {
		if (error instanceof PassStopped) {
			if (error.state === 'off') {
				this.progress = emptySemanticIndexProgress('off');
				this.emit(true);
			} else if (error.state === 'unavailable') {
				logger.warn(`Semantic index stopped: ${error.reason}`, LOG_CONTEXT);
				this.setState('unavailable', error.reason);
			} else {
				this.setState('idle');
			}
			return;
		}
		// A source that cannot be used at all (not downloaded, endpoint gone) is
		// an expected state with a recovery; anything else is a bug.
		if (isLocalModelError(error)) {
			this.setState('unavailable', `${error.message} ${error.recovery}`);
			return;
		}
		if (isLocalModelEndpointError(error)) {
			this.setState('unavailable', error.message);
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`Semantic index pass failed: ${message}`, LOG_CONTEXT);
		void captureException(error instanceof Error ? error : new Error(message), {
			operation: 'semanticIndex:pass',
			modelId,
		});
		this.setState('unavailable', `Indexing failed: ${message}`);
	}

	// ------------------------------------------------------------------------
	// Incremental
	// ------------------------------------------------------------------------

	/** Embed what {@link noteItem} collected. Skips anything a pass already stored. */
	private async indexIncoming(): Promise<void> {
		const items = this.incoming;
		this.incoming = [];
		if (!this.started || items.length === 0) return;
		const source = this.deps.resolveSource();
		if (!source) return;

		const controller = new AbortController();
		this.abort = controller;
		const modelId = localModelSourceKey(source);
		try {
			const budget = await this.deps.resolveChunkBudget(source);
			const store = this.deps.store();
			const plans: SourcePlan[] = [];
			const seen = new Set<string>();
			for (const item of items) {
				const key = `${item.sourceType}:${item.sourceId}`;
				if (seen.has(key)) continue;
				seen.add(key);
				if (store.hasSource(modelId, item.sourceType, item.sourceId)) continue;
				const plan = this.plan(item, undefined, budget);
				if (!plan) continue;
				this.count(item.sourceType, 'total');
				plans.push(plan);
			}
			if (plans.length === 0) return;
			await this.embedPlans(plans, modelId, controller.signal);
			this.setState('idle');
		} catch (error) {
			this.endPass(error, modelId);
		} finally {
			if (this.abort === controller) this.abort = null;
			if (this.progress.state === 'indexing' || this.progress.state === 'paused') {
				this.setState('idle');
			}
		}
	}
}

// ============================================================================
// Production wiring
// ============================================================================

/** The source Semantic search is assigned in settings, or `null` when off. */
export function resolveSemanticIndexSource(): LocalModelSource | null {
	return sourceForAssignment(
		resolveLocalModelAssignment(readLocalModelAssignments(), SEMANTIC_INDEX_TASK_ID)
	);
}

/**
 * How text is measured for a source.
 *
 * A local model is measured with its own tokenizer, resolved WITHOUT opening
 * the ONNX session: the check that the model is installed is the same one a
 * run would make, so a model that is not downloaded is refused here, by name,
 * before any file is read. An endpoint model's tokenizer is not visible to
 * this process, so its text is estimated at about four characters a token.
 */
export async function resolveSemanticChunkBudget(source: LocalModelSource): Promise<ChunkBudget> {
	if (source.type === 'endpoint') {
		return { countTokens: estimateTokenCount, maxTokens: CHUNK_TARGET_TOKENS };
	}
	const installed = await resolveInstalledEncoder(source.modelId, 'embedding', CONSUMER_ID);
	const tokenizer = await loadTokenizer(installed.tokenizerDir);
	return {
		countTokens: (text) => tokenizer.countTokens(text),
		maxTokens: Math.max(
			1,
			Math.min(CHUNK_TARGET_TOKENS, installed.spec.maxTokens - WINDOW_RESERVE_TOKENS)
		),
	};
}

let instance: SemanticIndexer | null = null;
let releaseHooks: (() => void) | null = null;
let readConfigKey: (() => string) | null = null;

/**
 * Subscribers to the app indexer's progress. Held here rather than on the
 * indexer so a transport can subscribe at registration time, before the
 * indexer has been built, and keep its subscription across a rebuild.
 */
const progressListeners = new Set<(progress: SemanticIndexProgress) => void>();

/** Listen for the app indexer's progress. Returns the unsubscribe. */
export function onSemanticIndexProgress(
	listener: (progress: SemanticIndexProgress) => void
): () => void {
	progressListeners.add(listener);
	return () => {
		progressListeners.delete(listener);
	};
}

export interface StartSemanticIndexerOptions {
	/** The History manager (entries, and the hook for new ones). */
	history: {
		listSessionsWithHistory: () => Promise<string[]>;
		getEntries: (sessionId: string) => Promise<HistoryEntry[]>;
		onEntryAdded: (listener: (sessionId: string, entry: HistoryEntry) => void) => () => void;
	};
	/** Every agent record in the sessions store. */
	sessions: () => Array<Record<string, unknown>>;
	/** The `semanticIndexCue` setting. */
	includeCue: () => boolean;
	/** Cue runs kept in the Cue database, for when Cue indexing is on. */
	cueRuns?: HistoryReaderDeps['cueRuns'];
}

/** The app's one indexer, or `null` before {@link startSemanticIndexer}. */
export function getSemanticIndexer(): SemanticIndexer | null {
	return instance;
}

/**
 * The indexer's progress for a transport (IPC, the CLI bridge). Before the
 * indexer exists the answer is `off`, never an error: a status read must work
 * at any point in startup.
 */
export function semanticIndexProgress(): SemanticIndexProgress {
	return instance?.getProgress() ?? emptySemanticIndexProgress('off');
}

/**
 * Build the app's indexer over the real stores and start it. Idempotent.
 *
 * Reads nothing and opens nothing by itself: the first pass is armed for a
 * minute after launch, and only when Semantic search is assigned a source.
 */
export function startSemanticIndexer(options: StartSemanticIndexerOptions): SemanticIndexer {
	if (instance) return instance;

	const indexer = new SemanticIndexer({
		resolveSource: resolveSemanticIndexSource,
		resolveChunkBudget: resolveSemanticChunkBudget,
		embed: (texts, signal) =>
			runEmbeddingTask(SEMANTIC_INDEX_TASK_ID, {
				texts,
				mode: 'document',
				background: true,
				signal,
			}),
		store: getEmbeddingStore,
		readers: [
			createHistoryReader({
				listSessions: options.history.listSessionsWithHistory,
				getEntries: options.history.getEntries,
				includeCue: options.includeCue,
				...(options.cueRuns ? { cueRuns: options.cueRuns } : {}),
			}),
			createDirectorNotesReader(() => readDirectorNotesArchive()),
			createTranscriptReader({ sessions: options.sessions }),
		],
		isInteractiveBusy: isInteractiveLocalTaskRunning,
		whenInteractiveIdle: whenNoInteractiveLocalTask,
	});

	// Everything the indexer's behavior depends on, as one string: the assigned
	// source and the Cue switch. `refreshSemanticIndexer` compares it, so a
	// settings write that touched neither costs one string comparison.
	readConfigKey = () => {
		const source = resolveSemanticIndexSource();
		return `${source ? localModelSourceKey(source) : 'off'}|cue=${options.includeCue()}`;
	};

	const releaseHistory = options.history.onEntryAdded((sessionId, entry) => {
		const item = historyEntryItem(entry, sessionId, options.includeCue());
		if (item) indexer.noteItem(item);
	});
	const releaseArchive = onDirectorNotesArchived((record: ArchivedSynopsis) => {
		const item = synopsisItem(record);
		if (item) indexer.noteItem(item);
	});
	const releaseProgress = indexer.onProgress((progress) => {
		for (const listener of progressListeners) listener(progress);
	});
	releaseHooks = () => {
		releaseHistory();
		releaseArchive();
		releaseProgress();
	};

	instance = indexer;
	indexer.start(readConfigKey());
	return indexer;
}

/**
 * Re-read the settings the indexer depends on. Call after ANY settings change,
 * in-app or external: it does nothing unless the assignment or the Cue switch
 * actually moved.
 */
export function refreshSemanticIndexer(): void {
	if (!instance || !readConfigKey) return;
	instance.refresh(readConfigKey());
}

/** Stop the indexer (app quit, tests). A later start builds a new one. */
export function stopSemanticIndexer(): void {
	instance?.stop();
	releaseHooks?.();
	instance = null;
	releaseHooks = null;
	readConfigKey = null;
}
