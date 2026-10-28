/**
 * @file pcm.test.ts
 *
 * The float resampler the Local Models speech-to-text service uses for a clip
 * that did not arrive at 16 kHz. The integer helpers beside it are covered
 * through their A Cappella re-exports (`providers/pcm`).
 */

import { describe, it, expect } from 'vitest';

import {
	encodeWav,
	decodeWavPcm16,
	float32ToInt16,
	resampleFloat32,
	SPEECH_SAMPLE_RATE,
} from '../../../shared/audio/pcm';

describe('resampleFloat32', () => {
	it('returns the same buffer when the rates match, and for an empty clip', () => {
		const samples = Float32Array.from([0.1, 0.2, 0.3]);
		expect(resampleFloat32(samples, 16000, 16000)).toBe(samples);
		const empty = new Float32Array(0);
		expect(resampleFloat32(empty, 48000, 16000)).toBe(empty);
	});

	it('scales the length by the rate ratio in both directions', () => {
		expect(resampleFloat32(new Float32Array(48000), 48000, 16000)).toHaveLength(16000);
		expect(resampleFloat32(new Float32Array(8000), 8000, 16000)).toHaveLength(16000);
	});

	it('interpolates linearly when upsampling', () => {
		const out = resampleFloat32(Float32Array.from([0, 1]), 8000, 16000);
		expect(Array.from(out)).toEqual([0, 0.5, 1, 1]);
	});

	it('averages the samples each output covers when downsampling', () => {
		// 3:1. Picking one sample in three would keep 1, 4; the average keeps the
		// energy of all of them and is what removes the aliasing.
		const out = resampleFloat32(Float32Array.from([1, 2, 3, 4, 5, 6]), 48000, 16000);
		expect(Array.from(out)).toEqual([2, 5]);
	});

	it('cancels a tone above the new Nyquist instead of folding it into the speech band', () => {
		// A 24 kHz square wave at 48 kHz alternates +1, -1. Decimating by picking
		// samples would turn it into a constant; averaging removes most of it.
		const tone = Float32Array.from({ length: 480 }, (_, i) => (i % 2 === 0 ? 1 : -1));
		const out = resampleFloat32(tone, 48000, 16000);
		const peak = Math.max(...Array.from(out, Math.abs));
		expect(peak).toBeLessThan(0.5);
	});
});

describe('wav round trip at the speech rate', () => {
	it('defaults to 16 kHz and survives encode then decode', () => {
		const pcm = float32ToInt16(Float32Array.from([0, 0.5, -0.5, 1, -1]));
		const decoded = decodeWavPcm16(encodeWav(pcm));
		expect(decoded.sampleRate).toBe(SPEECH_SAMPLE_RATE);
		expect(Array.from(decoded.pcm)).toEqual(Array.from(pcm));
	});
});
