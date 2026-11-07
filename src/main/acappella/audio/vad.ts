/**
 * A Cappella voice activity detection.
 *
 * A pure, synchronous classifier over the 20 ms / 16 kHz mono frames the PCM
 * worklet produces. Feed it frames, get back a per-frame verdict plus the two
 * transitions the pipeline cares about: `speech-start` (the floor has real audio
 * on it) and `speech-end` (the utterance endpointed).
 *
 * **Nothing in here touches a clock, a timer, a device, or Electron.** Time is
 * counted in frames, because that is the only clock that stays honest when the
 * main thread stalls: 35 frames of silence is 700 ms of silence whether the
 * event loop was free or wedged. Callers that need wall time correlate against
 * `AudioFrame.capturedAt`, which the worklet derives from the audio clock. The
 * practical payoff is that the whole detector is testable from generated tone
 * and silence arrays with no audio device anywhere near it.
 *
 * The classifier is energy plus zero-crossing rate, the classic pairing, with
 * three things bolted on that the textbook version leaves out and that decide
 * whether it is usable in a real room:
 *
 *   1. **Hysteresis.** Opening takes `enterRms`, closing takes the lower
 *      `exitRms`. One threshold makes the detector chatter on every syllable
 *      whose level happens to sit on the line.
 *   2. **A zero-crossing band, applied only on the way in.** Voiced speech
 *      crosses zero at a moderate rate. A desk thump or a fan rumble is far
 *      below the band, hiss and broadband transients far above it. Once speech
 *      is open the band is dropped, because a trailing "sss" is legitimately
 *      high-ZCR and must not close the floor mid-word.
 *   3. **A tracked noise floor.** A fixed absolute threshold is tuned for
 *      exactly one room and one microphone. The floor follows the quiet parts
 *      down fast and drifts up slowly, so a laptop fan spinning up raises the
 *      bar rather than holding the mic open.
 *
 * The limitation worth stating rather than papering over: no energy/ZCR detector
 * can tell a cough from a word. The defences here are the ZCR band (a cough is a
 * broadband burst) and `enterFrames`, which demands sustained evidence before
 * opening. Anything that survives both is the transcript's problem, and the
 * backstop for a floor that opens and will not close is the idle timeout in
 * `floor-control.ts`, not a cleverer VAD.
 */

import { ACAPPELLA_AUDIO_FRAME_MS } from '../../../shared/acappella/audio-host';
import type { AudioFrame } from '../../../shared/acappella/audio-host';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface VadConfig {
	/** Duration of one frame. Must match the capture frame size, or every ms figure below lies. */
	frameMs: number;
	/** RMS (0 to 1) a frame must reach to count toward speech onset. */
	enterRms: number;
	/** RMS a frame must fall under to count as silence. Below `enterRms`: this is the hysteresis. */
	exitRms: number;
	/** Consecutive qualifying frames required before `speech-start`. The transient defence. */
	enterFrames: number;
	/**
	 * Silent frames tolerated before a frame stops being marked `active`. Stop
	 * consonants and inter-word gaps are silent; cutting the audio feed at the
	 * first quiet frame clips the end of every utterance.
	 */
	hangoverFrames: number;
	/**
	 * Continuous silence that ends an utterance. The endpointing decision, and
	 * the one knob a user has any business turning: too short truncates anyone
	 * who thinks mid-sentence, too long makes the assistant feel deaf.
	 */
	endpointSilenceMs: number;
	/** Crossings per sample below which a frame is rumble, not voice. */
	minZeroCrossingRate: number;
	/** Crossings per sample above which a frame is hiss or a transient, not voice. */
	maxZeroCrossingRate: number;
	/** Track the room's noise floor and lift both thresholds above it. */
	adaptiveNoiseFloor: boolean;
	/** Multiple of the noise floor the enter threshold is held above. */
	noiseFloorEnterMargin: number;
	/** Multiple of the noise floor the exit threshold is held above. Below the enter margin. */
	noiseFloorExitMargin: number;
	/**
	 * Hard ceiling on the tracked floor. Chosen so the adapted exit threshold
	 * stays under the level of ordinary conversational speech: a floor that could
	 * climb past the speaker would endpoint people mid-sentence, which is a far
	 * worse failure than failing to reject a loud room.
	 */
	maxNoiseFloor: number;
	/**
	 * Frames at the head of a run during which the floor adapts fast.
	 *
	 * Without this the estimator is useless exactly when it matters: a room whose
	 * noise already clears the absolute enter threshold opens the floor within
	 * `enterFrames` and then never sees a quiet frame to learn from, so it stays
	 * latched open. A short fast pass at the start measures the room before that
	 * can happen. It does NOT suppress onset - a user who talks the instant the
	 * mic opens is still heard immediately - which is safe only because
	 * {@link maxNoiseFloor} bounds how wrong a calibration on speech can be.
	 */
	calibrationFrames: number;
}

/**
 * Tuned for a headset or a laptop mic at arm's length in a normal room.
 *
 * `endpointSilenceMs: 700` is the number to argue about. It is long enough to
 * survive the pause people leave before the second half of a sentence and short
 * enough that a finished request does not feel ignored.
 */
export const DEFAULT_VAD_CONFIG: VadConfig = {
	frameMs: ACAPPELLA_AUDIO_FRAME_MS,
	enterRms: 0.02,
	exitRms: 0.01,
	enterFrames: 4,
	hangoverFrames: 10,
	endpointSilenceMs: 700,
	minZeroCrossingRate: 0.01,
	maxZeroCrossingRate: 0.3,
	adaptiveNoiseFloor: true,
	noiseFloorEnterMargin: 3,
	noiseFloorExitMargin: 1.8,
	maxNoiseFloor: 0.03,
	calibrationFrames: 10,
};

/** How fast the tracked floor follows a quieter room. Fast: quiet is trustworthy. */
const NOISE_FLOOR_FALL = 0.5;
/**
 * How fast it follows a louder one. Deliberately ~4 s: speech is loud too, and a
 * floor that chased it would raise the bar above the speaker mid-sentence.
 */
const NOISE_FLOOR_RISE = 0.005;
/** Rise rate during calibration. ~5 frames to the room's level, not four seconds. */
const NOISE_FLOOR_CALIBRATION_RISE = 0.3;

/**
 * Fill in and sanitise a partial config.
 *
 * Every out-of-range value is clamped rather than rejected. These numbers reach
 * us from user settings, and a typo in a preference must not be able to throw
 * inside the audio path - a slightly wrong threshold is recoverable, a dead
 * pipeline is not.
 */
export function resolveVadConfig(overrides: Partial<VadConfig> = {}): VadConfig {
	const merged = { ...DEFAULT_VAD_CONFIG, ...overrides };
	const frameMs = Math.max(1, finite(merged.frameMs, DEFAULT_VAD_CONFIG.frameMs));
	const enterRms = clamp(finite(merged.enterRms, DEFAULT_VAD_CONFIG.enterRms), 0, 1);
	const maxNoiseFloor = clamp(finite(merged.maxNoiseFloor, DEFAULT_VAD_CONFIG.maxNoiseFloor), 0, 1);
	return {
		frameMs,
		enterRms,
		// An exit threshold at or above the enter threshold would make the detector
		// open and close on the same frame, so it is pinned below it.
		exitRms: Math.min(clamp(finite(merged.exitRms, DEFAULT_VAD_CONFIG.exitRms), 0, 1), enterRms),
		enterFrames: Math.max(
			1,
			Math.round(finite(merged.enterFrames, DEFAULT_VAD_CONFIG.enterFrames))
		),
		hangoverFrames: Math.max(
			0,
			Math.round(finite(merged.hangoverFrames, DEFAULT_VAD_CONFIG.hangoverFrames))
		),
		// One frame of silence is the shortest endpoint that can exist; anything
		// less would fire `speech-end` on the same frame as `speech-start`.
		endpointSilenceMs: Math.max(
			frameMs,
			finite(merged.endpointSilenceMs, DEFAULT_VAD_CONFIG.endpointSilenceMs)
		),
		minZeroCrossingRate: clamp(
			finite(merged.minZeroCrossingRate, DEFAULT_VAD_CONFIG.minZeroCrossingRate),
			0,
			1
		),
		maxZeroCrossingRate: clamp(
			finite(merged.maxZeroCrossingRate, DEFAULT_VAD_CONFIG.maxZeroCrossingRate),
			0,
			1
		),
		adaptiveNoiseFloor: merged.adaptiveNoiseFloor !== false,
		noiseFloorEnterMargin: Math.max(
			1,
			finite(merged.noiseFloorEnterMargin, DEFAULT_VAD_CONFIG.noiseFloorEnterMargin)
		),
		noiseFloorExitMargin: Math.max(
			1,
			finite(merged.noiseFloorExitMargin, DEFAULT_VAD_CONFIG.noiseFloorExitMargin)
		),
		maxNoiseFloor,
		calibrationFrames: Math.max(
			0,
			Math.round(finite(merged.calibrationFrames, DEFAULT_VAD_CONFIG.calibrationFrames))
		),
	};
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type VadState = 'silence' | 'speech';

export type VadEvent =
	| {
			type: 'speech-start';
			/** Detector time at the START of the first qualifying frame, not at the decision. */
			atMs: number;
	  }
	| {
			type: 'speech-end';
			/** Detector time at the END of the last frame that counted as speech. */
			atMs: number;
			/** The matching `speech-start.atMs`. */
			startedAtMs: number;
			/** `atMs - startedAtMs`. Speech only: the endpoint silence is not in here. */
			durationMs: number;
			/** Silence measured before endpointing, rounded up to a whole frame. */
			trailingSilenceMs: number;
	  };

export interface VadFrameResult {
	/** State AFTER this frame. */
	state: VadState;
	/**
	 * Whether this frame belongs to the utterance and should be fed to STT. True
	 * through the hangover, which is the point of the hangover.
	 */
	active: boolean;
	/**
	 * Whether this frame on its own looks like voice: the full onset test while the
	 * floor is closed, energy above the exit threshold while it is open.
	 *
	 * Deliberately weaker evidence than {@link VadFrameResult.event} - one frame is
	 * not enough to open the floor - and that is exactly what makes it useful. The
	 * pipeline ducks TTS output on the first candidate frame, 80 ms before a
	 * `speech-start` could possibly be confirmed, and restores the gain if the
	 * candidate does not turn into speech.
	 */
	candidate: boolean;
	/** The transition this frame caused, if any. At most one per frame. */
	event: VadEvent | null;
	/** Root mean square of the frame, 0 to 1. */
	rms: number;
	/** Zero crossings per sample, 0 to 1. */
	zeroCrossingRate: number;
	/** The tracked noise floor after this frame. Always zero when adaptation is off. */
	noiseFloor: number;
	/** Detector time at the END of this frame. Frame count times `frameMs`. */
	elapsedMs: number;
	/** Continuous silence up to and including this frame. Zero while speech is live. */
	silenceMs: number;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Energy plus zero-crossing voice activity detection over fixed-size frames.
 *
 * Stateful across frames (that is what hysteresis and hangover mean) but with no
 * hidden inputs: the same frame sequence always produces the same event
 * sequence. Instances are cheap; the pipeline holds one per capture run and
 * calls {@link reset} rather than rebuilding.
 */
export class VoiceActivityDetector {
	readonly config: VadConfig;

	private currentState: VadState = 'silence';
	private frameIndex = 0;
	/** Consecutive onset candidates seen while in `silence`. */
	private candidateFrames = 0;
	/** Consecutive silent frames seen while in `speech`. */
	private silenceFrames = 0;
	/**
	 * Starts at zero, meaning "nothing measured yet". That is deliberately the
	 * conservative end: with no estimate the configured absolute thresholds
	 * govern, and the floor can only ever raise them from there. Seeding it at
	 * `exitRms` instead would mean the absolute settings were never the operative
	 * numbers in even a silent room, which makes them impossible to reason about.
	 */
	private noiseFloorValue = 0;
	private speechStartedAtMs = 0;
	/** Frame index just past the last frame that counted as speech. */
	private lastVoicedFrame = 0;
	private readonly endpointFrames: number;

	constructor(overrides: Partial<VadConfig> = {}) {
		this.config = resolveVadConfig(overrides);
		this.endpointFrames = Math.max(
			1,
			Math.ceil(this.config.endpointSilenceMs / this.config.frameMs)
		);
	}

	get state(): VadState {
		return this.currentState;
	}

	/** The tracked noise floor. Exposed for the level meter and for tests. */
	get noiseFloor(): number {
		return this.config.adaptiveNoiseFloor ? this.noiseFloorValue : 0;
	}

	/** Detector time at the end of the last processed frame. */
	get elapsedMs(): number {
		return this.frameIndex * this.config.frameMs;
	}

	/**
	 * Back to the state a fresh detector is in, including the frame clock. Call
	 * between capture runs: carrying an open `speech` state across a stop would
	 * make the next run's first frame emit a `speech-end` for audio nobody heard.
	 */
	reset(): void {
		this.currentState = 'silence';
		this.frameIndex = 0;
		this.candidateFrames = 0;
		this.silenceFrames = 0;
		this.noiseFloorValue = 0;
		this.speechStartedAtMs = 0;
		this.lastVoicedFrame = 0;
	}

	/** Convenience over the wire type. Uses the samples, not `frame.rms`, so there is one measure. */
	processFrame(frame: AudioFrame): VadFrameResult {
		return this.process(new Int16Array(frame.pcm));
	}

	/** Classify one frame of signed 16-bit mono PCM. */
	process(samples: Int16Array): VadFrameResult {
		const { rms, zeroCrossingRate } = measure(samples);
		return this.processMeasurement(rms, zeroCrossingRate);
	}

	/**
	 * The classifier proper, over an already-measured frame.
	 *
	 * Split out so tests can drive threshold and hangover behaviour directly
	 * rather than by synthesising PCM that happens to land on a level, and so a
	 * future caller that already has the numbers is not forced to rescan.
	 */
	processMeasurement(rms: number, zeroCrossingRate: number): VadFrameResult {
		const enterThreshold = this.enterThreshold();
		const exitThreshold = this.exitThreshold();
		const quiet = rms < exitThreshold;

		// Measured only while the floor is closed: an open utterance is the one
		// stretch we know is not noise, and feeding it into the estimate is how an
		// adaptive detector talks itself into cutting the speaker off. Steady state
		// also skips a run of onset candidates for the same reason; calibration
		// cannot afford to, since a noisy room is nothing but candidates.
		const calibrating = this.frameIndex < this.config.calibrationFrames;
		if (this.currentState === 'silence' && (calibrating || this.candidateFrames === 0)) {
			this.trackNoiseFloor(rms, calibrating);
		}

		this.frameIndex += 1;
		let event: VadEvent | null = null;
		let candidate: boolean;

		if (this.currentState === 'silence') {
			candidate =
				rms >= enterThreshold &&
				zeroCrossingRate >= this.config.minZeroCrossingRate &&
				zeroCrossingRate <= this.config.maxZeroCrossingRate;
			this.candidateFrames = candidate ? this.candidateFrames + 1 : 0;

			if (this.candidateFrames >= this.config.enterFrames) {
				// Dated to the start of the FIRST qualifying frame, not to the frame
				// that tipped the count. The onset is what the pre-roll aligns to, and
				// backdating it is the difference between the transcript keeping the
				// first syllable and losing it.
				this.speechStartedAtMs = (this.frameIndex - this.candidateFrames) * this.config.frameMs;
				this.currentState = 'speech';
				this.candidateFrames = 0;
				this.silenceFrames = 0;
				this.lastVoicedFrame = this.frameIndex;
				event = { type: 'speech-start', atMs: this.speechStartedAtMs };
			}
		} else {
			// Hysteresis: anything not under the exit threshold sustains speech, even
			// though it would not have been loud enough to open the floor.
			candidate = !quiet;
			if (quiet) {
				this.silenceFrames += 1;
			} else {
				this.silenceFrames = 0;
				this.lastVoicedFrame = this.frameIndex;
			}

			if (this.silenceFrames >= this.endpointFrames) {
				const atMs = this.lastVoicedFrame * this.config.frameMs;
				event = {
					type: 'speech-end',
					atMs,
					startedAtMs: this.speechStartedAtMs,
					durationMs: atMs - this.speechStartedAtMs,
					trailingSilenceMs: this.silenceFrames * this.config.frameMs,
				};
				this.currentState = 'silence';
				this.candidateFrames = 0;
				this.silenceFrames = 0;
			}
		}

		return {
			state: this.currentState,
			active: this.currentState === 'speech' && this.silenceFrames <= this.config.hangoverFrames,
			candidate,
			event,
			rms,
			zeroCrossingRate,
			noiseFloor: this.noiseFloor,
			elapsedMs: this.elapsedMs,
			silenceMs: this.silenceFrames * this.config.frameMs,
		};
	}

	private enterThreshold(): number {
		if (!this.config.adaptiveNoiseFloor) return this.config.enterRms;
		return Math.max(this.config.enterRms, this.noiseFloorValue * this.config.noiseFloorEnterMargin);
	}

	private exitThreshold(): number {
		if (!this.config.adaptiveNoiseFloor) return this.config.exitRms;
		// Monotone in both arguments and the exit margin is below the enter margin,
		// so this can never climb above `enterThreshold()`.
		return Math.max(this.config.exitRms, this.noiseFloorValue * this.config.noiseFloorExitMargin);
	}

	private trackNoiseFloor(rms: number, calibrating: boolean): void {
		if (!this.config.adaptiveNoiseFloor) return;
		const rise = calibrating ? NOISE_FLOOR_CALIBRATION_RISE : NOISE_FLOOR_RISE;
		const alpha = rms < this.noiseFloorValue ? NOISE_FLOOR_FALL : rise;
		this.noiseFloorValue = Math.min(
			this.config.maxNoiseFloor,
			this.noiseFloorValue + alpha * (rms - this.noiseFloorValue)
		);
	}
}

/** Sugar for `new VoiceActivityDetector(...)`, matching the rest of A Cappella's factories. */
export function createVoiceActivityDetector(
	overrides: Partial<VadConfig> = {}
): VoiceActivityDetector {
	return new VoiceActivityDetector(overrides);
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** Full-scale magnitude of a signed 16-bit sample. */
const INT16_SCALE = 0x8000;

/**
 * RMS and zero-crossing rate in one pass over the frame.
 *
 * The worklet already reports an RMS, but it measures the float samples before
 * quantisation while this measures what actually arrived, and the zero-crossing
 * scan has to walk the array regardless. One measure of the same bytes beats two
 * measures that disagree in the third decimal place.
 */
export function measure(samples: Int16Array): { rms: number; zeroCrossingRate: number } {
	const length = samples.length;
	if (length === 0) return { rms: 0, zeroCrossingRate: 0 };

	let sumSquares = 0;
	let crossings = 0;
	let previousPositive = samples[0] >= 0;

	for (let i = 0; i < length; i++) {
		const value = samples[i] / INT16_SCALE;
		sumSquares += value * value;
		const positive = samples[i] >= 0;
		if (i > 0 && positive !== previousPositive) crossings += 1;
		previousPositive = positive;
	}

	return {
		rms: Math.sqrt(sumSquares / length),
		zeroCrossingRate: length > 1 ? crossings / (length - 1) : 0,
	};
}

function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

function finite(value: number, fallback: number): number {
	return Number.isFinite(value) ? value : fallback;
}
