/**
 * A Cappella voice activity detection.
 *
 * The detector is pure and synchronous over frames, so every case here is
 * generated PCM: sine tones for voiced speech, alternating samples for hiss, a
 * sub-audio partial cycle for rumble, zeros for silence. No audio device, no
 * fake timers, no `AudioContext` - if any of those were needed the VAD would
 * have the wrong shape.
 *
 * Cases that assert exact thresholds run with `adaptiveNoiseFloor: false` so the
 * configured absolute numbers are the operative ones. Adaptation gets its own
 * block.
 */

import { describe, expect, it } from 'vitest';

import {
	ACAPPELLA_AUDIO_FRAME_SAMPLES,
	ACAPPELLA_AUDIO_SAMPLE_RATE,
} from '../../../../shared/acappella/audio-host';
import type { AudioFrame } from '../../../../shared/acappella/audio-host';
import {
	DEFAULT_VAD_CONFIG,
	VoiceActivityDetector,
	createVoiceActivityDetector,
	measure,
	resolveVadConfig,
} from '../../../../main/acappella/audio/vad';
import type { VadConfig, VadEvent, VadFrameResult } from '../../../../main/acappella/audio/vad';

// ---------------------------------------------------------------------------
// Signal generators
// ---------------------------------------------------------------------------

const FRAME = ACAPPELLA_AUDIO_FRAME_SAMPLES;

function build(fill: (index: number) => number): Int16Array {
	const samples = new Int16Array(FRAME);
	for (let i = 0; i < FRAME; i++) {
		const value = Math.max(-1, Math.min(1, fill(i)));
		samples[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
	}
	return samples;
}

const silence = (): Int16Array => build(() => 0);

/** Voiced speech stand-in: 200 Hz puts the zero-crossing rate squarely in band. */
const tone = (amplitude: number, frequency = 200): Int16Array =>
	build((i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / ACAPPELLA_AUDIO_SAMPLE_RATE));

/** Broadband transient / hiss: a sign flip every sample is the maximum possible ZCR. */
const hiss = (amplitude: number): Int16Array =>
	build((i) => (i % 2 === 0 ? amplitude : -amplitude));

/** Rumble: 15 Hz never completes a cycle inside a 20 ms frame, so it never crosses zero. */
const rumble = (amplitude: number): Int16Array => tone(amplitude, 15);

function feed(detector: VoiceActivityDetector, frame: Int16Array, count: number): VadFrameResult[] {
	const results: VadFrameResult[] = [];
	for (let i = 0; i < count; i++) results.push(detector.process(frame));
	return results;
}

function events(results: VadFrameResult[]): VadEvent[] {
	return results.map((r) => r.event).filter((e): e is VadEvent => e !== null);
}

/** Deterministic thresholds: adaptation is exercised separately. */
const fixed = (overrides: Partial<VadConfig> = {}): VoiceActivityDetector =>
	createVoiceActivityDetector({ adaptiveNoiseFloor: false, ...overrides });

// ---------------------------------------------------------------------------

describe('measure', () => {
	it('reports the RMS of a full-scale tone as roughly 1/sqrt(2)', () => {
		const { rms } = measure(tone(1));
		expect(rms).toBeCloseTo(Math.SQRT1_2, 2);
	});

	it('reports zero for an empty frame rather than NaN', () => {
		expect(measure(new Int16Array(0))).toEqual({ rms: 0, zeroCrossingRate: 0 });
	});

	it('reports a real level for a one-sample frame without dividing by zero', () => {
		// A truncated frame is a transport artefact, not a signal. The level is
		// still measurable; the crossing rate needs two samples to have a meaning,
		// and a NaN here would poison every threshold comparison downstream.
		const { rms, zeroCrossingRate } = measure(new Int16Array([16384]));
		expect(rms).toBeCloseTo(0.5, 2);
		expect(zeroCrossingRate).toBe(0);
	});

	it('puts a 200 Hz tone inside the default zero-crossing band', () => {
		const { zeroCrossingRate } = measure(tone(0.5));
		expect(zeroCrossingRate).toBeGreaterThan(DEFAULT_VAD_CONFIG.minZeroCrossingRate);
		expect(zeroCrossingRate).toBeLessThan(DEFAULT_VAD_CONFIG.maxZeroCrossingRate);
	});

	it('puts hiss above the band and rumble below it', () => {
		expect(measure(hiss(0.5)).zeroCrossingRate).toBeGreaterThan(
			DEFAULT_VAD_CONFIG.maxZeroCrossingRate
		);
		expect(measure(rumble(0.5)).zeroCrossingRate).toBeLessThan(
			DEFAULT_VAD_CONFIG.minZeroCrossingRate
		);
	});
});

describe('VoiceActivityDetector - onset', () => {
	it('stays silent through silence', () => {
		const vad = fixed();
		const results = feed(vad, silence(), 100);
		expect(events(results)).toEqual([]);
		expect(vad.state).toBe('silence');
		expect(results.every((r) => !r.active)).toBe(true);
	});

	it('opens on exactly the configured number of consecutive speech frames', () => {
		const vad = fixed({ enterFrames: 4 });
		const results = feed(vad, tone(0.2), 4);

		expect(events(results.slice(0, 3))).toEqual([]);
		expect(results[3].event).toEqual({ type: 'speech-start', atMs: 0 });
		expect(vad.state).toBe('speech');
		expect(results[3].active).toBe(true);
	});

	it('backdates speech-start to the first qualifying frame, not the deciding one', () => {
		const vad = fixed({ enterFrames: 3, frameMs: 20 });
		feed(vad, silence(), 5);
		const results = feed(vad, tone(0.2), 3);

		// Frames 0-4 were silence, so the onset begins at frame 5 => 100 ms.
		expect(results[2].event).toEqual({ type: 'speech-start', atMs: 100 });
		// The decision itself landed two frames later, at the 160 ms mark.
		expect(results[2].elapsedMs).toBe(160);
	});

	it('does not open on a transient shorter than enterFrames', () => {
		const vad = fixed({ enterFrames: 4 });
		// Three loud frames, a gap, three more: the run counter resets, so neither
		// burst is ever sustained enough to take the floor.
		const results = [
			...feed(vad, tone(0.4), 3),
			...feed(vad, silence(), 2),
			...feed(vad, tone(0.4), 3),
		];

		expect(events(results)).toEqual([]);
		expect(vad.state).toBe('silence');
	});

	it('rejects loud hiss: energy alone is not speech', () => {
		const vad = fixed();
		expect(events(feed(vad, hiss(0.9), 50))).toEqual([]);
		expect(vad.state).toBe('silence');
	});

	it('rejects loud rumble below the zero-crossing band', () => {
		const vad = fixed();
		expect(events(feed(vad, rumble(0.9), 50))).toEqual([]);
		expect(vad.state).toBe('silence');
	});

	it('ignores the zero-crossing band once speech is open, so a trailing fricative sustains it', () => {
		const vad = fixed({ enterFrames: 2, endpointSilenceMs: 200 });
		feed(vad, tone(0.3), 2);
		expect(vad.state).toBe('speech');

		// Hiss would never have opened the floor, but it is loud, so it holds it.
		const results = feed(vad, hiss(0.3), 20);
		expect(events(results)).toEqual([]);
		expect(vad.state).toBe('speech');
	});
});

describe('VoiceActivityDetector - hysteresis', () => {
	it('sustains speech on levels that were too quiet to open it', () => {
		const vad = fixed({ enterRms: 0.05, exitRms: 0.01, enterFrames: 2, endpointSilenceMs: 200 });
		vad.processMeasurement(0.1, 0.05);
		vad.processMeasurement(0.1, 0.05);
		expect(vad.state).toBe('speech');

		// Between the two thresholds: too quiet to have entered, loud enough to stay.
		const held = Array.from({ length: 30 }, () => vad.processMeasurement(0.03, 0.05));
		expect(events(held)).toEqual([]);
		expect(vad.state).toBe('speech');
		expect(held.every((r) => r.active)).toBe(true);
	});

	it('does not open on levels between the two thresholds', () => {
		const vad = fixed({ enterRms: 0.05, exitRms: 0.01, enterFrames: 2 });
		const results = Array.from({ length: 30 }, () => vad.processMeasurement(0.03, 0.05));
		expect(events(results)).toEqual([]);
		expect(vad.state).toBe('silence');
	});
});

describe('VoiceActivityDetector - candidate frames', () => {
	it('flags a voice-like frame long before it would open the floor', () => {
		const vad = fixed({ enterFrames: 4 });
		const results = feed(vad, tone(0.3), 3);

		// Every frame looks like voice; none of them is enough evidence yet. This is
		// the 80 ms head start the pipeline ducks TTS output on.
		expect(results.map((r) => r.candidate)).toEqual([true, true, true]);
		expect(events(results)).toEqual([]);
	});

	it('does not flag rumble or hiss, which is what makes the duck safe', () => {
		const vad = fixed({ enterFrames: 4 });
		expect(vad.process(rumble(0.3)).candidate).toBe(false);
		expect(vad.process(hiss(0.3)).candidate).toBe(false);
		expect(vad.process(silence()).candidate).toBe(false);
	});

	it('tracks energy alone once the floor is open', () => {
		const vad = fixed({ enterRms: 0.05, exitRms: 0.01, enterFrames: 2 });
		vad.processMeasurement(0.1, 0.05);
		vad.processMeasurement(0.1, 0.05);

		// A trailing fricative is high-ZCR and still carries the utterance, so the
		// entry band does not apply on the way out.
		expect(vad.process(hiss(0.3)).candidate).toBe(true);
		expect(vad.process(silence()).candidate).toBe(false);
	});
});

describe('VoiceActivityDetector - hangover', () => {
	it('keeps frames active through the hangover and drops them after', () => {
		const vad = fixed({ enterFrames: 2, hangoverFrames: 5, endpointSilenceMs: 700 });
		feed(vad, tone(0.3), 2);

		const quiet = feed(vad, silence(), 8);
		// Silent frames 1..5 are hangover: still part of the utterance.
		expect(quiet.slice(0, 5).map((r) => r.active)).toEqual([true, true, true, true, true]);
		// From frame 6 the audio stops being fed onward, but the utterance is not
		// over: the endpoint decision is a separate, longer clock.
		expect(quiet.slice(5).map((r) => r.active)).toEqual([false, false, false]);
		expect(quiet.map((r) => r.state)).toEqual(Array(8).fill('speech'));
	});

	it('resets the hangover when speech resumes', () => {
		const vad = fixed({ enterFrames: 2, hangoverFrames: 3, endpointSilenceMs: 700 });
		feed(vad, tone(0.3), 2);
		feed(vad, silence(), 3);
		const resumed = feed(vad, tone(0.3), 1);

		expect(resumed[0].active).toBe(true);
		expect(resumed[0].silenceMs).toBe(0);
	});
});

describe('VoiceActivityDetector - endpointing', () => {
	it('ends the utterance after the configured silence and reports its span', () => {
		const vad = fixed({ enterFrames: 2, endpointSilenceMs: 700, frameMs: 20 });
		feed(vad, tone(0.3), 10); // 200 ms of speech
		const quiet = feed(vad, silence(), 40);

		const emitted = events(quiet);
		expect(emitted).toEqual([
			{
				type: 'speech-end',
				atMs: 200,
				startedAtMs: 0,
				durationMs: 200,
				trailingSilenceMs: 700,
			},
		]);
		// 700 ms is 35 frames, so the decision lands on the 35th silent frame.
		expect(quiet.findIndex((r) => r.event !== null)).toBe(34);
		expect(vad.state).toBe('silence');
	});

	it('defaults the endpoint to 700 ms', () => {
		expect(DEFAULT_VAD_CONFIG.endpointSilenceMs).toBe(700);
	});

	it('honours a shorter endpoint setting', () => {
		const vad = fixed({ enterFrames: 2, endpointSilenceMs: 300, frameMs: 20 });
		feed(vad, tone(0.3), 5);
		const quiet = feed(vad, silence(), 20);

		expect(quiet.findIndex((r) => r.event !== null)).toBe(14); // 15 frames = 300 ms
		expect(events(quiet)[0]).toMatchObject({ type: 'speech-end', trailingSilenceMs: 300 });
	});

	it('does not split an utterance on a pause shorter than the endpoint', () => {
		const vad = fixed({ enterFrames: 2, endpointSilenceMs: 700, frameMs: 20 });
		feed(vad, tone(0.3), 5);
		const pause = feed(vad, silence(), 20); // 400 ms: a person thinking
		const second = feed(vad, tone(0.3), 5);

		expect(events(pause)).toEqual([]);
		expect(events(second)).toEqual([]);
		expect(vad.state).toBe('speech');
	});

	it('dates speech-end to the last voiced frame, excluding the endpoint silence', () => {
		const vad = fixed({ enterFrames: 2, endpointSilenceMs: 200, frameMs: 20 });
		feed(vad, tone(0.3), 5); // ends at 100 ms
		feed(vad, silence(), 3); // a 60 ms gap, well short of the endpoint
		feed(vad, tone(0.3), 2); // ends at 200 ms
		const quiet = feed(vad, silence(), 10);

		expect(events(quiet)[0]).toMatchObject({ atMs: 200, durationMs: 200 });
	});

	it('opens a second utterance after the first ends', () => {
		const vad = fixed({ enterFrames: 2, endpointSilenceMs: 200, frameMs: 20 });
		const all = [
			...feed(vad, tone(0.3), 5),
			...feed(vad, silence(), 12),
			...feed(vad, tone(0.3), 5),
		];

		expect(events(all).map((e) => e.type)).toEqual(['speech-start', 'speech-end', 'speech-start']);
	});
});

describe('VoiceActivityDetector - noise floor', () => {
	it('rejects steady room noise that a fixed threshold would treat as speech', () => {
		// ~0.028 RMS: above the 0.02 absolute enter threshold, and in the ZCR band.
		const noise = tone(0.04);
		expect(measure(noise).rms).toBeGreaterThan(DEFAULT_VAD_CONFIG.enterRms);

		const withoutAdaptation = fixed();
		expect(events(feed(withoutAdaptation, noise, 60)).map((e) => e.type)).toEqual(['speech-start']);

		const withAdaptation = createVoiceActivityDetector();
		expect(events(feed(withAdaptation, noise, 60))).toEqual([]);
		expect(withAdaptation.state).toBe('silence');
	});

	it('still opens on speech that clears the raised threshold', () => {
		const vad = createVoiceActivityDetector();
		feed(vad, tone(0.04), 60); // let the floor settle on the room
		expect(vad.noiseFloor).toBeGreaterThan(0.01);

		expect(events(feed(vad, tone(0.5), 10)).map((e) => e.type)).toEqual(['speech-start']);
	});

	it('clamps the floor so noise can never adapt the microphone into deafness', () => {
		const vad = createVoiceActivityDetector();
		// Hiss is loud but out of band, so it trains the floor without ever opening.
		feed(vad, hiss(0.9), 500);
		expect(vad.noiseFloor).toBe(DEFAULT_VAD_CONFIG.maxNoiseFloor);
		expect(vad.state).toBe('silence');
	});

	it('follows a room back down quickly when the noise stops', () => {
		const vad = createVoiceActivityDetector();
		feed(vad, hiss(0.9), 500);
		feed(vad, silence(), 20);
		expect(vad.noiseFloor).toBeLessThan(0.001);
	});

	it('freezes the estimate while an utterance is open', () => {
		const vad = createVoiceActivityDetector({ enterFrames: 2, endpointSilenceMs: 10_000 });
		feed(vad, tone(0.5), 2);
		const floorAtOnset = vad.noiseFloor;

		feed(vad, tone(0.5), 200);
		expect(vad.noiseFloor).toBe(floorAtOnset);
	});

	it('does not delay onset for someone who speaks the instant the mic opens', () => {
		// Calibration trains on speech here, which is exactly the case the ceiling
		// exists for: the floor saturates and real speech still clears it.
		const vad = createVoiceActivityDetector({ enterFrames: 4 });
		const results = feed(vad, tone(0.5), 4);
		expect(results[3].event).toEqual({ type: 'speech-start', atMs: 0 });
	});

	it('needs no calibration pass when it is disabled', () => {
		// Without the fast head start the floor cannot outrun a noisy room, and the
		// detector latches open on noise a calibrated one rejects.
		const vad = createVoiceActivityDetector({ calibrationFrames: 0 });
		expect(events(feed(vad, tone(0.04), 60)).map((e) => e.type)).toEqual(['speech-start']);
	});

	it('reports a zero floor when adaptation is disabled', () => {
		const vad = fixed();
		const results = feed(vad, tone(0.5), 5);
		expect(results.every((r) => r.noiseFloor === 0)).toBe(true);
	});
});

describe('VoiceActivityDetector - lifecycle', () => {
	it('reset clears the open utterance and the frame clock', () => {
		const vad = fixed({ enterFrames: 2 });
		feed(vad, tone(0.3), 5);
		expect(vad.state).toBe('speech');

		vad.reset();
		expect(vad.state).toBe('silence');
		expect(vad.elapsedMs).toBe(0);
		expect(vad.noiseFloor).toBe(0);

		// No stale speech-end for audio from the previous run.
		expect(events(feed(vad, silence(), 60))).toEqual([]);
	});

	it('accepts an AudioFrame straight off the wire', () => {
		const vad = fixed({ enterFrames: 2 });
		const pcm = tone(0.3);
		const buffer = new ArrayBuffer(pcm.byteLength);
		new Int16Array(buffer).set(pcm);
		const frame: AudioFrame = {
			seq: 1,
			capturedAt: 1_700_000_000_000,
			// Deliberately wrong: the detector measures the samples, not this field.
			rms: 0,
			pcm: buffer,
		};

		expect(vad.processFrame(frame).rms).toBeCloseTo(measure(pcm).rms, 5);
		expect(vad.processFrame(frame).event).toEqual({ type: 'speech-start', atMs: 0 });
	});

	it('advances its clock in frames, independent of wall time', () => {
		const vad = fixed({ frameMs: 20 });
		feed(vad, silence(), 50);
		expect(vad.elapsedMs).toBe(1000);
	});
});

describe('resolveVadConfig', () => {
	it('fills in the defaults', () => {
		expect(resolveVadConfig()).toEqual(DEFAULT_VAD_CONFIG);
	});

	it('pins the exit threshold below the enter threshold', () => {
		// An exit at or above the enter threshold would open and close on one frame.
		const config = resolveVadConfig({ enterRms: 0.03, exitRms: 0.5 });
		expect(config.exitRms).toBe(0.03);
	});

	it('clamps rather than throws on nonsense, because these come from user settings', () => {
		const config = resolveVadConfig({
			frameMs: -5,
			enterFrames: 0,
			hangoverFrames: -3,
			endpointSilenceMs: 1,
			enterRms: 5,
			maxZeroCrossingRate: 9,
			noiseFloorEnterMargin: 0.1,
		});

		expect(config.frameMs).toBe(1);
		expect(config.enterFrames).toBe(1);
		expect(config.hangoverFrames).toBe(0);
		expect(config.endpointSilenceMs).toBeGreaterThanOrEqual(config.frameMs);
		expect(config.enterRms).toBe(1);
		expect(config.maxZeroCrossingRate).toBe(1);
		expect(config.noiseFloorEnterMargin).toBe(1);
	});

	it('falls back to the default for a non-finite value', () => {
		const config = resolveVadConfig({ endpointSilenceMs: Number.NaN, enterRms: Number.NaN });
		expect(config.endpointSilenceMs).toBe(DEFAULT_VAD_CONFIG.endpointSilenceMs);
		expect(config.enterRms).toBe(DEFAULT_VAD_CONFIG.enterRms);
	});

	it('never lets the endpoint fall below a single frame', () => {
		const config = resolveVadConfig({ frameMs: 20, endpointSilenceMs: 0 });
		expect(config.endpointSilenceMs).toBe(20);
	});
});

describe('VoiceActivityDetector construction', () => {
	it('exposes the resolved config', () => {
		const vad = new VoiceActivityDetector({ endpointSilenceMs: 450 });
		expect(vad.config.endpointSilenceMs).toBe(450);
		expect(vad.config.enterRms).toBe(DEFAULT_VAD_CONFIG.enterRms);
	});
});
