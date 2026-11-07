/**
 * openWakeWord's front end: audio in, classifier windows out.
 *
 * Two small ONNX graphs. The first turns 16 kHz audio into a mel spectrogram;
 * the second turns 76 mel frames into one speech embedding. A classifier then
 * reads the last sixteen embeddings, about two seconds of audio, once per 80 ms
 * hop. Everything that decides whether a phrase was said sits AFTER this module:
 * a pretrained classifier graph for a phrase openWakeWord ships, or the matcher
 * built from a user's own recordings (`enrolled-wake-model.ts`).
 *
 * It is its own module because two callers need exactly the same numbers. The
 * always-on scorer streams the microphone through it, and the trainer runs a
 * user's recordings through it to build the examples the matcher compares
 * against. An example computed any other way than the live audio is computed
 * would be an example of something the detector never sees.
 *
 * **The front end must match openWakeWord's reference exactly**, and once it did
 * not: three departures together scored a clear "hey jarvis" at 0.009 where the
 * reference scores 0.999. The mel graph takes samples at INT16 scale (not
 * [-1, 1]); each hop needs the previous 480 samples in front of it; and the mel
 * output is rescaled `x / 10 + 2` before the embedding graph sees it.
 */

import { OPENWAKEWORD_BASE_ID } from '../../../shared/local-models/model-catalog';
import { modelFilePath } from '../../local-models/model-store';
import { logger } from '../../utils/logger';
import { WAKE_WORD_PROVIDER_ID } from '../models/capability-gate';
import { loadVoiceRuntime } from '../providers/local/runtime';
import {
	EMBEDDING_WINDOW_MEL_FRAMES,
	MEL_FRAMES_PER_HOP,
	WAKE_CLASSIFIER_WINDOW,
	WAKE_HOP_SAMPLES,
	type WakeFeatureWindow,
	type WakeFeaturizer,
} from './wake-features';

// The stream's shape lives in `wake-features.ts`, which has no ONNX behind it;
// re-exported so the scorer keeps one import site for the front end.
export {
	WAKE_CLASSIFIER_WINDOW,
	WAKE_HOP_MS,
	WAKE_HOP_SAMPLES,
	WAKE_WARMUP_HOPS,
	type WakeFeatureWindow,
	type WakeFeaturizer,
} from './wake-features';

const LOG_CONTEXT = 'ACappella';

/** Mel bins openWakeWord's front end produces. */
const MEL_BINS = 32;

/**
 * Samples of the previous hop fed in front of each new one.
 *
 * The mel graph is unpadded with a 160-sample stride, so a 1280-sample hop on
 * its own yields fewer frames than the hop covers. openWakeWord's reference
 * streams the last 480 samples ahead of each hop and keeps the newest frames.
 */
const MEL_CONTEXT_SAMPLES = 480;

/** Int16 full scale: the mel graph wants samples at this scale, not [-1, 1]. */
const INT16_SCALE = 32768;

// ---------------------------------------------------------------------------
// The onnxruntime surface used here, structurally
// ---------------------------------------------------------------------------

export interface OnnxTensor {
	data: Float32Array;
	dims: readonly number[];
}

export interface OnnxSession {
	inputNames: readonly string[];
	outputNames: readonly string[];
	run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>;
	release?(): Promise<void>;
}

export interface OnnxRuntime {
	InferenceSession: { create(path: string): Promise<OnnxSession> };
	Tensor: new (type: string, data: Float32Array, dims: number[]) => OnnxTensor;
}

/** The runtime and the two graphs. Shared by every stream opened over them. */
export interface WakeFrontEndModels {
	ort: OnnxRuntime;
	mel: OnnxSession;
	embedding: OnnxSession;
}

/**
 * Load the runtime and both graphs, or null when either is missing.
 *
 * Missing is the ordinary state of a machine that has not opted into
 * hands-free. The capability gate is where that becomes a sentence the user can
 * act on, so this says so in the log and returns nothing.
 */
export async function loadWakeFrontEndModels(): Promise<WakeFrontEndModels | null> {
	let ort: OnnxRuntime;
	try {
		ort = await loadVoiceRuntime<OnnxRuntime>('onnx', WAKE_WORD_PROVIDER_ID);
	} catch (err) {
		logger.info(`Wake word runtime unavailable: ${(err as Error).message}`, LOG_CONTEXT);
		return null;
	}
	try {
		const mel = await ort.InferenceSession.create(
			modelFilePath(OPENWAKEWORD_BASE_ID, 'melspectrogram.onnx')
		);
		const embedding = await ort.InferenceSession.create(
			modelFilePath(OPENWAKEWORD_BASE_ID, 'embedding_model.onnx')
		);
		return { ort, mel, embedding };
	} catch (err) {
		logger.info(`Wake word models unavailable: ${(err as Error).message}`, LOG_CONTEXT);
		return null;
	}
}

export async function releaseWakeFrontEndModels(models: WakeFrontEndModels): Promise<void> {
	await models.mel.release?.();
	await models.embedding.release?.();
}

// ---------------------------------------------------------------------------
// One stream
// ---------------------------------------------------------------------------

/**
 * One continuous stream of audio through the front end.
 *
 * Holds the rolling mel frames and embeddings, which are the model's own memory
 * of the last two seconds. A stream is for ONE piece of continuous audio: feed
 * it a second recording without {@link reset} and the first window of the
 * second is stitched from the end of the first.
 */
export class WakeFrontEnd {
	private readonly melRing: Float32Array[] = [];
	private readonly embeddingRing: Float32Array[] = [];
	/** The tail of the previous hop, at int16 scale, fed in front of the next one. */
	private context = new Float32Array(0);

	constructor(private readonly models: WakeFrontEndModels) {}

	/** Forget everything heard so far. */
	reset(): void {
		this.melRing.length = 0;
		this.embeddingRing.length = 0;
		this.context = new Float32Array(0);
	}

	/**
	 * Advance by one hop.
	 *
	 * @param hop Mono float samples in [-1, 1], {@link WAKE_HOP_SAMPLES} long.
	 * @returns The newest classifier window ({@link WAKE_CLASSIFIER_WINDOW}
	 *          embeddings, oldest first, flattened), or null while warming up.
	 */
	async push(hop: Float32Array): Promise<Float32Array | null> {
		const { ort, mel, embedding } = this.models;

		// Int16 scale, previous tail in front.
		const input = new Float32Array(this.context.length + hop.length);
		input.set(this.context, 0);
		for (let i = 0; i < hop.length; i++) input[this.context.length + i] = hop[i] * INT16_SCALE;
		this.context = input.slice(Math.max(0, input.length - MEL_CONTEXT_SAMPLES));

		const melOut = await mel.run({
			[mel.inputNames[0]]: new ort.Tensor('float32', input, [1, input.length]),
		});
		const melData = melOut[mel.outputNames[0]].data;
		const frames: Float32Array[] = [];
		for (let i = 0; i + MEL_BINS <= melData.length; i += MEL_BINS) {
			const frame = melData.slice(i, i + MEL_BINS);
			for (let j = 0; j < frame.length; j++) frame[j] = frame[j] / 10 + 2;
			frames.push(frame);
		}
		// The context overlaps the previous hop; only the newest frames are new.
		this.melRing.push(...frames.slice(-MEL_FRAMES_PER_HOP));
		while (this.melRing.length > EMBEDDING_WINDOW_MEL_FRAMES) this.melRing.shift();
		if (this.melRing.length < EMBEDDING_WINDOW_MEL_FRAMES) return null;

		const melWindow = new Float32Array(EMBEDDING_WINDOW_MEL_FRAMES * MEL_BINS);
		this.melRing.forEach((frame, index) => melWindow.set(frame, index * MEL_BINS));
		const embedOut = await embedding.run({
			[embedding.inputNames[0]]: new ort.Tensor('float32', melWindow, [
				1,
				EMBEDDING_WINDOW_MEL_FRAMES,
				MEL_BINS,
				1,
			]),
		});
		this.embeddingRing.push(Float32Array.from(embedOut[embedding.outputNames[0]].data));
		while (this.embeddingRing.length > WAKE_CLASSIFIER_WINDOW) this.embeddingRing.shift();
		if (this.embeddingRing.length < WAKE_CLASSIFIER_WINDOW) return null;

		const width = this.embeddingRing[0].length;
		const window = new Float32Array(WAKE_CLASSIFIER_WINDOW * width);
		this.embeddingRing.forEach((vector, index) => window.set(vector, index * width));
		return window;
	}
}

// ---------------------------------------------------------------------------
// Whole recordings
// ---------------------------------------------------------------------------

/** Run one recording through a fresh stream, hop by hop. Samples past the last whole hop are dropped. */
export async function featurizeRecording(
	models: WakeFrontEndModels,
	audio: Float32Array
): Promise<WakeFeatureWindow[]> {
	const stream = new WakeFrontEnd(models);
	const windows: WakeFeatureWindow[] = [];
	for (let start = 0; start + WAKE_HOP_SAMPLES <= audio.length; start += WAKE_HOP_SAMPLES) {
		const window = await stream.push(audio.subarray(start, start + WAKE_HOP_SAMPLES));
		if (window) windows.push({ end: start + WAKE_HOP_SAMPLES, window });
	}
	return windows;
}

/** A featurizer over the installed front end, or null when it is not installed. */
export async function createWakeFeaturizer(): Promise<WakeFeaturizer | null> {
	const models = await loadWakeFrontEndModels();
	if (!models) return null;
	return {
		featurize: (audio) => featurizeRecording(models, audio),
		release: () => releaseWakeFrontEndModels(models),
	};
}
