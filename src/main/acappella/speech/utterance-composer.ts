/**
 * Utterance composer - assembles the fragments of one thought into one request.
 *
 * A recogniser endpoints on silence (700 ms, see `audio/vad.ts`), but people do
 * not. "Look at the auth module..." *thinks* "...and tell me why the refresh is
 * failing" endpoints twice, and without this the session routed and dispatched
 * BOTH halves: the agent got a fragment, started answering it, and then received
 * a second request that only made sense joined to the first.
 *
 * So a settled fragment is held rather than dispatched. Another fragment inside
 * the settle window joins it and restarts the clock; silence past the window
 * means the thought is finished and the whole thing goes as one request.
 *
 * **The cost is honest and deliberate.** A request that really was complete now
 * waits `settleMs` before anything happens. That is the trade this component
 * exists to make: dead air before a correct dispatch beats an agent working on
 * half a sentence. It is tunable for exactly that reason, and a settle of 0
 * restores the old behaviour for anyone who wants it.
 *
 * Pure and timer-driven, with no session, provider, or transport knowledge, so
 * it can be tested against fake timers rather than against a microphone.
 */

import { DEFAULT_SEND_PHRASES, matchSendPhrase } from './send-phrase';

/** How long to wait, and the backstop that stops it waiting forever. */
export interface UtteranceComposerConfig {
	/**
	 * Silence after a fragment before the thought counts as finished.
	 *
	 * On top of the recogniser's own endpoint silence, not instead of it: at the
	 * defaults a dispatch happens ~1.6 s after you stop making noise. Zero
	 * disables composition entirely and dispatches every fragment on arrival.
	 */
	settleMs: number;
	/**
	 * Hard cap on how long one thought may be assembled for.
	 *
	 * A backstop against a room noisy enough to keep producing fragments, never a
	 * normal path - firing it mid-sentence splits the thought, which is the very
	 * thing this module exists to prevent, so it is set far beyond any real
	 * sentence rather than close to one.
	 */
	maxHoldMs: number;
	/**
	 * Phrases that end dictation immediately, said at the END of a turn.
	 *
	 * A voice request has no Enter key, and {@link settleMs} is a guess at when
	 * someone stopped talking. A phrase removes the guess: the pause becomes a
	 * backstop for the times you forget to say it, rather than the mechanism.
	 * Empty disables them. See `speech/send-phrase.ts`.
	 */
	sendPhrases: readonly string[];
}

export const DEFAULT_UTTERANCE_COMPOSER_CONFIG: UtteranceComposerConfig = {
	settleMs: 900,
	maxHoldMs: 30_000,
	sendPhrases: DEFAULT_SEND_PHRASES,
};

/** One assembled thought, with the parts it was built from. */
export interface ComposedUtterance {
	text: string;
	/**
	 * The LOWEST confidence of any fragment.
	 *
	 * The assembled utterance is only as trustworthy as its worst part: averaging
	 * would let one clear fragment vouch for a mumbled one, and the whole thing is
	 * dispatched as a single request.
	 */
	confidence: number;
	/** Summed speech duration of the fragments, when they reported one. */
	durationMs?: number;
	/** How many recogniser finals were joined. 1 means nothing was coalesced. */
	fragments: number;
	/**
	 * The send phrase that ended this thought, when one did.
	 *
	 * Absent means the settle timer fired instead. Worth distinguishing: a client
	 * can say "sending" the instant you ask for it, rather than after a pause that
	 * looks like nothing happening.
	 */
	sentBy?: string;
}

export interface UtteranceComposerOptions extends Partial<UtteranceComposerConfig> {
	/** The assembled thought, once the user has stopped adding to it. */
	onSettled: (utterance: ComposedUtterance) => void;
	/**
	 * A fragment joined the buffer and the clock restarted.
	 *
	 * The HUD renders this as a growing partial: without it the transcript blanks
	 * between fragments and a composing session looks like one that stopped
	 * listening.
	 */
	onComposing?: (text: string) => void;
}

interface Buffered {
	parts: string[];
	confidence: number;
	durationMs: number;
	sawDuration: boolean;
}

export class UtteranceComposer {
	private readonly config: UtteranceComposerConfig;
	private readonly onSettled: (utterance: ComposedUtterance) => void;
	private readonly onComposing?: (text: string) => void;

	private buffer: Buffered | null = null;
	private settleTimer: ReturnType<typeof setTimeout> | null = null;
	private holdTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	constructor(options: UtteranceComposerOptions) {
		const settleMs = Math.max(0, options.settleMs ?? DEFAULT_UTTERANCE_COMPOSER_CONFIG.settleMs);
		const maxHoldMs = Math.max(0, options.maxHoldMs ?? DEFAULT_UTTERANCE_COMPOSER_CONFIG.maxHoldMs);
		this.config = {
			settleMs,
			// The cap can never be tighter than the wait it is backstopping. A 30 s
			// hold under a 30 s cap fires the cap first and splits the thought - the
			// exact failure the hold exists to prevent - because the cap starts on the
			// first fragment while the settle restarts on every one. The multiple is
			// slack for the fragments themselves, not a tuned number.
			maxHoldMs: maxHoldMs === 0 ? 0 : Math.max(maxHoldMs, settleMs * 4),
			sendPhrases: options.sendPhrases ?? DEFAULT_UTTERANCE_COMPOSER_CONFIG.sendPhrases,
		};
		this.onSettled = options.onSettled;
		this.onComposing = options.onComposing;
	}

	/** True while a thought is being assembled. */
	get composing(): boolean {
		return this.buffer !== null;
	}

	/** What has been collected so far. Empty when nothing is buffered. */
	get pending(): string {
		return this.buffer ? this.buffer.parts.join(' ') : '';
	}

	/** Take one recogniser final. It may or may not be the whole thought. */
	add(text: string, confidence: number, durationMs?: number): void {
		if (this.disposed) return;
		let fragment = text.trim();
		// An empty final is the recogniser reporting silence. Joining it would put a
		// stray space in the prompt and restart the clock for nothing.
		if (!fragment) return;

		// "fix the auth bug, good to go" is a request and a send signal in one
		// breath. The signal is removed before the rest is buffered, because what
		// survives here becomes the prompt an agent receives.
		const send = matchSendPhrase(fragment, this.config.sendPhrases);
		if (send) {
			fragment = send.text.trim();
			if (fragment) this.append(fragment, confidence, durationMs);
			// Said with nothing buffered and nothing else in the sentence, this is a
			// send signal for a request that does not exist. Dispatching an empty
			// prompt would be worse than ignoring it.
			if (!this.buffer) return;
			this.settle(send.phrase);
			return;
		}

		this.append(fragment, confidence, durationMs);

		// Zero settle is "compose nothing": dispatch on arrival, which is what the
		// session did before this module existed.
		if (this.config.settleMs === 0) {
			this.settle();
			return;
		}

		this.onComposing?.(this.pending);
		this.restartSettleTimer();
		this.startHoldTimer();
	}

	/**
	 * Settle now, whatever the clock says.
	 *
	 * For the moments that end a thought by decree rather than by silence: a stop
	 * word, a hotkey release, the floor closing under it.
	 */
	flush(): void {
		if (this.disposed || !this.buffer) return;
		this.settle();
	}

	/** Drop everything buffered. A barge-in or a new session, not an endpoint. */
	cancel(): void {
		this.clearTimers();
		this.buffer = null;
	}

	dispose(): void {
		this.disposed = true;
		this.cancel();
	}

	/** Add one fragment to the buffer, creating it when this is the first. */
	private append(fragment: string, confidence: number, durationMs?: number): void {
		if (!this.buffer) {
			this.buffer = { parts: [], confidence, durationMs: 0, sawDuration: false };
		}
		this.buffer.parts.push(fragment);
		this.buffer.confidence = Math.min(this.buffer.confidence, confidence);
		if (typeof durationMs === 'number') {
			this.buffer.durationMs += durationMs;
			this.buffer.sawDuration = true;
		}
	}

	private settle(sentBy?: string): void {
		const buffer = this.buffer;
		this.clearTimers();
		this.buffer = null;
		if (!buffer) return;

		this.onSettled({
			text: buffer.parts.join(' '),
			confidence: buffer.confidence,
			durationMs: buffer.sawDuration ? buffer.durationMs : undefined,
			fragments: buffer.parts.length,
			sentBy,
		});
	}

	private restartSettleTimer(): void {
		if (this.settleTimer !== null) clearTimeout(this.settleTimer);
		this.settleTimer = setTimeout(() => {
			this.settleTimer = null;
			this.settle();
		}, this.config.settleMs);
	}

	/** Started once per thought, and deliberately NOT restarted by a fragment. */
	private startHoldTimer(): void {
		if (this.holdTimer !== null || this.config.maxHoldMs === 0) return;
		this.holdTimer = setTimeout(() => {
			this.holdTimer = null;
			this.settle();
		}, this.config.maxHoldMs);
	}

	private clearTimers(): void {
		if (this.settleTimer !== null) clearTimeout(this.settleTimer);
		if (this.holdTimer !== null) clearTimeout(this.holdTimer);
		this.settleTimer = null;
		this.holdTimer = null;
	}
}
