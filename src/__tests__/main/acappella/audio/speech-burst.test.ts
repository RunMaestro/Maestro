/**
 * @file speech-burst.test.ts
 *
 * Cutting a microphone stream into bursts of speech: what a burst contains,
 * when it is handed over, and that a monologue is handed over once.
 */

import { describe, it, expect } from 'vitest';

import {
	SpeechBurstSegmenter,
	type SpeechBurst,
} from '../../../../main/acappella/audio/speech-burst';
import { melody, toFrames, TONES } from '../../../helpers/wakeTrainingFixtures';

function segment(
	audio: Float32Array,
	options: { preSpeechMs?: number; maxBurstMs?: number; endpointSilenceMs?: number } = {}
) {
	const bursts: SpeechBurst[] = [];
	const segmenter = new SpeechBurstSegmenter({
		preSpeechMs: options.preSpeechMs ?? 200,
		maxBurstMs: options.maxBurstMs ?? 3000,
		vad: { endpointSilenceMs: options.endpointSilenceMs ?? 400 },
		onBurst: (burst) => bursts.push(burst),
	});
	for (const frame of toFrames(audio)) segmenter.pushFrame(frame);
	return { bursts, segmenter };
}

const quiet = (ms: number) => ({ hz: 0, ms });
const tone = (ms: number) => ({ hz: TONES.mid, ms });

describe('SpeechBurstSegmenter', () => {
	it('hands over one burst per stretch of speech, with its length', () => {
		const { bursts } = segment(
			melody([quiet(600), tone(500), quiet(1000), tone(700), quiet(1000)])
		);

		expect(bursts).toHaveLength(2);
		expect(bursts.every((burst) => !burst.truncated)).toBe(true);
		expect(bursts[0].speechMs).toBeGreaterThanOrEqual(440);
		expect(bursts[0].speechMs).toBeLessThanOrEqual(560);
		expect(bursts[1].speechMs).toBeGreaterThan(bursts[0].speechMs!);
	});

	it('keeps a little of the quiet before the onset and the silence that ended it', () => {
		const { bursts } = segment(melody([quiet(1000), tone(500), quiet(1000)]));

		const samples = bursts[0].pcm.length;
		// More than the speech alone, less than speech plus a second of quiet.
		expect(samples).toBeGreaterThan(0.5 * 16000);
		expect(samples).toBeLessThan(1.4 * 16000);
		// The burst opens on the lead-in, not on the tone.
		expect(Math.abs(bursts[0].pcm[0])).toBe(0);
	});

	it('hands a monologue over once, at the cap, and marks it cut', () => {
		const { bursts } = segment(melody([quiet(400), tone(4000), quiet(1000)]), { maxBurstMs: 1000 });

		expect(bursts).toHaveLength(1);
		expect(bursts[0].truncated).toBe(true);
		expect(bursts[0].speechMs).toBeUndefined();
		expect(bursts[0].pcm.length).toBeGreaterThanOrEqual(16000);
		expect(bursts[0].pcm.length).toBeLessThan(16000 + 640);
	});

	it('is ready for the next burst after one that was cut', () => {
		const { bursts } = segment(
			melody([quiet(400), tone(2000), quiet(1000), tone(400), quiet(1000)]),
			{ maxBurstMs: 1000 }
		);

		expect(bursts.map((burst) => burst.truncated)).toEqual([true, false]);
	});

	it('hears nothing in silence, and forgets a burst in progress on reset', () => {
		expect(segment(melody([quiet(2000)])).bursts).toHaveLength(0);

		const bursts: SpeechBurst[] = [];
		const segmenter = new SpeechBurstSegmenter({
			preSpeechMs: 200,
			maxBurstMs: 3000,
			onBurst: (burst) => bursts.push(burst),
		});
		for (const frame of toFrames(melody([quiet(400), tone(400)]))) segmenter.pushFrame(frame);
		expect(segmenter.inSpeech).toBe(true);
		segmenter.reset();
		expect(segmenter.inSpeech).toBe(false);
		for (const frame of toFrames(melody([quiet(1500)]))) segmenter.pushFrame(frame);
		expect(bursts).toHaveLength(0);
	});

	it("does not keep a reference to the caller's frame", () => {
		const bursts: SpeechBurst[] = [];
		const segmenter = new SpeechBurstSegmenter({
			preSpeechMs: 0,
			maxBurstMs: 3000,
			vad: { endpointSilenceMs: 300 },
			onBurst: (burst) => bursts.push(burst),
		});
		// One buffer, refilled for every frame, the way a capture path reuses one.
		const shared = new Int16Array(320);
		for (const frame of toFrames(melody([quiet(400), tone(500), quiet(800)]))) {
			shared.set(frame);
			segmenter.pushFrame(shared);
		}
		shared.fill(0);

		expect(bursts).toHaveLength(1);
		expect(bursts[0].pcm.some((sample) => sample !== 0)).toBe(true);
	});
});
