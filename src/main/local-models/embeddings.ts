/**
 * The Local Models embedding service: text in, unit vectors out.
 *
 * Semantic search (history, transcripts, documents found by meaning) needs one
 * vector per text, comparable by cosine similarity. {@link embedTexts} produces
 * them from either kind of source:
 *
 *   - **Local**: a catalog embedding model on ONNX Runtime, through the shared
 *     {@link OnnxEncoderPool} (one session per model, freed when idle). Texts
 *     are tokenized and run in batches of {@link EMBED_BATCH_SIZE}, pooled as
 *     the model's run spec says (`cls`, `mean`, or the graph's own pooled
 *     output), and the model's query or document prefix is applied first. A
 *     model trained with prefixes embeds a query and a document differently,
 *     and leaving them off degrades retrieval without any visible error.
 *   - **Endpoint**: a model on a saved endpoint (`nomic-embed-text` on Ollama,
 *     say). Prefixes are NOT applied there: the endpoint model is the user's
 *     choice and this service cannot know what it was trained with.
 *
 * Every vector comes back L2-normalized, from both sources, so a caller can
 * compare any two with a dot product.
 *
 * A source that cannot run fails as itself (a classified `LocalModelError` or
 * `LocalModelEndpointError`), never by falling back to another source.
 */

import type { LocalEmbeddingSpec } from '../../shared/local-models/types';
import { embedWithLocalModelEndpoint } from './endpoint-service';
import { throwIfLocalModelCancelled } from './errors';
import {
	encoderFeeds,
	encoderRunFailure,
	getOnnxEncoderPool,
	type LoadedEncoder,
} from './onnx-encoder';
import type { OnnxTensor } from './runtime/onnx-types';
import type { LocalModelSource } from './sources';
import type { TokenizedBatch } from './tokenizer';
import { l2Normalize } from './vectors';

export { l2Normalize };

/**
 * Texts per ONNX run. Large enough to amortize a run's fixed cost, small enough
 * that padding every row to the batch's longest text does not waste much.
 */
export const EMBED_BATCH_SIZE = 16;

/** Texts per endpoint request: one round trip carries more, and the server batches. */
export const ENDPOINT_EMBED_BATCH_SIZE = 64;

/** Who the core names when a failure reaches a caller. */
const CONSUMER_ID = 'local-models:embeddings';

/**
 * Which side of a search a text is on. Models trained with task prefixes embed
 * a query and the documents it should find differently.
 */
export type EmbeddingMode = 'query' | 'document';

export interface EmbedTextsOptions {
	mode: EmbeddingMode;
	signal?: AbortSignal;
}

/**
 * Embed every text, returning one L2-normalized vector per text, in order.
 *
 * Throws a `LocalModelError` (local source) or `LocalModelEndpointError`
 * (endpoint source); both carry a message written for a person.
 */
export async function embedTexts(
	source: LocalModelSource,
	texts: readonly string[],
	options: EmbedTextsOptions
): Promise<Float32Array[]> {
	throwIfLocalModelCancelled(options.signal, CONSUMER_ID);
	if (texts.length === 0) return [];
	return source.type === 'local'
		? embedLocally(source.modelId, texts, options)
		: embedOnEndpoint(source.endpointId, source.model, texts, options.signal);
}

async function embedLocally(
	modelId: string,
	texts: readonly string[],
	options: EmbedTextsOptions
): Promise<Float32Array[]> {
	return getOnnxEncoderPool().run(modelId, 'embedding', CONSUMER_ID, async (encoder) => {
		// The pool resolved the model as an embedding model, so the spec is present.
		const spec = encoder.entry.embedding as LocalEmbeddingSpec;
		const prefix = (options.mode === 'query' ? spec.queryPrefix : spec.documentPrefix) ?? '';
		const vectors: Float32Array[] = [];
		for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
			throwIfLocalModelCancelled(options.signal, CONSUMER_ID);
			const batch = texts.slice(start, start + EMBED_BATCH_SIZE).map((text) => prefix + text);
			vectors.push(...(await runEmbeddingBatch(encoder, spec, batch)));
		}
		return vectors;
	});
}

async function embedOnEndpoint(
	endpointId: string,
	model: string,
	texts: readonly string[],
	signal: AbortSignal | undefined
): Promise<Float32Array[]> {
	const vectors: Float32Array[] = [];
	for (let start = 0; start < texts.length; start += ENDPOINT_EMBED_BATCH_SIZE) {
		throwIfLocalModelCancelled(signal, CONSUMER_ID);
		const result = await embedWithLocalModelEndpoint(endpointId, {
			model,
			input: texts.slice(start, start + ENDPOINT_EMBED_BATCH_SIZE),
			...(signal ? { signal } : {}),
		});
		for (const vector of result.embeddings) vectors.push(l2Normalize(Float32Array.from(vector)));
	}
	return vectors;
}

/** One batch through the graph: tokenize, feed what the graph declares, pool. */
async function runEmbeddingBatch(
	encoder: LoadedEncoder,
	spec: LocalEmbeddingSpec,
	texts: readonly string[]
): Promise<Float32Array[]> {
	const tokens = encoder.tokenizer.encodeBatch(texts, { maxLength: spec.maxTokens });
	const feeds = encoderFeeds(encoder, tokens, CONSUMER_ID);

	let outputs: Record<string, OnnxTensor>;
	try {
		outputs = await encoder.session.run(feeds);
	} catch (error) {
		throw encoderRunFailure(
			encoder.entry,
			CONSUMER_ID,
			`failed on this request: ${(error as Error).message}`,
			error
		);
	}
	const output = outputs[spec.outputName];
	if (!output) {
		throw encoderRunFailure(encoder.entry, CONSUMER_ID, `produced no "${spec.outputName}" output.`);
	}
	try {
		return poolEmbeddings(output, tokens, spec);
	} catch (error) {
		throw encoderRunFailure(encoder.entry, CONSUMER_ID, (error as Error).message, error);
	}
}

/**
 * Turn a graph output into one normalized vector per row of the batch.
 *
 * - `graph`: the output is `[batch, dimensions]`, already pooled.
 * - `cls`: the output is `[batch, sequence, hidden]`; take position 0.
 * - `mean`: the same, averaged over the positions the attention mask keeps.
 *
 * The width must equal the spec's `dimensions`: a mismatch means the graph is
 * not the one the catalog describes, and its vectors would be compared against
 * an index built in a different space.
 */
export function poolEmbeddings(
	output: OnnxTensor,
	tokens: Pick<TokenizedBatch, 'batchSize' | 'sequenceLength' | 'attentionMask'>,
	spec: Pick<LocalEmbeddingSpec, 'pooling' | 'dimensions'>
): Float32Array[] {
	if (!(output.data instanceof Float32Array)) {
		throw new Error('returned a non-float embedding output.');
	}
	const data = output.data;
	const { dims } = output;
	const pooled = spec.pooling === 'graph';
	const expectedRank = pooled ? 2 : 3;
	if (
		dims.length !== expectedRank ||
		dims[0] !== tokens.batchSize ||
		(!pooled && dims[1] !== tokens.sequenceLength)
	) {
		throw new Error(`returned an output of shape [${dims.join(', ')}].`);
	}
	const width = dims[dims.length - 1];
	if (width !== spec.dimensions) {
		throw new Error(`returned ${width}-wide vectors; the catalog expects ${spec.dimensions}.`);
	}

	const vectors: Float32Array[] = [];
	for (let row = 0; row < tokens.batchSize; row++) {
		let vector: Float32Array;
		if (pooled) {
			vector = data.slice(row * width, (row + 1) * width);
		} else {
			const sequence = tokens.sequenceLength;
			const rowStart = row * sequence * width;
			if (spec.pooling === 'cls') {
				vector = data.slice(rowStart, rowStart + width);
			} else {
				vector = new Float32Array(width);
				let kept = 0;
				// Padding positions carry states too; only the masked-in ones count.
				for (let position = 0; position < sequence; position++) {
					if (tokens.attentionMask[row * sequence + position] !== 1n) continue;
					kept++;
					const offset = rowStart + position * width;
					for (let i = 0; i < width; i++) vector[i] += data[offset + i];
				}
				if (kept > 0) for (let i = 0; i < width; i++) vector[i] /= kept;
			}
		}
		vectors.push(l2Normalize(vector));
	}
	return vectors;
}
