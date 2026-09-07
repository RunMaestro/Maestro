/**
 * @file echo-stt.test.ts
 *
 * The development echo recogniser: PCM in, speech segments out.
 *
 * Everything here is generated PCM against recording callbacks. No audio device,
 * no pipeline, no audio host - the provider owns its own segmentation precisely
 * so it can be driven from an `Int16Array` and nothing else.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { EchoSttProvider, createEchoSttProvider } from '../../../main/acappella/providers/echo-stt';
import {
	ACAPPELLA_AUDIO_FRAME_SAMPLES,
	ACAPPELLA_AUDIO_SAMPLE_RATE,
} from '../../../shared/acappella/audio-host';
import type { SttCallbacks } from '../../../shared/acappella/providers';

// ---------------------------------------------------------------------------
// Signal generators
// ---------------------------------------------------------------------------

function build(fill: (index: number) => number): Int16Array {
	const samples = new Int16Array(ACAPPELLA_AUDIO_FRAME_SAMPLES);
	for (let i = 0; i < ACAPPELLA_AUDIO_FRAME_SAMPLES; i++) {
		const value = Math.max(-1, Math.min(1, fill(i)));
		samples[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
	}
	return samples;
}

const silence = (): Int16Array => build(() => 0);

/** Voiced speech stand-in: 200 Hz sits squarely inside the VAD's zero-crossing band. */
const tone = (amplitude = 0.4): Int16Array =>
	build((i) => amplitude * Math.sin((2 * Math.PI * 200 * i) / ACAPPELLA_AUDIO_SAMPLE_RATE));

/** Silence long enough for the default 700 ms endpoint to fire. */
const ENDPOINT_FRAMES = 40;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Recorded {
	partials: Array<{ text: string; stability: number }>;
	finals: Array<{ text: string; confidence: number; durationMs?: number }>;
	errors: Error[];
}

function recording(): { callbacks: SttCallbacks; recorded: Recorded } {
	const recorded: Recorded = { partials: [], finals: [], errors: [] };
	return {
		recorded,
		callbacks: {
			onPartial: (text, stability) => recorded.partials.push({ text, stability }),
			onFinal: (text, confidence, durationMs) =>
				recorded.finals.push({ text, confidence, durationMs }),
			onError: (error) => recorded.errors.push(error),
		},
	};
}

async function started(options: ConstructorParameters<typeof EchoSttProvider>[0] = {}) {
	const provider = new EchoSttProvider({ finalDelayMs: 0, ...options });
	const { callbacks, recorded } = recording();
	await provider.start(callbacks);
	return { provider, recorded };
}

function push(provider: EchoSttProvider, samples: Int16Array, count = 1): void {
	for (let i = 0; i < count; i++) provider.feed(samples);
}

// ---------------------------------------------------------------------------

describe('EchoSttProvider identity', () => {
	it('declares itself an audio consumer at the pipeline sample rate', () => {
		const provider = createEchoSttProvider();

		// The flag the audio bridge reads before opening a microphone.
		expect(provider.acceptsAudio).toBe(true);
		expect(provider.sampleRate).toBe(ACAPPELLA_AUDIO_SAMPLE_RATE);
		expect(provider.tier).toBe('mock');
	});
});

describe('EchoSttProvider segmentation', () => {
	it('says nothing about a silent room', async () => {
		const { provider, recorded } = await started();

		push(provider, silence(), 100);

		expect(recorded.finals).toEqual([]);
		expect(recorded.partials).toEqual([]);
	});

	it('emits a final transcript once a speech segment endpoints', async () => {
		const { provider, recorded } = await started();

		push(provider, tone(), 10);
		push(provider, silence(), ENDPOINT_FRAMES);

		expect(recorded.finals).toHaveLength(1);
		expect(recorded.finals[0].text).toMatch(/^Echo utterance 1: 0\.2s of speech\.$/);
		expect(recorded.finals[0].confidence).toBeGreaterThan(0);
		expect(recorded.finals[0].confidence).toBeLessThan(1);
	});

	it('reports the speech duration without the endpoint silence in it', async () => {
		const { provider, recorded } = await started();

		// 25 frames of tone is 500 ms. The 800 ms of silence that ends the utterance
		// is the detector agreeing the user stopped, not something the user said.
		push(provider, tone(), 25);
		push(provider, silence(), ENDPOINT_FRAMES);

		expect(recorded.finals[0].durationMs).toBe(500);
	});

	it('numbers consecutive segments so one transcript is told from the next', async () => {
		const { provider, recorded } = await started();

		for (let segment = 0; segment < 3; segment++) {
			push(provider, tone(), 10);
			push(provider, silence(), ENDPOINT_FRAMES);
		}

		expect(recorded.finals.map((final) => final.text)).toEqual([
			'Echo utterance 1: 0.2s of speech.',
			'Echo utterance 2: 0.2s of speech.',
			'Echo utterance 3: 0.2s of speech.',
		]);
	});

	it('streams partials while the segment is open, with rising stability', async () => {
		const { provider, recorded } = await started({ partialIntervalMs: 200 });

		push(provider, tone(), 60);

		expect(recorded.partials.length).toBeGreaterThan(2);
		expect(recorded.partials[0].text).toMatch(/^Echo utterance 1: .*\.\.\.$/);
		// A hypothesis firms up as more of the utterance arrives.
		expect(recorded.partials[1].stability).toBeGreaterThan(recorded.partials[0].stability);
		expect(recorded.partials.at(-1)!.stability).toBeLessThanOrEqual(0.9);
		// Still open: nothing is final until the floor closes.
		expect(recorded.finals).toEqual([]);
	});

	it('emits no partials at all when the interval is disabled', async () => {
		const { provider, recorded } = await started({ partialIntervalMs: 0 });

		push(provider, tone(), 60);

		expect(recorded.partials).toEqual([]);
	});

	it('ignores frames fed before start', async () => {
		const provider = new EchoSttProvider({ finalDelayMs: 0 });
		const { callbacks, recorded } = recording();

		push(provider, tone(), 10);
		push(provider, silence(), ENDPOINT_FRAMES);
		await provider.start(callbacks);

		expect(recorded.finals).toEqual([]);
	});

	it('starts a fresh run on restart rather than continuing the last one', async () => {
		const { provider, recorded } = await started();
		push(provider, tone(), 10);
		push(provider, silence(), ENDPOINT_FRAMES);

		await provider.stop();
		const second = recording();
		await provider.start(second.callbacks);
		push(provider, tone(), 10);
		push(provider, silence(), ENDPOINT_FRAMES);

		// Segment 1 again, and on the new callbacks: a new capture run is a new
		// conversation, not the continuation of a session that already ended.
		expect(second.recorded.finals.map((f) => f.text)).toEqual([
			'Echo utterance 1: 0.2s of speech.',
		]);
		expect(recorded.finals).toHaveLength(1);
	});
});

describe('EchoSttProvider endpointing', () => {
	it('finalises the open segment immediately on flush', async () => {
		const { provider, recorded } = await started();

		push(provider, tone(), 10);
		expect(recorded.finals).toEqual([]);

		// Push-to-talk release, or the pipeline forwarding its own VAD endpoint. The
		// user already said they were finished; waiting out 700 ms of silence to
		// agree with them would be latency bought with nothing.
		await provider.flush();

		expect(recorded.finals).toHaveLength(1);
		expect(recorded.finals[0].durationMs).toBe(200);
	});

	it('produces nothing when flushed with no speech in hand', async () => {
		const { provider, recorded } = await started();

		push(provider, silence(), 10);
		await provider.flush();

		// Silence is not an empty transcript, it is no transcript.
		expect(recorded.finals).toEqual([]);
	});

	it('hears the next sentence right after a flush', async () => {
		const { provider, recorded } = await started();

		push(provider, tone(), 10);
		await provider.flush();
		push(provider, tone(), 10);
		push(provider, silence(), ENDPOINT_FRAMES);

		// A manual endpoint ends an utterance, not the capture run: someone who
		// keeps talking must not have to pause before being heard again.
		expect(recorded.finals.map((f) => f.text)).toEqual([
			'Echo utterance 1: 0.2s of speech.',
			'Echo utterance 2: 0.2s of speech.',
		]);
	});

	it('does not double-report a segment that flush already closed', async () => {
		const { provider, recorded } = await started();

		push(provider, tone(), 10);
		await provider.flush();
		push(provider, silence(), ENDPOINT_FRAMES);

		expect(recorded.finals).toHaveLength(1);
	});
});

describe('EchoSttProvider text-in seam', () => {
	it('routes typed text in as a synthetic final transcript', async () => {
		const { provider, recorded } = await started();

		provider.injectUtterance('  open the auth tab  ');

		// No partials: the text was already settled when it arrived, so there is no
		// hypothesis to revise.
		expect(recorded.partials).toEqual([]);
		expect(recorded.finals).toEqual([
			{ text: 'open the auth tab', confidence: 1, durationMs: expect.any(Number) },
		]);
		expect(recorded.finals[0].durationMs).toBeGreaterThan(0);
	});

	it('passes an empty utterance straight through with no estimated duration', async () => {
		const { provider, recorded } = await started();

		provider.injectUtterance('   ');

		// The session service has its own empty-utterance path; inventing a duration
		// for it would put a lie on the transcript timeline.
		expect(recorded.finals).toEqual([{ text: '', confidence: 1, durationMs: 0 }]);
	});

	it('supersedes audio that was being spoken over it', async () => {
		const { provider, recorded } = await started();

		push(provider, tone(), 10);
		provider.injectUtterance('typed instead');
		push(provider, silence(), ENDPOINT_FRAMES);

		// The open segment is abandoned, not endpointed behind the typed text.
		expect(recorded.finals.map((f) => f.text)).toEqual(['typed instead']);
	});
});

describe('EchoSttProvider decoder latency', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('delivers the final after the simulated decode, not on the endpoint frame', async () => {
		const provider = new EchoSttProvider({ finalDelayMs: 250 });
		const { callbacks, recorded } = recording();
		await provider.start(callbacks);

		push(provider, tone(), 10);
		push(provider, silence(), ENDPOINT_FRAMES);
		expect(recorded.finals).toEqual([]);

		vi.advanceTimersByTime(250);
		expect(recorded.finals).toHaveLength(1);
	});

	it('drops a final that was still decoding when the session ended', async () => {
		const provider = new EchoSttProvider({ finalDelayMs: 250 });
		const { callbacks, recorded } = recording();
		await provider.start(callbacks);

		push(provider, tone(), 10);
		push(provider, silence(), ENDPOINT_FRAMES);
		await provider.stop();
		vi.advanceTimersByTime(1_000);

		// A transcript for a session that is gone would arrive with no floor to take
		// it and no envelope to travel in.
		expect(recorded.finals).toEqual([]);
	});
});
