/**
 * Fixtures for wake phrase training tests: synthetic "speech" and a stand-in
 * for the wake word's front end.
 *
 * The real front end is two ONNX graphs that no unit test can load. What the
 * trainer and the matcher need from it is narrower than what it does: the same
 * sound must come out as the same vector, different sounds as different ones,
 * and a window must hold the last sixteen hops. {@link fakeWakeFeaturizer} gives
 * exactly that by reading which of four tones each hop is, so a "phrase" here
 * is a short melody and "other speech" is a different one.
 *
 * Every vector also carries a large constant, as real speech embeddings do:
 * without it, a matcher that forgot to subtract the shared part would pass.
 */

import {
	WAKE_CLASSIFIER_WINDOW,
	WAKE_HOP_SAMPLES,
	WAKE_WARMUP_HOPS,
	type WakeFeatureWindow,
	type WakeFeaturizer,
} from '../../main/acappella/wake/wake-features';

const SAMPLE_RATE = 16000;

/** The tones the fake front end can tell apart, in Hz. */
export const TONES = { low: 300, mid: 600, high: 900, top: 1200 } as const;

const BANDS = Object.values(TONES);

/** One note: a tone and how long it lasts. A frequency of 0 is silence. */
export interface Note {
	hz: number;
	ms: number;
}

/** Render notes as mono float audio at 16 kHz. */
export function melody(notes: readonly Note[], amplitude = 0.3): Float32Array {
	const total = notes.reduce((sum, note) => sum + Math.round((note.ms / 1000) * SAMPLE_RATE), 0);
	const out = new Float32Array(total);
	let offset = 0;
	for (const note of notes) {
		const length = Math.round((note.ms / 1000) * SAMPLE_RATE);
		if (note.hz > 0) {
			for (let i = 0; i < length; i++) {
				out[offset + i] = amplitude * Math.sin((2 * Math.PI * note.hz * i) / SAMPLE_RATE);
			}
		}
		offset += length;
	}
	return out;
}

/** A "phrase": two notes, with quiet either side like a burst cut by the VAD. */
export function phraseClip(options: { amplitude?: number; stretch?: number } = {}): Float32Array {
	const stretch = options.stretch ?? 1;
	return melody(
		[
			{ hz: 0, ms: 300 },
			{ hz: TONES.mid, ms: 320 * stretch },
			{ hz: TONES.top, ms: 320 * stretch },
			{ hz: 0, ms: 400 },
		],
		options.amplitude ?? 0.3
	);
}

/** "Other speech": the two tones a phrase does not use, and pauses. */
export function otherSpeech(seconds: number): Float32Array {
	const notes: Note[] = [];
	const pattern: Note[] = [
		{ hz: TONES.low, ms: 240 },
		{ hz: TONES.high, ms: 400 },
		{ hz: 0, ms: 320 },
		{ hz: TONES.high, ms: 160 },
		{ hz: TONES.low, ms: 480 },
		{ hz: 0, ms: 240 },
	];
	let ms = 0;
	for (let i = 0; ms < seconds * 1000; i++) {
		const note = pattern[i % pattern.length];
		notes.push(note);
		ms += note.ms;
	}
	return melody(notes).slice(0, seconds * SAMPLE_RATE);
}

/** Level at which a hop counts as fully "sound". Above the trainer's loudest room noise. */
const LOUD_RMS = 0.03;

/** How far, in log frequency, a pitch may sit from a tone and still count as it. */
const TONE_TOLERANCE = 0.2;

/**
 * One hop as a vector: the constant every vector shares, how loud it is, and
 * which tone it is.
 *
 * The tone is read from the hop's PITCH (zero crossings of a lightly smoothed
 * copy), not from a narrow filter. That matters: the trainer plays recordings a
 * little faster and slower, which moves their pitch, and real speech embeddings
 * shrug that off. A fake that did not would call a hurried phrase noise.
 */
function embed(hop: Float32Array): Float32Array {
	const out = new Float32Array(BANDS.length + 2);
	out[0] = 5;

	let energy = 0;
	let crossings = 0;
	let previous = 0;
	for (let i = 0; i < hop.length; i++) {
		energy += hop[i] * hop[i];
		// A four-sample average: enough to stop hiss adding crossings to a tone.
		const smooth = (hop[i] + (hop[i - 1] ?? 0) + (hop[i - 2] ?? 0) + (hop[i - 3] ?? 0)) / 4;
		if (i > 0 && smooth >= 0 !== previous >= 0) crossings += 1;
		previous = smooth;
	}
	const loud = Math.min(1, Math.sqrt(energy / hop.length) / LOUD_RMS);
	const hz = (crossings * SAMPLE_RATE) / (2 * hop.length);
	out[1] = loud;
	BANDS.forEach((tone, band) => {
		const distance = Math.log(Math.max(1, hz) / tone);
		out[band + 2] =
			3 * loud * Math.exp(-(distance * distance) / (2 * TONE_TOLERANCE * TONE_TOLERANCE));
	});
	return out;
}

/** A front end that needs no models. Counts its calls, so a test can see it was used. */
export function fakeWakeFeaturizer(): WakeFeaturizer & { calls: number; released: boolean } {
	const featurizer = {
		calls: 0,
		released: false,
		async featurize(audio: Float32Array): Promise<WakeFeatureWindow[]> {
			featurizer.calls += 1;
			const ring: Float32Array[] = [];
			const windows: WakeFeatureWindow[] = [];
			let hops = 0;
			for (let start = 0; start + WAKE_HOP_SAMPLES <= audio.length; start += WAKE_HOP_SAMPLES) {
				ring.push(embed(audio.subarray(start, start + WAKE_HOP_SAMPLES)));
				if (ring.length > WAKE_CLASSIFIER_WINDOW) ring.shift();
				hops += 1;
				// The real front end produces nothing for its first two seconds.
				if (hops <= WAKE_WARMUP_HOPS) continue;
				const width = ring[0].length;
				const window = new Float32Array(WAKE_CLASSIFIER_WINDOW * width);
				ring.forEach((vector, index) => window.set(vector, index * width));
				windows.push({ end: start + WAKE_HOP_SAMPLES, window });
			}
			return windows;
		},
		async release(): Promise<void> {
			featurizer.released = true;
		},
	};
	return featurizer;
}

/** Quiet, then `audio`, then quiet: long enough for the front end to warm up before it. */
export function withLead(audio: Float32Array, leadSeconds = 2.4): Float32Array {
	const lead = Math.round(leadSeconds * SAMPLE_RATE);
	const out = new Float32Array(lead + audio.length + SAMPLE_RATE / 2);
	out.set(audio, lead);
	return out;
}

/** Float audio as the 20 ms int16 frames the audio host delivers. */
export function toFrames(audio: Float32Array): Int16Array[] {
	const frames: Int16Array[] = [];
	for (let start = 0; start + 320 <= audio.length; start += 320) {
		const frame = new Int16Array(320);
		for (let i = 0; i < 320; i++) frame[i] = Math.round(audio[start + i] * 32767);
		frames.push(frame);
	}
	return frames;
}
