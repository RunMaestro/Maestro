/**
 * Mock text-to-speech: sentence events on a timer, no audio.
 *
 * `format: 'none'` with `audio: null` is a legal `TtsChunk`, which is what lets
 * the mock tier drive the real speaking path: the HUD renders one sentence at a
 * time, `speak-end` fires, and barge-in cuts the run off, all without a voice
 * model. The sentence boundaries come from the shared splitter and nowhere else,
 * because the session already announced `sentenceCount` from that same splitter
 * and a second opinion would leave a client's "3 of 5" stuck forever.
 */

import type {
	TtsChunk,
	TtsProvider,
	TtsSpeakOptions,
} from '../../../../shared/acappella/providers';
import { splitIntoSpokenSentences } from '../../../../shared/acappella/sentences';

/** Roughly a natural reading pace, so the HUD looks like something is speaking. */
const DEFAULT_MS_PER_CHARACTER = 32;
const DEFAULT_MIN_SENTENCE_MS = 220;
/** Ceiling so one long sentence cannot stall a demo. */
const DEFAULT_MAX_SENTENCE_MS = 2_500;

export interface MockTtsOptions {
	/** Simulated speech rate. Tests pass 0 to emit every sentence immediately. */
	msPerCharacter?: number;
	minSentenceMs?: number;
	maxSentenceMs?: number;
}

/** A sleep that `cancel()` can cut short, so barge-in does not wait out a sentence. */
interface PendingSleep {
	wake: () => void;
}

export class MockTtsProvider implements TtsProvider {
	readonly id = 'mock-tts';
	readonly label = 'Mock (silent)';
	readonly tier = 'mock' as const;

	private readonly msPerCharacter: number;
	private readonly minSentenceMs: number;
	private readonly maxSentenceMs: number;

	/** Bumped by `cancel()` and by every new run, so a stale iterator returns. */
	private run = 0;
	private pending: PendingSleep | null = null;

	constructor(options: MockTtsOptions = {}) {
		this.msPerCharacter = options.msPerCharacter ?? DEFAULT_MS_PER_CHARACTER;
		this.minSentenceMs = options.minSentenceMs ?? DEFAULT_MIN_SENTENCE_MS;
		this.maxSentenceMs = options.maxSentenceMs ?? DEFAULT_MAX_SENTENCE_MS;
	}

	speak(text: string, options: TtsSpeakOptions): AsyncIterable<TtsChunk> {
		// The run is claimed here, not inside the generator: a generator body does
		// not run until the first `next()`, and a second `speak()` has to supersede
		// the first one immediately.
		return this.stream(splitIntoSpokenSentences(text), ++this.run, options);
	}

	/** Barge-in. Wakes the in-flight sentence delay so the iterator ends now. */
	cancel(): void {
		this.run += 1;
		const pending = this.pending;
		this.pending = null;
		pending?.wake();
	}

	// -- Internals -----------------------------------------------------------

	private async *stream(
		sentences: string[],
		run: number,
		options: TtsSpeakOptions
	): AsyncGenerator<TtsChunk> {
		for (let index = 0; index < sentences.length; index++) {
			// Checked before every sentence: a run cancelled mid-sentence must not
			// deliver the one that follows it.
			if (this.run !== run) return;

			const sentence = sentences[index];
			yield {
				utteranceId: options.utteranceId,
				index,
				text: sentence,
				format: 'none',
				audio: null,
			};

			// The delay follows the sentence because a real voice starts speaking as
			// soon as the sentence begins: the wait IS the speech.
			await this.sleep(this.sentenceDurationMs(sentence, options.rate));
		}
	}

	private sentenceDurationMs(sentence: string, rate?: number): number {
		// A zero rate per character means "no simulated speech time at all", which
		// is what tests want; the floor below must not put the delay back.
		if (this.msPerCharacter <= 0) return 0;

		const speed = rate && rate > 0 ? rate : 1;
		const raw = (sentence.length * this.msPerCharacter) / speed;
		return Math.min(this.maxSentenceMs, Math.max(this.minSentenceMs, Math.round(raw)));
	}

	private sleep(ms: number): Promise<void> {
		if (ms <= 0) return Promise.resolve();

		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.pending = null;
				resolve();
			}, ms);

			this.pending = {
				wake: () => {
					clearTimeout(timer);
					resolve();
				},
			};
		});
	}
}
