/**
 * A Cappella input level meter.
 *
 * Turns the 50 frames a second the capture worklet produces into the ~20 a
 * second a client can actually draw, so a live meter costs a number rather than
 * PCM. Pure and synchronous over frame measurements, like `vad.ts`: no clock, no
 * device, no Electron.
 *
 * **Why downsample at all.** A meter is read by an eye, and an eye cannot see 50
 * updates a second. Every frame that reaches a client past the point of
 * perception is a message on the IPC channel, a React render in every open
 * window, and - once the phone is a peer client in Phase 10 - a packet on a
 * radio. The window is the cheapest place in the whole pipeline to spend that.
 *
 * **The window is counted in frames, not milliseconds.** Same reasoning as the
 * VAD: 3 frames is 60 ms whether the event loop was free or wedged, so a stalled
 * main thread makes the meter coarse rather than wrong. With the standard 20 ms
 * frame the achievable rates bracket the target (2 frames is 25/s, 3 frames is
 * 16.7/s) and this rounds to the nearer one, which is 3. Under-reporting a meter
 * is cheaper than over-reporting it: nobody has ever noticed a level bar
 * updating 16 times a second instead of 20.
 *
 * **Silence is not published forever.** Once the meter has visibly fallen to
 * rest it stops emitting until something moves again. An open microphone in a
 * quiet room is the normal state of a voice session, and 20 identical zeros a
 * second is the definition of traffic nobody can use.
 */

import { ACAPPELLA_AUDIO_FRAME_MS } from '../../../shared/acappella/audio-host';

/** Meter updates per second. What a client draws, not what the microphone produces. */
export const DEFAULT_LEVEL_UPDATE_HZ = 20;

/**
 * Level at or below which the meter counts as at rest. Sits under the VAD's exit
 * threshold on purpose: the meter must be able to show room noise the detector
 * is ignoring, or a user with a dead microphone and a user in a quiet room would
 * see the same thing.
 */
export const DEFAULT_LEVEL_SILENCE = 0.005;

export interface AudioLevelMeterConfig {
	/** Duration of one input frame. Must match the capture frame size. */
	frameMs: number;
	/** Target updates per second. Realised to the nearest whole number of frames. */
	updateHz: number;
	/** Level at or under which the meter is at rest and stops republishing. */
	silenceLevel: number;
}

export const DEFAULT_LEVEL_METER_CONFIG: AudioLevelMeterConfig = {
	frameMs: ACAPPELLA_AUDIO_FRAME_MS,
	updateHz: DEFAULT_LEVEL_UPDATE_HZ,
	silenceLevel: DEFAULT_LEVEL_SILENCE,
};

/** One meter update, shaped exactly like the body of an `audio-level` event. */
export interface AudioLevelUpdate {
	/** Root mean square across the window, 0 to 1. */
	level: number;
	/** Whether the detector held the floor open at any point in the window. */
	speech: boolean;
}

/**
 * Clamped, never thrown. These numbers reach the meter from user settings, and a
 * typo in a preference must not be able to throw inside the audio path.
 */
export function resolveLevelMeterConfig(
	overrides?: Partial<AudioLevelMeterConfig>
): AudioLevelMeterConfig {
	const merged = { ...DEFAULT_LEVEL_METER_CONFIG, ...(overrides ?? {}) };
	return {
		frameMs: positive(merged.frameMs, DEFAULT_LEVEL_METER_CONFIG.frameMs),
		updateHz: positive(merged.updateHz, DEFAULT_LEVEL_METER_CONFIG.updateHz),
		silenceLevel: clamp01(merged.silenceLevel, DEFAULT_LEVEL_METER_CONFIG.silenceLevel),
	};
}

/**
 * Accumulates frame measurements and yields an update once per window.
 *
 * Instances are cheap and hold one capture run; the pipeline pushes each frame's
 * RMS and the detector's verdict, and publishes whatever comes back.
 */
export class AudioLevelMeter {
	readonly config: AudioLevelMeterConfig;
	/** Frames per update. At least one, so a pathological config still emits. */
	readonly windowFrames: number;

	private frames = 0;
	/** Sum of squares, so the window's level is a true RMS rather than a mean of RMSs. */
	private sumSquares = 0;
	private speech = false;
	/** Whether the last published update was already at rest. Null before the first. */
	private atRest: boolean | null = null;

	constructor(overrides?: Partial<AudioLevelMeterConfig>) {
		this.config = resolveLevelMeterConfig(overrides);
		this.windowFrames = Math.max(1, Math.round(1000 / this.config.updateHz / this.config.frameMs));
	}

	/** Realised update rate, which is the frame quantum's answer rather than the requested one. */
	get updateHz(): number {
		return 1000 / (this.windowFrames * this.config.frameMs);
	}

	/**
	 * Add one frame.
	 *
	 * @param rms   The frame's root mean square, 0 to 1.
	 * @param speech Whether the detector counted this frame as part of an utterance.
	 * @returns The update to publish, or null when the window is still filling or
	 *          the meter is already at rest and has not moved.
	 */
	push(rms: number, speech: boolean): AudioLevelUpdate | null {
		const value = clamp01(rms, 0);
		this.sumSquares += value * value;
		this.speech = this.speech || speech;
		this.frames += 1;
		if (this.frames < this.windowFrames) return null;

		const level = Math.sqrt(this.sumSquares / this.frames);
		const update: AudioLevelUpdate = { level, speech: this.speech };
		this.frames = 0;
		this.sumSquares = 0;
		this.speech = false;

		const resting = level <= this.config.silenceLevel && !update.speech;
		// The first at-rest window is published so the meter visibly falls to zero;
		// every one after it says nothing new.
		if (resting && this.atRest) return null;
		this.atRest = resting;
		return update;
	}

	/**
	 * Drop the partial window and forget what was last published.
	 *
	 * Called when a capture run ends: the next run must publish its first update
	 * even if the room is silent, or a client that started listening during the
	 * gap would show a meter frozen at whatever the last run left behind.
	 */
	reset(): void {
		this.frames = 0;
		this.sumSquares = 0;
		this.speech = false;
		this.atRest = null;
	}
}

export function createAudioLevelMeter(overrides?: Partial<AudioLevelMeterConfig>): AudioLevelMeter {
	return new AudioLevelMeter(overrides);
}

// ---------------------------------------------------------------------------

function positive(value: number, fallback: number): number {
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp01(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return value < 0 ? 0 : value > 1 ? 1 : value;
}
