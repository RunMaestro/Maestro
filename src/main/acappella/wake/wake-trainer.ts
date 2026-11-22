/**
 * Builds the matcher for a phrase from the user's own recordings.
 *
 * In: a couple of dozen short recordings of the phrase and half a minute of
 * ordinary speech. Out: an {@link EnrolledWakeModel}. Nothing here downloads,
 * uploads, or needs a GPU; the only heavy step is running the recordings
 * through the wake word's own front end, which the caller supplies.
 *
 * What it does, in order:
 *
 *   1. **Finds the phrase inside each recording.** A recording is a burst cut
 *      by the voice activity detector, with silence either side. The examples
 *      have to end where the phrase ends, because that is the moment the live
 *      detector should fire.
 *   2. **Makes several examples of each recording.** As recorded, then again
 *      quieter or louder, a little faster or slower, over more room noise, and
 *      with other speech running right up to it. Twenty recordings in one sitting
 *      all share one room and one mood; the copies are what stops the model
 *      requiring that room and that mood.
 *   3. **Drops recordings that are not like the rest.** A cough the detector
 *      mistook for the phrase would otherwise be an example of the phrase.
 *   4. **Finds the threshold.** Each recording is scored against the OTHERS, and
 *      the ordinary speech is scored against all of them. The score is set to
 *      cross 0.5 between the two, and how far apart they are is the quality the
 *      user is told.
 *
 * Deterministic: the same recordings give the same model, so a result that
 * changed means the recordings changed.
 */

import { SPEECH_SAMPLE_RATE } from '../../../shared/audio/pcm';
import {
	WAKE_ENROLLMENT_TARGET_CLIPS,
	wakePhraseKey,
	type WakeEnrollmentQuality,
	type WakeEnrollmentReport,
	type WakeTrainingPhase,
} from '../../../shared/acappella/wake-enrollment';
import { DEFAULT_WAKE_DEBOUNCE_MS } from '../../../shared/acappella/voice-controls';
import {
	ENROLLED_WAKE_MODEL_VERSION,
	nearestWakeSimilarity,
	prepareWakeWindow,
	weightWakeTemplate,
	type EnrolledWakeModel,
} from './enrolled-wake-model';
import {
	WAKE_CLASSIFIER_WINDOW,
	WAKE_HOP_SAMPLES,
	WAKE_WARMUP_HOPS,
	type WakeFeatureWindow,
	type WakeFeaturizer,
} from './wake-features';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Examples made of each recording: one as recorded, the rest varied. */
const VARIANTS_PER_CLIP = 6;

/**
 * Hops after the phrase ends that still count as "the phrase just ended".
 *
 * Two, not more: later windows hold whatever followed the phrase, and in real
 * use that is the request ("hey scout, run the tests"), not the silence a
 * recording has there.
 */
const POSITIVE_HOPS = 2;

/** Fewest trailing embeddings compared, however short the phrase. */
const MIN_FRAMES = 4;

/**
 * Audio one speech embedding is computed from: 76 mel frames at a 10 ms stride.
 * What decides how much of an embedding is the phrase and how much is whatever
 * was said before it.
 */
const EMBEDDING_SPAN_SAMPLES = 12_160;

/** An embedding the phrase accounts for less than this much of is not compared. */
const MIN_FRAME_WEIGHT = 0.05;

/** Analysis frame for finding the phrase inside a recording: 20 ms. */
const BOUNDS_FRAME_SAMPLES = 320;

/** A frame this far below the recording's loudest frame is not speech. */
const SPEECH_RELATIVE_LEVEL = 0.15;

/** Audio kept either side of the detected phrase, so a soft onset or tail survives. */
const SPEECH_PAD_BEFORE = 1600;
const SPEECH_PAD_AFTER = 800;

/** Least audio in front of the phrase in an example. */
const MIN_LEAD_SAMPLES = 6400;

/** Silence between other speech and the phrase, in an example that has speech before it. */
const SPEECH_LEAD_GAP_SAMPLES = 4000;

/** How much faster or slower a varied example is played. */
const MIN_SPEED = 0.85;
const MAX_SPEED = 1.18;

/** Room noise levels a varied example may be given, as RMS. */
const NOISE_LEVELS = [0.002, 0.005, 0.01, 0.02];

/** Seconds of plain noise scored as "not the phrase", at each of these levels. */
const NOISE_ONLY_SECONDS = 4;
const NOISE_ONLY_LEVELS = [0.001, 0.01, 0.05];

/** A recording this far below the typical one is not the phrase. In similarity. */
const OUTLIER_MIN_DROP = 0.12;

/** The same, in robust standard deviations, for recordings that vary a lot. */
const OUTLIER_SIGMAS = 4;

/** Most recordings that may be dropped as outliers, as a share of all of them. */
const MAX_OUTLIER_SHARE = 0.25;

/** The share of recordings allowed to score under the "least phrase-like recording". */
const POSITIVE_FLOOR_QUANTILE = 0.1;

/**
 * Where 0.5 sits between other speech and the recordings: 0 is at the other
 * speech, 1 at the recordings.
 *
 * Past the middle on purpose. Thirty seconds of ordinary speech is a small
 * sample of everything that will be said near this microphone, so the most
 * phrase-like thing in it understates what is coming; the recordings are a
 * good sample of the phrase.
 */
const MIDPOINT_BIAS = 0.6;

/** Score reached at the edges of the gap: 0.12 at the other speech, 0.88 at the recordings. */
const LOGIT_AT_EDGE = 2;

/** Narrowest gap the score curve is built on, so a tiny gap cannot make it a step. */
const MIN_CURVE_GAP = 0.04;

/** Gaps, in similarity, at which a phrase is called strong or fair. */
const STRONG_GAP = 0.12;
const FAIR_GAP = 0.04;

/** Windows compared between yields to the event loop. Training runs in the main process. */
const YIELD_EVERY = 64;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface WakeTrainingInput {
	phrase: string;
	/** One burst of the phrase each. Mono float in [-1, 1] at 16 kHz. */
	clips: readonly Float32Array[];
	/** Ordinary speech that is NOT the phrase. Same format. */
	background: Float32Array;
	featurizer: Pick<WakeFeaturizer, 'featurize'>;
	onProgress?: (phase: WakeTrainingPhase, progress: number) => void;
	/** Injected for tests. Defaults to a fixed-seed generator, so training is repeatable. */
	random?: () => number;
	now?: () => number;
}

/** Thrown when the recordings cannot be turned into a model at all. */
export class WakeTrainingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WakeTrainingError';
	}
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/** Where the phrase sits inside a recording, and how quiet the room around it is. */
export interface SpeechBounds {
	start: number;
	end: number;
	/** RMS of the recording's quietest frames. */
	noiseFloor: number;
}

/**
 * Find the phrase inside a recording by level.
 *
 * Relative to the recording's own loudest frame, so a quiet microphone and a hot
 * one both work. Returns null for a recording with no frame that stands out.
 */
export function findSpeechBounds(audio: Float32Array): SpeechBounds | null {
	const levels: number[] = [];
	for (let i = 0; i + BOUNDS_FRAME_SAMPLES <= audio.length; i += BOUNDS_FRAME_SAMPLES) {
		let sum = 0;
		for (let j = 0; j < BOUNDS_FRAME_SAMPLES; j++) sum += audio[i + j] * audio[i + j];
		levels.push(Math.sqrt(sum / BOUNDS_FRAME_SAMPLES));
	}
	if (!levels.length) return null;
	const peak = Math.max(...levels);
	if (peak <= 0) return null;

	const threshold = peak * SPEECH_RELATIVE_LEVEL;
	const first = levels.findIndex((level) => level > threshold);
	let last = levels.length - 1;
	while (last > first && levels[last] <= threshold) last--;
	if (first < 0) return null;

	const sorted = [...levels].sort((a, b) => a - b);
	const noiseFloor = sorted[Math.floor(sorted.length * 0.1)];
	return {
		start: first * BOUNDS_FRAME_SAMPLES,
		end: (last + 1) * BOUNDS_FRAME_SAMPLES,
		noiseFloor,
	};
}

/**
 * Play audio faster or slower by linear interpolation.
 *
 * Not `resampleFloat32`: that converts between sample RATES and box-filters on
 * the way down, which at a ratio this close to one averages an uneven one or two
 * samples per output and adds a buzz. A few percent of speed change wants plain
 * interpolation in both directions. The pitch moves with the speed, which is
 * wanted: people who hurry a phrase also raise it.
 */
function changeSpeed(audio: Float32Array, speed: number): Float32Array {
	if (speed === 1) return audio;
	const out = new Float32Array(Math.max(1, Math.floor(audio.length / speed)));
	for (let i = 0; i < out.length; i++) {
		const position = i * speed;
		const left = Math.floor(position);
		const right = Math.min(audio.length - 1, left + 1);
		out[i] = audio[left] + (audio[right] - audio[left]) * (position - left);
	}
	return out;
}

/** A fixed-seed generator. Training must not depend on `Math.random`. */
function seededRandom(seed = 0x5eed): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

function gaussian(random: () => number): number {
	return Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
}

function addNoise(audio: Float32Array, level: number, random: () => number): void {
	for (let i = 0; i < audio.length; i++) audio[i] += gaussian(random) * level;
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

interface ExampleOptions {
	speed: number;
	gain: number;
	noise: number;
	/** Put other speech in front of the phrase instead of room noise. */
	speechLead: boolean;
}

interface ComposedExample {
	audio: Float32Array;
	/** Sample index just past the phrase. */
	speechEnd: number;
}

/**
 * One example of the phrase as the live detector would meet it: something in
 * front (the front end needs two seconds before it produces a window at all),
 * then the phrase, then a little room.
 */
function composeExample(
	speech: Float32Array,
	background: Float32Array,
	options: ExampleOptions,
	random: () => number
): ComposedExample {
	const spoken = changeSpeed(speech, options.speed);
	const needed = (WAKE_WARMUP_HOPS + 1) * WAKE_HOP_SAMPLES - spoken.length;
	// The sub-hop jitter is not decoration. The live stream is cut into hops
	// wherever it happens to be cut, so the phrase ends at a different place
	// inside a hop every time it is said.
	const lead = Math.max(MIN_LEAD_SAMPLES, needed) + Math.floor(random() * WAKE_HOP_SAMPLES);
	const tail = (POSITIVE_HOPS + 1) * WAKE_HOP_SAMPLES;
	const audio = new Float32Array(lead + spoken.length + tail);

	if (options.speechLead && background.length > lead) {
		const from = Math.floor(random() * (background.length - lead));
		const until = lead - SPEECH_LEAD_GAP_SAMPLES;
		for (let i = 0; i < until; i++) audio[i] = background[from + i];
	}
	for (let i = 0; i < spoken.length; i++) audio[lead + i] += spoken[i] * options.gain;
	addNoise(audio, options.noise, random);

	return { audio, speechEnd: lead + spoken.length };
}

/** A window that ends where the phrase ends, and which recording it came from. */
interface PositiveWindow {
	clip: number;
	variant: number;
	window: Float32Array;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function quantile(sortedAscending: readonly number[], q: number): number {
	if (!sortedAscending.length) return 0;
	const position = (sortedAscending.length - 1) * q;
	const lower = Math.floor(position);
	const upper = Math.min(sortedAscending.length - 1, lower + 1);
	return (
		sortedAscending[lower] + (sortedAscending[upper] - sortedAscending[lower]) * (position - lower)
	);
}

function median(values: readonly number[]): number {
	return quantile(
		[...values].sort((a, b) => a - b),
		0.5
	);
}

/**
 * How much each trailing embedding counts, newest LAST, summing to one.
 *
 * An embedding is computed from the 760 ms before it. At the moment a phrase
 * ends, the newest few embeddings are all phrase; older ones are part phrase and
 * part whatever preceded it; older still are none of it. Comparing those older
 * frames one for one would score the room, and a phrase said straight after
 * other speech would not match a recording made in silence: measured, it was
 * missed half the time. So each frame counts by the share of its audio the
 * phrase accounts for, and frames it barely touches are not compared at all.
 *
 * @param phraseSamples How long the phrase is.
 * @param afterSamples  How far past the end of the phrase the window ends.
 */
export function wakeFrameWeights(phraseSamples: number, afterSamples: number): Float32Array {
	const shares: number[] = [];
	for (let back = 0; back < WAKE_CLASSIFIER_WINDOW; back++) {
		// Positions are measured back from the end of the window, in samples.
		const frameEnd = back * WAKE_HOP_SAMPLES;
		const frameStart = frameEnd + EMBEDDING_SPAN_SAMPLES;
		const phraseEnd = afterSamples;
		const phraseStart = afterSamples + phraseSamples;
		const overlap = Math.min(frameStart, phraseStart) - Math.max(frameEnd, phraseEnd);
		const share = Math.max(0, overlap) / EMBEDDING_SPAN_SAMPLES;
		if (share < MIN_FRAME_WEIGHT && back >= MIN_FRAMES) break;
		shares.push(Math.max(share, MIN_FRAME_WEIGHT));
	}
	const total = shares.reduce((sum, share) => sum + share, 0);
	// Newest last, matching the order embeddings sit in a window.
	return Float32Array.from(shares.reverse(), (share) => share / total);
}

/** The embedding every frame shares: the mean over every frame of every window. */
function meanEmbedding(windows: readonly Float32Array[], width: number): Float32Array {
	const mean = new Float32Array(width);
	let frames = 0;
	for (const window of windows) {
		for (let offset = 0; offset + width <= window.length; offset += width) {
			for (let i = 0; i < width; i++) mean[i] += window[offset + i];
			frames++;
		}
	}
	if (frames > 0) for (let i = 0; i < width; i++) mean[i] /= frames;
	return mean;
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

export async function trainEnrolledWakeModel(input: WakeTrainingInput): Promise<EnrolledWakeModel> {
	const random = input.random ?? seededRandom();
	const now = input.now ?? Date.now;
	const report = (phase: WakeTrainingPhase, progress: number) =>
		input.onProgress?.(phase, Math.min(1, Math.max(0, progress)));

	// -- 1. The phrase inside each recording ---------------------------------
	const speech: Float32Array[] = [];
	const floors: number[] = [];
	const phraseLengths: number[] = [];
	for (const clip of input.clips) {
		const bounds = findSpeechBounds(clip);
		if (!bounds) continue;
		const from = Math.max(0, bounds.start - SPEECH_PAD_BEFORE);
		const to = Math.min(clip.length, bounds.end + SPEECH_PAD_AFTER);
		speech.push(clip.slice(from, to));
		floors.push(Math.max(0.0005, Math.min(0.02, bounds.noiseFloor)));
		phraseLengths.push(bounds.end - bounds.start);
	}
	if (speech.length < 2) {
		throw new WakeTrainingError('There are not enough usable recordings of the phrase.');
	}

	// A window that counts as the phrase ends up to POSITIVE_HOPS after the padded
	// recording does; the middle of that range is where a typical one ends.
	const weights = wakeFrameWeights(
		median(phraseLengths),
		SPEECH_PAD_AFTER + (POSITIVE_HOPS * WAKE_HOP_SAMPLES) / 2
	);
	const frames = weights.length;

	// -- 2. Examples -----------------------------------------------------------
	const backgroundPasses = 3;
	const units = speech.length * VARIANTS_PER_CLIP + backgroundPasses + NOISE_ONLY_LEVELS.length;
	let done = 0;
	const step = () => report('listening', (++done / units) * 0.85);

	const positives: PositiveWindow[] = [];
	const negatives: Float32Array[] = [];

	for (let clip = 0; clip < speech.length; clip++) {
		for (let variant = 0; variant < VARIANTS_PER_CLIP; variant++) {
			const options: ExampleOptions =
				variant === 0
					? { speed: 1, gain: 1, noise: floors[clip], speechLead: false }
					: {
							speed: MIN_SPEED + random() * (MAX_SPEED - MIN_SPEED),
							gain: 0.4 + random(),
							noise: NOISE_LEVELS[Math.floor(random() * NOISE_LEVELS.length)],
							speechLead: random() < 0.5,
						};
			const example = composeExample(speech[clip], input.background, options, random);
			const windows = await input.featurizer.featurize(example.audio);
			for (const { end, window } of windows) {
				const after = end - example.speechEnd;
				if (after >= 0 && after < POSITIVE_HOPS * WAKE_HOP_SAMPLES) {
					positives.push({ clip, variant, window });
				}
			}
			step();
		}
	}

	/** The ordinary speech as recorded, in order: what the false alarm count is read from. */
	let backgroundStream: WakeFeatureWindow[] = [];
	for (let pass = 0; pass < backgroundPasses; pass++) {
		const offset = pass === 0 ? 0 : Math.floor(random() * WAKE_HOP_SAMPLES);
		const gain = pass === 0 ? 1 : 0.4 + random();
		const audio = new Float32Array(input.background.length + offset);
		for (let i = 0; i < input.background.length; i++)
			audio[offset + i] = input.background[i] * gain;
		if (pass > 0) addNoise(audio, NOISE_LEVELS[pass], random);
		const windows = await input.featurizer.featurize(audio);
		if (pass === 0) backgroundStream = windows;
		for (const { window } of windows) negatives.push(window);
		step();
	}
	for (const level of NOISE_ONLY_LEVELS) {
		const audio = new Float32Array(NOISE_ONLY_SECONDS * SPEECH_SAMPLE_RATE);
		addNoise(audio, level, random);
		for (const { window } of await input.featurizer.featurize(audio)) negatives.push(window);
		step();
	}

	if (!positives.length) {
		throw new WakeTrainingError('The recordings were too short to learn the phrase from.');
	}
	if (!backgroundStream.length) {
		throw new WakeTrainingError('The other-speech recording is too short to calibrate against.');
	}

	// -- 3. Comparable form ----------------------------------------------------
	const width = positives[0].window.length / WAKE_CLASSIFIER_WINDOW;
	const mean = meanEmbedding([...negatives, ...positives.map((entry) => entry.window)], width);
	const size = frames * width;
	const prepare = (window: Float32Array) => prepareWakeWindow(window, frames, width, mean);

	const prepared = positives.map((entry) => prepare(entry.window));
	const pack = (keep: (entry: PositiveWindow) => boolean) => {
		const kept = positives.map((entry, index) => ({ entry, index })).filter((x) => keep(x.entry));
		const templates = new Float32Array(kept.length * size);
		kept.forEach(({ index }, slot) =>
			templates.set(weightWakeTemplate(prepared[index], weights, width), slot * size)
		);
		return { templates, clips: kept.map(({ entry }) => entry.clip) };
	};

	/**
	 * How well each recording is recognised by the OTHERS: its as-recorded
	 * windows against every example that did not come from it.
	 */
	const leaveOneOut = (set: { templates: Float32Array; clips: number[] }, clips: number[]) =>
		clips.map((clip) => {
			let best = -1;
			positives.forEach((entry, index) => {
				if (entry.clip !== clip || entry.variant !== 0) return;
				const similarity = nearestWakeSimilarity(
					set.templates,
					set.clips.length,
					prepared[index],
					(template) => set.clips[template] === clip
				);
				if (similarity > best) best = similarity;
			});
			return best;
		});

	// -- 4. Outliers -----------------------------------------------------------
	const allClips = speech.map((_, index) => index);
	let model = pack(() => true);
	let peaks = leaveOneOut(model, allClips);
	report('comparing', 0.88);

	const typical = median(peaks);
	const spread = median(peaks.map((peak) => Math.abs(peak - typical))) * 1.4826;
	const cutoff = typical - Math.max(OUTLIER_MIN_DROP, OUTLIER_SIGMAS * spread);
	const maxDropped = Math.floor(allClips.length * MAX_OUTLIER_SHARE);
	const dropped = allClips
		.filter((clip) => peaks[clip] < cutoff)
		.sort((a, b) => peaks[a] - peaks[b])
		.slice(0, maxDropped);
	let kept = allClips;
	if (dropped.length) {
		kept = allClips.filter((clip) => !dropped.includes(clip));
		model = pack((entry) => kept.includes(entry.clip));
		peaks = leaveOneOut(model, kept);
	}

	// -- 5. The threshold ------------------------------------------------------
	const similarityOf = (window: Float32Array) =>
		nearestWakeSimilarity(model.templates, model.clips.length, prepare(window));

	let otherSpeech = -1;
	for (let i = 0; i < negatives.length; i++) {
		const similarity = similarityOf(negatives[i]);
		if (similarity > otherSpeech) otherSpeech = similarity;
		if (i % YIELD_EVERY === 0) {
			report('comparing', 0.88 + (i / negatives.length) * 0.1);
			await yieldToEventLoop();
		}
	}

	const sortedPeaks = [...peaks].sort((a, b) => a - b);
	const recordings = quantile(sortedPeaks, POSITIVE_FLOOR_QUANTILE);
	const gap = recordings - otherSpeech;
	const midpoint = gap > 0 ? otherSpeech + gap * MIDPOINT_BIAS : (recordings + otherSpeech) / 2;
	const steepness = (2 * LOGIT_AT_EDGE) / Math.max(MIN_CURVE_GAP, gap);

	// -- 6. What to tell the user ---------------------------------------------
	let falseAlarms = 0;
	let lastAlarm = Number.NEGATIVE_INFINITY;
	const debounceSamples = (DEFAULT_WAKE_DEBOUNCE_MS / 1000) * SPEECH_SAMPLE_RATE;
	for (const { end, window } of backgroundStream) {
		if (similarityOf(window) < midpoint) continue;
		if (end - lastAlarm > debounceSamples) falseAlarms++;
		lastAlarm = end;
	}
	const recognized = peaks.filter((peak) => peak >= midpoint).length;
	const quality: WakeEnrollmentQuality =
		gap >= STRONG_GAP ? 'strong' : gap >= FAIR_GAP ? 'fair' : 'weak';

	const result: WakeEnrollmentReport = {
		clipsUsed: kept.length,
		clipsTotal: input.clips.length,
		recognized,
		falseAlarms,
		backgroundMs: Math.round((input.background.length / SPEECH_SAMPLE_RATE) * 1000),
		quality,
	};
	const advice = adviceFor(result, gap);
	if (advice) result.advice = advice;

	report('comparing', 0.98);
	return {
		version: ENROLLED_WAKE_MODEL_VERSION,
		phrase: input.phrase,
		key: wakePhraseKey(input.phrase),
		trainedAt: now(),
		frames,
		width,
		mean,
		templates: model.templates,
		count: model.clips.length,
		midpoint,
		steepness,
		report: result,
	};
}

/** The one thing worth doing next, or nothing when the phrase is in good shape. */
function adviceFor(report: WakeEnrollmentReport, gap: number): string | undefined {
	if (gap <= 0) {
		return 'Something in the other-speech recording sounds like the phrase. Record it again without saying the phrase, or choose a longer phrase.';
	}
	if (report.quality === 'weak' || report.recognized < report.clipsUsed * 0.8) {
		return 'Your recordings differ a lot from each other. Record more, saying the phrase the way you would to wake Maestro.';
	}
	if (report.clipsUsed < WAKE_ENROLLMENT_TARGET_CLIPS) {
		return 'More recordings will make it more reliable.';
	}
	return undefined;
}
