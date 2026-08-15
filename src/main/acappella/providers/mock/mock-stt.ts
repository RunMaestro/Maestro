/**
 * Mock speech-to-text: text in, partials and a final out.
 *
 * There is no audio path here on purpose. The mock tier exists so the whole
 * voice pipeline runs with no model download, no device, and no network, which
 * makes it the tier every test and the dev harness drive. Because it lands on
 * the same `SttCallbacks` a real recognizer does, nothing downstream can tell a
 * typed utterance from a spoken one.
 */

import type { SttCallbacks, SttProvider } from '../../../../shared/acappella/providers';

/** Gap between the two synthetic partials and the final. 0 emits synchronously. */
const DEFAULT_PARTIAL_DELAY_MS = 90;

/** Rising stability across the two partials, matching what a real recognizer reports. */
const FIRST_PARTIAL_STABILITY = 0.35;
const SECOND_PARTIAL_STABILITY = 0.7;

/** Typed text is not a guess, so the mock reports no transcription doubt. */
const MOCK_FINAL_CONFIDENCE = 1;

/** Speaking pace used to estimate `durationMs` for an utterance nobody spoke. */
const WORDS_PER_MINUTE = 150;

export interface MockSttOptions {
	/**
	 * Delay between the injected partials and the final. The default makes the
	 * live-transcript UI visibly stream; tests pass 0 to stay synchronous.
	 */
	partialDelayMs?: number;
}

export class MockSttProvider implements SttProvider {
	readonly id = 'mock-stt';
	readonly label = 'Mock (typed input)';
	readonly tier = 'mock' as const;
	/** What a real recognizer would want. Nothing here consumes audio. */
	readonly sampleRate = 16_000;

	private callbacks: SttCallbacks | null = null;
	private readonly partialDelayMs: number;
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();

	constructor(options: MockSttOptions = {}) {
		this.partialDelayMs = options.partialDelayMs ?? DEFAULT_PARTIAL_DELAY_MS;
	}

	async start(callbacks: SttCallbacks): Promise<void> {
		this.callbacks = callbacks;
	}

	feed(_pcm: Int16Array): void {
		// Dropped deliberately. Inventing a transcript from audio this provider
		// cannot hear would emit words nobody said.
	}

	async flush(): Promise<void> {
		// Endpointing is meaningless without an audio stream: `injectUtterance()`
		// already delivers a complete utterance.
	}

	async stop(): Promise<void> {
		this.clearTimers();
		this.callbacks = null;
	}

	/**
	 * Treat `text` as an already-final transcript, preceded by two synthetic
	 * partials so the live-transcript UI has something to render.
	 *
	 * A second call supersedes the first: pending emissions from the previous
	 * utterance are dropped rather than interleaved with the new one.
	 */
	injectUtterance(text: string): void {
		this.clearTimers();
		if (!this.callbacks) return;

		const utterance = text.trim();
		if (!utterance) {
			// The session service has its own empty-utterance path (it hands the
			// floor straight back); partials for nothing would be noise.
			this.emit((callbacks) => callbacks.onFinal('', MOCK_FINAL_CONFIDENCE, 0));
			return;
		}

		const [first, second] = partialPrefixes(utterance);
		this.schedule(1, (callbacks) => callbacks.onPartial(first, FIRST_PARTIAL_STABILITY));
		this.schedule(2, (callbacks) => callbacks.onPartial(second, SECOND_PARTIAL_STABILITY));
		this.schedule(3, (callbacks) =>
			callbacks.onFinal(utterance, MOCK_FINAL_CONFIDENCE, estimateSpokenDurationMs(utterance))
		);
	}

	// -- Internals -----------------------------------------------------------

	/** Run `emit` after `step` delay slots, or immediately when there is no delay. */
	private schedule(step: number, emit: (callbacks: SttCallbacks) => void): void {
		if (this.partialDelayMs <= 0) {
			this.emit(emit);
			return;
		}

		const timer = setTimeout(() => {
			this.timers.delete(timer);
			this.emit(emit);
		}, this.partialDelayMs * step);
		this.timers.add(timer);
	}

	/** Callbacks can outlive `stop()`, so every emission re-checks the session. */
	private emit(emit: (callbacks: SttCallbacks) => void): void {
		if (!this.callbacks) return;
		emit(this.callbacks);
	}

	private clearTimers(): void {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
	}
}

/**
 * Growing prefixes at word boundaries, roughly a third and two thirds in. Short
 * utterances still get two partials: a client counting them must not have to
 * special-case a one-word sentence.
 */
function partialPrefixes(utterance: string): [string, string] {
	const words = utterance.split(/\s+/);
	const firstCount = Math.max(1, Math.ceil(words.length / 3));
	const secondCount = Math.max(firstCount, Math.ceil((words.length * 2) / 3));
	return [words.slice(0, firstCount).join(' '), words.slice(0, secondCount).join(' ')];
}

/** How long the utterance would have taken to say, for the transcript timeline. */
function estimateSpokenDurationMs(utterance: string): number {
	const words = utterance.split(/\s+/).length;
	return Math.round((words / WORDS_PER_MINUTE) * 60_000);
}
