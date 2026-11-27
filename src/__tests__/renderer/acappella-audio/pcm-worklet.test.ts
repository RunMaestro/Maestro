/**
 * @file pcm-worklet.test.ts
 *
 * The PCM worklet is the one piece of A Cappella that no integration test can
 * cover: it only ever runs inside `AudioWorkletGlobalScope`, on the audio
 * thread, in a hidden window. So it is tested the only way it can be - by
 * standing up the three globals it reads, importing the module, and driving the
 * processor with synthetic render quanta.
 *
 * The load-bearing case is the ramp test. Resampling block by block, with the
 * read position reset each time, produces output that looks right in aggregate
 * but has a discontinuity every 128 samples: a 375 Hz buzz on top of the user's
 * voice at 48 kHz. Feeding a perfect ramp and checking every output sample
 * against the position it should have been read from is what catches it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACAPPELLA_AUDIO_FRAME_SAMPLES } from '../../../shared/acappella/audio-host';

interface WorkletFrame {
	pcm: ArrayBuffer;
	rms: number;
	t: number;
}

interface ProcessorLike {
	process(inputs: Float32Array[][]): boolean;
}

const RENDER_QUANTUM = 128;

let posted: WorkletFrame[] = [];

/** Stand up `AudioWorkletGlobalScope` and load the module fresh under it. */
async function loadProcessor(
	contextSampleRate: number
): Promise<new (options?: unknown) => ProcessorLike> {
	posted = [];
	let registered: (new (options?: unknown) => ProcessorLike) | null = null;

	class FakeAudioWorkletProcessor {
		readonly port = {
			postMessage: (message: WorkletFrame) => {
				posted.push(message);
			},
		};
	}

	vi.stubGlobal('AudioWorkletProcessor', FakeAudioWorkletProcessor);
	vi.stubGlobal('sampleRate', contextSampleRate);
	vi.stubGlobal('currentTime', 1.5);
	vi.stubGlobal('registerProcessor', (_name: string, ctor: unknown) => {
		registered = ctor as new (options?: unknown) => ProcessorLike;
	});

	vi.resetModules();
	await import('../../../renderer/acappella-audio/pcm-worklet');

	if (!registered) throw new Error('worklet did not register a processor');
	return registered;
}

/** Feed `sampleCount` samples as consecutive 128-sample render quanta. */
function drive(
	processor: ProcessorLike,
	sampleCount: number,
	valueAt: (globalIndex: number) => number,
	channels = 1
): void {
	for (let offset = 0; offset < sampleCount; offset += RENDER_QUANTUM) {
		const block: Float32Array[] = [];
		for (let c = 0; c < channels; c++) {
			const channel = new Float32Array(RENDER_QUANTUM);
			for (let i = 0; i < RENDER_QUANTUM; i++) {
				// Channel 1 is inverted so a stereo downmix cancels to silence.
				channel[i] = c === 0 ? valueAt(offset + i) : -valueAt(offset + i);
			}
			block.push(channel);
		}
		processor.process([block]);
	}
}

function framesToFloat(frames: WorkletFrame[]): number[] {
	const out: number[] = [];
	for (const frame of frames) {
		const samples = new Int16Array(frame.pcm);
		for (const sample of samples) out.push(sample < 0 ? sample / 0x8000 : sample / 0x7fff);
	}
	return out;
}

describe('A Cappella PCM worklet', () => {
	beforeEach(() => {
		posted = [];
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('emits 20 ms frames of 320 samples at 16 kHz from a 48 kHz context', async () => {
		const Processor = await loadProcessor(48000);
		const processor = new Processor();

		// One second of audio at 48 kHz -> 16000 output samples -> 50 frames.
		drive(processor, 48000, () => 0.5);

		expect(posted).toHaveLength(50);
		for (const frame of posted) {
			expect(new Int16Array(frame.pcm)).toHaveLength(ACAPPELLA_AUDIO_FRAME_SAMPLES);
		}
	});

	it('resamples continuously across render quanta, with no seam at the block boundary', async () => {
		const Processor = await loadProcessor(48000);
		const processor = new Processor();

		// A perfect ramp: linear interpolation of a line is exact, so every output
		// sample must equal the input at the position it was read from. Any per-block
		// reset of the read position shows up immediately as a step.
		const slope = 1e-5;
		drive(processor, 48000, (index) => index * slope);

		const output = framesToFloat(posted);
		expect(output.length).toBe(16000);
		// Tolerance is one int16 quantisation step, not an approximation of the maths.
		const tolerance = 2 / 0x7fff;
		for (let k = 0; k < output.length; k++) {
			expect(Math.abs(output[k] - k * 3 * slope)).toBeLessThan(tolerance);
		}
	});

	it('downmixes stereo to mono by averaging the channels', async () => {
		const Processor = await loadProcessor(48000);
		const processor = new Processor();

		// Channel 1 is the inverse of channel 0, so the average is silence.
		drive(processor, 48000, () => 0.8, 2);

		expect(posted.length).toBeGreaterThan(0);
		for (const value of framesToFloat(posted)) expect(Math.abs(value)).toBeLessThan(1e-6);
	});

	it('handles a non-integer resample ratio (44.1 kHz)', async () => {
		const Processor = await loadProcessor(44100);
		const processor = new Processor();

		drive(processor, 44100, () => 0.25);

		// 44100 in at 44.1 kHz is one second, so ~16000 samples out (50 frames),
		// minus whatever is still short of a full frame.
		expect(posted.length).toBeGreaterThanOrEqual(49);
		expect(posted.length).toBeLessThanOrEqual(50);
	});

	it('reports RMS per frame and clamps out-of-range samples', async () => {
		const Processor = await loadProcessor(16000);
		const processor = new Processor();

		// Deliberately over full scale: an auto-gained mic can overshoot, and
		// wrapping instead of clamping turns a loud vowel into a burst of noise.
		drive(processor, 16000, () => 2);

		expect(posted.length).toBeGreaterThan(0);
		for (const frame of posted) {
			expect(frame.rms).toBeCloseTo(1, 5);
			for (const sample of new Int16Array(frame.pcm)) expect(sample).toBe(0x7fff);
		}
	});

	it('passes 16 kHz input through unchanged and stamps the context clock', async () => {
		const Processor = await loadProcessor(16000);
		const processor = new Processor();

		drive(processor, 3200, () => 0.5);

		expect(posted).toHaveLength(10);
		expect(posted[0].t).toBe(1.5);
		for (const value of framesToFloat(posted)) expect(value).toBeCloseTo(0.5, 4);
	});

	it('stays alive when the graph delivers no input', async () => {
		const Processor = await loadProcessor(48000);
		const processor = new Processor();

		// Returning false here would retire the processor for good, so a momentary
		// gap while the mic connects would silently kill capture.
		expect(processor.process([])).toBe(true);
		expect(processor.process([[]])).toBe(true);
		expect(posted).toHaveLength(0);
	});
});
