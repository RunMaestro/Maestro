/**
 * The Local Models classifier service: untrusted text in, a risk score out.
 *
 * The prompt-injection screen scores text Maestro is about to hand an agent (a
 * GitHub comment a Cue subscription forwards, say) before the agent reads it.
 * {@link classifyText} runs a catalog classifier (Prompt Guard 2, ProtectAI's
 * DeBERTa) on ONNX Runtime through the shared {@link OnnxEncoderPool}.
 *
 * **Every token is read.** A classifier sees at most its window (512 tokens),
 * and truncating would screen only the start of a long text: an injection
 * appended to the end of a long, friendly comment would pass unseen. So a long
 * text is cut into overlapping windows ({@link CLASSIFIER_WINDOW_OVERLAP}
 * tokens repeated across each edge, so a span cut at one edge is whole in the
 * next window), every window is scored, and the result is the HIGHEST positive
 * score across them. Averaging would dilute a short injection with pages of
 * benign text; the maximum cannot be diluted.
 *
 * **Local only.** Endpoints serve text-generation and embedding models; none
 * of the supported servers runs a sequence classifier. An endpoint source is
 * refused by name rather than approximated with a chat model asked "is this an
 * injection?", which would be a different, uncalibrated screen the user did
 * not choose.
 */

import type { LocalClassifierSpec } from '../../shared/local-models/types';
import { LocalModelError, throwIfLocalModelCancelled } from './errors';
import {
	encoderFeeds,
	encoderRunFailure,
	getOnnxEncoderPool,
	type LoadedEncoder,
} from './onnx-encoder';
import type { OnnxTensor } from './runtime/onnx-types';
import type { LocalModelSource } from './sources';
import { padTokenizedRows, type TokenizedInput } from './tokenizer';

/** Windows per ONNX run. */
export const CLASSIFY_BATCH_SIZE = 16;

/**
 * Content tokens each window repeats from the one before it. Long enough to
 * hold a typical injection sentence whole, short enough that a long text costs
 * barely more windows than it would without overlap.
 */
export const CLASSIFIER_WINDOW_OVERLAP = 64;

/** Who the core names when a failure reaches a caller. */
const CONSUMER_ID = 'local-models:classifier';

export interface ClassifyTextOptions {
	signal?: AbortSignal;
}

export interface ClassificationResult {
	/** The most likely label of the riskiest window. */
	label: string;
	/**
	 * Probability of the model's positive label (`MALICIOUS`, `INJECTION`), the
	 * maximum across every window. 0 to 1.
	 */
	score: number;
	/** Whether {@link label} is the positive label: the text should be flagged. */
	flagged: boolean;
	/** How many windows the text was scored in. 1 when it fits the model's window. */
	chunks: number;
}

/**
 * Score a text with a classifier model.
 *
 * Throws a classified `LocalModelError`: the model is not installed, the
 * runtime will not load, the source is an endpoint, or a run failed.
 */
export async function classifyText(
	source: LocalModelSource,
	text: string,
	options: ClassifyTextOptions = {}
): Promise<ClassificationResult> {
	throwIfLocalModelCancelled(options.signal, CONSUMER_ID);
	if (source.type !== 'local') {
		throw new LocalModelError(
			`"${source.model}" is served by an endpoint, which cannot run a text classifier.`,
			{
				code: 'model-unsupported',
				recovery: 'Choose a local classifier model from the Local Models catalog.',
				consumerId: CONSUMER_ID,
			}
		);
	}
	return getOnnxEncoderPool().run(source.modelId, 'classifier', CONSUMER_ID, async (encoder) => {
		// The pool resolved the model as a classifier, so the spec is present.
		const spec = encoder.entry.classifier as LocalClassifierSpec;
		const positive = spec.labels.indexOf(spec.positiveLabel);
		const windows = encoder.tokenizer.encodeWindows(text, {
			maxLength: spec.maxTokens,
			overlap: CLASSIFIER_WINDOW_OVERLAP,
		});

		let riskiest: Float32Array | null = null;
		for (let start = 0; start < windows.length; start += CLASSIFY_BATCH_SIZE) {
			throwIfLocalModelCancelled(options.signal, CONSUMER_ID);
			const batch = windows.slice(start, start + CLASSIFY_BATCH_SIZE);
			for (const probabilities of await runClassifierBatch(encoder, spec, batch)) {
				if (!riskiest || probabilities[positive] > riskiest[positive]) riskiest = probabilities;
			}
		}
		// encodeWindows always returns at least one window.
		const top = riskiest as Float32Array;
		const label = spec.labels[argmax(top)];
		return {
			label,
			score: top[positive],
			flagged: label === spec.positiveLabel,
			chunks: windows.length,
		};
	});
}

/** One batch of windows through the graph: pad, feed, softmax each row. */
async function runClassifierBatch(
	encoder: LoadedEncoder,
	spec: LocalClassifierSpec,
	windows: readonly TokenizedInput[]
): Promise<Float32Array[]> {
	const tokens = padTokenizedRows(windows, encoder.tokenizer.padTokenId);
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
		return logitsToProbabilities(output, tokens.batchSize, spec.labels.length);
	} catch (error) {
		throw encoderRunFailure(encoder.entry, CONSUMER_ID, (error as Error).message, error);
	}
}

/**
 * Turn a `[batch, labels]` logits output into one probability row per window.
 *
 * The width must equal the catalog's label count: a mismatch means the graph
 * is not the one the catalog describes, and reading index N as the positive
 * label would score the wrong class.
 */
export function logitsToProbabilities(
	output: OnnxTensor,
	batchSize: number,
	labelCount: number
): Float32Array[] {
	if (!(output.data instanceof Float32Array)) {
		throw new Error('returned non-float logits.');
	}
	const { dims, data } = output;
	if (dims.length !== 2 || dims[0] !== batchSize) {
		throw new Error(`returned logits of shape [${dims.join(', ')}].`);
	}
	if (dims[1] !== labelCount) {
		throw new Error(`returned ${dims[1]} labels; the catalog expects ${labelCount}.`);
	}
	const rows: Float32Array[] = [];
	for (let row = 0; row < batchSize; row++) {
		rows.push(softmax(data.subarray(row * labelCount, (row + 1) * labelCount)));
	}
	return rows;
}

/** Softmax, shifted by the maximum so large logits cannot overflow. */
function softmax(logits: Float32Array): Float32Array {
	const max = Math.max(...logits);
	const out = new Float32Array(logits.length);
	let sum = 0;
	for (let i = 0; i < logits.length; i++) {
		out[i] = Math.exp(logits[i] - max);
		sum += out[i];
	}
	for (let i = 0; i < out.length; i++) out[i] /= sum;
	return out;
}

function argmax(values: Float32Array): number {
	let best = 0;
	for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
	return best;
}
