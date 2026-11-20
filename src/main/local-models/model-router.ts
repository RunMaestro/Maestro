/**
 * The embedding router: how much model a prompt needs, decided by the labeled
 * prompts it most resembles.
 *
 * A prompt is embedded with an embedding model (`embedTexts`, the same service
 * semantic search uses) and compared against every labeled example: the ones
 * Maestro ships (`MODEL_ROUTING_EXAMPLES`) and the corrections the user
 * recorded (`model-routing-corrections.ts`). Its nearest neighbours vote, by
 * distance, for a tier and an effort, and each vote's margin is the confidence
 * (`voteModelRoute` in `src/shared/local-models/model-routing.ts`). No text is
 * generated, so a decision costs one short embedding: tens of milliseconds on a
 * CPU.
 *
 * The example vectors are kept in memory under the source that produced them
 * (`localModelSourceKey`). Two models are two vector spaces, so a different
 * source throws the vectors away and embeds the examples again; a new
 * correction embeds only itself.
 *
 * **The build is never tied to one caller.** The first prompt after a start, or
 * after a model change, has to embed every example, which can take longer than
 * a send is allowed to wait. A caller that gives up (its signal aborts) stops
 * WAITING; the build runs on, and the next prompt finds the vectors ready. Tied
 * to the caller, a slow machine would abandon the build on every send and never
 * route at all. {@link EmbeddingRouter.warm} starts it ahead of the first send.
 *
 * This module decides nothing about WHETHER routing runs: it has no assignment,
 * no timeout and no ledger. A caller hands it a source. A source that cannot
 * run fails as itself (the classified error `embedTexts` throws), never by
 * falling back to another.
 */

import {
	mergeModelRoutingExamples,
	MODEL_ROUTING_NEIGHBOURS,
	normalizeModelRoutingText,
	voteModelRoute,
	type ModelRouteVote,
	type ModelRoutingCorrection,
	type ModelRoutingExample,
	type ModelRoutingLabeledExample,
	type ModelRoutingNeighbour,
} from '../../shared/local-models/model-routing';
import { MODEL_ROUTING_EXAMPLES } from '../../shared/local-models/model-routing-examples';
import { embedTexts, type EmbeddingMode } from './embeddings';
import { localModelCancelledError } from './errors';
import { getModelRoutingCorrectionStore } from './model-routing-corrections';
import { localModelSourceKey, type LocalModelSource } from './sources';
import { dotProduct } from './vectors';

/** Who the core names when a cancelled route reaches a caller. */
const CONSUMER_ID = 'local-models:model-router';

/**
 * Both sides are embedded the same way. A nearest-neighbour vote compares a
 * prompt with other prompts, like with like; embedding the examples as
 * documents and the prompt as a query would measure how well each example
 * ANSWERS the prompt, which is a different question.
 */
const ROUTING_EMBEDDING_MODE: EmbeddingMode = 'query';

/** The embedding call the router makes. `embedTexts` in the app; a stub in a test. */
export type ModelRouterEmbedder = (
	source: LocalModelSource,
	texts: readonly string[],
	options: { mode: EmbeddingMode; signal?: AbortSignal }
) => Promise<Float32Array[]>;

export interface EmbeddingRouterOptions {
	/** Defaults to `embedTexts`. */
	embed?: ModelRouterEmbedder;
	/** Defaults to the shipped {@link MODEL_ROUTING_EXAMPLES}. */
	examples?: readonly ModelRoutingExample[];
	/** Defaults to the app's corrections store. Read on every route. */
	corrections?: () => Promise<readonly ModelRoutingCorrection[]>;
	/** How many nearest neighbours vote. Defaults to {@link MODEL_ROUTING_NEIGHBOURS}. */
	neighbours?: number;
}

export interface EmbeddingRouteOptions {
	/** Stops the caller's wait. It never stops a build other prompts will need. */
	signal?: AbortSignal;
}

/** What the embedding router decided, and what it decided from. */
export interface EmbeddingRouteDecision extends ModelRouteVote {
	/** The neighbours that voted, nearest first. */
	neighbours: ModelRoutingNeighbour[];
	/** How many labeled prompts the prompt was compared against. */
	exampleCount: number;
	/** The embedding source that produced the vectors. */
	source: LocalModelSource;
}

/** One source's example vectors, by the text that was embedded. */
interface RouterIndex {
	key: string;
	vectors: Map<string, Float32Array>;
	/** The build in flight, shared by every prompt waiting on it. */
	pending: Promise<void> | null;
}

interface IndexedExample {
	example: ModelRoutingLabeledExample;
	vector: Float32Array;
}

/**
 * Wait for shared work, but only as long as the caller's signal allows. The
 * work itself is not cancelled: other callers are waiting on the same promise.
 */
function waitUnlessAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return work;
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(localModelCancelledError(CONSUMER_ID));
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener('abort', onAbort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
}

/** The `count` entries nearest the query, nearest first. */
function nearestNeighbours(
	indexed: readonly IndexedExample[],
	query: Float32Array,
	count: number
): ModelRoutingNeighbour[] {
	return indexed
		.map(({ example, vector }) => ({ ...example, similarity: dotProduct(query, vector) }))
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, count);
}

export class EmbeddingRouter {
	private readonly embed: ModelRouterEmbedder;
	private readonly examples: readonly ModelRoutingExample[];
	private readonly corrections: () => Promise<readonly ModelRoutingCorrection[]>;
	private readonly neighbours: number;
	private index: RouterIndex | null = null;

	constructor(options: EmbeddingRouterOptions = {}) {
		this.embed = options.embed ?? embedTexts;
		this.examples = options.examples ?? MODEL_ROUTING_EXAMPLES;
		this.corrections = options.corrections ?? (() => getModelRoutingCorrectionStore().list());
		this.neighbours = options.neighbours ?? MODEL_ROUTING_NEIGHBOURS;
	}

	/**
	 * Decide a tier and an effort for `text` on `source`.
	 *
	 * Throws a cancelled `LocalModelError` when the signal aborts, whatever
	 * `embedTexts` throws when the source cannot run, and a plain `Error` for a
	 * caller bug (no text to route).
	 */
	async route(
		source: LocalModelSource,
		text: string,
		options: EmbeddingRouteOptions = {}
	): Promise<EmbeddingRouteDecision> {
		const routed = normalizeModelRoutingText(text);
		if (!routed) throw new Error('The embedding router was given no text to route.');

		for (let attempt = 0; ; attempt++) {
			const indexed = await this.syncIndex(source, options.signal);
			const [query] = await this.embed(source, [routed], {
				mode: ROUTING_EMBEDDING_MODE,
				...(options.signal ? { signal: options.signal } : {}),
			});
			if (!query) throw new Error('The embedding source returned no vector for the prompt.');

			if (indexed.some(({ vector }) => vector.length !== query.length)) {
				// The source now answers in another width: an endpoint that serves a
				// different model under the same name. That is a model change the key
				// cannot see, so the vectors are rebuilt, once.
				if (attempt > 0) {
					throw new Error(
						`${localModelSourceKey(source)} returned embeddings of more than one width.`
					);
				}
				this.reset();
				continue;
			}

			const neighbours = nearestNeighbours(indexed, query, this.neighbours);
			const vote = voteModelRoute(neighbours);
			if (!vote) throw new Error('The embedding router has no labeled examples to compare with.');
			return { ...vote, neighbours, exampleCount: indexed.length, source };
		}
	}

	/**
	 * Embed the examples for `source` now, so the first routed prompt does not
	 * pay for it. Call it when routing is turned on or its model changes, never
	 * on a start with routing off: it loads the embedding model.
	 */
	async warm(source: LocalModelSource): Promise<void> {
		await this.syncIndex(source, undefined);
	}

	/** Drop the vectors. The next route or warm embeds the examples again. */
	reset(): void {
		this.index = null;
	}

	/**
	 * Every labeled example with its vector, for `source`. Embeds what the index
	 * lacks: everything after a source change, one text after a new correction.
	 */
	private async syncIndex(
		source: LocalModelSource,
		signal: AbortSignal | undefined
	): Promise<IndexedExample[]> {
		const key = localModelSourceKey(source);
		for (;;) {
			if (this.index?.key !== key) this.index = { key, vectors: new Map(), pending: null };
			const index = this.index;

			const examples = mergeModelRoutingExamples(
				this.examples,
				await waitUnlessAborted(this.corrections(), signal)
			);
			// The source changed, or the index was reset, while the corrections were read.
			if (this.index !== index) continue;

			const missing = examples
				.map((example) => example.text)
				.filter((text) => !index.vectors.has(text));
			if (missing.length === 0) {
				const wanted = new Set(examples.map((example) => example.text));
				for (const text of index.vectors.keys()) {
					if (!wanted.has(text)) index.vectors.delete(text);
				}
				return examples.map((example) => ({
					example,
					vector: index.vectors.get(example.text) as Float32Array,
				}));
			}

			if (!index.pending) {
				// No signal: this build serves every prompt, not the one that started it.
				const build = Promise.resolve()
					.then(() => this.embed(source, missing, { mode: ROUTING_EMBEDDING_MODE }))
					.then((vectors) => {
						if (vectors.length !== missing.length) {
							throw new Error(
								`${key} returned ${vectors.length} embeddings for ${missing.length} texts.`
							);
						}
						missing.forEach((text, position) => index.vectors.set(text, vectors[position]));
					})
					.finally(() => {
						index.pending = null;
					});
				// A caller that stopped waiting leaves nobody holding this promise. Its
				// failure is not lost: nothing was stored, so the next prompt builds
				// again and is handed the error itself.
				build.catch(() => undefined);
				index.pending = build;
			}
			await waitUnlessAborted(index.pending, signal);
		}
	}
}

let instance: EmbeddingRouter | null = null;

/** The app's one embedding router. It holds the example vectors in memory. */
export function getEmbeddingRouter(): EmbeddingRouter {
	if (!instance) instance = new EmbeddingRouter();
	return instance;
}
