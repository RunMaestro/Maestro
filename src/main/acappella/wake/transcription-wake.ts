/**
 * The transcription wake engine: any phrase, no training.
 *
 * openWakeWord only fires on phrases a model was trained for. This engine is
 * the fallback for every other phrase: the local recogniser (Parakeet)
 * transcribes each short burst of speech, and the phrase is matched in the
 * text. It plugs into the same `WakePhraseScorer` seam as the classifier, so
 * the detector's debounce, thresholds, and single outward edge are unchanged.
 *
 * **Still local, by type.** The scorer declares `tier: 'local'`, which is what
 * the detector requires, and the recogniser is the on-device Parakeet model.
 * No audio leaves the machine before a wake, exactly as with the classifier.
 *
 * **Only the start of a burst is transcribed.** A wake phrase opens an
 * utterance ("hey scout, run the tests"), so each burst is cut at
 * {@link MAX_BURST_MS} and decoded once. A long monologue therefore costs one
 * short decode, not a running transcription of the room.
 *
 * **The cost is memory.** Parakeet stays loaded while hands-free is on (about
 * 1 GB). That is why this is the fallback and the classifier is the default.
 * The model is LEASED from the core speech-to-text pool, so a voice session or
 * a dictation that also uses Parakeet shares this copy instead of loading a
 * second one.
 */

import { SpeechBurstSegmenter } from '../audio/speech-burst';
import { TRANSCRIPTION_WAKE_PROVIDER_ID } from '../models/capability-gate';
import { getSpeechToTextPool } from '../../local-models/speech-to-text';
import { PARAKEET_TDT_V2_ID } from '../../../shared/local-models/model-catalog';
import { normalizeWakePhrase } from '../../../shared/acappella/voice-models';
import { ACAPPELLA_AUDIO_FRAME_SAMPLES } from '../../../shared/acappella/audio-host';
import { int16ToFloat32 } from '../../../shared/audio/pcm';
import type { WakeEngine } from '../../../shared/acappella/voice-controls';
import { logger } from '../../utils/logger';
import type { WakePhrase, WakePhraseScorer } from './wake-detector';

const LOG_CONTEXT = 'ACappella';

// Defined beside the classifier engine's id in the gate, which owns both;
// re-exported so this module stays the one import site for the engine.
export { TRANSCRIPTION_WAKE_PROVIDER_ID };

/** Longest stretch of one burst that is decoded. Wake phrases are short and come first. */
const MAX_BURST_MS = 3000;

/** Audio kept ahead of speech onset, so the first syllable is not clipped. */
const PRE_SPEECH_MS = 300;

/** Bursts shorter than this are coughs and clicks, not a phrase. */
const MIN_BURST_MS = 300;

const SAMPLE_RATE = 16000;
const INT16_SCALE = 32768;

/**
 * Text similarity below which a window is not the phrase at all. Character edit
 * similarity is generous: "hey there" against "hey jarvis" already scores about
 * 0.6, so the score is rescaled to start at this floor. 0.8 similarity (one
 * misheard letter in a short phrase) lands at 0.5, the default threshold.
 */
const SIMILARITY_FLOOR = 0.6;

/**
 * How well `phrase` appears in `transcript`, 0 to 1.
 *
 * Both are normalised (case, punctuation), then every run of transcript words
 * as long as the phrase is compared to it by character edit similarity, so
 * "Hey, Jarvis!" and "hey jarvis" match exactly and a recogniser's near miss
 * ("hey jarvi") still scores high. Exported for tests.
 */
export function scoreWakePhraseInTranscript(phrase: string, transcript: string): number {
	const wanted = normalizeWakePhrase(phrase);
	const heard = normalizeWakePhrase(transcript);
	if (!wanted || !heard) return 0;

	const wantedWords = wanted.split(' ').length;
	const words = heard.split(' ');
	let best = 0;
	for (let start = 0; start + wantedWords <= words.length; start++) {
		const window = words.slice(start, start + wantedWords).join(' ');
		best = Math.max(best, similarity(wanted, window));
		if (best === 1) break;
	}
	if (words.length < wantedWords) best = similarity(wanted, heard);
	return Math.max(0, (best - SIMILARITY_FLOOR) / (1 - SIMILARITY_FLOOR));
}

/** 1 minus normalised Levenshtein distance. */
function similarity(a: string, b: string): number {
	if (a === b) return 1;
	const longest = Math.max(a.length, b.length);
	if (longest === 0) return 1;
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
		}
		previous = current;
	}
	return 1 - previous[b.length] / longest;
}

/** What the scorer needs of a recogniser. Injected in tests. */
export interface WakeTranscriber {
	transcribe(audio: Float32Array): Promise<string>;
	unload(): Promise<void>;
}

/**
 * A scorer over a ready transcriber. Separate from the factory so the burst and
 * scoring policy can be tested with a fake transcriber and generated audio.
 */
export function createTranscriptionScorer(transcriber: WakeTranscriber): WakePhraseScorer {
	const minBurstSamples = (MIN_BURST_MS / 1000) * SAMPLE_RATE;

	/** The phrases the hop being scored was asked about; a burst is decoded against these. */
	let armed: readonly WakePhrase[] = [];
	/** Scores waiting to be reported on the next hop, then cleared. */
	let pending: Record<string, number> = {};
	let decoding = false;
	let disposed = false;

	function decode(audio: Float32Array, phrases: readonly WakePhrase[]): void {
		if (decoding || audio.length < minBurstSamples) return;
		decoding = true;
		void transcriber
			.transcribe(audio)
			.then((text) => {
				if (disposed || !text) return;
				const scores: Record<string, number> = {};
				for (const phrase of phrases) {
					scores[phrase.id] = scoreWakePhraseInTranscript(phrase.phrase, text);
				}
				pending = scores;
			})
			.catch((err: Error) => {
				logger.warn(`Transcription wake decode failed: ${err.message}`, LOG_CONTEXT);
			})
			.finally(() => {
				decoding = false;
			});
	}

	// A burst is decoded once: at the cap when the speaker keeps going (the
	// phrase, if any, is at the start), otherwise when the speech ends.
	const segmenter = new SpeechBurstSegmenter({
		preSpeechMs: PRE_SPEECH_MS,
		maxBurstMs: MAX_BURST_MS,
		onBurst: (burst) => decode(int16ToFloat32(burst.pcm), armed),
	});

	return {
		tier: 'local',
		score(hop, phrases) {
			// Report what the last decode found exactly once: a hit held across hops
			// would only be debounced, but a stale miss could hide a new hit.
			const report = pending;
			pending = {};
			armed = phrases;

			for (let offset = 0; offset < hop.length; offset += ACAPPELLA_AUDIO_FRAME_SAMPLES) {
				const frame = hop.subarray(offset, offset + ACAPPELLA_AUDIO_FRAME_SAMPLES);
				const pcm = new Int16Array(frame.length);
				for (let i = 0; i < frame.length; i++) {
					pcm[i] = Math.max(-INT16_SCALE, Math.min(INT16_SCALE - 1, frame[i] * INT16_SCALE));
				}
				segmenter.pushFrame(pcm);
			}
			return report;
		},
		async dispose() {
			disposed = true;
			await transcriber.unload();
		},
	};
}

/**
 * The transcription scorer over the installed Parakeet model.
 *
 * Returns null when the runtime or the model is missing, like the classifier's
 * factory: the detector then runs inert, and the capability gate is where the
 * missing piece becomes a sentence the user can act on.
 */
export async function createTranscriptionWakeScorer(): Promise<WakePhraseScorer | null> {
	try {
		const lease = await getSpeechToTextPool().acquire(
			PARAKEET_TDT_V2_ID,
			TRANSCRIPTION_WAKE_PROVIDER_ID
		);
		return createTranscriptionScorer({
			transcribe: (audio) => lease.transcribe(audio),
			unload: () => lease.release(),
		});
	} catch (err) {
		logger.info(`Transcription wake engine unavailable: ${(err as Error).message}`, LOG_CONTEXT);
		return null;
	}
}

/**
 * The scorer factory for a wake engine. One place decides, so the hands-free
 * listener and the Test button cannot run different engines for one setting.
 */
export function wakeScorerFactory(
	engine: WakeEngine
): (() => Promise<WakePhraseScorer | null>) | undefined {
	// Undefined means the detector's own default, the openWakeWord classifier.
	return engine === 'transcription' ? createTranscriptionWakeScorer : undefined;
}
