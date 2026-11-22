/**
 * Notice speech - the audio host's speakers, with no voice session behind them.
 *
 * Spoken notices need one thing from A Cappella: a way to make sound. The
 * hidden audio host already plays synthesised speech, and the local voice
 * providers already make it. This module is the mode of that path that speaks
 * one line and does nothing else:
 *
 *   - **No session.** Nothing here touches `VoiceSessionService`. No floor is
 *     opened, no microphone is asked for, and no protocol event is published.
 *   - **Refused while a session is live.** The session speaks for itself; a
 *     notice over it would be two voices on one output.
 *   - **A local voice, always.** A notice fires with nobody asking for it, so it
 *     never sends its text to a hosted voice: see `resolveNoticeTtsProvider`.
 *   - **Cut off, not faded.** Aborting stops the synthesiser and flushes what
 *     the host has queued, so a voice session that starts under a notice does
 *     not hear the rest of it.
 *
 * It implements the core's `NoticeSpeaker` seam and is registered at startup,
 * so notices work whether or not the A Cappella Encore Feature is on. Free of
 * Electron: the host commands, the voice, and the status feed are injected
 * (see `src/main/ipc/handlers/acappella.ts`).
 */

import type { AudioHostCommand, AudioHostStatus } from '../../../shared/acappella/audio-host';
import type { TtsProvider } from '../../../shared/acappella/providers';
import { prepareSpeechText } from '../../../shared/acappella/speech-text';
import type { SpokenNoticeSkipCode } from '../../../shared/spokenNotices';
import type { NoticeSpeaker } from '../../local-models/spoken-notices';
import { speechChunkToPlayCommand } from './audio-bridge';

/**
 * How long the audio host may take to announce itself. The first notice after
 * launch pays for the host window loading its bundle.
 */
export const NOTICE_HOST_READY_TIMEOUT_MS = 10_000;

/**
 * How long past the audio's own length the host may take to report it drained.
 * A lost status must not hold the notice queue forever.
 */
export const NOTICE_DRAIN_MARGIN_MS = 3_000;

/** The drain budget for audio whose length is not known (an encoded container). */
const UNKNOWN_LENGTH_DRAIN_MS = 30_000;

/** The voice a notice is spoken with, read at each notice. */
export interface NoticeVoice {
	tts: TtsProvider;
	voiceId?: string;
	/** 1 is the provider's natural pace. */
	rate?: number;
	/** Output volume, 0 to 1. */
	volume: number;
}

export interface NoticeSpeechDeps {
	/** Why nothing may be spoken right now (a live voice session), or null. */
	refusal(): { code: SpokenNoticeSkipCode; message: string } | null;
	/** The voice to speak with. Read per notice, so a settings change lands on the next one. */
	readVoice(): NoticeVoice;
	/** Make sure the audio host window exists. False when there is none to open. */
	ensureAudioHost(): boolean;
	/** Whether the host already announced `ready` since it last loaded. */
	isAudioHostReady(): boolean;
	/** Send one command to the audio host. */
	sendCommand(command: AudioHostCommand): void;
	/** Defaults to {@link NOTICE_HOST_READY_TIMEOUT_MS}. */
	hostReadyTimeoutMs?: number;
	/** Defaults to {@link NOTICE_DRAIN_MARGIN_MS}. */
	drainMarginMs?: number;
}

/** Thrown inside `speak` when its signal aborted. The core reports the reason. */
function aborted(): Error {
	return new Error('The notice was cancelled.');
}

export class NoticeSpeech implements NoticeSpeaker {
	private sequence = 0;
	/** Resolved by the host's next `ready` announcement. */
	private readyWaiters: Array<() => void> = [];
	/** The utterance whose drain is awaited, and what settles it. */
	private draining: { utteranceId: string; done: () => void } | null = null;

	constructor(private readonly deps: NoticeSpeechDeps) {}

	refusal(): { code: SpokenNoticeSkipCode; message: string } | null {
		return this.deps.refusal();
	}

	/** One control-plane message from the audio host. */
	handleStatus(status: AudioHostStatus): void {
		if (status.kind === 'ready') {
			const waiters = this.readyWaiters;
			this.readyWaiters = [];
			for (const resolve of waiters) resolve();
			return;
		}
		// The host forgets the utterance only once it has drained AND been told no
		// more chunks are coming, so an idle report naming no utterance is the end
		// of this one. A gap between two sentences still names it.
		if (
			status.kind === 'playback-state' &&
			!status.playing &&
			status.utteranceId === null &&
			this.draining
		) {
			this.draining.done();
		}
	}

	async speak(text: string, signal: AbortSignal): Promise<void> {
		if (signal.aborted) throw aborted();
		text = prepareSpeechText(text);
		if (!text) return;
		if (!this.deps.ensureAudioHost()) {
			throw new Error('There is no audio host to play the notice through.');
		}
		await this.whenHostReady(signal);

		const voice = this.deps.readVoice();
		const utteranceId = `notice-${++this.sequence}`;
		// Set per notice: the level is the user's voice volume, and the host keeps
		// whatever it was last told.
		this.deps.sendCommand({ kind: 'set-volume', volume: voice.volume });

		const cut = () => {
			voice.tts.cancel();
			this.deps.sendCommand({ kind: 'flush' });
		};
		signal.addEventListener('abort', cut, { once: true });
		try {
			let audioMs = 0;
			let lengthKnown = true;
			let played = 0;
			for await (const chunk of voice.tts.speak(text, {
				utteranceId,
				voiceId: voice.voiceId,
				rate: voice.rate,
			})) {
				if (signal.aborted) break;
				const command = speechChunkToPlayCommand(chunk);
				if (!command) continue;
				this.deps.sendCommand(command);
				played += 1;
				if (command.format === 'pcm16' && command.sampleRate) {
					audioMs += (command.data.byteLength / 2 / command.sampleRate) * 1000;
				} else {
					lengthKnown = false;
				}
			}
			if (signal.aborted) throw aborted();
			if (played === 0) throw new Error('The voice produced no audio for the notice.');

			await this.whenDrained(
				utteranceId,
				lengthKnown
					? audioMs + (this.deps.drainMarginMs ?? NOTICE_DRAIN_MARGIN_MS)
					: UNKNOWN_LENGTH_DRAIN_MS,
				signal
			);
			if (signal.aborted) throw aborted();
		} finally {
			signal.removeEventListener('abort', cut);
		}
	}

	// -- Internals -----------------------------------------------------------

	/**
	 * Wait for the host window to finish loading. A command sent before that has
	 * no listener and vanishes, which would be a notice that plays into nothing.
	 */
	private whenHostReady(signal: AbortSignal): Promise<void> {
		if (this.deps.isAudioHostReady()) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const finish = (error?: Error) => {
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				this.readyWaiters = this.readyWaiters.filter((waiter) => waiter !== onReady);
				if (error) reject(error);
				else resolve();
			};
			const onReady = () => finish();
			const onAbort = () => finish(aborted());
			const timer = setTimeout(
				() => finish(new Error('The audio host did not start, so the notice was not spoken.')),
				this.deps.hostReadyTimeoutMs ?? NOTICE_HOST_READY_TIMEOUT_MS
			);
			signal.addEventListener('abort', onAbort, { once: true });
			this.readyWaiters.push(onReady);
		});
	}

	/**
	 * Tell the host no more audio is coming and wait until what it has was
	 * heard. Resolves on the host's idle report, on the budget running out (a
	 * lost report must not hold the queue), or on an abort.
	 */
	private whenDrained(utteranceId: string, budgetMs: number, signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				signal.removeEventListener('abort', done);
				if (this.draining?.utteranceId === utteranceId) this.draining = null;
				resolve();
			};
			const timer = setTimeout(done, budgetMs);
			signal.addEventListener('abort', done, { once: true });
			// Registered BEFORE the end marker is sent: a short line can already have
			// drained, and the host answers the marker with the idle report at once.
			this.draining = { utteranceId, done };
			this.deps.sendCommand({ kind: 'end-utterance', utteranceId });
		});
	}
}
