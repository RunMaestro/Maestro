/**
 * The matcher behind a phrase the user recorded themselves.
 *
 * A pretrained wake phrase is a small neural classifier, trained on thousands of
 * clips, that draws a boundary between the phrase and everything else. A couple
 * of dozen recordings cannot draw that boundary: a classifier fitted to them
 * learns "is not the thirty seconds of other speech I was shown", and fires on
 * the first sentence it has not heard. Measured on four synthetic voices, a
 * logistic head fired on ordinary speech three to six times as often as the
 * matcher below at the same recall.
 *
 * So this does not classify. It REMEMBERS: every recording, a few times over
 * with the room and the pace varied, is kept as an example, and a window of
 * live audio scores by how close it comes to the nearest one. "Close" is the
 * cosine similarity of the last {@link EnrolledWakeModel.frames} speech
 * embeddings, frame against frame, after subtracting the embedding every
 * frame shares, averaged with each frame weighted by how much of it the phrase
 * accounts for. Other speech is then used for the one thing a little of it is
 * good for: finding where "close enough" starts.
 *
 * The result is a number from 0 to 1 that crosses 0.5 half way between the most
 * phrase-like thing in the user's ordinary speech and the least phrase-like of
 * their recordings, which is what lets the same sensitivity slider drive it and
 * a pretrained phrase.
 *
 * Pure: no files, no ONNX. `wake-enrollment-store.ts` persists it and
 * `wake-trainer.ts` builds it.
 */

import type { WakeEnrollmentReport } from '../../../shared/acappella/wake-enrollment';
import { WAKE_CLASSIFIER_WINDOW } from './wake-features';

/** Bumped when a stored model can no longer be scored by this code. */
export const ENROLLED_WAKE_MODEL_VERSION = 1;

/** Keeps a silent frame, whose embedding is all centre and no direction, from dividing by zero. */
const NORM_EPSILON = 1e-6;

export interface EnrolledWakeModel {
	version: typeof ENROLLED_WAKE_MODEL_VERSION;
	/** The phrase as the user typed it. */
	phrase: string;
	/** `wakePhraseKey(phrase)`: the directory this model lives in. */
	key: string;
	/** Epoch ms. Doubles as the revision a running detector is stale against. */
	trainedAt: number;
	/**
	 * Trailing embeddings compared, at most {@link WAKE_CLASSIFIER_WINDOW}.
	 *
	 * Sized to the phrase: the frames before it hold whatever was said earlier,
	 * and comparing those would score the room rather than the phrase.
	 */
	frames: number;
	/** Embedding width. A property of the front end, stored so a mismatch is detectable. */
	width: number;
	/** The embedding every frame shares, subtracted before comparing. `width` long. */
	mean: Float32Array;
	/**
	 * Examples, each `frames * width` long. Every frame is centred, unit length,
	 * and then scaled by its share of the weighting, so the dot product of an
	 * example with a prepared window IS the weighted mean similarity.
	 */
	templates: Float32Array;
	/** Number of examples in `templates`. */
	count: number;
	/** The similarity that scores 0.5. */
	midpoint: number;
	/** Slope of the similarity-to-score curve. */
	steepness: number;
	report: WakeEnrollmentReport;
}

/**
 * The comparable form of a classifier window: its last `frames` embeddings,
 * each centred on `mean` and scaled to unit length.
 *
 * Centring matters more than it looks. Raw speech embeddings all point roughly
 * the same way, so two unrelated sounds already score about 0.9 against each
 * other; removing the shared part spreads that out to where a threshold has
 * room to sit.
 */
export function prepareWakeWindow(
	window: Float32Array,
	frames: number,
	width: number,
	mean: Float32Array
): Float32Array {
	const total = Math.floor(window.length / width);
	const out = new Float32Array(frames * width);
	for (let frame = 0; frame < frames; frame++) {
		const source = (total - frames + frame) * width;
		const target = frame * width;
		let norm = 0;
		for (let i = 0; i < width; i++) {
			const value = window[source + i] - mean[i];
			out[target + i] = value;
			norm += value * value;
		}
		const scale = 1 / (Math.sqrt(norm) + NORM_EPSILON);
		for (let i = 0; i < width; i++) out[target + i] *= scale;
	}
	return out;
}

/**
 * Scale each frame of a prepared window by its weight, turning it into an
 * example. The weights must sum to one.
 */
export function weightWakeTemplate(
	prepared: Float32Array,
	weights: Float32Array,
	width: number
): Float32Array {
	const out = new Float32Array(prepared.length);
	for (let frame = 0; frame < weights.length; frame++) {
		const offset = frame * width;
		for (let i = 0; i < width; i++) out[offset + i] = prepared[offset + i] * weights[frame];
	}
	return out;
}

/**
 * How close a prepared window comes to the nearest example, -1 to 1.
 *
 * @param skip Example indices to leave out. Training uses it to ask how well a
 *             recording is recognised by the OTHER recordings.
 */
export function nearestWakeSimilarity(
	templates: Float32Array,
	count: number,
	prepared: Float32Array,
	skip?: (index: number) => boolean
): number {
	const size = prepared.length;
	let best = -1;
	for (let index = 0; index < count; index++) {
		if (skip?.(index)) continue;
		const offset = index * size;
		let sum = 0;
		for (let i = 0; i < size; i++) sum += prepared[i] * templates[offset + i];
		if (sum > best) best = sum;
	}
	return best;
}

/** Similarity to score: 0 to 1, 0.5 at the model's midpoint. */
export function wakeScoreFromSimilarity(
	similarity: number,
	midpoint: number,
	steepness: number
): number {
	return 1 / (1 + Math.exp(-steepness * (similarity - midpoint)));
}

/**
 * Score one classifier window against a trained phrase, 0 to 1.
 *
 * Returns 0 for a window the model cannot read (a front end with a different
 * embedding width than the one it was trained on) rather than throwing: this
 * runs on every hop of an always-on stream.
 */
export function scoreEnrolledWakeWindow(model: EnrolledWakeModel, window: Float32Array): number {
	if (model.count === 0 || window.length < model.frames * model.width) return 0;
	if (window.length % model.width !== 0) return 0;
	const prepared = prepareWakeWindow(window, model.frames, model.width, model.mean);
	const similarity = nearestWakeSimilarity(model.templates, model.count, prepared);
	return wakeScoreFromSimilarity(similarity, model.midpoint, model.steepness);
}

/** Whether a stored model's numbers are usable by this build. */
export function isUsableEnrolledWakeModel(model: EnrolledWakeModel): boolean {
	return (
		model.version === ENROLLED_WAKE_MODEL_VERSION &&
		model.frames > 0 &&
		model.frames <= WAKE_CLASSIFIER_WINDOW &&
		model.width > 0 &&
		model.mean.length === model.width &&
		model.templates.length === model.count * model.frames * model.width &&
		Number.isFinite(model.midpoint) &&
		Number.isFinite(model.steepness)
	);
}
