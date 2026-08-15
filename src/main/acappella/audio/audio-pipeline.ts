/**
 * A Cappella duplex audio pipeline.
 *
 * The join between the hidden audio host (microphone in, TTS out) and the voice
 * session (STT in, speech runs out). Frames arrive here at 50/s and this module
 * decides, per frame, one of three things: feed it to the speech recogniser, hold
 * it in the pre-roll, or drop it and say so.
 *
 * **Full duplex, not half.** The microphone stays open while the assistant
 * speaks. That is only safe because capture and playback share one `AudioContext`
 * in the audio host, so Chromium's echo canceller has our own output as a
 * reference and subtracts it: what reaches the VAD during playback is the user,
 * not the assistant. Barge-in is therefore just the VAD firing `speech-start`
 * while the session is in `speaking`, and the response is immediate - flush the
 * queued audio in the host, cancel the TTS run, take the floor back - rather than
 * waiting for a sentence boundary.
 *
 * **Nothing here is buffered without a bound.** The only queue is the pre-roll
 * ring, whose capacity is fixed in frames at construction. Audio that arrives
 * with nowhere to go is counted and periodically logged, never accumulated: a
 * pipeline that quietly grows a queue while the session is busy trades a moment
 * of silence for an unbounded memory leak and a transcript minutes out of date.
 *
 * **The pre-roll is what makes a wake word usable.** Capture runs before the
 * floor opens, so the ~500 ms preceding a wake word or a hotkey is already in
 * hand and is fed to STT ahead of the live frames. Without it "Maestro, what's
 * the status" reaches the recogniser as "...what's the status". The same buffer
 * covers barge-in: the syllables spoken over the assistant are in the ring before
 * the interrupt lands, so they survive the transition into `listening`.
 *
 * Deliberately free of Electron and of the concrete session service: frames,
 * commands, and the session come in as injected seams. That keeps the whole thing
 * unit-testable with generated PCM, and lets Phase 10's phone drive the identical
 * pipeline with frames that arrived over WebRTC instead of over IPC.
 */

import {
	ACAPPELLA_AUDIO_FRAME_MS,
	type AudioFrame,
	type AudioHostCommand,
	type AudioHostStatus,
} from '../../../shared/acappella/audio-host';
import type { InterruptSource } from '../../../shared/acappella/protocol';
import type { SttProvider } from '../../../shared/acappella/providers';
import type { VoiceSessionState } from '../../../shared/acappella/session-state';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { VoiceActivityDetector } from './vad';
import type { VadConfig, VadFrameResult } from './vad';

const LOG_CONTEXT = 'ACappella';

/**
 * How much audio preceding the floor opening is kept. 500 ms is about one spoken
 * word: enough to cover the gap between a wake word firing and the session
 * reaching `listening`, short enough that the ring is 25 frames of 320 samples.
 */
export const DEFAULT_PRE_ROLL_MS = 500;

/**
 * Hard ceiling on the pre-roll, and with it on every byte this module holds. A
 * setting is a number a user can get wrong; the cap is what makes "bounded" a
 * property of the code rather than of the configuration.
 */
export const MAX_PRE_ROLL_MS = 5000;

/** Output gain while a possible barge-in is being confirmed. Audible, but the user wins. */
const DEFAULT_DUCK_GAIN = 0.2;

/** Ramp for the duck and for its restore. Fast enough to feel instant, slow enough not to click. */
const DEFAULT_DUCK_RAMP_MS = 60;

/** Dropped frames between warnings: 500 frames is 10 s of audio going nowhere. */
const DROP_LOG_INTERVAL = 500;

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The slice of `VoiceSessionService` the pipeline needs. Narrow on purpose: the
 * pipeline reads the state machine and performs exactly one action on it, and
 * anything wider would invite it to start driving turns.
 */
export interface AudioPipelineSession {
	getState(): VoiceSessionState;
	/** Barge-in: cancels the speech run and keeps the floor. False when nothing was speaking. */
	interrupt(source?: InterruptSource): boolean;
}

export interface AudioPipelineOptions {
	session: AudioPipelineSession;
	/**
	 * The recogniser for the current session, or null when none is running. Read
	 * per frame rather than captured, so a provider swap between sessions cannot
	 * leave the pipeline feeding a stopped recogniser.
	 */
	getStt: () => SttProvider | null;
	/** Sends a command to the audio host window. */
	sendCommand: (command: AudioHostCommand) => void;
	vad?: Partial<VadConfig>;
	/** Audio retained ahead of the floor opening. Clamped to {@link MAX_PRE_ROLL_MS}. */
	preRollMs?: number;
	/** Gain TTS output is ducked to while a barge-in is being confirmed. */
	duckGain?: number;
	/** Ramp length for ducking and restoring. */
	duckRampMs?: number;
	/** Per frame, after the frame has been classified and routed. The level-meter seam. */
	onFrame?: (info: AudioPipelineFrameInfo) => void;
	/** A barge-in was performed: TTS was flushed and cancelled, the floor is back. */
	onBargeIn?: () => void;
}

export interface AudioPipelineFrameInfo {
	frame: AudioFrame;
	result: VadFrameResult;
	/** Whether this frame reached the recogniser. False means it went to the pre-roll. */
	delivered: boolean;
}

/**
 * Counters, all monotonic within a capture run.
 *
 * These exist because every interesting audio failure is silent: a recogniser
 * that never hears anything, an IPC channel shedding frames under load, and a
 * healthy pipeline all look identical from the outside.
 */
export interface AudioPipelineStats {
	framesReceived: number;
	/** Frames handed to `SttProvider.feed()`, including replayed pre-roll. */
	framesDelivered: number;
	/** Frames that arrived with no recogniser to take them. The pre-roll holds the last few. */
	framesDropped: number;
	/** Frames replayed out of the pre-roll when the floor opened. */
	preRollFramesDelivered: number;
	/** Frames missing between two `seq` values: the IPC channel shed them, not us. */
	sequenceGaps: number;
	bargeIns: number;
	/** Throws out of `feed()`. Counted rather than propagated: see {@link AudioPipeline.handleFrame}. */
	feedErrors: number;
}

// ---------------------------------------------------------------------------
// Pre-roll ring
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity ring of PCM frames, oldest evicted first.
 *
 * Eviction is the normal case, not an error: this is a sliding window over the
 * last N frames, so a frame ageing out has done its job. That is why it keeps no
 * drop counter - the pipeline's `framesDropped` counts audio that had nowhere to
 * go, which is a different and much more interesting fact.
 */
export class AudioFrameRing {
	private readonly frames: Int16Array[] = [];

	constructor(readonly capacity: number) {}

	get size(): number {
		return this.frames.length;
	}

	push(samples: Int16Array): void {
		if (this.capacity <= 0) return;
		if (this.frames.length >= this.capacity) this.frames.shift();
		this.frames.push(samples);
	}

	/** Take everything, oldest first, and empty the ring. */
	drain(): Int16Array[] {
		return this.frames.splice(0, this.frames.length);
	}

	clear(): void {
		this.frames.length = 0;
	}
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class AudioPipeline {
	private readonly options: AudioPipelineOptions;
	private readonly vad: VoiceActivityDetector;
	private readonly preRoll: AudioFrameRing;
	private readonly frameMs: number;
	private readonly duckGain: number;
	private readonly duckRampMs: number;

	private running = false;
	/** Whether the previous frame was delivered, so the pre-roll drains on the edge. */
	private feeding = false;
	private ducked = false;
	private lastState: VoiceSessionState = 'idle';
	private lastSeq = 0;
	private dropsSinceLog = 0;
	/** One Sentry report per run: a broken `feed()` breaks on every one of 50 frames a second. */
	private reportedFeedError = false;
	private stats = emptyStats();

	constructor(options: AudioPipelineOptions) {
		this.options = options;
		this.vad = new VoiceActivityDetector(options.vad);
		this.frameMs = this.vad.config.frameMs || ACAPPELLA_AUDIO_FRAME_MS;
		this.preRoll = new AudioFrameRing(
			Math.max(0, Math.round(resolvePreRollMs(options.preRollMs) / this.frameMs))
		);
		this.duckGain = clamp01(options.duckGain ?? DEFAULT_DUCK_GAIN);
		this.duckRampMs = Math.max(0, options.duckRampMs ?? DEFAULT_DUCK_RAMP_MS);
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** Frames of audio the pre-roll can hold. Zero disables it. */
	get preRollCapacity(): number {
		return this.preRoll.capacity;
	}

	getStats(): AudioPipelineStats {
		return { ...this.stats };
	}

	/** Open the microphone. Idempotent: a second start is not a second device. */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.resetRun();
		this.options.sendCommand({ kind: 'start-capture' });
	}

	/**
	 * Close the microphone and stop any speech.
	 *
	 * Both halves, because a session that ends mid-sentence must not keep talking
	 * into a room whose microphone it just released.
	 */
	stop(): void {
		if (!this.running) return;
		this.running = false;
		this.options.sendCommand({ kind: 'stop-capture' });
		this.options.sendCommand({ kind: 'flush' });
		this.ducked = false;
		this.logDropSummary();
		this.resetRun();
	}

	/**
	 * Classify one captured frame and route it.
	 *
	 * The order matters: the session state is read first so a detector reset lands
	 * before the frame is classified rather than after it, the VAD then sees every
	 * frame regardless of state (it is how barge-in is detected in the one state
	 * where audio is not being fed anywhere), barge-in is handled before delivery
	 * so the frame the user interrupted with is itself delivered, and only then is
	 * the frame either fed or shelved.
	 */
	handleFrame(frame: AudioFrame): void {
		if (!this.running) return;

		this.stats.framesReceived += 1;
		this.trackSequence(frame.seq);

		this.syncSessionState();
		const samples = new Int16Array(frame.pcm);
		const result = this.vad.process(samples);

		this.handleDuplex(result);

		const delivered = this.deliver(samples, result);
		this.options.onFrame?.({ frame, result, delivered });
	}

	/**
	 * React to the audio host's control plane.
	 *
	 * Only the events that invalidate what the pipeline is holding: a capture that
	 * started or stopped resets the detector (carrying an open speech state across
	 * a device restart would endpoint audio nobody spoke), and a microphone error
	 * makes the pre-roll a record of a device that is gone.
	 */
	handleStatus(status: AudioHostStatus): void {
		switch (status.kind) {
			case 'capture-start':
				this.resetRun();
				break;
			case 'capture-stop':
			case 'mic-error':
				this.logDropSummary();
				this.resetRun();
				break;
			default:
				break;
		}
	}

	/** Stop and drop everything held. Safe to call more than once. */
	dispose(): void {
		this.stop();
		this.preRoll.clear();
	}

	// -- Internals -----------------------------------------------------------

	/**
	 * A gap in `seq` means frames were shed between the worklet and here, which is
	 * the one drop this module cannot prevent and therefore must not hide.
	 */
	private trackSequence(seq: number): void {
		if (this.lastSeq > 0 && seq > this.lastSeq + 1) {
			this.stats.sequenceGaps += seq - this.lastSeq - 1;
		}
		this.lastSeq = seq;
	}

	/**
	 * Reset the detector when the session starts speaking.
	 *
	 * Barge-in needs a closed floor to fire `speech-start` from, and the VAD can
	 * still be open (hangover, or a recogniser that endpointed before the VAD did)
	 * when playback begins. Leaving it open would swallow the first interruption
	 * for as long as the hangover lasts. The reset also re-runs the noise-floor
	 * calibration against whatever the echo canceller leaves behind, which is the
	 * right floor to measure while our own voice is in the room.
	 */
	private syncSessionState(): void {
		const state = this.options.session.getState();
		if (state === this.lastState) return;
		if (state === 'speaking') this.vad.reset();
		this.lastState = state;
	}

	/**
	 * Duck on suspicion, interrupt on confirmation.
	 *
	 * The duck fires on the first candidate frame, which is up to `enterFrames`
	 * ahead of a confirmed `speech-start` - 80 ms of the user hearing themselves
	 * win the room rather than talking into a wall. If the candidate turns out to
	 * be a cough or a door, the gain goes straight back up and nothing was
	 * cancelled.
	 */
	private handleDuplex(result: VadFrameResult): void {
		if (this.lastState !== 'speaking') {
			// Playback ended on its own while a duck was in place. Nothing will
			// restore the gain if this does not: `flush()` only runs on barge-in.
			if (this.ducked) this.setDuck(false);
			return;
		}

		if (result.event?.type === 'speech-start') {
			this.bargeIn();
			return;
		}

		if (result.candidate !== this.ducked) this.setDuck(result.candidate);
	}

	/**
	 * Cut the assistant off.
	 *
	 * Flush first: it is the only step the user can hear, and it costs one IPC
	 * message. Cancelling the provider and moving the state machine is bookkeeping
	 * that can happen while the room is already quiet.
	 */
	private bargeIn(): void {
		this.options.sendCommand({ kind: 'flush' });
		// The host restores gain to 1 as part of a flush, so the local flag has to
		// follow or the next duck would be a no-op.
		this.ducked = false;

		const interrupted = this.options.session.interrupt('voice');
		if (!interrupted) {
			// The session moved on between the frame and here (the speech run ended by
			// itself). The flush was still correct, and there is nothing to report.
			return;
		}

		this.stats.bargeIns += 1;
		this.lastState = this.options.session.getState();
		this.options.onBargeIn?.();
	}

	private setDuck(ducked: boolean): void {
		this.ducked = ducked;
		this.options.sendCommand({
			kind: 'duck',
			gain: ducked ? this.duckGain : 1,
			ms: this.duckRampMs,
		});
	}

	/**
	 * Feed the frame, or shelve it in the pre-roll.
	 *
	 * The pre-roll is filled only while NOT feeding: once frames are reaching the
	 * recogniser there is nothing to pre-roll, and keeping a second copy would
	 * replay audio the recogniser already has the next time the floor closes and
	 * reopens.
	 */
	private deliver(samples: Int16Array, result: VadFrameResult): boolean {
		const stt = this.options.getStt();
		const canFeed = stt !== null && this.lastState === 'listening';

		if (!canFeed) {
			this.feeding = false;
			this.preRoll.push(samples);
			this.stats.framesDropped += 1;
			this.countDropForLogging();
			return false;
		}

		if (!this.feeding) {
			this.feeding = true;
			this.drainPreRoll(stt);
		}

		this.feed(stt, samples);

		// The recogniser decides what a final transcript is, but it cannot know the
		// room went quiet if it is being fed a continuous stream, so the VAD's
		// endpoint is forwarded as an explicit flush.
		if (result.event?.type === 'speech-end') this.endpoint(stt);
		return true;
	}

	private drainPreRoll(stt: SttProvider): void {
		const buffered = this.preRoll.drain();
		for (const samples of buffered) this.feed(stt, samples);
		this.stats.preRollFramesDelivered += buffered.length;
	}

	/**
	 * One buffer into the recogniser.
	 *
	 * A throwing `feed()` is caught rather than propagated: this runs from a frame
	 * handler 50 times a second, so an unhandled throw would be 50 identical Sentry
	 * reports a second and would take the whole capture run down with it. One
	 * report per run, then the frames are counted as errors and dropped.
	 */
	private feed(stt: SttProvider, samples: Int16Array): void {
		try {
			stt.feed(samples);
			this.stats.framesDelivered += 1;
		} catch (error) {
			this.stats.feedErrors += 1;
			if (this.reportedFeedError) return;
			this.reportedFeedError = true;
			logger.error(
				`Speech provider '${stt.id}' rejected audio: ${(error as Error).message}`,
				LOG_CONTEXT
			);
			void captureException(error as Error, {
				context: 'acappella.audioPipeline.feed',
				providerId: stt.id,
			});
		}
	}

	private endpoint(stt: SttProvider): void {
		void stt.flush().catch((error: Error) => {
			// Endpointing is a hint. A provider that cannot take it still has the
			// audio, so this is reported and the run continues.
			void captureException(error, {
				context: 'acappella.audioPipeline.endpoint',
				providerId: stt.id,
			});
		});
	}

	/**
	 * Dropped frames are logged in batches. Per frame it would be 50 lines a second
	 * of the least useful log in the app; per batch it is one line every 10 s that
	 * says the microphone is running with nothing listening.
	 */
	private countDropForLogging(): void {
		this.dropsSinceLog += 1;
		if (this.dropsSinceLog < DROP_LOG_INTERVAL) return;
		logger.debug(
			`Dropped ${this.stats.framesDropped} captured frames (state '${this.lastState}')`,
			LOG_CONTEXT
		);
		this.dropsSinceLog = 0;
	}

	private logDropSummary(): void {
		const { framesReceived, framesDelivered, framesDropped, sequenceGaps, feedErrors } = this.stats;
		if (framesReceived === 0) return;
		const message =
			`Audio run: ${framesReceived} frames, ${framesDelivered} delivered, ` +
			`${framesDropped} dropped, ${sequenceGaps} lost in transit, ${feedErrors} feed errors`;
		if (sequenceGaps > 0 || feedErrors > 0) logger.warn(message, LOG_CONTEXT);
		else logger.debug(message, LOG_CONTEXT);
	}

	private resetRun(): void {
		this.vad.reset();
		this.preRoll.clear();
		this.feeding = false;
		this.lastSeq = 0;
		this.dropsSinceLog = 0;
		this.reportedFeedError = false;
		this.lastState = this.options.session.getState();
		this.stats = emptyStats();
	}
}

export function createAudioPipeline(options: AudioPipelineOptions): AudioPipeline {
	return new AudioPipeline(options);
}

// ---------------------------------------------------------------------------

function emptyStats(): AudioPipelineStats {
	return {
		framesReceived: 0,
		framesDelivered: 0,
		framesDropped: 0,
		preRollFramesDelivered: 0,
		sequenceGaps: 0,
		bargeIns: 0,
		feedErrors: 0,
	};
}

/** Clamped, never rejected: this arrives from a user setting, like the VAD's numbers. */
function resolvePreRollMs(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_PRE_ROLL_MS;
	return Math.min(MAX_PRE_ROLL_MS, Math.max(0, value));
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_DUCK_GAIN;
	return value < 0 ? 0 : value > 1 ? 1 : value;
}
