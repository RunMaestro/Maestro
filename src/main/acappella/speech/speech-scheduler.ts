/**
 * The sentence-streaming speech scheduler.
 *
 * One speech run is a queue of sentences, each moving through synthesize and
 * then play. The scheduler's whole reason to exist is the seam between those two
 * verbs: sentence N+1 is synthesized while sentence N is still audible, so there
 * is no gap between them, and no more than `lookahead` sentences are synthesized
 * beyond what has actually been heard, so a barge-in throws away one sentence of
 * paid-for audio rather than a paragraph of it.
 *
 * It owns three things nothing else should duplicate:
 *
 *   - **Segmentation.** Through `splitCompleteSentences()`, the one splitter in
 *     `src/shared/acappella/sentences.ts`. `v1.2.3`, `src/main/index.ts`, `99.5`,
 *     and `e.g.` are exactly what agents write, and a second splitter that got
 *     any of them wrong would cut a spoken sentence in half.
 *   - **The protocol events.** `speak-start`, one `speak-sentence` per sentence
 *     with its text, and `speak-end`. The live transcript and the phone render
 *     from those, so what they show is what is being said by construction.
 *   - **The end reason.** `interrupted` is not `completed`. Collapsing them makes
 *     a turn the user talked over indistinguishable from one they listened to,
 *     which is the difference the conversation memory is built on.
 */

import type { TtsChunk, TtsProvider } from '../../../shared/acappella/providers';
import {
	splitCompleteSentences,
	splitIntoSpokenSentences,
} from '../../../shared/acappella/sentences';

/**
 * How a run ended.
 *
 *   - `completed`   - every queued sentence was spoken, cap included.
 *   - `interrupted` - the user took the floor back. Distinct on purpose.
 *   - `error`       - the provider failed mid-run.
 */
export type SpeechRunEndReason = 'completed' | 'interrupted' | 'error';

export interface SpeechRunResult {
	utteranceId: string;
	reason: SpeechRunEndReason;
	/** Sentences that reached the speaker, in order. This is what was HEARD. */
	spoken: string[];
	/** Sentences that were queued and never reached it. */
	unspoken: string[];
	/** The run hit the per-turn cap and wrapped up rather than reading on. */
	capped: boolean;
}

export interface SpeechSchedulerEvents {
	onStart: (event: {
		utteranceId: string;
		sentenceCount: number;
		ttsProviderId: string;
		/** True while more sentences are still being written. `sentenceCount` is a lower bound. */
		streaming: boolean;
	}) => void;
	onSentence: (event: { utteranceId: string; index: number; text: string }) => void;
	onEnd: (result: SpeechRunResult) => void;
	/** One synthesised chunk, for the audio sink. Never broadcast. */
	onChunk?: (chunk: TtsChunk) => void;
	/** A classified provider failure. Anything unexpected is rethrown to Sentry. */
	onError?: (error: Error) => void;
}

export interface SpeechSchedulerOptions extends SpeechSchedulerEvents {
	tts: TtsProvider;
	/** Hard cap on sentences spoken per turn. */
	maxSentencesPerTurn?: number;
	/** Sentences allowed to be synthesized beyond the one being heard. */
	lookahead?: number;
	/** Longest queue held before `push()` starts dropping. */
	queueLimit?: number;
	/** Said instead of an abrupt cut when the cap is reached. */
	wrapUpText?: string;
	/**
	 * The voice and rate to synthesize with, read fresh for EVERY sentence.
	 *
	 * A getter rather than a value because that is what makes the settings apply
	 * live: a user who drags the speed slider mid-reply hears the change on the
	 * next sentence instead of on the next session. Reading it once at
	 * construction would pin the whole session to whatever was configured when it
	 * started, which is the "restart to hear your own setting" behaviour this
	 * exists to avoid.
	 */
	speechOptions?: () => { voiceId?: string; rate?: number };
}

/**
 * Roughly forty seconds of speech. Long enough for a real answer, short enough
 * that a runaway agent summary cannot hold the floor while the user waits for a
 * gap to talk into.
 */
const DEFAULT_MAX_SENTENCES_PER_TURN = 6;

/** One sentence ahead: no gap, and no more than one wasted synthesis on barge-in. */
const DEFAULT_LOOKAHEAD = 1;

/** A queue longer than this is an agent that will never be listened to in full. */
const DEFAULT_QUEUE_LIMIT = 64;

const DEFAULT_WRAP_UP = "There's more, ask me for the details.";

export class SpeechScheduler {
	private readonly options: SpeechSchedulerOptions;
	private readonly maxSentencesPerTurn: number;
	private readonly lookahead: number;
	private readonly queueLimit: number;
	private readonly wrapUpText: string;

	private utteranceId: string | null = null;
	private queue: string[] = [];
	/** Text after the last complete sentence, waiting for the rest of it. */
	private partial = '';
	private spoken: string[] = [];
	/**
	 * Sentences being synthesized right now, oldest first.
	 *
	 * This is the no-gap mechanism, and it is why synthesis is not simply awaited
	 * in a loop: `lookahead + 1` sentences are in flight at once and are DELIVERED
	 * strictly in order, so the audio for sentence two is already made by the time
	 * sentence one finishes playing. Serial synthesis would leave a provider round
	 * trip of silence between every pair of sentences.
	 */
	private pipeline: { sentence: string; chunks: Promise<TtsChunk[]> }[] = [];
	/** Sentences handed to the provider this run, delivered or not. */
	private started = 0;
	/** Sentences whose audio has reached the sink. */
	private delivered = 0;
	private capped = false;
	private closed = false;
	private running = false;
	private ended = false;
	private endReason: SpeechRunEndReason = 'completed';
	private settle: (() => void) | null = null;
	private wake: (() => void) | null = null;
	private lastResult: SpeechRunResult | null = null;

	constructor(options: SpeechSchedulerOptions) {
		this.options = options;
		this.maxSentencesPerTurn = Math.max(
			1,
			options.maxSentencesPerTurn ?? DEFAULT_MAX_SENTENCES_PER_TURN
		);
		this.lookahead = Math.max(0, options.lookahead ?? DEFAULT_LOOKAHEAD);
		this.queueLimit = Math.max(1, options.queueLimit ?? DEFAULT_QUEUE_LIMIT);
		this.wrapUpText = options.wrapUpText ?? DEFAULT_WRAP_UP;
	}

	get isSpeaking(): boolean {
		return this.utteranceId !== null && !this.ended;
	}

	get activeUtteranceId(): string | null {
		return this.ended ? null : this.utteranceId;
	}

	/**
	 * Open a run.
	 *
	 * `speak-start` is emitted here with the sentences known so far, which for a
	 * streaming turn is usually zero: the announced count is a lower bound and the
	 * `streaming` flag says so, because the alternative is holding the first
	 * sentence back until the whole reply exists and losing the entire point of
	 * the pipeline.
	 */
	begin(utteranceId: string, seed = ''): void {
		this.utteranceId = utteranceId;
		this.queue = [];
		this.partial = '';
		this.spoken = [];
		this.pipeline = [];
		this.started = 0;
		this.delivered = 0;
		this.capped = false;
		this.closed = false;
		this.ended = false;
		this.endReason = 'completed';

		if (seed) this.enqueue(splitIntoSpokenSentences(seed));

		this.options.onStart({
			utteranceId,
			sentenceCount: this.queue.length,
			ttsProviderId: this.options.tts.id,
			streaming: !this.closed,
		});
		this.pump();
	}

	/**
	 * Add text to the run. Only complete sentences are queued; the tail is held
	 * until the rest of it arrives, so nothing is synthesized twice.
	 */
	push(text: string): void {
		if (!this.utteranceId || this.closed || this.ended) return;
		this.partial += this.partial ? ` ${text}` : text;
		const { sentences, rest } = splitCompleteSentences(this.partial);
		this.partial = rest;
		this.enqueue(sentences);
		this.pump();
	}

	/**
	 * One whole sentence, already segmented by the translator. Bypasses the
	 * partial buffer: the translator yields sentences, not deltas.
	 */
	pushSentence(sentence: string): void {
		if (!this.utteranceId || this.closed || this.ended) return;
		this.enqueue([sentence]);
		this.pump();
	}

	/** No more text is coming. The run ends once the queue drains. */
	close(): void {
		if (!this.utteranceId || this.ended) return;
		this.closed = true;
		if (this.partial.trim()) {
			this.enqueue(splitIntoSpokenSentences(this.partial));
			this.partial = '';
		}
		this.wake?.();
		this.pump();
	}

	/**
	 * The user took the floor. Cuts the provider off mid-sentence and reports what
	 * was heard against what was not.
	 *
	 * Idempotent, because a barge-in and a speech run finishing on its own can race
	 * and the loser must not emit a second `speak-end`.
	 */
	cancel(reason: SpeechRunEndReason = 'interrupted'): SpeechRunResult | null {
		if (!this.utteranceId || this.ended) return null;
		this.endReason = reason;
		this.options.tts.cancel();
		this.wake?.();
		return this.finish(reason);
	}

	/** Resolves when the run has ended, however it ended. */
	async drained(): Promise<SpeechRunResult | null> {
		if (this.ended || !this.utteranceId) return null;
		await new Promise<void>((resolve) => {
			this.settle = resolve;
		});
		return this.lastResult;
	}

	// -- Internals -----------------------------------------------------------

	private enqueue(sentences: readonly string[]): void {
		for (const raw of sentences) {
			const sentence = raw.trim();
			if (!sentence) continue;
			if (this.queue.length >= this.queueLimit) {
				// The queue is already longer than anyone will listen to. Dropping the
				// newest is right: the oldest is the headline, and the cap below will
				// wrap the turn up long before this matters.
				return;
			}
			this.queue.push(sentence);
		}
	}

	/** Start the worker, or wake the one already parked waiting for text. */
	private pump(): void {
		// Before the `running` check, not after: a worker asleep on an empty queue IS
		// running, and returning early here is how a pushed sentence was never spoken.
		this.wake?.();
		if (this.running || this.ended || !this.utteranceId) return;
		this.running = true;
		void this.run().finally(() => {
			this.running = false;
		});
	}

	/**
	 * Fill the synthesis pipeline, then deliver its head in order.
	 *
	 * Two halves on purpose. Filling runs ahead so audio for the next sentence
	 * exists before the current one finishes; delivering is strictly in order so
	 * the user hears the reply in the order it was written. Merging them - the
	 * obvious `await speak(sentence)` loop - reintroduces a provider round trip of
	 * silence between every pair of sentences, which is precisely what this module
	 * exists to remove.
	 */
	private async run(): Promise<void> {
		const utteranceId = this.utteranceId;
		if (!utteranceId) return;

		while (!this.ended) {
			this.fill(utteranceId);

			const head = this.pipeline[0];
			if (!head) {
				if (this.started >= this.maxSentencesPerTurn) {
					await this.speakWrapUp(utteranceId);
					this.finish('completed');
					return;
				}
				if (this.closed && this.queue.length === 0 && !this.partial.trim()) {
					this.finish(this.endReason);
					return;
				}
				// Nothing to synthesize and more text is coming: wait to be woken rather
				// than spinning, and never end a run on a gap in the translation.
				await this.sleep();
				continue;
			}

			let chunks: TtsChunk[];
			try {
				chunks = await head.chunks;
			} catch (error) {
				this.options.onError?.(error as Error);
				this.finish('error');
				return;
			}

			// A cancelled run's stragglers belong to a floor the user already took
			// back; `cancel()` has emitted `speak-end` and moved on.
			if (this.ended || this.utteranceId !== utteranceId) return;

			// The event fires before the audio reaches the sink, so the sentence is on
			// screen by the time it is audible rather than after it.
			this.options.onSentence({ utteranceId, index: this.delivered, text: head.sentence });

			// A barge-in can arrive from INSIDE that event: the transcript rendering a
			// sentence is exactly what a user talks over. Checked before the shift, so
			// a sentence that was announced but never audible is reported as unspoken
			// rather than vanishing from both lists.
			if (this.ended || this.utteranceId !== utteranceId) return;

			this.pipeline.shift();
			this.spoken.push(head.sentence);
			this.delivered += 1;
			for (const chunk of chunks) this.options.onChunk?.(chunk);
		}
	}

	/**
	 * Start synthesis for as many sentences as the lookahead allows.
	 *
	 * `lookahead + 1` in flight: one being delivered and `lookahead` being made
	 * ahead of it. Higher would buy nothing (the user cannot get further ahead
	 * than one sentence of listening) and would throw away more paid-for audio on
	 * every barge-in.
	 */
	private fill(utteranceId: string): void {
		while (
			this.pipeline.length <= this.lookahead &&
			this.started < this.maxSentencesPerTurn &&
			this.queue.length > 0
		) {
			const sentence = this.queue.shift() as string;
			this.started += 1;
			const chunks = this.synthesize(utteranceId, sentence);
			// A prefetched sentence can reject long before the delivery loop reaches
			// it - a provider that failed for the whole run fails every sentence in
			// flight. Attaching a handler here is what keeps that from surfacing as an
			// unhandled rejection; the delivery loop still sees the rejection when it
			// awaits the same promise, and still ends the run with `error`.
			void chunks.catch(() => {});
			this.pipeline.push({ sentence, chunks });
		}
	}

	/** The voice and rate for the sentence about to be synthesized. Read live. */
	private speakOptions(utteranceId: string): {
		utteranceId: string;
		voiceId?: string;
		rate?: number;
	} {
		return { utteranceId, ...(this.options.speechOptions?.() ?? {}) };
	}

	/** Collect one sentence's audio. Rejections are handled by the delivery loop. */
	private async synthesize(utteranceId: string, sentence: string): Promise<TtsChunk[]> {
		const chunks: TtsChunk[] = [];
		for await (const chunk of this.options.tts.speak(sentence, this.speakOptions(utteranceId))) {
			chunks.push(chunk);
		}
		return chunks;
	}

	/**
	 * The cap, said out loud rather than performed silently.
	 *
	 * Stopping mid-answer with no explanation reads as a crash to someone who
	 * cannot see the screen, so the turn ends on an offer instead.
	 */
	private async speakWrapUp(utteranceId: string): Promise<void> {
		if (this.capped) return;
		// Nothing left to offer: the run happened to end exactly on the cap, and
		// promising details that do not exist is worse than stopping.
		if (this.queue.length === 0 && !this.partial.trim() && this.closed) return;

		this.capped = true;
		this.options.onSentence({ utteranceId, index: this.delivered, text: this.wrapUpText });
		try {
			for await (const chunk of this.options.tts.speak(
				this.wrapUpText,
				this.speakOptions(utteranceId)
			)) {
				if (this.ended) return;
				this.options.onChunk?.(chunk);
			}
		} catch (error) {
			this.options.onError?.(error as Error);
			return;
		}
		this.spoken.push(this.wrapUpText);
		this.delivered += 1;
	}

	private finish(reason: SpeechRunEndReason): SpeechRunResult | null {
		if (this.ended || !this.utteranceId) return this.lastResult;
		this.ended = true;

		const result: SpeechRunResult = {
			utteranceId: this.utteranceId,
			reason,
			spoken: [...this.spoken],
			// Everything still being synthesized plus everything still queued: the user
			// heard none of it, so the conversation memory must not claim they did.
			unspoken: [
				...this.pipeline.map((entry) => entry.sentence),
				...this.queue,
				...splitIntoSpokenSentences(this.partial),
			],
			capped: this.capped,
		};

		this.lastResult = result;
		this.queue = [];
		this.partial = '';
		this.pipeline = [];
		this.options.onEnd(result);

		const settle = this.settle;
		this.settle = null;
		settle?.();
		return result;
	}

	/** Park until something happens: a push, a close, a cancel, or a played sentence. */
	private sleep(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.wake = () => {
				this.wake = null;
				resolve();
			};
		});
	}
}

export function createSpeechScheduler(options: SpeechSchedulerOptions): SpeechScheduler {
	return new SpeechScheduler(options);
}
