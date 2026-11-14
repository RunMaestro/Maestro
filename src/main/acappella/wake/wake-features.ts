/**
 * The shape of the wake word's feature stream, with nothing behind it.
 *
 * The front end (`wake-front-end.ts`) loads ONNX graphs; the matcher and the
 * trainer for a user-recorded phrase are arithmetic over what those graphs
 * produce. They need to agree on the numbers - how long a hop is, how many
 * embeddings a window holds - without the arithmetic dragging a native runtime
 * into every test that exercises it. So the numbers live here.
 */

/**
 * openWakeWord's hop: 1280 samples at 16 kHz, 80 ms. The models are trained on
 * this cadence, so it is a property of the graph and not a tuning knob.
 */
export const WAKE_HOP_SAMPLES = 1280;

/** One hop, in milliseconds. */
export const WAKE_HOP_MS = 80;

/** Embeddings a classifier consumes at once. A property of the trained models. */
export const WAKE_CLASSIFIER_WINDOW = 16;

/** Mel frames the embedding graph consumes at once. A property of the trained model. */
export const EMBEDDING_WINDOW_MEL_FRAMES = 76;

/** Mel frames per 80 ms hop: one per 160-sample stride. */
export const MEL_FRAMES_PER_HOP = 8;

/**
 * Hops of audio before the first classifier window exists: the mel ring has to
 * fill (ten hops) and then the embedding ring (fifteen more).
 */
export const WAKE_WARMUP_HOPS =
	Math.ceil(EMBEDDING_WINDOW_MEL_FRAMES / MEL_FRAMES_PER_HOP) + WAKE_CLASSIFIER_WINDOW - 1;

/** One classifier window from a recording, and where in the recording it ends. */
export interface WakeFeatureWindow {
	/** Sample index just past the hop that produced this window. */
	end: number;
	/** {@link WAKE_CLASSIFIER_WINDOW} embeddings, oldest first, flattened. */
	window: Float32Array;
}

/**
 * Turns a whole recording into the windows the live detector would have seen
 * while it played. What the trainer needs, and all it needs.
 */
export interface WakeFeaturizer {
	/** @param audio Mono float samples in [-1, 1] at 16 kHz. */
	featurize(audio: Float32Array): Promise<WakeFeatureWindow[]>;
	release(): Promise<void>;
}
