/**
 * @file whisper-mel.test.ts
 *
 * The feature extractor in front of local speech-to-text.
 *
 * These matter more than their size suggests. Whisper's encoder consumes an
 * 80 x 3000 image, and if that image is subtly wrong NOTHING raises: the encoder
 * accepts it, the decoder runs, and it emits a fluent, confident, entirely
 * invented sentence. The bug that prompted this file was exactly that - a
 * 400-sample window zero-padded into a 512-point FFT, which moves every bin and
 * therefore every mel filter. The transcript decoded its first two words
 * correctly and then collapsed into "to be able to be able to be able".
 *
 * So the DFT is checked against a brute-force O(n^2) transform rather than
 * against itself: a naive DFT is the definition, it is trivially correct, and it
 * is the one reference that cannot drift with the implementation.
 */

import { describe, it, expect } from 'vitest';

import {
	WhisperMelExtractor,
	createDftPlan,
	dftPowerSpectrum,
	hannWindow,
	melFilterBank,
	WHISPER_N_FFT,
	WHISPER_N_FRAMES,
	WHISPER_N_MELS,
	WHISPER_SAMPLE_RATE,
} from '../../../../main/acappella/providers/local/whisper/mel';

/** The definition of a DFT, written out. Ground truth for the fast path. */
function naiveDftPower(frame: Float64Array): Float64Array {
	const n = frame.length;
	const out = new Float64Array(n / 2 + 1);
	for (let k = 0; k <= n / 2; k++) {
		let re = 0;
		let im = 0;
		for (let i = 0; i < n; i++) {
			const angle = (-2 * Math.PI * k * i) / n;
			re += frame[i] * Math.cos(angle);
			im += frame[i] * Math.sin(angle);
		}
		out[k] = re * re + im * im;
	}
	return out;
}

/** A deterministic, non-trivial signal. No RNG: a failure has to be reproducible. */
function testSignal(length: number): Float64Array {
	const signal = new Float64Array(length);
	for (let i = 0; i < length; i++) {
		signal[i] =
			Math.sin((2 * Math.PI * 440 * i) / WHISPER_SAMPLE_RATE) +
			0.5 * Math.sin((2 * Math.PI * 1970 * i) / WHISPER_SAMPLE_RATE) +
			0.1 * Math.cos((2 * Math.PI * 60 * i) / WHISPER_SAMPLE_RATE);
	}
	return signal;
}

describe('whisper mel extractor', () => {
	describe('exact DFT', () => {
		it('matches a brute-force DFT for the non-power-of-two window Whisper uses', () => {
			// THE regression test. `WHISPER_N_FFT` is 400, and the tempting shortcut -
			// zero-pad to 512 and use a radix-2 FFT - produces a different transform,
			// not an approximation of this one.
			const plan = createDftPlan(WHISPER_N_FFT);
			const frame = testSignal(WHISPER_N_FFT);
			const fast = new Float64Array(WHISPER_N_FFT / 2 + 1);
			dftPowerSpectrum(plan, frame, fast);

			const slow = naiveDftPower(frame);

			expect(fast.length).toBe(slow.length);
			for (let k = 0; k < slow.length; k++) {
				// Relative tolerance: bin magnitudes here span several orders of
				// magnitude, so a flat epsilon would be vacuous on the large bins and
				// impossible on the small ones.
				const scale = Math.max(Math.abs(slow[k]), 1);
				expect(Math.abs(fast[k] - slow[k]) / scale).toBeLessThan(1e-6);
			}
		});

		it('is exact for a power-of-two window too, where the chirp path is not needed', () => {
			const plan = createDftPlan(256);
			const frame = testSignal(256);
			const fast = new Float64Array(129);
			dftPowerSpectrum(plan, frame, fast);
			const slow = naiveDftPower(frame);

			for (let k = 0; k < slow.length; k++) {
				expect(Math.abs(fast[k] - slow[k]) / Math.max(Math.abs(slow[k]), 1)).toBeLessThan(1e-6);
			}
		});

		it('puts a pure tone in the bin its frequency belongs to', () => {
			const plan = createDftPlan(WHISPER_N_FFT);
			// 800 Hz with a 400-point window at 16 kHz is exactly bin 20, so the tone
			// is periodic in the window and leaks into no neighbour.
			const frame = new Float64Array(WHISPER_N_FFT);
			for (let i = 0; i < WHISPER_N_FFT; i++) {
				frame[i] = Math.sin((2 * Math.PI * 800 * i) / WHISPER_SAMPLE_RATE);
			}
			const power = new Float64Array(WHISPER_N_FFT / 2 + 1);
			dftPowerSpectrum(plan, frame, power);

			let peak = 0;
			for (let k = 1; k < power.length; k++) if (power[k] > power[peak]) peak = k;
			expect(peak).toBe(20);
		});
	});

	describe('mel filterbank', () => {
		it('covers the spectrum with one triangle per mel bin', () => {
			const bins = WHISPER_N_FFT / 2 + 1;
			const filters = melFilterBank();
			expect(filters.length).toBe(WHISPER_N_MELS * bins);

			for (let m = 0; m < WHISPER_N_MELS; m++) {
				const row = filters.subarray(m * bins, (m + 1) * bins);
				const total = row.reduce((sum, value) => sum + value, 0);
				// Every filter carries weight. An empty row means a mel bin that can
				// never respond, and it would be invisible in a transcript.
				expect(total).toBeGreaterThan(0);
				expect(row.every((value) => value >= 0)).toBe(true);
			}
		});

		it('spaces low filters more tightly than high ones', () => {
			// The defining property of a mel scale. A linear filterbank would pass
			// every other test here and still transcribe badly.
			const bins = WHISPER_N_FFT / 2 + 1;
			const filters = melFilterBank();
			const width = (m: number) => {
				const row = filters.subarray(m * bins, (m + 1) * bins);
				return row.reduce((count, value) => count + (value > 0 ? 1 : 0), 0);
			};
			expect(width(2)).toBeLessThan(width(WHISPER_N_MELS - 3));
		});
	});

	describe('hann window', () => {
		it('is periodic, not symmetric', () => {
			// torch.hann_window(periodic=True). The symmetric variant is off by one
			// sample of phase, which is small, systematic, and never announced.
			const window = hannWindow(8);
			expect(window[0]).toBeCloseTo(0, 12);
			expect(window[4]).toBeCloseTo(1, 12);
			// A symmetric window would also be 0 here; a periodic one is not.
			expect(window[7]).toBeGreaterThan(0);
		});
	});

	describe('feature extraction', () => {
		it('produces the fixed shape the encoder expects, whatever the input length', () => {
			const extractor = new WhisperMelExtractor();
			const short = extractor.extract(Float32Array.from(testSignal(1600)));
			expect(short.length).toBe(WHISPER_N_MELS * WHISPER_N_FRAMES);

			// Longer than the 30 s window: truncated to the same shape, never ragged.
			const long = extractor.extract(Float32Array.from(testSignal(WHISPER_SAMPLE_RATE * 45)));
			expect(long.length).toBe(WHISPER_N_MELS * WHISPER_N_FRAMES);
		});

		it('normalises into the range Whisper expects, leaving no non-finite value', () => {
			const extractor = new WhisperMelExtractor();
			const mel = extractor.extract(Float32Array.from(testSignal(16000)));

			let min = Infinity;
			let max = -Infinity;
			for (const value of mel) {
				expect(Number.isFinite(value)).toBe(true);
				if (value < min) min = value;
				if (value > max) max = value;
			}
			// The clamp is `peak - 8` decades, then `(x + 4) / 4`. So the SPAN is
			// exactly 2, always - but the absolute values track how loud the window
			// was, which is deliberate and is what makes the clamp relative rather
			// than absolute. Asserting a fixed maximum here would be asserting a
			// property of the test signal, not of the extractor.
			expect(min).toBeCloseTo(max - 2, 5);
		});

		it('survives digital silence rather than producing -Infinity', () => {
			// log10(0) is -Infinity, and one of those poisons the whole feature map.
			// Silence is not an edge case here: it is every gap between words.
			const extractor = new WhisperMelExtractor();
			const mel = extractor.extract(new Float32Array(16000));
			expect(mel.every((value) => Number.isFinite(value))).toBe(true);
		});

		it('reuses its plan across calls without changing the answer', () => {
			// The extractor caches the chirp tables and the filterbank. A cache that
			// carried state between passes would make the second utterance of a
			// session differ from the first.
			const extractor = new WhisperMelExtractor();
			const audio = Float32Array.from(testSignal(8000));
			expect(Array.from(extractor.extract(audio))).toEqual(Array.from(extractor.extract(audio)));
		});
	});
});
